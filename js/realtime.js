// realtime.js - Gestor eficiente de listeners de Firestore para Spark
import { db } from './firebase-config';
import { onSnapshot, doc, collection, query, where, limit, onDisconnect, serverTimestamp } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';

class RealtimeManager {
  constructor() {
    this.activeSubscriptions = new Map();
    this.pausedSubscriptions = new Map();
    this.cache = new Map();
    this.isOnline = true;
    this.maxListeners = 100;
    this.currentListenerCount = 0;
    
    this.initConnectionMonitoring();
    this.initAuthMonitoring();
  }

  /**
   * Inicializa monitoreo de conexión
   */
  initConnectionMonitoring() {
    const onlineHandler = () => {
      this.isOnline = true;
      this.resumeAllSubscriptions();
    };

    const offlineHandler = () => {
      this.isOnline = false;
      this.pauseAllSubscriptions();
    };

    window.addEventListener('online', onlineHandler);
    window.addEventListener('offline', offlineHandler);
  }

  /**
   * Inicializa monitoreo de autenticación
   */
  initAuthMonitoring() {
    // Limpia listeners cuando el usuario cambia
    onAuthStateChanged(auth, (user) => {
      if (!user) {
        this.cleanInactiveSubscriptions();
      }
    });
  }

  /**
   * Valida si se puede añadir un nuevo listener
   */
  _canAddListener() {
    if (this.currentListenerCount >= this.maxListeners) {
      console.warn('Límite de listeners alcanzado (100)');
      return false;
    }
    return true;
  }

  /**
   * Suscripción a colección con query optimizada
   */
  async subscribeToCollection(collectionName, queryConstraints, callback) {
    if (!this._canAddListener()) return null;
    if (this.activeSubscriptions.has(collectionName)) {
      this.unsubscribeFromCollection(collectionName);
    }

    try {
      const q = query(
        collection(db, collectionName),
        ...queryConstraints,
        limit(50) // Límite por defecto para evitar cargas grandes
      );

      const unsubscribe = onSnapshot(q, 
        (snapshot) => {
          const data = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
          }));
          
          // Cachear última data
          this.cache.set(collectionName, {
            data,
            timestamp: Date.now()
          });
          
          // Actualizar UI inmediatamente
          callback(data);
        },
        (error) => {
          this._handleError(error, collectionName);
        }
      );

      const subscription = {
        type: 'collection',
        unsubscribe,
        query: queryConstraints,
        timestamp: Date.now()
      };

      this.activeSubscriptions.set(collectionName, subscription);
      this.currentListenerCount++;
      
      return unsubscribe;
    } catch (error) {
      this._handleError(error, collectionName);
      return null;
    }
  }

  /**
   * Cancelar suscripción de colección
   */
  unsubscribeFromCollection(collectionName) {
    const subscription = this.activeSubscriptions.get(collectionName);
    if (subscription) {
      subscription.unsubscribe();
      this.activeSubscriptions.delete(collectionName);
      this.currentListenerCount--;
      console.log(`Unsubscribed from collection: ${collectionName}`);
    }
  }

  /**
   * Suscripción a documento específico
   */
  async subscribeToDocument(docPath, callback) {
    if (!this._canAddListener()) return null;
    if (this.activeSubscriptions.has(docPath)) {
      this.unsubscribeFromDocument(docPath);
    }

    try {
      const docRef = doc(db, docPath);
      
      const unsubscribe = onSnapshot(docRef, 
        (document) => {
          if (document.exists()) {
            const data = {
              id: document.id,
              ...document.data()
            };
            
            // Cachear documento
            this.cache.set(docPath, {
              data,
              timestamp: Date.now()
            });
            
            // Notificar conflictos si hay cambios concurrentes
            this._checkForConflicts(docPath, data);
            
            callback(data);
          }
        },
        (error) => {
          this._handleError(error, docPath);
        }
      );

      const subscription = {
        type: 'document',
        unsubscribe,
        timestamp: Date.now()
      };

      this.activeSubscriptions.set(docPath, subscription);
      this.currentListenerCount++;
      
      return unsubscribe;
    } catch (error) {
      this._handleError(error, docPath);
      return null;
    }
  }

  /**
   * Cancelar suscripción de documento
   */
  unsubscribeFromDocument(docPath) {
    const subscription = this.activeSubscriptions.get(docPath);
    if (subscription) {
      subscription.unsubscribe();
      this.activeSubscriptions.delete(docPath);
      this.currentListenerCount--;
      console.log(`Unsubscribed from document: ${docPath}`);
    }
  }

  /**
   * Alertas de stock bajo (optimizada con índices)
   */
  async subscribeToStockAlerts(localId, callback) {
    const queryConstraints = [
      where('localId', '==', localId),
      where('stockActual', '<=', where('stockMinimo')),
      where('activo', '==', true),
      limit(20) // Máximo 20 alertas simultáneas
    ];

    return this.subscribeToCollection('productos', queryConstraints, callback);
  }

  /**
   * Cambios en caja registradora
   */
  async subscribeToCashboxChanges(localId, callback) {
    const docPath = `locales/${localId}/caja/actual`;
    return this.subscribeToDocument(docPath, callback);
  }

  /**
   * Obtener suscripciones activas
   */
  getActiveSubscriptions() {
    const subscriptions = [];
    this.activeSubscriptions.forEach((value, key) => {
      subscriptions.push({
        id: key,
        type: value.type,
        active: true,
        timestamp: value.timestamp
      });
    });
    return subscriptions;
  }

  /**
   * Pausar todas las suscripciones
   */
  pauseAllSubscriptions() {
    console.log('Pausing all subscriptions');
    this.activeSubscriptions.forEach((subscription, key) => {
      subscription.unsubscribe();
      this.pausedSubscriptions.set(key, subscription);
    });
    this.activeSubscriptions.clear();
    this.currentListenerCount = 0;
  }

  /**
   * Reanudar suscripciones pausadas
   */
  resumeAllSubscriptions() {
    console.log('Resuming paused subscriptions');
    this.pausedSubscriptions.forEach(async (subscription, key) => {
      if (subscription.type === 'collection') {
        await this.subscribeToCollection(key, subscription.query, subscription.callback);
      } else if (subscription.type === 'document') {
        await this.subscribeToDocument(key, subscription.callback);
      }
    });
    this.pausedSubscriptions.clear();
  }

  /**
   * Limpiar suscripciones inactivas (más de 30 minutos)
   */
  cleanInactiveSubscriptions() {
    const now = Date.now();
    const THIRTY_MINUTES = 30 * 60 * 1000;

    this.activeSubscriptions.forEach((subscription, key) => {
      if (now - subscription.timestamp > THIRTY_MINUTES) {
        this.unsubscribeFromCollection(key);
      }
    });
  }

  /**
   * Manejo de errores centralizado
   */
  _handleError(error, context) {
    console.error(`Firestore Error [${context}]:`, error.code, error.message);
    
    switch (error.code) {
      case 'permission-denied':
        console.warn('Permisos denegados para:', context);
        this.unsubscribeFromCollection(context);
        break;
        
      case 'failed-precondition':
        console.error('Índice requerido no encontrado. Crea el índice en Firebase Console.');
        break;
        
      case 'resource-exhausted':
        console.error('Límite de recursos excedido. Reduciendo listeners.');
        this.cleanInactiveSubscriptions();
        break;
        
      default:
        // Reintento automático para errores de red
        if (error.code === 'unavailable') {
          setTimeout(() => {
            if (this.isOnline) {
              this.resumeAllSubscriptions();
            }
          }, 5000);
        }
    }
  }

  /**
   * Detectar conflictos de datos concurrentes
   */
  _checkForConflicts(docPath, newData) {
    const cached = this.cache.get(docPath);
    if (cached && newData._updatedAt) {
      const timeDiff = newData._updatedAt - cached.data._updatedAt;
      if (timeDiff < 1000) { // Cambios en menos de 1 segundo
        console.warn('Posible conflicto de escritura concurrente:', docPath);
      }
    }
  }

  /**
   * Destructor para limpiar recursos
   */
  destroy() {
    this.activeSubscriptions.forEach((subscription, key) => {
      subscription.unsubscribe();
    });
    this.activeSubscriptions.clear();
    this.pausedSubscriptions.clear();
    this.cache.clear();
    this.currentListenerCount = 0;
    
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
  }
}

// Instancia única (Singleton)
export const realtimeManager = new RealtimeManager();

// Exportar funciones individuales para conveniencia
export const subscribeToCollection = (collection, query, callback) => 
  realtimeManager.subscribeToCollection(collection, query, callback);

export const unsubscribeFromCollection = (collection) => 
  realtimeManager.unsubscribeFromCollection(collection);

export const subscribeToDocument = (docPath, callback) => 
  realtimeManager.subscribeToDocument(docPath, callback);

export const unsubscribeFromDocument = (docPath) => 
  realtimeManager.unsubscribeFromDocument(docPath);

export const getActiveSubscriptions = () => 
  realtimeManager.getActiveSubscriptions();

export const pauseAllSubscriptions = () => 
  realtimeManager.pauseAllSubscriptions();

export const resumeAllSubscriptions = () => 
  realtimeManager.resumeAllSubscriptions();

export const cleanInactiveSubscriptions = () => 
  realtimeManager.cleanInactiveSubscriptions();

export const subscribeToStockAlerts = (localId, callback) => 
  realtimeManager.subscribeToStockAlerts(localId, callback);

export const subscribeToCashboxChanges = (localId, callback) => 
  realtimeManager.subscribeToCashboxChanges(localId, callback);

export default realtimeManager;
