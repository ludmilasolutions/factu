// cashbox.js
// Sistema de gestión de caja diaria, turnos y arqueos para Spark/Firestore
// @version 1.0.0

import { 
  collection, 
  doc, 
  setDoc, 
  getDoc, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit,
  updateDoc,
  Timestamp,
  serverTimestamp,
  runTransaction,
  writeBatch,
  onSnapshot,
  enableIndexedDbPersistence,
  disableNetwork,
  enableNetwork
} from 'firebase/firestore';
import { auth, db } from './firebase-config';

class CashboxManager {
  constructor() {
    this.cashboxesRef = collection(db, 'cashboxes');
    this.currentCashbox = null;
    this.localId = this.getLocalId(); // Obtener del contexto de la app
    this.user = null;
    this.offlineMovements = [];
    this.isOnline = true;
    
    this.initializeAuth();
    this.setupOfflineSupport();
    this.setupAutoClose();
  }

  // ============ CONFIGURACIÓN INICIAL ============

  initializeAuth() {
    auth.onAuthStateChanged((user) => {
      if (user) {
        this.user = user;
        this.userId = user.uid;
        this.userRole = user.claims?.role || 'cashier';
      } else {
        this.user = null;
      }
    });
  }

  getLocalId() {
    // Implementar lógica para obtener el ID del local
    return localStorage.getItem('localId') || 'default';
  }

  setupOfflineSupport() {
    // Habilitar persistencia offline
    enableIndexedDbPersistence(db).catch((err) => {
      console.warn('Persistencia offline no disponible:', err);
    });

    // Monitorear estado de conexión
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.syncOfflineMovements();
    });
    
    window.addEventListener('offline', () => {
      this.isOnline = false;
    });
  }

  setupAutoClose() {
    // Configurar cierre automático a las 00:00
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const timeToMidnight = midnight.getTime() - now.getTime();

    setTimeout(() => {
      this.autoCloseCashbox();
      // Programar para el próximo día
      this.setupAutoClose();
    }, timeToMidnight);
  }

  // ============ FUNCIONES PRINCIPALES ============

  /**
   * Abrir caja para el turno actual
   * @param {number} initialAmount - Monto inicial en caja
   * @returns {Promise<Object>} - Documento de caja creado
   */
  async openCashbox(initialAmount) {
    this.validateUserPermission('open_cashbox');
    
    try {
      // Verificar que no haya cajas abiertas
      const openBox = await this.getOpenCashbox();
      if (openBox) {
        throw new Error(`Ya existe una caja abierta por ${openBox.openedBy}`);
      }

      // Validar turno
      const currentShift = this.getCurrentShift();
      if (!currentShift) {
        throw new Error('No hay turno activo para abrir caja');
      }

      // Crear documento de caja
      const cashboxId = this.generateCashboxId();
      const cashboxDoc = {
        id: cashboxId,
        localId: this.localId,
        shiftId: currentShift.id,
        shiftName: currentShift.name,
        openedAt: serverTimestamp(),
        openedBy: this.userId,
        openedByName: this.user?.displayName || 'Usuario',
        initialAmount: this.formatAmount(initialAmount),
        currentAmount: this.formatAmount(initialAmount),
        expectedAmount: this.formatAmount(initialAmount),
        status: 'open',
        isClosed: false,
        movementsCount: 0,
        totalEntries: 0,
        totalExits: 0,
        differences: [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      };

      // Crear subcolección para movimientos
      await runTransaction(db, async (transaction) => {
        const cashboxRef = doc(this.cashboxesRef, cashboxId);
        transaction.set(cashboxRef, cashboxDoc);
        
        // Registrar movimiento de apertura
        const movementRef = doc(collection(cashboxRef, 'movements'));
        const openingMovement = {
          id: movementRef.id,
          type: 'open',
          amount: this.formatAmount(initialAmount),
          description: `Apertura de caja - Turno ${currentShift.name}`,
          userId: this.userId,
          userName: this.user?.displayName || 'Usuario',
          timestamp: serverTimestamp(),
          isSynced: true,
          offlineId: null
        };
        transaction.set(movementRef, openingMovement);
      });

      this.currentCashbox = cashboxDoc;
      this.notifyCashboxOpened();
      
      return cashboxDoc;
    } catch (error) {
      console.error('Error al abrir caja:', error);
      throw error;
    }
  }

  /**
   * Cerrar caja con arqueo
   * @param {number} finalAmount - Monto real contado
   * @param {string} notes - Observaciones del cierre
   * @returns {Promise<Object>} - Caja cerrada
   */
  async closeCashbox(finalAmount, notes = '') {
    this.validateUserPermission('close_cashbox');
    
    try {
      const cashbox = await this.getOpenCashbox();
      if (!cashbox) {
        throw new Error('No hay caja abierta para cerrar');
      }

      // Calcular monto esperado
      const expectedAmount = await this.calculateExpectedAmount(cashbox.id);
      const difference = this.formatAmount(finalAmount - expectedAmount);

      // Verificar si requiere autorización para diferencia
      if (Math.abs(difference) > this.getMaxAllowedDifference()) {
        const requiresAuth = await this.requestSupervisorAuthorization(
          'difference_approval',
          { difference, cashboxId: cashbox.id }
        );
        if (!requiresAuth) {
          throw new Error('Diferencia requiere autorización de supervisor');
        }
      }

      // Actualizar caja
      const cashboxRef = doc(this.cashboxesRef, cashbox.id);
      const updateData = {
        closedAt: serverTimestamp(),
        closedBy: this.userId,
        closedByName: this.user?.displayName || 'Usuario',
        finalAmount: this.formatAmount(finalAmount),
        expectedAmount: expectedAmount,
        difference: difference,
        notes: notes,
        status: 'closed',
        isClosed: true,
        updatedAt: serverTimestamp()
      };

      await updateDoc(cashboxRef, updateData);

      // Registrar movimiento de cierre
      await this.addCashMovement(
        'close',
        this.formatAmount(finalAmount),
        `Cierre de caja - Diferencia: ${difference}`,
        cashbox.id
      );

      this.currentCashbox = null;
      this.notifyCashboxClosed();
      
      return { ...cashbox, ...updateData };
    } catch (error) {
      console.error('Error al cerrar caja:', error);
      throw error;
    }
  }

  /**
   * Obtener caja actual abierta
   * @returns {Promise<Object|null>} - Caja actual o null
   */
  async getCurrentCashbox() {
    if (this.currentCashbox && !this.currentCashbox.isClosed) {
      return this.currentCashbox;
    }

    const cashbox = await this.getOpenCashbox();
    this.currentCashbox = cashbox;
    return cashbox;
  }

  /**
   * Agregar movimiento a la caja actual
   * @param {string} type - Tipo de movimiento
   * @param {number} amount - Monto del movimiento
   * @param {string} description - Descripción
   * @returns {Promise<Object>} - Movimiento registrado
   */
  async addCashMovement(type, amount, description) {
    this.validateUserPermission('add_movement');
    
    try {
      let cashbox = await this.getCurrentCashbox();
      let cashboxId = cashbox?.id;

      // Si no hay caja abierta y estamos offline, permitir movimiento offline
      if (!cashbox && !this.isOnline) {
        return this.addOfflineMovement(type, amount, description);
      }

      if (!cashbox) {
        throw new Error('No hay caja abierta para registrar movimiento');
      }

      // Validar tipos de movimiento permitidos
      const validTypes = ['sale', 'expense', 'withdrawal', 'deposit', 'adjustment'];
      if (!validTypes.includes(type)) {
        throw new Error(`Tipo de movimiento inválido. Usar: ${validTypes.join(', ')}`);
      }

      const formattedAmount = this.formatAmount(amount);
      
      // Actualizar monto actual en tiempo real
      const newAmount = this.calculateNewAmount(cashbox.currentAmount, type, formattedAmount);
      
      const movement = {
        type,
        amount: formattedAmount,
        description,
        userId: this.userId,
        userName: this.user?.displayName || 'Usuario',
        timestamp: serverTimestamp(),
        isSynced: true,
        offlineId: null,
        cashboxId: cashboxId
      };

      // Usar transacción para asegurar consistencia
      await runTransaction(db, async (transaction) => {
        // Actualizar caja
        const cashboxRef = doc(this.cashboxesRef, cashboxId);
        transaction.update(cashboxRef, {
          currentAmount: newAmount,
          movementsCount: (cashbox.movementsCount || 0) + 1,
          updatedAt: serverTimestamp(),
          ...(type === 'sale' || type === 'deposit' ? {
            totalEntries: (cashbox.totalEntries || 0) + Math.abs(formattedAmount)
          } : {}),
          ...(type === 'expense' || type === 'withdrawal' ? {
            totalExits: (cashbox.totalExits || 0) + Math.abs(formattedAmount)
          } : {})
        });

        // Agregar movimiento
        const movementRef = doc(collection(cashboxRef, 'movements'));
        movement.id = movementRef.id;
        transaction.set(movementRef, movement);
      });

      this.notifyMovementAdded(movement);
      return movement;
    } catch (error) {
      console.error('Error al agregar movimiento:', error);
      
      // En caso de error offline, guardar localmente
      if (!this.isOnline) {
        return this.addOfflineMovement(type, amount, description);
      }
      
      throw error;
    }
  }

  /**
   * Obtener resumen de caja por fecha
   * @param {Date|string} date - Fecha para el resumen
   * @returns {Promise<Object>} - Resumen de caja
   */
  async getCashboxSummary(date) {
    this.validateUserPermission('view_reports');
    
    const targetDate = this.parseDate(date);
    const startDate = new Date(targetDate.setHours(0, 0, 0, 0));
    const endDate = new Date(targetDate.setHours(23, 59, 59, 999));

    const q = query(
      this.cashboxesRef,
      where('localId', '==', this.localId),
      where('openedAt', '>=', startDate),
      where('openedAt', '<=', endDate),
      where('isClosed', '==', true)
    );

    const snapshot = await getDocs(q);
    const cashboxes = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    const summary = {
      date: targetDate.toISOString().split('T')[0],
      totalCashboxes: cashboxes.length,
      totalInitialAmount: 0,
      totalFinalAmount: 0,
      totalEntries: 0,
      totalExits: 0,
      totalDifferences: 0,
      cashboxes: cashboxes
    };

    cashboxes.forEach(box => {
      summary.totalInitialAmount += box.initialAmount || 0;
      summary.totalFinalAmount += box.finalAmount || 0;
      summary.totalEntries += box.totalEntries || 0;
      summary.totalExits += box.totalExits || 0;
      summary.totalDifferences += Math.abs(box.difference || 0);
    });

    return summary;
  }

  /**
   * Obtener movimientos por fecha
   * @param {Date|string} date - Fecha para filtrar
   * @returns {Promise<Array>} - Lista de movimientos
   */
  async getCashMovements(date) {
    this.validateUserPermission('view_movements');
    
    const targetDate = this.parseDate(date);
    const startDate = new Date(targetDate.setHours(0, 0, 0, 0));
    const endDate = new Date(targetDate.setHours(23, 59, 59, 999));

    const q = query(
      this.cashboxesRef,
      where('localId', '==', this.localId),
      where('openedAt', '>=', startDate),
      where('openedAt', '<=', endDate)
    );

    const snapshot = await getDocs(q);
    const movements = [];

    for (const boxDoc of snapshot.docs) {
      const movementsRef = collection(boxDoc.ref, 'movements');
      const movementsQuery = query(movementsRef, orderBy('timestamp', 'desc'));
      const movementsSnapshot = await getDocs(movementsQuery);
      
      movementsSnapshot.docs.forEach(movDoc => {
        movements.push({
          cashboxId: boxDoc.id,
          cashboxShift: boxDoc.data().shiftName,
          ...movDoc.data()
        });
      });
    }

    return movements.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Calcular monto esperado en caja
   * @param {string} cashboxId - ID de la caja
   * @returns {Promise<number>} - Monto esperado
   */
  async calculateExpectedAmount(cashboxId = null) {
    const cashbox = cashboxId 
      ? await this.getCashboxById(cashboxId)
      : await this.getCurrentCashbox();

    if (!cashbox) {
      throw new Error('Caja no encontrada');
    }

    // Obtener todos los movimientos
    const movementsRef = collection(doc(this.cashboxesRef, cashbox.id), 'movements');
    const q = query(movementsRef, where('type', 'in', ['sale', 'expense', 'withdrawal', 'deposit', 'adjustment']));
    const snapshot = await getDocs(q);

    let expectedAmount = cashbox.initialAmount || 0;

    snapshot.docs.forEach(doc => {
      const mov = doc.data();
      switch(mov.type) {
        case 'sale':
        case 'deposit':
          expectedAmount += mov.amount;
          break;
        case 'expense':
        case 'withdrawal':
          expectedAmount -= mov.amount;
          break;
        case 'adjustment':
          expectedAmount += mov.amount; // amount puede ser positivo o negativo
          break;
      }
    });

    return this.formatAmount(expectedAmount);
  }

  /**
   * Registrar diferencia autorizada
   * @param {number} difference - Monto de la diferencia
   * @param {string} notes - Explicación
   * @param {string} supervisorId - ID del supervisor
   * @returns {Promise<Object>} - Diferencia registrada
   */
  async registerCashDifference(difference, notes, supervisorId) {
    this.validateUserPermission('register_difference');
    
    const cashbox = await this.getCurrentCashbox();
    if (!cashbox) {
      throw new Error('No hay caja abierta');
    }

    const formattedDiff = this.formatAmount(difference);
    const diffRecord = {
      id: this.generateId(),
      amount: formattedDiff,
      notes,
      supervisorId,
      supervisorName: await this.getUserName(supervisorId),
      registeredBy: this.userId,
      registeredAt: serverTimestamp(),
      status: 'approved'
    };

    // Agregar a la lista de diferencias
    const cashboxRef = doc(this.cashboxesRef, cashbox.id);
    await updateDoc(cashboxRef, {
      differences: [...(cashbox.differences || []), diffRecord],
      updatedAt: serverTimestamp()
    });

    // Registrar movimiento de ajuste
    await this.addCashMovement(
      'adjustment',
      formattedDiff,
      `Ajuste por diferencia: ${notes}`
    );

    return diffRecord;
  }

  /**
   * Obtener historial de cajas
   * @param {Object} dateRange - Rango de fechas {start, end}
   * @returns {Promise<Array>} - Historial de cajas
   */
  async getCashboxHistory(dateRange = {}) {
    this.validateUserPermission('view_history');
    
    const { start, end } = dateRange;
    const startDate = start ? this.parseDate(start) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // Últimos 30 días
    const endDate = end ? this.parseDate(end) : new Date();

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);

    const q = query(
      this.cashboxesRef,
      where('localId', '==', this.localId),
      where('openedAt', '>=', startDate),
      where('openedAt', '<=', endDate),
      where('isClosed', '==', true),
      orderBy('openedAt', 'desc'),
      limit(100)
    );

    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  }

  /**
   * Bloquear caja para evitar modificaciones
   * @param {string} cashboxId - ID de la caja
   * @returns {Promise<boolean>} - Confirmación de bloqueo
   */
  async lockCashbox(cashboxId) {
    this.validateUserPermission('lock_cashbox');
    
    const cashboxRef = doc(this.cashboxesRef, cashboxId);
    const cashbox = await getDoc(cashboxRef);
    
    if (!cashbox.exists()) {
      throw new Error('Caja no encontrada');
    }

    if (!cashbox.data().isClosed) {
      throw new Error('Solo se pueden bloquear cajas cerradas');
    }

    await updateDoc(cashboxRef, {
      isLocked: true,
      lockedAt: serverTimestamp(),
      lockedBy: this.userId,
      lockedByName: this.user?.displayName || 'Usuario',
      updatedAt: serverTimestamp()
    });

    return true;
  }

  // ============ FUNCIONES AUXILIARES ============

  async getOpenCashbox() {
    const q = query(
      this.cashboxesRef,
      where('localId', '==', this.localId),
      where('isClosed', '==', false),
      limit(1)
    );

    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }

    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data()
    };
  }

  async getCashboxById(cashboxId) {
    const docRef = doc(this.cashboxesRef, cashboxId);
    const snapshot = await getDoc(docRef);
    
    if (!snapshot.exists()) {
      throw new Error('Caja no encontrada');
    }

    return {
      id: snapshot.id,
      ...snapshot.data()
    };
  }

  getCurrentShift() {
    // Implementar lógica de turnos
    const now = new Date();
    const hour = now.getHours();
    
    if (hour >= 6 && hour < 14) {
      return { id: 'morning', name: 'Mañana', start: 6, end: 14 };
    } else if (hour >= 14 && hour < 22) {
      return { id: 'afternoon', name: 'Tarde', start: 14, end: 22 };
    } else {
      return { id: 'night', name: 'Noche', start: 22, end: 6 };
    }
  }

  validateUserPermission(permission) {
    const permissions = {
      cashier: ['add_movement', 'view_movements'],
      supervisor: ['add_movement', 'view_movements', 'view_reports', 'register_difference', 'close_cashbox'],
      admin: ['open_cashbox', 'close_cashbox', 'view_history', 'lock_cashbox', 'all']
    };

    if (!this.user) {
      throw new Error('Usuario no autenticado');
    }

    const userRole = this.userRole || 'cashier';
    const userPermissions = permissions[userRole] || [];

    if (!userPermissions.includes(permission) && !userPermissions.includes('all')) {
      throw new Error('Permiso denegado');
    }
  }

  formatAmount(amount) {
    // Manejar decimales correctamente
    return Math.round(parseFloat(amount) * 100) / 100;
  }

  calculateNewAmount(current, type, amount) {
    let newAmount = parseFloat(current);
    const parsedAmount = parseFloat(amount);

    switch(type) {
      case 'sale':
      case 'deposit':
        newAmount += parsedAmount;
        break;
      case 'expense':
      case 'withdrawal':
        newAmount -= parsedAmount;
        break;
      case 'adjustment':
        newAmount += parsedAmount; // amount puede ser positivo o negativo
        break;
    }

    return this.formatAmount(newAmount);
  }

  generateCashboxId() {
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');
    const shift = this.getCurrentShift().id;
    const random = Math.random().toString(36).substr(2, 4).toUpperCase();
    
    return `CASH-${this.localId}-${dateStr}-${shift}-${random}`;
  }

  generateId() {
    return Math.random().toString(36).substr(2, 9);
  }

  parseDate(dateInput) {
    if (dateInput instanceof Date) return dateInput;
    if (typeof dateInput === 'string') return new Date(dateInput);
    return new Date();
  }

  getMaxAllowedDifference() {
    return 50.00; // Máximo $50 de diferencia permitida sin autorización
  }

  async getUserName(userId) {
    // Implementar obtención de nombre de usuario
    return 'Usuario';
  }

  async requestSupervisorAuthorization(permission, data) {
    // Implementar solicitud de autorización a supervisor
    return true;
  }

  // ============ MANEJO OFFLINE ============

  addOfflineMovement(type, amount, description) {
    const offlineMovement = {
      id: `offline_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type,
      amount: this.formatAmount(amount),
      description,
      userId: this.userId,
      timestamp: new Date(),
      isSynced: false,
      offlineId: this.generateId()
    };

    this.offlineMovements.push(offlineMovement);
    this.saveOfflineMovements();
    
    return offlineMovement;
  }

  async syncOfflineMovements() {
    if (this.offlineMovements.length === 0) return;

    const cashbox = await this.getCurrentCashbox();
    if (!cashbox) {
      console.warn('No hay caja abierta para sincronizar movimientos offline');
      return;
    }

    const batch = writeBatch(db);
    const cashboxRef = doc(this.cashboxesRef, cashbox.id);

    for (const movement of this.offlineMovements) {
      const movementRef = doc(collection(cashboxRef, 'movements'));
      const syncedMovement = {
        ...movement,
        isSynced: true,
        syncedAt: serverTimestamp(),
        cashboxId: cashbox.id
      };
      delete syncedMovement.offlineId;

      batch.set(movementRef, syncedMovement);
    }

    try {
      await batch.commit();
      this.offlineMovements = [];
      this.saveOfflineMovements();
      console.log('Movimientos offline sincronizados exitosamente');
    } catch (error) {
      console.error('Error al sincronizar movimientos offline:', error);
    }
  }

  saveOfflineMovements() {
    localStorage.setItem('offlineCashMovements', JSON.stringify(this.offlineMovements));
  }

  loadOfflineMovements() {
    const saved = localStorage.getItem('offlineCashMovements');
    if (saved) {
      this.offlineMovements = JSON.parse(saved);
    }
  }

  async validateCashboxOnSync() {
    const cashbox = await this.getCurrentCashbox();
    if (!cashbox) {
      // Si hay movimientos offline pero no hay caja abierta,
      // podemos intentar crear una caja con fecha anterior
      this.handleOfflineCashboxRecovery();
    }
  }

  handleOfflineCashboxRecovery() {
    // Implementar lógica de recuperación de caja offline
    console.warn('Recuperación de caja offline requerida');
  }

  // ============ NOTIFICACIONES Y EVENTOS ============

  notifyCashboxOpened() {
    const event = new CustomEvent('cashboxOpened', {
      detail: { cashbox: this.currentCashbox }
    });
    window.dispatchEvent(event);
  }

  notifyCashboxClosed() {
    const event = new CustomEvent('cashboxClosed', {
      detail: { cashbox: this.currentCashbox }
    });
    window.dispatchEvent(event);
  }

  notifyMovementAdded(movement) {
    const event = new CustomEvent('cashMovementAdded', {
      detail: { movement }
    });
    window.dispatchEvent(event);
  }

  notifySimultaneousOpenAttempt(userInfo) {
    const event = new CustomEvent('simultaneousOpenAttempt', {
      detail: { userInfo }
    });
    window.dispatchEvent(event);
  }

  // ============ CIERRE AUTOMÁTICO ============

  async autoCloseCashbox() {
    try {
      const cashbox = await this.getOpenCashbox();
      if (cashbox) {
        console.log('Cerrando caja automáticamente por horario');
        
        // Calcular monto esperado
        const expectedAmount = await this.calculateExpectedAmount(cashbox.id);
        
        // Cerrar con monto esperado y nota de cierre automático
        await this.closeCashbox(
          expectedAmount,
          'Cierre automático por horario (00:00)'
        );
      }
    } catch (error) {
      console.error('Error en cierre automático:', error);
    }
  }

  // ============ SUSCRIPCIONES EN TIEMPO REAL ============

  subscribeToCurrentCashbox(callback) {
    if (!this.currentCashbox) return null;

    const cashboxRef = doc(this.cashboxesRef, this.currentCashbox.id);
    return onSnapshot(cashboxRef, (snapshot) => {
      if (snapshot.exists()) {
        this.currentCashbox = {
          id: snapshot.id,
          ...snapshot.data()
        };
        callback(this.currentCashbox);
      }
    });
  }

  subscribeToMovements(cashboxId, callback) {
    const movementsRef = collection(doc(this.cashboxesRef, cashboxId), 'movements');
    const q = query(movementsRef, orderBy('timestamp', 'desc'));
    
    return onSnapshot(q, (snapshot) => {
      const movements = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      callback(movements);
    });
  }

  // ============ AUDITORÍA ============

  async getCashboxAuditLog(cashboxId) {
    this.validateUserPermission('view_history');
    
    const movements = await this.getCashMovements(new Date());
    const cashbox = await this.getCashboxById(cashboxId);
    
    return {
      cashbox,
      movements,
      auditTrail: this.generateAuditTrail(cashbox, movements)
    };
  }

  generateAuditTrail(cashbox, movements) {
    const trail = [];
    
    // Apertura
    trail.push({
      action: 'open',
      timestamp: cashbox.openedAt,
      user: cashbox.openedByName,
      details: `Monto inicial: $${cashbox.initialAmount}`
    });

    // Movimientos
    movements.forEach(mov => {
      if (mov.type !== 'open' && mov.type !== 'close') {
        trail.push({
          action: mov.type,
          timestamp: mov.timestamp,
          user: mov.userName,
          details: `${mov.description} - $${mov.amount}`
        });
      }
    });

    // Cierre
    if (cashbox.isClosed) {
      trail.push({
        action: 'close',
        timestamp: cashbox.closedAt,
        user: cashbox.closedByName,
        details: `Monto final: $${cashbox.finalAmount}, Diferencia: $${cashbox.difference}`
      });
    }

    return trail;
  }
}

// Instancia singleton
let cashboxInstance = null;

export function getCashboxManager() {
  if (!cashboxInstance) {
    cashboxInstance = new CashboxManager();
  }
  return cashboxInstance;
}

export default CashboxManager;
