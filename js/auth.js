/**
 * Sistema de Autenticación y Gestión de Usuarios
 * Responsabilidad exacta: Gestionar autenticación, usuarios, roles y permisos del sistema.
 * Arquitectura: Firebase Auth + Firestore + IndexedDB (offline)
 */

// Instancias globales de Firebase (usando SDK compat del CDN)
const auth = firebase.auth();
const db = firebase.firestore();

// Configuración de IndexedDB
const AUTH_DB_NAME = 'auth_offline_db';
const AUTH_DB_VERSION = 3;
const STORES = {
    USER: 'user_data',
    ROLES: 'roles_cache',
    OFFLINE_OPS: 'offline_operations',
    LOCALS: 'locals_cache'
};

// Estado global
let currentUserData = null;
let authStateListeners = [];
let sessionTimer = null;
let userSnapshotUnsubscribe = null;
let connectionListener = null;

/**
 * Inicializar IndexedDB para cache offline de autenticación
 */
async function initAuthDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(AUTH_DB_NAME, AUTH_DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // Store para datos de usuario completo
            if (!db.objectStoreNames.contains(STORES.USER)) {
                const userStore = db.createObjectStore(STORES.USER, { keyPath: 'uid' });
                userStore.createIndex('email', 'email', { unique: false });
                userStore.createIndex('lastLogin', 'lastLogin', { unique: false });
            }
            
            // Store para cache de roles (expira en 24h)
            if (!db.objectStoreNames.contains(STORES.ROLES)) {
                const rolesStore = db.createObjectStore(STORES.ROLES, { keyPath: 'userId' });
                rolesStore.createIndex('expiresAt', 'expiresAt', { unique: false });
            }
            
            // Store para operaciones offline pendientes
            if (!db.objectStoreNames.contains(STORES.OFFLINE_OPS)) {
                const opsStore = db.createObjectStore(STORES.OFFLINE_OPS, { 
                    keyPath: 'id',
                    autoIncrement: true 
                });
                opsStore.createIndex('type', 'type', { unique: false });
                opsStore.createIndex('status', 'status', { unique: false });
                opsStore.createIndex('createdAt', 'createdAt', { unique: false });
            }
            
            // Store para cache de locales
            if (!db.objectStoreNames.contains(STORES.LOCALS)) {
                const localsStore = db.createObjectStore(STORES.LOCALS, { keyPath: 'id' });
                localsStore.createIndex('name', 'name', { unique: false });
            }
        };
    });
}

/**
 * Limpiar cache expirada (roles mayores a 24h)
 */
async function cleanExpiredCache() {
    try {
        const db = await initAuthDB();
        const transaction = db.transaction(STORES.ROLES, 'readwrite');
        const store = transaction.objectStore(STORES.ROLES);
        const index = store.index('expiresAt');
        
        const expiredRange = IDBKeyRange.upperBound(Date.now());
        const expired = await index.getAllKeys(expiredRange);
        
        for (const key of expired) {
            await store.delete(key);
        }
        
        await transaction.complete;
    } catch (error) {
        console.warn('Error limpiando cache expirada:', error);
    }
}

/**
 * Validar estructura de datos de usuario
 */
function validateUserData(userData) {
    if (!userData) throw new Error('Datos de usuario requeridos');
    
    const requiredFields = ['uid', 'email', 'name', 'roles', 'activeLocal', 'activeTurn'];
    const missingFields = [];
    
    for (const field of requiredFields) {
        if (!userData[field]) {
            missingFields.push(field);
        }
    }
    
    if (missingFields.length > 0) {
        throw new Error(`Campos requeridos faltantes: ${missingFields.join(', ')}`);
    }
    
    // Validar roles
    if (typeof userData.roles !== 'object' || Array.isArray(userData.roles)) {
        throw new Error('Roles debe ser un objeto mapa');
    }
    
    // Validar que el local activo exista en los roles
    if (!userData.roles[userData.activeLocal]) {
        throw new Error('Local activo no encontrado en roles del usuario');
    }
    
    // Validar turno
    const validTurns = ['mañana', 'tarde', 'noche'];
    if (!validTurns.includes(userData.activeTurn)) {
        throw new Error(`Turno inválido. Debe ser uno de: ${validTurns.join(', ')}`);
    }
    
    return true;
}

/**
 * Login completo con validación de local y turno
 * @param {string} email - Email del usuario
 * @param {string} password - Contraseña
 * @param {string} localId - ID del local seleccionado
 * @param {string} turno - Turno seleccionado
 * @returns {Promise<Object>} Datos del usuario autenticado
 */
export async function loginUser(email, password, localId, turno) {
    try {
        console.log('🔐 Iniciando login:', { email, localId, turno });
        
        // Validaciones iniciales
        if (!email || !password) {
            throw new Error('Email y contraseña son requeridos');
        }
        
        if (!localId || !turno) {
            throw new Error('Debe seleccionar un local y turno');
        }
        
        // 1. Autenticación con Firebase Auth
        console.log('1. Autenticando con Firebase Auth...');
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        const user = userCredential.user;
        
        console.log('✅ Auth exitoso, obteniendo datos de usuario...');
        
        // 2. Obtener datos del usuario desde Firestore
        const userDoc = await db.collection('users').doc(user.uid).get();
        
        if (!userDoc.exists) {
            console.warn('❌ Usuario no encontrado en Firestore');
            await auth.signOut();
            throw new Error('Usuario no encontrado en el sistema');
        }
        
        const userData = userDoc.data();
        console.log('📋 Datos de usuario obtenidos:', { name: userData.name, roles: Object.keys(userData.roles || {}) });
        
        // 3. Validar local y turno
        if (!userData.roles || !userData.roles[localId]) {
            throw new Error('Usuario no tiene permisos para este local');
        }
        
        const validTurns = ['mañana', 'tarde', 'noche'];
        if (!validTurns.includes(turno)) {
            throw new Error('Turno inválido');
        }
        
        // 4. Obtener token y construir objeto completo
        const token = await user.getIdToken();
        
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
            token,
            tokenExpiration: Date.now() + 3600000, // 1 hora
            isOnline: true
        };
        
        validateUserData(completeUserData);
        console.log('✅ Datos de usuario validados correctamente');
        
        // 5. Cachear en IndexedDB
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.USER, 'readwrite');
        await transaction.objectStore(STORES.USER).put(completeUserData);
        await transaction.complete;
        console.log('💾 Datos guardados en IndexedDB');
        
        // 6. Cachear roles por 24 horas
        const rolesTransaction = idb.transaction(STORES.ROLES, 'readwrite');
        const rolesCache = {
            userId: user.uid,
            roles: userData.roles,
            cachedAt: Date.now(),
            expiresAt: Date.now() + (24 * 60 * 60 * 1000)
        };
        await rolesTransaction.objectStore(STORES.ROLES).put(rolesCache);
        await rolesTransaction.complete;
        
        // 7. Configurar listener para cambios del usuario
        setupUserSnapshotListener(user.uid);
        
        // 8. Configurar validación periódica de sesión
        setupSessionValidation();
        
        // 9. Configurar listener de conexión
        setupConnectionListener();
        
        // 10. Actualizar estado global y notificar listeners
        currentUserData = completeUserData;
        notifyAuthListeners(completeUserData);
        
        console.log('🎉 Login completado exitosamente');
        return completeUserData;
        
    } catch (error) {
        console.error('❌ Error en login:', error);
        
        // Intentar login offline si es error de red
        if (error.code === 'auth/network-request-failed' || !navigator.onLine) {
            console.log('🌐 Intentando login offline...');
            return await attemptOfflineLogin(email, localId, turno);
        }
        
        // Traducir errores de Firebase
        const errorMessages = {
            'auth/invalid-credential': 'Credenciales inválidas',
            'auth/user-not-found': 'Usuario no encontrado',
            'auth/wrong-password': 'Contraseña incorrecta',
            'auth/too-many-requests': 'Demasiados intentos. Intente más tarde',
            'auth/user-disabled': 'Usuario deshabilitado',
            'auth/invalid-email': 'Email inválido'
        };
        
        throw new Error(errorMessages[error.code] || error.message || 'Error al iniciar sesión');
    }
}

/**
 * Intento de login offline con credenciales cacheadas
 */
async function attemptOfflineLogin(email, localId, turno) {
    try {
        console.log('📴 Intentando login offline...');
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.USER, 'readonly');
        const store = transaction.objectStore(STORES.USER);
        const cachedUser = await store.get(email); // Buscar por email
        
        if (!cachedUser || cachedUser.email !== email) {
            throw new Error('No hay credenciales cacheadas disponibles');
        }
        
        // Validar que el local y turno coincidan
        if (cachedUser.activeLocal !== localId || cachedUser.activeTurn !== turno) {
            throw new Error('Local o turno no coinciden con la última sesión');
        }
        
        // Verificar que la caché no sea muy vieja (máximo 7 días)
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        if (cachedUser.loginTimestamp && cachedUser.loginTimestamp < sevenDaysAgo) {
            throw new Error('La sesión cacheadas ha expirado');
        }
        
        // Marcar como sesión offline
        cachedUser.isOffline = true;
        cachedUser.offlineSince = Date.now();
        cachedUser.lastLogin = new Date().toISOString();
        
        // Guardar como nueva sesión offline
        const writeTransaction = idb.transaction(STORES.USER, 'readwrite');
        await writeTransaction.objectStore(STORES.USER).put(cachedUser);
        await writeTransaction.complete;
        
        // Registrar operación offline para sincronización
        await queueOfflineOperation('offline_login', {
            userId: cachedUser.uid,
            email: cachedUser.email,
            localId,
            turno,
            timestamp: Date.now()
        });
        
        currentUserData = cachedUser;
        notifyAuthListeners(cachedUser);
        
        console.log('✅ Login offline exitoso');
        return cachedUser;
        
    } catch (error) {
        console.error('❌ Error en login offline:', error);
        throw new Error('No se puede conectar y no hay sesión offline disponible');
    }
}

/**
 * Cerrar sesión limpiando todos los datos
 */
export async function logoutUser() {
    try {
        console.log('🚪 Cerrando sesión...');
        
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
        await auth.signOut();
        console.log('✅ Sesión cerrada en Firebase');
        
        // 3. Limpiar cache local (dejar roles para futuros logins)
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.USER, 'readwrite');
        await transaction.objectStore(STORES.USER).clear();
        await transaction.complete;
        console.log('🧹 Cache local limpiada');
        
        // 4. Limpiar estado global
        currentUserData = null;
        
        // 5. Notificar listeners
        notifyAuthListeners(null);
        
        console.log('🎯 Sesión cerrada completamente');
        return true;
        
    } catch (error) {
        console.error('❌ Error en logout:', error);
        throw new Error('Error al cerrar sesión');
    }
}

/**
 * Obtener usuario actual con datos completos
 * @returns {Promise<Object|null>} Datos del usuario o null si no hay sesión
 */
export async function getCurrentUser() {
    // Si ya tenemos los datos en memoria, retornarlos
    if (currentUserData) {
        // Verificar si el token sigue vigente (si no es sesión offline)
        if (!currentUserData.isOffline && currentUserData.tokenExpiration) {
            if (currentUserData.tokenExpiration < Date.now()) {
                console.warn('Token expirado, cerrando sesión...');
                await logoutUser();
                return null;
            }
        }
        return currentUserData;
    }
    
    // Intentar cargar desde cache
    try {
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.USER, 'readonly');
        const store = transaction.objectStore(STORES.USER);
        const cachedUsers = await store.getAll();
        
        if (cachedUsers.length > 0) {
            const cachedUser = cachedUsers[0]; // Último usuario
            
            // Verificar que la caché no sea muy vieja (máximo 7 días)
            const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
            if (cachedUser.loginTimestamp && cachedUser.loginTimestamp > sevenDaysAgo) {
                currentUserData = cachedUser;
                
                // Si es sesión offline, no verificar con Firebase
                if (cachedUser.isOffline) {
                    return cachedUser;
                }
                
                // Verificar con Firebase si hay conexión
                if (navigator.onLine) {
                    try {
                        // Verificar que el usuario aún existe en Firebase
                        const user = auth.currentUser;
                        if (user && user.uid === cachedUser.uid) {
                            // Actualizar token
                            const token = await user.getIdToken(true);
                            cachedUser.token = token;
                            cachedUser.tokenExpiration = Date.now() + 3600000;
                            cachedUser.isOnline = true;
                            cachedUser.isOffline = false;
                            
                            // Actualizar en cache
                            const writeTransaction = idb.transaction(STORES.USER, 'readwrite');
                            await writeTransaction.objectStore(STORES.USER).put(cachedUser);
                            await writeTransaction.complete;
                            
                            currentUserData = cachedUser;
                            return cachedUser;
                        } else {
                            // Usuario no autenticado en Firebase, limpiar cache
                            await logoutUser();
                            return null;
                        }
                    } catch (error) {
                        console.warn('Error verificando sesión con Firebase:', error);
                        // Mantener sesión como offline
                        cachedUser.isOffline = true;
                        return cachedUser;
                    }
                } else {
                    // No hay conexión, mantener sesión offline
                    cachedUser.isOffline = true;
                    return cachedUser;
                }
            } else {
                console.log('Sesión cacheadas expirada, limpiando...');
                await logoutUser();
                return null;
            }
        }
        
        return null;
        
    } catch (error) {
        console.error('Error obteniendo usuario actual:', error);
        return null;
    }
}

/**
 * Actualizar perfil de usuario
 * @param {Object} data - Datos a actualizar
 */
export async function updateUserProfile(data) {
    try {
        console.log('📝 Actualizando perfil de usuario...');
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
        
        // Si estamos online, actualizar en Firestore
        if (navigator.onLine && !user.isOffline) {
            await db.collection('users').doc(user.uid).update(updateData);
            console.log('✅ Perfil actualizado en Firestore');
        }
        
        // Actualizar en cache local
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.USER, 'readwrite');
        const store = transaction.objectStore(STORES.USER);
        const cachedUser = await store.get(user.uid);
        
        if (cachedUser) {
            Object.assign(cachedUser, updateData);
            await store.put(cachedUser);
            await transaction.complete;
            
            currentUserData = cachedUser;
            notifyAuthListeners(cachedUser);
            
            console.log('✅ Perfil actualizado en cache local');
        }
        
        // Si estamos offline, encolar operación
        if (!navigator.onLine || user.isOffline) {
            await queueOfflineOperation('update_profile', {
                userId: user.uid,
                data: updateData,
                timestamp: Date.now()
            });
            console.log('📤 Operación encolada para sincronización');
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Error actualizando perfil:', error);
        
        if (error.code === 'unavailable' || error.code === 'network-request-failed') {
            // Guardar operación para sincronizar después
            try {
                await queueOfflineOperation('update_profile', {
                    userId: currentUserData?.uid,
                    data: data,
                    timestamp: Date.now()
                });
                throw new Error('Cambios guardados localmente. Se sincronizarán cuando haya conexión');
            } catch (queueError) {
                throw new Error('Error guardando cambios localmente');
            }
        }
        
        throw error;
    }
}

/**
 * Verificar si usuario tiene un permiso específico
 * @param {string} permission - Permiso a verificar
 * @returns {Promise<boolean>} True si tiene permiso
 */
export async function checkPermission(permission) {
    try {
        console.log(`🔒 Verificando permiso: ${permission}`);
        const user = await getCurrentUser();
        if (!user) {
            console.log('❌ No hay usuario autenticado');
            return false;
        }
        
        // Obtener roles del local activo
        const localRoles = user.roles[user.activeLocal] || [];
        if (localRoles.length === 0) {
            console.log(`❌ Usuario no tiene roles en local ${user.activeLocal}`);
            return false;
        }
        
        console.log(`👥 Roles del usuario en local activo:`, localRoles);
        
        // Obtener definición de permisos
        const permissionsMap = await getPermissionsMap();
        
        // Verificar si algún rol tiene el permiso
        for (const role of localRoles) {
            const rolePermissions = permissionsMap[role] || [];
            console.log(`📋 Permisos del rol ${role}:`, rolePermissions);
            
            if (rolePermissions.includes(permission)) {
                console.log(`✅ Permiso ${permission} concedido por rol ${role}`);
                
                // Verificaciones específicas por turno
                if (permission.includes('cashbox.close')) {
                    const canClose = canCloseCashRegister(user.activeTurn);
                    console.log(`💰 ¿Puede cerrar caja en turno ${user.activeTurn}? ${canClose}`);
                    return canClose;
                }
                
                if (permission.includes('discount.apply')) {
                    const canDiscount = await canApplyDiscount(role, user.activeLocal);
                    console.log(`🎫 ¿Puede aplicar descuento? ${canDiscount}`);
                    return canDiscount;
                }
                
                return true;
            }
        }
        
        console.log(`❌ Permiso ${permission} no encontrado en ningún rol`);
        return false;
        
    } catch (error) {
        console.error('❌ Error verificando permiso:', error);
        return false;
    }
}

/**
 * Obtener mapa de permisos desde cache o Firestore
 */
async function getPermissionsMap() {
    try {
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.ROLES, 'readonly');
        const store = transaction.objectStore(STORES.ROLES);
        const cachedRoles = await store.get('permissions_map');
        
        // Si hay cache válida (menos de 24 horas), usarla
        if (cachedRoles && cachedRoles.expiresAt > Date.now()) {
            console.log('📚 Usando permisos cacheadas');
            return cachedRoles.data;
        }
        
        // Si no hay conexión, usar cache expirada como fallback
        if (!navigator.onLine) {
            console.warn('🌐 Sin conexión, usando cache expirada de permisos');
            return cachedRoles ? cachedRoles.data : {};
        }
        
        // Obtener desde Firestore
        console.log('🌐 Obteniendo permisos desde Firestore...');
        const rolesSnapshot = await db.collection('roles').get();
        const permissionsMap = {};
        
        rolesSnapshot.forEach(doc => {
            permissionsMap[doc.id] = doc.data().permissions || [];
        });
        
        console.log('✅ Permisos obtenidos de Firestore:', Object.keys(permissionsMap));
        
        // Cachear por 24 horas
        const writeTransaction = idb.transaction(STORES.ROLES, 'readwrite');
        const rolesCache = {
            id: 'permissions_map',
            data: permissionsMap,
            cachedAt: Date.now(),
            expiresAt: Date.now() + (24 * 60 * 60 * 1000)
        };
        await writeTransaction.objectStore(STORES.ROLES).put(rolesCache);
        await writeTransaction.complete;
        
        console.log('💾 Permisos cacheadas por 24 horas');
        return permissionsMap;
        
    } catch (error) {
        console.error('❌ Error obteniendo permisos:', error);
        
        // Intentar desde cache expirada como último recurso
        try {
            const idb = await initAuthDB();
            const transaction = idb.transaction(STORES.ROLES, 'readonly');
            const store = transaction.objectStore(STORES.ROLES);
            const cachedRoles = await store.get('permissions_map');
            return cachedRoles ? cachedRoles.data : {};
        } catch (cacheError) {
            console.error('❌ Error incluso con cache:', cacheError);
            return {};
        }
    }
}

/**
 * Validar si se puede cerrar caja según el turno
 */
function canCloseCashRegister(turno) {
    const horaActual = new Date().getHours();
    let canClose = false;
    
    switch (turno) {
        case 'mañana':
            canClose = horaActual >= 14 && horaActual < 22;
            break;
        case 'tarde':
            canClose = horaActual >= 22 || horaActual < 6;
            break;
        case 'noche':
            canClose = horaActual >= 6 && horaActual < 14;
            break;
        default:
            canClose = false;
    }
    
    console.log(`⏰ Turno: ${turno}, Hora actual: ${horaActual}, ¿Puede cerrar?: ${canClose}`);
    return canClose;
}

/**
 * Validar si puede aplicar descuento según rol y local
 */
async function canApplyDiscount(role, localId) {
    try {
        // Roles que siempre pueden aplicar descuento
        const discountRoles = ['admin', 'manager', 'supervisor'];
        
        if (discountRoles.includes(role)) {
            return true;
        }
        
        // Para vendedores, verificar límites del local
        const localDoc = await db.collection('locals').doc(localId).get();
        if (localDoc.exists) {
            const localData = localDoc.data();
            const discountLimit = localData.discountLimit || 0;
            
            // Si el límite es 0, no puede aplicar descuentos
            return discountLimit > 0;
        }
        
        return false;
    } catch (error) {
        console.error('Error verificando descuentos:', error);
        return false;
    }
}

/**
 * Listar usuarios por local (solo administradores)
 * @param {string} localId - ID del local
 * @returns {Promise<Array>} Lista de usuarios
 */
export async function getUsersByLocal(localId) {
    try {
        console.log(`👥 Obteniendo usuarios del local ${localId}...`);
        
        // Verificar permisos de administrador
        const hasPermission = await checkPermission('admin.users.view');
        if (!hasPermission) {
            throw new Error('Permiso denegado: Se requiere rol de administrador');
        }
        
        // Si estamos offline, intentar desde cache
        if (!navigator.onLine) {
            console.log('📴 Modo offline, buscando usuarios en cache...');
            const idb = await initAuthDB();
            const transaction = idb.transaction(STORES.USER, 'readonly');
            const store = transaction.objectStore(STORES.USER);
            const allUsers = await store.getAll();
            
            return allUsers.filter(user => 
                user.roles && user.roles[localId]
            ).map(user => ({
                uid: user.uid,
                email: user.email,
                name: user.name,
                roles: user.roles[localId] || [],
                lastLogin: user.lastLogin,
                isOnline: false
            }));
        }
        
        // Online: consultar desde Firestore
        const usersRef = db.collection('users');
        const q = usersRef.where(`roles.${localId}`, '!=', null);
        const snapshot = await q.get();
        
        const users = [];
        snapshot.forEach(doc => {
            const userData = doc.data();
            users.push({
                uid: doc.id,
                email: userData.email,
                name: userData.name || 'Sin nombre',
                phone: userData.phone || '',
                roles: userData.roles[localId] || [],
                lastLogin: userData.lastLogin || 'Nunca',
                isActive: userData.isActive !== false,
                isOnline: !userData.isOffline
            });
        });
        
        console.log(`✅ ${users.length} usuarios encontrados`);
        return users;
        
    } catch (error) {
        console.error('❌ Error obteniendo usuarios por local:', error);
        throw error;
    }
}

/**
 * Crear nuevo usuario (solo administradores)
 * @param {Object} userData - Datos del nuevo usuario
 */
export async function createUser(userData) {
    try {
        console.log('👤 Creando nuevo usuario...');
        
        // Verificar permisos de administrador
        const hasPermission = await checkPermission('admin.users.create');
        if (!hasPermission) {
            throw new Error('Permiso denegado: Se requiere rol de administrador');
        }
        
        // Validar datos requeridos
        const requiredFields = ['email', 'name', 'password', 'roles'];
        const missingFields = [];
        
        for (const field of requiredFields) {
            if (!userData[field]) {
                missingFields.push(field);
            }
        }
        
        if (missingFields.length > 0) {
            throw new Error(`Campos requeridos faltantes: ${missingFields.join(', ')}`);
        }
        
        // Validar estructura de roles
        if (typeof userData.roles !== 'object') {
            throw new Error('Roles debe ser un objeto con localId como clave');
        }
        
        // Validar que el usuario actual tenga permisos para asignar esos roles
        const currentUser = await getCurrentUser();
        if (!currentUser) throw new Error('No hay usuario autenticado');
        
        // Verificar que el usuario actual tenga permisos de admin en los locales asignados
        for (const localId in userData.roles) {
            const localRoles = currentUser.roles[localId] || [];
            if (!localRoles.includes('admin')) {
                throw new Error(`No tienes permisos de administrador en el local ${localId}`);
            }
        }
        
        console.log('✅ Validaciones pasadas, creando usuario...');
        
        // En un entorno real, esto se haría en un backend seguro
        // Por ahora, simulamos la creación (en producción usar Cloud Functions)
        console.warn('⚠️ En producción, esta operación debe hacerse en backend seguro');
        
        // Simular éxito
        const newUserId = 'user_' + Date.now();
        
        // Si estamos online, guardar en Firestore
        if (navigator.onLine) {
            await db.collection('users').doc(newUserId).set({
                email: userData.email,
                name: userData.name,
                roles: userData.roles,
                phone: userData.phone || '',
                isActive: true,
                createdAt: new Date().toISOString(),
                createdBy: currentUser.uid
            });
            
            console.log('✅ Usuario creado en Firestore');
        } else {
            // Si estamos offline, encolar operación
            await queueOfflineOperation('create_user', {
                userData,
                createdBy: currentUser.uid,
                timestamp: Date.now()
            });
            
            console.log('📤 Creación de usuario encolada para sincronización');
        }
        
        return {
            success: true,
            userId: newUserId,
            message: 'Usuario creado exitosamente'
        };
        
    } catch (error) {
        console.error('❌ Error creando usuario:', error);
        throw error;
    }
}

/**
 * Cambiar contraseña del usuario actual
 * @param {string} newPassword - Nueva contraseña
 */
export async function changeUserPassword(newPassword) {
    try {
        console.log('🔑 Cambiando contraseña...');
        const user = auth.currentUser;
        if (!user) throw new Error('No hay usuario autenticado');
        
        // Validar fortaleza de contraseña
        if (newPassword.length < 8) {
            throw new Error('La contraseña debe tener al menos 8 caracteres');
        }
        
        // Validar que no sea igual a la anterior (simplificado)
        if (newPassword === '********') { // En realidad comparar hash
            throw new Error('La nueva contraseña no puede ser igual a la anterior');
        }
        
        await user.updatePassword(newPassword);
        console.log('✅ Contraseña actualizada en Firebase Auth');
        
        // Registrar cambio en auditoría
        if (navigator.onLine) {
            await db.collection('audit_logs').add({
                type: 'password_change',
                userId: user.uid,
                timestamp: new Date().toISOString(),
                ip: await getClientIP()
            });
        } else {
            await queueOfflineOperation('audit_password_change', {
                userId: user.uid,
                timestamp: Date.now()
            });
        }
        
        return {
            success: true,
            message: 'Contraseña cambiada exitosamente'
        };
        
    } catch (error) {
        console.error('❌ Error cambiando contraseña:', error);
        
        if (error.code === 'auth/requires-recent-login') {
            throw new Error('Debe volver a autenticarse para cambiar la contraseña');
        }
        
        if (error.code === 'auth/weak-password') {
            throw new Error('La contraseña es muy débil. Use al menos 8 caracteres');
        }
        
        throw new Error('Error al cambiar la contraseña');
    }
}

/**
 * Enviar email de recuperación de contraseña
 * @param {string} email - Email del usuario
 */
export async function resetPassword(email) {
    try {
        console.log(`📧 Enviando email de recuperación a ${email}...`);
        
        if (!email) throw new Error('Email es requerido');
        
        // Validar formato de email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new Error('Email inválido');
        }
        
        await auth.sendPasswordResetEmail(email, {
            url: `${window.location.origin}/login`,
            handleCodeInApp: false
        });
        
        console.log('✅ Email de recuperación enviado');
        return {
            success: true,
            message: 'Email de recuperación enviado. Revise su bandeja de entrada.'
        };
        
    } catch (error) {
        console.error('❌ Error enviando email de recuperación:', error);
        
        // Por seguridad, siempre mostrar el mismo mensaje
        if (error.code === 'auth/user-not-found') {
            console.log('⚠️ Usuario no encontrado, pero no revelando por seguridad');
            // Igual retornar éxito para no revelar información
            return {
                success: true,
                message: 'Si el email existe, recibirá un enlace de recuperación'
            };
        }
        
        throw new Error('Error al procesar la solicitud. Intente nuevamente.');
    }
}

/**
 * Validar sesión activa en intervalos
 */
function setupSessionValidation() {
    console.log('⏰ Configurando validación de sesión...');
    
    if (sessionTimer) {
        clearInterval(sessionTimer);
    }
    
    // Validar cada 5 minutos
    sessionTimer = setInterval(async () => {
        try {
            console.log('🔄 Validando sesión...');
            const user = auth.currentUser;
            
            if (!user) {
                console.log('❌ No hay usuario en Firebase Auth, cerrando sesión...');
                await logoutUser();
                return;
            }
            
            // Verificar que los datos en cache coincidan
            const cachedUser = await getCurrentUser();
            if (!cachedUser || cachedUser.uid !== user.uid) {
                console.log('❌ Usuario en cache no coincide, cerrando sesión...');
                await logoutUser();
                return;
            }
            
            // Verificar si el token ha expirado (si no es sesión offline)
            if (!cachedUser.isOffline && cachedUser.tokenExpiration) {
                if (cachedUser.tokenExpiration < Date.now()) {
                    console.log('🔄 Token expirado, renovando...');
                    
                    try {
                        // Intentar renovar el token
                        const newToken = await user.getIdToken(true);
                        cachedUser.token = newToken;
                        cachedUser.tokenExpiration = Date.now() + 3600000;
                        
                        // Actualizar en cache
                        const idb = await initAuthDB();
                        const transaction = idb.transaction(STORES.USER, 'readwrite');
                        await transaction.objectStore(STORES.USER).put(cachedUser);
                        await transaction.complete;
                        
                        currentUserData = cachedUser;
                        console.log('✅ Token renovado exitosamente');
                        
                    } catch (tokenError) {
                        console.error('❌ Error renovando token:', tokenError);
                        await logoutUser();
                        return;
                    }
                }
            }
            
            console.log('✅ Sesión válida');
            
        } catch (error) {
            console.error('❌ Error validando sesión:', error);
            
            // Si hay error de red, mantener sesión offline
            if (error.code !== 'auth/network-request-failed' && !navigator.onLine) {
                console.log('🌐 Error de red, manteniendo sesión offline');
                return;
            }
            
            // Otros errores, cerrar sesión
            try {
                await logoutUser();
            } catch (logoutError) {
                console.error('Error forzando logout:', logoutError);
            }
        }
    }, 5 * 60 * 1000); // 5 minutos
    
    console.log('✅ Validación de sesión configurada');
}

/**
 * Configurar listener para cambios en datos del usuario
 */
function setupUserSnapshotListener(userId) {
    console.log(`👂 Configurando listener para usuario ${userId}...`);
    
    if (userSnapshotUnsubscribe) {
        console.log('🔄 Cancelando listener anterior...');
        userSnapshotUnsubscribe();
    }
    
    // Solo crear listener si hay conexión
    if (navigator.onLine) {
        userSnapshotUnsubscribe = db.collection('users').doc(userId)
            .onSnapshot(async (snapshot) => {
                if (!snapshot.exists) {
                    console.warn('❌ Usuario eliminado en Firestore');
                    await logoutUser();
                    return;
                }
                
                const userData = snapshot.data();
                console.log('📡 Cambios detectados en usuario:', userData);
                
                // Actualizar cache local
                const idb = await initAuthDB();
                const transaction = idb.transaction(STORES.USER, 'readwrite');
                const store = transaction.objectStore(STORES.USER);
                const cachedUser = await store.get(userId);
                
                if (cachedUser) {
                    // Mantener datos de sesión activa
                    const updatedUser = {
                        ...cachedUser,
                        ...userData,
                        activeLocal: cachedUser.activeLocal,
                        activeTurn: cachedUser.activeTurn,
                        lastLogin: cachedUser.lastLogin,
                        token: cachedUser.token,
                        tokenExpiration: cachedUser.tokenExpiration,
                        isOnline: true,
                        isOffline: false
                    };
                    
                    await store.put(updatedUser);
                    await transaction.complete;
                    
                    currentUserData = updatedUser;
                    notifyAuthListeners(updatedUser);
                    
                    console.log('✅ Cache de usuario actualizada');
                }
            }, (error) => {
                console.error('❌ Error en listener de usuario:', error);
                
                // Si es error de permisos, cerrar sesión
                if (error.code === 'permission-denied') {
                    console.log('🔒 Permiso denegado, cerrando sesión...');
                    logoutUser();
                }
                // No desconectar por errores de red
            });
        
        console.log('✅ Listener de usuario configurado');
    }
}

/**
 * Configurar listener de estado de conexión
 */
function setupConnectionListener() {
    console.log('📡 Configurando listener de conexión...');
    
    if (connectionListener) {
        connectionListener();
    }
    
    const handleOnline = async () => {
        console.log('🌐 Conexión restablecida');
        
        // Actualizar estado de usuario
        if (currentUserData) {
            currentUserData.isOnline = true;
            currentUserData.isOffline = false;
            
            // Actualizar en cache
            const idb = await initAuthDB();
            const transaction = idb.transaction(STORES.USER, 'readwrite');
            await transaction.objectStore(STORES.USER).put(currentUserData);
            await transaction.complete;
            
            notifyAuthListeners(currentUserData);
        }
        
        // Reestablecer listener de usuario
        if (currentUserData?.uid) {
            setupUserSnapshotListener(currentUserData.uid);
        }
        
        // Sincronizar operaciones pendientes
        await syncPendingAuthOperations();
    };
    
    const handleOffline = async () => {
        console.log('📴 Sin conexión');
        
        // Actualizar estado de usuario
        if (currentUserData) {
            currentUserData.isOnline = false;
            currentUserData.isOffline = true;
            currentUserData.offlineSince = Date.now();
            
            // Actualizar en cache
            const idb = await initAuthDB();
            const transaction = idb.transaction(STORES.USER, 'readwrite');
            await transaction.objectStore(STORES.USER).put(currentUserData);
            await transaction.complete;
            
            notifyAuthListeners(currentUserData);
        }
        
        // Pausar listener de Firestore
        if (userSnapshotUnsubscribe) {
            userSnapshotUnsubscribe();
            userSnapshotUnsubscribe = null;
        }
    };
    
    // Escuchar eventos
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
    } else {
        handleOnline();
    }
    
    console.log('✅ Listener de conexión configurado');
}

/**
 * Sincronizar operaciones offline pendientes de autenticación
 */
async function syncPendingAuthOperations() {
    try {
        console.log('🔄 Sincronizando operaciones pendientes...');
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.OFFLINE_OPS, 'readwrite');
        const store = transaction.objectStore(STORES.OFFLINE_OPS);
        const index = store.index('status');
        
        const pendingOps = await index.getAll('pending');
        console.log(`📋 ${pendingOps.length} operaciones pendientes encontradas`);
        
        for (const op of pendingOps) {
            try {
                console.log(`🔄 Procesando operación ${op.id} (${op.type})...`);
                
                switch (op.type) {
                    case 'update_profile':
                        if (currentUserData?.uid === op.data.userId) {
                            await db.collection('users').doc(op.data.userId).update(op.data.data);
                            op.status = 'completed';
                            op.syncedAt = Date.now();
                            console.log(`✅ Perfil sincronizado para usuario ${op.data.userId}`);
                        }
                        break;
                        
                    case 'create_user':
                        // En producción, esto se haría en backend seguro
                        console.warn('⚠️ Creación de usuario requiere backend seguro');
                        op.status = 'completed';
                        op.syncedAt = Date.now();
                        break;
                        
                    case 'offline_login':
                        // Registrar login offline en auditoría
                        await db.collection('audit_logs').add({
                            type: 'offline_login',
                            userId: op.data.userId,
                            email: op.data.email,
                            localId: op.data.localId,
                            turno: op.data.turno,
                            timestamp: new Date(op.data.timestamp).toISOString(),
                            syncedAt: new Date().toISOString(),
                            ip: await getClientIP()
                        });
                        op.status = 'completed';
                        op.syncedAt = Date.now();
                        console.log(`✅ Login offline auditado para ${op.data.email}`);
                        break;
                        
                    case 'audit_password_change':
                        await db.collection('audit_logs').add({
                            type: 'password_change',
                            userId: op.data.userId,
                            timestamp: new Date(op.data.timestamp).toISOString(),
                            syncedAt: new Date().toISOString(),
                            ip: await getClientIP()
                        });
                        op.status = 'completed';
                        op.syncedAt = Date.now();
                        console.log(`✅ Cambio de contraseña auditado`);
                        break;
                }
                
                await store.put(op);
                
            } catch (error) {
                console.error(`❌ Error sincronizando operación ${op.id}:`, error);
                op.status = 'failed';
                op.error = error.message;
                op.retryCount = (op.retryCount || 0) + 1;
                await store.put(op);
            }
        }
        
        await transaction.complete;
        
        // Limpiar operaciones completadas (más de 7 días)
        setTimeout(async () => {
            try {
                const cleanTransaction = idb.transaction(STORES.OFFLINE_OPS, 'readwrite');
                const cleanStore = cleanTransaction.objectStore(STORES.OFFLINE_OPS);
                const dateIndex = cleanStore.index('createdAt');
                
                const weekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
                const oldRange = IDBKeyRange.upperBound(weekAgo);
                const oldOps = await dateIndex.getAllKeys(oldRange);
                
                for (const key of oldOps) {
                    await cleanStore.delete(key);
                }
                
                await cleanTransaction.complete;
                console.log(`🧹 ${oldOps.length} operaciones antiguas limpiadas`);
            } catch (cleanError) {
                console.warn('Error limpiando operaciones antiguas:', cleanError);
            }
        }, 1000);
        
        console.log('✅ Sincronización completada');
        
    } catch (error) {
        console.error('❌ Error en sincronización:', error);
    }
}

/**
 * Encolar operación offline
 */
async function queueOfflineOperation(type, data) {
    try {
        const idb = await initAuthDB();
        const transaction = idb.transaction(STORES.OFFLINE_OPS, 'readwrite');
        const store = transaction.objectStore(STORES.OFFLINE_OPS);
        
        const operation = {
            type,
            data,
            status: 'pending',
            createdAt: Date.now(),
            userId: currentUserData?.uid
        };
        
        await store.add(operation);
        await transaction.complete;
        
        console.log(`📤 Operación ${type} encolada`);
        return true;
        
    } catch (error) {
        console.error('❌ Error encolando operación:', error);
        throw error;
    }
}

/**
 * Obtener IP del cliente (simplificado)
 */
async function getClientIP() {
    try {
        // En un entorno real, esto vendría de tu backend
        // Por ahora, usar un servicio público (con limitaciones)
        if (navigator.onLine) {
            const response = await fetch('https://api.ipify.org?format=json');
            const data = await response.json();
            return data.ip;
        }
        return 'offline';
    } catch (error) {
        console.warn('No se pudo obtener IP:', error);
        return 'unknown';
    }
}

/**
 * Sistema de listeners para cambios de autenticación
 */
export function onAuthStateChange(callback) {
    console.log('👂 Registrando listener de autenticación');
    authStateListeners.push(callback);
    
    // Llamar inmediatamente con estado actual
    if (currentUserData) {
        setTimeout(() => callback(currentUserData), 0);
    } else {
        setTimeout(() => callback(null), 0);
    }
    
    // Retornar función para remover listener
    return () => {
        const index = authStateListeners.indexOf(callback);
        if (index > -1) {
            authStateListeners.splice(index, 1);
        }
    };
}

/**
 * Notificar a todos los listeners
 */
function notifyAuthListeners(userData) {
    console.log(`📢 Notificando a ${authStateListeners.length} listeners`);
    authStateListeners.forEach(callback => {
        try {
            callback(userData);
        } catch (error) {
            console.error('❌ Error en auth listener:', error);
        }
    });
}

/**
 * Validar sesión activa (para uso externo)
 */
export async function validateSession() {
    try {
        const user = await getCurrentUser();
        
        if (!user) {
            console.log('❌ No hay sesión activa');
            return false;
        }
        
        // Verificar expiración del token
        if (user.tokenExpiration && user.tokenExpiration < Date.now()) {
            console.log('⌛ Token expirado');
            return false;
        }
        
        // Verificar que no haya pasado más de 12 horas desde el login
        const twelveHoursAgo = Date.now() - (12 * 60 * 60 * 1000);
        if (user.loginTimestamp && user.loginTimestamp < twelveHoursAgo) {
            console.log('⏰ Sesión expirada (más de 12 horas)');
            return false;
        }
        
        // Si es sesión offline, verificar que no sea muy vieja
        if (user.isOffline) {
            const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
            if (user.loginTimestamp && user.loginTimestamp < threeDaysAgo) {
                console.log('📴 Sesión offline muy antigua');
                return false;
            }
        }
        
        console.log('✅ Sesión válida');
        return true;
        
    } catch (error) {
        console.error('❌ Error validando sesión:', error);
        return false;
    }
}

/**
 * Inicializar sistema de autenticación
 */
export async function initAuth() {
    console.log('🚀 Inicializando sistema de autenticación...');
    
    try {
        // Inicializar IndexedDB
        await initAuthDB();
        console.log('✅ IndexedDB inicializado');
        
        // Limpiar cache expirada
        await cleanExpiredCache();
        console.log('✅ Cache expirada limpiada');
        
        // Configurar listener de Firebase Auth
        auth.onAuthStateChanged(async (firebaseUser) => {
            console.log('🔄 Estado de autenticación cambiado:', firebaseUser?.email);
            
            if (!firebaseUser) {
                // Usuario cerró sesión en Firebase
                if (currentUserData) {
                    console.log('👋 Usuario cerró sesión en Firebase');
                    await logoutUser();
                }
                return;
            }
            
            // Usuario autenticado en Firebase
            if (!currentUserData || currentUserData.uid !== firebaseUser.uid) {
                console.log('🆕 Usuario autenticado en Firebase, cargando datos...');
                
                try {
                    const idb = await initAuthDB();
                    const transaction = idb.transaction(STORES.USER, 'readonly');
                    const store = transaction.objectStore(STORES.USER);
                    const cachedUsers = await store.getAll();
                    
                    const cachedUser = cachedUsers.find(u => u.uid === firebaseUser.uid);
                    
                    if (cachedUser) {
                        currentUserData = cachedUser;
                        notifyAuthListeners(cachedUser);
                        console.log('✅ Usuario cargado desde cache');
                    } else {
                        console.log('ℹ️ Usuario no encontrado en cache');
                    }
                } catch (error) {
                    console.error('Error cargando usuario desde cache:', error);
                }
            }
        });
        
        // Configurar manejo de errores de Firebase Auth
        auth.onIdTokenChanged((user) => {
            if (user) {
                console.log('✅ Token de autenticación válido');
            }
        });
        
        console.log('🎉 Sistema de autenticación inicializado correctamente');
        
    } catch (error) {
        console.error('❌ Error inicializando autenticación:', error);
        throw error;
    }
}

// Inicializar automáticamente al cargar
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuth);
} else {
    initAuth();
}

// Exportar instancias de Firebase para uso en otros módulos
export { auth, db };
