// sync.js - Sincronización bidireccional IndexedDB ↔ Firestore
class SyncManager {
  constructor(db, firestore, config = {}) {
    this.db = db; // Instancia de IndexedDB
    this.firestore = firestore; // Instancia de Firestore
    this.config = {
      batchSize: 500,
      collections: ['ventas', 'caja', 'presupuestos', 'datosMaestros'],
      priorities: {
        'ventas': 1,
        'caja': 2,
        'presupuestos': 3,
        'datosMaestros': 4
      },
      retryConfig: {
        maxRetries: 5,
        initialDelay: 1000,
        maxDelay: 30000
      },
      ...config
    };
    
    this.state = {
      isSyncing: false,
      isPaused: false,
      lastSync: null,
      pendingOperations: 0,
      errors: [],
      syncQueue: [],
      online: navigator.onLine
    };
    
    this.init();
  }

  /**
   * Inicialización de listeners y estados
   */
  init() {
    // Detectar cambios de conexión
    window.addEventListener('online', () => {
      this.state.online = true;
      if (!this.state.isPaused) this.startSync();
    });
    
    window.addEventListener('offline', () => {
      this.state.online = false;
      this.pauseSync();
    });
    
    // Inicializar última sincronización
    this.loadSyncState();
  }

  /**
   * Iniciar proceso de sincronización
   */
  async startSync() {
    if (this.state.isSyncing || this.state.isPaused || !this.state.online) {
      console.log('Sync no iniciado:', {
        isSyncing: this.state.isSyncing,
        isPaused: this.state.isPaused,
        online: this.state.online
      });
      return;
    }

    this.state.isSyncing = true;
    this.notifyUI('sync_started', { timestamp: new Date() });

    try {
      // 1. Sincronizar operaciones pendientes (offline → online)
      await this.syncPendingOperations();
      
      // 2. Sincronizar cada colección incrementalmente (online → offline)
      for (const collection of this.config.collections) {
        if (this.state.isPaused) break;
        
        const lastSync = await this.getLastSyncTimestamp(collection);
        await this.syncCollection(collection, lastSync);
        
        // Actualizar timestamp de sincronización
        await this.updateSyncTimestamp(collection);
      }
      
      this.state.lastSync = new Date();
      this.saveSyncState();
      this.notifyUI('sync_completed', { timestamp: this.state.lastSync });
      
    } catch (error) {
      console.error('Error en sincronización:', error);
      this.state.errors.push({
        type: 'sync_error',
        message: error.message,
        timestamp: new Date(),
        stack: error.stack
      });
      this.notifyUI('sync_error', { error: error.message });
    } finally {
      this.state.isSyncing = false;
      this.notifyUI('sync_ended');
    }
  }

  /**
   * Sincronizar operaciones pendientes con backoff exponencial
   */
  async syncPendingOperations() {
    const operations = await this.getPendingOperations();
    if (operations.length === 0) return;

    const batches = this.chunkArray(operations, this.config.batchSize);
    
    for (const batch of batches) {
      if (this.state.isPaused) break;
      
      const batchPromises = batch.map(async (op) => {
        return this.retryWithBackoff(async () => {
          switch (op.type) {
            case 'CREATE':
              await this.firestore.collection(op.collection).doc(op.id).set(op.data);
              break;
            case 'UPDATE':
              await this.firestore.collection(op.collection).doc(op.id).update(op.data);
              break;
            case 'DELETE':
              await this.firestore.collection(op.collection).doc(op.id).delete();
              break;
          }
          
          // Marcar como sincronizado en IndexedDB
          await this.markOperationAsSynced(op.id);
          this.state.pendingOperations--;
        }, `operation_${op.type}_${op.id}`);
      });
      
      await Promise.allSettled(batchPromises);
      await this.delay(100); // Pequeña pausa entre lotes
    }
  }

  /**
   * Sincronizar colección específica incrementalmente
   */
  async syncCollection(collection, lastSync) {
    let query = this.firestore.collection(collection)
      .orderBy('updatedAt')
      .limit(this.config.batchSize);

    if (lastSync) {
      query = query.where('updatedAt', '>', lastSync);
    }

    const snapshot = await query.get();
    
    const batch = this.db.batch();
    const operations = [];
    
    snapshot.forEach(doc => {
      const data = doc.data();
      const localDoc = this.getLocalDocument(collection, doc.id);
      
      if (localDoc) {
        // Resolver conflicto si existe
        const resolved = this.resolveConflict(localDoc, data);
        operations.push({
          type: 'UPDATE',
          collection,
          id: doc.id,
          data: resolved
        });
      } else {
        operations.push({
          type: 'CREATE',
          collection,
          id: doc.id,
          data
        });
      }
    });
    
    // Procesar en batch
    for (const op of operations) {
      if (op.type === 'CREATE') {
        batch.set(this.db.collection(collection).doc(op.id), {
          ...op.data,
          _syncedAt: new Date(),
          _syncStatus: 'synced'
        });
      } else {
        batch.update(this.db.collection(collection).doc(op.id), {
          ...op.data,
          _syncedAt: new Date(),
          _syncStatus: 'synced'
        });
      }
    }
    
    await batch.commit();
    
    // Si hay más documentos, llamar recursivamente
    if (snapshot.size === this.config.batchSize) {
      const lastDoc = snapshot.docs[snapshot.docs.length - 1];
      await this.syncCollection(collection, lastDoc.get('updatedAt'));
    }
  }

  /**
   * Resolver conflictos (última modificación gana)
   */
  resolveConflict(offlineData, onlineData) {
    const offlineTime = offlineData.updatedAt?.toMillis?.() || offlineData.updatedAt;
    const onlineTime = onlineData.updatedAt?.toMillis?.() || onlineData.updatedAt;
    
    if (offlineTime > onlineTime) {
      // Datos offline más recientes
      this.notifyUI('conflict_resolved', {
        conflictType: 'offline_wins',
        offlineTime,
        onlineTime
      });
      return offlineData;
    } else {
      // Datos online más recientes o iguales
      if (offlineTime < onlineTime) {
        this.notifyUI('conflict_resolved', {
          conflictType: 'online_wins',
          offlineTime,
          onlineTime
        });
      }
      return onlineData;
    }
  }

  /**
   * Obtener estado de sincronización
   */
  getSyncStatus() {
    return {
      isSyncing: this.state.isSyncing,
      isPaused: this.state.isPaused,
      lastSync: this.state.lastSync,
      pendingOperations: this.state.pendingOperations,
      online: this.state.online,
      errors: this.state.errors.slice(-10) // Últimos 10 errores
    };
  }

  /**
   * Pausar sincronización
   */
  pauseSync() {
    this.state.isPaused = true;
    this.notifyUI('sync_paused');
  }

  /**
   * Reanudar sincronización
   */
  resumeSync() {
    this.state.isPaused = false;
    this.notifyUI('sync_resumed');
    if (this.state.online) {
      this.startSync();
    }
  }

  /**
   * Forzar sincronización completa
   */
  async forceSync() {
    // Limpiar timestamps para forzar sincronización completa
    await this.clearSyncTimestamps();
    this.state.isPaused = false;
    await this.startSync();
  }

  /**
   * Obtener última sincronización por colección
   */
  async getLastSyncTimestamp(collection) {
    const metadata = await this.db.collection('_metadata').doc('sync').get();
    return metadata.data()?.[collection] || null;
  }

  /**
   * Limpiar errores de sincronización
   */
  clearSyncErrors() {
    this.state.errors = [];
    this.notifyUI('errors_cleared');
  }

  // ===== MÉTODOS AUXILIARES =====

  /**
   * Retry con backoff exponencial
   */
  async retryWithBackoff(fn, operationId) {
    let retries = 0;
    
    while (retries < this.config.retryConfig.maxRetries) {
      try {
        return await fn();
      } catch (error) {
        retries++;
        
        if (retries === this.config.retryConfig.maxRetries) {
          throw error;
        }
        
        // Backoff exponencial
        const delay = Math.min(
          this.config.retryConfig.initialDelay * Math.pow(2, retries - 1),
          this.config.retryConfig.maxDelay
        );
        
        console.warn(`Reintento ${retries} para ${operationId}, esperando ${delay}ms`);
        await this.delay(delay);
      }
    }
  }

  /**
   * Obtener operaciones pendientes ordenadas por prioridad
   */
  async getPendingOperations() {
    const ops = await this.db.collection('_pending_ops')
      .orderBy('priority')
      .orderBy('timestamp')
      .where('status', '==', 'pending')
      .limit(this.config.batchSize)
      .get();
    
    return ops.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Marcar operación como sincronizada
   */
  async markOperationAsSynced(operationId) {
    await this.db.collection('_pending_ops')
      .doc(operationId)
      .update({
        status: 'synced',
        syncedAt: new Date()
      });
  }

  /**
   * Actualizar timestamp de sincronización
   */
  async updateSyncTimestamp(collection) {
    await this.db.collection('_metadata').doc('sync').set({
      [collection]: new Date()
    }, { merge: true });
  }

  /**
   * Limpiar timestamps de sincronización
   */
  async clearSyncTimestamps() {
    const update = {};
    this.config.collections.forEach(col => {
      update[col] = null;
    });
    
    await this.db.collection('_metadata').doc('sync').update(update);
  }

  /**
   * Cargar estado de sincronización
   */
  async loadSyncState() {
    const doc = await this.db.collection('_metadata').doc('sync_state').get();
    if (doc.exists) {
      this.state.lastSync = doc.data().lastSync;
      this.state.pendingOperations = doc.data().pendingOperations || 0;
    }
  }

  /**
   * Guardar estado de sincronización
   */
  async saveSyncState() {
    await this.db.collection('_metadata').doc('sync_state').set({
      lastSync: this.state.lastSync,
      pendingOperations: this.state.pendingOperations,
      lastUpdated: new Date()
    });
  }

  /**
   * Notificar a la UI
   */
  notifyUI(event, data = {}) {
    if (typeof CustomEvent !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sync_event', {
        detail: { event, data, timestamp: new Date() }
      }));
    }
    
    // También se puede usar un callback si se configuró
    if (this.config.onStatusChange) {
      this.config.onStatusChange({ event, ...data });
    }
  }

  /**
   * Dividir array en chunks
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Exportar para uso en módulos
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SyncManager;
}
