/**
 * budgets.js - Gestión de presupuestos y conversión a ventas
 * Responsabilidad exacta: Gestión de presupuestos y conversión a ventas
 */

const BUDGET_EXPIRY_DAYS = 30;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const BUDGET_STATUS = {
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CONVERTED: 'converted',
  PARTIAL: 'partially_converted'
};

// Cache para presupuestos frecuentes
const budgetCache = new Map();
let cacheLastClean = Date.now();

class BudgetManager {
  constructor() {
    this.offlineBudgets = new Map();
    this.init();
  }

  init() {
    // Inicializar listeners para sincronización offline
    this.setupOfflineSync();
    this.setupRealTimeSync();
    this.startExpiryNotifier();
  }

  // -------------------- FUNCIONES PRINCIPALES --------------------

  /**
   * Crear presupuesto con validación de cliente y productos
   * @param {Object} clientData - Datos del cliente
   * @param {Array} items - Items del presupuesto
   * @returns {Object} Presupuesto creado
   */
  async createBudget(clientData, items) {
    try {
      // Validación de cliente
      if (!clientData || !clientData.id) {
        throw new Error('Cliente no válido');
      }

      // Verificar si hay conexión
      const isOnline = await this.checkConnection();
      
      // Validar productos y obtener precios vigentes
      const validatedItems = await this.validateItems(items);
      
      // Calcular totales
      const totals = this.calculateTotals(validatedItems);
      
      // Crear objeto presupuesto
      const budget = {
        id: this.generateBudgetId(),
        clientId: clientData.id,
        clientData: { ...clientData },
        items: validatedItems,
        subtotal: totals.subtotal,
        taxes: totals.taxes,
        total: totals.total,
        status: BUDGET_STATUS.ACTIVE,
        createdAt: new Date(),
        validUntil: this.calculateExpiryDate(),
        convertedSaleId: null,
        convertedItems: [],
        history: [{
          action: 'created',
          timestamp: new Date(),
          user: this.getCurrentUser()
        }],
        version: 1,
        offline: !isOnline,
        lastSynced: isOnline ? new Date() : null
      };

      // Guardar según conexión
      if (isOnline) {
        await this.saveBudgetOnline(budget);
      } else {
        await this.saveBudgetOffline(budget);
      }

      // Actualizar caché
      this.updateCache(budget.id, budget);
      
      return budget;
    } catch (error) {
      console.error('Error al crear presupuesto:', error);
      throw error;
    }
  }

  /**
   * Convertir presupuesto a venta con validaciones
   * @param {string} budgetId - ID del presupuesto
   * @param {Object} paymentData - Datos de pago
   * @returns {Object} Venta creada
   */
  async convertToSale(budgetId, paymentData) {
    try {
      // Obtener presupuesto
      const budget = await this.getBudget(budgetId);
      
      // Validar conversión
      this.validateConversion(budget);
      
      // Verificar stock disponible para todos los items
      await this.checkStockAvailability(budget.items);
      
      // Obtener precios actuales
      const currentPrices = await this.getCurrentPrices(budget.items);
      
      // Crear objeto de venta con precios actuales
      const sale = {
        id: this.generateSaleId(),
        budgetId: budget.id,
        clientId: budget.clientId,
        items: budget.items.map(item => ({
          ...item,
          unitPrice: currentPrices[item.productId] || item.unitPrice
        })),
        payment: paymentData,
        originalBudgetTotal: budget.total,
        saleTotal: this.calculateSaleTotal(budget.items, currentPrices),
        convertedAt: new Date(),
        status: 'completed'
      };

      // Actualizar presupuesto
      budget.status = BUDGET_STATUS.CONVERTED;
      budget.convertedSaleId = sale.id;
      budget.convertedAt = new Date();
      budget.history.push({
        action: 'converted_to_sale',
        saleId: sale.id,
        timestamp: new Date(),
        user: this.getCurrentUser()
      });

      // Guardar cambios
      await this.updateBudget(budgetId, budget);
      
      // Crear venta en el sistema
      await this.createSale(sale);
      
      // Actualizar stock
      await this.updateStock(budget.items, 'subtract');
      
      return sale;
    } catch (error) {
      console.error('Error al convertir a venta:', error);
      throw error;
    }
  }

  /**
   * Convertir presupuesto parcialmente
   * @param {string} budgetId - ID del presupuesto
   * @param {Array} itemsToConvert - Items a convertir
   * @param {Object} paymentData - Datos de pago
   */
  async convertPartialBudget(budgetId, itemsToConvert, paymentData) {
    const budget = await this.getBudget(budgetId);
    
    // Validar que el presupuesto no esté completamente convertido
    if (budget.status === BUDGET_STATUS.CONVERTED) {
      throw new Error('Presupuesto ya convertido completamente');
    }

    // Verificar stock para items específicos
    await this.checkStockAvailability(itemsToConvert);
    
    // Crear venta parcial
    const sale = await this.convertToSale(budgetId, paymentData);
    
    // Actualizar estado del presupuesto
    budget.status = BUDGET_STATUS.PARTIAL;
    budget.convertedItems = [...budget.convertedItems, ...itemsToConvert];
    
    await this.updateBudget(budgetId, budget);
    
    return sale;
  }

  /**
   * Obtener presupuesto por ID
   * @param {string} budgetId - ID del presupuesto
   * @returns {Object} Presupuesto
   */
  async getBudget(budgetId) {
    // Intentar obtener de caché primero
    const cached = this.getFromCache(budgetId);
    if (cached) return cached;

    // Obtener de base de datos
    const budget = await this.fetchBudgetFromDB(budgetId);
    
    if (!budget) {
      throw new Error('Presupuesto no encontrado');
    }

    // Validar vigencia
    if (this.isBudgetExpired(budget) && budget.status === BUDGET_STATUS.ACTIVE) {
      await this.expireBudget(budgetId);
      budget.status = BUDGET_STATUS.EXPIRED;
    }

    // Actualizar caché
    this.updateCache(budgetId, budget);
    
    return budget;
  }

  /**
   * Actualizar presupuesto existente
   * @param {string} budgetId - ID del presupuesto
   * @param {Object} updates - Campos a actualizar
   */
  async updateBudget(budgetId, updates) {
    const budget = await this.getBudget(budgetId);
    
    // Validar que no esté convertido
    if (budget.status === BUDGET_STATUS.CONVERTED) {
      throw new Error('No se puede modificar un presupuesto convertido');
    }

    // Validar cambios
    const validatedUpdates = await this.validateUpdates(budget, updates);
    
    // Crear nuevo historial
    validatedUpdates.history = [
      ...budget.history,
      {
        action: 'updated',
        changes: Object.keys(validatedUpdates),
        timestamp: new Date(),
        user: this.getCurrentUser(),
        previousVersion: budget.version
      }
    ];
    
    validatedUpdates.version = budget.version + 1;
    validatedUpdates.lastModified = new Date();

    // Guardar cambios
    await this.saveBudgetUpdate(budgetId, validatedUpdates);
    
    // Invalidar caché
    this.invalidateCache(budgetId);
    
    return { ...budget, ...validatedUpdates };
  }

  /**
   * Obtener presupuestos por cliente
   * @param {string} clientId - ID del cliente
   * @returns {Array} Lista de presupuestos
   */
  async getBudgetsByClient(clientId) {
    // Validar cliente
    if (!await this.clientExists(clientId)) {
      throw new Error('Cliente no encontrado');
    }

    const budgets = await this.fetchBudgetsByClient(clientId);
    
    // Filtrar presupuestos expirados
    const activeBudgets = budgets.filter(b => 
      b.status === BUDGET_STATUS.ACTIVE && !this.isBudgetExpired(b)
    );

    return activeBudgets;
  }

  /**
   * Obtener presupuestos activos
   * @returns {Array} Presupuestos activos
   */
  async getActiveBudgets() {
    const budgets = await this.fetchAllBudgets();
    
    return budgets.filter(budget => 
      budget.status === BUDGET_STATUS.ACTIVE && 
      !this.isBudgetExpired(budget)
    );
  }

  /**
   * Marcar presupuesto como expirado
   * @param {string} budgetId - ID del presupuesto
   */
  async expireBudget(budgetId) {
    const budget = await this.getBudget(budgetId);
    
    if (budget.status !== BUDGET_STATUS.ACTIVE) {
      throw new Error('Solo se pueden expirar presupuestos activos');
    }

    const updates = {
      status: BUDGET_STATUS.EXPIRED,
      expiredAt: new Date(),
      history: [
        ...budget.history,
        {
          action: 'expired',
          timestamp: new Date(),
          user: 'system'
        }
      ]
    };

    await this.saveBudgetUpdate(budgetId, updates);
    this.invalidateCache(budgetId);
  }

  /**
   * Enviar presupuesto por email
   * @param {string} budgetId - ID del presupuesto
   * @param {string} email - Email destino
   */
  async sendBudgetByEmail(budgetId, email) {
    const budget = await this.getBudget(budgetId);
    
    // Validar email
    if (!this.isValidEmail(email)) {
      throw new Error('Email no válido');
    }

    // Generar PDF
    const pdfBuffer = await this.generateBudgetPDF(budget);
    
    // Enviar email
    await this.sendEmail({
      to: email,
      subject: `Presupuesto ${budget.id}`,
      attachments: [{
        filename: `presupuesto-${budget.id}.pdf`,
        content: pdfBuffer
      }]
    });

    // Registrar en historial
    await this.updateBudget(budgetId, {
      history: [
        ...budget.history,
        {
          action: 'sent_by_email',
          email: email,
          timestamp: new Date(),
          user: this.getCurrentUser()
        }
      ]
    });
  }

  /**
   * Imprimir presupuesto
   * @param {string} budgetId - ID del presupuesto
   */
  async printBudget(budgetId) {
    const budget = await this.getBudget(budgetId);
    
    // Generar formato para impresión
    const printData = this.formatForPrint(budget);
    
    // Enviar a impresora
    await this.sendToPrinter(printData);

    // Registrar en historial
    await this.updateBudget(budgetId, {
      history: [
        ...budget.history,
        {
          action: 'printed',
          timestamp: new Date(),
          user: this.getCurrentUser()
        }
      ]
    });
  }

  /**
   * Duplicar presupuesto
   * @param {string} budgetId - ID del presupuesto a duplicar
   */
  async duplicateBudget(budgetId) {
    const original = await this.getBudget(budgetId);
    
    // Validar que no sea un presupuesto convertido
    if (original.status === BUDGET_STATUS.CONVERTED) {
      throw new Error('No se puede duplicar un presupuesto convertido');
    }

    // Crear copia con nuevos datos
    const duplicate = {
      ...original,
      id: this.generateBudgetId(),
      parentBudgetId: original.id,
      createdAt: new Date(),
      validUntil: this.calculateExpiryDate(),
      status: BUDGET_STATUS.ACTIVE,
      convertedSaleId: null,
      history: [{
        action: 'duplicated',
        originalBudgetId: original.id,
        timestamp: new Date(),
        user: this.getCurrentUser()
      }],
      version: 1
    };

    // Eliminar propiedades no necesarias
    delete duplicate._id;
    delete duplicate.lastSynced;

    // Guardar duplicado
    const newBudget = await this.createBudget(duplicate.clientData, duplicate.items);
    
    return newBudget;
  }

  // -------------------- FUNCIONES DE VALIDACIÓN --------------------

  /**
   * Validar items del presupuesto
   */
  async validateItems(items) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('Items no válidos');
    }

    const validatedItems = [];
    
    for (const item of items) {
      // Validar producto existente
      if (!await this.productExists(item.productId)) {
        throw new Error(`Producto ${item.productId} no encontrado`);
      }

      // Validar que no sea descontinuado
      if (await this.isDiscontinued(item.productId)) {
        throw new Error(`Producto ${item.productId} está descontinuado`);
      }

      // Obtener precio vigente
      const currentPrice = await this.getCurrentPrice(item.productId);
      
      validatedItems.push({
        ...item,
        unitPrice: currentPrice,
        total: item.quantity * currentPrice,
        originalPrice: currentPrice // Guardar precio original del presupuesto
      });
    }

    return validatedItems;
  }

  /**
   * Validar conversión de presupuesto
   */
  validateConversion(budget) {
    if (budget.status === BUDGET_STATUS.CONVERTED) {
      throw new Error('Presupuesto ya convertido');
    }

    if (budget.status === BUDGET_STATUS.EXPIRED) {
      throw new Error('Presupuesto expirado');
    }

    if (this.isBudgetExpired(budget)) {
      throw new Error('Presupuesto ha vencido');
    }
  }

  // -------------------- FUNCIONES DE CÁLCULO --------------------

  calculateTotals(items) {
    const subtotal = items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
    const taxes = subtotal * 0.21; // Ejemplo: 21% IVA
    const total = subtotal + taxes;
    
    return { subtotal, taxes, total };
  }

  calculateExpiryDate() {
    const date = new Date();
    date.setDate(date.getDate() + BUDGET_EXPIRY_DAYS);
    return date;
  }

  calculateSaleTotal(items, currentPrices) {
    return items.reduce((total, item) => {
      const price = currentPrices[item.productId] || item.unitPrice;
      return total + (item.quantity * price);
    }, 0);
  }

  // -------------------- FUNCIONES DE CACHÉ --------------------

  getFromCache(budgetId) {
    this.cleanCacheIfNeeded();
    
    const cached = budgetCache.get(budgetId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return cached.data;
    }
    
    budgetCache.delete(budgetId);
    return null;
  }

  updateCache(budgetId, data) {
    budgetCache.set(budgetId, {
      data,
      timestamp: Date.now()
    });
  }

  invalidateCache(budgetId) {
    budgetCache.delete(budgetId);
  }

  cleanCacheIfNeeded() {
    if (Date.now() - cacheLastClean > CACHE_TTL) {
      for (const [key, value] of budgetCache.entries()) {
        if (Date.now() - value.timestamp > CACHE_TTL) {
          budgetCache.delete(key);
        }
      }
      cacheLastClean = Date.now();
    }
  }

  // -------------------- FUNCIONES OFFLINE --------------------

  setupOfflineSync() {
    window.addEventListener('online', async () => {
      await this.syncOfflineBudgets();
    });
  }

  async saveBudgetOffline(budget) {
    budget.offline = true;
    this.offlineBudgets.set(budget.id, budget);
    
    // Guardar en storage local
    localStorage.setItem(`budget_offline_${budget.id}`, JSON.stringify(budget));
    
    return budget;
  }

  async syncOfflineBudgets() {
    for (const [budgetId, budget] of this.offlineBudgets.entries()) {
      try {
        // Validar precios actuales antes de sincronizar
        const validatedItems = await this.validateItems(budget.items);
        budget.items = validatedItems;
        budget.offline = false;
        budget.lastSynced = new Date();
        
        // Guardar en servidor
        await this.saveBudgetOnline(budget);
        
        // Eliminar de almacenamiento offline
        this.offlineBudgets.delete(budgetId);
        localStorage.removeItem(`budget_offline_${budgetId}`);
      } catch (error) {
        console.error(`Error sincronizando presupuesto ${budgetId}:`, error);
      }
    }
  }

  // -------------------- FUNCIONES TIEMPO REAL --------------------

  setupRealTimeSync() {
    // Configurar WebSocket o similar para actualizaciones en tiempo real
    this.setupWebSocket();
  }

  setupWebSocket() {
    // Implementar conexión WebSocket para actualizaciones
    // Notificar cambios en presupuestos
  }

  startExpiryNotifier() {
    // Verificar vencimientos cada hora
    setInterval(async () => {
      await this.checkExpiringBudgets();
    }, 60 * 60 * 1000);
  }

  async checkExpiringBudgets() {
    const activeBudgets = await this.getActiveBudgets();
    const now = new Date();
    
    for (const budget of activeBudgets) {
      const daysLeft = Math.floor((new Date(budget.validUntil) - now) / (1000 * 60 * 60 * 24));
      
      if (daysLeft <= 3) {
        // Notificar vencimiento próximo
        await this.notifyBudgetExpiry(budget, daysLeft);
      }
    }
  }

  // -------------------- FUNCIONES AUXILIARES --------------------

  isBudgetExpired(budget) {
    return new Date(budget.validUntil) < new Date();
  }

  generateBudgetId() {
    return `BGT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  generateSaleId() {
    return `SALE-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  getCurrentUser() {
    // Implementar según sistema de autenticación
    return 'system_user';
  }

  // -------------------- MÉTODOS A IMPLEMENTAR SEGÚN SISTEMA --------------------

  async checkConnection() {
    // Implementar lógica de verificación de conexión
    return navigator.onLine;
  }

  async productExists(productId) {
    // Implementar verificación de producto
    return true;
  }

  async isDiscontinued(productId) {
    // Implementar verificación de producto descontinuado
    return false;
  }

  async getCurrentPrice(productId) {
    // Implementar obtención de precio vigente
    return 0;
  }

  async getCurrentPrices(items) {
    // Implementar obtención de precios actuales
    return {};
  }

  async checkStockAvailability(items) {
    // Implementar verificación de stock
    return true;
  }

  async updateStock(items, operation) {
    // Implementar actualización de stock
  }

  async createSale(saleData) {
    // Implementar creación de venta
    return saleData;
  }

  async saveBudgetOnline(budget) {
    // Implementar guardado en servidor
    return budget;
  }

  async saveBudgetUpdate(budgetId, updates) {
    // Implementar actualización en servidor
    return updates;
  }

  async fetchBudgetFromDB(budgetId) {
    // Implementar obtención de base de datos
    return null;
  }

  async fetchBudgetsByClient(clientId) {
    // Implementar obtención por cliente
    return [];
  }

  async fetchAllBudgets() {
    // Implementar obtención de todos los presupuestos
    return [];
  }

  async clientExists(clientId) {
    // Implementar verificación de cliente
    return true;
  }

  async generateBudgetPDF(budget) {
    // Implementar generación de PDF
    return Buffer.from('');
  }

  async sendEmail(emailData) {
    // Implementar envío de email
  }

  formatForPrint(budget) {
    // Implementar formateo para impresión
    return budget;
  }

  async sendToPrinter(printData) {
    // Implementar envío a impresora
  }

  isValidEmail(email) {
    // Implementar validación de email
    return true;
  }

  async validateUpdates(budget, updates) {
    // Validar que las actualizaciones sean permitidas
    const allowedUpdates = ['items', 'clientData', 'validUntil'];
    const validated = {};
    
    for (const key in updates) {
      if (allowedUpdates.includes(key)) {
        validated[key] = updates[key];
      }
    }
    
    return validated;
  }

  async notifyBudgetExpiry(budget, daysLeft) {
    // Implementar notificación de vencimiento
    console.log(`Presupuesto ${budget.id} vence en ${daysLeft} días`);
  }
}

// Exportar instancia única
const budgetManager = new BudgetManager();
export default budgetManager;
