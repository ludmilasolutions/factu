// providers.js - Gestión de proveedores y pedidos de reposición
// Responsabilidad: Gestión de proveedores y pedidos de reposición

import { db, auth } from './firebaseConfig';
import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  updateDoc, 
  arrayUnion, 
  arrayRemove, 
  serverTimestamp,
  orderBy,
  onSnapshot,
  writeBatch
} from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import NetInfo from '@react-native-community/netinfo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { formatPhoneNumber, validatePhoneNumber } from './utils/phoneUtils';

// Constantes
const PROVIDERS_COLLECTION = 'providers';
const ORDERS_COLLECTION = 'orders';
const PRODUCTS_COLLECTION = 'products';
const PRICE_HISTORY_COLLECTION = 'priceHistory';
const OFFLINE_QUEUE = 'offline_orders_queue';
const PROVIDERS_CACHE = 'cached_providers';

class ProvidersService {
  constructor() {
    this.currentBusinessId = null;
    this.currentLocalId = null;
    this.offlineMode = false;
    this.init();
  }

  async init() {
    // Inicializar con IDs de negocio y local (deberían venir de la autenticación/contexto)
    const user = auth.currentUser;
    if (user) {
      const userDoc = await getDoc(doc(db, 'users', user.uid));
      const userData = userDoc.data();
      this.currentBusinessId = userData.businessId;
      this.currentLocalId = userData.localId;
    }

    // Configurar listener de conexión
    NetInfo.addEventListener(state => {
      this.offlineMode = !state.isConnected;
      if (state.isConnected) {
        this.syncOfflineOrders();
      }
    });

    // Cargar cache de proveedores
    await this.loadProvidersCache();
  }

  // ==================== FUNCIONES PRINCIPALES ====================

  /**
   * Crear un nuevo proveedor
   * @param {Object} providerData - Datos del proveedor
   */
  async createProvider(providerData) {
    try {
      // Validaciones
      if (!providerData.name || !providerData.contact) {
        throw new Error('Nombre y contacto son obligatorios');
      }

      if (providerData.whatsapp && !validatePhoneNumber(providerData.whatsapp)) {
        throw new Error('Número de WhatsApp inválido');
      }

      const providerId = this.generateId();
      const providerRef = doc(db, PROVIDERS_COLLECTION, providerId);
      
      const providerWithMetadata = {
        ...providerData,
        id: providerId,
        businessId: this.currentBusinessId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        active: true,
        // Manejar múltiples contactos
        contacts: providerData.contacts || [
          {
            type: 'whatsapp',
            value: providerData.whatsapp,
            primary: true
          }
        ]
      };

      // Eliminar whatsapp del objeto principal para evitar duplicación
      delete providerWithMetadata.whatsapp;

      await setDoc(providerRef, providerWithMetadata);
      
      // Actualizar cache
      await this.updateProvidersCache(providerWithMetadata);
      
      return providerId;
    } catch (error) {
      console.error('Error creando proveedor:', error);
      throw error;
    }
  }

  /**
   * Actualizar proveedor existente
   * @param {string} providerId - ID del proveedor
   * @param {Object} updates - Campos a actualizar
   */
  async updateProvider(providerId, updates) {
    try {
      const providerRef = doc(db, PROVIDERS_COLLECTION, providerId);
      const providerDoc = await getDoc(providerRef);
      
      if (!providerDoc.exists()) {
        throw new Error('Proveedor no encontrado');
      }

      // Verificar que no se intente modificar el businessId
      if (updates.businessId) {
        delete updates.businessId;
      }

      // Validar WhatsApp si se actualiza
      if (updates.whatsapp && !validatePhoneNumber(updates.whatsapp)) {
        throw new Error('Número de WhatsApp inválido');
      }

      // Si se actualiza precio de productos, guardar en historial
      if (updates.products) {
        await this.updatePriceHistory(providerId, updates.products);
      }

      const updateData = {
        ...updates,
        updatedAt: serverTimestamp()
      };

      await updateDoc(providerRef, updateData);
      
      // Actualizar cache
      await this.refreshProvidersCache();
      
      return true;
    } catch (error) {
      console.error('Error actualizando proveedor:', error);
      throw error;
    }
  }

  /**
   * Listar todos los proveedores del negocio
   */
  async getProviders(filters = {}) {
    try {
      // Intentar desde cache primero si está offline
      if (this.offlineMode) {
        const cached = await AsyncStorage.getItem(PROVIDERS_CACHE);
        if (cached) {
          let providers = JSON.parse(cached);
          
          // Aplicar filtros básicos offline
          if (filters.active !== undefined) {
            providers = providers.filter(p => p.active === filters.active);
          }
          if (filters.search) {
            const searchLower = filters.search.toLowerCase();
            providers = providers.filter(p => 
              p.name.toLowerCase().includes(searchLower) ||
              p.contactName?.toLowerCase().includes(searchLower)
            );
          }
          
          return providers;
        }
      }

      // Online: consultar Firestore
      const q = query(
        collection(db, PROVIDERS_COLLECTION),
        where('businessId', '==', this.currentBusinessId),
        where('active', '==', true),
        orderBy('name')
      );

      const snapshot = await getDocs(q);
      const providers = [];
      
      snapshot.forEach(doc => {
        providers.push({
          id: doc.id,
          ...doc.data()
        });
      });

      // Actualizar cache
      await AsyncStorage.setItem(PROVIDERS_CACHE, JSON.stringify(providers));
      
      return providers;
    } catch (error) {
      console.error('Error obteniendo proveedores:', error);
      throw error;
    }
  }

  /**
   * Crear un pedido de reposición
   * @param {string} providerId - ID del proveedor
   * @param {Array} items - Items del pedido
   */
  async createOrder(providerId, items) {
    // Validación: no permitir pedidos sin proveedor
    if (!providerId) {
      throw new Error('El proveedor es requerido');
    }

    if (!items || items.length === 0) {
      throw new Error('El pedido debe contener items');
    }

    const orderData = {
      providerId,
      localId: this.currentLocalId,
      businessId: this.currentBusinessId,
      items: items.map(item => ({
        ...item,
        receivedQuantity: 0,
        // Guardar precio actual para historial
        purchasePrice: item.price,
        purchaseCurrency: 'MXN'
      })),
      status: 'pending',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      estimatedDelivery: this.calculateEstimatedDelivery(), // Función auxiliar
      sentAt: null,
      receivedAt: null
    };

    try {
      if (this.offlineMode) {
        return await this.createOrderOffline(orderData);
      } else {
        return await this.createOrderOnline(orderData);
      }
    } catch (error) {
      console.error('Error creando pedido:', error);
      throw error;
    }
  }

  /**
   * Enviar pedido por WhatsApp (requiere confirmación)
   * @param {string} orderId - ID del pedido
   */
  async sendOrderWhatsApp(orderId) {
    try {
      const orderRef = doc(db, ORDERS_COLLECTION, orderId);
      const orderDoc = await getDoc(orderRef);
      
      if (!orderDoc.exists()) {
        throw new Error('Pedido no encontrado');
      }

      const order = orderDoc.data();
      
      // Validar que el pedido esté pendiente
      if (order.status !== 'pending') {
        throw new Error('Solo se pueden enviar pedidos pendientes');
      }

      // Obtener datos del proveedor
      const providerRef = doc(db, PROVIDERS_COLLECTION, order.providerId);
      const providerDoc = await getDoc(providerRef);
      
      if (!providerDoc.exists()) {
        throw new Error('Proveedor no encontrado');
      }

      const provider = providerDoc.data();
      
      // Buscar contacto de WhatsApp (puede haber múltiples)
      const whatsappContact = provider.contacts?.find(c => 
        c.type === 'whatsapp' && c.primary
      ) || provider.contacts?.find(c => c.type === 'whatsapp');

      if (!whatsappContact) {
        throw new Error('El proveedor no tiene WhatsApp configurado');
      }

      // Formatear mensaje del pedido
      const message = this.formatWhatsAppMessage(order, provider);
      const phoneNumber = formatPhoneNumber(whatsappContact.value);
      const whatsappUrl = `https://wa.me/${phoneNumber}?text=${encodeURIComponent(message)}`;
      
      // Actualizar estado del pedido
      await updateDoc(orderRef, {
        status: 'sent',
        sentAt: serverTimestamp(),
        whatsappSent: true,
        whatsappUrl
      });

      // NOTA: Aquí se debería abrir el enlace de WhatsApp
      // La implementación de apertura depende de la plataforma
      // Esta función solo prepara la URL y actualiza el estado
      
      return {
        success: true,
        whatsappUrl,
        phoneNumber
      };
    } catch (error) {
      console.error('Error enviando pedido por WhatsApp:', error);
      throw error;
    }
  }

  /**
   * Recibir un pedido
   * @param {string} orderId - ID del pedido
   * @param {Array} receivedItems - Items recibidos
   */
  async receiveOrder(orderId, receivedItems) {
    try {
      const orderRef = doc(db, ORDERS_COLLECTION, orderId);
      const orderDoc = await getDoc(orderRef);
      
      if (!orderDoc.exists()) {
        throw new Error('Pedido no encontrado');
      }

      const order = orderDoc.data();
      
      // Validar: no modificar pedidos ya recibidos
      if (order.status === 'received') {
        throw new Error('No se puede modificar un pedido ya recibido');
      }

      // Validar que los items recibidos correspondan al pedido
      const validatedItems = this.validateReceivedItems(order.items, receivedItems);
      
      // Actualizar inventario y costos
      await this.updateInventoryAndCosts(validatedItems, order.localId);
      
      // Actualizar pedido
      await updateDoc(orderRef, {
        status: 'received',
        receivedAt: serverTimestamp(),
        items: validatedItems,
        updatedAt: serverTimestamp()
      });

      return true;
    } catch (error) {
      console.error('Error recibiendo pedido:', error);
      throw error;
    }
  }

  /**
   * Obtener pedidos pendientes
   */
  async getPendingOrders() {
    try {
      const q = query(
        collection(db, ORDERS_COLLECTION),
        where('localId', '==', this.currentLocalId),
        where('status', 'in', ['pending', 'sent']),
        orderBy('createdAt', 'desc')
      );

      const snapshot = await getDocs(q);
      const orders = [];
      
      snapshot.forEach(doc => {
        orders.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return orders;
    } catch (error) {
      console.error('Error obteniendo pedidos pendientes:', error);
      throw error;
    }
  }

  /**
   * Obtener productos de un proveedor
   * @param {string} providerId - ID del proveedor
   */
  async getProviderProducts(providerId) {
    try {
      const providerRef = doc(db, PROVIDERS_COLLECTION, providerId);
      const providerDoc = await getDoc(providerRef);
      
      if (!providerDoc.exists()) {
        throw new Error('Proveedor no encontrado');
      }

      const provider = providerDoc.data();
      
      // Los productos pueden estar:
      // 1. Directamente en el proveedor (array products)
      // 2. En una colección separada relacionada
      
      if (provider.products && provider.products.length > 0) {
        return provider.products;
      }
      
      // Consultar productos del proveedor desde colección separada
      const q = query(
        collection(db, 'providerProducts'),
        where('providerId', '==', providerId),
        where('active', '==', true)
      );

      const snapshot = await getDocs(q);
      const products = [];
      
      snapshot.forEach(doc => {
        products.push({
          id: doc.id,
          ...doc.data()
        });
      });

      return products;
    } catch (error) {
      console.error('Error obteniendo productos del proveedor:', error);
      throw error;
    }
  }

  /**
   * Calcular puntos de reposición
   * Basado en ventas históricas, stock actual y lead time
   */
  async calculateReorderPoints() {
    try {
      const productsRef = collection(db, PRODUCTS_COLLECTION);
      const q = query(
        productsRef,
        where('businessId', '==', this.currentBusinessId),
        where('localId', '==', this.currentLocalId),
        where('active', '==', true)
      );

      const snapshot = await getDocs(q);
      const reorderSuggestions = [];
      const now = new Date();
      const thirtyDaysAgo = new Date(now.setDate(now.getDate() - 30));

      for (const productDoc of snapshot.docs) {
        const product = productDoc.data();
        
        // Obtener ventas de los últimos 30 días
        const salesQuery = query(
          collection(db, 'sales'),
          where('productId', '==', productDoc.id),
          where('localId', '==', this.currentLocalId),
          where('date', '>=', thirtyDaysAgo),
          where('date', '<=', new Date())
        );

        const salesSnapshot = await getDocs(salesQuery);
        let totalSold = 0;
        salesSnapshot.forEach(sale => {
          totalSold += sale.data().quantity;
        });

        // Calcular promedio diario
        const dailyAverage = totalSold / 30;
        
        // Obtener lead time del proveedor principal (si existe)
        let leadTime = 7; // días por defecto
        if (product.mainProviderId) {
          const providerRef = doc(db, PROVIDERS_COLLECTION, product.mainProviderId);
          const providerDoc = await getDoc(providerRef);
          if (providerDoc.exists() && providerDoc.data().leadTime) {
            leadTime = providerDoc.data().leadTime;
          }
        }

        // Calcular punto de reposición
        const safetyStock = dailyAverage * 3; // stock de seguridad (3 días)
        const reorderPoint = Math.ceil((dailyAverage * leadTime) + safetyStock);
        
        // Verificar si necesita reposición
        const currentStock = product.currentStock || 0;
        const needsReorder = currentStock <= reorderPoint;

        if (needsReorder) {
          reorderSuggestions.push({
            productId: productDoc.id,
            productName: product.name,
            sku: product.sku,
            currentStock,
            reorderPoint,
            dailyAverage,
            leadTime,
            suggestedOrder: reorderPoint - currentStock,
            providerId: product.mainProviderId,
            urgency: currentStock <= safetyStock ? 'high' : 'medium'
          });
        }
      }

      return reorderSuggestions;
    } catch (error) {
      console.error('Error calculando puntos de reposición:', error);
      throw error;
    }
  }

  /**
   * Generar reporte de pedidos
   * @param {Object} dateRange - Rango de fechas {start: Date, end: Date}
   */
  async generateOrdersReport(dateRange) {
    try {
      const { start, end } = dateRange;
      
      const q = query(
        collection(db, ORDERS_COLLECTION),
        where('localId', '==', this.currentLocalId),
        where('createdAt', '>=', start),
        where('createdAt', '<=', end),
        orderBy('createdAt', 'desc')
      );

      const snapshot = await getDocs(q);
      
      const report = {
        summary: {
          totalOrders: 0,
          totalValue: 0,
          pending: 0,
          sent: 0,
          received: 0,
          cancelled: 0
        },
        orders: [],
        byProvider: {},
        byDate: {}
      };

      snapshot.forEach(doc => {
        const order = doc.data();
        const orderValue = order.items.reduce((sum, item) => 
          sum + (item.quantity * item.purchasePrice), 0
        );

        // Actualizar resumen
        report.summary.totalOrders++;
        report.summary.totalValue += orderValue;
        report.summary[order.status]++;

        // Agrupar por proveedor
        if (!report.byProvider[order.providerId]) {
          report.byProvider[order.providerId] = {
            count: 0,
            value: 0
          };
        }
        report.byProvider[order.providerId].count++;
        report.byProvider[order.providerId].value += orderValue;

        // Agrupar por fecha
        const orderDate = order.createdAt.toDate().toISOString().split('T')[0];
        if (!report.byDate[orderDate]) {
          report.byDate[orderDate] = {
            count: 0,
            value: 0
          };
        }
        report.byDate[orderDate].count++;
        report.byDate[orderDate].value += orderValue;

        // Agregar orden detallada
        report.orders.push({
          id: doc.id,
          ...order,
          totalValue: orderValue
        });
      });

      return report;
    } catch (error) {
      console.error('Error generando reporte:', error);
      throw error;
    }
  }

  // ==================== FUNCIONES AUXILIARES ====================

  /**
   * Formatear mensaje de WhatsApp para pedido
   */
  formatWhatsAppMessage(order, provider) {
    const itemsText = order.items.map(item => 
      `• ${item.quantity} x ${item.name} - $${item.price}`
    ).join('\n');

    const total = order.items.reduce((sum, item) => 
      sum + (item.quantity * item.price), 0
    );

    return `*PEDIDO #${order.id.substring(0, 8)}*\n\n` +
           `Hola ${provider.name},\n\n` +
           `Necesitamos los siguientes productos:\n\n` +
           `${itemsText}\n\n` +
           `*Total: $${total.toFixed(2)}*\n\n` +
           `Fecha estimada de entrega: ${order.estimatedDelivery}\n\n` +
           `Local: ${this.currentLocalId}\n` +
           `Gracias.`;
  }

  /**
   * Crear pedido en modo offline
   */
  async createOrderOffline(orderData) {
    const orderId = this.generateId();
    const orderWithId = {
      ...orderData,
      id: orderId,
      offline: true,
      syncStatus: 'pending'
    };

    // Guardar en cola offline
    const queue = await this.getOfflineQueue();
    queue.push(orderWithId);
    await AsyncStorage.setItem(OFFLINE_QUEUE, JSON.stringify(queue));

    // También guardar en cache local
    const cachedOrders = await AsyncStorage.getItem('offline_orders');
    const orders = cachedOrders ? JSON.parse(cachedOrders) : [];
    orders.push(orderWithId);
    await AsyncStorage.setItem('offline_orders', JSON.stringify(orders));

    return orderId;
  }

  /**
   * Sincronizar pedidos offline
   */
  async syncOfflineOrders() {
    try {
      const queue = await this.getOfflineQueue();
      if (queue.length === 0) return;

      const batch = writeBatch(db);
      const syncedOrders = [];

      for (const order of queue) {
        if (order.syncStatus === 'pending') {
          const orderRef = doc(collection(db, ORDERS_COLLECTION), order.id);
          batch.set(orderRef, {
            ...order,
            offline: false,
            syncStatus: 'synced',
            syncedAt: serverTimestamp()
          });
          syncedOrders.push(order.id);
        }
      }

      if (syncedOrders.length > 0) {
        await batch.commit();
        
        // Limpiar cola
        const newQueue = queue.filter(order => 
          !syncedOrders.includes(order.id)
        );
        await AsyncStorage.setItem(OFFLINE_QUEUE, JSON.stringify(newQueue));
        
        console.log(`${syncedOrders.length} pedidos sincronizados`);
      }
    } catch (error) {
      console.error('Error sincronizando pedidos offline:', error);
    }
  }

  /**
   * Actualizar historial de precios
   */
  async updatePriceHistory(providerId, products) {
    const batch = writeBatch(db);
    const timestamp = serverTimestamp();

    for (const product of products) {
      if (product.price) {
        const historyRef = doc(collection(db, PRICE_HISTORY_COLLECTION));
        batch.set(historyRef, {
          providerId,
          productId: product.productId || product.id,
          price: product.price,
          currency: 'MXN',
          date: timestamp,
          businessId: this.currentBusinessId
        });
      }
    }

    await batch.commit();
  }

  /**
   * Validar items recibidos vs pedidos
   */
  validateReceivedItems(orderedItems, receivedItems) {
    return orderedItems.map(ordered => {
      const received = receivedItems.find(r => r.productId === ordered.productId);
      return {
        ...ordered,
        receivedQuantity: received ? received.quantity : 0,
        notes: received ? received.notes : null
      };
    });
  }

  /**
   * Actualizar inventario y costos promedio
   */
  async updateInventoryAndCosts(items, localId) {
    const batch = writeBatch(db);

    for (const item of items) {
      if (item.receivedQuantity > 0) {
        const productRef = doc(db, PRODUCTS_COLLECTION, item.productId);
        const productDoc = await getDoc(productRef);
        
        if (productDoc.exists()) {
          const product = productDoc.data();
          const newStock = (product.currentStock || 0) + item.receivedQuantity;
          
          // Calcular nuevo costo promedio ponderado
          const currentTotalCost = (product.averageCost || 0) * (product.currentStock || 0);
          const newPurchaseCost = item.receivedQuantity * item.purchasePrice;
          const newAverageCost = (currentTotalCost + newPurchaseCost) / newStock;
          
          batch.update(productRef, {
            currentStock: newStock,
            averageCost: newAverageCost,
            lastPurchasePrice: item.purchasePrice,
            lastPurchaseDate: serverTimestamp(),
            updatedAt: serverTimestamp()
          });
        }
      }
    }

    await batch.commit();
  }

  /**
   * Calcular fecha estimada de entrega
   */
  calculateEstimatedDelivery() {
    const date = new Date();
    date.setDate(date.getDate() + 7); // 7 días por defecto
    return date;
  }

  /**
   * Cargar cache de proveedores
   */
  async loadProvidersCache() {
    try {
      const cached = await AsyncStorage.getItem(PROVIDERS_CACHE);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (error) {
      console.error('Error cargando cache:', error);
    }
    return [];
  }

  /**
   * Actualizar cache de proveedores
   */
  async updateProvidersCache(provider) {
    const cached = await this.loadProvidersCache();
    const existingIndex = cached.findIndex(p => p.id === provider.id);
    
    if (existingIndex >= 0) {
      cached[existingIndex] = provider;
    } else {
      cached.push(provider);
    }
    
    await AsyncStorage.setItem(PROVIDERS_CACHE, JSON.stringify(cached));
  }

  /**
   * Refrescar cache completo
   */
  async refreshProvidersCache() {
    const providers = await this.getProviders();
    await AsyncStorage.setItem(PROVIDERS_CACHE, JSON.stringify(providers));
  }

  /**
   * Obtener cola offline
   */
  async getOfflineQueue() {
    try {
      const queue = await AsyncStorage.getItem(OFFLINE_QUEUE);
      return queue ? JSON.parse(queue) : [];
    } catch (error) {
      return [];
    }
  }

  /**
   * Generar ID único
   */
  generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  // ==================== LISTENERS TIEMPO REAL ====================

  /**
   * Escuchar cambios en pedidos
   */
  subscribeToOrders(callback) {
    const q = query(
      collection(db, ORDERS_COLLECTION),
      where('localId', '==', this.currentLocalId),
      orderBy('updatedAt', 'desc')
    );

    return onSnapshot(q, (snapshot) => {
      const orders = [];
      snapshot.forEach(doc => {
        orders.push({
          id: doc.id,
          ...doc.data()
        });
      });
      callback(orders);
    });
  }

  /**
   * Escuchar cambios en precios de proveedores
   */
  subscribeToPriceChanges(providerId, callback) {
    const q = query(
      collection(db, PRICE_HISTORY_COLLECTION),
      where('providerId', '==', providerId),
      orderBy('date', 'desc'),
      limit(10)
    );

    return onSnapshot(q, (snapshot) => {
      const changes = [];
      snapshot.forEach(doc => {
        changes.push({
          id: doc.id,
          ...doc.data()
        });
      });
      callback(changes);
    });
  }
}

// Exportar instancia singleton
export const providersService = new ProvidersService();
export default ProvidersService;
