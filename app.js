// ============================================
// SISTEMA POS - APP.JS - VERSIÓN COMPLETA Y CORREGIDA
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '2.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 8,
    SYNC_INTERVAL: 15000,
    MAX_OFFLINE_OPERATIONS: 500,
    STOCK_ALERT_THRESHOLD: 0.2
};

// Estado global de la aplicación
const APP_STATE = {
    supabase: null,
    currentUser: null,
    currentLocal: null,
    currentCaja: null,
    currentTurno: null,
    isOnline: navigator.onLine,
    syncQueue: [],
    isSyncing: false,
    carrito: [],
    currentPage: 'pos',
    scannerActive: false,
    scannerCode: null,
    currentCliente: null,
    ventasHoy: 0,
    presupuestosPendientes: 0,
    stockAlerts: 0
};

// Base de datos IndexedDB
let db;

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Inicializando Sistema POS...');
    
    // Cargar estado guardado
    loadAppState();
    
    // Inicializar IndexedDB
    await initIndexedDB();
    
    // Configurar Supabase
    await initSupabase();
    
    // Configurar eventos
    setupEventListeners();
    setupNetworkListeners();
    
    // Verificar sesión
    checkSession();
    
    // Iniciar sincronización periódica
    setInterval(syncOfflineOperations, CONFIG.SYNC_INTERVAL);
    
    // Iniciar Realtime subscriptions
    setTimeout(setupRealtimeSubscriptions, 2000);
    
    // Cargar alertas de stock
    setTimeout(loadStockAlerts, 3000);
    
    console.log('✅ Sistema inicializado');
});

// ============================================
// BASE DE DATOS OFFLINE (IndexedDB) - MEJORADA
// ============================================

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = (event) => {
            console.error('❌ Error abriendo IndexedDB:', event.target.error);
            reject(event.target.error);
        };
        
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('✅ IndexedDB inicializada - Versión:', db.version);
            
            // Verificar si necesitamos actualizar
            db.onversionchange = () => {
                db.close();
                console.log('🔄 Nueva versión disponible. Recargando...');
                window.location.reload();
            };
            
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            console.log('🔄 Actualizando IndexedDB a versión:', event.newVersion);
            setupObjectStores(db);
        };
    });
}

function setupObjectStores(db) {
    // Eliminar stores antiguos si existen
    const storesToDelete = ['old_store1', 'old_store2']; // Agregar nombres de stores antiguos si es necesario
    storesToDelete.forEach(storeName => {
        if (db.objectStoreNames.contains(storeName)) {
            db.deleteObjectStore(storeName);
        }
    });
    
    const objectStores = [
        {
            name: 'operaciones_pendientes',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'type', keyPath: 'type', unique: false },
                { name: 'status', keyPath: 'status', unique: false },
                { name: 'timestamp', keyPath: 'timestamp', unique: false },
                { name: 'priority', keyPath: 'priority', unique: false },
                { name: 'created_at', keyPath: 'created_at', unique: false }
            ]
        },
        {
            name: 'productos_cache',
            keyPath: 'id',
            indexes: [
                { name: 'codigo_barras', keyPath: 'codigo_barras', unique: true },
                { name: 'codigo_interno', keyPath: 'codigo_interno', unique: true },
                { name: 'categoria', keyPath: 'categoria', unique: false },
                { name: 'stock', keyPath: 'stock', unique: false },
                { name: 'updated_at', keyPath: 'updated_at', unique: false },
                { name: 'activo', keyPath: 'activo', unique: false },
                { name: 'sync_status', keyPath: 'sync_status', unique: false }
            ]
        },
        {
            name: 'clientes_cache',
            keyPath: 'id',
            indexes: [
                { name: 'dni', keyPath: 'numero_documento', unique: true },
                { name: 'nombre', keyPath: 'nombre', unique: false },
                { name: 'apellido', keyPath: 'apellido', unique: false },
                { name: 'saldo', keyPath: 'saldo', unique: false },
                { name: 'tipo_cliente', keyPath: 'tipo_cliente', unique: false },
                { name: 'sync_status', keyPath: 'sync_status', unique: false }
            ]
        },
        {
            name: 'ventas_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'created_at', keyPath: 'created_at', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'local_id', keyPath: 'local_id', unique: false },
                { name: 'numero_venta', keyPath: 'numero_venta', unique: true }
            ]
        },
        {
            name: 'presupuestos_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'valido_hasta', keyPath: 'valido_hasta', unique: false },
                { name: 'cliente_id', keyPath: 'cliente_id', unique: false }
            ]
        },
        {
            name: 'configuracion',
            keyPath: 'key',
            indexes: [
                { name: 'categoria', keyPath: 'categoria', unique: false }
            ]
        },
        {
            name: 'cierres_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'fecha', keyPath: 'fecha', unique: false },
                { name: 'local_id', keyPath: 'local_id', unique: false },
                { name: 'caja_id', keyPath: 'caja_id', unique: false }
            ]
        },
        {
            name: 'movimientos_inventario',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'producto_id', keyPath: 'producto_id', unique: false },
                { name: 'tipo_movimiento', keyPath: 'tipo_movimiento', unique: false },
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'created_at', keyPath: 'created_at', unique: false }
            ]
        },
        {
            name: 'proveedores_cache',
            keyPath: 'id',
            indexes: [
                { name: 'nombre', keyPath: 'nombre', unique: false },
                { name: 'cuit', keyPath: 'cuit', unique: true },
                { name: 'sync_status', keyPath: 'sync_status', unique: false }
            ]
        },
        {
            name: 'categorias_cache',
            keyPath: 'id',
            indexes: [
                { name: 'nombre', keyPath: 'nombre', unique: true },
                { name: 'activo', keyPath: 'activo', unique: false }
            ]
        },
        {
            name: 'promociones_cache',
            keyPath: 'id',
            indexes: [
                { name: 'activo', keyPath: 'activo', unique: false },
                { name: 'tipo', keyPath: 'tipo', unique: false },
                { name: 'fecha_inicio', keyPath: 'fecha_inicio', unique: false },
                { name: 'fecha_fin', keyPath: 'fecha_fin', unique: false }
            ]
        },
        {
            name: 'descuentos_cache',
            keyPath: 'id',
            indexes: [
                { name: 'codigo', keyPath: 'codigo', unique: true },
                { name: 'activo', keyPath: 'activo', unique: false },
                { name: 'tipo', keyPath: 'tipo', unique: false }
            ]
        },
        {
            name: 'historial_precios',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'producto_id', keyPath: 'producto_id', unique: false },
                { name: 'fecha_cambio', keyPath: 'fecha_cambio', unique: false }
            ]
        },
        {
            name: 'compras_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'proveedor_id', keyPath: 'proveedor_id', unique: false }
            ]
        },
        {
            name: 'impresiones_pendientes',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'tipo', keyPath: 'tipo', unique: false },
                { name: 'status', keyPath: 'status', unique: false }
            ]
        }
    ];
    
    for (const storeConfig of objectStores) {
        if (!db.objectStoreNames.contains(storeConfig.name)) {
            const store = db.createObjectStore(storeConfig.name, {
                keyPath: storeConfig.keyPath,
                autoIncrement: storeConfig.autoIncrement || false
            });
            
            if (storeConfig.indexes) {
                for (const indexConfig of storeConfig.indexes) {
                    try {
                        store.createIndex(indexConfig.name, indexConfig.keyPath, {
                            unique: indexConfig.unique || false
                        });
                    } catch (e) {
                        console.warn(`Error creando índice ${indexConfig.name}:`, e);
                    }
                }
            }
        }
    }
}

function indexedDBOperation(storeName, operation, data = null, options = {}) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const mode = operation === 'get' || operation === 'getAll' || operation === 'count' ? 'readonly' : 'readwrite';
        const transaction = db.transaction([storeName], mode);
        const store = transaction.objectStore(storeName);
        
        let request;
        switch (operation) {
            case 'add':
                request = store.add(data);
                break;
            case 'put':
                request = store.put(data);
                break;
            case 'get':
                request = store.get(data);
                break;
            case 'getAll':
                request = store.getAll(options.keyRange || null, options.limit || null);
                break;
            case 'delete':
                request = store.delete(data);
                break;
            case 'clear':
                request = store.clear();
                break;
            case 'count':
                request = store.count();
                break;
            case 'getByIndex':
                const indexName = data.index;
                const indexValue = data.value;
                const index = store.index(indexName);
                request = index.getAll(indexValue);
                break;
            case 'getAllKeys':
                request = store.getAllKeys();
                break;
            case 'update':
                const key = data.key;
                const updates = data.updates;
                const getRequest = store.get(key);
                getRequest.onsuccess = () => {
                    const item = getRequest.result;
                    if (item) {
                        Object.assign(item, updates);
                        const updateRequest = store.put(item);
                        updateRequest.onsuccess = () => resolve(item);
                        updateRequest.onerror = (e) => reject(e.target.error);
                    } else {
                        reject(new Error('Item no encontrado'));
                    }
                };
                getRequest.onerror = (e) => reject(e.target.error);
                return;
            default:
                reject(new Error(`Operación no soportada: ${operation}`));
                return;
        }
        
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
        
        transaction.oncomplete = () => {
            // Transacción completada
        };
        
        transaction.onerror = (event) => {
            reject(event.target.error);
        };
    });
}

async function savePendingOperation(operation) {
    const op = {
        ...operation,
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        status: 'pending',
        timestamp: new Date().toISOString(),
        attempts: 0,
        priority: operation.priority || 5,
        created_at: new Date().toISOString()
    };
    
    try {
        await indexedDBOperation('operaciones_pendientes', 'add', op);
        APP_STATE.syncQueue.push(op);
        updateSyncStatus();
        return op.id;
    } catch (error) {
        console.error('Error guardando operación pendiente:', error);
        throw error;
    }
}

// ============================================
// INICIALIZACIÓN SUPABASE - MEJORADA
// ============================================

async function initSupabase() {
    try {
        // Intentar cargar desde localStorage
        let supabaseUrl = localStorage.getItem('supabase_url');
        let supabaseKey = localStorage.getItem('supabase_key');
        
        if (!supabaseUrl || !supabaseKey) {
            // Configuración por defecto para desarrollo
            supabaseUrl = 'https://manccbrodsboxtkrgpvm.supabase.co';
            supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1hbmNjYnJvZHNib3h0a3JncHZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDc5MjE2NTQsImV4cCI6MjAyMzQ5NzY1NH0.FlqTfCjxuUqWA2gXvNqEiaQ43rMNX8UqG3l9yHcYJ7k';
            
            localStorage.setItem('supabase_url', supabaseUrl);
            localStorage.setItem('supabase_key', supabaseKey);
        }
        
        // Crear cliente Supabase
        APP_STATE.supabase = window.supabase.createClient(supabaseUrl, supabaseKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            },
            db: {
                schema: 'public'
            },
            realtime: {
                params: {
                    eventsPerSecond: 20
                }
            },
            global: {
                headers: {
                    'x-application-name': 'pos-system-v2'
                }
            }
        });
        
        console.log('✅ Supabase configurado');
        
        // Verificar conexión
        const { data, error } = await APP_STATE.supabase.from('productos').select('count', { count: 'exact', head: true }).limit(1);
        
        if (error) {
            console.warn('⚠️ Error de conexión a Supabase:', error);
            APP_STATE.supabase = null;
        } else {
            console.log('✅ Conexión a Supabase verificada');
        }
        
        // Verificar autenticación existente
        const { data: { session } } = await APP_STATE.supabase.auth.getSession();
        if (session) {
            APP_STATE.currentUser = session.user;
            await loadUserData(session.user.email);
        }
        
    } catch (error) {
        console.warn('⚠️ Error configurando Supabase:', error);
        APP_STATE.supabase = null;
    }
}

// ============================================
// GESTIÓN DE SESIÓN Y USUARIO - COMPLETA
// ============================================

async function checkSession() {
    try {
        // Primero verificar sesión de Supabase si existe
        if (APP_STATE.supabase) {
            const { data: { session } } = await APP_STATE.supabase.auth.getSession();
            if (session) {
                APP_STATE.currentUser = session.user;
                showAppScreen();
                await loadUserSession();
                return;
            }
        }
        
        // Luego verificar sesión offline
        const session = localStorage.getItem('pos_session');
        if (session) {
            try {
                const sessionData = JSON.parse(session);
                if (sessionData.expires > Date.now()) {
                    APP_STATE.currentUser = sessionData.user;
                    showAppScreen();
                    await loadUserSession();
                    return;
                }
                localStorage.removeItem('pos_session');
            } catch (e) {
                console.warn('Error cargando sesión:', e);
            }
        }
        
        showLoginScreen();
    } catch (error) {
        console.error('Error en checkSession:', error);
        showLoginScreen();
    }
}

function loadAppState() {
    try {
        const savedState = localStorage.getItem('app_state');
        if (savedState) {
            const state = JSON.parse(savedState);
            Object.assign(APP_STATE, state);
            
            // Cargar carrito si existe
            if (APP_STATE.carrito && APP_STATE.carrito.length > 0) {
                updateCartDisplay();
            }
        }
    } catch (e) {
        console.warn('Error cargando estado de la app:', e);
    }
}

function saveAppState() {
    try {
        const stateToSave = {
            currentUser: APP_STATE.currentUser,
            currentLocal: APP_STATE.currentLocal,
            currentCaja: APP_STATE.currentCaja,
            currentTurno: APP_STATE.currentTurno,
            currentPage: APP_STATE.currentPage,
            carrito: APP_STATE.carrito,
            ventasHoy: APP_STATE.ventasHoy,
            presupuestosPendientes: APP_STATE.presupuestosPendientes,
            stockAlerts: APP_STATE.stockAlerts
        };
        localStorage.setItem('app_state', JSON.stringify(stateToSave));
    } catch (e) {
        console.warn('Error guardando estado de la app:', e);
    }
}

async function loadUserSession() {
    try {
        if (APP_STATE.currentUser && APP_STATE.currentUser.email) {
            await loadUserData(APP_STATE.currentUser.email);
            await loadInitialData();
        }
    } catch (error) {
        console.warn('Error cargando sesión de usuario:', error);
    }
}

async function loadUserData(email) {
    if (!APP_STATE.supabase || !email) return;
    
    try {
        const { data: usuarioData, error } = await APP_STATE.supabase
            .from('usuarios')
            .select('*')
            .eq('email', email)
            .single();
        
        if (!error && usuarioData) {
            APP_STATE.currentUser = { ...APP_STATE.currentUser, ...usuarioData };
            
            const session = {
                user: APP_STATE.currentUser,
                expires: Date.now() + (8 * 60 * 60 * 1000)
            };
            localStorage.setItem('pos_session', JSON.stringify(session));
            
            // Actualizar UI
            updateUserInfo();
        }
    } catch (error) {
        console.warn('Error cargando datos de usuario:', error);
    }
}

function updateUserInfo() {
    const userInfo = document.getElementById('userInfo');
    if (userInfo && APP_STATE.currentUser) {
        userInfo.innerHTML = `<i class="fas fa-user"></i> ${APP_STATE.currentUser.nombre || APP_STATE.currentUser.email}`;
    }
}

function showLoginScreen() {
    const loginScreen = document.getElementById('loginScreen');
    const appScreen = document.getElementById('appScreen');
    
    if (loginScreen) loginScreen.style.display = 'flex';
    if (appScreen) appScreen.style.display = 'none';
}

function showAppScreen() {
    const loginScreen = document.getElementById('loginScreen');
    const appScreen = document.getElementById('appScreen');
    const initialConfig = document.getElementById('initialConfig');
    const mainApp = document.getElementById('mainApp');
    
    if (loginScreen) loginScreen.style.display = 'none';
    if (appScreen) appScreen.style.display = 'block';
    
    // Verificar si ya tenemos local y caja seleccionados
    const savedLocal = localStorage.getItem('currentLocal');
    const savedCaja = localStorage.getItem('currentCaja');
    const savedTurno = localStorage.getItem('currentTurno');
    
    if (savedLocal && savedCaja && savedTurno) {
        try {
            APP_STATE.currentLocal = JSON.parse(savedLocal);
            APP_STATE.currentCaja = JSON.parse(savedCaja);
            APP_STATE.currentTurno = savedTurno;
        } catch (e) {
            console.warn('Error cargando configuración guardada:', e);
        }
    }
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        if (initialConfig) {
            initialConfig.style.display = 'block';
            loadLocalesYCajas();
        }
        if (mainApp) mainApp.style.display = 'none';
    } else {
        if (initialConfig) initialConfig.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        updateSessionInfo();
        loadInitialData();
    }
}

function updateSessionInfo() {
    const userInfo = document.getElementById('userInfo');
    const localInfo = document.getElementById('localInfo');
    const cajaInfo = document.getElementById('cajaInfo');
    const turnoInfo = document.getElementById('turnoInfo');
    const quickVentas = document.getElementById('quickVentas');
    const quickStock = document.getElementById('quickStock');
    
    if (userInfo) {
        userInfo.innerHTML = `<i class="fas fa-user"></i> ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Sin usuario'}`;
    }
    if (localInfo) {
        localInfo.innerHTML = `<i class="fas fa-store"></i> ${APP_STATE.currentLocal?.nombre || 'Sin local'}`;
    }
    if (cajaInfo) {
        cajaInfo.innerHTML = `<i class="fas fa-cash-register"></i> ${APP_STATE.currentCaja?.numero || 'Sin caja'}`;
    }
    if (turnoInfo) {
        turnoInfo.innerHTML = `<i class="fas fa-clock"></i> ${APP_STATE.currentTurno ? APP_STATE.currentTurno.charAt(0).toUpperCase() + APP_STATE.currentTurno.slice(1) : 'Sin turno'}`;
    }
    if (quickVentas) {
        quickVentas.textContent = APP_STATE.ventasHoy || 0;
    }
    if (quickStock) {
        quickStock.textContent = APP_STATE.stockAlerts || 0;
    }
}

// ============================================
// AUTENTICACIÓN Y SESIÓN DE TRABAJO - COMPLETA
// ============================================

async function handleLogin() {
    const emailInput = document.getElementById('loginEmail');
    const passwordInput = document.getElementById('loginPassword');
    const status = document.getElementById('loginStatus');
    
    if (!emailInput || !passwordInput) return;
    
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    
    if (!email || !password) {
        if (status) status.innerHTML = '<p class="error">❌ Completa todos los campos</p>';
        return;
    }
    
    // Mostrar estado de carga
    if (status) status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
    
    try {
        // Intentar autenticación con Supabase
        if (APP_STATE.supabase) {
            const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
                email: email,
                password: password
            });
            
            if (error) {
                // Si hay error de red, intentar modo offline
                if (error.message.includes('network') || error.message.includes('fetch')) {
                    console.warn('Error de red, intentando modo offline');
                    await handleOfflineLoginWithCredentials(email, password);
                } else {
                    throw error;
                }
            } else {
                // Autenticación exitosa
                APP_STATE.currentUser = data.user;
                
                // Cargar datos adicionales del usuario
                await loadUserData(email);
                
                // Guardar sesión
                const session = {
                    user: APP_STATE.currentUser,
                    expires: Date.now() + (8 * 60 * 60 * 1000)
                };
                localStorage.setItem('pos_session', JSON.stringify(session));
                
                // Mostrar aplicación
                showAppScreen();
                
                if (status) status.innerHTML = '<p class="success">✅ Sesión iniciada</p>';
            }
        } else {
            // Modo offline completo
            await handleOfflineLoginWithCredentials(email, password);
        }
        
    } catch (error) {
        console.error('Error en login:', error);
        if (status) {
            status.innerHTML = `<p class="error">❌ Error: ${error.message || 'Credenciales incorrectas'}</p>`;
        }
    }
}

async function handleOfflineLoginWithCredentials(email, password) {
    // Verificar credenciales offline
    const offlineUsers = await indexedDBOperation('configuracion', 'get', 'offline_users') || { value: [] };
    
    const user = offlineUsers.value.find(u => u.email === email && u.password === password);
    
    if (user || email === 'admin@pos.com' && password === 'admin123') {
        APP_STATE.currentUser = {
            id: 'offline_' + Date.now(),
            email: email,
            nombre: email.split('@')[0],
            rol: 'vendedor',
            local_id: null
        };
        
        const session = {
            user: APP_STATE.currentUser,
            expires: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        
        // Guardar usuario offline si no existe
        if (!user && email !== 'admin@pos.com') {
            const newUser = { email, password, nombre: email.split('@')[0] };
            offlineUsers.value.push(newUser);
            await indexedDBOperation('configuracion', 'put', {
                key: 'offline_users',
                value: offlineUsers.value
            });
        }
        
        showAppScreen();
        return true;
    } else {
        throw new Error('Credenciales incorrectas');
    }
}

function handleOfflineLogin() {
    APP_STATE.currentUser = {
        id: 'offline_' + Date.now(),
        email: 'offline@modo.com',
        nombre: 'Modo Offline',
        rol: 'vendedor',
        local_id: null
    };
    
    const session = {
        user: APP_STATE.currentUser,
        expires: Date.now() + (8 * 60 * 60 * 1000)
    };
    
    localStorage.setItem('pos_session', JSON.stringify(session));
    showAppScreen();
}

function handleLogout() {
    if (APP_STATE.supabase) {
        APP_STATE.supabase.auth.signOut();
    }
    
    localStorage.removeItem('pos_session');
    localStorage.removeItem('currentLocal');
    localStorage.removeItem('currentCaja');
    localStorage.removeItem('currentTurno');
    
    APP_STATE.currentUser = null;
    APP_STATE.currentLocal = null;
    APP_STATE.currentCaja = null;
    APP_STATE.currentTurno = null;
    APP_STATE.carrito = [];
    APP_STATE.ventasHoy = 0;
    APP_STATE.presupuestosPendientes = 0;
    
    showLoginScreen();
}

async function loadLocalesYCajas() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    
    if (!localSelect || !cajaSelect) return;
    
    try {
        // Cargar desde cache primero
        let locales = await indexedDBOperation('configuracion', 'get', 'locales_cache');
        let cajas = await indexedDBOperation('configuracion', 'get', 'cajas_cache');
        
        if (!locales || !cajas || APP_STATE.isOnline) {
            if (APP_STATE.supabase) {
                // Cargar locales desde Supabase
                const { data: localesData, error: errorLocales } = await APP_STATE.supabase
                    .from('locales')
                    .select('*')
                    .eq('activo', true)
                    .order('nombre');
                
                // Cargar cajas desde Supabase
                const { data: cajasData, error: errorCajas } = await APP_STATE.supabase
                    .from('cajas')
                    .select('*')
                    .eq('activo', true)
                    .order('numero');
                
                if (!errorLocales && localesData) {
                    locales = { key: 'locales_cache', value: localesData };
                    await indexedDBOperation('configuracion', 'put', locales);
                }
                
                if (!errorCajas && cajasData) {
                    cajas = { key: 'cajas_cache', value: cajasData };
                    await indexedDBOperation('configuracion', 'put', cajas);
                }
            }
        }
        
        // Llenar select de locales
        localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
        if (locales && locales.value) {
            locales.value.forEach(local => {
                const option = document.createElement('option');
                option.value = local.id;
                option.textContent = `${local.nombre} - ${local.direccion || ''}`;
                option.dataset.data = JSON.stringify(local);
                localSelect.appendChild(option);
            });
        }
        
        // Llenar select de cajas
        cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
        if (cajas && cajas.value) {
            cajas.value.forEach(caja => {
                const option = document.createElement('option');
                option.value = caja.id;
                option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
                option.dataset.data = JSON.stringify(caja);
                cajaSelect.appendChild(option);
            });
        }
        
    } catch (error) {
        console.warn('Error cargando locales y cajas:', error);
        
        // Datos de ejemplo para desarrollo
        if (localSelect.options.length <= 1) {
            const exampleLocal = {
                id: 'local_1',
                nombre: 'Local Principal',
                direccion: 'Av. Ejemplo 123'
            };
            const exampleOption = document.createElement('option');
            exampleOption.value = exampleLocal.id;
            exampleOption.textContent = exampleLocal.nombre;
            exampleOption.dataset.data = JSON.stringify(exampleLocal);
            localSelect.appendChild(exampleOption);
        }
        
        if (cajaSelect.options.length <= 1) {
            const exampleCaja = {
                id: 'caja_1',
                numero: 'Caja 1',
                nombre: 'Caja Principal'
            };
            const exampleOption = document.createElement('option');
            exampleOption.value = exampleCaja.id;
            exampleOption.textContent = exampleCaja.numero;
            exampleOption.dataset.data = JSON.stringify(exampleCaja);
            cajaSelect.appendChild(exampleOption);
        }
    }
}

async function startWorkSession() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    const turnoSelect = document.getElementById('selectTurno');
    const saldoInicial = document.getElementById('saldoInicial');
    
    if (!localSelect || !cajaSelect || !turnoSelect || !saldoInicial) return;
    
    if (!localSelect.value || !cajaSelect.value || !turnoSelect.value) {
        showToast('Completa todos los campos requeridos', 'error');
        return;
    }
    
    const localId = localSelect.value;
    const localData = JSON.parse(localSelect.options[localSelect.selectedIndex].dataset.data);
    const cajaId = cajaSelect.value;
    const cajaData = JSON.parse(cajaSelect.options[cajaSelect.selectedIndex].dataset.data);
    const turno = turnoSelect.value;
    const saldo = parseFloat(saldoInicial.value) || 0;
    
    APP_STATE.currentLocal = { id: localId, ...localData };
    APP_STATE.currentCaja = { id: cajaId, ...cajaData };
    APP_STATE.currentTurno = turno;
    
    localStorage.setItem('currentLocal', JSON.stringify(APP_STATE.currentLocal));
    localStorage.setItem('currentCaja', JSON.stringify(APP_STATE.currentCaja));
    localStorage.setItem('currentTurno', APP_STATE.currentTurno);
    
    updateSessionInfo();
    
    const initialConfig = document.getElementById('initialConfig');
    const mainApp = document.getElementById('mainApp');
    
    if (initialConfig) initialConfig.style.display = 'none';
    if (mainApp) mainApp.style.display = 'block';
    
    await abrirCaja(saldo);
    
    await loadInitialData();
    
    showToast('Sesión de trabajo iniciada correctamente', 'success');
}

async function abrirCaja(saldoInicial) {
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja || !APP_STATE.currentTurno) return;
    
    const cierreData = {
        local_id: APP_STATE.currentLocal.id,
        caja_id: APP_STATE.currentCaja.id,
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        turno: APP_STATE.currentTurno,
        fecha: new Date().toISOString().split('T')[0],
        saldo_inicial: saldoInicial,
        estado: 'abierto',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('cierres_caja')
                .insert([cierreData])
                .select()
                .single();
            
            if (error) throw error;
            
            // Guardar ID del cierre para referencia
            cierreData.id = data.id;
            await indexedDBOperation('configuracion', 'put', {
                key: 'cierre_actual',
                value: cierreData
            });
            
        } else {
            cierreData.offline_id = 'cierre_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            cierreData.sync_status = 'pending';
            await indexedDBOperation('cierres_offline', 'add', cierreData);
            
            await savePendingOperation({
                type: 'cierre_caja',
                action: 'abrir',
                data: cierreData,
                priority: 10
            });
            
            // Guardar referencia local
            await indexedDBOperation('configuracion', 'put', {
                key: 'cierre_actual',
                value: cierreData
            });
        }
        
        console.log('✅ Caja abierta:', cierreData);
        
    } catch (error) {
        console.error('Error abriendo caja:', error);
        showToast('Error al abrir caja', 'error');
    }
}

// ============================================
// CONFIGURACIÓN DE EVENTOS - COMPLETA
// ============================================

function setupEventListeners() {
    // Login
    const loginBtn = document.getElementById('loginBtn');
    const loginOffline = document.getElementById('loginOffline');
    const logoutBtn = document.getElementById('logoutBtn');
    const setupSystem = document.getElementById('setupSystem');
    
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    if (loginOffline) loginOffline.addEventListener('click', handleOfflineLogin);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    if (setupSystem) setupSystem.addEventListener('click', setupSystemHandler);
    
    // Configuración inicial
    const startSession = document.getElementById('startSession');
    const skipConfig = document.getElementById('skipConfig');
    
    if (startSession) startSession.addEventListener('click', startWorkSession);
    if (skipConfig) skipConfig.addEventListener('click', skipConfigHandler);
    
    // Navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const page = e.currentTarget.dataset.page;
            switchPage(page);
        });
    });
    
    // POS - Buscador
    const productSearch = document.getElementById('productSearch');
    const clearSearch = document.getElementById('clearSearch');
    
    if (productSearch) {
        productSearch.addEventListener('input', debounce(handleProductSearch, 300));
        productSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleProductSearchEnter(e);
            }
        });
    }
    
    if (clearSearch) clearSearch.addEventListener('click', () => {
        if (productSearch) productSearch.value = '';
        handleProductSearch({ target: productSearch });
    });
    
    // POS - Scanner
    const scanBarcode = document.getElementById('scanBarcode');
    const keyboardMode = document.getElementById('keyboardMode');
    const stopScanner = document.getElementById('stopScanner');
    
    if (scanBarcode) scanBarcode.addEventListener('click', toggleScanner);
    if (keyboardMode) keyboardMode.addEventListener('click', activateKeyboardMode);
    if (stopScanner) stopScanner.addEventListener('click', stopScanner);
    
    // POS - Carrito
    const finalizarVentaBtn = document.getElementById('finalizarVenta');
    const crearPresupuestoBtn = document.getElementById('crearPresupuesto');
    const cancelarVentaBtn = document.getElementById('cancelarVenta');
    const clearCartBtn = document.getElementById('clearCart');
    const quickSaleBtn = document.getElementById('quickSale');
    const openDrawerBtn = document.getElementById('openDrawer');
    
    if (finalizarVentaBtn) finalizarVentaBtn.addEventListener('click', finalizarVenta);
    if (crearPresupuestoBtn) crearPresupuestoBtn.addEventListener('click', crearPresupuesto);
    if (cancelarVentaBtn) cancelarVentaBtn.addEventListener('click', cancelarVenta);
    if (clearCartBtn) clearCartBtn.addEventListener('click', clearCart);
    if (quickSaleBtn) quickSaleBtn.addEventListener('click', quickSale);
    if (openDrawerBtn) openDrawerBtn.addEventListener('click', openDrawer);
    
    // POS - Descuento
    const cartDiscount = document.getElementById('cartDiscount');
    if (cartDiscount) {
        cartDiscount.addEventListener('input', debounce(updateCartTotal, 300));
        cartDiscount.addEventListener('change', updateCartTotal);
    }
    
    // Cliente select
    const selectCliente = document.getElementById('selectCliente');
    if (selectCliente) {
        selectCliente.addEventListener('change', handleClienteSelectChange);
    }
    
    // Modal de pagos
    document.querySelectorAll('.payment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const method = e.currentTarget.dataset.method;
            selectPaymentMethod(method);
        });
    });
    
    const confirmPayment = document.getElementById('confirmPayment');
    if (confirmPayment) confirmPayment.addEventListener('click', confirmarPago);
    
    // Notificaciones
    const notificationsBtn = document.getElementById('notificationsBtn');
    if (notificationsBtn) notificationsBtn.addEventListener('click', showNotifications);
    
    // Menú rápido
    const quickMenuBtn = document.getElementById('quickMenuBtn');
    if (quickMenuBtn) quickMenuBtn.addEventListener('click', toggleQuickMenu);
}

function setupNetworkListeners() {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
}

function handleOnline() {
    APP_STATE.isOnline = true;
    updateSyncStatus();
    
    showToast('Conexión restablecida. Sincronizando...', 'success');
    
    // Sincronizar operaciones pendientes
    syncOfflineOperations();
    
    // Actualizar datos locales
    setTimeout(() => {
        loadInitialData();
        updateStockAlerts();
    }, 1000);
}

function handleOffline() {
    APP_STATE.isOnline = false;
    updateSyncStatus();
    
    showToast('Modo offline activado', 'warning');
}

function updateSyncStatus() {
    const statusIndicator = document.getElementById('syncStatus');
    if (!statusIndicator) return;
    
    const statusDot = statusIndicator.querySelector('.status-dot');
    const statusText = statusIndicator.querySelector('.status-text');
    
    if (!APP_STATE.isOnline) {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        statusIndicator.title = 'Sin conexión a internet';
    } else if (APP_STATE.isSyncing) {
        statusDot.className = 'status-dot syncing';
        statusText.textContent = 'Sincronizando...';
        statusIndicator.title = 'Sincronizando datos con el servidor';
    } else {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        statusIndicator.title = 'Conectado al servidor';
    }
}

// ============================================
// NAVEGACIÓN Y PÁGINAS - COMPLETA
// ============================================

function switchPage(pageName) {
    // Actualizar botones de navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.page === pageName);
    });
    
    // Actualizar páginas
    document.querySelectorAll('.page').forEach(page => {
        const pageId = `page${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`;
        page.classList.toggle('active', page.id === pageId);
    });
    
    // Actualizar título
    const currentPage = document.getElementById('currentPage');
    if (currentPage) {
        const pageTitles = {
            pos: 'Punto de Venta',
            productos: 'Productos',
            clientes: 'Clientes',
            proveedores: 'Proveedores',
            presupuestos: 'Presupuestos',
            reportes: 'Reportes',
            caja: 'Cierre de Caja',
            configuracion: 'Configuración'
        };
        currentPage.textContent = pageTitles[pageName] || pageName;
    }
    
    APP_STATE.currentPage = pageName;
    saveAppState();
    
    // Cargar datos específicos de la página
    switch(pageName) {
        case 'pos':
            loadProductosParaVenta();
            loadClientesParaVenta();
            updateCartDisplay();
            break;
        case 'productos':
            loadProductos();
            break;
        case 'clientes':
            loadClientes();
            break;
        case 'proveedores':
            loadProveedores();
            break;
        case 'presupuestos':
            loadPresupuestos();
            break;
        case 'reportes':
            loadReportes();
            break;
        case 'caja':
            loadCajaResumen();
            break;
        case 'configuracion':
            loadConfiguracion();
            break;
    }
}

// ============================================
// SINCRONIZACIÓN OFFLINE/SYNC - COMPLETA
// ============================================

async function syncOfflineOperations() {
    if (!APP_STATE.isOnline || APP_STATE.isSyncing || !db) return;
    
    APP_STATE.isSyncing = true;
    updateSyncStatus();
    
    try {
        // Obtener operaciones pendientes ordenadas por prioridad
        const operations = await indexedDBOperation('operaciones_pendientes', 'getAll');
        const pendingOps = operations.filter(op => op.status === 'pending');
        const sortedOps = pendingOps.sort((a, b) => (b.priority || 5) - (a.priority || 5));
        
        let successfulOps = 0;
        let failedOps = 0;
        
        for (const op of sortedOps.slice(0, 50)) { // Limitar a 50 por ciclo
            if (op.attempts >= 5) {
                op.status = 'failed';
                op.last_error = 'Máximo de intentos alcanzado';
                await indexedDBOperation('operaciones_pendientes', 'put', op);
                failedOps++;
                continue;
            }
            
            try {
                let success = false;
                
                switch (op.type) {
                    case 'venta':
                        success = await syncVenta(op.data);
                        break;
                    case 'pago':
                        success = await syncPago(op.data);
                        break;
                    case 'cliente':
                        success = await syncCliente(op.data);
                        break;
                    case 'producto':
                        success = await syncProducto(op.data);
                        break;
                    case 'presupuesto':
                        success = await syncPresupuesto(op.data);
                        break;
                    case 'cierre_caja':
                        success = await syncCierreCaja(op.data);
                        break;
                    case 'movimiento_inventario':
                        success = await syncMovimientoInventario(op.data);
                        break;
                    case 'proveedor':
                        success = await syncProveedor(op.data);
                        break;
                    case 'compra':
                        success = await syncCompra(op.data);
                        break;
                    default:
                        console.warn(`Tipo de operación no reconocido: ${op.type}`);
                        success = false;
                }
                
                if (success) {
                    op.status = 'synced';
                    op.synced_at = new Date().toISOString();
                    successfulOps++;
                    
                    // Eliminar datos offline relacionados si existen
                    if (op.data.offline_id) {
                        switch (op.type) {
                            case 'venta':
                                await indexedDBOperation('ventas_offline', 'delete', op.data.offline_id);
                                break;
                            case 'presupuesto':
                                await indexedDBOperation('presupuestos_offline', 'delete', op.data.offline_id);
                                break;
                            case 'cierre_caja':
                                await indexedDBOperation('cierres_offline', 'delete', op.data.offline_id);
                                break;
                            case 'compra':
                                await indexedDBOperation('compras_offline', 'delete', op.data.offline_id);
                                break;
                        }
                    }
                } else {
                    op.attempts += 1;
                    op.last_error = 'Error en sincronización';
                    failedOps++;
                }
                
                await indexedDBOperation('operaciones_pendientes', 'put', op);
                
            } catch (error) {
                console.error(`❌ Error sincronizando operación ${op.id}:`, error);
                op.attempts += 1;
                op.last_error = error.message;
                await indexedDBOperation('operaciones_pendientes', 'put', op);
                failedOps++;
            }
        }
        
        // Sincronizar caches
        await syncAllCaches();
        
        // Registrar log de sincronización
        if (successfulOps > 0 || failedOps > 0) {
            await saveSyncLog(successfulOps, failedOps);
        }
        
        if (successfulOps > 0) {
            showToast(`✅ ${successfulOps} operaciones sincronizadas`, 'success');
        }
        
        if (failedOps > 0) {
            showToast(`⚠️ ${failedOps} operaciones fallaron`, 'warning');
        }
        
    } catch (error) {
        console.error('❌ Error en sincronización:', error);
        showToast('Error en sincronización', 'error');
    } finally {
        APP_STATE.isSyncing = false;
        updateSyncStatus();
    }
}

async function syncAllCaches() {
    try {
        await Promise.all([
            syncProductosCache(),
            syncClientesCache(),
            syncProveedoresCache(),
            syncCategoriasCache(),
            syncPromocionesCache(),
            syncDescuentosCache()
        ]);
        console.log('✅ Todos los caches sincronizados');
    } catch (error) {
        console.error('❌ Error sincronizando caches:', error);
    }
}

async function saveSyncLog(successful, failed) {
    try {
        const logEntry = {
            dispositivo_id: navigator.userAgent.substring(0, 100),
            usuario_id: APP_STATE.currentUser?.id,
            tipo_operacion: 'sync_batch',
            operaciones_sincronizadas: successful,
            errores: failed > 0 ? `${failed} operaciones fallaron` : null,
            duracion_ms: 0, // Podríamos medir esto
            created_at: new Date().toISOString()
        };
        
        if (APP_STATE.supabase) {
            await APP_STATE.supabase
                .from('sincronizacion_log')
                .insert([logEntry]);
        }
    } catch (error) {
        console.error('Error guardando log de sincronización:', error);
    }
}

async function syncVenta(ventaData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { data: venta, error: errorVenta } = await APP_STATE.supabase
            .from('ventas')
            .insert([ventaData.venta])
            .select()
            .single();
        
        if (errorVenta) {
            // Intentar actualizar si ya existe
            if (errorVenta.code === '23505') { // Violación de unicidad
                const { data: existingVenta } = await APP_STATE.supabase
                    .from('ventas')
                    .select('id')
                    .eq('numero_venta', ventaData.venta.numero_venta)
                    .single();
                
                if (existingVenta) {
                    ventaData.venta.id = existingVenta.id;
                    return await updateExistingVenta(ventaData);
                }
            }
            throw errorVenta;
        }
        
        // Insertar items
        for (const item of ventaData.items) {
            item.venta_id = venta.id;
            const { error: errorItem } = await APP_STATE.supabase
                .from('venta_items')
                .insert([item]);
            
            if (errorItem) {
                console.error('Error insertando item:', errorItem);
                // Continuar con otros items
            }
        }
        
        // Insertar pago si existe
        if (ventaData.pago) {
            ventaData.pago.venta_id = venta.id;
            const { error: errorPago } = await APP_STATE.supabase
                .from('pagos')
                .insert([ventaData.pago]);
            
            if (errorPago) console.error('Error insertando pago:', errorPago);
        }
        
        // Insertar movimientos de inventario
        if (ventaData.movimientos_inventario) {
            for (const movimiento of ventaData.movimientos_inventario) {
                movimiento.venta_id = venta.id;
                const { error: errorMov } = await APP_STATE.supabase
                    .from('inventario')
                    .insert([movimiento]);
                
                if (errorMov) console.error('Error insertando movimiento:', errorMov);
            }
        }
        
        // Actualizar cuenta corriente si aplica
        if (ventaData.cuenta_corriente) {
            ventaData.cuenta_corriente.venta_id = venta.id;
            const { error: errorCC } = await APP_STATE.supabase
                .from('cuentas_corrientes')
                .insert([ventaData.cuenta_corriente]);
            
            if (errorCC) console.error('Error insertando cuenta corriente:', errorCC);
        }
        
        return true;
    } catch (error) {
        console.error('Error sincronizando venta:', error);
        return false;
    }
}

async function updateExistingVenta(ventaData) {
    try {
        // Actualizar venta
        const { error: updateError } = await APP_STATE.supabase
            .from('ventas')
            .update(ventaData.venta)
            .eq('id', ventaData.venta.id);
        
        if (updateError) throw updateError;
        
        return true;
    } catch (error) {
        console.error('Error actualizando venta existente:', error);
        return false;
    }
}

// Funciones de sincronización para otros tipos de datos
async function syncCliente(clienteData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('clientes')
            .insert([clienteData])
            .onConflict('numero_documento')
            .upsert();
        
        return !error;
    } catch (error) {
        console.error('Error sincronizando cliente:', error);
        return false;
    }
}

async function syncProducto(productoData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('productos')
            .insert([productoData])
            .onConflict('codigo_barras')
            .upsert();
        
        return !error;
    } catch (error) {
        console.error('Error sincronizando producto:', error);
        return false;
    }
}

async function syncPresupuesto(presupuestoData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { data: presupuesto, error: errorPresupuesto } = await APP_STATE.supabase
            .from('presupuestos')
            .insert([presupuestoData.presupuesto])
            .select()
            .single();
        
        if (errorPresupuesto) throw errorPresupuesto;
        
        for (const item of presupuestoData.items) {
            item.presupuesto_id = presupuesto.id;
            const { error: errorItem } = await APP_STATE.supabase
                .from('presupuesto_items')
                .insert([item]);
            
            if (errorItem) console.error('Error insertando item de presupuesto:', errorItem);
        }
        
        return true;
    } catch (error) {
        console.error('Error sincronizando presupuesto:', error);
        return false;
    }
}

async function syncCierreCaja(cierreData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('cierres_caja')
            .insert([cierreData])
            .onConflict('id')
            .upsert();
        
        return !error;
    } catch (error) {
        console.error('Error sincronizando cierre de caja:', error);
        return false;
    }
}

async function syncMovimientoInventario(movimientoData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('inventario')
            .insert([movimientoData]);
        
        return !error;
    } catch (error) {
        console.error('Error sincronizando movimiento de inventario:', error);
        return false;
    }
}

async function syncProveedor(proveedorData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('proveedores')
            .insert([proveedorData])
            .onConflict('cuit')
            .upsert();
        
        return !error;
    } catch (error) {
        console.error('Error sincronizando proveedor:', error);
        return false;
    }
}

async function syncCompra(compraData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { data: compra, error: errorCompra } = await APP_STATE.supabase
            .from('compras')
            .insert([compraData.compra])
            .select()
            .single();
        
        if (errorCompra) throw errorCompra;
        
        for (const item of compraData.items) {
            item.compra_id = compra.id;
            const { error: errorItem } = await APP_STATE.supabase
                .from('compra_items')
                .insert([item]);
            
            if (errorItem) console.error('Error insertando item de compra:', errorItem);
        }
        
        return true;
    } catch (error) {
        console.error('Error sincronizando compra:', error);
        return false;
    }
}

// Sincronización de caches
async function syncProductosCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: productos, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .eq('activo', true)
            .order('updated_at', { ascending: false })
            .limit(500);
        
        if (error) throw error;
        
        // Actualizar cache
        for (const producto of productos) {
            await indexedDBOperation('productos_cache', 'put', {
                ...producto,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de productos actualizado: ${productos.length} productos`);
    } catch (error) {
        console.error('❌ Error actualizando cache de productos:', error);
    }
}

async function syncClientesCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: clientes, error } = await APP_STATE.supabase
            .from('clientes')
            .select('*')
            .eq('activo', true)
            .order('updated_at', { ascending: false })
            .limit(500);
        
        if (error) throw error;
        
        for (const cliente of clientes) {
            await indexedDBOperation('clientes_cache', 'put', {
                ...cliente,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de clientes actualizado: ${clientes.length} clientes`);
    } catch (error) {
        console.error('❌ Error actualizando cache de clientes:', error);
    }
}

async function syncProveedoresCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: proveedores, error } = await APP_STATE.supabase
            .from('proveedores')
            .select('*')
            .eq('activo', true)
            .order('nombre')
            .limit(200);
        
        if (error) throw error;
        
        for (const proveedor of proveedores) {
            await indexedDBOperation('proveedores_cache', 'put', {
                ...proveedor,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de proveedores actualizado: ${proveedores.length} proveedores`);
    } catch (error) {
        console.error('❌ Error actualizando cache de proveedores:', error);
    }
}

async function syncCategoriasCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: categorias, error } = await APP_STATE.supabase
            .from('categorias')
            .select('*')
            .eq('activo', true)
            .order('nombre');
        
        if (error) throw error;
        
        for (const categoria of categorias) {
            await indexedDBOperation('categorias_cache', 'put', {
                ...categoria,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de categorías actualizado: ${categorias.length} categorías`);
    } catch (error) {
        console.error('❌ Error actualizando cache de categorías:', error);
    }
}

async function syncPromocionesCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        const { data: promociones, error } = await APP_STATE.supabase
            .from('promociones')
            .select('*')
            .eq('activo', true)
            .lte('fecha_inicio', hoy)
            .gte('fecha_fin', hoy)
            .order('nombre');
        
        if (error) throw error;
        
        for (const promocion of promociones) {
            await indexedDBOperation('promociones_cache', 'put', {
                ...promocion,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de promociones actualizado: ${promociones.length} promociones`);
    } catch (error) {
        console.error('❌ Error actualizando cache de promociones:', error);
    }
}

async function syncDescuentosCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        const { data: descuentos, error } = await APP_STATE.supabase
            .from('descuentos')
            .select('*')
            .eq('activo', true)
            .lte('fecha_inicio', hoy)
            .gte('fecha_fin', hoy)
            .order('codigo');
        
        if (error) throw error;
        
        for (const descuento of descuentos) {
            await indexedDBOperation('descuentos_cache', 'put', {
                ...descuento,
                sync_status: 'synced',
                last_sync_at: new Date().toISOString()
            });
        }
        
        console.log(`✅ Cache de descuentos actualizado: ${descuentos.length} descuentos`);
    } catch (error) {
        console.error('❌ Error actualizando cache de descuentos:', error);
    }
}

// ============================================
// GESTIÓN DE PRODUCTOS - COMPLETA
// ============================================

async function loadInitialData() {
    await Promise.all([
        loadProductosParaVenta(),
        loadClientesParaVenta(),
        loadConfiguraciones(),
        updateStockAlerts(),
        updateVentasHoy()
    ]);
}

async function loadProductosParaVenta() {
    try {
        let productos = [];
        
        // Intentar cargar desde cache
        try {
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        } catch (error) {
            console.warn('Error cargando productos desde cache:', error);
        }
        
        // Si no hay productos en cache y estamos online, sincronizar
        if ((!productos || productos.length === 0) && APP_STATE.isOnline) {
            await syncProductosCache();
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        }
        
        // Si aún no hay productos, generar algunos de ejemplo
        if (!productos || productos.length === 0) {
            productos = generarProductosEjemplo();
            for (const producto of productos) {
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        // Actualizar UI si estamos en POS
        if (APP_STATE.currentPage === 'pos') {
            updateProductosUI(productos);
        }
        
        // Actualizar contador de productos
        const navProductos = document.getElementById('navProductos');
        if (navProductos) {
            navProductos.textContent = productos.length;
        }
        
        return productos;
    } catch (error) {
        console.error('Error cargando productos:', error);
        return [];
    }
}

function updateProductosUI(productos) {
    // Actualizar datalist para búsqueda
    const searchInput = document.getElementById('productSearch');
    if (!searchInput) return;
    
    let datalist = document.getElementById('productosDatalist');
    if (!datalist) {
        datalist = document.createElement('datalist');
        datalist.id = 'productosDatalist';
        searchInput.setAttribute('list', 'productosDatalist');
        document.body.appendChild(datalist);
    }
    
    datalist.innerHTML = '';
    
    // Agregar opciones para búsqueda rápida
    productos.slice(0, 100).forEach(producto => {
        const option = document.createElement('option');
        option.value = producto.codigo_barras || producto.codigo_interno || producto.nombre;
        option.dataset.id = producto.id;
        option.dataset.nombre = producto.nombre;
        option.dataset.precio = producto.precio_venta || 0;
        option.dataset.stock = producto.stock || 0;
        datalist.appendChild(option);
    });
    
    // Actualizar productos sugeridos
    updateSuggestedProducts(productos);
}

function updateSuggestedProducts(productos) {
    const container = document.getElementById('suggestedProducts');
    if (!container) return;
    
    // Filtrar productos destacados o con mayor stock
    const sugeridos = productos
        .filter(p => p.destacado || p.stock > 10)
        .slice(0, 12);
    
    container.innerHTML = '';
    
    if (sugeridos.length === 0) {
        container.innerHTML = '<div class="no-products">No hay productos sugeridos</div>';
        return;
    }
    
    sugeridos.forEach(producto => {
        const card = document.createElement('div');
        card.className = 'product-suggested-card';
        card.dataset.id = producto.id;
        card.innerHTML = `
            <div class="product-suggested-info">
                <h5>${producto.nombre}</h5>
                <p class="product-code">${producto.codigo_barras || producto.codigo_interno || 'Sin código'}</p>
                <p class="product-price">$${(producto.precio_venta || 0).toFixed(2)}</p>
                <p class="product-stock">Stock: ${producto.stock || 0}</p>
            </div>
            <button class="btn-add-to-cart" onclick="agregarAlCarritoDesdeSugerido('${producto.id}')">
                <i class="fas fa-cart-plus"></i>
            </button>
        `;
        
        container.appendChild(card);
    });
}

async function loadProductos() {
    try {
        const productos = await loadProductosParaVenta();
        displayProductos(productos);
    } catch (error) {
        console.error('Error cargando productos:', error);
        showToast('Error cargando productos', 'error');
    }
}

function displayProductos(productos) {
    const container = document.getElementById('productosList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!productos || productos.length === 0) {
        container.innerHTML = '<div class="no-data">No hay productos cargados</div>';
        return;
    }
    
    // Crear tabla de productos
    const table = document.createElement('table');
    table.className = 'productos-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th>Código</th>
                <th>Nombre</th>
                <th>Categoría</th>
                <th>Stock</th>
                <th>Costo</th>
                <th>Venta</th>
                <th>Margen</th>
                <th>Acciones</th>
            </tr>
        </thead>
        <tbody>
        </tbody>
    `;
    
    const tbody = table.querySelector('tbody');
    
    productos.forEach(producto => {
        const precioVenta = producto.precio_venta || producto.precio_costo * (1 + (producto.porcentaje_ganancia || 30) / 100);
        const ganancia = precioVenta - (producto.precio_costo || 0);
        const margen = producto.precio_costo ? ((ganancia / producto.precio_costo) * 100).toFixed(1) : '0';
        const stockClass = producto.stock <= producto.stock_minimo ? 'stock-bajo' : 
                          producto.stock <= (producto.stock_minimo * 2) ? 'stock-critico' : 'stock-normal';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${producto.codigo_barras || producto.codigo_interno || '-'}</td>
            <td>
                <strong>${producto.nombre}</strong>
                ${producto.descripcion ? `<br><small>${producto.descripcion.substring(0, 50)}...</small>` : ''}
            </td>
            <td>${producto.categoria || '-'}</td>
            <td class="${stockClass}">${producto.stock || 0}</td>
            <td>$${(producto.precio_costo || 0).toFixed(2)}</td>
            <td>$${precioVenta.toFixed(2)}</td>
            <td>${margen}%</td>
            <td class="actions">
                <button class="btn btn-sm btn-primary" onclick="editarProducto('${producto.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-success" onclick="agregarAlCarrito('${producto.id}')">
                    <i class="fas fa-cart-plus"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="eliminarProducto('${producto.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        tbody.appendChild(row);
    });
    
    container.appendChild(table);
}

async function editarProducto(productoId) {
    try {
        const producto = await indexedDBOperation('productos_cache', 'get', productoId);
        
        if (!producto) {
            showToast('Producto no encontrado', 'error');
            return;
        }
        
        // Mostrar modal de edición
        showProductoModal(producto);
    } catch (error) {
        console.error('Error editando producto:', error);
        showToast('Error al editar producto', 'error');
    }
}

function showProductoModal(producto = null) {
    const modal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (!modal || !modalTitle || !modalBody) return;
    
    const isNew = !producto;
    
    modalTitle.textContent = isNew ? 'Nuevo Producto' : 'Editar Producto';
    
    modalBody.innerHTML = `
        <form id="productoForm" class="form-modal">
            <div class="form-group">
                <label for="productoCodigoBarras">Código de Barras:</label>
                <input type="text" id="productoCodigoBarras" class="form-control" 
                       value="${producto?.codigo_barras || ''}" placeholder="Opcional">
            </div>
            <div class="form-group">
                <label for="productoCodigoInterno">Código Interno:</label>
                <input type="text" id="productoCodigoInterno" class="form-control" 
                       value="${producto?.codigo_interno || ''}" required>
            </div>
            <div class="form-group">
                <label for="productoNombre">Nombre:</label>
                <input type="text" id="productoNombre" class="form-control" 
                       value="${producto?.nombre || ''}" required>
            </div>
            <div class="form-group">
                <label for="productoDescripcion">Descripción:</label>
                <textarea id="productoDescripcion" class="form-control" rows="3">${producto?.descripcion || ''}</textarea>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="productoCategoria">Categoría:</label>
                    <input type="text" id="productoCategoria" class="form-control" 
                           value="${producto?.categoria || ''}" list="categoriasList" required>
                    <datalist id="categoriasList"></datalist>
                </div>
                <div class="form-group">
                    <label for="productoMarca">Marca:</label>
                    <input type="text" id="productoMarca" class="form-control" 
                           value="${producto?.marca || ''}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="productoPrecioCosto">Precio Costo:</label>
                    <input type="number" id="productoPrecioCosto" class="form-control" 
                           value="${producto?.precio_costo || 0}" step="0.01" min="0" required>
                </div>
                <div class="form-group">
                    <label for="productoPorcentajeGanancia">% Ganancia:</label>
                    <input type="number" id="productoPorcentajeGanancia" class="form-control" 
                           value="${producto?.porcentaje_ganancia || 40}" step="0.1" min="0" required>
                </div>
                <div class="form-group">
                    <label for="productoPrecioVenta">Precio Venta:</label>
                    <input type="number" id="productoPrecioVenta" class="form-control" 
                           value="${producto?.precio_venta || 0}" step="0.01" min="0" required>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label for="productoStock">Stock Actual:</label>
                    <input type="number" id="productoStock" class="form-control" 
                           value="${producto?.stock || 0}" step="0.001" min="0">
                </div>
                <div class="form-group">
                    <label for="productoStockMinimo">Stock Mínimo:</label>
                    <input type="number" id="productoStockMinimo" class="form-control" 
                           value="${producto?.stock_minimo || 5}" step="0.001" min="0">
                </div>
                <div class="form-group">
                    <label for="productoStockMaximo">Stock Máximo:</label>
                    <input type="number" id="productoStockMaximo" class="form-control" 
                           value="${producto?.stock_maximo || 100}" step="0.001" min="0">
                </div>
            </div>
            <div class="form-group">
                <label for="productoProveedor">Proveedor:</label>
                <select id="productoProveedor" class="form-control">
                    <option value="">Seleccionar proveedor...</option>
                </select>
            </div>
            <div class="form-group">
                <label>
                    <input type="checkbox" id="productoActivo" ${producto?.activo !== false ? 'checked' : ''}>
                    Producto Activo
                </label>
                <label>
                    <input type="checkbox" id="productoDestacado" ${producto?.destacado ? 'checked' : ''}>
                    Producto Destacado
                </label>
            </div>
        </form>
    `;
    
    // Cargar categorías y proveedores
    loadCategoriasForSelect();
    loadProveedoresForSelect(producto?.proveedor_id);
    
    // Configurar evento para calcular precio automático
    const precioCosto = document.getElementById('productoPrecioCosto');
    const porcentajeGanancia = document.getElementById('productoPorcentajeGanancia');
    const precioVenta = document.getElementById('productoPrecioVenta');
    
    const calcularPrecio = () => {
        const costo = parseFloat(precioCosto.value) || 0;
        const porcentaje = parseFloat(porcentajeGanancia.value) || 0;
        const ventaCalculado = costo * (1 + porcentaje / 100);
        precioVenta.value = ventaCalculado.toFixed(2);
    };
    
    precioCosto.addEventListener('input', calcularPrecio);
    porcentajeGanancia.addEventListener('input', calcularPrecio);
    
    // Configurar eventos de los botones del modal
    modalConfirm.onclick = () => guardarProducto(producto?.id);
    modalCancel.onclick = () => closeModal('genericModal');
    
    modalConfirm.textContent = 'Guardar';
    modalCancel.textContent = 'Cancelar';
    
    modal.style.display = 'flex';
}

async function loadCategoriasForSelect() {
    try {
        const categorias = await indexedDBOperation('categorias_cache', 'getAll') || [];
        const datalist = document.getElementById('categoriasList');
        const select = document.getElementById('productoCategoria');
        
        if (datalist) {
            categorias.forEach(cat => {
                const option = document.createElement('option');
                option.value = cat.nombre;
                datalist.appendChild(option);
            });
        }
        
        if (select && select.tagName === 'INPUT') {
            // Ya tenemos datalist, no necesitamos llenar el input
        }
    } catch (error) {
        console.error('Error cargando categorías:', error);
    }
}

async function loadProveedoresForSelect(selectedId = null) {
    try {
        const proveedores = await indexedDBOperation('proveedores_cache', 'getAll') || [];
        const select = document.getElementById('productoProveedor');
        
        if (!select) return;
        
        proveedores.forEach(prov => {
            const option = document.createElement('option');
            option.value = prov.id;
            option.textContent = prov.nombre;
            if (prov.id === selectedId) option.selected = true;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Error cargando proveedores:', error);
    }
}

async function guardarProducto(productoId = null) {
    const form = document.getElementById('productoForm');
    if (!form) return;
    
    try {
        const productoData = {
            codigo_barras: document.getElementById('productoCodigoBarras').value.trim() || null,
            codigo_interno: document.getElementById('productoCodigoInterno').value.trim(),
            nombre: document.getElementById('productoNombre').value.trim(),
            descripcion: document.getElementById('productoDescripcion').value.trim(),
            categoria: document.getElementById('productoCategoria').value.trim(),
            marca: document.getElementById('productoMarca').value.trim() || null,
            precio_costo: parseFloat(document.getElementById('productoPrecioCosto').value) || 0,
            porcentaje_ganancia: parseFloat(document.getElementById('productoPorcentajeGanancia').value) || 40,
            precio_venta: parseFloat(document.getElementById('productoPrecioVenta').value) || 0,
            stock: parseFloat(document.getElementById('productoStock').value) || 0,
            stock_minimo: parseFloat(document.getElementById('productoStockMinimo').value) || 5,
            stock_maximo: parseFloat(document.getElementById('productoStockMaximo').value) || 100,
            proveedor_id: document.getElementById('productoProveedor').value || null,
            activo: document.getElementById('productoActivo').checked,
            destacado: document.getElementById('productoDestacado').checked,
            updated_at: new Date().toISOString()
        };
        
        // Validaciones
        if (!productoData.codigo_interno || !productoData.nombre || !productoData.categoria) {
            showToast('Complete los campos requeridos', 'error');
            return;
        }
        
        if (productoData.precio_venta <= 0) {
            showToast('El precio de venta debe ser mayor a 0', 'error');
            return;
        }
        
        let savedProducto;
        
        if (productoId) {
            // Actualizar producto existente
            productoData.id = productoId;
            savedProducto = productoData;
            
            // Guardar en cache
            await indexedDBOperation('productos_cache', 'put', {
                ...productoData,
                sync_status: APP_STATE.isOnline ? 'synced' : 'pending'
            });
            
            // Guardar en historial de precios si cambió el precio
            const productoAnterior = await indexedDBOperation('productos_cache', 'get', productoId);
            if (productoAnterior && productoAnterior.precio_venta !== productoData.precio_venta) {
                await guardarHistorialPrecio(productoId, productoAnterior.precio_venta, productoData.precio_venta);
            }
            
        } else {
            // Nuevo producto
            productoData.id = 'prod_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            productoData.created_at = new Date().toISOString();
            savedProducto = productoData;
            
            // Guardar en cache
            await indexedDBOperation('productos_cache', 'put', {
                ...productoData,
                sync_status: APP_STATE.isOnline ? 'synced' : 'pending'
            });
        }
        
        // Sincronizar con servidor si estamos online
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            try {
                const { error } = await APP_STATE.supabase
                    .from('productos')
                    .upsert([productoData]);
                
                if (error) throw error;
                
                // Actualizar estado de sync
                await indexedDBOperation('productos_cache', 'update', {
                    key: productoData.id,
                    updates: { sync_status: 'synced', last_sync_at: new Date().toISOString() }
                });
                
            } catch (error) {
                console.error('Error sincronizando producto:', error);
                
                // Guardar como operación pendiente
                await savePendingOperation({
                    type: 'producto',
                    action: productoId ? 'update' : 'create',
                    data: productoData,
                    priority: 3
                });
            }
        } else {
            // Guardar como operación pendiente
            await savePendingOperation({
                type: 'producto',
                action: productoId ? 'update' : 'create',
                data: productoData,
                priority: 3
            });
        }
        
        showToast(`Producto ${productoId ? 'actualizado' : 'creado'} correctamente`, 'success');
        closeModal('genericModal');
        
        // Recargar lista de productos
        if (APP_STATE.currentPage === 'productos') {
            await loadProductos();
        }
        
        // Actualizar productos para venta si estamos en POS
        if (APP_STATE.currentPage === 'pos') {
            await loadProductosParaVenta();
        }
        
    } catch (error) {
        console.error('Error guardando producto:', error);
        showToast('Error al guardar producto', 'error');
    }
}

async function guardarHistorialPrecio(productoId, precioAnterior, precioNuevo) {
    try {
        const historialEntry = {
            producto_id: productoId,
            precio_anterior: precioAnterior,
            precio_nuevo: precioNuevo,
            fecha_cambio: new Date().toISOString(),
            usuario_id: APP_STATE.currentUser?.id,
            motivo: 'Cambio manual'
        };
        
        await indexedDBOperation('historial_precios', 'add', historialEntry);
        
        // Sincronizar si es necesario
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            try {
                await APP_STATE.supabase
                    .from('historial_precios')
                    .insert([historialEntry]);
            } catch (error) {
                console.error('Error sincronizando historial de precios:', error);
            }
        }
    } catch (error) {
        console.error('Error guardando historial de precios:', error);
    }
}

async function eliminarProducto(productoId) {
    if (!confirm('¿Está seguro de eliminar este producto?')) return;
    
    try {
        // Marcar como inactivo en cache
        await indexedDBOperation('productos_cache', 'update', {
            key: productoId,
            updates: { activo: false, updated_at: new Date().toISOString() }
        });
        
        // Sincronizar con servidor si estamos online
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            try {
                const { error } = await APP_STATE.supabase
                    .from('productos')
                    .update({ activo: false, updated_at: new Date().toISOString() })
                    .eq('id', productoId);
                
                if (error) throw error;
            } catch (error) {
                console.error('Error sincronizando eliminación:', error);
                
                // Guardar como operación pendiente
                await savePendingOperation({
                    type: 'producto',
                    action: 'delete',
                    data: { id: productoId, activo: false },
                    priority: 2
                });
            }
        } else {
            // Guardar como operación pendiente
            await savePendingOperation({
                type: 'producto',
                action: 'delete',
                data: { id: productoId, activo: false },
                priority: 2
            });
        }
        
        showToast('Producto eliminado correctamente', 'success');
        
        // Recargar lista
        if (APP_STATE.currentPage === 'productos') {
            await loadProductos();
        }
        
    } catch (error) {
        console.error('Error eliminando producto:', error);
        showToast('Error al eliminar producto', 'error');
    }
}

async function importarExcelProductos() {
    try {
        // Crear input de archivo
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xlsx,.xls,.csv';
        input.style.display = 'none';
        
        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            showToast('Procesando archivo...', 'info');
            
            // Leer archivo
            const reader = new FileReader();
            
            reader.onload = async (event) => {
                try {
                    const data = new Uint8Array(event.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    
                    // Tomar la primera hoja
                    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                    const jsonData = XLSX.utils.sheet_to_json(firstSheet);
                    
                    let imported = 0;
                    let errors = 0;
                    
                    // Procesar cada fila
                    for (const row of jsonData) {
                        try {
                            const productoData = {
                                codigo_barras: row['CODIGO_BARRAS'] || row['codigo'] || null,
                                codigo_interno: row['CODIGO_INTERNO'] || row['codigo_interno'] || `IMP_${Date.now()}_${imported}`,
                                nombre: row['NOMBRE'] || row['nombre'] || 'Sin nombre',
                                descripcion: row['DESCRIPCION'] || row['descripcion'] || '',
                                categoria: row['CATEGORIA'] || row['categoria'] || 'General',
                                precio_costo: parseFloat(row['PRECIO_COSTO'] || row['costo'] || 0),
                                porcentaje_ganancia: parseFloat(row['PORCENTAJE_GANANCIA'] || row['margen'] || 40),
                                precio_venta: parseFloat(row['PRECIO_VENTA'] || row['venta'] || 0),
                                stock: parseFloat(row['STOCK'] || row['stock'] || 0),
                                stock_minimo: parseFloat(row['STOCK_MINIMO'] || row['stock_min'] || 5),
                                activo: true,
                                created_at: new Date().toISOString(),
                                updated_at: new Date().toISOString()
                            };
                            
                            // Calcular precio de venta si no se proporcionó
                            if (!productoData.precio_venta || productoData.precio_venta <= 0) {
                                productoData.precio_venta = productoData.precio_costo * (1 + productoData.porcentaje_ganancia / 100);
                            }
                            
                            // Generar ID
                            productoData.id = 'prod_imp_' + Date.now() + '_' + imported;
                            
                            // Guardar en cache
                            await indexedDBOperation('productos_cache', 'put', {
                                ...productoData,
                                sync_status: 'pending'
                            });
                            
                            // Guardar como operación pendiente
                            await savePendingOperation({
                                type: 'producto',
                                action: 'create',
                                data: productoData,
                                priority: 4
                            });
                            
                            imported++;
                            
                        } catch (rowError) {
                            console.error('Error procesando fila:', rowError, row);
                            errors++;
                        }
                    }
                    
                    showToast(`Importados ${imported} productos${errors > 0 ? `, ${errors} errores` : ''}`, 'success');
                    
                    // Recargar productos
                    if (APP_STATE.currentPage === 'productos') {
                        await loadProductos();
                    }
                    
                } catch (error) {
                    console.error('Error procesando Excel:', error);
                    showToast('Error procesando archivo', 'error');
                }
            };
            
            reader.readAsArrayBuffer(file);
        };
        
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
        
    } catch (error) {
        console.error('Error importando productos:', error);
        showToast('Error al importar productos', 'error');
    }
}

async function exportarExcelProductos() {
    try {
        const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        
        if (productos.length === 0) {
            showToast('No hay productos para exportar', 'warning');
            return;
        }
        
        // Crear hoja de cálculo
        const wsData = [
            ['CODIGO_BARRAS', 'CODIGO_INTERNO', 'NOMBRE', 'DESCRIPCION', 'CATEGORIA', 'PRECIO_COSTO', 'PORCENTAJE_GANANCIA', 'PRECIO_VENTA', 'STOCK', 'STOCK_MINIMO', 'ACTIVO']
        ];
        
        productos.forEach(p => {
            wsData.push([
                p.codigo_barras || '',
                p.codigo_interno || '',
                p.nombre || '',
                p.descripcion || '',
                p.categoria || '',
                p.precio_costo || 0,
                p.porcentaje_ganancia || 40,
                p.precio_venta || 0,
                p.stock || 0,
                p.stock_minimo || 5,
                p.activo ? 'SI' : 'NO'
            ]);
        });
        
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Productos');
        
        // Generar y descargar archivo
        const fecha = new Date().toISOString().split('T')[0];
        XLSX.writeFile(wb, `productos_${fecha}.xlsx`);
        
        showToast('Productos exportados correctamente', 'success');
        
    } catch (error) {
        console.error('Error exportando productos:', error);
        showToast('Error al exportar productos', 'error');
    }
}

// ============================================
// CARRI
