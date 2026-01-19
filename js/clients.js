// clients.js - Gestor de clientes, cuenta corriente y deudas
// Reglas: Por local, offline/online, tiempo real, validaciones estrictas

const ClientManager = (() => {
  // ========== CONFIGURACIÓN ==========
  const CONFIG = {
    MAX_DEBT_LIMIT: 100000, // Límite máximo de deuda permitida
    PAGE_SIZE: 50,
    OFFLINE_CACHE_SIZE: 100,
    DEBT_ALERT_DAYS: 30
  };

  // ========== ESTRUCTURAS DE DATOS ==========
  const clients = new Map(); // Map<clientId, client>
  const movements = new Map(); // Map<clientId, movement[]>
  const indexes = {
    name: new Map(), // Map<localId, Map<normalizedName, Set<clientId>>>
    dni: new Map(),  // Map<localId, Map<dni, clientId>>
    email: new Map(), // Map<localId, Map<email, clientId>>
    localId: new Map() // Map<localId, Set<clientId>>
  };

  // ========== CACHÉ OFFLINE ==========
  const offlineCache = {
    pendingClients: new Map(),
    pendingMovements: new Map(),
    frequentClients: new LRUCache(CONFIG.OFFLINE_CACHE_SIZE)
  };

  // ========== HELPERS ==========
  const validators = {
    dni: (dni, localId) => {
      if (!/^[0-9]{8,11}$/.test(dni)) return false;
      const existing = indexes.dni.get(localId)?.get(dni);
      return !existing;
    },
    
    cuit: (cuit) => /^[0-9]{2}-[0-9]{8}-[0-9]$/.test(cuit),
    
    creditLimit: (currentDebt, newDebt, limit) => {
      return currentDebt + newDebt <= limit;
    }
  };

  const security = {
    maskPersonalData: (client) => {
      const masked = { ...client };
      if (masked.dni) masked.dni = masked.dni.slice(0, 3) + '*****';
      if (masked.email) {
        const [user, domain] = masked.email.split('@');
        masked.email = user.slice(0, 2) + '***@' + domain;
      }
      return masked;
    },
    
    auditLog: (action, userId, clientId, details) => {
      return {
        timestamp: new Date().toISOString(),
        action,
        userId,
        clientId,
        details
      };
    }
  };

  // ========== FUNCIONES PRINCIPALES ==========
  
  /**
   * Crear nuevo cliente con validaciones
   */
  const createClient = async (clientData) => {
    // Validaciones básicas
    if (!clientData.localId) throw new Error('LocalId es requerido');
    if (!clientData.createdBy) throw new Error('Usuario creador es requerido');
    
    // Validar DNI único por local
    if (clientData.dni && !validators.dni(clientData.dni, clientData.localId)) {
      throw new Error('DNI ya existe o es inválido');
    }
    
    // Estructura del cliente
    const client = {
      id: generateId(),
      ...clientData,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isActive: true,
      creditLimit: clientData.creditLimit || CONFIG.MAX_DEBT_LIMIT,
      currentDebt: 0,
      lastPaymentDate: null,
      tags: clientData.tags || [],
      metadata: {
        createdBy: clientData.createdBy,
        modifiedBy: clientData.createdBy,
        modificationHistory: []
      }
    };
    
    // Guardar en almacenamiento principal
    clients.set(client.id, client);
    
    // Actualizar índices
    updateIndexes('add', client);
    
    // Auditoría
    logAudit('CREATE', clientData.createdBy, client.id, clientData);
    
    // Si está offline, agregar a cola de sincronización
    if (navigator && !navigator.onLine) {
      offlineCache.pendingClients.set(client.id, client);
      offlineCache.frequentClients.set(client.id, client);
    }
    
    return { success: true, clientId: client.id };
  };

  /**
   * Actualizar cliente (sin modificar historial)
   */
  const updateClient = async (clientId, updates) => {
    const client = clients.get(clientId);
    if (!client) throw new Error('Cliente no encontrado');
    
    // Campos protegidos que no se pueden modificar
    const protectedFields = ['id', 'createdAt', 'metadata.creation'];
    protectedFields.forEach(field => {
      if (updates[field] !== undefined) {
        throw new Error(`No se puede modificar el campo: ${field}`);
      }
    });
    
    // Validar DNI si se actualiza
    if (updates.dni && updates.dni !== client.dni) {
      if (!validators.dni(updates.dni, client.localId)) {
        throw new Error('DNI ya existe o es inválido');
      }
      // Remover índice antiguo
      removeFromIndex('dni', client);
    }
    
    // Actualizar
    const updatedClient = {
      ...client,
      ...updates,
      updatedAt: new Date().toISOString(),
      metadata: {
        ...client.metadata,
        modifiedBy: updates.modifiedBy || 'system',
        modificationHistory: [
          ...client.metadata.modificationHistory,
          security.auditLog('UPDATE', updates.modifiedBy, clientId, updates)
        ]
      }
    };
    
    clients.set(clientId, updatedClient);
    
    // Actualizar índices
    updateIndexes('update', updatedClient, client);
    
    // Sincronización en tiempo real
    if (typeof io !== 'undefined') {
      io.emit('client:updated', { clientId, localId: client.localId });
    }
    
    return { success: true };
  };

  /**
   * Búsqueda con paginación e índices
   */
  const searchClients = (query, localId, page = 1) => {
    let results = new Set();
    
    // Búsqueda por índice
    if (query.name) {
      const normalized = query.name.toLowerCase().trim();
      const localNames = indexes.name.get(localId);
      if (localNames) {
        for (let [key, clientSet] of localNames) {
          if (key.includes(normalized)) {
            clientSet.forEach(id => results.add(id));
          }
        }
      }
    }
    
    if (query.dni && indexes.dni.get(localId)?.has(query.dni)) {
      results.add(indexes.dni.get(localId).get(query.dni));
    }
    
    // Si no hay resultados de índice, búsqueda secuencial
    if (results.size === 0) {
      const localClients = indexes.localId.get(localId);
      if (localClients) {
        localClients.forEach(id => {
          const client = clients.get(id);
          if (matchesQuery(client, query)) results.add(id);
        });
      }
    }
    
    // Paginación
    const resultArray = Array.from(results);
    const start = (page - 1) * CONFIG.PAGE_SIZE;
    const paginated = resultArray.slice(start, start + CONFIG.PAGE_SIZE);
    
    // Enmascarar datos sensibles
    const safeResults = paginated.map(id => {
      const client = clients.get(id);
      return security.maskPersonalData(client);
    });
    
    return {
      page,
      totalPages: Math.ceil(resultArray.length / CONFIG.PAGE_SIZE),
      totalResults: resultArray.length,
      clients: safeResults
    };
  };

  /**
   * Obtener deudas del cliente con detalles
   */
  const getClientDebts = (clientId) => {
    const client = clients.get(clientId);
    if (!client) throw new Error('Cliente no encontrado');
    
    const clientMovements = movements.get(clientId) || [];
    const debts = clientMovements.filter(m => 
      m.type === 'sale' && m.balance > 0
    ).map(debt => ({
      id: debt.id,
      date: debt.date,
      description: debt.description,
      originalAmount: debt.amount,
      currentBalance: debt.balance,
      dueDate: debt.dueDate,
      isOverdue: debt.dueDate && new Date(debt.dueDate) < new Date()
    }));
    
    // Calcular días de atraso
    debts.forEach(debt => {
      if (debt.dueDate) {
        const due = new Date(debt.dueDate);
        const today = new Date();
        debt.daysOverdue = Math.max(0, Math.floor((today - due) / (1000*60*60*24)));
      }
    });
    
    return {
      clientId,
      totalDebt: client.currentDebt,
      debts,
      creditLimit: client.creditLimit,
      availableCredit: client.creditLimit - client.currentDebt
    };
  };

  /**
   * Registrar pago y actualizar saldo
   */
  const addClientPayment = async (clientId, paymentData) => {
    const client = clients.get(clientId);
    if (!client) throw new Error('Cliente no encontrado');
    
    // Validar monto positivo
    if (paymentData.amount <= 0) {
      throw new Error('El monto debe ser positivo');
    }
    
    // Crear movimiento de pago
    const paymentMovement = {
      id: generateId(),
      clientId,
      type: 'payment',
      amount: paymentData.amount,
      date: new Date().toISOString(),
      description: paymentData.description || 'Pago',
      paymentMethod: paymentData.method,
      reference: paymentData.reference,
      appliedTo: [], // Se llenará al aplicar a deudas específicas
      createdBy: paymentData.createdBy
    };
    
    // Aplicar pago a deudas (FIFO: más antiguas primero)
    const pendingDebts = (movements.get(clientId) || [])
      .filter(m => m.type === 'sale' && m.balance > 0)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    
    let remaining = paymentData.amount;
    for (const debt of pendingDebts) {
      if (remaining <= 0) break;
      
      const toPay = Math.min(debt.balance, remaining);
      debt.balance -= toPay;
      debt.lastPaymentDate = new Date().toISOString();
      remaining -= toPay;
      
      paymentMovement.appliedTo.push({
        debtId: debt.id,
        amount: toPay
      });
    }
    
    // Si sobra dinero, queda como saldo a favor
    if (remaining > 0) {
      paymentMovement.creditBalance = remaining;
    }
    
    // Actualizar saldo del cliente
    client.currentDebt = Math.max(0, client.currentDebt - paymentData.amount);
    client.lastPaymentDate = new Date().toISOString();
    client.updatedAt = new Date().toISOString();
    
    // Guardar movimiento
    if (!movements.has(clientId)) movements.set(clientId, []);
    movements.get(clientId).push(paymentMovement);
    
    // Actualizar cliente
    clients.set(clientId, client);
    
    // Notificación en tiempo real
    if (typeof io !== 'undefined') {
      io.emit('payment:received', {
        clientId,
        amount: paymentData.amount,
        localId: client.localId
      });
      
      // Alerta si saldo bajo cierto umbral
      if (client.currentDebt < client.creditLimit * 0.1) {
        io.emit('client:lowBalance', { clientId, balance: client.currentDebt });
      }
    }
    
    // Auditoría
    logAudit('PAYMENT', paymentData.createdBy, clientId, paymentData);
    
    return {
      success: true,
      paymentId: paymentMovement.id,
      remainingCredit: client.creditLimit - client.currentDebt,
      applied: paymentMovement.appliedTo
    };
  };

  /**
   * Historial completo del cliente
   */
  const getClientHistory = (clientId, limit = 100) => {
    const client = clients.get(clientId);
    if (!client) throw new Error('Cliente no encontrado');
    
    const clientMovements = movements.get(clientId) || [];
    const history = clientMovements
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit)
      .map(move => ({
        ...move,
        // No exponer datos internos sensibles
        internalId: undefined
      }));
    
    return {
      client: security.maskPersonalData(client),
      summary: {
        totalTransactions: clientMovements.length,
        totalPurchases: clientMovements.filter(m => m.type === 'sale').length,
        totalPayments: clientMovements.filter(m => m.type === 'payment').length,
        oldestTransaction: clientMovements.length > 0 
          ? clientMovements[clientMovements.length - 1].date 
          : null
      },
      history
    };
  };

  /**
   * Listar clientes con deuda (para seguimiento)
   */
  const getClientsWithDebts = (localId, minDebt = 0) => {
    const localClients = indexes.localId.get(localId);
    if (!localClients) return [];
    
    const clientsWithDebts = [];
    
    localClients.forEach(clientId => {
      const client = clients.get(clientId);
      if (client.currentDebt > minDebt) {
        // Calcular días de deuda más antigua
        const clientMovements = movements.get(clientId) || [];
        const oldestDebt = clientMovements
          .filter(m => m.type === 'sale' && m.balance > 0)
          .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
        
        clientsWithDebts.push({
          ...security.maskPersonalData(client),
          currentDebt: client.currentDebt,
          oldestDebtDate: oldestDebt?.date,
          daysOverdue: oldestDebt?.dueDate 
            ? Math.max(0, Math.floor((new Date() - new Date(oldestDebt.dueDate)) / (1000*60*60*24)))
            : 0,
          creditUtilization: (client.currentDebt / client.creditLimit) * 100
        });
      }
    });
    
    // Ordenar por deuda más alta
    return clientsWithDebts.sort((a, b) => b.currentDebt - a.currentDebt);
  };

  /**
   * Fusionar dos clientes (mover historial a uno principal)
   */
  const mergeClients = async (clientId1, clientId2, mergedBy) => {
    const client1 = clients.get(clientId1);
    const client2 = clients.get(clientId2);
    
    if (!client1 || !client2) throw new Error('Uno o ambos clientes no existen');
    if (client1.localId !== client2.localId) throw new Error('Clientes de distintos locales');
    
    // Mover movimientos de client2 a client1
    const movements2 = movements.get(clientId2) || [];
    if (movements.has(clientId1)) {
      movements.set(clientId1, [...movements.get(clientId1), ...movements2]);
    } else {
      movements.set(clientId1, movements2);
    }
    
    // Actualizar saldo
    client1.currentDebt += client2.currentDebt;
    
    // Marcar cliente2 como fusionado
    client2.isActive = false;
    client2.mergedInto = clientId1;
    client2.mergedAt = new Date().toISOString();
    client2.mergedBy = mergedBy;
    
    // Actualizar índices para client2
    removeFromIndex('all', client2);
    
    // Auditoría
    logAudit('MERGE', mergedBy, clientId1, {
      mergedClient: clientId2,
      debtTransferred: client2.currentDebt
    });
    
    return {
      success: true,
      mainClient: clientId1,
      mergedClient: clientId2,
      totalDebt: client1.currentDebt
    };
  };

  /**
   * Exportar clientes en diferentes formatos
   */
  const exportClients = (format, localId) => {
    const localClients = indexes.localId.get(localId);
    if (!localClients) return null;
    
    const data = Array.from(localClients).map(id => {
      const client = clients.get(id);
      return {
        id: client.id,
        code: client.code,
        name: client.name,
        dni: client.dni ? client.dni.slice(0, 3) + '*****' : null,
        email: client.email ? '***@' + client.email.split('@')[1] : null,
        phone: client.phone,
        currentDebt: client.currentDebt,
        creditLimit: client.creditLimit,
        lastPurchase: getLastPurchase(id),
        lastPayment: client.lastPaymentDate
      };
    });
    
    switch(format) {
      case 'csv':
        return convertToCSV(data);
      case 'json':
        return JSON.stringify(data, null, 2);
      case 'xlsx':
        return generateExcel(data);
      default:
        throw new Error('Formato no soportado');
    }
  };

  /**
   * Estadísticas detalladas del cliente
   */
  const getClientStats = (clientId) => {
    const client = clients.get(clientId);
    if (!client) throw new Error('Cliente no encontrado');
    
    const clientMovements = movements.get(clientId) || [];
    const purchases = clientMovements.filter(m => m.type === 'sale');
    const payments = clientMovements.filter(m => m.type === 'payment');
    
    // Cálculo de métricas
    const totalPurchases = purchases.reduce((sum, p) => sum + p.amount, 0);
    const totalPayments = payments.reduce((sum, p) => sum + p.amount, 0);
    
    // Frecuencia de compra
    const purchaseDates = purchases.map(p => new Date(p.date));
    const avgPurchaseFrequency = purchaseDates.length > 1
      ? averageDifference(purchaseDates)
      : null;
    
    return {
      clientId,
      lifetimeValue: totalPurchases,
      totalTransactions: clientMovements.length,
      averageTicket: purchases.length > 0 ? totalPurchases / purchases.length : 0,
      paymentRate: purchases.length > 0 ? (totalPayments / totalPurchases) * 100 : 0,
      purchaseFrequency: avgPurchaseFrequency,
      debtHistory: calculateDebtHistory(clientMovements),
      riskScore: calculateRiskScore(client, clientMovements)
    };
  };

  // ========== FUNCIONES DE SISTEMA ==========
  
  /**
   * Sincronizar datos pendientes (offline -> online)
   */
  const syncPendingData = async () => {
    // Sincronizar clientes pendientes
    for (const [clientId, client] of offlineCache.pendingClients) {
      try {
        await apiSync('clients', 'POST', client);
        offlineCache.pendingClients.delete(clientId);
      } catch (error) {
        console.error('Error sincronizando cliente:', error);
      }
    }
    
    // Sincronizar movimientos pendientes
    for (const [clientId, pendingMoves] of offlineCache.pendingMovements) {
      for (const movement of pendingMoves) {
        try {
          await apiSync('movements', 'POST', movement);
          offlineCache.pendingMovements.delete(clientId);
        } catch (error) {
          console.error('Error sincronizando movimiento:', error);
        }
      }
    }
  };

  /**
   * Sistema de alertas de deuda vencida
   */
  const checkDebtAlerts = () => {
    const alerts = [];
    const today = new Date();
    
    clients.forEach(client => {
      if (client.currentDebt > 0) {
        const clientMovements = movements.get(client.id) || [];
        const overdueDebts = clientMovements.filter(m => 
          m.type === 'sale' && 
          m.balance > 0 &&
          m.dueDate && 
          new Date(m.dueDate) < today
        );
        
        if (overdueDebts.length > 0) {
          alerts.push({
            clientId: client.id,
            clientName: client.name,
            totalDebt: client.currentDebt,
            overdueAmount: overdueDebts.reduce((sum, d) => sum + d.balance, 0),
            oldestOverdue: overdueDebts.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))[0],
            alertLevel: calculateAlertLevel(overdueDebts)
          });
        }
      }
    });
    
    return alerts;
  };

  // ========== FUNCIONES INTERNAS ==========
  
  const updateIndexes = (operation, client, oldClient = null) => {
    const { localId } = client;
    
    if (!indexes.localId.has(localId)) {
      indexes.localId.set(localId, new Set());
    }
    
    switch(operation) {
      case 'add':
        indexes.localId.get(localId).add(client.id);
        
        // Índice por nombre
        if (client.name) {
          const normalized = client.name.toLowerCase().trim();
          if (!indexes.name.has(localId)) indexes.name.set(localId, new Map());
          if (!indexes.name.get(localId).has(normalized)) {
            indexes.name.get(localId).set(normalized, new Set());
          }
          indexes.name.get(localId).get(normalized).add(client.id);
        }
        
        // Índice por DNI
        if (client.dni) {
          if (!indexes.dni.has(localId)) indexes.dni.set(localId, new Map());
          indexes.dni.get(localId).set(client.dni, client.id);
        }
        
        // Índice por email
        if (client.email) {
          if (!indexes.email.has(localId)) indexes.email.set(localId, new Map());
          indexes.email.get(localId).set(client.email, client.id);
        }
        break;
        
      case 'update':
        if (oldClient) {
          // Remover índices antiguos si cambiaron
          if (oldClient.name !== client.name && oldClient.name) {
            removeFromIndex('name', oldClient);
          }
          if (oldClient.dni !== client.dni && oldClient.dni) {
            removeFromIndex('dni', oldClient);
          }
          if (oldClient.email !== client.email && oldClient.email) {
            removeFromIndex('email', oldClient);
          }
        }
        // Agregar nuevos índices
        updateIndexes('add', client);
        break;
    }
  };
  
  const removeFromIndex = (type, client) => {
    const { localId, id } = client;
    
    if (type === 'all' || type === 'name') {
      if (client.name) {
        const normalized = client.name.toLowerCase().trim();
        const nameIndex = indexes.name.get(localId);
        if (nameIndex && nameIndex.has(normalized)) {
          nameIndex.get(normalized).delete(id);
          if (nameIndex.get(normalized).size === 0) {
            nameIndex.delete(normalized);
          }
        }
      }
    }
    
    if (type === 'all' || type === 'dni') {
      if (client.dni) {
        const dniIndex = indexes.dni.get(localId);
        if (dniIndex) dniIndex.delete(client.dni);
      }
    }
    
    if (type === 'all' || type === 'email') {
      if (client.email) {
        const emailIndex = indexes.email.get(localId);
        if (emailIndex) emailIndex.delete(client.email);
      }
    }
  };
  
  const logAudit = (action, userId, clientId, details) => {
    const auditLog = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      action,
      userId,
      clientId,
      details: typeof details === 'object' ? { ...details } : details
    };
    
    // Guardar en sistema de auditoría
    if (typeof window !== 'undefined' && window.auditSystem) {
      window.auditSystem.log('clients', auditLog);
    }
    
    return auditLog;
  };

  // ========== UTILIDADES ==========
  
  const generateId = () => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  };
  
  const getLastPurchase = (clientId) => {
    const clientMovements = movements.get(clientId);
    if (!clientMovements) return null;
    
    const purchases = clientMovements.filter(m => m.type === 'sale');
    if (purchases.length === 0) return null;
    
    return purchases.sort((a, b) => new Date(b.date) - new Date(a.date))[0].date;
  };
  
  const calculateRiskScore = (client, movements) => {
    let score = 100;
    
    // Penalizar por deuda alta
    const utilization = client.currentDebt / client.creditLimit;
    if (utilization > 0.8) score -= 30;
    else if (utilization > 0.5) score -= 15;
    
    // Penalizar por pagos atrasados
    const overdue = movements.filter(m => 
      m.type === 'sale' && 
      m.balance > 0 &&
      m.dueDate && 
      new Date(m.dueDate) < new Date()
    );
    if (overdue.length > 0) score -= (overdue.length * 10);
    
    // Bonificar por pagos anticipados
    const earlyPayments = movements.filter(m => 
      m.type === 'payment' &&
      m.appliedTo.some(a => a.daysEarly > 0)
    );
    if (earlyPayments.length > 0) score += (earlyPayments.length * 5);
    
    return Math.max(0, Math.min(100, score));
  };
  
  // ========== CLASE LRU CACHE ==========
  
  class LRUCache {
    constructor(capacity) {
      this.capacity = capacity;
      this.cache = new Map();
    }
    
    get(key) {
      if (!this.cache.has(key)) return null;
      const value = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, value);
      return value;
    }
    
    set(key, value) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.capacity) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }
      this.cache.set(key, value);
    }
  }

  // ========== API PÚBLICA ==========
  
  return {
    createClient,
    updateClient,
    searchClients,
    getClientDebts,
    addClientPayment,
    getClientHistory,
    getClientsWithDebts,
    mergeClients,
    exportClients,
    getClientStats,
    
    // Funciones de sistema
    syncPendingData,
    checkDebtAlerts,
    
    // Para desarrollo/debug
    _internal: {
      indexes,
      cache: offlineCache,
      validators
    }
  };
})();

// Exportación según entorno
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ClientManager;
} else if (typeof window !== 'undefined') {
  window.ClientManager = ClientManager;
}

// ========== EJEMPLO DE USO ==========
/*
// Crear cliente
ClientManager.createClient({
  name: "Juan Pérez",
  dni: "30123456",
  email: "juan@email.com",
  localId: "LOCAL_001",
  creditLimit: 50000,
  createdBy: "USER_001"
});

// Registrar pago
ClientManager.addClientPayment("CLIENT_001", {
  amount: 10000,
  method: "cash",
  description: "Pago parcial",
  createdBy: "USER_001"
});

// Buscar clientes con deuda
const debtors = ClientManager.getClientsWithDebts("LOCAL_001", 1000);

// Exportar a CSV
const csvData = ClientManager.exportClients("csv", "LOCAL_001");
*/
