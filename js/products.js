// products.js - Gestión completa de productos, stock, precios y categorías
// Configuración inicial
const PRODUCTS_PER_PAGE = 20;
const OFFLINE_CACHE_LIMIT = 1000;
const STOCK_MOVEMENT_TYPES = {
  SALE: 'sale',
  PURCHASE: 'purchase',
  ADJUSTMENT: 'adjustment',
  RETURN: 'return',
  TRANSFER: 'transfer'
};

class ProductManager {
  constructor(db, auth, syncManager) {
    this.db = db; // Base de datos Firestore
    this.auth = auth; // Autenticación
    this.syncManager = syncManager; // Gestor de sincronización offline
    this.cache = new ProductCache();
    this.realtimeListeners = new Map();
    this.initIndexes();
  }

  /**
   * Inicializar índices necesarios
   */
  initIndexes() {
    // Índices para Firestore
    this.db.collection('products')
      .where('isActive', '==', true)
      .orderBy('updatedAt', 'desc')
      .limit(1); // Ejemplo de índice

    // Inicializar IndexedDB para cache offline
    this.cache.init();
  }

  /**
   * Búsqueda paginada con filtros
   * @param {string} query - Término de búsqueda
   * @param {Object} filters - Filtros aplicables
   * @param {string} filters.categoryId - Filtrar por categoría
   * @param {number} filters.minPrice - Precio mínimo
   * @param {number} filters.maxPrice - Precio máximo
   * @param {boolean} filters.lowStockOnly - Solo productos con stock bajo
   * @param {number} page - Número de página (1-indexed)
   * @returns {Promise<{products: Array, total: number, pages: number}>}
   */
  async searchProducts(query, filters = {}, page = 1) {
    try {
      let ref = this.db.collection('products')
        .where('isActive', '==', true);

      // Aplicar filtros
      if (filters.categoryId) {
        ref = ref.where('categoryId', '==', filters.categoryId);
      }

      if (filters.lowStockOnly) {
        ref = ref.where('stock', '<=', filters.lowStockThreshold || 10);
      }

      // Búsqueda por texto (nombre, descripción, código)
      if (query) {
        // Nota: Firestore no soporta búsqueda de texto completo nativamente
        // Considerar usar Algolia o ElasticSearch para producción
        ref = ref.where('searchKeywords', 'array-contains', query.toLowerCase());
      }

      // Paginación
      const startAt = (page - 1) * PRODUCTS_PER_PAGE;
      const snapshot = await ref
        .orderBy('name')
        .startAt(startAt)
        .limit(PRODUCTS_PER_PAGE)
        .get();

      // Obtener total para paginación
      const totalSnapshot = await ref.count().get();
      const total = totalSnapshot.data().count;

      const products = [];
      snapshot.forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      // Cachear productos para offline
      await this.cache.addProducts(products);

      return {
        products,
        total,
        pages: Math.ceil(total / PRODUCTS_PER_PAGE),
        currentPage: page
      };
    } catch (error) {
      console.error('Error en búsqueda:', error);
      
      // Fallback a cache offline
      if (error.code === 'failed-precondition') {
        return this.searchProductsOffline(query, filters, page);
      }
      
      throw new Error(`Error buscando productos: ${error.message}`);
    }
  }

  /**
   * Búsqueda offline desde cache
   */
  async searchProductsOffline(query, filters = {}, page = 1) {
    const products = await this.cache.search(query, filters);
    
    // Paginación manual
    const start = (page - 1) * PRODUCTS_PER_PAGE;
    const end = start + PRODUCTS_PER_PAGE;
    const paginatedProducts = products.slice(start, end);
    
    return {
      products: paginatedProducts,
      total: products.length,
      pages: Math.ceil(products.length / PRODUCTS_PER_PAGE),
      currentPage: page,
      isOffline: true
    };
  }

  /**
   * Buscar producto por código de barras
   * @param {string} barcode - Código de barras
   * @returns {Promise<Object|null>} Producto encontrado o null
   */
  async getProductByBarcode(barcode) {
    if (!barcode) return null;

    try {
      // Buscar en índice de códigos de barras
      const snapshot = await this.db.collection('productBarcodes')
        .where('barcode', '==', barcode)
        .where('isActive', '==', true)
        .limit(1)
        .get();

      if (snapshot.empty) {
        // Intentar en cache offline
        return await this.cache.getByBarcode(barcode);
      }

      const barcodeDoc = snapshot.docs[0];
      const productId = barcodeDoc.data().productId;
      
      // Obtener producto completo
      return await this.getProductById(productId);
    } catch (error) {
      console.error('Error buscando por código de barras:', error);
      
      // Fallback a cache
      return await this.cache.getByBarcode(barcode);
    }
  }

  /**
   * Obtener producto por ID
   * @param {string} productId - ID del producto
   * @param {boolean} forceRefresh - Forzar actualización desde servidor
   * @returns {Promise<Object>} Producto
   */
  async getProductById(productId, forceRefresh = false) {
    if (!productId) throw new Error('ID de producto requerido');

    // Verificar cache primero (a menos que forceRefresh sea true)
    if (!forceRefresh) {
      const cached = await this.cache.get(productId);
      if (cached) return cached;
    }

    try {
      const doc = await this.db.collection('products')
        .doc(productId)
        .get();

      if (!doc.exists) {
        throw new Error('Producto no encontrado');
      }

      const product = { id: doc.id, ...doc.data() };
      
      // Actualizar cache
      await this.cache.addProduct(product);
      
      return product;
    } catch (error) {
      console.error('Error obteniendo producto:', error);
      
      // Intentar desde cache
      const cached = await this.cache.get(productId);
      if (cached) {
        console.warn('Producto obtenido desde cache offline');
        return cached;
      }
      
      throw new Error(`Producto no disponible: ${error.message}`);
    }
  }

  /**
   * Actualizar producto
   * @param {string} productId - ID del producto
   * @param {Object} data - Datos a actualizar
   * @param {string} userId - ID del usuario que realiza la modificación
   * @returns {Promise<Object>} Producto actualizado
   */
  async updateProduct(productId, data, userId) {
    if (!userId) throw new Error('Usuario requerido para auditoría');
    
    // Validar datos
    this.validateProductData(data, true);
    
    // Verificar duplicados de código de barras
    if (data.barcodes) {
      await this.validateBarcodes(data.barcodes, productId);
    }

    const updateData = {
      ...data,
      updatedAt: new Date(),
      updatedBy: userId,
      lastUpdated: new Date() // Para sincronización offline
    };

    try {
      // Actualizar en Firestore
      await this.db.collection('products')
        .doc(productId)
        .update(updateData);

      // Actualizar cache
      const product = await this.getProductById(productId, true);
      
      // Registrar en historial de cambios
      await this.recordChange(productId, 'update', userId, data);
      
      return product;
    } catch (error) {
      console.error('Error actualizando producto:', error);
      
      // Guardar para sincronización offline
      if (error.code === 'unavailable') {
        await this.syncManager.queueUpdate('products', productId, updateData);
        return this.getProductById(productId); // Retorna versión cacheada
      }
      
      throw error;
    }
  }

  /**
   * Actualizar stock con registro de movimiento
   * @param {string} productId - ID del producto
   * @param {number} quantity - Cantidad (positiva para entrada, negativa para salida)
   * @param {string} movementType - Tipo de movimiento
   * @param {Object} options - Opciones adicionales
   * @returns {Promise<Object>} Producto actualizado
   */
  async updateStock(productId, quantity, movementType, options = {}) {
    const { userId, referenceId, notes, offline = false } = options;
    
    if (!userId && !offline) {
      throw new Error('Usuario requerido para movimientos de stock');
    }

    // Validar tipo de movimiento
    if (!Object.values(STOCK_MOVEMENT_TYPES).includes(movementType)) {
      throw new Error('Tipo de movimiento inválido');
    }

    // Obtener producto actual
    const product = await this.getProductById(productId);
    
    // Validar stock disponible para ventas
    if (movementType === STOCK_MOVEMENT_TYPES.SALE && product.stock + quantity < 0) {
      throw new Error('Stock insuficiente para realizar la venta');
    }

    const newStock = product.stock + quantity;
    const movementId = this.generateMovementId();

    const movement = {
      movementId,
      productId,
      type: movementType,
      quantity,
      previousStock: product.stock,
      newStock,
      date: new Date(),
      userId,
      referenceId,
      notes,
      synced: !offline
    };

    try {
      // Transacción para actualizar stock y registrar movimiento
      const batch = this.db.batch();
      
      const productRef = this.db.collection('products').doc(productId);
      batch.update(productRef, {
        stock: newStock,
        updatedAt: new Date(),
        lastCost: movementType === STOCK_MOVEMENT_TYPES.PURCHASE ? 
          (options.unitCost || product.lastCost) : product.lastCost
      });
      
      const movementRef = this.db.collection('stockMovements').doc(movementId);
      batch.set(movementRef, movement);
      
      await batch.commit();

      // Actualizar cache
      await this.cache.updateStock(productId, newStock);
      
      // Notificar si stock bajo mínimo
      if (newStock <= product.minStock) {
        this.notifyLowStock(product, newStock);
      }
      
      return {
        productId,
        newStock,
        movementId
      };
    } catch (error) {
      console.error('Error actualizando stock:', error);
      
      // Guardar movimiento para sincronización offline
      if (error.code === 'unavailable' || offline) {
        await this.syncManager.queueStockMovement(movement);
        await this.cache.updateStock(productId, newStock);
        
        return {
          productId,
          newStock,
          movementId,
          pendingSync: true
        };
      }
      
      throw error;
    }
  }

  /**
   * Actualizar precio con historial
   * @param {string} productId - ID del producto
   * @param {number} newPrice - Nuevo precio
   * @param {string} userId - ID del usuario
   * @param {string} reason - Razón del cambio
   * @returns {Promise<Object>} Producto actualizado
   */
  async updatePrice(productId, newPrice, userId, reason = 'price_adjustment') {
    if (!userId) throw new Error('Usuario requerido');
    
    // Validar precio
    if (typeof newPrice !== 'number' || newPrice < 0) {
      throw new Error('Precio inválido');
    }

    // Obtener producto actual
    const product = await this.getProductById(productId);
    
    // Crear entrada de historial
    const priceHistory = {
      previousPrice: product.price,
      newPrice,
      changeDate: new Date(),
      changedBy: userId,
      reason,
      productId
    };

    try {
      // Actualizar precio y agregar al historial
      const batch = this.db.batch();
      
      const productRef = this.db.collection('products').doc(productId);
      batch.update(productRef, {
        price: newPrice,
        updatedAt: new Date(),
        updatedBy: userId
      });
      
      const historyRef = this.db.collection('priceHistory').doc();
      batch.set(historyRef, priceHistory);
      
      await batch.commit();

      // Actualizar cache
      await this.cache.updatePrice(productId, newPrice);
      
      // Notificar a presupuestos pendientes
      await this.notifyPriceChange(productId, newPrice);
      
      return {
        productId,
        newPrice,
        previousPrice: product.price
      };
    } catch (error) {
      console.error('Error actualizando precio:', error);
      
      // Guardar para sincronización offline
      if (error.code === 'unavailable') {
        await this.syncManager.queuePriceUpdate(productId, newPrice, userId, reason);
        await this.cache.updatePrice(productId, newPrice);
      }
      
      throw error;
    }
  }

  /**
   * Obtener productos con stock bajo
   * @param {number} threshold - Umbral de stock (opcional)
   * @returns {Promise<Array>} Productos con stock bajo
   */
  async getLowStockProducts(threshold) {
    try {
      const snapshot = await this.db.collection('products')
        .where('isActive', '==', true)
        .where('stock', '<=', threshold || 5)
        .orderBy('stock')
        .limit(50)
        .get();

      const products = [];
      snapshot.forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      return products;
    } catch (error) {
      console.error('Error obteniendo productos con stock bajo:', error);
      return this.cache.getLowStock(threshold);
    }
  }

  /**
   * Obtener productos por categoría
   * @param {string} categoryId - ID de categoría
   * @param {number} limit - Límite de resultados
   * @returns {Promise<Array>} Productos de la categoría
   */
  async getProductsByCategory(categoryId, limit = 100) {
    if (!categoryId) return [];

    try {
      const snapshot = await this.db.collection('products')
        .where('categoryId', '==', categoryId)
        .where('isActive', '==', true)
        .orderBy('name')
        .limit(limit)
        .get();

      const products = [];
      snapshot.forEach(doc => {
        products.push({ id: doc.id, ...doc.data() });
      });

      // Cachear productos
      await this.cache.addProducts(products);

      return products;
    } catch (error) {
      console.error('Error obteniendo productos por categoría:', error);
      return this.cache.getByCategory(categoryId);
    }
  }

  /**
   * Crear nuevo producto
   * @param {Object} productData - Datos del producto
   * @param {string} userId - ID del usuario creador
   * @returns {Promise<Object>} Producto creado
   */
  async createProduct(productData, userId) {
    if (!userId) throw new Error('Usuario creador requerido');
    
    // Validar datos
    this.validateProductData(productData, false);
    
    // Verificar duplicados de código de barras
    if (productData.barcodes) {
      await this.validateBarcodes(productData.barcodes);
    }

    const productId = this.generateProductId();
    const now = new Date();

    const newProduct = {
      ...productData,
      id: productId,
      localId: productData.localId || `LOCAL_${productId.substring(0, 8)}`,
      stock: productData.stock || 0,
      minStock: productData.minStock || 5,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
      lastCost: productData.cost || 0,
      searchKeywords: this.generateSearchKeywords(productData)
    };

    try {
      // Guardar producto
      await this.db.collection('products')
        .doc(productId)
        .set(newProduct);

      // Guardar códigos de barras en índice
      if (productData.barcodes && productData.barcodes.length > 0) {
        await this.saveBarcodes(productId, productData.barcodes);
      }

      // Crear historial de precio inicial
      if (productData.price) {
        await this.db.collection('priceHistory').add({
          productId,
          previousPrice: 0,
          newPrice: productData.price,
          changeDate: now,
          changedBy: userId,
          reason: 'initial_price'
        });
      }

      // Cachear producto
      await this.cache.addProduct(newProduct);

      return newProduct;
    } catch (error) {
      console.error('Error creando producto:', error);
      
      // Guardar para sincronización offline
      if (error.code === 'unavailable') {
        await this.syncManager.queueCreate('products', newProduct);
        return newProduct;
      }
      
      throw error;
    }
  }

  /**
   * Importar productos desde CSV
   * @param {string} csvData - Datos en formato CSV
   * @param {string} userId - ID del usuario
   * @returns {Promise<{success: number, errors: Array}>} Resultado de importación
   */
  async importProductsCSV(csvData, userId) {
    const results = {
      success: 0,
      errors: []
    };

    const rows = this.parseCSV(csvData);
    
    for (let i = 0; i < rows.length; i++) {
      try {
        const row = rows[i];
        const productData = this.mapCSVRowToProduct(row);
        
        // Verificar si producto ya existe (por código de barras)
        const existing = await this.findProductByImportData(productData);
        
        if (existing) {
          // Actualizar producto existente
          await this.updateProduct(existing.id, productData, userId);
        } else {
          // Crear nuevo producto
          await this.createProduct(productData, userId);
        }
        
        results.success++;
      } catch (error) {
        results.errors.push({
          row: i + 1,
          error: error.message,
          data: rows[i]
        });
      }
    }

    return results;
  }

  /**
   * Escuchar cambios en tiempo real para productos visibles
   * @param {Array<string>} productIds - IDs de productos a escuchar
   * @param {Function} callback - Función a ejecutar en cambios
   */
  listenToProducts(productIds, callback) {
    // Limpiar listeners anteriores para estos productos
    const listenerKey = productIds.sort().join(',');
    if (this.realtimeListeners.has(listenerKey)) {
      this.realtimeListeners.get(listenerKey)();
    }

    // Crear nuevo listener
    const unsubscribe = this.db.collection('products')
      .where('id', 'in', productIds.slice(0, 10)) // Firestore limita a 10 en consultas 'in'
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
          if (change.type === 'modified') {
            const product = { id: change.doc.id, ...change.doc.data() };
            callback(product);
            
            // Actualizar cache
            this.cache.addProduct(product);
          }
        });
      });

    this.realtimeListeners.set(listenerKey, unsubscribe);
  }

  /**
   * Validar datos del producto
   */
  validateProductData(data, isUpdate) {
    const errors = [];
    
    if (!isUpdate) {
      if (!data.name || data.name.trim().length < 2) {
        errors.push('Nombre requerido (mínimo 2 caracteres)');
      }
      
      if (!data.categoryId) {
        errors.push('Categoría requerida');
      }
    }
    
    if (data.price !== undefined && (typeof data.price !== 'number' || data.price < 0)) {
      errors.push('Precio inválido');
    }
    
    if (data.stock !== undefined && !Number.isInteger(data.stock)) {
      errors.push('Stock debe ser un número entero');
    }
    
    if (errors.length > 0) {
      throw new Error(`Errores de validación: ${errors.join(', ')}`);
    }
  }

  /**
   * Validar códigos de barras únicos
   */
  async validateBarcodes(barcodes, excludeProductId = null) {
    for (const barcode of barcodes) {
      if (!barcode) continue;
      
      const snapshot = await this.db.collection('productBarcodes')
        .where('barcode', '==', barcode)
        .where('isActive', '==', true)
        .limit(1)
        .get();
      
      if (!snapshot.empty) {
        const existing = snapshot.docs[0].data();
        if (existing.productId !== excludeProductId) {
          throw new Error(`Código de barras ${barcode} ya existe en producto ${existing.productId}`);
        }
      }
    }
  }

  /**
   * Generar keywords para búsqueda
   */
  generateSearchKeywords(productData) {
    const keywords = [];
    
    if (productData.name) {
      keywords.push(productData.name.toLowerCase());
      // Agregar variaciones sin acentos, etc.
    }
    
    if (productData.description) {
      keywords.push(...productData.description.toLowerCase().split(/\s+/));
    }
    
    if (productData.barcodes) {
      keywords.push(...productData.barcodes);
    }
    
    if (productData.sku) {
      keywords.push(productData.sku);
    }
    
    // Eliminar duplicados y valores vacíos
    return [...new Set(keywords.filter(k => k && k.trim().length > 0))];
  }

  /**
   * Notificar cambio de precio a presupuestos
   */
  async notifyPriceChange(productId, newPrice) {
    // Implementar lógica para actualizar presupuestos pendientes
    // Esto podría ser una Cloud Function o un proceso en segundo plano
    console.log(`Precio actualizado para ${productId}: $${newPrice}`);
  }

  /**
   * Notificar stock bajo
   */
  notifyLowStock(product, currentStock) {
    // Enviar notificación (email, push, etc.)
    console.warn(`Stock bajo para ${product.name}: ${currentStock} unidades (mínimo: ${product.minStock})`);
  }

  /**
   * Métodos auxiliares para ID generation
   */
  generateProductId() {
    return `PROD_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
  
  generateMovementId() {
    return `MOV_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Clase para manejo de cache offline en IndexedDB
 */
class ProductCache {
  constructor() {
    this.dbName = 'productsCache';
    this.storeName = 'products';
    this.barcodeIndexName = 'barcodes';
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('barcode', 'barcodes', { multiEntry: true });
          store.createIndex('categoryId', 'categoryId');
          store.createIndex('isActive', 'isActive');
          store.createIndex('stock', 'stock');
          store.createIndex('localId', 'localId', { unique: true });
        }
      };
      
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      
      request.onerror = (event) => {
        reject(new Error('Error inicializando cache'));
      };
    });
  }

  async addProduct(product) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      // Limitar cache a 1000 productos
      const countRequest = store.count();
      countRequest.onsuccess = async () => {
        if (countRequest.result >= OFFLINE_CACHE_LIMIT) {
          await this.cleanOldProducts();
        }
        
        const putRequest = store.put(product);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject();
      };
    });
  }

  async addProducts(products) {
    for (const product of products) {
      await this.addProduct(product);
    }
  }

  async get(productId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(productId);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject();
    });
  }

  async getByBarcode(barcode) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const index = store.index('barcode');
      const request = index.get(barcode);
      
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject();
    });
  }

  async getByCategory(categoryId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const index = store.index('categoryId');
      const request = index.getAll(categoryId);
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject();
    });
  }

  async getLowStock(threshold = 5) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      
      request.onsuccess = () => {
        const products = request.result || [];
        const lowStock = products.filter(p => 
          p.isActive && p.stock <= threshold
        );
        resolve(lowStock);
      };
      
      request.onerror = () => reject();
    });
  }

  async updateStock(productId, newStock) {
    const product = await this.get(productId);
    if (product) {
      product.stock = newStock;
      product.updatedAt = new Date();
      await this.addProduct(product);
    }
  }

  async updatePrice(productId, newPrice) {
    const product = await this.get(productId);
    if (product) {
      product.price = newPrice;
      product.updatedAt = new Date();
      await this.addProduct(product);
    }
  }

  async search(query, filters = {}) {
    const products = await this.getAllProducts();
    
    return products.filter(product => {
      // Filtrar por búsqueda de texto
      if (query) {
        const searchTerm = query.toLowerCase();
        const matches = (
          product.name?.toLowerCase().includes(searchTerm) ||
          product.description?.toLowerCase().includes(searchTerm) ||
          product.barcodes?.some(b => b.includes(searchTerm)) ||
          product.sku?.toLowerCase().includes(searchTerm)
        );
        if (!matches) return false;
      }
      
      // Filtrar por categoría
      if (filters.categoryId && product.categoryId !== filters.categoryId) {
        return false;
      }
      
      // Filtrar por stock bajo
      if (filters.lowStockOnly && product.stock > (filters.lowStockThreshold || 10)) {
        return false;
      }
      
      return product.isActive;
    });
  }

  async getAllProducts() {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();
      
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject();
    });
  }

  async cleanOldProducts() {
    const products = await this.getAllProducts();
    
    // Ordenar por fecha de actualización (más antiguos primero)
    products.sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
    
    // Eliminar los más antiguos hasta quedar en el límite
    const toDelete = products.slice(0, products.length - OFFLINE_CACHE_LIMIT + 100);
    
    const transaction = this.db.transaction([this.storeName], 'readwrite');
    const store = transaction.objectStore(this.storeName);
    
    toDelete.forEach(product => {
      store.delete(product.id);
    });
  }
}

// Exportar la clase principal
export default ProductManager;
