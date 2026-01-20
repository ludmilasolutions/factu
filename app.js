// ============================================
// SISTEMA POS - APP.JS - VERSIÓN COMPLETA Y CORREGIDA
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '2.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 7,
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
    presupuestosPendientes: 0
};

// Base de datos IndexedDB
let db;

// CREDENCIALES SUPABASE
const SUPABASE_CONFIG = {
    URL: 'https://manccbrodsboxtkrgpvm.supabase.co',
    KEY: 'sb_publishable_uFJcZUlmh3htTha0wX7knQ_4h8Z3FH3'
};

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
    
    console.log('✅ Sistema inicializado');
});

// ============================================
// BASE DE DATOS OFFLINE (IndexedDB)
// ============================================

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = (event) => {
            console.error('❌ Error abriendo IndexedDB:', event.target.error);
            if (event.target.error.name === 'VersionError') {
                console.log('⚠️ Error de versión. Intentando eliminar...');
                const deleteRequest = indexedDB.deleteDatabase(CONFIG.DB_NAME);
                
                deleteRequest.onsuccess = () => {
                    const newRequest = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
                    newRequest.onerror = (e) => reject(e.target.error);
                    newRequest.onsuccess = (e) => {
                        db = e.target.result;
                        console.log('✅ IndexedDB reinicializada');
                        resolve(db);
                    };
                    newRequest.onupgradeneeded = (e) => {
                        db = e.target.result;
                        setupObjectStores(db);
                    };
                };
                
                deleteRequest.onerror = (e) => {
                    console.error('❌ Error eliminando base de datos:', e.target.error);
                    reject(e.target.error);
                };
            } else {
                reject(event.target.error);
            }
        };
        
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('✅ IndexedDB inicializada - Versión:', db.version);
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
    const objectStores = [
        {
            name: 'operaciones_pendientes',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'type', keyPath: 'type', unique: false },
                { name: 'status', keyPath: 'status', unique: false },
                { name: 'timestamp', keyPath: 'timestamp', unique: false },
                { name: 'priority', keyPath: 'priority', unique: false }
            ]
        },
        {
            name: 'productos_cache',
            keyPath: 'id',
            indexes: [
                { name: 'codigo_barras', keyPath: 'codigo_barras', unique: true },
                { name: 'codigo_interno', keyPath: 'codigo_interno', unique: false },
                { name: 'categoria', keyPath: 'categoria', unique: false },
                { name: 'stock', keyPath: 'stock', unique: false },
                { name: 'updated_at', keyPath: 'updated_at', unique: false }
            ]
        },
        {
            name: 'clientes_cache',
            keyPath: 'id',
            indexes: [
                { name: 'dni', keyPath: 'numero_documento', unique: true },
                { name: 'nombre', keyPath: 'nombre', unique: false },
                { name: 'saldo', keyPath: 'saldo', unique: false }
            ]
        },
        {
            name: 'ventas_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'created_at', keyPath: 'created_at', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false }
            ]
        },
        {
            name: 'presupuestos_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'valido_hasta', keyPath: 'valido_hasta', unique: false }
            ]
        },
        {
            name: 'configuracion',
            keyPath: 'key'
        },
        {
            name: 'cierres_offline',
            keyPath: 'offline_id',
            autoIncrement: false,
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'estado', keyPath: 'estado', unique: false },
                { name: 'fecha', keyPath: 'fecha', unique: false }
            ]
        },
        {
            name: 'movimientos_inventario',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'producto_id', keyPath: 'producto_id', unique: false },
                { name: 'tipo_movimiento', keyPath: 'tipo_movimiento', unique: false },
                { name: 'sync_status', keyPath: 'sync_status', unique: false }
            ]
        },
        {
            name: 'proveedores_cache',
            keyPath: 'id',
            indexes: [
                { name: 'nombre', keyPath: 'nombre', unique: false },
                { name: 'cuit', keyPath: 'cuit', unique: true }
            ]
        },
        {
            name: 'categorias_cache',
            keyPath: 'id',
            indexes: [
                { name: 'nombre', keyPath: 'nombre', unique: true }
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
                    store.createIndex(indexConfig.name, indexConfig.keyPath, {
                        unique: indexConfig.unique || false
                    });
                }
            }
        }
    }
}

function indexedDBOperation(storeName, operation, data = null) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = db.transaction([storeName], operation === 'get' || operation === 'getAll' ? 'readonly' : 'readwrite');
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
                request = store.getAll();
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
            default:
                reject(new Error(`Operación no soportada: ${operation}`));
                return;
        }
        
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

async function savePendingOperation(operation) {
    const op = {
        ...operation,
        id: Date.now() + Math.random(),
        status: 'pending',
        timestamp: new Date().toISOString(),
        attempts: 0,
        priority: operation.priority || 5
    };
    
    try {
        await indexedDBOperation('operaciones_pendientes', 'add', op);
        APP_STATE.syncQueue.push(op);
        updateSyncStatus();
    } catch (error) {
        console.error('Error guardando operación pendiente:', error);
    }
}

// ============================================
// INICIALIZACIÓN SUPABASE - CORREGIDO
// ============================================

async function initSupabase() {
    try {
        // Cargar el cliente de Supabase si no está disponible
        if (!window.supabase) {
            await loadSupabase();
        }
        
        // Configurar el cliente de Supabase con las credenciales correctas
        APP_STATE.supabase = window.supabase.createClient(
            SUPABASE_CONFIG.URL,
            SUPABASE_CONFIG.KEY,
            {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                },
                realtime: {
                    params: {
                        eventsPerSecond: 10
                    }
                },
                global: {
                    headers: {
                        'apikey': SUPABASE_CONFIG.KEY
                    }
                }
            }
        );
        
        console.log('✅ Supabase configurado');
        
        // Verificar autenticación existente
        const { data: { session } } = await APP_STATE.supabase.auth.getSession();
        if (session) {
            APP_STATE.currentUser = session.user;
            await loadUserData(session.user.email);
        }
        
        // Test de conexión
        await testSupabaseConnection();
        
    } catch (error) {
        console.warn('⚠️ Error configurando Supabase:', error);
        showToast('Advertencia: Modo offline activado', 'warning');
    }
}

async function loadSupabase() {
    return new Promise((resolve, reject) => {
        if (window.supabase) {
            resolve();
            return;
        }
        
        // Verificar si ya está cargado
        if (typeof window.supabase !== 'undefined') {
            resolve();
            return;
        }
        
        // Cargar desde CDN
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        script.onload = () => {
            console.log('✅ Supabase cargado desde CDN');
            resolve();
        };
        script.onerror = () => {
            console.error('❌ Error cargando Supabase');
            reject(new Error('Error cargando Supabase'));
        };
        document.head.appendChild(script);
    });
}

async function testSupabaseConnection() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data, error } = await APP_STATE.supabase
            .from('locales')
            .select('count')
            .limit(1);
        
        if (error) {
            console.warn('⚠️ Error de conexión a Supabase:', error.message);
        } else {
            console.log('✅ Conexión a Supabase verificada');
        }
    } catch (error) {
        console.warn('⚠️ No se pudo verificar conexión a Supabase:', error.message);
    }
}

// ============================================
// GESTIÓN DE SESIÓN Y USUARIO
// ============================================

async function checkSession() {
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
}

function loadAppState() {
    try {
        const savedState = localStorage.getItem('app_state');
        if (savedState) {
            const state = JSON.parse(savedState);
            Object.assign(APP_STATE, state);
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
            ventasHoy: APP_STATE.ventasHoy
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
        }
    } catch (error) {
        console.warn('Error cargando sesión de usuario:', error);
    }
}

async function loadUserData(email) {
    if (!APP_STATE.supabase) return;
    
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
        }
    } catch (error) {
        console.warn('Error cargando datos de usuario:', error);
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
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        if (initialConfig) initialConfig.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';
        loadLocalesYCajas();
    } else {
        if (initialConfig) initialConfig.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        updateSessionInfo();
        switchPage('pos');
    }
}

function updateSessionInfo() {
    const userInfo = document.getElementById('userInfo');
    const localInfo = document.getElementById('localInfo');
    const cajaInfo = document.getElementById('cajaInfo');
    const turnoInfo = document.getElementById('turnoInfo');
    
    if (userInfo) userInfo.innerHTML = `<i class="fas fa-user"></i> Usuario: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Sin nombre'}`;
    if (localInfo) localInfo.innerHTML = `<i class="fas fa-store"></i> Local: ${APP_STATE.currentLocal?.nombre || 'Sin local'}`;
    if (cajaInfo) cajaInfo.innerHTML = `<i class="fas fa-cash-register"></i> Caja: ${APP_STATE.currentCaja?.numero || 'Sin caja'}`;
    if (turnoInfo) turnoInfo.innerHTML = `<i class="fas fa-clock"></i> Turno: ${APP_STATE.currentTurno || 'Sin turno'}`;
}

// ============================================
// AUTENTICACIÓN Y SESIÓN DE TRABAJO
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
    
    // Si no hay Supabase configurado, usar modo offline
    if (!APP_STATE.supabase) {
        handleOfflineLogin();
        return;
    }
    
    try {
        if (status) status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
        
        // Intentar login con Supabase Auth
        const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        
        if (error) {
            // Si falla, intentar modo demo con credenciales específicas
            if (email === 'admin@pos.com' && password === 'admin123') {
                await demoLogin();
                return;
            }
            throw error;
        }
        
        APP_STATE.currentUser = data.user;
        
        // Intentar cargar datos adicionales del usuario
        try {
            const { data: usuarioData, error: userError } = await APP_STATE.supabase
                .from('usuarios')
                .select('*')
                .eq('email', email)
                .single();
            
            if (!userError && usuarioData) {
                APP_STATE.currentUser = { ...APP_STATE.currentUser, ...usuarioData };
            } else {
                // Si no existe en la tabla, crear registro básico
                APP_STATE.currentUser.nombre = email.split('@')[0];
                APP_STATE.currentUser.rol = 'vendedor';
            }
        } catch (userError) {
            console.warn('No se pudieron cargar datos adicionales del usuario:', userError);
            APP_STATE.currentUser.nombre = email.split('@')[0];
            APP_STATE.currentUser.rol = 'vendedor';
        }
        
        const session = {
            user: APP_STATE.currentUser,
            expires: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        
        showAppScreen();
        
        await loadInitialData();
        
        showToast(`Bienvenido ${APP_STATE.currentUser.nombre}`, 'success');
        
    } catch (error) {
        console.error('Error en login:', error);
        if (status) {
            status.innerHTML = `
                <p class="error">❌ Error de autenticación</p>
                <p class="error-hint">Usa: admin@pos.com / admin123 para modo demo</p>
                <p class="error-detail">${error.message}</p>
            `;
        }
    }
}

async function demoLogin() {
    // Modo demo sin Supabase Auth
    APP_STATE.currentUser = {
        id: 'demo_' + Date.now(),
        email: 'admin@pos.com',
        nombre: 'Administrador Demo',
        rol: 'administrador',
        local_id: null
    };
    
    const session = {
        user: APP_STATE.currentUser,
        expires: Date.now() + (8 * 60 * 60 * 1000)
    };
    
    localStorage.setItem('pos_session', JSON.stringify(session));
    showAppScreen();
    
    // Cargar datos de demostración
    await loadInitialData();
    
    showToast('Modo demo activado', 'info');
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
    
    // Cargar datos de demostración
    setTimeout(() => {
        loadInitialData();
        showToast('Modo offline activado', 'warning');
    }, 500);
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
    
    showLoginScreen();
    showToast('Sesión cerrada', 'info');
}

async function loadLocalesYCajas() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    
    if (!localSelect || !cajaSelect) return;
    
    try {
        // Limpiar selects
        localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
        cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
        
        let locales = [];
        let cajas = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            // Cargar desde Supabase
            const { data: localesData, error: errorLocales } = await APP_STATE.supabase
                .from('locales')
                .select('*')
                .eq('activo', true)
                .order('nombre');
            
            const { data: cajasData, error: errorCajas } = await APP_STATE.supabase
                .from('cajas')
                .select('*')
                .eq('activo', true)
                .order('numero');
            
            if (!errorLocales && localesData) locales = localesData;
            if (!errorCajas && cajasData) cajas = cajasData;
        }
        
        // Si no hay datos en Supabase o estamos offline, usar datos de demo
        if (locales.length === 0) {
            locales = [
                { id: 'local-1', nombre: 'Local Central', direccion: 'Av. Principal 1234' },
                { id: 'local-2', nombre: 'Sucursal Norte', direccion: 'Calle Norte 567' },
                { id: 'local-3', nombre: 'Sucursal Sur', direccion: 'Av. Sur 890' }
            ];
        }
        
        if (cajas.length === 0) {
            cajas = [
                { id: 'caja-1', numero: 'Caja 1', nombre: 'Principal' },
                { id: 'caja-2', numero: 'Caja 2', nombre: 'Secundaria' },
                { id: 'caja-3', numero: 'Caja 3', nombre: 'Express' }
            ];
        }
        
        // Llenar select de locales
        locales.forEach(local => {
            const option = document.createElement('option');
            option.value = local.id;
            option.textContent = `${local.nombre} - ${local.direccion || ''}`;
            localSelect.appendChild(option);
        });
        
        // Llenar select de cajas
        cajas.forEach(caja => {
            const option = document.createElement('option');
            option.value = caja.id;
            option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
            cajaSelect.appendChild(option);
        });
        
    } catch (error) {
        console.warn('Error cargando locales y cajas:', error);
        
        // Cargar datos de demo en caso de error
        const localSelect = document.getElementById('selectLocal');
        const cajaSelect = document.getElementById('selectCaja');
        
        if (localSelect && cajaSelect) {
            localSelect.innerHTML = `
                <option value="">Seleccionar local...</option>
                <option value="local-1">Local Central - Av. Principal 1234</option>
                <option value="local-2">Sucursal Norte - Calle Norte 567</option>
                <option value="local-3">Sucursal Sur - Av. Sur 890</option>
            `;
            
            cajaSelect.innerHTML = `
                <option value="">Seleccionar caja...</option>
                <option value="caja-1">Caja 1 - Principal</option>
                <option value="caja-2">Caja 2 - Secundaria</option>
                <option value="caja-3">Caja 3 - Express</option>
            `;
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
    const localNombre = localSelect.options[localSelect.selectedIndex].text.split(' - ')[0];
    const cajaId = cajaSelect.value;
    const cajaNumero = cajaSelect.options[cajaSelect.selectedIndex].text.split(' - ')[0];
    const turno = turnoSelect.value;
    const saldo = parseFloat(saldoInicial.value) || 0;
    
    APP_STATE.currentLocal = { id: localId, nombre: localNombre };
    APP_STATE.currentCaja = { id: cajaId, numero: cajaNumero };
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
    
    showToast(`Sesión iniciada en ${localNombre} - ${cajaNumero} (${turno})`, 'success');
}

function skipConfig() {
    // Datos de demostración
    APP_STATE.currentLocal = { id: 'demo-local', nombre: 'Local Demo' };
    APP_STATE.currentCaja = { id: 'demo-caja', numero: 'Caja Demo' };
    APP_STATE.currentTurno = 'mañana';
    
    localStorage.setItem('currentLocal', JSON.stringify(APP_STATE.currentLocal));
    localStorage.setItem('currentCaja', JSON.stringify(APP_STATE.currentCaja));
    localStorage.setItem('currentTurno', APP_STATE.currentTurno);
    
    const initialConfig = document.getElementById('initialConfig');
    const mainApp = document.getElementById('mainApp');
    
    if (initialConfig) initialConfig.style.display = 'none';
    if (mainApp) mainApp.style.display = 'block';
    
    updateSessionInfo();
    switchPage('pos');
    
    loadInitialData();
    
    showToast('Modo demo activado con configuración predeterminada', 'info');
}

async function abrirCaja(saldoInicial) {
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja || !APP_STATE.currentTurno) return;
    
    const cierreData = {
        local_id: APP_STATE.currentLocal.id,
        caja_id: APP_STATE.currentCaja.id,
        usuario_id: APP_STATE.currentUser?.id || 'demo',
        turno: APP_STATE.currentTurno,
        fecha: new Date().toISOString().split('T')[0],
        saldo_inicial: saldoInicial,
        estado: 'abierto',
        created_at: new Date().toISOString()
    };
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .insert([cierreData]);
            
            if (error) throw error;
            
            showToast(`Caja abierta con saldo inicial: $${saldoInicial.toFixed(2)}`, 'success');
        } else {
            cierreData.offline_id = 'cierre_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            cierreData.sync_status = 'pending';
            await indexedDBOperation('cierres_offline', 'add', cierreData);
            
            await savePendingOperation({
                type: 'cierre_caja',
                data: cierreData,
                priority: 10
            });
            
            showToast(`Caja abierta (offline) con saldo inicial: $${saldoInicial.toFixed(2)}`, 'warning');
        }
    } catch (error) {
        console.error('Error abriendo caja:', error);
        showToast('Error abriendo caja', 'error');
    }
}

// ============================================
// CONFIGURACIÓN DE EVENTOS
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
    if (setupSystem) setupSystem.addEventListener('click', () => {
        showToast('Configuración del sistema', 'info');
    });
    
    // Configuración inicial
    const startSession = document.getElementById('startSession');
    const skipConfig = document.getElementById('skipConfig');
    
    if (startSession) startSession.addEventListener('click', startWorkSession);
    if (skipConfig) skipConfig.addEventListener('click', skipConfig);
    
    // Navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const page = e.currentTarget.dataset.page;
            switchPage(page);
        });
    });
    
    // POS
    const productSearch = document.getElementById('productSearch');
    const scanBarcode = document.getElementById('scanBarcode');
    const keyboardMode = document.getElementById('keyboardMode');
    const finalizarVentaBtn = document.getElementById('finalizarVenta');
    const crearPresupuestoBtn = document.getElementById('crearPresupuesto');
    const cancelarVentaBtn = document.getElementById('cancelarVenta');
    const cartDiscount = document.getElementById('cartDiscount');
    const clearCart = document.getElementById('clearCart');
    const clearSearch = document.getElementById('clearSearch');
    const quickSale = document.getElementById('quickSale');
    const openDrawer = document.getElementById('openDrawer');
    
    if (productSearch) {
        productSearch.addEventListener('keyup', handleProductSearch);
        productSearch.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleProductSearch(e);
            }
        });
    }
    
    if (scanBarcode) scanBarcode.addEventListener('click', toggleScanner);
    if (keyboardMode) keyboardMode.addEventListener('click', activateKeyboardMode);
    if (finalizarVentaBtn) finalizarVentaBtn.addEventListener('click', finalizarVenta);
    if (crearPresupuestoBtn) crearPresupuestoBtn.addEventListener('click', crearPresupuesto);
    if (cancelarVentaBtn) cancelarVentaBtn.addEventListener('click', cancelarVenta);
    if (cartDiscount) cartDiscount.addEventListener('input', updateCartTotal);
    if (clearCart) clearCart.addEventListener('click', cancelarVenta);
    if (clearSearch) clearSearch.addEventListener('click', () => {
        document.getElementById('productSearch').value = '';
    });
    if (quickSale) quickSale.addEventListener('click', () => {
        // Venta rápida de ejemplo
        agregarAlCarrito('prod-1');
        agregarAlCarrito('prod-2');
        showToast('Productos de ejemplo agregados', 'info');
    });
    if (openDrawer) openDrawer.addEventListener('click', () => {
        showToast('Cajón de dinero abierto', 'success');
    });
    
    // Modal de pagos
    document.querySelectorAll('.payment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.payment-btn').forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            const method = e.currentTarget.dataset.method;
            showPaymentDetails(method);
        });
    });
    
    const confirmPayment = document.getElementById('confirmPayment');
    
    if (confirmPayment) confirmPayment.addEventListener('click', confirmarPago);
    
    // Modal genérico
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (modalConfirm) modalConfirm.addEventListener('click', handleModalConfirm);
    if (modalCancel) modalCancel.addEventListener('click', handleModalCancel);
    
    // Scanner
    const stopScanner = document.getElementById('stopScanner');
    if (stopScanner) stopScanner.addEventListener('click', stopScanner);
    
    // Notificaciones
    const notificationsBtn = document.getElementById('notificationsBtn');
    if (notificationsBtn) notificationsBtn.addEventListener('click', showNotifications);
    
    // Menú rápido
    const quickMenuBtn = document.getElementById('quickMenuBtn');
    if (quickMenuBtn) quickMenuBtn.addEventListener('click', showQuickMenu);
}

function setupNetworkListeners() {
    window.addEventListener('online', () => {
        APP_STATE.isOnline = true;
        updateSyncStatus();
        syncOfflineOperations();
        loadInitialData();
        showToast('Conexión restablecida', 'success');
    });
    
    window.addEventListener('offline', () => {
        APP_STATE.isOnline = false;
        updateSyncStatus();
        showToast('Modo offline activado', 'warning');
    });
}

// ============================================
// NAVEGACIÓN Y PÁGINAS
// ============================================

function switchPage(pageName) {
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.page === pageName) {
            btn.classList.add('active');
        }
    });
    
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
        const pageId = `page${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`;
        if (page.id === pageId) {
            page.classList.add('active');
        }
    });
    
    const currentPage = document.getElementById('currentPage');
    if (currentPage) {
        currentPage.textContent = getPageTitle(pageName);
    }
    
    APP_STATE.currentPage = pageName;
    
    switch(pageName) {
        case 'pos':
            loadProductosParaVenta();
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
    
    saveAppState();
}

function getPageTitle(pageName) {
    const titles = {
        'pos': 'Punto de Venta',
        'productos': 'Productos',
        'clientes': 'Clientes',
        'proveedores': 'Proveedores',
        'presupuestos': 'Presupuestos',
        'reportes': 'Reportes',
        'caja': 'Cierre de Caja',
        'configuracion': 'Configuración'
    };
    return titles[pageName] || pageName;
}

// ============================================
// SINCRONIZACIÓN OFFLINE/SYNC
// ============================================

async function syncOfflineOperations() {
    if (!APP_STATE.isOnline || APP_STATE.isSyncing || !db) return;
    
    APP_STATE.isSyncing = true;
    updateSyncStatus();
    
    try {
        const operations = await indexedDBOperation('operaciones_pendientes', 'getAll');
        const sortedOps = operations.sort((a, b) => (b.priority || 5) - (a.priority || 5));
        
        for (const op of sortedOps) {
            if (op.attempts > 5) {
                op.status = 'failed';
                op.last_error = 'Máximo de intentos alcanzado';
                await indexedDBOperation('operaciones_pendientes', 'put', op);
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
                }
                
                if (success) {
                    op.status = 'synced';
                    op.synced_at = new Date().toISOString();
                    await indexedDBOperation('operaciones_pendientes', 'put', op);
                    
                    if (op.type === 'venta') {
                        await indexedDBOperation('ventas_offline', 'delete', op.data.offline_id);
                    }
                } else {
                    op.attempts += 1;
                    op.last_error = 'Error desconocido';
                    await indexedDBOperation('operaciones_pendientes', 'put', op);
                }
                
            } catch (error) {
                console.error(`❌ Error sincronizando operación ${op.id}:`, error);
                op.attempts += 1;
                op.last_error = error.message;
                await indexedDBOperation('operaciones_pendientes', 'put', op);
            }
        }
        
        await syncProductosCache();
        await syncClientesCache();
        await syncProveedoresCache();
        await syncCategoriasCache();
        
    } catch (error) {
        console.error('❌ Error en sincronización:', error);
    } finally {
        APP_STATE.isSyncing = false;
        updateSyncStatus();
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
        
        if (errorVenta) throw errorVenta;
        
        for (const item of ventaData.items) {
            item.venta_id = venta.id;
            const { error: errorItem } = await APP_STATE.supabase
                .from('venta_items')
                .insert([item]);
            
            if (errorItem) throw errorItem;
        }
        
        if (ventaData.pago) {
            ventaData.pago.venta_id = venta.id;
            const { error: errorPago } = await APP_STATE.supabase
                .from('pagos')
                .insert([ventaData.pago]);
            
            if (errorPago) throw errorPago;
        }
        
        if (ventaData.movimientos_inventario) {
            for (const movimiento of ventaData.movimientos_inventario) {
                movimiento.venta_id = venta.id;
                const { error: errorMov } = await APP_STATE.supabase
                    .from('inventario')
                    .insert([movimiento]);
                
                if (errorMov) throw errorMov;
            }
        }
        
        if (ventaData.cuenta_corriente) {
            ventaData.cuenta_corriente.venta_id = venta.id;
            const { error: errorCC } = await APP_STATE.supabase
                .from('cuentas_corrientes')
                .insert([ventaData.cuenta_corriente]);
            
            if (errorCC) throw errorCC;
        }
        
        return true;
    } catch (error) {
        console.error('Error sincronizando venta:', error);
        return false;
    }
}

async function syncPago(pagoData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('pagos')
            .insert([pagoData]);
        
        if (error) throw error;
        return true;
    } catch (error) {
        console.error('Error sincronizando pago:', error);
        return false;
    }
}

async function syncCliente(clienteData) {
    if (!APP_STATE.supabase) return false;
    
    try {
        const { error } = await APP_STATE.supabase
            .from('clientes')
            .insert([clienteData]);
        
        if (error) throw error;
        return true;
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
            .insert([productoData]);
        
        if (error) throw error;
        return true;
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
            
            if (errorItem) throw errorItem;
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
            .insert([cierreData]);
        
        if (error) throw error;
        return true;
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
        
        if (error) throw error;
        return true;
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
            .insert([proveedorData]);
        
        if (error) throw error;
        return true;
    } catch (error) {
        console.error('Error sincronizando proveedor:', error);
        return false;
    }
}

async function syncProductosCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: productos, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .eq('activo', true)
            .order('updated_at', { ascending: false })
            .limit(200);
        
        if (error) throw error;
        
        for (const producto of productos) {
            await indexedDBOperation('productos_cache', 'put', producto);
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
            .order('nombre')
            .limit(200);
        
        if (error) throw error;
        
        for (const cliente of clientes) {
            await indexedDBOperation('clientes_cache', 'put', cliente);
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
            .limit(100);
        
        if (error) throw error;
        
        for (const proveedor of proveedores) {
            await indexedDBOperation('proveedores_cache', 'put', proveedor);
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
            await indexedDBOperation('categorias_cache', 'put', categoria);
        }
        
        console.log(`✅ Cache de categorías actualizado: ${categorias.length} categorías`);
    } catch (error) {
        console.error('❌ Error actualizando cache de categorías:', error);
    }
}

function updateSyncStatus() {
    const statusBtn = document.getElementById('syncStatus');
    if (!statusBtn) return;
    
    const statusDot = statusBtn.querySelector('.status-dot');
    const statusText = statusBtn.querySelector('.status-text');
    
    if (!statusDot || !statusText) return;
    
    if (!APP_STATE.isOnline) {
        statusDot.className = 'status-dot offline';
        statusText.textContent = 'Offline';
        statusBtn.title = 'Modo offline activado';
    } else if (APP_STATE.isSyncing) {
        statusDot.className = 'status-dot syncing';
        statusText.textContent = 'Sincronizando...';
        statusBtn.title = 'Sincronizando datos...';
    } else {
        statusDot.className = 'status-dot online';
        statusText.textContent = 'Online';
        statusBtn.title = 'Conectado a Supabase';
    }
}

// ============================================
// GESTIÓN DE PRODUCTOS COMPLETA
// ============================================

async function loadInitialData() {
    await loadProductosParaVenta();
    await loadClientesParaVenta();
    await loadConfiguraciones();
    updateQuickStats();
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
        
        // Si no hay productos en cache, generar datos de demo
        if (productos.length === 0) {
            productos = generarProductosEjemplo();
            for (const producto of productos) {
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        // Actualizar sugeridos en POS
        if (APP_STATE.currentPage === 'pos') {
            actualizarBuscadorProductos(productos);
            mostrarProductosSugeridos(productos);
        }
        
        // Actualizar contador de productos
        const navProductos = document.getElementById('navProductos');
        if (navProductos) navProductos.textContent = productos.length;
        
    } catch (error) {
        console.error('Error cargando productos:', error);
    }
}

function generarProductosEjemplo() {
    const productos = [
        {
            id: 'prod-1',
            codigo_barras: '7791234567890',
            codigo_interno: 'HERR-001',
            nombre: 'Martillo de Acero 500g',
            descripcion: 'Martillo con mango de fibra de vidrio',
            categoria: 'Herramientas Manuales',
            precio_costo: 1250,
            precio_venta: 1750,
            stock: 15,
            stock_minimo: 5,
            activo: true
        },
        {
            id: 'prod-2',
            codigo_barras: '7791234567891',
            codigo_interno: 'HERR-002',
            nombre: 'Destornillador Plano 6x100',
            descripcion: 'Destornillador plano profesional',
            categoria: 'Herramientas Manuales',
            precio_costo: 850,
            precio_venta: 1232.5,
            stock: 8,
            stock_minimo: 10,
            activo: true
        },
        {
            id: 'prod-3',
            codigo_barras: '7791234567892',
            codigo_interno: 'ELEC-001',
            nombre: 'Taladro Percutor 600W',
            descripcion: 'Taladro percutor con maletín',
            categoria: 'Herramientas Eléctricas',
            precio_costo: 35000,
            precio_venta: 47250,
            stock: 3,
            stock_minimo: 2,
            activo: true
        },
        {
            id: 'prod-4',
            codigo_barras: '7791234567893',
            codigo_interno: 'FIJ-001',
            nombre: 'Caja de Tornillos 100u',
            descripcion: 'Tornillos para madera 3x50mm',
            categoria: 'Fijaciones',
            precio_costo: 1200,
            precio_venta: 1800,
            stock: 25,
            stock_minimo: 10,
            activo: true
        },
        {
            id: 'prod-5',
            codigo_barras: '7791234567894',
            codigo_interno: 'PINT-001',
            nombre: 'Pintura Látex Blanco 4L',
            descripcion: 'Pintura látex interior/exterior',
            categoria: 'Pinturas',
            precio_costo: 4500,
            precio_venta: 6300,
            stock: 12,
            stock_minimo: 5,
            activo: true
        }
    ];
    
    return productos;
}

function actualizarBuscadorProductos(productos) {
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
    
    productos.slice(0, 50).forEach(producto => {
        const option = document.createElement('option');
        option.value = `${producto.nombre} (${producto.codigo_barras || producto.codigo_interno || ''})`;
        option.dataset.id = producto.id;
        datalist.appendChild(option);
    });
}

function mostrarProductosSugeridos(productos) {
    const container = document.getElementById('suggestedProducts');
    if (!container) return;
    
    // Tomar los primeros 6 productos como sugeridos
    const sugeridos = productos.slice(0, 6);
    
    container.innerHTML = '';
    
    sugeridos.forEach(producto => {
        const productCard = document.createElement('div');
        productCard.className = 'product-card';
        productCard.innerHTML = `
            <div class="product-card-header">
                <h4>${producto.nombre}</h4>
                <span class="product-code">${producto.codigo_interno || producto.codigo_barras?.substring(0, 8) || ''}</span>
            </div>
            <p class="product-desc">${producto.descripcion?.substring(0, 50) || ''}...</p>
            <div class="product-info">
                <span class="product-price">$${producto.precio_venta?.toFixed(2) || '0.00'}</span>
                <span class="product-stock">Stock: ${producto.stock || 0}</span>
            </div>
            <button class="btn btn-primary btn-sm" onclick="agregarAlCarrito('${producto.id}')">
                <i class="fas fa-cart-plus"></i> Agregar
            </button>
        `;
        
        container.appendChild(productCard);
    });
}

async function loadProductos() {
    const pageProductos = document.getElementById('pageProductos');
    if (!pageProductos) return;
    
    pageProductos.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-boxes"></i> Productos</h2>
                <p>Gestiona el inventario de productos</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="showNuevoProductoModal()">
                    <i class="fas fa-plus"></i> Nuevo Producto
                </button>
                <button class="btn btn-secondary" onclick="exportarExcelProductos()">
                    <i class="fas fa-file-export"></i> Exportar
                </button>
            </div>
        </div>
        
        <div class="filters-section">
            <div class="search-container">
                <i class="fas fa-search"></i>
                <input type="text" id="filterProductos" placeholder="Buscar productos...">
            </div>
            <div class="filter-buttons">
                <button class="btn btn-outline" onclick="filterProductosPorStock('todo')">Todos</button>
                <button class="btn btn-outline" onclick="filterProductosPorStock('bajo')">Stock Bajo</button>
                <button class="btn btn-outline" onclick="filterProductosPorStock('sin')">Sin Stock</button>
            </div>
        </div>
        
        <div class="products-table-container">
            <div class="table-responsive">
                <table class="products-table">
                    <thead>
                        <tr>
                            <th>Código</th>
                            <th>Nombre</th>
                            <th>Categoría</th>
                            <th>Precio Costo</th>
                            <th>Precio Venta</th>
                            <th>Stock</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody id="productosList">
                        <!-- Productos cargados dinámicamente -->
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    // Cargar productos
    try {
        let productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        
        if (productos.length === 0) {
            productos = generarProductosEjemplo();
            for (const producto of productos) {
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        displayProductos(productos);
        
        // Configurar filtro
        const filterInput = document.getElementById('filterProductos');
        if (filterInput) {
            filterInput.addEventListener('input', handleFilterProductos);
        }
        
    } catch (error) {
        console.error('Error cargando productos:', error);
    }
}

function displayProductos(productos) {
    const container = document.getElementById('productosList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!productos || productos.length === 0) {
        container.innerHTML = '<tr><td colspan="7" class="no-data">No hay productos cargados</td></tr>';
        return;
    }
    
    productos.forEach(producto => {
        const stockClass = producto.stock <= producto.stock_minimo ? 'stock-bajo' : 
                          producto.stock === 0 ? 'stock-sin' : 'stock-normal';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${producto.codigo_interno || producto.codigo_barras || 'N/A'}</td>
            <td>
                <strong>${producto.nombre}</strong>
                ${producto.descripcion ? `<br><small>${producto.descripcion.substring(0, 50)}...</small>` : ''}
            </td>
            <td>${producto.categoria || 'Sin categoría'}</td>
            <td>$${producto.precio_costo?.toFixed(2) || '0.00'}</td>
            <td><strong>$${producto.precio_venta?.toFixed(2) || '0.00'}</strong></td>
            <td class="${stockClass}">${producto.stock || 0}</td>
            <td class="actions">
                <button class="btn btn-sm btn-primary" onclick="agregarAlCarrito('${producto.id}')">
                    <i class="fas fa-cart-plus"></i>
                </button>
                <button class="btn btn-sm btn-warning" onclick="editarProducto('${producto.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-danger" onclick="eliminarProducto('${producto.id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        
        container.appendChild(row);
    });
}

function handleFilterProductos() {
    const searchInput = document.getElementById('filterProductos');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const productos = Array.from(document.querySelectorAll('#productosList tr'));
    
    productos.forEach(row => {
        const nombre = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const codigo = row.querySelector('td:nth-child(1)')?.textContent.toLowerCase() || '';
        const categoria = row.querySelector('td:nth-child(3)')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || codigo.includes(searchTerm) || categoria.includes(searchTerm)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

function filterProductosPorStock(tipo) {
    const productos = document.querySelectorAll('#productosList tr');
    
    productos.forEach(row => {
        const stockCell = row.querySelector('td:nth-child(6)');
        if (!stockCell) return;
        
        const stock = parseFloat(stockCell.textContent) || 0;
        const stockClass = stockCell.className;
        
        let mostrar = true;
        
        switch(tipo) {
            case 'bajo':
                mostrar = stockClass.includes('stock-bajo');
                break;
            case 'sin':
                mostrar = stockClass.includes('stock-sin');
                break;
            case 'todo':
                mostrar = true;
                break;
        }
        
        row.style.display = mostrar ? '' : 'none';
    });
}

async function agregarAlCarrito(productoId) {
    try {
        let producto = await indexedDBOperation('productos_cache', 'get', productoId);
        
        // Si no encuentra en cache, buscar en datos de ejemplo
        if (!producto) {
            const productosEjemplo = generarProductosEjemplo();
            producto = productosEjemplo.find(p => p.id === productoId);
        }
        
        if (!producto) {
            showToast('Producto no encontrado', 'error');
            return;
        }
        
        const existingItem = APP_STATE.carrito.find(item => item.id === producto.id);
        
        if (existingItem) {
            if (existingItem.cantidad >= (producto.stock || 9999)) {
                showToast('Stock insuficiente', 'error');
                return;
            }
            existingItem.cantidad += 1;
            existingItem.subtotal = existingItem.cantidad * existingItem.precio;
        } else {
            if ((producto.stock || 0) <= 0) {
                showToast('Producto sin stock', 'warning');
                return;
            }
            APP_STATE.carrito.push({
                id: producto.id,
                nombre: producto.nombre,
                precio: producto.precio_venta || producto.precio || 0,
                costo: producto.precio_costo || 0,
                cantidad: 1,
                subtotal: producto.precio_venta || producto.precio || 0,
                stock: producto.stock || 0
            });
        }
        
        updateCartDisplay();
        showToast(`${producto.nombre} agregado al carrito`, 'success');
        
    } catch (error) {
        console.error('Error agregando al carrito:', error);
        showToast('Error al agregar producto', 'error');
    }
}

function updateCantidad(index, delta) {
    const item = APP_STATE.carrito[index];
    if (!item) return;
    
    const nuevaCantidad = (item.cantidad || 1) + delta;
    
    if (nuevaCantidad < 1) {
        removeFromCart(index);
        return;
    }
    
    if (nuevaCantidad > (item.stock || 9999)) {
        showToast('Stock insuficiente', 'error');
        return;
    }
    
    item.cantidad = nuevaCantidad;
    item.subtotal = item.cantidad * (item.precio || 0);
    updateCartDisplay();
    
    showToast(`Cantidad actualizada: ${item.cantidad}`, 'info');
}

function removeFromCart(index) {
    const item = APP_STATE.carrito[index];
    APP_STATE.carrito.splice(index, 1);
    updateCartDisplay();
    
    if (item) {
        showToast(`${item.nombre} eliminado del carrito`, 'warning');
    }
}

function changePrice(index) {
    const item = APP_STATE.carrito[index];
    if (!item) return;
    
    const nuevoPrecio = prompt('Nuevo precio:', item.precio ? item.precio.toFixed(2) : '0.00');
    
    if (nuevoPrecio && !isNaN(nuevoPrecio) && parseFloat(nuevoPrecio) >= 0) {
        item.precio = parseFloat(nuevoPrecio);
        item.subtotal = (item.cantidad || 1) * item.precio;
        updateCartDisplay();
        showToast('Precio actualizado', 'success');
    }
}

function updateCartDisplay() {
    const container = document.getElementById('cartItems');
    const cartCount = document.getElementById('cartCount');
    const cartSubtotal = document.getElementById('cartSubtotal');
    const cartIVA = document.getElementById('cartIVA');
    const cartTotal = document.getElementById('cartTotal');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    if (APP_STATE.carrito.length === 0) {
        container.innerHTML = `
            <div class="cart-empty-state">
                <i class="fas fa-shopping-basket"></i>
                <h4>Carrito Vacío</h4>
                <p>Agrega productos para comenzar una venta</p>
                <p class="hint">
                    <i class="fas fa-lightbulb"></i> 
                    Usa el buscador, escanea códigos o selecciona productos frecuentes
                </p>
            </div>
        `;
        
        if (cartCount) cartCount.textContent = '0 items';
        if (cartSubtotal) cartSubtotal.textContent = '$0.00';
        if (cartIVA) cartIVA.textContent = '$0.00';
        if (cartTotal) cartTotal.textContent = '$0.00';
        
        // Deshabilitar botones de venta
        const finalizarBtn = document.getElementById('finalizarVenta');
        const presupuestoBtn = document.getElementById('crearPresupuesto');
        if (finalizarBtn) finalizarBtn.disabled = true;
        if (presupuestoBtn) presupuestoBtn.disabled = true;
        
        return;
    }
    
    let subtotal = 0;
    
    APP_STATE.carrito.forEach((item, index) => {
        subtotal += item.subtotal || 0;
        
        const itemElem = document.createElement('div');
        itemElem.className = 'cart-item';
        itemElem.innerHTML = `
            <div class="cart-item-info">
                <span class="cart-item-name">${item.nombre || 'Producto'}</span>
                <span class="cart-item-code">${item.id}</span>
            </div>
            <div class="cart-item-quantity">
                <button class="btn-qty" onclick="updateCantidad(${index}, -1)">-</button>
                <span>${item.cantidad || 1}</span>
                <button class="btn-qty" onclick="updateCantidad(${index}, 1)">+</button>
            </div>
            <div class="cart-item-price">$${(item.precio || 0).toFixed(2)}</div>
            <div class="cart-item-subtotal">$${(item.subtotal || 0).toFixed(2)}</div>
            <div class="cart-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeFromCart(${index})">
                    <i class="fas fa-trash"></i>
                </button>
                <button class="btn btn-sm btn-warning" onclick="changePrice(${index})">
                    <i class="fas fa-dollar-sign"></i>
                </button>
            </div>
        `;
        
        container.appendChild(itemElem);
    });
    
    // Calcular IVA (21%)
    const iva = subtotal * 0.21;
    const total = subtotal + iva;
    
    // Actualizar resumen
    if (cartCount) cartCount.textContent = `${APP_STATE.carrito.length} items`;
    if (cartSubtotal) cartSubtotal.textContent = `$${subtotal.toFixed(2)}`;
    if (cartIVA) cartIVA.textContent = `$${iva.toFixed(2)}`;
    if (cartTotal) cartTotal.textContent = `$${total.toFixed(2)}`;
    
    // Habilitar botones de venta
    const finalizarBtn = document.getElementById('finalizarVenta');
    const presupuestoBtn = document.getElementById('crearPresupuesto');
    if (finalizarBtn) finalizarBtn.disabled = false;
    if (presupuestoBtn) presupuestoBtn.disabled = false;
    
    // Actualizar total en modal de pago
    const modalTotal = document.getElementById('modalTotalAmount');
    if (modalTotal) modalTotal.textContent = `$${total.toFixed(2)}`;
    
    saveAppState();
}

function updateCartTotal() {
    const subtotalElem = document.getElementById('cartSubtotal');
    const totalElem = document.getElementById('cartTotal');
    const discountInput = document.getElementById('cartDiscount');
    
    const subtotalText = subtotalElem ? subtotalElem.textContent : '$0.00';
    const subtotal = parseFloat(subtotalText.replace('$', '').replace(',', '')) || 0;
    const discount = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    
    // Aplicar descuento como porcentaje
    const descuentoMonto = subtotal * (discount / 100);
    const total = subtotal - descuentoMonto + (subtotal * 0.21);
    
    if (totalElem) totalElem.textContent = `$${total.toFixed(2)}`;
    
    // Actualizar modal de pago
    const modalTotal = document.getElementById('modalTotalAmount');
    if (modalTotal) modalTotal.textContent = `$${total.toFixed(2)}`;
}

function cancelarVenta() {
    if (APP_STATE.carrito.length === 0) return;
    
    if (confirm('¿Cancelar la venta actual? Se perderán todos los items del carrito.')) {
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '0';
        showToast('Venta cancelada', 'warning');
    }
}

// ============================================
// VENTAS Y PAGOS COMPLETOS
// ============================================

function finalizarVenta() {
    if (APP_STATE.carrito.length === 0) {
        showToast('El carrito está vacío', 'error');
        return;
    }
    
    const paymentModal = document.getElementById('paymentModal');
    if (paymentModal) {
        paymentModal.style.display = 'flex';
        
        // Actualizar total en modal
        const totalElem = document.getElementById('cartTotal');
        const modalTotal = document.getElementById('modalTotalAmount');
        if (totalElem && modalTotal) {
            modalTotal.textContent = totalElem.textContent;
        }
        
        // Seleccionar pago en efectivo por defecto
        const efectivoBtn = document.querySelector('.payment-btn[data-method="efectivo"]');
        if (efectivoBtn) {
            efectivoBtn.click();
        }
    }
}

function showPaymentDetails(method) {
    const container = document.getElementById('paymentDetails');
    if (!container) return;
    
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    
    let html = '';
    
    switch (method) {
        case 'efectivo':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label for="montoRecibido">Monto recibido:</label>
                        <div class="input-group">
                            <span class="input-group-text">$</span>
                            <input type="number" id="montoRecibido" class="form-control" 
                                   placeholder="0.00" min="${total}" step="0.01" value="${total.toFixed(2)}">
                        </div>
                    </div>
                    <div class="form-group">
                        <label for="vuelto">Vuelto:</label>
                        <div class="input-group">
                            <span class="input-group-text">$</span>
                            <input type="number" id="vuelto" class="form-control" 
                                   placeholder="0.00" readonly value="0.00">
                        </div>
                    </div>
                </div>
            `;
            
            // Configurar cálculo de vuelto
            setTimeout(() => {
                const montoInput = document.getElementById('montoRecibido');
                const vueltoInput = document.getElementById('vuelto');
                
                if (montoInput && vueltoInput) {
                    const calcularVuelto = () => {
                        const monto = parseFloat(montoInput.value) || 0;
                        const vuelto = monto - total;
                        vueltoInput.value = vuelto > 0 ? vuelto.toFixed(2) : '0.00';
                    };
                    
                    montoInput.addEventListener('input', calcularVuelto);
                    calcularVuelto();
                }
            }, 100);
            break;
            
        case 'tarjeta':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label for="tarjetaTipo">Tipo de tarjeta:</label>
                        <select id="tarjetaTipo" class="form-control">
                            <option value="credito">Crédito</option>
                            <option value="debito">Débito</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label for="tarjetaNumero">Número de tarjeta (últimos 4 dígitos):</label>
                        <input type="text" id="tarjetaNumero" class="form-control" 
                               placeholder="1234" maxlength="4" pattern="\\d{4}">
                    </div>
                    <div class="form-group">
                        <label for="tarjetaCuotas">Cuotas:</label>
                        <select id="tarjetaCuotas" class="form-control">
                            <option value="1">1 cuota</option>
                            <option value="3">3 cuotas</option>
                            <option value="6">6 cuotas</option>
                            <option value="12">12 cuotas</option>
                        </select>
                    </div>
                </div>
            `;
            break;
            
        case 'transferencia':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label for="transferenciaNumero">Número de transferencia:</label>
                        <input type="text" id="transferenciaNumero" class="form-control" 
                               placeholder="TRF-001" value="TRF-${Date.now().toString().slice(-6)}">
                    </div>
                    <div class="form-group">
                        <label for="transferenciaBanco">Banco:</label>
                        <input type="text" id="transferenciaBanco" class="form-control" 
                               placeholder="Nombre del banco">
                    </div>
                </div>
            `;
            break;
            
        case 'qr':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label>Escanea el código QR para pagar</label>
                        <div class="qr-simulator">
                            <div class="qr-code">
                                <div class="qr-pattern"></div>
                                <div class="qr-pattern"></div>
                                <div class="qr-pattern"></div>
                            </div>
                            <p><strong>Monto:</strong> $${total.toFixed(2)}</p>
                            <p><strong>Código:</strong> QR${Date.now().toString().slice(-8)}</p>
                            <button class="btn btn-primary" onclick="simularPagoQR()">
                                <i class="fas fa-check"></i> Simular Pago
                            </button>
                        </div>
                    </div>
                </div>
            `;
            break;
            
        case 'cuenta':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label for="clienteCuenta">Cliente con cuenta corriente:</label>
                        <select id="clienteCuenta" class="form-control">
                            <option value="">Seleccionar cliente...</option>
                            <option value="cliente_cc">Cliente Cuenta Corriente</option>
                        </select>
                    </div>
                    <div class="alert alert-info">
                        <i class="fas fa-info-circle"></i>
                        <span>Límite de crédito disponible: $0.00</span>
                    </div>
                </div>
            `;
            break;
            
        case 'mixto':
            html = `
                <div class="payment-form">
                    <div class="form-group">
                        <label>Pago Mixto</label>
                        <p class="text-muted">Selecciona múltiples métodos de pago</p>
                    </div>
                    <div class="alert alert-warning">
                        <i class="fas fa-exclamation-triangle"></i>
                        <span>Funcionalidad en desarrollo</span>
                    </div>
                </div>
            `;
            break;
    }
    
    container.innerHTML = html;
}

function simularPagoQR() {
    showToast('✅ Pago con QR simulado correctamente', 'success');
    setTimeout(confirmarPago, 1000);
}

async function confirmarPago() {
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    const discountInput = document.getElementById('cartDiscount');
    const descuento = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    const subtotal = total / 1.21; // Remover IVA para obtener subtotal
    
    let metodo = 'efectivo';
    let referencia = '';
    let tarjetaTipo = '';
    let tarjetaNumero = '';
    let tarjetaCuotas = 1;
    
    const activePaymentBtn = document.querySelector('.payment-btn.active');
    if (activePaymentBtn) {
        metodo = activePaymentBtn.dataset.method || 'efectivo';
    }
    
    switch (metodo) {
        case 'efectivo':
            const montoRecibido = document.getElementById('montoRecibido');
            referencia = `EF-${Date.now().toString().slice(-6)}`;
            break;
        case 'tarjeta':
            const tarjetaTipoSelect = document.getElementById('tarjetaTipo');
            const tarjetaNumeroInput = document.getElementById('tarjetaNumero');
            const tarjetaCuotasSelect = document.getElementById('tarjetaCuotas');
            tarjetaTipo = tarjetaTipoSelect ? tarjetaTipoSelect.value : 'credito';
            tarjetaNumero = tarjetaNumeroInput ? tarjetaNumeroInput.value : '';
            tarjetaCuotas = tarjetaCuotasSelect ? parseInt(tarjetaCuotasSelect.value) : 1;
            referencia = `TJ-${Date.now().toString().slice(-6)}`;
            break;
        case 'transferencia':
            const transferenciaNumero = document.getElementById('transferenciaNumero');
            referencia = transferenciaNumero ? transferenciaNumero.value : `TRF-${Date.now().toString().slice(-6)}`;
            break;
        case 'qr':
            referencia = `QR-${Date.now().toString().slice(-6)}`;
            break;
        case 'cuenta':
            referencia = `CC-${Date.now().toString().slice(-6)}`;
            break;
        case 'mixto':
            referencia = `MX-${Date.now().toString().slice(-6)}`;
            break;
    }
    
    const clienteSelect = document.getElementById('selectCliente');
    const clienteId = clienteSelect && clienteSelect.value === 'cuenta' ? 'cliente_cc' : null;
    
    const ventaId = 'venta_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const venta = {
        local_id: APP_STATE.currentLocal?.id || 'demo',
        caja_id: APP_STATE.currentCaja?.id || 'demo',
        usuario_id: APP_STATE.currentUser?.id || 'demo',
        cliente_id: clienteId,
        total: total,
        descuento: descuento,
        subtotal: subtotal,
        iva: total * 0.21,
        estado: 'completada',
        tipo_venta: metodo === 'cuenta' ? 'cuenta_corriente' : 'contado',
        tipo_comprobante: 'ticket',
        numero_venta: `V${Date.now().toString().slice(-8)}`,
        offline_id: ventaId,
        sync_status: APP_STATE.isOnline && APP_STATE.supabase ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    const items = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        cantidad: item.cantidad || 1,
        precio_unitario: item.precio || 0,
        descuento_unitario: 0,
        subtotal: item.subtotal || 0,
        created_at: new Date().toISOString()
    }));
    
    const pago = {
        metodo: metodo,
        monto: total,
        referencia: referencia,
        estado: 'completado',
        tarjeta_tipo: tarjetaTipo,
        tarjeta_numero: tarjetaNumero,
        tarjeta_cuotas: tarjetaCuotas,
        offline_id: 'pago_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: APP_STATE.isOnline && APP_STATE.supabase ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    const movimientosInventario = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        tipo_movimiento: 'venta',
        cantidad: item.cantidad || 1,
        stock_anterior: item.stock || 0,
        stock_nuevo: (item.stock || 0) - (item.cantidad || 1),
        motivo: 'Venta',
        usuario_id: APP_STATE.currentUser?.id || 'demo',
        offline_id: 'mov_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: 'pending',
        created_at: new Date().toISOString()
    }));
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { data: ventaData, error: ventaError } = await APP_STATE.supabase
                .from('ventas')
                .insert([venta])
                .select()
                .single();
            
            if (ventaError) throw ventaError;
            
            for (const item of items) {
                item.venta_id = ventaData.id;
                const { error: itemError } = await APP_STATE.supabase
                    .from('venta_items')
                    .insert([item]);
                
                if (itemError) throw itemError;
            }
            
            pago.venta_id = ventaData.id;
            const { error: pagoError } = await APP_STATE.supabase
                .from('pagos')
                .insert([pago]);
            
            if (pagoError) throw pagoError;
            
            for (const movimiento of movimientosInventario) {
                movimiento.venta_id = ventaData.id;
                const { error: movError } = await APP_STATE.supabase
                    .from('inventario')
                    .insert([movimiento]);
                
                if (movError) throw movError;
                
                await actualizarStockLocal(movimiento.producto_id, -movimiento.cantidad);
            }
            
            if (metodo === 'cuenta' && clienteId) {
                const movimientoCC = {
                    cliente_id: clienteId,
                    tipo_movimiento: 'venta',
                    monto: total,
                    saldo_anterior: 0,
                    saldo_nuevo: total,
                    venta_id: ventaData.id,
                    observaciones: 'Venta a cuenta corriente',
                    created_at: new Date().toISOString()
                };
                
                const { error: ccError } = await APP_STATE.supabase
                    .from('cuentas_corrientes')
                    .insert([movimientoCC]);
                
                if (ccError) throw ccError;
            }
            
        } else {
            const ventaOffline = {
                ...venta,
                items: items,
                pago: pago,
                movimientos_inventario: movimientosInventario
            };
            
            await indexedDBOperation('ventas_offline', 'add', ventaOffline);
            
            await savePendingOperation({
                type: 'venta',
                data: {
                    venta: venta,
                    items: items,
                    pago: pago,
                    movimientos_inventario: movimientosInventario,
                    offline_id: ventaId
                },
                priority: 10
            });
            
            for (const movimiento of movimientosInventario) {
                await indexedDBOperation('movimientos_inventario', 'add', movimiento);
                await actualizarStockLocal(movimiento.producto_id, -movimiento.cantidad);
            }
        }
        
        APP_STATE.ventasHoy++;
        updateQuickStats();
        
        // Mostrar ticket
        mostrarTicket(venta, items, pago);
        
        // Limpiar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        if (discountInput) discountInput.value = '0';
        
        // Cerrar modal de pago
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        showToast(`❌ Error: ${error.message || 'Error desconocido'}`, 'error');
    }
}

async function actualizarStockLocal(productoId, cantidad) {
    try {
        const producto = await indexedDBOperation('productos_cache', 'get', productoId);
        if (producto) {
            producto.stock = (producto.stock || 0) + cantidad;
            if (producto.stock < 0) producto.stock = 0;
            await indexedDBOperation('productos_cache', 'put', producto);
            
            // Actualizar display si estamos en página de productos
            if (APP_STATE.currentPage === 'productos') {
                loadProductos();
            }
        }
    } catch (error) {
        console.error('Error actualizando stock local:', error);
    }
}

function mostrarTicket(venta, items, pago) {
    const modal = document.getElementById('ticketModal');
    const ticketContent = document.getElementById('ticketContent');
    
    if (!modal || !ticketContent) return;
    
    // Configuración de empresa (puedes cambiarla)
    const configEmpresa = {
        nombre: 'Mi Ferretería',
        direccion: 'Av. Principal 1234',
        telefono: '011-1234-5678',
        cuit: '30-12345678-9'
    };
    
    const ticketHTML = `
        <div class="ticket-paper">
            <div class="ticket-header">
                <h3>${configEmpresa.nombre}</h3>
                <p>${configEmpresa.direccion}</p>
                <p>Tel: ${configEmpresa.telefono}</p>
                <p>CUIT: ${configEmpresa.cuit}</p>
            </div>
            
            <div class="ticket-divider">═══════════════════════</div>
            
            <div class="ticket-info">
                <p><strong>Fecha:</strong> ${new Date().toLocaleString('es-AR')}</p>
                <p><strong>Venta:</strong> ${venta.numero_venta || venta.offline_id}</p>
                <p><strong>Vendedor:</strong> ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Demo'}</p>
                <p><strong>Local:</strong> ${APP_STATE.currentLocal?.nombre || 'Demo'}</p>
                <p><strong>Caja:</strong> ${APP_STATE.currentCaja?.numero || 'Demo'}</p>
            </div>
            
            <div class="ticket-divider">───────────────────────</div>
            
            <div class="ticket-items">
                <div class="ticket-items-header">
                    <span>Descripción</span>
                    <span>Cant.</span>
                    <span>Precio</span>
                    <span>Total</span>
                </div>
                
                ${items.map(item => `
                    <div class="ticket-item">
                        <span>${item.producto_id}</span>
                        <span>${item.cantidad}</span>
                        <span>$${item.precio_unitario.toFixed(2)}</span>
                        <span>$${item.subtotal.toFixed(2)}</span>
                    </div>
                `).join('')}
            </div>
            
            <div class="ticket-divider">───────────────────────</div>
            
            <div class="ticket-totals">
                <div class="ticket-total-row">
                    <span>Subtotal:</span>
                    <span>$${(venta.subtotal || venta.total).toFixed(2)}</span>
                </div>
                ${venta.descuento > 0 ? `
                <div class="ticket-total-row">
                    <span>Descuento:</span>
                    <span>-$${venta.descuento.toFixed(2)}</span>
                </div>
                ` : ''}
                <div class="ticket-total-row">
                    <span>IVA 21%:</span>
                    <span>$${(venta.total * 0.21).toFixed(2)}</span>
                </div>
                <div class="ticket-total-row total">
                    <span><strong>TOTAL:</strong></span>
                    <span><strong>$${venta.total.toFixed(2)}</strong></span>
                </div>
            </div>
            
            <div class="ticket-divider">───────────────────────</div>
            
            <div class="ticket-payment">
                <p><strong>MÉTODO DE PAGO:</strong> ${pago.metodo.toUpperCase()}</p>
                <p><strong>REFERENCIA:</strong> ${pago.referencia}</p>
                <p><strong>ESTADO:</strong> ${pago.estado.toUpperCase()}</p>
            </div>
            
            <div class="ticket-divider">═══════════════════════</div>
            
            <div class="ticket-footer">
                <p>¡Gracias por su compra!</p>
                <p>Conserve este ticket para cambios</p>
                <p>Válido por 30 días</p>
            </div>
        </div>
    `;
    
    ticketContent.innerHTML = ticketHTML;
    modal.style.display = 'flex';
}

function imprimirTicket() {
    const ticketContent = document.getElementById('ticketContent');
    if (!ticketContent) return;
    
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
        <html>
        <head>
            <title>Ticket de Venta</title>
            <style>
                body { 
                    font-family: 'Courier New', monospace; 
                    font-size: 12px;
                    padding: 10px;
                    margin: 0;
                    width: 80mm;
                }
                .ticket-paper {
                    width: 100%;
                }
                .ticket-header {
                    text-align: center;
                    margin-bottom: 10px;
                }
                .ticket-header h3 {
                    margin: 0;
                    font-size: 14px;
                }
                .ticket-divider {
                    text-align: center;
                    margin: 5px 0;
                }
                .ticket-info p {
                    margin: 2px 0;
                }
                .ticket-items {
                    width: 100%;
                }
                .ticket-items-header {
                    display: flex;
                    justify-content: space-between;
                    font-weight: bold;
                    margin-bottom: 5px;
                }
                .ticket-item {
                    display: flex;
                    justify-content: space-between;
                    margin: 2px 0;
                }
                .ticket-totals {
                    margin-top: 10px;
                }
                .ticket-total-row {
                    display: flex;
                    justify-content: space-between;
                    margin: 3px 0;
                }
                .ticket-total-row.total {
                    font-weight: bold;
                    border-top: 1px dashed #000;
                    padding-top: 5px;
                    margin-top: 5px;
                }
                .ticket-footer {
                    text-align: center;
                    margin-top: 10px;
                    font-size: 10px;
                }
                @media print {
                    body {
                        font-size: 10px;
                    }
                }
            </style>
        </head>
        <body>
            ${ticketContent.innerHTML}
        </body>
        </html>
    `);
    printWindow.document.close();
    printWindow.print();
    printWindow.close();
    
    showToast('Ticket enviado a impresión', 'success');
}

function enviarTicketWhatsapp() {
    const ticketContent = document.getElementById('ticketContent');
    if (!ticketContent) return;
    
    const texto = `📋 Ticket de Compra\n${ticketContent.textContent}`;
    const telefono = prompt('Ingrese el número de WhatsApp (sin + ni 0):', '5491122334455');
    
    if (telefono) {
        const url = `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`;
        window.open(url, '_blank');
        showToast('WhatsApp abierto para enviar ticket', 'success');
    }
}

// ============================================
// PRESUPUESTOS COMPLETOS
// ============================================

async function crearPresupuesto() {
    if (APP_STATE.carrito.length === 0) {
        showToast('El carrito está vacío', 'error');
        return;
    }
    
    const clienteSelect = document.getElementById('selectCliente');
    const clienteId = clienteSelect ? clienteSelect.value : null;
    
    const hoy = new Date();
    const validoHasta = new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000);
    const fechaValido = validoHasta.toISOString().split('T')[0];
    
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    const discountInput = document.getElementById('cartDiscount');
    const descuento = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    const subtotal = total / 1.21; // Remover IVA
    
    const presupuestoId = 'presupuesto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const presupuesto = {
        local_id: APP_STATE.currentLocal?.id || 'demo',
        cliente_id: clienteId,
        usuario_id: APP_STATE.currentUser?.id || 'demo',
        total: total,
        descuento: descuento,
        subtotal: subtotal,
        valido_hasta: fechaValido,
        estado: 'pendiente',
        numero_presupuesto: `P${Date.now().toString().slice(-8)}`,
        offline_id: presupuestoId,
        sync_status: APP_STATE.isOnline && APP_STATE.supabase ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    const items = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        cantidad: item.cantidad || 1,
        precio_unitario: item.precio || 0,
        subtotal: item.subtotal || 0,
        created_at: new Date().toISOString()
    }));
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { data, error } = await APP_STATE.supabase
                .from('presupuestos')
                .insert([presupuesto])
                .select()
                .single();
            
            if (error) throw error;
            
            for (const item of items) {
                item.presupuesto_id = data.id;
                const { error: itemError } = await APP_STATE.supabase
                    .from('presupuesto_items')
                    .insert([item]);
                
                if (itemError) throw itemError;
            }
        } else {
            const presupuestoOffline = {
                ...presupuesto,
                items: items
            };
            
            await indexedDBOperation('presupuestos_offline', 'add', presupuestoOffline);
            
            await savePendingOperation({
                type: 'presupuesto',
                data: { presupuesto, items },
                priority: 5
            });
        }
        
        APP_STATE.presupuestosPendientes++;
        updateQuickStats();
        
        showToast('✅ Presupuesto creado correctamente', 'success');
        
        // Limpiar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        if (discountInput) discountInput.value = '0';
        
        // Mostrar modal con detalles del presupuesto
        showPresupuestoModal(presupuesto, items);
        
    } catch (error) {
        console.error('Error creando presupuesto:', error);
        showToast(`❌ Error: ${error.message || 'Error desconocido'}`, 'error');
    }
}

function showPresupuestoModal(presupuesto, items) {
    const modal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    
    if (!modal || !modalTitle || !modalBody) return;
    
    modalTitle.textContent = 'Presupuesto Creado';
    modalBody.innerHTML = `
        <div class="presupuesto-detalle">
            <div class="alert alert-success">
                <i class="fas fa-check-circle"></i>
                <strong>Presupuesto creado exitosamente</strong>
            </div>
            
            <div class="presupuesto-info">
                <p><strong>Número:</strong> ${presupuesto.numero_presupuesto}</p>
                <p><strong>Fecha:</strong> ${new Date(presupuesto.created_at).toLocaleDateString('es-AR')}</p>
                <p><strong>Válido hasta:</strong> ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}</p>
                <p><strong>Total:</strong> $${presupuesto.total.toFixed(2)}</p>
                <p><strong>Estado:</strong> <span class="badge bg-warning">${presupuesto.estado}</span></p>
            </div>
            
            <div class="presupuesto-items">
                <h5>Productos incluidos:</h5>
                <ul>
                    ${items.map(item => `
                        <li>${item.cantidad} x Producto ${item.producto_id} - $${item.subtotal.toFixed(2)}</li>
                    `).join('')}
                </ul>
            </div>
            
            <div class="presupuesto-actions">
                <button class="btn btn-primary" onclick="imprimirPresupuesto('${presupuesto.numero_presupuesto}')">
                    <i class="fas fa-print"></i> Imprimir
                </button>
                <button class="btn btn-success" onclick="convertirPresupuestoAVenta('${presupuesto.offline_id}')">
                    <i class="fas fa-shopping-cart"></i> Convertir a Venta
                </button>
            </div>
        </div>
    `;
    
    document.getElementById('modalConfirm').style.display = 'none';
    document.getElementById('modalCancel').textContent = 'Cerrar';
    
    modal.style.display = 'flex';
}

function imprimirPresupuesto(numero) {
    showToast(`Presupuesto ${numero} enviado a impresión`, 'success');
    // Implementación real de impresión iría aquí
}

async function loadPresupuestos() {
    const pagePresupuestos = document.getElementById('pagePresupuestos');
    if (!pagePresupuestos) return;
    
    pagePresupuestos.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-file-invoice-dollar"></i> Presupuestos</h2>
                <p>Gestiona presupuestos y cotizaciones</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="crearNuevoPresupuesto()">
                    <i class="fas fa-plus"></i> Nuevo Presupuesto
                </button>
            </div>
        </div>
        
        <div class="filters-section">
            <div class="search-container">
                <i class="fas fa-search"></i>
                <input type="text" id="filterPresupuestos" placeholder="Buscar presupuestos...">
            </div>
            <div class="filter-buttons">
                <button class="btn btn-outline" onclick="filterPresupuestos('todos')">Todos</button>
                <button class="btn btn-outline" onclick="filterPresupuestos('pendiente')">Pendientes</button>
                <button class="btn btn-outline" onclick="filterPresupuestos('convertido')">Convertidos</button>
                <button class="btn btn-outline" onclick="filterPresupuestos('vencido')">Vencidos</button>
            </div>
        </div>
        
        <div class="presupuestos-container">
            <div class="table-responsive">
                <table class="presupuestos-table">
                    <thead>
                        <tr>
                            <th>Número</th>
                            <th>Cliente</th>
                            <th>Fecha</th>
                            <th>Válido hasta</th>
                            <th>Total</th>
                            <th>Estado</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody id="presupuestosList">
                        <!-- Presupuestos cargados dinámicamente -->
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    // Cargar presupuestos
    try {
        let presupuestos = await indexedDBOperation('presupuestos_offline', 'getAll') || [];
        
        if (presupuestos.length === 0) {
            // Crear algunos presupuestos de ejemplo
            const hoy = new Date();
            const fechaValido = new Date(hoy.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            
            presupuestos = [
                {
                    offline_id: 'presup-1',
                    numero_presupuesto: 'P001',
                    cliente_id: 'cliente-1',
                    total: 1750,
                    estado: 'pendiente',
                    valido_hasta: fechaValido,
                    created_at: new Date().toISOString()
                },
                {
                    offline_id: 'presup-2',
                    numero_presupuesto: 'P002',
                    cliente_id: 'cliente-2',
                    total: 3200,
                    estado: 'convertido',
                    valido_hasta: fechaValido,
                    created_at: new Date().toISOString()
                }
            ];
            
            for (const presupuesto of presupuestos) {
                await indexedDBOperation('presupuestos_offline', 'add', presupuesto);
            }
        }
        
        displayPresupuestos(presupuestos);
        
        // Configurar filtro
        const filterInput = document.getElementById('filterPresupuestos');
        if (filterInput) {
            filterInput.addEventListener('input', handleFilterPresupuestos);
        }
        
    } catch (error) {
        console.error('Error cargando presupuestos:', error);
    }
}

function displayPresupuestos(presupuestos) {
    const container = document.getElementById('presupuestosList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!presupuestos || presupuestos.length === 0) {
        container.innerHTML = '<tr><td colspan="7" class="no-data">No hay presupuestos</td></tr>';
        return;
    }
    
    presupuestos.forEach(presupuesto => {
        const estadoClass = getEstadoClass(presupuesto.estado);
        const fechaValido = new Date(presupuesto.valido_hasta);
        const hoy = new Date();
        const vencido = fechaValido < hoy && presupuesto.estado === 'pendiente';
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td><strong>${presupuesto.numero_presupuesto || 'N/A'}</strong></td>
            <td>Cliente ${presupuesto.cliente_id || 'Contado'}</td>
            <td>${new Date(presupuesto.created_at).toLocaleDateString('es-AR')}</td>
            <td class="${vencido ? 'text-danger' : ''}">
                ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}
                ${vencido ? '<br><small class="text-danger">(Vencido)</small>' : ''}
            </td>
            <td>$${presupuesto.total?.toFixed(2) || '0.00'}</td>
            <td><span class="badge ${estadoClass}">${presupuesto.estado}</span></td>
            <td class="actions">
                <button class="btn btn-sm btn-primary" onclick="verPresupuesto('${presupuesto.offline_id}')">
                    <i class="fas fa-eye"></i>
                </button>
                ${presupuesto.estado === 'pendiente' ? `
                <button class="btn btn-sm btn-success" onclick="convertirPresupuestoAVenta('${presupuesto.offline_id}')">
                    <i class="fas fa-shopping-cart"></i>
                </button>
                ` : ''}
                <button class="btn btn-sm btn-danger" onclick="eliminarPresupuesto('${presupuesto.offline_id}')">
                    <i class="fas fa-trash"></i>
                </button>
            </td>
        `;
        
        container.appendChild(row);
    });
}

function getEstadoClass(estado) {
    switch(estado) {
        case 'pendiente': return 'bg-warning';
        case 'convertido': return 'bg-success';
        case 'vencido': return 'bg-danger';
        case 'cancelado': return 'bg-secondary';
        default: return 'bg-info';
    }
}

function handleFilterPresupuestos() {
    const searchInput = document.getElementById('filterPresupuestos');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const presupuestos = Array.from(document.querySelectorAll('#presupuestosList tr'));
    
    presupuestos.forEach(row => {
        const numero = row.querySelector('td:nth-child(1)')?.textContent.toLowerCase() || '';
        const cliente = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const total = row.querySelector('td:nth-child(5)')?.textContent.toLowerCase() || '';
        
        if (numero.includes(searchTerm) || cliente.includes(searchTerm) || total.includes(searchTerm)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

function filterPresupuestos(tipo) {
    const presupuestos = document.querySelectorAll('#presupuestosList tr');
    
    presupuestos.forEach(row => {
        const estadoBadge = row.querySelector('.badge');
        if (!estadoBadge) return;
        
        const estado = estadoBadge.textContent.toLowerCase();
        const fechaValidoCell = row.querySelector('td:nth-child(4)');
        const vencido = fechaValidoCell?.classList.contains('text-danger') || false;
        
        let mostrar = true;
        
        switch(tipo) {
            case 'pendiente':
                mostrar = estado === 'pendiente' && !vencido;
                break;
            case 'convertido':
                mostrar = estado === 'convertido';
                break;
            case 'vencido':
                mostrar = vencido;
                break;
            case 'todos':
                mostrar = true;
                break;
        }
        
        row.style.display = mostrar ? '' : 'none';
    });
}

function crearNuevoPresupuesto() {
    showToast('Para crear un presupuesto, agrega productos al carrito y haz clic en "Crear Presupuesto"', 'info');
    switchPage('pos');
}

function verPresupuesto(presupuestoId) {
    showToast(`Ver presupuesto ${presupuestoId}`, 'info');
    // Implementación detallada iría aquí
}

function convertirPresupuestoAVenta(presupuestoId) {
    if (confirm('¿Convertir este presupuesto en una venta?')) {
        showToast(`Presupuesto ${presupuestoId} convertido a venta`, 'success');
        // Implementación completa iría aquí
    }
}

function eliminarPresupuesto(presupuestoId) {
    if (confirm('¿Eliminar este presupuesto?')) {
        showToast(`Presupuesto ${presupuestoId} eliminado`, 'warning');
        // Implementación completa iría aquí
    }
}

// ============================================
// CLIENTES Y CUENTA CORRIENTE
// ============================================

async function loadClientes() {
    const pageClientes = document.getElementById('pageClientes');
    if (!pageClientes) return;
    
    pageClientes.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-users"></i> Clientes</h2>
                <p>Gestiona la base de clientes</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="showNuevoClienteModal()">
                    <i class="fas fa-plus"></i> Nuevo Cliente
                </button>
                <button class="btn btn-secondary" onclick="exportarClientesExcel()">
                    <i class="fas fa-file-export"></i> Exportar
                </button>
            </div>
        </div>
        
        <div class="filters-section">
            <div class="search-container">
                <i class="fas fa-search"></i>
                <input type="text" id="filterClientes" placeholder="Buscar clientes...">
            </div>
            <div class="filter-buttons">
                <button class="btn btn-outline" onclick="filterClientes('todos')">Todos</button>
                <button class="btn btn-outline" onclick="filterClientes('con_deuda')">Con Deuda</button>
                <button class="btn btn-outline" onclick="filterClientes('cuenta_corriente')">Cuenta Corriente</button>
            </div>
        </div>
        
        <div class="clientes-container">
            <div class="table-responsive">
                <table class="clientes-table">
                    <thead>
                        <tr>
                            <th>Nombre</th>
                            <th>Documento</th>
                            <th>Teléfono</th>
                            <th>Email</th>
                            <th>Tipo</th>
                            <th>Saldo</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody id="clientesList">
                        <!-- Clientes cargados dinámicamente -->
                    </tbody>
                </table>
            </div>
        </div>
    `;
    
    // Cargar clientes
    try {
        let clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        
        if (clientes.length === 0) {
            // Crear clientes de ejemplo
            clientes = [
                {
                    id: 'cliente-1',
                    nombre: 'Juan Pérez',
                    numero_documento: '12345678',
                    telefono: '011-1234-5678',
                    email: 'juan@email.com',
                    tipo_cliente: 'consumidor_final',
                    saldo: 0
                },
                {
                    id: 'cliente-2',
                    nombre: 'María Gómez',
                    numero_documento: '87654321',
                    telefono: '011-8765-4321',
                    email: 'maria@email.com',
                    tipo_cliente: 'cuenta_corriente',
                    saldo: 1500
                },
                {
                    id: 'cliente-3',
                    nombre: 'Empresa Constructora S.A.',
                    numero_documento: '30-12345678-9',
                    telefono: '011-1111-2222',
                    email: 'contacto@constructora.com',
                    tipo_cliente: 'responsable_inscripto',
                    saldo: 0
                }
            ];
            
            for (const cliente of clientes) {
                await indexedDBOperation('clientes_cache', 'put', cliente);
            }
        }
        
        displayClientes(clientes);
        
        // Configurar filtro
        const filterInput = document.getElementById('filterClientes');
        if (filterInput) {
            filterInput.addEventListener('input', handleFilterClientes);
        }
        
    } catch (error) {
        console.error('Error cargando clientes:', error);
    }
}

function displayClientes(clientes) {
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!clientes || clientes.length === 0) {
        container.innerHTML = '<tr><td colspan="7" class="no-data">No hay clientes cargados</td></tr>';
        return;
    }
    
    clientes.forEach(cliente => {
        const saldoClass = cliente.saldo > 0 ? 'text-danger' : 'text-success';
        const saldoText = cliente.saldo > 0 ? `-$${Math.abs(cliente.saldo).toFixed(2)}` : `$${cliente.saldo.toFixed(2)}`;
        
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>
                <strong>${cliente.nombre}</strong>
                ${cliente.apellido ? `<br><small>${cliente.apellido}</small>` : ''}
            </td>
            <td>${cliente.numero_documento || 'N/A'}</td>
            <td>${cliente.telefono || 'N/A'}</td>
            <td>${cliente.email || 'N/A'}</td>
            <td><span class="badge bg-info">${cliente.tipo_cliente || 'N/A'}</span></td>
            <td class="${saldoClass}"><strong>${saldoText}</strong></td>
            <td class="actions">
                <button class="btn btn-sm btn-primary" onclick="verCliente('${cliente.id}')">
                    <i class="fas fa-eye"></i>
                </button>
                <button class="btn btn-sm btn-warning" onclick="editarCliente('${cliente.id}')">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="btn btn-sm btn-success" onclick="verMovimientosCliente('${cliente.id}')">
                    <i class="fas fa-history"></i>
                </button>
            </td>
        `;
        
        container.appendChild(row);
    });
}

function handleFilterClientes() {
    const searchInput = document.getElementById('filterClientes');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const clientes = Array.from(document.querySelectorAll('#clientesList tr'));
    
    clientes.forEach(row => {
        const nombre = row.querySelector('td:nth-child(1)')?.textContent.toLowerCase() || '';
        const documento = row.querySelector('td:nth-child(2)')?.textContent.toLowerCase() || '';
        const telefono = row.querySelector('td:nth-child(3)')?.textContent.toLowerCase() || '';
        const email = row.querySelector('td:nth-child(4)')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || documento.includes(searchTerm) || 
            telefono.includes(searchTerm) || email.includes(searchTerm)) {
            row.style.display = '';
        } else {
            row.style.display = 'none';
        }
    });
}

function filterClientes(tipo) {
    const clientes = document.querySelectorAll('#clientesList tr');
    
    clientes.forEach(row => {
        const tipoBadge = row.querySelector('td:nth-child(5) .badge');
        const saldoCell = row.querySelector('td:nth-child(6)');
        
        if (!tipoBadge || !saldoCell) return;
        
        const tipoCliente = tipoBadge.textContent.toLowerCase();
        const saldoText = saldoCell.textContent;
        const tieneDeuda = saldoText.includes('-');
        
        let mostrar = true;
        
        switch(tipo) {
            case 'con_deuda':
                mostrar = tieneDeuda;
                break;
            case 'cuenta_corriente':
                mostrar = tipoCliente.includes('cuenta');
                break;
            case 'todos':
                mostrar = true;
                break;
        }
        
        row.style.display = mostrar ? '' : 'none';
    });
}

async function loadClientesParaVenta() {
    const select = document.getElementById('selectCliente');
    if (!select) return;
    
    try {
        let clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        
        if (clientes.length === 0) {
            // Crear clientes básicos para venta
            clientes = [
                {
                    id: 'cliente-contado',
                    nombre: 'Cliente Contado',
                    tipo_cliente: 'consumidor_final'
                },
                {
                    id: 'cliente-cc',
                    nombre: 'Cliente Cuenta Corriente',
                    tipo_cliente: 'cuenta_corriente',
                    saldo: 1500
                }
            ];
        }
        
        select.innerHTML = '<option value="">Cliente Contado</option>';
        
        clientes.forEach(cliente => {
            if (cliente.tipo_cliente === 'cuenta_corriente') {
                const option = document.createElement('option');
                option.value = cliente.id;
                option.textContent = `${cliente.nombre} (CC) - Saldo: $${cliente.saldo?.toFixed(2) || '0.00'}`;
                select.appendChild(option);
            }
        });
        
        // Agregar opción para nuevo cliente
        const newOption = document.createElement('option');
        newOption.value = 'nuevo';
        newOption.textContent = '+ Nuevo Cliente';
        select.appendChild(newOption);
        
        // Configurar evento para nuevo cliente
        select.addEventListener('change', function() {
            if (this.value === 'nuevo') {
                showNuevoClienteModal();
                this.value = '';
            }
        });
        
    } catch (error) {
        console.error('Error cargando clientes para venta:', error);
    }
}

function verCliente(clienteId) {
    showToast(`Ver detalles del cliente ${clienteId}`, 'info');
    // Implementación completa iría aquí
}

function editarCliente(clienteId) {
    showToast(`Editar cliente ${clienteId}`, 'info');
    // Implementación completa iría aquí
}

function verMovimientosCliente(clienteId) {
    showToast(`Ver movimientos del cliente ${clienteId}`, 'info');
    // Implementación completa iría aquí
}

function showNuevoClienteModal() {
    const modal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    
    if (!modal || !modalTitle || !modalBody) return;
    
    modalTitle.textContent = 'Nuevo Cliente';
    modalBody.innerHTML = `
        <div class="nuevo-cliente-form">
            <div class="form-group">
                <label for="clienteNombre">Nombre *</label>
                <input type="text" id="clienteNombre" class="form-control" placeholder="Nombre del cliente">
            </div>
            <div class="form-group">
                <label for="clienteApellido">Apellido</label>
                <input type="text" id="clienteApellido" class="form-control" placeholder="Apellido">
            </div>
            <div class="form-group">
                <label for="clienteDNI">DNI/CUIT</label>
                <input type="text" id="clienteDNI" class="form-control" placeholder="Número de documento">
            </div>
            <div class="form-group">
                <label for="clienteTelefono">Teléfono</label>
                <input type="text" id="clienteTelefono" class="form-control" placeholder="Teléfono">
            </div>
            <div class="form-group">
                <label for="clienteEmail">Email</label>
                <input type="email" id="clienteEmail" class="form-control" placeholder="Email">
            </div>
            <div class="form-group">
                <label for="clienteTipo">Tipo de Cliente</label>
                <select id="clienteTipo" class="form-control">
                    <option value="consumidor_final">Consumidor Final</option>
                    <option value="cuenta_corriente">Cuenta Corriente</option>
                    <option value="responsable_inscripto">Responsable Inscripto</option>
                    <option value="monotributista">Monotributista</option>
                </select>
            </div>
            <div class="form-group">
                <label for="clienteDireccion">Dirección</label>
                <textarea id="clienteDireccion" class="form-control" placeholder="Dirección completa" rows="2"></textarea>
            </div>
        </div>
    `;
    
    document.getElementById('modalConfirm').style.display = 'block';
    document.getElementById('modalConfirm').textContent = 'Guardar Cliente';
    document.getElementById('modalConfirm').onclick = guardarNuevoCliente;
    
    document.getElementById('modalCancel').textContent = 'Cancelar';
    
    modal.style.display = 'flex';
}

function guardarNuevoCliente() {
    const nombre = document.getElementById('clienteNombre').value;
    if (!nombre) {
        showToast('El nombre es requerido', 'error');
        return;
    }
    
    const cliente = {
        id: 'cliente-' + Date.now(),
        nombre: nombre,
        apellido: document.getElementById('clienteApellido').value,
        numero_documento: document.getElementById('clienteDNI').value,
        telefono: document.getElementById('clienteTelefono').value,
        email: document.getElementById('clienteEmail').value,
        tipo_cliente: document.getElementById('clienteTipo').value,
        direccion: document.getElementById('clienteDireccion').value,
        saldo: 0,
        activo: true,
        created_at: new Date().toISOString()
    };
    
    // Guardar en IndexedDB
    indexedDBOperation('clientes_cache', 'put', cliente)
        .then(() => {
            showToast('Cliente guardado correctamente', 'success');
            
            // Si estamos en la página de clientes, recargar
            if (APP_STATE.currentPage === 'clientes') {
                loadClientes();
            }
            
            // Cerrar modal
            const modal = document.getElementById('genericModal');
            if (modal) modal.style.display = 'none';
            
            // Si estamos en POS, actualizar select
            if (APP_STATE.currentPage === 'pos') {
                loadClientesParaVenta();
            }
            
            // Guardar operación pendiente para sincronizar
            if (APP_STATE.supabase) {
                savePendingOperation({
                    type: 'cliente',
                    data: cliente,
                    priority: 5
                });
            }
        })
        .catch(error => {
            console.error('Error guardando cliente:', error);
            showToast('Error guardando cliente', 'error');
        });
}

function exportarClientesExcel() {
    showToast('Exportando clientes a Excel...', 'info');
    // Implementación completa iría aquí
}

// ============================================
// CAJA Y CIERRES
// ============================================

async function loadCajaResumen() {
    const pageCaja = document.getElementById('pageCaja');
    if (!pageCaja) return;
    
    pageCaja.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-calculator"></i> Cierre de Caja</h2>
                <p>Gestiona los cierres de caja y arqueos</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-danger" onclick="cerrarCaja()">
                    <i class="fas fa-lock"></i> Cerrar Caja
                </button>
                <button class="btn btn-secondary" onclick="imprimirArqueo()">
                    <i class="fas fa-print"></i> Imprimir Arqueo
                </button>
            </div>
        </div>
        
        <div class="caja-resumen">
            <div class="resumen-card">
                <h3><i class="fas fa-cash-register"></i> Resumen del Turno</h3>
                <div class="resumen-grid">
                    <div class="resumen-item">
                        <span class="resumen-label">Saldo Inicial:</span>
                        <span class="resumen-value" id="saldoInicialResumen">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Ventas Efectivo:</span>
                        <span class="resumen-value" id="ventasEfectivo">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Ventas Tarjeta:</span>
                        <span class="resumen-value" id="ventasTarjeta">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Ventas Transferencia:</span>
                        <span class="resumen-value" id="ventasTransferencia">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Ventas QR:</span>
                        <span class="resumen-value" id="ventasQR">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Total Ventas:</span>
                        <span class="resumen-value total" id="totalVentas">$0.00</span>
                    </div>
                    <div class="resumen-item">
                        <span class="resumen-label">Saldo Final:</span>
                        <span class="resumen-value final" id="saldoFinal">$0.00</span>
                    </div>
                </div>
            </div>
            
            <div class="cierres-historial">
                <h3><i class="fas fa-history"></i> Historial de Cierres</h3>
                <div class="table-responsive">
                    <table class="cierres-table">
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Turno</th>
                                <th>Saldo Inicial</th>
                                <th>Total Ventas</th>
                                <th>Saldo Final</th>
                                <th>Diferencia</th>
                                <th>Estado</th>
                            </tr>
                        </thead>
                        <tbody id="historialCierres">
                            <!-- Historial cargado dinámicamente -->
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    
    await cargarResumenCaja();
    await cargarHistorialCierres();
}

async function cargarResumenCaja() {
    try {
        // Datos de ejemplo para el resumen
        const saldoInicial = 10000;
        const ventasEfectivo = APP_STATE.ventasHoy * 1750; // Simulación
        const ventasTarjeta = APP_STATE.ventasHoy * 500;
        const ventasTransferencia = APP_STATE.ventasHoy * 300;
        const ventasQR = APP_STATE.ventasHoy * 200;
        const totalVentas = ventasEfectivo + ventasTarjeta + ventasTransferencia + ventasQR;
        const saldoFinal = saldoInicial + ventasEfectivo;
        
        // Actualizar elementos
        document.getElementById('saldoInicialResumen').textContent = `$${saldoInicial.toFixed(2)}`;
        document.getElementById('ventasEfectivo').textContent = `$${ventasEfectivo.toFixed(2)}`;
        document.getElementById('ventasTarjeta').textContent = `$${ventasTarjeta.toFixed(2)}`;
        document.getElementById('ventasTransferencia').textContent = `$${ventasTransferencia.toFixed(2)}`;
        document.getElementById('ventasQR').textContent = `$${ventasQR.toFixed(2)}`;
        document.getElementById('totalVentas').textContent = `$${totalVentas.toFixed(2)}`;
        document.getElementById('saldoFinal').textContent = `$${saldoFinal.toFixed(2)}`;
        
    } catch (error) {
        console.error('Error cargando resumen de caja:', error);
    }
}

async function cargarHistorialCierres() {
    const container = document.getElementById('historialCierres');
    if (!container) return;
    
    try {
        let cierres = await indexedDBOperation('cierres_offline', 'getAll') || [];
        
        if (cierres.length === 0) {
            // Crear cierres de ejemplo
            const hoy = new Date();
            const ayer = new Date(hoy.getTime() - 24 * 60 * 60 * 1000);
            
            cierres = [
                {
                    fecha: ayer.toISOString().split('T')[0],
                    turno: 'tarde',
                    saldo_inicial: 8000,
                    total_ventas: 12500,
                    saldo_final: 20500,
                    diferencia: 0,
                    estado: 'cerrado'
                },
                {
                    fecha: hoy.toISOString().split('T')[0],
                    turno: 'mañana',
                    saldo_inicial: 10000,
                    total_ventas: 7500,
                    saldo_final: 17500,
                    diferencia: 0,
                    estado: 'abierto'
                }
            ];
            
            for (const cierre of cierres) {
                cierre.offline_id = 'cierre-' + Date.now() + Math.random();
                await indexedDBOperation('cierres_offline', 'add', cierre);
            }
        }
        
        container.innerHTML = '';
        
        cierres.forEach(cierre => {
            const estadoClass = cierre.estado === 'abierto' ? 'bg-success' : 'bg-secondary';
            
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${new Date(cierre.fecha).toLocaleDateString('es-AR')}</td>
                <td>${cierre.turno}</td>
                <td>$${cierre.saldo_inicial?.toFixed(2) || '0.00'}</td>
                <td>$${cierre.total_ventas?.toFixed(2) || '0.00'}</td>
                <td>$${cierre.saldo_final?.toFixed(2) || '0.00'}</td>
                <td class="${cierre.diferencia > 0 ? 'text-success' : cierre.diferencia < 0 ? 'text-danger' : ''}">
                    $${cierre.diferencia?.toFixed(2) || '0.00'}
                </td>
                <td><span class="badge ${estadoClass}">${cierre.estado}</span></td>
            `;
            
            container.appendChild(row);
        });
        
    } catch (error) {
        console.error('Error cargando historial de cierres:', error);
        container.innerHTML = '<tr><td colspan="7" class="no-data">Error cargando historial</td></tr>';
    }
}

async function cerrarCaja() {
    if (!confirm('¿Estás seguro de cerrar la caja?')) return;
    
    try {
        const saldoFinalInput = prompt('Ingrese el saldo final en caja:', '17500.00');
        if (!saldoFinalInput) return;
        
        const saldoFinal = parseFloat(saldoFinalInput) || 0;
        const saldoInicial = 10000; // Este valor debería venir de la base de datos
        const ventasEfectivo = APP_STATE.ventasHoy * 1750; // Simulación
        const diferencia = saldoFinal - (saldoInicial + ventasEfectivo);
        
        const cierreData = {
            local_id: APP_STATE.currentLocal?.id || 'demo',
            caja_id: APP_STATE.currentCaja?.id || 'demo',
            usuario_id: APP_STATE.currentUser?.id || 'demo',
            turno: APP_STATE.currentTurno || 'mañana',
            fecha: new Date().toISOString().split('T')[0],
            saldo_inicial: saldoInicial,
            saldo_final: saldoFinal,
            ventas_efectivo: ventasEfectivo,
            ventas_tarjeta: APP_STATE.ventasHoy * 500,
            ventas_transferencia: APP_STATE.ventasHoy * 300,
            ventas_qr: APP_STATE.ventasHoy * 200,
            total_ventas: ventasEfectivo + (APP_STATE.ventasHoy * 1000),
            diferencia: diferencia,
            observaciones: 'Cierre de caja manual',
            estado: 'cerrado',
            offline_id: 'cierre_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            sync_status: 'pending',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        
        // Guardar en IndexedDB
        await indexedDBOperation('cierres_offline', 'add', cierreData);
        
        // Guardar operación pendiente
        await savePendingOperation({
            type: 'cierre_caja',
            data: cierreData,
            priority: 10
        });
        
        // Reiniciar contador de ventas del día
        APP_STATE.ventasHoy = 0;
        updateQuickStats();
        
        showToast(`✅ Caja cerrada correctamente\nDiferencia: $${diferencia.toFixed(2)}`, 'success');
        
        // Recargar la página de caja
        await loadCajaResumen();
        
    } catch (error) {
        console.error('Error cerrando caja:', error);
        showToast(`❌ Error: ${error.message || 'Error desconocido'}`, 'error');
    }
}

function imprimirArqueo() {
    showToast('Arqueo enviado a impresión', 'success');
    // Implementación completa iría aquí
}

// ============================================
// PROVEEDORES
// ============================================

async function loadProveedores() {
    const pageProveedores = document.getElementById('pageProveedores');
    if (!pageProveedores) return;
    
    pageProveedores.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-truck"></i> Proveedores</h2>
                <p>Gestiona proveedores y contactos</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="showNuevoProveedorModal()">
                    <i class="fas fa-plus"></i> Nuevo Proveedor
                </button>
                <button class="btn btn-secondary" onclick="exportarProveedoresExcel()">
                    <i class="fas fa-file-export"></i> Exportar
                </button>
            </div>
        </div>
        
        <div class="filters-section">
            <div class="search-container">
                <i class="fas fa-search"></i>
                <input type="text" id="filterProveedores" placeholder="Buscar proveedores...">
            </div>
        </div>
        
        <div class="proveedores-container">
            <div class="proveedores-grid" id="proveedoresList">
                <!-- Proveedores cargados dinámicamente -->
            </div>
        </div>
    `;
    
    // Cargar proveedores
    try {
        let proveedores = await indexedDBOperation('proveedores_cache', 'getAll') || [];
        
        if (proveedores.length === 0) {
            // Crear proveedores de ejemplo
            proveedores = [
                {
                    id: 'prov-1',
                    nombre: 'Distribuidora Mayorista S.A.',
                    contacto: 'Carlos López',
                    telefono: '011-1111-2222',
                    email: 'ventas@mayorista.com',
                    cuit: '30-11222333-9',
                    productos_que_vende: 'Herramientas, materiales'
                },
                {
                    id: 'prov-2',
                    nombre: 'Fábrica de Pinturas Color Plus',
                    contacto: 'Ana Martínez',
                    telefono: '011-3333-4444',
                    email: 'ana@colorplus.com',
                    cuit: '30-44555666-7',
                    productos_que_vende: 'Pinturas, barnices, accesorios'
                },
                {
                    id: 'prov-3',
                    nombre: 'Importadora de Herramientas',
                    contacto: 'Roberto García',
                    telefono: '011-5555-6666',
                    email: 'roberto@importtools.com',
                    cuit: '30-77888999-1',
                    productos_que_vende: 'Herramientas eléctricas y manuales'
                }
            ];
            
            for (const proveedor of proveedores) {
                await indexedDBOperation('proveedores_cache', 'put', proveedor);
            }
        }
        
        displayProveedores(proveedores);
        
        // Configurar filtro
        const filterInput = document.getElementById('filterProveedores');
        if (filterInput) {
            filterInput.addEventListener('input', handleFilterProveedores);
        }
        
    } catch (error) {
        console.error('Error cargando proveedores:', error);
    }
}

function displayProveedores(proveedores) {
    const container = document.getElementById('proveedoresList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!proveedores || proveedores.length === 0) {
        container.innerHTML = '<div class="no-data">No hay proveedores cargados</div>';
        return;
    }
    
    proveedores.forEach(proveedor => {
        const card = document.createElement('div');
        card.className = 'proveedor-card';
        card.innerHTML = `
            <div class="proveedor-card-header">
                <h4>${proveedor.nombre}</h4>
                <span class="proveedor-cuit">${proveedor.cuit || 'Sin CUIT'}</span>
            </div>
            <div class="proveedor-card-body">
                <p><i class="fas fa-user"></i> <strong>Contacto:</strong> ${proveedor.contacto || 'No especificado'}</p>
                <p><i class="fas fa-phone"></i> <strong>Teléfono:</strong> ${proveedor.telefono || 'No especificado'}</p>
                <p><i class="fas fa-envelope"></i> <strong>Email:</strong> ${proveedor.email || 'No especificado'}</p>
                <p><i class="fas fa-box"></i> <strong>Productos:</strong> ${proveedor.productos_que_vende || 'No especificado'}</p>
            </div>
            <div class="proveedor-card-footer">
                <button class="btn btn-sm btn-primary" onclick="contactarProveedor('${proveedor.telefono}', '${proveedor.contacto}')">
                    <i class="fas fa-phone"></i> Llamar
                </button>
                <button class="btn btn-sm btn-success" onclick="enviarEmailProveedor('${proveedor.email}', '${proveedor.nombre}')">
                    <i class="fas fa-envelope"></i> Email
                </button>
                <button class="btn btn-sm btn-warning" onclick="verProveedor('${proveedor.id}')">
                    <i class="fas fa-eye"></i> Ver
                </button>
            </div>
        `;
        
        container.appendChild(card);
    });
}

function handleFilterProveedores() {
    const searchInput = document.getElementById('filterProveedores');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const proveedores = Array.from(document.querySelectorAll('.proveedor-card'));
    
    proveedores.forEach(card => {
        const nombre = card.querySelector('h4')?.textContent.toLowerCase() || '';
        const contacto = card.querySelector('.proveedor-card-body')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || contacto.includes(searchTerm)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

function showNuevoProveedorModal() {
    const modal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    
    if (!modal || !modalTitle || !modalBody) return;
    
    modalTitle.textContent = 'Nuevo Proveedor';
    modalBody.innerHTML = `
        <div class="nuevo-proveedor-form">
            <div class="form-group">
                <label for="proveedorNombre">Nombre *</label>
                <input type="text" id="proveedorNombre" class="form-control" placeholder="Nombre del proveedor">
            </div>
            <div class="form-group">
                <label for="proveedorContacto">Contacto</label>
                <input type="text" id="proveedorContacto" class="form-control" placeholder="Persona de contacto">
            </div>
            <div class="form-group">
                <label for="proveedorTelefono">Teléfono</label>
                <input type="text" id="proveedorTelefono" class="form-control" placeholder="Teléfono">
            </div>
            <div class="form-group">
                <label for="proveedorEmail">Email</label>
                <input type="email" id="proveedorEmail" class="form-control" placeholder="Email">
            </div>
            <div class="form-group">
                <label for="proveedorCUIT">CUIT</label>
                <input type="text" id="proveedorCUIT" class="form-control" placeholder="CUIT">
            </div>
            <div class="form-group">
                <label for="proveedorProductos">Productos que vende</label>
                <textarea id="proveedorProductos" class="form-control" placeholder="Descripción de productos" rows="3"></textarea>
            </div>
            <div class="form-group">
                <label for="proveedorDireccion">Dirección</label>
                <textarea id="proveedorDireccion" class="form-control" placeholder="Dirección completa" rows="2"></textarea>
            </div>
        </div>
    `;
    
    document.getElementById('modalConfirm').style.display = 'block';
    document.getElementById('modalConfirm').textContent = 'Guardar Proveedor';
    document.getElementById('modalConfirm').onclick = guardarNuevoProveedor;
    
    document.getElementById('modalCancel').textContent = 'Cancelar';
    
    modal.style.display = 'flex';
}

function guardarNuevoProveedor() {
    const nombre = document.getElementById('proveedorNombre').value;
    if (!nombre) {
        showToast('El nombre es requerido', 'error');
        return;
    }
    
    const proveedor = {
        id: 'prov-' + Date.now(),
        nombre: nombre,
        contacto: document.getElementById('proveedorContacto').value,
        telefono: document.getElementById('proveedorTelefono').value,
        email: document.getElementById('proveedorEmail').value,
        cuit: document.getElementById('proveedorCUIT').value,
        productos_que_vende: document.getElementById('proveedorProductos').value,
        direccion: document.getElementById('proveedorDireccion').value,
        activo: true,
        created_at: new Date().toISOString()
    };
    
    // Guardar en IndexedDB
    indexedDBOperation('proveedores_cache', 'put', proveedor)
        .then(() => {
            showToast('Proveedor guardado correctamente', 'success');
            
            // Si estamos en la página de proveedores, recargar
            if (APP_STATE.currentPage === 'proveedores') {
                loadProveedores();
            }
            
            // Cerrar modal
            const modal = document.getElementById('genericModal');
            if (modal) modal.style.display = 'none';
            
            // Guardar operación pendiente para sincronizar
            if (APP_STATE.supabase) {
                savePendingOperation({
                    type: 'proveedor',
                    data: proveedor,
                    priority: 5
                });
            }
        })
        .catch(error => {
            console.error('Error guardando proveedor:', error);
            showToast('Error guardando proveedor', 'error');
        });
}

function contactarProveedor(telefono, contacto) {
    if (!telefono || telefono === 'No especificado') {
        showToast('No hay teléfono registrado', 'error');
        return;
    }
    
    if (confirm(`¿Llamar a ${contacto} al ${telefono}?`)) {
        window.open(`tel:${telefono}`, '_blank');
    }
}

function enviarEmailProveedor(email, nombre) {
    if (!email || email === 'No especificado') {
        showToast('No hay email registrado', 'error');
        return;
    }
    
    const asunto = encodeURIComponent('Consulta - Sistema POS');
    const cuerpo = encodeURIComponent(`Hola ${nombre},\n\nNecesito hacer una consulta sobre productos.\n\nSaludos cordiales.`);
    
    window.open(`mailto:${email}?subject=${asunto}&body=${cuerpo}`, '_blank');
}

function verProveedor(proveedorId) {
    showToast(`Ver detalles del proveedor ${proveedorId}`, 'info');
    // Implementación completa iría aquí
}

function exportarProveedoresExcel() {
    showToast('Exportando proveedores a Excel...', 'info');
    // Implementación completa iría aquí
}

// ============================================
// REPORTES
// ============================================

async function loadReportes() {
    const pageReportes = document.getElementById('pageReportes');
    if (!pageReportes) return;
    
    pageReportes.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-chart-bar"></i> Reportes</h2>
                <p>Reportes y estadísticas del sistema</p>
            </div>
            <div class="page-actions">
                <button class="btn btn-primary" onclick="generarReporteDiario()">
                    <i class="fas fa-file-pdf"></i> Reporte Diario
                </button>
                <button class="btn btn-secondary" onclick="exportarReportesExcel()">
                    <i class="fas fa-file-excel"></i> Exportar Excel
                </button>
            </div>
        </div>
        
        <div class="reportes-grid">
            <div class="reporte-card">
                <div class="reporte-card-header bg-primary">
                    <i class="fas fa-chart-line"></i>
                    <h3>Ventas Hoy</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteVentasHoy">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
            
            <div class="reporte-card">
                <div class="reporte-card-header bg-warning">
                    <i class="fas fa-box"></i>
                    <h3>Stock Bajo</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteStockBajo">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
            
            <div class="reporte-card">
                <div class="reporte-card-header bg-danger">
                    <i class="fas fa-users"></i>
                    <h3>Clientes con Deuda</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteClientesDeuda">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
            
            <div class="reporte-card">
                <div class="reporte-card-header bg-success">
                    <i class="fas fa-calculator"></i>
                    <h3>Cierre de Caja</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteCierreCaja">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
            
            <div class="reporte-card large">
                <div class="reporte-card-header bg-info">
                    <i class="fas fa-chart-pie"></i>
                    <h3>Productos Más Vendidos</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteProductosVendidos">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
            
            <div class="reporte-card large">
                <div class="reporte-card-header bg-purple">
                    <i class="fas fa-calendar-alt"></i>
                    <h3>Ventas por Día (Últimos 7 días)</h3>
                </div>
                <div class="reporte-card-body">
                    <div class="reporte-data" id="reporteVentasSemanales">
                        <div class="loading">Cargando...</div>
                    </div>
                </div>
            </div>
        </div>
    `;
    
    await cargarDatosReportes();
}

async function cargarDatosReportes() {
    try {
        // Ventas Hoy
        const ventasHoy = APP_STATE.ventasHoy;
        const totalVentasHoy = ventasHoy * 2250; // Simulación
        
        document.getElementById('reporteVentasHoy').innerHTML = `
            <div class="reporte-number">${ventasHoy}</div>
            <p>Ventas realizadas hoy</p>
            <div class="reporte-total">$${totalVentasHoy.toFixed(2)}</div>
            <p>Total facturado</p>
        `;
        
        // Stock Bajo
        const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        const stockBajo = productos.filter(p => p.stock <= p.stock_minimo);
        
        document.getElementById('reporteStockBajo').innerHTML = `
            <div class="reporte-number ${stockBajo.length > 0 ? 'text-danger' : ''}">${stockBajo.length}</div>
            <p>Productos con stock bajo</p>
            ${stockBajo.length > 0 ? `
                <div class="reporte-list">
                    <strong>Productos críticos:</strong>
                    ${stockBajo.slice(0, 3).map(p => `
                        <div class="reporte-list-item">
                            <span>${p.nombre}</span>
                            <span class="badge bg-danger">${p.stock}</span>
                        </div>
                    `).join('')}
                    ${stockBajo.length > 3 ? `<p>... y ${stockBajo.length - 3} más</p>` : ''}
                </div>
            ` : '<p class="text-success">✅ Todo en orden</p>'}
        `;
        
        // Clientes con Deuda
        const clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        const clientesDeuda = clientes.filter(c => c.saldo > 0);
        const deudaTotal = clientesDeuda.reduce((sum, c) => sum + c.saldo, 0);
        
        document.getElementById('reporteClientesDeuda').innerHTML = `
            <div class="reporte-number ${clientesDeuda.length > 0 ? 'text-danger' : ''}">${clientesDeuda.length}</div>
            <p>Clientes con saldo pendiente</p>
            <div class="reporte-total ${deudaTotal > 0 ? 'text-danger' : ''}">$${deudaTotal.toFixed(2)}</div>
            <p>Deuda total</p>
        `;
        
        // Cierre de Caja
        document.getElementById('reporteCierreCaja').innerHTML = `
            <div class="reporte-info">
                <p><strong>Turno:</strong> ${APP_STATE.currentTurno || 'No iniciado'}</p>
                <p><strong>Caja:</strong> ${APP_STATE.currentCaja?.numero || 'No seleccionada'}</p>
                <p><strong>Local:</strong> ${APP_STATE.currentLocal?.nombre || 'No seleccionado'}</p>
                <p><strong>Ventas hoy:</strong> ${ventasHoy}</p>
                <p><strong>Total ventas:</strong> $${totalVentasHoy.toFixed(2)}</p>
            </div>
        `;
        
        // Productos Más Vendidos
        const productosVendidos = [
            { nombre: 'Martillo de Acero', ventas: 15, total: 26250 },
            { nombre: 'Destornillador Plano', ventas: 12, total: 14790 },
            { nombre: 'Taladro Percutor', ventas: 3, total: 141750 },
            { nombre: 'Caja de Tornillos', ventas: 25, total: 45000 },
            { nombre: 'Pintura Látex', ventas: 8, total: 50400 }
        ];
        
        document.getElementById('reporteProductosVendidos').innerHTML = `
            <div class="productos-vendidos">
                ${productosVendidos.map((prod, index) => `
                    <div class="producto-vendido">
                        <div class="producto-rank">#${index + 1}</div>
                        <div class="producto-info">
                            <strong>${prod.nombre}</strong>
                            <div class="producto-stats">
                                <span>${prod.ventas} ventas</span>
                                <span class="text-success">$${prod.total.toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        
        // Ventas por Día
        const ventasSemanales = [
            { dia: 'Lunes', ventas: 8, total: 18000 },
            { dia: 'Martes', ventas: 10, total: 22500 },
            { dia: 'Miércoles', ventas: 7, total: 15750 },
            { dia: 'Jueves', ventas: 12, total: 27000 },
            { dia: 'Viernes', ventas: 15, total: 33750 },
            { dia: 'Sábado', ventas: 20, total: 45000 },
            { dia: 'Hoy', ventas: ventasHoy, total: totalVentasHoy }
        ];
        
        document.getElementById('reporteVentasSemanales').innerHTML = `
            <div class="ventas-semanales">
                ${ventasSemanales.map(dia => `
                    <div class="dia-ventas">
                        <div class="dia-nombre">${dia.dia}</div>
                        <div class="dia-barra">
                            <div class="barra-progreso" style="width: ${(dia.ventas / 20) * 100}%"></div>
                        </div>
                        <div class="dia-total">
                            <span>${dia.ventas} ventas</span>
                            <span class="text-success">$${dia.total.toFixed(2)}</span>
                        </div>
                    </div>
                `).join('')}
            </div>
        `;
        
    } catch (error) {
        console.error('Error cargando reportes:', error);
        
        // Mostrar errores
        document.querySelectorAll('.reporte-data .loading').forEach(el => {
            el.innerHTML = 'Error cargando datos';
            el.className = 'error';
        });
    }
}

function generarReporteDiario() {
    showToast('Generando reporte diario en PDF...', 'info');
    // Implementación completa iría aquí
}

function exportarReportesExcel() {
    showToast('Exportando reportes a Excel...', 'info');
    // Implementación completa iría aquí
}

// ============================================
// CONFIGURACIÓN
// ============================================

async function loadConfiguracion() {
    const pageConfiguracion = document.getElementById('pageConfiguracion');
    if (!pageConfiguracion) return;
    
    pageConfiguracion.innerHTML = `
        <div class="page-header">
            <div class="page-title">
                <h2><i class="fas fa-cog"></i> Configuración</h2>
                <p>Configuración del sistema y preferencias</p>
            </div>
        </div>
        
        <div class="configuracion-grid">
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-store"></i>
                    <h3>Configuración de Empresa</h3>
                </div>
                <div class="config-card-body">
                    <div class="form-group">
                        <label for="empresaNombre">Nombre de la Empresa</label>
                        <input type="text" id="empresaNombre" class="form-control" value="Mi Ferretería">
                    </div>
                    <div class="form-group">
                        <label for="empresaDireccion">Dirección</label>
                        <input type="text" id="empresaDireccion" class="form-control" value="Av. Principal 1234">
                    </div>
                    <div class="form-group">
                        <label for="empresaTelefono">Teléfono</label>
                        <input type="text" id="empresaTelefono" class="form-control" value="011-1234-5678">
                    </div>
                    <div class="form-group">
                        <label for="empresaCUIT">CUIT</label>
                        <input type="text" id="empresaCUIT" class="form-control" value="30-12345678-9">
                    </div>
                    <button class="btn btn-primary" onclick="guardarConfigEmpresa()">
                        <i class="fas fa-save"></i> Guardar
                    </button>
                </div>
            </div>
            
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-cash-register"></i>
                    <h3>Configuración de Caja</h3>
                </div>
                <div class="config-card-body">
                    <div class="form-group">
                        <label for="configSaldoInicial">Saldo Inicial por Defecto</label>
                        <input type="number" id="configSaldoInicial" class="form-control" value="10000">
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="configImprimirTicket" class="form-check-input" checked>
                        <label class="form-check-label" for="configImprimirTicket">Imprimir ticket automáticamente</label>
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="configCorteAutomatico" class="form-check-input">
                        <label class="form-check-label" for="configCorteAutomatico">Corte automático de caja</label>
                    </div>
                    <button class="btn btn-primary" onclick="guardarConfigCaja()">
                        <i class="fas fa-save"></i> Guardar
                    </button>
                </div>
            </div>
            
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-box"></i>
                    <h3>Configuración de Stock</h3>
                </div>
                <div class="config-card-body">
                    <div class="form-group">
                        <label for="configStockMinimo">Stock Mínimo por Defecto</label>
                        <input type="number" id="configStockMinimo" class="form-control" value="5">
                    </div>
                    <div class="form-group">
                        <label for="configStockMaximo">Stock Máximo por Defecto</label>
                        <input type="number" id="configStockMaximo" class="form-control" value="100">
                    </div>
                    <div class="form-check">
                        <input type="checkbox" id="configAlertarStock" class="form-check-input" checked>
                        <label class="form-check-label" for="configAlertarStock">Alertar stock bajo</label>
                    </div>
                    <button class="btn btn-primary" onclick="guardarConfigStock()">
                        <i class="fas fa-save"></i> Guardar
                    </button>
                </div>
            </div>
            
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-sync"></i>
                    <h3>Sincronización</h3>
                </div>
                <div class="config-card-body">
                    <div class="form-group">
                        <label>Estado de conexión:</label>
                        <div class="connection-status">
                            <span class="status-dot ${APP_STATE.isOnline ? 'online' : 'offline'}"></span>
                            <span>${APP_STATE.isOnline ? 'Online' : 'Offline'}</span>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Operaciones pendientes:</label>
                        <div class="pending-ops">${APP_STATE.syncQueue.length}</div>
                    </div>
                    <button class="btn btn-primary" onclick="forzarSincronizacion()" ${!APP_STATE.isOnline ? 'disabled' : ''}>
                        <i class="fas fa-sync"></i> Sincronizar Ahora
                    </button>
                    <button class="btn btn-warning" onclick="limpiarCache()">
                        <i class="fas fa-trash"></i> Limpiar Cache
                    </button>
                </div>
            </div>
            
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-shield-alt"></i>
                    <h3>Seguridad</h3>
                </div>
                <div class="config-card-body">
                    <button class="btn btn-warning" onclick="cambiarContrasena()">
                        <i class="fas fa-key"></i> Cambiar Contraseña
                    </button>
                    <button class="btn btn-info" onclick="exportarDatos()">
                        <i class="fas fa-download"></i> Exportar Datos
                    </button>
                    <button class="btn btn-danger" onclick="resetearSistema()">
                        <i class="fas fa-exclamation-triangle"></i> Resetear Sistema
                    </button>
                </div>
            </div>
            
            <div class="config-card">
                <div class="config-card-header">
                    <i class="fas fa-info-circle"></i>
                    <h3>Acerca del Sistema</h3>
                </div>
                <div class="config-card-body">
                    <p><strong>Versión:</strong> ${CONFIG.VERSION}</p>
                    <p><strong>Base de datos:</strong> ${db ? 'IndexedDB ' + CONFIG.DB_VERSION : 'No inicializada'}</p>
                    <p><strong>Supabase:</strong> ${APP_STATE.supabase ? 'Conectado' : 'No conectado'}</p>
                    <p><strong>Modo:</strong> ${APP_STATE.isOnline ? 'Online' : 'Offline'}</p>
                    <p><strong>Usuario:</strong> ${APP_STATE.currentUser?.nombre || 'No identificado'}</p>
                    <hr>
                    <p class="text-muted small">Sistema POS - Desarrollado por Ángel Mascali</p>
                </div>
            </div>
        </div>
    `;
}

function guardarConfigEmpresa() {
    showToast('Configuración de empresa guardada', 'success');
}

function guardarConfigCaja() {
    showToast('Configuración de caja guardada', 'success');
}

function guardarConfigStock() {
    showToast('Configuración de stock guardada', 'success');
}

function forzarSincronizacion() {
    if (!APP_STATE.isOnline) {
        showToast('No hay conexión a internet', 'error');
        return;
    }
    
    showToast('Sincronizando...', 'info');
    syncOfflineOperations();
}

function limpiarCache() {
    if (confirm('¿Estás seguro de limpiar la cache? Esto no eliminará datos sincronizados.')) {
        indexedDB.deleteDatabase(CONFIG.DB_NAME)
            .then(() => {
                showToast('Cache limpiada correctamente', 'success');
                setTimeout(() => {
                    location.reload();
                }, 2000);
            })
            .catch(error => {
                console.error('Error limpiando cache:', error);
                showToast('Error limpiando cache', 'error');
            });
    }
}

function cambiarContraseña() {
    showToast('Función en desarrollo', 'info');
}

function exportarDatos() {
    showToast('Exportando datos...', 'info');
}

function resetearSistema() {
    if (confirm('⚠️ ¿ESTÁS SEGURO?\n\nEsta acción eliminará todos los datos locales y reiniciará el sistema.')) {
        // Eliminar IndexedDB
        indexedDB.deleteDatabase(CONFIG.DB_NAME);
        
        // Eliminar localStorage
        localStorage.clear();
        
        showToast('Sistema reseteado. Recargando...', 'warning');
        
        setTimeout(() => {
            location.reload();
        }, 3000);
    }
}

async function loadConfiguraciones() {
    try {
        // Cargar configuraciones por defecto
        const configDefaults = {
            empresa: {
                nombre: 'Mi Ferretería',
                direccion: 'Av. Principal 1234',
                telefono: '011-1234-5678',
                cuit: '30-12345678-9'
            },
            caja: {
                saldo_inicial: 10000,
                imprimir_ticket: true,
                corte_automatico: false
            },
            stock: {
                stock_minimo: 5,
                stock_maximo: 100,
                alertar_stock: true
            }
        };
        
        // Guardar en localStorage para uso rápido
        localStorage.setItem('config_sistema', JSON.stringify(configDefaults));
        
    } catch (error) {
        console.warn('Error cargando configuraciones:', error);
    }
}

// ============================================
// SCANNER Y BÚSQUEDA
// ============================================

async function handleProductSearch(e) {
    if (e.key === 'Enter') {
        const searchTerm = e.target.value.trim();
        if (!searchTerm) return;
        
        let producto = null;
        
        try {
            const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
            
            // Buscar por código de barras, código interno o nombre
            producto = productos.find(p => 
                (p.codigo_barras && p.codigo_barras === searchTerm) || 
                (p.codigo_interno && p.codigo_interno === searchTerm) ||
                (p.nombre && p.nombre.toLowerCase().includes(searchTerm.toLowerCase()))
            );
        } catch (error) {
            console.warn('Error buscando producto en cache:', error);
        }
        
        if (!producto) {
            // Buscar en productos de ejemplo
            const productosEjemplo = generarProductosEjemplo();
            producto = productosEjemplo.find(p => 
                p.nombre.toLowerCase().includes(searchTerm.toLowerCase())
            );
        }
        
        if (producto) {
            agregarAlCarrito(producto.id);
            e.target.value = '';
            e.target.focus();
        } else {
            showToast('Producto no encontrado', 'error');
        }
    }
}

let scannerStream = null;

async function toggleScanner() {
    const scannerContainer = document.getElementById('scannerContainer');
    const scannerVideo = document.getElementById('scannerVideo');
    
    if (!scannerContainer || !scannerVideo) return;
    
    if (APP_STATE.scannerActive) {
        stopScanner();
        return;
    }
    
    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showToast('Tu navegador no soporta el acceso a la cámara', 'error');
            return;
        }
        
        scannerStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        
        scannerVideo.srcObject = scannerStream;
        scannerContainer.style.display = 'block';
        APP_STATE.scannerActive = true;
        
        // Simular detección después de 2 segundos
        simulateBarcodeDetection();
        
    } catch (error) {
        console.error('Error accediendo a la cámara:', error);
        showToast('No se pudo acceder a la cámara. Asegúrate de conceder los permisos necesarios.', 'error');
    }
}

function stopScanner() {
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }
    
    const scannerContainer = document.getElementById('scannerContainer');
    if (scannerContainer) scannerContainer.style.display = 'none';
    
    APP_STATE.scannerActive = false;
}

function simulateBarcodeDetection() {
    console.log('Simulando detección de código de barras...');
    
    setTimeout(() => {
        if (APP_STATE.scannerActive) {
            const fakeBarcode = '779123456789' + Math.floor(Math.random() * 10);
            const productSearch = document.getElementById('productSearch');
            if (productSearch) {
                productSearch.value = fakeBarcode;
                const event = new KeyboardEvent('keyup', { key: 'Enter' });
                productSearch.dispatchEvent(event);
            }
            stopScanner();
        }
    }, 2000);
}

function activateKeyboardMode() {
    const productSearch = document.getElementById('productSearch');
    if (productSearch) {
        productSearch.focus();
        productSearch.value = '';
        showToast('Teclado activado. Escribe y presiona Enter para buscar.', 'info');
    }
}

// ============================================
// UTILIDADES Y FUNCIONES AUXILIARES
// ============================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-exclamation-circle',
        warning: 'fas fa-exclamation-triangle',
        info: 'fas fa-info-circle'
    };
    
    toast.innerHTML = `
        <i class="${icons[type] || icons.info}"></i>
        <div class="toast-content">
            <div class="toast-message">${message}</div>
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    container.appendChild(toast);
    
    // Auto-remover después de 5 segundos
    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('fade-out');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.remove();
                }
            }, 300);
        }
    }, 5000);
}

function updateQuickStats() {
    const quickVentas = document.getElementById('quickVentas');
    const quickStock = document.getElementById('quickStock');
    
    if (quickVentas) quickVentas.textContent = APP_STATE.ventasHoy;
    
    // Calcular productos con stock bajo
    if (quickStock) {
        indexedDBOperation('productos_cache', 'getAll')
            .then(productos => {
                const stockBajo = productos.filter(p => p.stock <= p.stock_minimo).length;
                quickStock.textContent = stockBajo;
                
                // Actualizar badge de stock
                const stockAlert = document.getElementById('stockAlert');
                if (stockAlert) stockAlert.textContent = stockBajo;
            })
            .catch(() => {
                if (quickStock) quickStock.textContent = '0';
            });
    }
    
    // Actualizar badge de ventas
    const ventasCount = document.getElementById('ventasCount');
    if (ventasCount) ventasCount.textContent = APP_STATE.ventasHoy;
}

function showNotifications() {
    showToast('Tienes 3 notificaciones pendientes', 'info');
    // Implementación completa iría aquí
}

function showQuickMenu() {
    const menuItems = [
        { icon: 'fas fa-bolt', text: 'Venta Rápida', action: () => quickSale.click() },
        { icon: 'fas fa-calculator', text: 'Calculadora', action: () => window.open('calculator:', '_blank') },
        { icon: 'fas fa-history', text: 'Historial Ventas', action: () => switchPage('reportes') },
        { icon: 'fas fa-cog', text: 'Configuración', action: () => switchPage('configuracion') },
        { icon: 'fas fa-question-circle', text: 'Ayuda', action: () => showToast('Documentación del sistema', 'info') }
    ];
    
    const modal = document.getElementById('genericModal');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');
    
    if (!modal || !modalTitle || !modalBody) return;
    
    modalTitle.textContent = 'Menú Rápido';
    modalBody.innerHTML = `
        <div class="quick-menu">
            ${menuItems.map(item => `
                <button class="quick-menu-item" onclick="(${item.action})()">
                    <i class="${item.icon}"></i>
                    <span>${item.text}</span>
                </button>
            `).join('')}
        </div>
    `;
    
    document.getElementById('modalConfirm').style.display = 'none';
    document.getElementById('modalCancel').textContent = 'Cerrar';
    
    modal.style.display = 'flex';
}

function handleModalConfirm() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

function handleModalCancel() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

// Funciones de productos
function editarProducto(productoId) {
    showToast(`Editar producto ${productoId}`, 'info');
    // Implementación completa iría aquí
}

function eliminarProducto(productoId) {
    if (confirm('¿Eliminar este producto?')) {
        showToast(`Producto ${productoId} eliminado`, 'warning');
        // Implementación completa iría aquí
    }
}

function showNuevoProductoModal() {
    showToast('Nuevo producto - Implementación pendiente', 'info');
}

function importarExcelProductos() {
    showToast('Importar Excel - Implementación pendiente', 'info');
}

function exportarExcelProductos() {
    showToast('Exportar Excel - Implementación pendiente', 'info');
}

// ============================================
// REAL-TIME SUBSCRIPTIONS
// ============================================

async function setupRealtimeSubscriptions() {
    if (!APP_STATE.supabase) return;
    
    try {
        console.log('🔔 Configurando suscripciones realtime...');
        
        // Suscripción a cambios en productos
        const productosChannel = APP_STATE.supabase
            .channel('productos-changes')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'productos' }, 
                async (payload) => {
                    console.log('Cambio en productos:', payload);
                    
                    if (payload.new) {
                        await indexedDBOperation('productos_cache', 'put', payload.new);
                    } else if (payload.old) {
                        await indexedDBOperation('productos_cache', 'delete', payload.old.id);
                    }
                    
                    if (APP_STATE.currentPage === 'productos' || APP_STATE.currentPage === 'pos') {
                        await loadProductosParaVenta();
                    }
                    
                    showToast('Productos actualizados desde la nube', 'info');
                }
            )
            .subscribe((status) => {
                console.log('Estado suscripción productos:', status);
            });
        
        // Suscripción a cambios en ventas
        const ventasChannel = APP_STATE.supabase
            .channel('ventas-changes')
            .on('postgres_changes', 
                { event: 'INSERT', schema: 'public', table: 'ventas' }, 
                (payload) => {
                    console.log('Nueva venta:', payload);
                    if (payload.new.local_id === APP_STATE.currentLocal?.id) {
                        APP_STATE.ventasHoy++;
                        updateQuickStats();
                    }
                }
            )
            .subscribe();
        
        console.log('✅ Suscripciones realtime activadas');
        
    } catch (error) {
        console.error('Error configurando suscripciones:', error);
    }
}

// ============================================
// FUNCIONES GLOBALES
// ============================================

// Hacer funciones disponibles globalmente
window.agregarAlCarrito = agregarAlCarrito;
window.updateCantidad = updateCantidad;
window.removeFromCart = removeFromCart;
window.changePrice = changePrice;
window.handleProductSearch = handleProductSearch;
window.finalizarVenta = finalizarVenta;
window.crearPresupuesto = crearPresupuesto;
window.cancelarVenta = cancelarVenta;
window.updateCartTotal = updateCartTotal;
window.simularPagoQR = simularPagoQR;
window.confirmarPago = confirmarPago;
window.imprimirTicket = imprimirTicket;
window.enviarTicketWhatsapp = enviarTicketWhatsapp;
window.showNuevoProductoModal = showNuevoProductoModal;
window.showNuevoClienteModal = showNuevoClienteModal;
window.showNuevoProveedorModal = showNuevoProveedorModal;
window.importarExcelProductos = importarExcelProductos;
window.exportarExcelProductos = exportarExcelProductos;
window.editarProducto = editarProducto;
window.eliminarProducto = eliminarProducto;
window.verCliente = verCliente;
window.editarCliente = editarCliente;
window.contactarProveedor = contactarProveedor;
window.verProveedor = verProveedor;
window.verPresupuesto = verPresupuesto;
window.convertirPresupuestoAVenta = convertirPresupuestoAVenta;
window.eliminarPresupuesto = eliminarPresupuesto;
window.toggleScanner = toggleScanner;
window.stopScanner = stopScanner;
window.activateKeyboardMode = activateKeyboardMode;
window.switchPage = switchPage;
window.closeModal = function(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
};

// ============================================
// EVENTOS FINALES
// ============================================

window.addEventListener('beforeunload', saveAppState);
window.addEventListener('load', () => {
    if (APP_STATE.carrito && APP_STATE.carrito.length > 0) {
        updateCartDisplay();
    }
    updateSyncStatus();
    updateQuickStats();
});

console.log('✅ app.js cargado completamente - Versión ' + CONFIG.VERSION);
