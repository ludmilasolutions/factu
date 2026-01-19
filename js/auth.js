/**
 * Sistema de Autenticación y Gestión de Usuarios
 * Responsabilidad: Gestionar autenticación, usuarios, roles y permisos del sistema
 * Arquitectura: Firebase Auth + Firestore + IndexedDB (offline)
 */

import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInWithEmailAndPassword, 
  signOut, 
  updatePassword, 
  sendPasswordResetEmail,
  onAuthStateChanged,
  getIdToken,
  getIdTokenResult
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  collection, 
  query, 
  where, 
  getDocs,
  onSnapshot,
  enableIndexedDbPersistence
} from 'firebase/firestore';
import { openDB, deleteDB } from 'idb';

// Configuración de Firebase
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Configurar persistencia offline
enableIndexedDbPersistence(db).catch((err) => {
  console.error('Persistencia offline no disponible:', err.code);
});

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
 * Limpiar cache expirada
 */
const cleanExpiredCache = async () => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAMES.ROLES, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.ROLES);
    const index = store.index('expiresAt');
    
    const expired = await index.getAll(IDBKeyRange.upperBound(Date.now()));
    
    for (const item of expired) {
      await store.delete(item.id);
    }
    
    await tx.done;
  } catch (error) {
    console.warn('Error limpiando cache expirada:', error);
  }
};

// Estado global de la sesión
let currentUserData = null;
let authListeners = [];
let sessionTimer = null;
let connectionListener = null;
let userSnapshotUnsubscribe = null;

/**
 * Validar estructura de datos de usuario
 */
const validateUserData = (userData) => {
  const requiredFields = ['uid', 'email', 'name', 'roles', 'activeLocal', 'activeTurn'];
  
  for (const field of requiredFields) {
    if (!userData[field]) {
      throw new Error(`Campo requerido faltante: ${field}`);
    }
  }
  
  // Validar que roles sea un mapa de localId -> array de roles
  if (typeof userData.roles !== 'object' || Array.isArray(userData.roles)) {
    throw new Error('Roles debe ser un objeto mapa');
  }
  
  // Validar que el local activo exista en los roles
  if (!userData.roles[userData.activeLocal]) {
    throw new Error('Local activo no encontrado en roles del usuario');
  }
  
  return true;
};

/**
 * Login completo con validación de local y turno
 * @param {string} email - Email del usuario
 * @param {string} password - Contraseña
 * @param {string} localId - ID del local seleccionado
 * @param {string} turno - Turno seleccionado ('mañana', 'tarde', 'noche')
 * @returns {Promise<Object>} Datos del usuario autenticado
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
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    
    // 2. Obtener datos del usuario desde Firestore
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    
    if (!userDoc.exists()) {
      await signOut(auth);
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
    
    validateUserData(completeUserData);
    
    // 5. Cachear en IndexedDB
    const db = await initDB();
    await db.put(STORE_NAMES.USER, completeUserData, 'current_user');
    
    // 6. Cachear roles por 24 horas
    const rolesCache = {
      userId: user.uid,
      roles: userData.roles,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 horas
    };
    
    await db.put(STORE_NAMES.ROLES, rolesCache, user.uid);
    
    // 7. Limpiar cache expirada
    await cleanExpiredCache();
    
    // 8. Configurar listener para cambios del usuario actual
    setupUserSnapshotListener(user.uid);
    
    // 9. Configurar validación periódica de sesión
    setupSessionValidation();
    
    // 10. Configurar listener de conexión
    setupConnectionListener();
    
    currentUserData = completeUserData;
    
    // Notificar a listeners
    notifyAuthListeners(completeUserData);
    
    return completeUserData;
    
  } catch (error) {
    console.error('Error en login:', error.code || error.message);
    
    // No exponer detalles internos
    if (error.code === 'auth/invalid-credential') {
      throw new Error('Credenciales inválidas');
    } else if (error.code === 'auth/too-many-requests') {
      throw new Error('Demasiados intentos. Intente más tarde');
    } else if (error.code === 'auth/network-request-failed') {
      // Intentar login offline
      return await attemptOfflineLogin(email, localId, turno);
    }
    
    throw error;
  }
};

/**
 * Intento de login offline con credenciales cacheadas
 */
const attemptOfflineLogin = async (email, localId, turno) => {
  try {
    const db = await initDB();
    const cachedUser = await db.get(STORE_NAMES.USER, 'current_user');
    
    if (!cachedUser || cachedUser.email !== email) {
      throw new Error('No hay credenciales cacheadas disponibles');
    }
    
    // Validar que el local y turno coincidan
    if (cachedUser.activeLocal !== localId || cachedUser.activeTurn !== turno) {
      throw new Error('Local o turno no coinciden con la última sesión');
    }
    
    // Marcar como sesión offline
    cachedUser.isOffline = true;
    cachedUser.offlineSince = Date.now();
    
    currentUserData = cachedUser;
    
    // Registrar operación offline
    await db.add(STORE_NAMES.OFFLINE_OPS, {
      type: 'offline_login',
      timestamp: Date.now(),
      userId: cachedUser.uid,
      data: { localId, turno },
      status: 'pending'
    });
    
    notifyAuthListeners(cachedUser);
    
    return cachedUser;
    
  } catch (error) {
    throw new Error('No se puede conectar y no hay sesión offline disponible');
  }
};

/**
 * Cerrar sesión limpiando todos los datos
 */
export const logoutUser = async () => {
  try {
    // 1. Limpiar listeners
    if (userSnapshotUnsubscribe) {
      userSnapshotUnsubscribe();
      userSnapshotUnsubscribe = null;
    }
    
    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
    
    if (connectionListener) {
      connectionListener();
      connectionListener = null;
    }
    
    // 2. Cerrar sesión en Firebase
    await signOut(auth);
    
    // 3. Limpiar cache local (excepto roles que tienen expiración)
    const db = await initDB();
    await db.delete(STORE_NAMES.USER, 'current_user');
    
    // 4. Limpiar estado global
    currentUserData = null;
    
    // 5. Notificar listeners
    notifyAuthListeners(null);
    
  } catch (error) {
    console.error('Error en logout:', error);
    throw error;
  }
};

/**
 * Obtener usuario actual con datos completos
 * @returns {Object|null} Datos del usuario o null si no hay sesión
 */
export const getCurrentUser = async () => {
  // Si ya tenemos los datos en memoria, retornarlos
  if (currentUserData) {
    return currentUserData;
  }
  
  // Intentar cargar desde cache
  try {
    const db = await initDB();
    const cachedUser = await db.get(STORE_NAMES.USER, 'current_user');
    
    if (cachedUser) {
      // Verificar si la caché está expirada (más de 1 hora)
      const oneHourAgo = Date.now() - (60 * 60 * 1000);
      if (cachedUser.loginTimestamp && cachedUser.loginTimestamp > oneHourAgo) {
        currentUserData = cachedUser;
        return cachedUser;
      }
    }
  } catch (error) {
    console.warn('Error cargando usuario desde cache:', error);
  }
  
  return null;
};

/**
 * Actualizar perfil de usuario
 * @param {Object} data - Datos a actualizar
 */
export const updateUserProfile = async (data) => {
  try {
    const user = await getCurrentUser();
    if (!user) throw new Error('No hay usuario autenticado');
    
    // Validar campos permitidos
    const allowedFields = ['name', 'phone', 'avatar'];
    const updateData = {};
    
    Object.keys(data).forEach(key => {
      if (allowedFields.includes(key)) {
        updateData[key] = data[key];
      }
    });
    
    if (Object.keys(updateData).length === 0) {
      throw new Error('No hay campos válidos para actualizar');
    }
    
    // 1. Actualizar en Firestore
    await updateDoc(doc(db, 'users', user.uid), updateData);
    
    // 2. Actualizar en cache local
    const dbCache = await initDB();
    const cachedUser = await dbCache.get(STORE_NAMES.USER, 'current_user');
    
    if (cachedUser) {
      Object.assign(cachedUser, updateData);
      await dbCache.put(STORE_NAMES.USER, cachedUser, 'current_user');
      currentUserData = cachedUser;
      
      // Notificar cambios
      notifyAuthListeners(cachedUser);
    }
    
    return true;
    
  } catch (error) {
    console.error('Error actualizando perfil:', error);
    
    // Si estamos offline, guardar operación para sincronizar después
    if (error.code === 'unavailable') {
      await queueOfflineOperation('update_profile', { data: updateData });
      throw new Error('Cambios guardados localmente. Se sincronizarán cuando haya conexión');
    }
    
    throw error;
  }
};

/**
 * Verificar si usuario tiene un permiso específico
 * @param {string} permission - Permiso a verificar
 * @returns {boolean} True si tiene permiso
 */
export const checkPermission = async (permission) => {
  try {
    const user = await getCurrentUser();
    if (!user) return false;
    
    // Obtener roles del local activo
    const localRoles = user.roles[user.activeLocal] || [];
    if (localRoles.length === 0) return false;
    
    // Obtener definición de permisos desde cache o Firestore
    const permissionsMap = await getPermissionsMap();
    
    // Verificar si algún rol tiene el permiso
    for (const role of localRoles) {
      const rolePermissions = permissionsMap[role] || [];
      if (rolePermissions.includes(permission)) {
        
        // Verificaciones específicas por turno
        if (permission.startsWith('caja.cerrar')) {
          return canCloseCashRegister(user.activeTurn);
        }
        
        return true;
      }
    }
    
    return false;
    
  } catch (error) {
    console.error('Error verificando permiso:', error);
    return false;
  }
};

/**
 * Obtener mapa de permisos desde cache o Firestore
 */
const getPermissionsMap = async () => {
  try {
    const db = await initDB();
    
    // Intentar desde cache primero
    const cachedRoles = await db.get(STORE_NAMES.ROLES, 'permissions_map');
    
    if (cachedRoles && cachedRoles.expiresAt > Date.now()) {
      return cachedRoles.data;
    }
    
    // Obtener desde Firestore
    const rolesSnapshot = await getDocs(collection(db, 'roles'));
    const permissionsMap = {};
    
    rolesSnapshot.forEach(doc => {
      permissionsMap[doc.id] = doc.data().permissions || [];
    });
    
    // Cachear por 24 horas
    await db.put(STORE_NAMES.ROLES, {
      data: permissionsMap,
      cachedAt: Date.now(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000)
    }, 'permissions_map');
    
    return permissionsMap;
    
  } catch (error) {
    console.error('Error obteniendo permisos:', error);
    
    // Fallback a cache expirada si estamos offline
    if (error.code === 'unavailable') {
      const db = await initDB();
      const cached = await db.get(STORE_NAMES.ROLES, 'permissions_map');
      return cached ? cached.data : {};
    }
    
    return {};
  }
};

/**
 * Validar si se puede cerrar caja según el turno
 */
const canCloseCashRegister = (turno) => {
  const horaActual = new Date().getHours();
  
  switch (turno) {
    case 'mañana':
      return horaActual >= 14 && horaActual < 22;
    case 'tarde':
      return horaActual >= 22 || horaActual < 6;
    case 'noche':
      return horaActual >= 6 && horaActual < 14;
    default:
      return false;
  }
};

/**
 * Listar usuarios por local (solo administradores)
 * @param {string} localId - ID del local
 * @returns {Promise<Array>} Lista de usuarios
 */
export const getUsersByLocal = async (localId) => {
  try {
    // Verificar permisos de administrador
    const hasPermission = await checkPermission('admin.users.view');
    if (!hasPermission) {
      throw new Error('Permiso denegado: Se requiere rol de administrador');
    }
    
    // Consultar usuarios que tienen acceso al local
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where(`roles.${localId}`, '!=', null));
    const snapshot = await getDocs(q);
    
    const users = [];
    snapshot.forEach(doc => {
      const userData = doc.data();
      users.push({
        uid: doc.id,
        email: userData.email,
        name: userData.name,
        roles: userData.roles[localId] || [],
        isActive: userData.isActive !== false
      });
    });
    
    return users;
    
  } catch (error) {
    console.error('Error obteniendo usuarios por local:', error);
    throw error;
  }
};

/**
 * Crear nuevo usuario (solo administradores)
 * @param {Object} userData - Datos del nuevo usuario
 */
export const createUser = async (userData) => {
  try {
    // Verificar permisos de administrador
    const hasPermission = await checkPermission('admin.users.create');
    if (!hasPermission) {
      throw new Error('Permiso denegado: Se requiere rol de administrador');
    }
    
    // Validar datos requeridos
    const requiredFields = ['email', 'name', 'password', 'roles'];
    for (const field of requiredFields) {
      if (!userData[field]) {
        throw new Error(`Campo requerido: ${field}`);
      }
    }
    
    // Validar estructura de roles
    if (typeof userData.roles !== 'object') {
      throw new Error('Roles debe ser un objeto con localId como clave');
    }
    
    // Crear usuario en Firebase Auth
    // NOTA: En producción, esto debería hacerse en un backend seguro
    // Por ahora, usamos una Cloud Function o un endpoint seguro
    const response = await fetch('/api/create-user', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${await auth.currentUser.getIdToken()}`
      },
      body: JSON.stringify(userData)
    });
    
    if (!response.ok) {
      throw new Error('Error creando usuario');
    }
    
    return await response.json();
    
  } catch (error) {
    console.error('Error creando usuario:', error);
    throw error;
  }
};

/**
 * Cambiar contraseña del usuario actual
 * @param {string} newPassword - Nueva contraseña
 */
export const changeUserPassword = async (newPassword) => {
  try {
    const user = auth.currentUser;
    if (!user) throw new Error('No hay usuario autenticado');
    
    // Validar fortaleza de contraseña
    if (newPassword.length < 8) {
      throw new Error('La contraseña debe tener al menos 8 caracteres');
    }
    
    await updatePassword(user, newPassword);
    
    // Registrar cambio en auditoría
    await updateDoc(doc(db, 'users', user.uid), {
      lastPasswordChange: new Date().toISOString()
    });
    
    return true;
    
  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    
    if (error.code === 'auth/requires-recent-login') {
      throw new Error('Debe volver a autenticarse para cambiar la contraseña');
    }
    
    throw error;
  }
};

/**
 * Enviar email de recuperación de contraseña
 * @param {string} email - Email del usuario
 */
export const resetPassword = async (email) => {
  try {
    if (!email) throw new Error('Email es requerido');
    
    await sendPasswordResetEmail(auth, email, {
      url: `${window.location.origin}/login`,
      handleCodeInApp: true
    });
    
    return true;
    
  } catch (error) {
    console.error('Error enviando email de recuperación:', error);
    
    // No revelar si el email existe o no
    if (error.code === 'auth/user-not-found') {
      // Silenciosamente retornar éxito por seguridad
      return true;
    }
    
    throw new Error('Error al procesar la solicitud. Intente nuevamente.');
  }
};

/**
 * Validar sesión activa en intervalos
 */
const setupSessionValidation = () => {
  if (sessionTimer) clearInterval(sessionTimer);
  
  // Validar cada 5 minutos
  sessionTimer = setInterval(async () => {
    try {
      const user = auth.currentUser;
      
      if (!user) {
        await logoutUser();
        return;
      }
      
      // Verificar si el token ha expirado
      const tokenResult = await getIdTokenResult(user, true);
      
      if (tokenResult.expirationTime < new Date().toISOString()) {
        console.warn('Token expirado, cerrando sesión');
        await logoutUser();
        return;
      }
      
      // Actualizar token en cache
      const db = await initDB();
      const cachedUser = await db.get(STORE_NAMES.USER, 'current_user');
      
      if (cachedUser) {
        cachedUser.token = tokenResult.token;
        cachedUser.tokenExpiration = tokenResult.expirationTime;
        await db.put(STORE_NAMES.USER, cachedUser, 'current_user');
      }
      
    } catch (error) {
      console.error('Error validando sesión:', error);
      
      // Si hay error de red, mantener sesión offline
      if (error.code !== 'auth/network-request-failed') {
        logoutUser();
      }
    }
  }, 5 * 60 * 1000); // 5 minutos
};

/**
 * Configurar listener para cambios en datos del usuario
 */
const setupUserSnapshotListener = (userId) => {
  if (userSnapshotUnsubscribe) {
    userSnapshotUnsubscribe();
  }
  
  userSnapshotUnsubscribe = onSnapshot(
    doc(db, 'users', userId),
    async (snapshot) => {
      if (!snapshot.exists()) {
        await logoutUser();
        return;
      }
      
      const userData = snapshot.data();
      
      // Actualizar cache local
      const dbCache = await initDB();
      const cachedUser = await dbCache.get(STORE_NAMES.USER, 'current_user');
      
      if (cachedUser) {
        // Mantener datos de sesión activa
        const updatedUser = {
          ...cachedUser,
          ...userData,
          activeLocal: cachedUser.activeLocal,
          activeTurn: cachedUser.activeTurn,
          lastLogin: cachedUser.lastLogin
        };
        
        await dbCache.put(STORE_NAMES.USER, updatedUser, 'current_user');
        currentUserData = updatedUser;
        
        // Notificar cambios
        notifyAuthListeners(updatedUser);
      }
    },
    (error) => {
      console.error('Error en listener de usuario:', error);
      // No desconectar por errores de red
    }
  );
};

/**
 * Configurar listener de estado de conexión
 */
const setupConnectionListener = () => {
  // Usar Firebase Realtime Database para estado de conexión
  // o implementar con window online/offline events
  
  const handleOnline = async () => {
    console.log('Conexión restablecida - Sincronizando datos...');
    
    // Sincronizar operaciones offline pendientes
    await syncOfflineOperations();
    
    // Actualizar estado de conexión en Firestore
    if (currentUserData) {
      await updateDoc(doc(db, 'users', currentUserData.uid), {
        isOnline: true,
        lastOnline: new Date().toISOString()
      });
    }
  };
  
  const handleOffline = async () => {
    console.log('Sin conexión - Modo offline activado');
    
    // Actualizar estado local
    if (currentUserData) {
      currentUserData.isOffline = true;
      currentUserData.offlineSince = Date.now();
      
      // Guardar en cache
      const db = await initDB();
      await db.put(STORE_NAMES.USER, currentUserData, 'current_user');
    }
  };
  
  // Escuchar eventos de conexión
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  
  // Guardar función para limpiar
  connectionListener = () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
  
  // Estado inicial
  if (!navigator.onLine) {
    handleOffline();
  }
};

/**
 * Sincronizar operaciones offline pendientes
 */
const syncOfflineOperations = async () => {
  try {
    const db = await initDB();
    const tx = db.transaction(STORE_NAMES.OFFLINE_OPS, 'readwrite');
    const store = tx.objectStore(STORE_NAMES.OFFLINE_OPS);
    const pendingOps = await store.index('status').getAll('pending');
    
    for (const op of pendingOps) {
      try {
        // Procesar según tipo de operación
        switch (op.type) {
          case 'update_profile':
            await updateUserProfile(op.data.data);
            break;
          case 'offline_login':
            // Registrar login offline en auditoría
            await updateDoc(doc(db, 'audit_logs', `offline_${op.id}`), {
              type: 'offline_login',
              userId: op.data.userId,
              timestamp: op.timestamp,
              localId: op.data.localId,
              turno: op.data.turno,
              syncedAt: new Date().toISOString()
            });
            break;
        }
        
        // Marcar como completado
        op.status = 'completed';
        op.syncedAt = Date.now();
        await store.put(op);
        
      } catch (error) {
        console.error(`Error sincronizando operación ${op.id}:`, error);
        op.status = 'failed';
        op.error = error.message;
        await store.put(op);
      }
    }
    
    await tx.done;
    
  } catch (error) {
    console.error('Error sincronizando operaciones offline:', error);
  }
};

/**
 * Cola de operaciones offline
 */
const queueOfflineOperation = async (type, data) => {
  const db = await initDB();
  
  await db.add(STORE_NAMES.OFFLINE_OPS, {
    type,
    timestamp: Date.now(),
    userId: currentUserData?.uid,
    data,
    status: 'pending',
    createdAt: new Date().toISOString()
  });
};

/**
 * Sistema de listeners para cambios de autenticación
 */
export const onAuthStateChange = (callback) => {
  authListeners.push(callback);
  
  // Retornar función para remover listener
  return () => {
    const index = authListeners.indexOf(callback);
    if (index > -1) {
      authListeners.splice(index, 1);
    }
  };
};

/**
 * Notificar a todos los listeners
 */
const notifyAuthListeners = (userData) => {
  authListeners.forEach(callback => {
    try {
      callback(userData);
    } catch (error) {
      console.error('Error en auth listener:', error);
    }
  });
};

/**
 * Validar sesión activa (para uso en intervalos)
 */
export const validateSession = async () => {
  const user = await getCurrentUser();
  
  if (!user) {
    return false;
  }
  
  // Verificar expiración del token (si está disponible)
  if (user.tokenExpiration) {
    const expTime = new Date(user.tokenExpiration).getTime();
    if (expTime < Date.now()) {
      await logoutUser();
      return false;
    }
  }
  
  // Verificar que no haya pasado más de 12 horas desde el login
  const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
  if (user.loginTimestamp && user.loginTimestamp < twelveHoursAgo) {
    await logoutUser();
    return false;
  }
  
  return true;
};

/**
 * Inicializar sistema de autenticación
 */
export const initAuth = () => {
  // Configurar listener de estado de autenticación de Firebase
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      // Usuario cerró sesión
      await logoutUser();
      return;
    }
    
    // Si ya tenemos datos de usuario, verificar que coincidan
    if (currentUserData && currentUserData.uid === firebaseUser.uid) {
      return;
    }
    
    // Cargar usuario desde cache o Firestore
    try {
      const db = await initDB();
      const cachedUser = await db.get(STORE_NAMES.USER, 'current_user');
      
      if (cachedUser && cachedUser.uid === firebaseUser.uid) {
        currentUserData = cachedUser;
        notifyAuthListeners(cachedUser);
      }
    } catch (error) {
      console.warn('Error cargando sesión cacheadas:', error);
    }
  });
  
  // Inicializar IndexedDB
  initDB().catch(console.error);
  
  // Limpiar cache expirada al iniciar
  cleanExpiredCache();
  
  console.log('Sistema de autenticación inicializado');
};

// Inicializar al importar
initAuth();

// Exportar instancias para uso avanzado
export { auth, db };
