/**
 * offline.js - Gestión de almacenamiento offline con IndexedDB
 * Responsabilidad: Manejar almacenamiento offline y sincronización con Firestore
 * Versión: 1.0.0
 */

class OfflineManager {
    constructor() {
        this.db = null;
        this.dbName = 'app_offline_db';
        this.dbVersion = 4;
        this.isOnline = navigator.onLine;
        this.syncInProgress = false;
        this.connectionListeners = [];
        
        // Límites de almacenamiento por colección
        this.collectionLimits = {
            'products': 1000,
            'customers': 500,
            'suppliers': 200,
            'sales': 2000,
            'budgets': 1000,
            'cash_movements': 1000
        };
        
        // Tiempos de retención en días
        this.retentionPolicies = {
            'operations': 7,    // Ventas, presupuestos, movimientos
            'master': 30        // Productos, clientes, proveedores
        };
        
        this.init();
    }

    /**
     * INICIALIZACIÓN Y CONFIGURACIÓN
     */

    async init() {
        await this.initOfflineDB();
        this.setupConnectionListeners();
        this.setupSyncInterval();
        
        // Limpieza inicial de datos viejos
        setTimeout(() => this.cleanOldData(), 2000);
    }

    /**
     * Inicializar IndexedDB con esquemas
     * @returns {Promise} Promesa de inicialización
     */
    async initOfflineDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            
            request.onerror = (event) => {
                console.error('Error al abrir IndexedDB:', event.target.error);
                reject(event.target.error);
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                console.log('IndexedDB inicializado correctamente');
                resolve();
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;
                
                // Crear o actualizar almacenes de datos
                this.createObjectStores(db, oldVersion);
            };
        });
    }

    createObjectStores(db, oldVersion) {
        // Schema para datos maestros (read-only offline)
        if (!db.objectStoreNames.contains('master_data')) {
            const masterStore = db.createObjectStore('master_data', { keyPath: 'id' });
            masterStore.createIndex('collection', 'collection', { unique: false });
            masterStore.createIndex('updated_at', 'updated_at', { unique: false });
            masterStore.createIndex('collection_type', ['collection', 'type'], { unique: false });
        }
        
        // Schema para operaciones pendientes
        if (!db.objectStoreNames.contains('pending_operations')) {
            const opsStore = db.createObjectStore('pending_operations', { 
                keyPath: 'localId',
                autoIncrement: true 
            });
            opsStore.createIndex('status', 'status', { unique: false });
            opsStore.createIndex('collection', 'collection', { unique: false });
            opsStore.createIndex('created_at', 'created_at', { unique: false });
            opsStore.createIndex('retry_count', 'retry_count', { unique: false });
        }
        
        // Schema para metadatos y configuración
        if (!db.objectStoreNames.contains('metadata')) {
            const metaStore = db.createObjectStore('metadata', { keyPath: 'key' });
        }
        
        // Actualizaciones de versión
        if (oldVersion < 2) {
            // Actualización para v2: agregar índice compuesto
            const store = db.transaction.objectStore('master_data');
            if (!store.indexNames.contains('collection_type')) {
                store.createIndex('collection_type', ['collection', 'type'], { unique: false });
            }
        }
        
        if (oldVersion < 3) {
            // Actualización para v3: agregar campo de compresión
            const store = db.transaction.objectStore('master_data');
            store.transaction.oncomplete = () => {
                // Migrar datos existentes
                this.migrateToCompression(db);
            };
        }
        
        if (oldVersion < 4) {
            // Actualización para v4: agregar índice para búsquedas
            const store = db.transaction.objectStore('pending_operations');
            if (!store.indexNames.contains('retry_count')) {
                store.createIndex('retry_count', 'retry_count', { unique: false });
            }
        }
    }

    /**
     * GESTIÓN DE DATOS OFFLINE
     */

    /**
     * Guardar datos offline con compresión
     * @param {string} collection - Nombre de la colección
     * @param {Array|Object} data - Datos a guardar
     * @returns {Promise} Promesa con resultado de la operación
     */
    async saveOfflineData(collection, data) {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                const transaction = this.db.transaction(['master_data'], 'readwrite');
                const store = transaction.objectStore('master_data');
                
                // Verificar límites de la colección
                await this.enforceCollectionLimit(collection);
                
                const items = Array.isArray(data) ? data : [data];
                const timestamp = Date.now();
                
                for (const item of items) {
                    // Generar ID offline único si no existe
                    if (!item.id) {
                        item.id = this.generateOfflineId(collection);
                    }
                    
                    // Marcar como dato offline
                    item._offline = true;
                    item._collection = collection;
                    item._updated_at = timestamp;
                    item._synced = false;
                    
                    // Comprimir datos si son grandes
                    const compressedData = await this.compressData(item);
                    
                    const record = {
                        id: item.id,
                        collection: collection,
                        data: compressedData,
                        updated_at: timestamp,
                        type: 'master' // o 'operation' según corresponda
                    };
                    
                    store.put(record);
                }
                
                transaction.oncomplete = () => {
                    console.log(`Datos guardados en ${collection}: ${items.length} items`);
                    resolve({ success: true, count: items.length });
                };
                
                transaction.onerror = (event) => {
                    reject(new Error(`Error al guardar datos: ${event.target.error}`));
                };
                
            } catch (error) {
                console.error('Error en saveOfflineData:', error);
                reject(error);
            }
        });
    }

    /**
     * Consultar datos offline
     * @param {string} collection - Colección a consultar
     * @param {Object} query - Objeto de consulta
     * @returns {Promise} Promesa con resultados
     */
    async getOfflineData(collection, query = {}) {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                const transaction = this.db.transaction(['master_data'], 'readonly');
                const store = transaction.objectStore('master_data');
                const index = store.index('collection');
                const range = IDBKeyRange.only(collection);
                const request = index.openCursor(range);
                
                const results = [];
                
                request.onsuccess = async (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        const record = cursor.value;
                        // Descomprimir datos
                        const item = await this.decompressData(record.data);
                        
                        // Aplicar filtros de consulta
                        if (this.matchesQuery(item, query)) {
                            results.push(item);
                        }
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                
                request.onerror = (event) => {
                    reject(new Error(`Error en consulta: ${event.target.error}`));
                };
                
            } catch (error) {
                console.error('Error en getOfflineData:', error);
                reject(error);
            }
        });
    }

    /**
     * GESTIÓN DE SINCRONIZACIÓN
     */

    /**
     * Obtener operaciones pendientes de sincronización
     * @returns {Promise} Promesa con operaciones pendientes
     */
    async getPendingOperations() {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['pending_operations'], 'readonly');
            const store = transaction.objectStore('pending_operations');
            const index = store.index('status');
            const range = IDBKeyRange.only('pending');
            const request = index.openCursor(range);
            
            const operations = [];
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    operations.push(cursor.value);
                    cursor.continue();
                } else {
                    // Ordenar por fecha de creación
                    operations.sort((a, b) => a.created_at - b.created_at);
                    resolve(operations);
                }
            };
            
            request.onerror = (event) => {
                reject(new Error(`Error al obtener operaciones: ${event.target.error}`));
            };
        });
    }

    /**
     * Encolar operación para sincronización
     * @param {Object} operation - Operación a encolar
     * @returns {Promise} Promesa con ID local
     */
    async queueOperation(operation) {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise((resolve, reject) => {
            // Validar operación
            if (!operation.type || !operation.collection || !operation.data) {
                reject(new Error('Operación inválida: falta tipo, colección o datos'));
                return;
            }
            
            const transaction = this.db.transaction(['pending_operations'], 'readwrite');
            const store = transaction.objectStore('pending_operations');
            
            const operationRecord = {
                ...operation,
                status: 'pending',
                created_at: Date.now(),
                retry_count: 0,
                last_retry: null,
                error: null
            };
            
            const request = store.add(operationRecord);
            
            request.onsuccess = (event) => {
                const localId = event.target.result;
                console.log(`Operación encolada con ID local: ${localId}`);
                
                // Intentar sincronización inmediata si hay conexión
                if (this.isOnline && !this.syncInProgress) {
                    this.attemptSync();
                }
                
                resolve(localId);
            };
            
            request.onerror = (event) => {
                reject(new Error(`Error al encolar operación: ${event.target.error}`));
            };
        });
    }

    /**
     * Limpiar operaciones ya sincronizadas
     * @returns {Promise} Promesa con resultado
     */
    async clearProcessedOperations() {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['pending_operations'], 'readwrite');
            const store = transaction.objectStore('pending_operations');
            const index = store.index('status');
            const range = IDBKeyRange.only('synced');
            
            const deleteRequest = index.openCursor(range);
            let deletedCount = 0;
            
            deleteRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    console.log(`Operaciones eliminadas: ${deletedCount}`);
                    resolve({ deleted: deletedCount });
                }
            };
            
            deleteRequest.onerror = (event) => {
                reject(new Error(`Error al limpiar operaciones: ${event.target.error}`));
            };
        });
    }

    /**
     * GESTIÓN DE ALMACENAMIENTO
     */

    /**
     * Obtener uso de almacenamiento offline
     * @returns {Promise} Promesa con estadísticas
     */
    async getStorageUsage() {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                const transaction = this.db.transaction([
                    'master_data', 
                    'pending_operations', 
                    'metadata'
                ], 'readonly');
                
                const stores = {
                    master_data: transaction.objectStore('master_data'),
                    pending_operations: transaction.objectStore('pending_operations'),
                    metadata: transaction.objectStore('metadata')
                };
                
                const stats = {
                    total: 0,
                    byCollection: {},
                    byStore: {}
                };
                
                // Contar registros por almacén
                for (const [storeName, store] of Object.entries(stores)) {
                    const countRequest = store.count();
                    
                    countRequest.onsuccess = (event) => {
                        stats.byStore[storeName] = event.target.result;
                        stats.total += event.target.result;
                        
                        // Si es master_data, desglosar por colección
                        if (storeName === 'master_data') {
                            this.getCollectionStats(store).then(collectionStats => {
                                stats.byCollection = collectionStats;
                                
                                // Verificar si todas las promesas se completaron
                                if (Object.keys(stats.byStore).length === 3) {
                                    resolve(stats);
                                }
                            });
                        }
                    };
                    
                    countRequest.onerror = (error) => {
                        console.error(`Error contando ${storeName}:`, error);
                        stats.byStore[storeName] = 0;
                    };
                }
                
                // Manejar finalización de transacción
                transaction.oncomplete = () => {
                    if (!stats.byCollection) {
                        stats.byCollection = {};
                    }
                    resolve(stats);
                };
                
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Limpiar datos viejos según políticas
     * @returns {Promise} Promesa con resultados
     */
    async cleanOldData() {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                const now = Date.now();
                const sevenDaysAgo = now - (this.retentionPolicies.operations * 24 * 60 * 60 * 1000);
                const thirtyDaysAgo = now - (this.retentionPolicies.master * 24 * 60 * 60 * 1000);
                
                // Limpiar operaciones antiguas
                const opsCleaned = await this.cleanOldOperations(sevenDaysAgo);
                
                // Limpiar datos maestros antiguos
                const masterCleaned = await this.cleanOldMasterData(thirtyDaysAgo);
                
                // Limpiar operaciones sincronizadas
                const syncedCleaned = await this.clearProcessedOperations();
                
                resolve({
                    operations_cleaned: opsCleaned,
                    master_data_cleaned: masterCleaned,
                    synced_operations_cleaned: syncedCleaned.deleted || 0,
                    timestamp: new Date().toISOString()
                });
                
            } catch (error) {
                console.error('Error en cleanOldData:', error);
                reject(error);
            }
        });
    }

    /**
     * BACKUP Y RESTAURACIÓN
     */

    /**
     * Exportar datos para backup
     * @returns {Promise} Promesa con datos exportados
     */
    async exportOfflineData() {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                const exportData = {
                    version: this.dbVersion,
                    exported_at: new Date().toISOString(),
                    collections: {}
                };
                
                // Obtener todas las colecciones únicas
                const collections = await this.getAllCollections();
                
                for (const collection of collections) {
                    const data = await this.getOfflineData(collection, {});
                    exportData.collections[collection] = data;
                }
                
                // Obtener metadatos
                exportData.metadata = await this.getMetadata();
                
                // Obtener operaciones pendientes (sin datos sensibles)
                const pendingOps = await this.getPendingOperations();
                exportData.pending_operations = pendingOps.map(op => ({
                    id: op.localId,
                    type: op.type,
                    collection: op.collection,
                    created_at: op.created_at,
                    retry_count: op.retry_count
                }));
                
                resolve(exportData);
                
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Importar datos de backup
     * @param {Object} data - Datos a importar
     * @returns {Promise} Promesa con resultado
     */
    async importOfflineData(data) {
        if (!this.db) await this.initOfflineDB();
        
        return new Promise(async (resolve, reject) => {
            try {
                // Validar estructura de datos
                if (!data.collections || !data.version) {
                    reject(new Error('Formato de backup inválido'));
                    return;
                }
                
                // Limpiar datos existentes antes de importar
                await this.clearAllData();
                
                let importedCount = 0;
                
                // Importar colecciones
                for (const [collection, items] of Object.entries(data.collections)) {
                    if (Array.isArray(items)) {
                        await this.saveOfflineData(collection, items);
                        importedCount += items.length;
                    }
                }
                
                // Importar metadatos si existen
                if (data.metadata) {
                    await this.saveMetadata(data.metadata);
                }
                
                resolve({
                    success: true,
                    imported: importedCount,
                    collections: Object.keys(data.collections).length
                });
                
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * MÉTODOS AUXILIARES
     */

    generateOfflineId(collection) {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substr(2, 9);
        return `offline_${collection}_${timestamp}_${random}`;
    }

    async enforceCollectionLimit(collection) {
        const limit = this.collectionLimits[collection];
        if (!limit) return;
        
        const data = await this.getOfflineData(collection, {});
        
        if (data.length >= limit) {
            // Ordenar por fecha de actualización y eliminar los más antiguos
            const sorted = data.sort((a, b) => 
                (b._updated_at || 0) - (a._updated_at || 0)
            );
            
            const toRemove = sorted.slice(limit - 1);
            
            for (const item of toRemove) {
                await this.deleteOfflineItem(collection, item.id);
            }
            
            console.log(`Límite aplicado: ${toRemove.length} items eliminados de ${collection}`);
        }
    }

    async deleteOfflineItem(collection, id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['master_data'], 'readwrite');
            const store = transaction.objectStore('master_data');
            store.delete(id);
            
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);
        });
    }

    matchesQuery(item, query) {
        for (const [key, value] of Object.entries(query)) {
            if (item[key] !== value) {
                return false;
            }
        }
        return true;
    }

    async compressData(data) {
        // Compresión simple para JSON - en producción usar algo como lz-string
        try {
            const jsonString = JSON.stringify(data);
            // Solo comprimir si es grande (> 1KB)
            if (jsonString.length > 1024) {
                return btoa(unescape(encodeURIComponent(jsonString)));
            }
            return jsonString;
        } catch (error) {
            console.warn('Error en compresión, usando datos sin comprimir:', error);
            return JSON.stringify(data);
        }
    }

    async decompressData(compressedData) {
        try {
            // Intentar descomprimir como base64 primero
            if (compressedData.startsWith('ey') || compressedData.length > 1000) {
                try {
                    const jsonString = decodeURIComponent(escape(atob(compressedData)));
                    return JSON.parse(jsonString);
                } catch (e) {
                    // Si falla, asumir que no está comprimido
                }
            }
            return JSON.parse(compressedData);
        } catch (error) {
            console.error('Error descomprimiendo datos:', error);
            return null;
        }
    }

    setupConnectionListeners() {
        const handleOnline = () => {
            this.isOnline = true;
            console.log('Conectado - Modo online');
            this.notifyConnectionChange(true);
            
            // Intentar sincronizar pendientes
            setTimeout(() => this.attemptSync(), 1000);
        };
        
        const handleOffline = () => {
            this.isOnline = false;
            console.log('Desconectado - Modo offline');
            this.notifyConnectionChange(false);
        };
        
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        
        // Guardar listeners para limpieza
        this.connectionListeners = [
            { type: 'online', handler: handleOnline },
            { type: 'offline', handler: handleOffline }
        ];
    }

    setupSyncInterval() {
        // Sincronizar cada 5 minutos si hay conexión
        setInterval(() => {
            if (this.isOnline && !this.syncInProgress) {
                this.attemptSync();
            }
        }, 5 * 60 * 1000);
    }

    async attemptSync() {
        if (this.syncInProgress || !this.isOnline) return;
        
        this.syncInProgress = true;
        console.log('Iniciando sincronización...');
        
        try {
            const pendingOps = await this.getPendingOperations();
            
            for (const operation of pendingOps) {
                // Límite de reintentos
                if (operation.retry_count >= 3) {
                    console.warn(`Operación ${operation.localId} excedió reintentos`);
                    await this.markOperationFailed(operation.localId, 'Max retries exceeded');
                    continue;
                }
                
                try {
                    // Aquí iría la lógica de sincronización con Firestore
                    // Por ahora simulamos una sincronización exitosa
                    await this.simulateFirestoreSync(operation);
                    
                    await this.markOperationSynced(operation.localId);
                    
                } catch (syncError) {
                    console.error(`Error sincronizando operación ${operation.localId}:`, syncError);
                    await this.incrementRetryCount(operation.localId, syncError.message);
                }
            }
            
            // Limpiar operaciones sincronizadas
            await this.clearProcessedOperations();
            
        } catch (error) {
            console.error('Error en proceso de sincronización:', error);
        } finally {
            this.syncInProgress = false;
            console.log('Sincronización completada');
        }
    }

    notifyConnectionChange(isOnline) {
        // Disparar evento personalizado
        const event = new CustomEvent('offline-status-change', {
            detail: { isOnline }
        });
        window.dispatchEvent(event);
        
        // También actualizar UI si hay un callback registrado
        if (this.onConnectionChange) {
            this.onConnectionChange(isOnline);
        }
    }

    // Métodos auxiliares para operaciones pendientes
    async markOperationSynced(localId) {
        return this.updateOperationStatus(localId, 'synced');
    }

    async markOperationFailed(localId, error) {
        return this.updateOperationStatus(localId, 'failed', error);
    }

    async updateOperationStatus(localId, status, error = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['pending_operations'], 'readwrite');
            const store = transaction.objectStore('pending_operations');
            
            const getRequest = store.get(localId);
            
            getRequest.onsuccess = (event) => {
                const operation = event.target.result;
                if (operation) {
                    operation.status = status;
                    if (error) operation.error = error;
                    operation.updated_at = Date.now();
                    
                    const updateRequest = store.put(operation);
                    
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = (e) => reject(e.target.error);
                } else {
                    reject(new Error('Operación no encontrada'));
                }
            };
            
            getRequest.onerror = (event) => reject(event.target.error);
        });
    }

    async incrementRetryCount(localId, error = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['pending_operations'], 'readwrite');
            const store = transaction.objectStore('pending_operations');
            
            const getRequest = store.get(localId);
            
            getRequest.onsuccess = (event) => {
                const operation = event.target.result;
                if (operation) {
                    operation.retry_count = (operation.retry_count || 0) + 1;
                    operation.last_retry = Date.now();
                    if (error) operation.error = error;
                    
                    const updateRequest = store.put(operation);
                    
                    updateRequest.onsuccess = () => resolve();
                    updateRequest.onerror = (e) => reject(e.target.error);
                } else {
                    reject(new Error('Operación no encontrada'));
                }
            };
            
            getRequest.onerror = (event) => reject(event.target.error);
        });
    }

    async cleanOldOperations(cutoffDate) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['pending_operations'], 'readwrite');
            const store = transaction.objectStore('pending_operations');
            const index = store.index('created_at');
            const range = IDBKeyRange.upperBound(cutoffDate);
            
            const deleteRequest = index.openCursor(range);
            let deletedCount = 0;
            
            deleteRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    resolve(deletedCount);
                }
            };
            
            deleteRequest.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    async cleanOldMasterData(cutoffDate) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['master_data'], 'readwrite');
            const store = transaction.objectStore('master_data');
            const index = store.index('updated_at');
            const range = IDBKeyRange.upperBound(cutoffDate);
            
            const deleteRequest = index.openCursor(range);
            let deletedCount = 0;
            
            deleteRequest.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    deletedCount++;
                    cursor.continue();
                } else {
                    resolve(deletedCount);
                }
            };
            
            deleteRequest.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    async getAllCollections() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['master_data'], 'readonly');
            const store = transaction.objectStore('master_data');
            const index = store.index('collection');
            const request = index.getAllKeys();
            
            request.onsuccess = (event) => {
                const collections = [...new Set(event.target.result)];
                resolve(collections);
            };
            
            request.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    async getCollectionStats(store) {
        return new Promise((resolve) => {
            const index = store.index('collection');
            const request = index.openCursor();
            const stats = {};
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const collection = cursor.key;
                    stats[collection] = (stats[collection] || 0) + 1;
                    cursor.continue();
                } else {
                    resolve(stats);
                }
            };
            
            request.onerror = () => {
                resolve({});
            };
        });
    }

    async getMetadata() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readonly');
            const store = transaction.objectStore('metadata');
            const request = store.getAll();
            
            request.onsuccess = (event) => {
                const metadata = {};
                event.target.result.forEach(item => {
                    metadata[item.key] = item.value;
                });
                resolve(metadata);
            };
            
            request.onerror = (event) => {
                reject(event.target.error);
            };
        });
    }

    async saveMetadata(metadata) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['metadata'], 'readwrite');
            const store = transaction.objectStore('metadata');
            
            for (const [key, value] of Object.entries(metadata)) {
                store.put({ key, value });
            }
            
            transaction.oncomplete = () => resolve();
            transaction.onerror = (event) => reject(event.target.error);
        });
    }

    async clearAllData() {
        return new Promise(async (resolve, reject) => {
            try {
                // Cerrar conexión existente
                if (this.db) {
                    this.db.close();
                }
                
                // Eliminar base de datos
                const deleteRequest = indexedDB.deleteDatabase(this.dbName);
                
                deleteRequest.onsuccess = () => {
                    console.log('Base de datos eliminada para importación limpia');
                    // Re-inicializar
                    this.initOfflineDB().then(resolve).catch(reject);
                };
                
                deleteRequest.onerror = (event) => {
                    reject(event.target.error);
                };
                
            } catch (error) {
                reject(error);
            }
        });
    }

    migrateToCompression(db) {
        console.log('Migrando a sistema de compresión...');
        // Implementación de migración
    }

    async simulateFirestoreSync(operation) {
        // Simulación de sincronización con Firestore
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                // Simular falla aleatoria del 10%
                if (Math.random() < 0.1) {
                    reject(new Error('Error de red simulado'));
                } else {
                    resolve({ success: true, serverId: `server_${Date.now()}` });
                }
            }, 500);
        });
    }

    /**
     * DESTRUCTOR Y LIMPIEZA
     */

    cleanup() {
        // Remover event listeners
        this.connectionListeners.forEach(listener => {
            window.removeEventListener(listener.type, listener.handler);
        });
        
        // Cerrar conexión a IndexedDB
        if (this.db) {
            this.db.close();
        }
        
        console.log('OfflineManager limpiado');
    }
}

// Exportar instancia singleton
const offlineManager = new OfflineManager();

// Para uso en módulos ES6
export default offlineManager;

// Para uso global en navegador
if (typeof window !== 'undefined') {
    window.OfflineManager = offlineManager;
}
