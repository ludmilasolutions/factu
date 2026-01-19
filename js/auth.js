/**
 * Sistema de Autenticación y Gestión de Usuarios
 * Versión compat - Usando Firebase compat SDK
 */

// Importar Firebase desde el script global
const auth = firebase.auth();
const db = firebase.firestore();

// Importar idb si es necesario, o usar la versión desde CDN
let openDB, deleteDB;
if (window.idb) {
  openDB = window.idb.openDB;
  deleteDB = window.idb.deleteDB;
} else {
  // Cargar dinámicamente si no está disponible
  console.warn('idb no está disponible');
}

// Configuración de IndexedDB
const DB_NAME = 'auth_cache_db';
const DB_VERSION = 2;
const STORE_NAMES = {
  USER: 'user_data',
  ROLES: 'roles_cache',
  OFFLINE_OPS: 'offline_operations'
};

let dbInstance = null;

/**
 * Inicializar IndexedDB para cache offline
 */
const initDB = async () => {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, transaction) {
      // Store para datos de usuario
      if (!db.objectStoreNames.contains(STORE_NAMES.USER)) {
        db.createObjectStore(STORE_NAMES.USER);
      }
      
      // Store para cache de roles (24h)
      if (!db.objectStoreNames.contains(STORE_NAMES.ROLES)) {
        const rolesStore = db.createObjectStore(STORE_NAMES.ROLES);
        rolesStore.createIndex('expiresAt', 'expiresAt');
      }
      
      // Store para operaciones offline pendientes
      if (!db.objectStoreNames.contains(STORE_NAMES.OFFLINE_OPS)) {
        const opsStore = db.createObjectStore(STORE_NAMES.OFFLINE_OPS, { 
          keyPath: 'id',
          autoIncrement: true 
        });
        opsStore.createIndex('status', 'status');
        opsStore.createIndex('type', 'type');
      }
    }
  });

  return dbInstance;
};

/**
 * Login completo con validación de local y turno
 */
export const loginUser = async (email, password, localId, turno) => {
  try {
    // Validaciones iniciales
    if (!email || !password) {
      throw new Error('Email y contraseña son requeridos');
    }
    
    if (!localId || !turno) {
      throw new Error('Debe seleccionar un local y turno');
    }
    
    // 1. Autenticación con Firebase Auth
    const userCredential = await auth.signInWithEmailAndPassword(email, password);
    const user = userCredential.user;
    
    // 2. Obtener datos del usuario desde Firestore
    const userDoc = await db.collection('users').doc(user.uid).get();
    
    if (!userDoc.exists) {
      await auth.signOut();
      throw new Error('Usuario no encontrado en el sistema');
    }
    
    const userData = userDoc.data();
    
    // 3. Validar local y turno
    if (!userData.roles || !userData.roles[localId]) {
      throw new Error('Usuario no tiene permisos para este local');
    }
    
    const validTurns = ['mañana', 'tarde', 'noche'];
    if (!validTurns.includes(turno)) {
      throw new Error('Turno inválido');
    }
    
    // 4. Construir objeto de usuario completo
    const completeUserData = {
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      name: userData.name || '',
      phone: userData.phone || '',
      roles: userData.roles,
      activeLocal: localId,
      activeTurn: turno,
      lastLogin: new Date().toISOString(),
      loginTimestamp: Date.now(),
      token: await user.getIdToken()
    };
    
    // 5. Cachear en IndexedDB
    const idb = await initDB();
    await idb.put(STORE_NAMES.USER, completeUserData, 'current_user');
    
    // 6. Cachear roles por 24 horas
    const rolesCache = {
      userId: user.uid,
      roles: userData.roles,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000)
    };
    
    await idb.put(STORE_NAMES.ROLES, rolesCache, user.uid);
    
    return completeUserData;
    
  } catch (error) {
    console.error('Error en login:', error.code || error.message);
    
    if (error.code === 'auth/invalid-credential') {
      throw new Error('Credenciales inválidas');
    } else if (error.code === 'auth/too-many-requests') {
      throw new Error('Demasiados intentos. Intente más tarde');
    }
    
    throw error;
  }
};

/**
 * Cerrar sesión
 */
export const logoutUser = async () => {
  try {
    await auth.signOut();
    
    // Limpiar cache local
    const idb = await initDB();
    await idb.delete(STORE_NAMES.USER, 'current_user');
    
    return true;
  } catch (error) {
    console.error('Error en logout:', error);
    throw error;
  }
};

/**
 * Obtener usuario actual
 */
export const getCurrentUser = async () => {
  const user = auth.currentUser;
  
  if (!user) {
    return null;
  }
  
  try {
    const idb = await initDB();
    const cachedUser = await idb.get(STORE_NAMES.USER, 'current_user');
    
    if (cachedUser) {
      return cachedUser;
    }
    
    // Si no hay cache, obtener de Firestore
    const userDoc = await db.collection('users').doc(user.uid).get();
    
    if (!userDoc.exists) {
      return null;
    }
    
    const userData = userDoc.data();
    
    return {
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      name: userData.name || '',
      phone: userData.phone || '',
      roles: userData.roles || {},
      token: await user.getIdToken()
    };
    
  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    return null;
  }
};

// Exportar instancias de Firebase para uso en otros archivos
export { auth, db };
