// sales.js - Sistema completo de gestión de ventas y tickets
const { db, admin, auth } = require('./firebase-config');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { generateTicketNumber, validateStock, updateCashRegister } = require('./sales-helpers');
const { printService, emailService } = require('./services');

// Configuración
const MAX_DAILY_SALES = 1000;
const REQUIRED_FISCAL_DATA = ['businessName', 'taxId', 'address', 'receiptType'];

// Estados de venta
const SALE_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  RETURNED: 'returned',
  PARTIALLY_RETURNED: 'partially_returned'
};

class SalesManager {
  constructor(localId, userId) {
    this.localId = localId;
    this.userId = userId;
    this.offlineMode = false;
    this.pendingSales = [];
    this.initOfflineSync();
  }

  /**
   * Crea una nueva venta
   * @param {Object} cartData - Datos del carrito
   * @param {Object} paymentData - Datos de pago
   * @returns {Promise<Object>} Venta creada
   */
  async createSale(cartData, paymentData) {
    try {
      // Validaciones iniciales
      await this.validateSaleData(cartData, paymentData);
      
      // Verificar límite diario
      await this.checkDailyLimit();
      
      // Generar ID único para la venta
      const saleId = this.offlineMode 
        ? `temp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        : db.collection('sales').doc().id;
      
      // Generar número de ticket
      const ticketNumber = await generateTicketNumber(this.localId);
      
      // Preparar datos de la venta
      const saleData = {
        saleId,
        localId: this.localId,
        userId: this.userId,
        ticketNumber,
        date: Timestamp.now(),
        cartData: this.sanitizeCartData(cartData),
        paymentData: this.validatePaymentMethods(paymentData),
        status: SALE_STATUS.COMPLETED,
        fiscalData: await this.getFiscalData(),
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        offline: this.offlineMode
      };
      
      // Si está en modo offline, guardar localmente
      if (this.offlineMode) {
        return this.createOfflineSale(saleData);
      }
      
      // Transacción en lote para asegurar consistencia
      const batch = db.batch();
      const saleRef = db.collection('sales').doc(saleId);
      
      // Agregar venta principal
      batch.set(saleRef, saleData);
      
      // Agregar items como subcolección
      const itemsRef = saleRef.collection('items');
      cartData.items.forEach(item => {
        const itemRef = itemsRef.doc(item.productId);
        batch.set(itemRef, {
          ...item,
          saleId,
          addedAt: Timestamp.now()
        });
        
        // Actualizar stock
        const productRef = db.collection('products').doc(item.productId);
        batch.update(productRef, {
          stock: FieldValue.increment(-item.quantity),
          lastSale: Timestamp.now()
        });
      });
      
      // Actualizar resumen diario
      const dailySummaryRef = db.collection('dailySummaries')
        .doc(`${this.localId}_${new Date().toISOString().split('T')[0]}`);
      
      batch.set(dailySummaryRef, {
        totalSales: FieldValue.increment(1),
        totalAmount: FieldValue.increment(cartData.total),
        lastUpdate: Timestamp.now()
      }, { merge: true });
      
      // Actualizar caja en tiempo real
      await updateCashRegister(this.localId, cartData.total, paymentData);
      
      // Ejecutar batch
      await batch.commit();
      
      // Notificar a supervisor
      await this.notifySupervisor(saleData);
      
      // Retornar venta creada
      const createdSale = await this.getSale(saleId);
      
      // Actualizar caché offline si existe
      await this.syncPendingSales();
      
      return createdSale;
      
    } catch (error) {
      console.error('Error al crear venta:', error);
      throw this.handleError(error);
    }
  }

  /**
   * Obtiene una venta por ID
   * @param {string} saleId - ID de la venta
   * @returns {Promise<Object>} Datos de la venta
   */
  async getSale(saleId) {
    try {
      // Verificar si es venta temporal offline
      if (saleId.startsWith('temp_')) {
        return this.getOfflineSale(saleId);
      }
      
      const saleRef = db.collection('sales').doc(saleId);
      const itemsRef = saleRef.collection('items');
      
      const [saleDoc, itemsSnapshot] = await Promise.all([
        saleRef.get(),
        itemsRef.get()
      ]);
      
      if (!saleDoc.exists) {
        throw new Error('Venta no encontrada');
      }
      
      const saleData = saleDoc.data();
      const items = itemsSnapshot.docs.map(doc => doc.data());
      
      return {
        ...saleData,
        items,
        id: saleDoc.id
      };
    } catch (error) {
      console.error('Error al obtener venta:', error);
      throw error;
    }
  }

  /**
   * Cancela una venta (requiere autorización)
   * @param {string} saleId - ID de la venta
   * @param {string} reason - Razón de cancelación
   * @param {string} authToken - Token de autorización
   * @returns {Promise<Object>} Venta cancelada
   */
  async cancelSale(saleId, reason, authToken) {
    try {
      // Verificar autorización
      await this.validateCancellationAuth(authToken);
      
      // Obtener venta
      const sale = await this.getSale(saleId);
      
      // Validar que no sea histórica (más de 24 horas)
      const saleDate = sale.date.toDate();
      const hoursDiff = (new Date() - saleDate) / (1000 * 60 * 60);
      
      if (hoursDiff > 24 && sale.status !== SALE_STATUS.PENDING) {
        throw new Error('No se pueden cancelar ventas históricas');
      }
      
      // Validar que no esté ya cancelada
      if (sale.status === SALE_STATUS.CANCELLED) {
        throw new Error('La venta ya está cancelada');
      }
      
      // Revertir stock
      const batch = db.batch();
      
      sale.items.forEach(item => {
        const productRef = db.collection('products').doc(item.productId);
        batch.update(productRef, {
          stock: FieldValue.increment(item.quantity)
        });
      });
      
      // Actualizar estado de venta
      const saleRef = db.collection('sales').doc(saleId);
      batch.update(saleRef, {
        status: SALE_STATUS.CANCELLED,
        cancellationReason: reason,
        cancelledBy: this.userId,
        cancelledAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      });
      
      // Revertir en caja
      await updateCashRegister(this.localId, -sale.cartData.total, sale.paymentData, true);
      
      await batch.commit();
      
      return await this.getSale(saleId);
      
    } catch (error) {
      console.error('Error al cancelar venta:', error);
      throw error;
    }
  }

  /**
   * Procesa devolución de items
   * @param {string} saleId - ID de la venta
   * @param {Array} items - Items a devolver
   * @param {string} reason - Razón de devolución
   * @returns {Promise<Object>} Resultado de devolución
   */
  async returnItems(saleId, items, reason) {
    try {
      const sale = await this.getSale(saleId);
      
      // Validar que la venta esté completada
      if (sale.status !== SALE_STATUS.COMPLETED && 
          sale.status !== SALE_STATUS.PARTIALLY_RETURNED) {
        throw new Error('Solo se pueden devolver items de ventas completadas');
      }
      
      // Validar items a devolver
      const validItems = this.validateReturnItems(sale.items, items);
      
      const batch = db.batch();
      const saleRef = db.collection('sales').doc(saleId);
      const returnsRef = saleRef.collection('returns').doc();
      
      // Registrar devolución
      const returnData = {
        returnId: returnsRef.id,
        items: validItems,
        reason,
        returnedBy: this.userId,
        returnedAt: Timestamp.now(),
        totalAmount: validItems.reduce((sum, item) => sum + (item.price * item.quantity), 0)
      };
      
      batch.set(returnsRef, returnData);
      
      // Actualizar stock
      validItems.forEach(item => {
        const productRef = db.collection('products').doc(item.productId);
        batch.update(productRef, {
          stock: FieldValue.increment(item.quantity)
        });
      });
      
      // Actualizar estado de venta
      const allItemsReturned = sale.items.every(saleItem => {
        const returnedItem = validItems.find(i => i.productId === saleItem.productId);
        return returnedItem && returnedItem.quantity >= saleItem.quantity;
      });
      
      batch.update(saleRef, {
        status: allItemsReturned ? SALE_STATUS.RETURNED : SALE_STATUS.PARTIALLY_RETURNED,
        updatedAt: Timestamp.now()
      });
      
      // Revertir en caja
      await updateCashRegister(this.localId, -returnData.totalAmount, sale.paymentData, true);
      
      await batch.commit();
      
      return {
        success: true,
        returnId: returnsRef.id,
        returnedAmount: returnData.totalAmount
      };
      
    } catch (error) {
      console.error('Error en devolución:', error);
      throw error;
    }
  }

  /**
   * Obtiene ventas por fecha
   * @param {Date} date - Fecha a consultar
   * @param {Object} filters - Filtros adicionales
   * @returns {Promise<Array>} Lista de ventas
   */
  async getSalesByDate(date, filters = {}) {
    try {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      
      let query = db.collection('sales')
        .where('localId', '==', this.localId)
        .where('date', '>=', Timestamp.fromDate(startDate))
        .where('date', '<=', Timestamp.fromDate(endDate));
      
      // Aplicar filtros
      if (filters.status) {
        query = query.where('status', '==', filters.status);
      }
      
      if (filters.userId) {
        query = query.where('userId', '==', filters.userId);
      }
      
      // Ordenar por fecha descendente
      query = query.orderBy('date', 'desc').limit(1000);
      
      const snapshot = await query.get();
      
      const sales = await Promise.all(
        snapshot.docs.map(doc => this.getSale(doc.id))
      );
      
      return sales;
      
    } catch (error) {
      console.error('Error al obtener ventas por fecha:', error);
      throw error;
    }
  }

  /**
   * Obtiene ventas por usuario
   * @param {string} userId - ID del usuario
   * @param {Object} dateRange - Rango de fechas
   * @returns {Promise<Array>} Lista de ventas
   */
  async getSalesByUser(userId, dateRange = {}) {
    try {
      let query = db.collection('sales')
        .where('localId', '==', this.localId)
        .where('userId', '==', userId);
      
      // Filtrar por rango de fechas si se proporciona
      if (dateRange.start) {
        query = query.where('date', '>=', Timestamp.fromDate(dateRange.start));
      }
      
      if (dateRange.end) {
        query = query.where('date', '<=', Timestamp.fromDate(dateRange.end));
      }
      
      query = query.orderBy('date', 'desc').limit(500);
      
      const snapshot = await query.get();
      
      const sales = await Promise.all(
        snapshot.docs.map(doc => this.getSale(doc.id))
      );
      
      return sales;
      
    } catch (error) {
      console.error('Error al obtener ventas por usuario:', error);
      throw error;
    }
  }

  /**
   * Obtiene resumen diario de ventas
   * @param {Date} date - Fecha del resumen
   * @returns {Promise<Object>} Resumen de ventas
   */
  async getDailySummary(date) {
    try {
      const dateStr = date.toISOString().split('T')[0];
      const summaryRef = db.collection('dailySummaries')
        .doc(`${this.localId}_${dateStr}`);
      
      const summaryDoc = await summaryRef.get();
      
      if (!summaryDoc.exists) {
        return this.generateDailySummary(date);
      }
      
      const summary = summaryDoc.data();
      
      // Obtener ventas del día para calcular detalles
      const sales = await this.getSalesByDate(date);
      
      // Calcular detalles por método de pago
      const paymentMethods = {};
      sales.forEach(sale => {
        Object.keys(sale.paymentData.methods).forEach(method => {
          paymentMethods[method] = (paymentMethods[method] || 0) + 
            sale.paymentData.methods[method];
        });
      });
      
      return {
        ...summary,
        date: dateStr,
        totalTransactions: sales.length,
        paymentMethods,
        salesByHour: this.calculateSalesByHour(sales),
        averageTicket: sales.length > 0 ? summary.totalAmount / sales.length : 0
      };
      
    } catch (error) {
      console.error('Error al obtener resumen diario:', error);
      throw error;
    }
  }

  /**
   * Imprime ticket de venta
   * @param {string} saleId - ID de la venta
   * @param {string} template - Plantilla a usar
   * @returns {Promise<Object>} Resultado de impresión
   */
  async printTicket(saleId, template = 'default') {
    try {
      const sale = await this.getSale(saleId);
      
      // Validar datos fiscales mínimos
      this.validateFiscalData(sale.fiscalData);
      
      // Preparar datos para impresión
      const ticketData = {
        ...sale,
        printDate: new Date().toLocaleString(),
        printerId: this.getPrinterId(),
        template
      };
      
      // Generar HTML del ticket según plantilla
      const ticketHtml = await this.generateTicketHtml(ticketData, template);
      
      // Enviar a impresión
      const printResult = await printService.print(ticketHtml, {
        printer: this.getPrinterConfig(),
        copies: 1,
        timeout: 30000 // 30 segundos timeout
      });
      
      // Registrar impresión
      await this.logTicketPrint(saleId, printResult);
      
      return {
        success: true,
        printJobId: printResult.jobId,
        ticketNumber: sale.ticketNumber
      };
      
    } catch (error) {
      console.error('Error al imprimir ticket:', error);
      
      // Guardar en cola de reimpresión si falla
      await this.queueForReprint(saleId, error.message);
      
      throw new Error(`Error de impresión: ${error.message}`);
    }
  }

  /**
   * Envía ticket por email
   * @param {string} saleId - ID de la venta
   * @param {string} email - Email del cliente
   * @returns {Promise<Object>} Resultado del envío
   */
  async sendTicketByEmail(saleId, email) {
    try {
      // Validar consentimiento del cliente
      const consent = await this.validateEmailConsent(saleId, email);
      
      if (!consent) {
        throw new Error('El cliente no ha dado consentimiento para emails');
      }
      
      const sale = await this.getSale(saleId);
      
      // Validar datos fiscales
      this.validateFiscalData(sale.fiscalData);
      
      // Generar PDF del ticket
      const pdfBuffer = await this.generateTicketPdf(sale);
      
      // Enviar email
      const emailResult = await emailService.send({
        to: email,
        subject: `Tu ticket de compra #${sale.ticketNumber}`,
        body: this.generateEmailBody(sale),
        attachments: [{
          filename: `ticket-${sale.ticketNumber}.pdf`,
          content: pdfBuffer
        }]
      });
      
      // Registrar envío
      await this.logEmailSent(saleId, email, emailResult);
      
      return {
        success: true,
        messageId: emailResult.messageId,
        email: email
      };
      
    } catch (error) {
      console.error('Error al enviar ticket por email:', error);
      throw error;
    }
  }

  /**
   * Aplica promoción a una venta
   * @param {string} saleId - ID de la venta
   * @param {Object} promotion - Datos de la promoción
   * @returns {Promise<Object>} Venta actualizada
   */
  async applyPromotion(saleId, promotion) {
    try {
      const sale = await this.getSale(saleId);
      
      // Validar que la venta esté activa
      if (sale.status !== SALE_STATUS.COMPLETED && 
          sale.status !== SALE_STATUS.PENDING) {
        throw new Error('No se pueden aplicar promociones a ventas canceladas o devueltas');
      }
      
      // Validar promoción
      await this.validatePromotion(promotion, sale);
      
      // Calcular descuentos
      const discountResult = this.calculateDiscount(sale, promotion);
      
      // Actualizar venta con descuento
      const saleRef = db.collection('sales').doc(saleId);
      
      await saleRef.update({
        'cartData.discount': discountResult.totalDiscount,
        'cartData.finalTotal': sale.cartData.total - discountResult.totalDiscount,
        'promotionApplied': {
          promotionId: promotion.id,
          name: promotion.name,
          discount: discountResult.totalDiscount,
          appliedAt: Timestamp.now()
        },
        updatedAt: Timestamp.now()
      });
      
      // Actualizar items si hay descuentos específicos
      if (discountResult.itemDiscounts.length > 0) {
        const batch = db.batch();
        
        discountResult.itemDiscounts.forEach(itemDiscount => {
          const itemRef = saleRef.collection('items').doc(itemDiscount.productId);
          batch.update(itemRef, {
            discount: itemDiscount.discount,
            finalPrice: itemDiscount.finalPrice
          });
        });
        
        await batch.commit();
      }
      
      // Recalcular caja
      await updateCashRegister(
        this.localId, 
        -discountResult.totalDiscount, 
        sale.paymentData, 
        true
      );
      
      return await this.getSale(saleId);
      
    } catch (error) {
      console.error('Error al aplicar promoción:', error);
      throw error;
    }
  }

  // ========== MÉTODOS AUXILIARES ==========

  /**
   * Valida datos de la venta
   */
  async validateSaleData(cartData, paymentData) {
    if (!cartData || !cartData.items || cartData.items.length === 0) {
      throw new Error('El carrito está vacío');
    }
    
    if (!paymentData || Object.keys(paymentData.methods || {}).length === 0) {
      throw new Error('Se requiere al menos un método de pago');
    }
    
    // Validar stock disponible
    await validateStock(cartData.items, this.localId);
    
    // Validar total coincide
    const calculatedTotal = cartData.items.reduce(
      (sum, item) => sum + (item.price * item.quantity), 0
    );
    
    if (Math.abs(calculatedTotal - cartData.total) > 0.01) {
      throw new Error('El total calculado no coincide con los items');
    }
  }

  /**
   * Verifica límite diario de ventas
   */
  async checkDailyLimit() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const salesCount = await db.collection('sales')
      .where('localId', '==', this.localId)
      .where('date', '>=', Timestamp.fromDate(today))
      .count()
      .get();
    
    if (salesCount.data().count >= MAX_DAILY_SALES) {
      throw new Error('Se ha alcanzado el límite diario de ventas');
    }
  }

  /**
   * Valida métodos de pago
   */
  validatePaymentMethods(paymentData) {
    const validMethods = ['cash', 'card', 'transfer', 'credit'];
    const methods = paymentData.methods || {};
    
    // Verificar que todos los métodos sean válidos
    Object.keys(methods).forEach(method => {
      if (!validMethods.includes(method)) {
        throw new Error(`Método de pago inválido: ${method}`);
      }
    });
    
    // Verificar que la suma coincida con el total
    const totalPaid = Object.values(methods).reduce((a, b) => a + b, 0);
    
    if (Math.abs(totalPaid - paymentData.total) > 0.01) {
      throw new Error('La suma de los métodos de pago no coincide con el total');
    }
    
    return {
      ...paymentData,
      methods,
      totalPaid
    };
  }

  /**
   * Obtiene datos fiscales del local
   */
  async getFiscalData() {
    const localRef = db.collection('locals').doc(this.localId);
    const localDoc = await localRef.get();
    
    if (!localDoc.exists) {
      throw new Error('Local no encontrado');
    }
    
    const localData = localDoc.data();
    
    // Verificar datos fiscales requeridos
    REQUIRED_FISCAL_DATA.forEach(field => {
      if (!localData[field]) {
        throw new Error(`Falta dato fiscal requerido: ${field}`);
      }
    });
    
    return {
      businessName: localData.businessName,
      taxId: localData.taxId,
      address: localData.address,
      receiptType: localData.receiptType,
      phone: localData.phone,
      email: localData.email
    };
  }

  /**
   * Valida datos fiscales
   */
  validateFiscalData(fiscalData) {
    REQUIRED_FISCAL_DATA.forEach(field => {
      if (!fiscalData || !fiscalData[field]) {
        throw new Error(`Ticket inválido: falta dato fiscal '${field}'`);
      }
    });
  }

  /**
   * Sanitiza datos del carrito
   */
  sanitizeCartData(cartData) {
    return {
      items: cartData.items.map(item => ({
        productId: item.productId,
        name: item.name,
        quantity: item.quantity,
        price: parseFloat(item.price),
        subtotal: parseFloat(item.price) * parseInt(item.quantity)
      })),
      subtotal: parseFloat(cartData.subtotal || 0),
      tax: parseFloat(cartData.tax || 0),
      total: parseFloat(cartData.total || 0),
      customerNotes: cartData.customerNotes || ''
    };
  }

  /**
   * Valida items para devolución
   */
  validateReturnItems(saleItems, returnItems) {
    const validItems = [];
    
    returnItems.forEach(returnItem => {
      const saleItem = saleItems.find(item => item.productId === returnItem.productId);
      
      if (!saleItem) {
        throw new Error(`Producto ${returnItem.productId} no encontrado en la venta`);
      }
      
      if (returnItem.quantity > saleItem.quantity) {
        throw new Error(`Cantidad a devolver excede la cantidad vendida para ${saleItem.name}`);
      }
      
      validItems.push({
        ...returnItem,
        price: saleItem.price,
        maxQuantity: saleItem.quantity
      });
    });
    
    return validItems;
  }

  /**
   * Valida autorización para cancelación
   */
  async validateCancellationAuth(authToken) {
    // Verificar token con Firebase Auth
    const decodedToken = await auth.verifyIdToken(authToken);
    
    // Verificar rol de supervisor o administrador
    const userRef = db.collection('users').doc(decodedToken.uid);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      throw new Error('Usuario no autorizado');
    }
    
    const userRole = userDoc.data().role;
    const allowedRoles = ['supervisor', 'admin', 'manager'];
    
    if (!allowedRoles.includes(userRole)) {
      throw new Error('No tiene permisos para cancelar ventas');
    }
  }

  /**
   * Genera resumen diario
   */
  async generateDailySummary(date) {
    const sales = await this.getSalesByDate(date);
    
    const summary = {
      date: date.toISOString().split('T')[0],
      localId: this.localId,
      totalSales: sales.length,
      totalAmount: sales.reduce((sum, sale) => sum + sale.cartData.total, 0),
      totalTransactions: sales.length,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    };
    
    // Guardar en base de datos
    const dateStr = date.toISOString().split('T')[0];
    const summaryRef = db.collection('dailySummaries')
      .doc(`${this.localId}_${dateStr}`);
    
    await summaryRef.set(summary);
    
    return summary;
  }

  /**
   * Calcula ventas por hora
   */
  calculateSalesByHour(sales) {
    const salesByHour = {};
    
    sales.forEach(sale => {
      const hour = sale.date.toDate().getHours();
      salesByHour[hour] = (salesByHour[hour] || 0) + 1;
    });
    
    return salesByHour;
  }

  /**
   * Notifica al supervisor
   */
  async notifySupervisor(saleData) {
    try {
      // Obtener supervisores del local
      const supervisors = await db.collection('users')
        .where('localId', '==', this.localId)
        .where('role', '==', 'supervisor')
        .get();
      
      if (supervisors.empty) return;
      
      // Enviar notificación a cada supervisor
      const notifications = supervisors.docs.map(doc => {
        const supervisor = doc.data();
        
        return db.collection('notifications').add({
          userId: supervisor.userId,
          type: 'new_sale',
          title: 'Nueva venta realizada',
          message: `Venta #${saleData.ticketNumber} por $${saleData.cartData.total}`,
          data: {
            saleId: saleData.saleId,
            ticketNumber: saleData.ticketNumber,
            amount: saleData.cartData.total
          },
          read: false,
          createdAt: Timestamp.now()
        });
      });
      
      await Promise.all(notifications);
      
    } catch (error) {
      console.error('Error al notificar supervisor:', error);
      // No lanzar error para no afectar la venta principal
    }
  }

  // ========== MÉTODOS OFFLINE ==========

  /**
   * Inicializa sincronización offline
   */
  initOfflineSync() {
    // Verificar conexión
    this.checkConnection();
    
    // Escuchar cambios en conexión
    window.addEventListener('online', () => this.onConnectionRestored());
    window.addEventListener('offline', () => this.onConnectionLost());
    
    // Cargar ventas pendientes del localStorage
    this.loadPendingSales();
  }

  /**
   * Crea venta offline
   */
  async createOfflineSale(saleData) {
    // Guardar en localStorage
    const pendingSales = JSON.parse(localStorage.getItem('pendingSales') || '[]');
    
    // Agregar metadata offline
    const offlineSale = {
      ...saleData,
      offlineId: saleData.saleId,
      syncAttempts: 0,
      lastSyncAttempt: null,
      syncPriority: saleData.cartData.total > 100 ? 'high' : 'normal'
    };
    
    pendingSales.push(offlineSale);
    localStorage.setItem('pendingSales', JSON.stringify(pendingSales));
    
    // Actualizar caché en memoria
    this.pendingSales = pendingSales;
    
    // Validar stock localmente
    await this.validateOfflineStock(saleData.cartData.items);
    
    return offlineSale;
  }

  /**
   * Obtiene venta offline
   */
  async getOfflineSale(saleId) {
    const pendingSales = JSON.parse(localStorage.getItem('pendingSales') || '[]');
    return pendingSales.find(sale => sale.saleId === saleId);
  }

  /**
   * Valida stock offline
   */
  async validateOfflineStock(items) {
    // Cargar caché de productos
    const productsCache = JSON.parse(localStorage.getItem('productsCache') || '{}');
    
    items.forEach(item => {
      const product = productsCache[item.productId];
      
      if (!product) {
        throw new Error(`Producto ${item.productId} no disponible offline`);
      }
      
      if (product.stock < item.quantity) {
        throw new Error(`Stock insuficiente para ${product.name}`);
      }
    });
  }

  /**
   * Sincroniza ventas pendientes
   */
  async syncPendingSales() {
    if (this.offlineMode) return;
    
    const pendingSales = JSON.parse(localStorage.getItem('pendingSales') || '[]');
    
    if (pendingSales.length === 0) return;
    
    // Ordenar por prioridad (monto alto primero, luego intentos fallidos)
    pendingSales.sort((a, b) => {
      if (a.syncPriority === 'high' && b.syncPriority !== 'high') return -1;
      if (b.syncPriority === 'high' && a.syncPriority !== 'high') return 1;
      return a.syncAttempts - b.syncAttempts;
    });
    
    for (const sale of pendingSales) {
      try {
        // Intentar sincronizar
        await this.syncSingleSale(sale);
        
        // Eliminar de pendientes si éxito
        this.removePendingSale(sale.offlineId);
        
      } catch (error) {
        console.error(`Error sincronizando venta ${sale.offlineId}:`, error);
        
        // Incrementar intentos fallidos
        sale.syncAttempts++;
        sale.lastSyncAttempt = new Date().toISOString();
        
        // Actualizar en localStorage
        this.updatePendingSale(sale);
      }
    }
  }

  /**
   * Sincroniza una sola venta
   */
  async syncSingleSale(sale) {
    // Remover ID temporal
    const { offlineId, syncAttempts, lastSyncAttempt, syncPriority, ...saleData } = sale;
    
    // Usar createSale normal
    return await this.createSale(saleData.cartData, saleData.paymentData);
  }

  /**
   * Maneja error genérico
   */
  handleError(error) {
    // Clasificar errores
    const errorMap = {
      'permission-denied': 'No tiene permisos para realizar esta acción',
      'unavailable': 'Servicio no disponible. Modo offline activado',
      'deadline-exceeded': 'Tiempo de espera agotado',
      'resource-exhausted': 'Límite de operaciones alcanzado'
    };
    
    const message = errorMap[error.code] || error.message;
    
    // Si es error de conexión, activar modo offline
    if (error.code === 'unavailable' || error.message.includes('network')) {
      this.offlineMode = true;
    }
    
    return new Error(message);
  }
}

module.exports = SalesManager;

// Índices recomendados para Firestore:
/*
Colección: sales
- Índice 1: localId, date DESC
- Índice 2: localId, status, date DESC
- Índice 3: userId, date DESC
- Índice 4: ticketNumber ASC (único por local)

Colección: dailySummaries
- Índice: localId, date DESC

Colección: products
- Índice: localId, stock ASC
*/
