// ============================================
// SISTEMA POS - APP.JS - VERSIÓN COMPLETA
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '1.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 5,
    SYNC_INTERVAL: 30000,
    MAX_OFFLINE_OPERATIONS: 100
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
    scannerCode: null
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
    
    // Verificar conexión a Supabase
    const supabaseUrl = localStorage.getItem('supabaseUrl');
    const supabaseKey = localStorage.getItem('supabaseKey');
    
    if (supabaseUrl && supabaseKey) {
        try {
            // Cargar Supabase si no está disponible
            if (!window.supabase) {
                await loadSupabase();
            }
            
            APP_STATE.supabase = window.supabase.createClient(supabaseUrl, supabaseKey);
            console.log('✅ Supabase configurado');
        } catch (error) {
            console.warn('⚠️ Error configurando Supabase:', error);
        }
    }
    
    // Configurar eventos
    setupEventListeners();
    setupNetworkListeners();
    
    // Verificar si hay sesión activa
    const session = localStorage.getItem('pos_session');
    if (session) {
        try {
            const sessionData = JSON.parse(session);
            if (sessionData.expires > Date.now()) {
                APP_STATE.currentUser = sessionData.user;
                showAppScreen();
                loadUserSession();
            } else {
                localStorage.removeItem('pos_session');
                showLoginScreen();
            }
        } catch (e) {
            console.warn('Error cargando sesión:', e);
            showLoginScreen();
        }
    } else {
        showLoginScreen();
    }
    
    // Iniciar sincronización periódica
    setInterval(syncOfflineOperations, CONFIG.SYNC_INTERVAL);
    
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
            reject(event.target.error);
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
    // Lista de almacenes de objetos necesarios
    const objectStores = [
        { name: 'operaciones_pendientes', keyPath: 'id', autoIncrement: true },
        { name: 'productos_cache', keyPath: 'id' },
        { name: 'clientes_cache', keyPath: 'id' },
        { name: 'ventas_offline', keyPath: 'offline_id' },
        { name: 'configuracion', keyPath: 'key' },
        { name: 'locales_cache', keyPath: 'id' },
        { name: 'cajas_cache', keyPath: 'id' },
        { name: 'proveedores_cache', keyPath: 'id' }
    ];
    
    // Crear almacenes de objetos si no existen
    for (const store of objectStores) {
        if (!db.objectStoreNames.contains(store.name)) {
            const newStore = db.createObjectStore(store.name, { 
                keyPath: store.keyPath, 
                autoIncrement: store.autoIncrement 
            });
            
            // Crear índices para búsquedas
            switch (store.name) {
                case 'operaciones_pendientes':
                    newStore.createIndex('type', 'type', { unique: false });
                    newStore.createIndex('status', 'status', { unique: false });
                    break;
                case 'productos_cache':
                    newStore.createIndex('codigo_barras', 'codigo_barras', { unique: true });
                    newStore.createIndex('categoria', 'categoria', { unique: false });
                    break;
                case 'ventas_offline':
                    newStore.createIndex('sync_status', 'sync_status', { unique: false });
                    break;
            }
        }
    }
}

// Operaciones IndexedDB
function indexedDBOperation(storeName, operation, data = null) {
    return new Promise((resolve, reject) => {
        if (!db) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = db.transaction([storeName], 'readwrite');
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
            default:
                reject(new Error(`Operación no soportada: ${operation}`));
                return;
        }
        
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
        
        transaction.oncomplete = () => {};
        transaction.onerror = (event) => {
            console.error('Error en transacción:', event.target.error);
        };
    });
}

// Guardar operación pendiente
async function savePendingOperation(operation) {
    const op = {
        ...operation,
        id: Date.now() + Math.random(),
        status: 'pending',
        timestamp: new Date().toISOString(),
        attempts: 0
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
// FUNCIONES AUXILIARES
// ============================================

async function loadSupabase() {
    return new Promise((resolve, reject) => {
        if (window.supabase) {
            resolve();
            return;
        }
        
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Error cargando Supabase'));
        document.head.appendChild(script);
    });
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
        localStorage.setItem('app_state', JSON.stringify(APP_STATE));
    } catch (e) {
        console.warn('Error guardando estado de la app:', e);
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
    
    // Verificar si ya se configuró local y caja
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        if (initialConfig) initialConfig.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';
        loadLocalesYCajas();
    } else {
        if (initialConfig) initialConfig.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
    }
}

function loadUserSession() {
    try {
        const session = JSON.parse(localStorage.getItem('pos_session'));
        if (session && session.user) {
            APP_STATE.currentUser = session.user;
            const userInfo = document.getElementById('userInfo');
            if (userInfo) userInfo.textContent = `Usuario: ${APP_STATE.currentUser.nombre || APP_STATE.currentUser.email || 'Sin nombre'}`;
        }
        
        const local = localStorage.getItem('currentLocal');
        const caja = localStorage.getItem('currentCaja');
        const turno = localStorage.getItem('currentTurno');
        
        if (local && caja && turno) {
            APP_STATE.currentLocal = JSON.parse(local);
            APP_STATE.currentCaja = JSON.parse(caja);
            APP_STATE.currentTurno = turno;
            
            const localInfo = document.getElementById('localInfo');
            const cajaInfo = document.getElementById('cajaInfo');
            const turnoInfo = document.getElementById('turnoInfo');
            
            if (localInfo) localInfo.textContent = `Local: ${APP_STATE.currentLocal.nombre || 'Sin nombre'}`;
            if (cajaInfo) cajaInfo.textContent = `Caja: ${APP_STATE.currentCaja.numero || 'Sin número'}`;
            if (turnoInfo) turnoInfo.textContent = `Turno: ${APP_STATE.currentTurno || 'Sin turno'}`;
            
            showAppScreen();
        }
    } catch (e) {
        console.warn('Error cargando sesión de usuario:', e);
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
    
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
    if (loginOffline) loginOffline.addEventListener('click', handleOfflineLogin);
    if (logoutBtn) logoutBtn.addEventListener('click', handleLogout);
    
    // Configuración inicial
    const startSession = document.getElementById('startSession');
    if (startSession) startSession.addEventListener('click', startWorkSession);
    
    // Navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const page = e.target.dataset.page;
            switchPage(page);
        });
    });
    
    // POS
    const productSearch = document.getElementById('productSearch');
    const scanBarcode = document.getElementById('scanBarcode');
    const stopScanner = document.getElementById('stopScanner');
    const keyboardMode = document.getElementById('keyboardMode');
    const finalizarVenta = document.getElementById('finalizarVenta');
    const crearPresupuesto = document.getElementById('crearPresupuesto');
    const cancelarVenta = document.getElementById('cancelarVenta');
    const cartDiscount = document.getElementById('cartDiscount');
    const nuevoCliente = document.getElementById('nuevoCliente');
    
    if (productSearch) productSearch.addEventListener('keyup', handleProductSearch);
    if (scanBarcode) scanBarcode.addEventListener('click', toggleScanner);
    if (stopScanner) stopScanner.addEventListener('click', stopScanner);
    if (keyboardMode) keyboardMode.addEventListener('click', activateKeyboardMode);
    if (finalizarVenta) finalizarVenta.addEventListener('click', finalizarVenta);
    if (crearPresupuesto) crearPresupuesto.addEventListener('click', crearPresupuesto);
    if (cancelarVenta) cancelarVenta.addEventListener('click', cancelarVenta);
    if (cartDiscount) cartDiscount.addEventListener('input', updateCartTotal);
    if (nuevoCliente) nuevoCliente.addEventListener('click', showNuevoClienteModal);
    
    // Modal de pagos
    document.querySelectorAll('.payment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.payment-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            const method = e.target.dataset.method;
            showPaymentDetails(method);
        });
    });
    
    const confirmPayment = document.getElementById('confirmPayment');
    const cancelPayment = document.getElementById('cancelPayment');
    
    if (confirmPayment) confirmPayment.addEventListener('click', confirmarPago);
    if (cancelPayment) cancelPayment.addEventListener('click', () => {
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
    });
    
    // Modal genérico
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (modalConfirm) modalConfirm.addEventListener('click', () => {
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
    });
    
    if (modalCancel) modalCancel.addEventListener('click', () => {
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
    });
    
    // Productos
    const nuevoProducto = document.getElementById('nuevoProducto');
    const filterProductos = document.getElementById('filterProductos');
    const filterStockBajo = document.getElementById('filterStockBajo');
    
    if (nuevoProducto) nuevoProducto.addEventListener('click', showNuevoProductoModal);
    if (filterProductos) filterProductos.addEventListener('input', filterProductosList);
    if (filterStockBajo) filterStockBajo.addEventListener('click', filterStockBajo);
    
    // Clientes
    const nuevoClientePage = document.getElementById('nuevoClientePage');
    if (nuevoClientePage) nuevoClientePage.addEventListener('click', showNuevoClienteModal);
    
    // Caja
    const cerrarCaja = document.getElementById('cerrarCaja');
    if (cerrarCaja) cerrarCaja.addEventListener('click', cerrarCajaFunc);
}

function setupNetworkListeners() {
    window.addEventListener('online', () => {
        APP_STATE.isOnline = true;
        updateSyncStatus();
        syncOfflineOperations();
    });
    
    window.addEventListener('offline', () => {
        APP_STATE.isOnline = false;
        updateSyncStatus();
    });
}

// ============================================
// AUTENTICACIÓN Y SESIÓN
// ============================================

async function handleLogin() {
    const emailInput = document.getElementById('loginEmail');
    const passwordInput = document.getElementById('loginPassword');
    const status = document.getElementById('loginStatus');
    
    if (!emailInput || !passwordInput) return;
    
    const email = emailInput.value;
    const password = passwordInput.value;
    
    if (!email || !password) {
        if (status) {
            status.innerHTML = '<p class="error">❌ Completa todos los campos</p>';
            status.classList.add('show');
        }
        return;
    }
    
    // Modo offline: login simple
    if (!APP_STATE.supabase) {
        APP_STATE.currentUser = {
            email: email,
            nombre: email.split('@')[0],
            rol: 'vendedor'
        };
        
        const session = {
            user: APP_STATE.currentUser,
            expires: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        showAppScreen();
        return;
    }
    
    // Login con Supabase
    try {
        if (status) {
            status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
            status.classList.add('show');
        }
        
        const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        
        if (error) throw error;
        
        APP_STATE.currentUser = data.user;
        
        // Guardar sesión
        const session = {
            user: APP_STATE.currentUser,
            expires: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        showAppScreen();
        
        // Cargar datos iniciales
        try {
            await loadInitialData();
        } catch (loadError) {
            console.warn('Error cargando datos iniciales:', loadError);
        }
        
    } catch (error) {
        console.error('Error en login:', error);
        if (status) {
            status.innerHTML = `<p class="error">❌ Error: ${error.message}</p>`;
            status.classList.add('show');
        }
    }
}

function handleOfflineLogin() {
    APP_STATE.currentUser = {
        email: 'offline@modo.com',
        nombre: 'Modo Offline',
        rol: 'vendedor'
    };
    
    const session = {
        user: APP_STATE.currentUser,
        expires: Date.now() + (8 * 60 * 60 * 1000)
    };
    
    localStorage.setItem('pos_session', JSON.stringify(session));
    showAppScreen();
}

function handleLogout() {
    localStorage.removeItem('pos_session');
    localStorage.removeItem('currentLocal');
    localStorage.removeItem('currentCaja');
    localStorage.removeItem('currentTurno');
    APP_STATE.currentUser = null;
    APP_STATE.currentLocal = null;
    APP_STATE.currentCaja = null;
    APP_STATE.currentTurno = null;
    showLoginScreen();
}

async function loadLocalesYCajas() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    
    if (!localSelect || !cajaSelect) return;
    
    // Limpiar selects
    localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
    cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
    
    // Cargar desde caché primero
    try {
        const localesCache = await indexedDBOperation('locales_cache', 'getAll') || [];
        const cajasCache = await indexedDBOperation('cajas_cache', 'getAll') || [];
        
        localesCache.forEach(local => {
            const option = document.createElement('option');
            option.value = local.id;
            option.textContent = local.nombre;
            localSelect.appendChild(option);
        });
        
        cajasCache.forEach(caja => {
            const option = document.createElement('option');
            option.value = caja.id;
            option.textContent = `${caja.numero} - ${caja.nombre || 'Caja'}`;
            cajaSelect.appendChild(option);
        });
    } catch (error) {
        console.warn('Error cargando locales y cajas desde caché:', error);
    }
    
    // Si hay conexión, actualizar desde Supabase
    if (APP_STATE.supabase && APP_STATE.isOnline) {
        try {
            // Cargar locales activos
            const { data: locales, error: localesError } = await APP_STATE.supabase
                .from('locales')
                .select('*')
                .eq('activo', true);
            
            if (!localesError && locales) {
                localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
                locales.forEach(local => {
                    const option = document.createElement('option');
                    option.value = local.id;
                    option.textContent = local.nombre;
                    localSelect.appendChild(option);
                    
                    // Guardar en caché
                    indexedDBOperation('locales_cache', 'put', local);
                });
            }
            
            // Cargar cajas activas
            const { data: cajas, error: cajasError } = await APP_STATE.supabase
                .from('cajas')
                .select('*')
                .eq('activa', true);
            
            if (!cajasError && cajas) {
                cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
                cajas.forEach(caja => {
                    const option = document.createElement('option');
                    option.value = caja.id;
                    option.textContent = `${caja.numero} - ${caja.nombre || 'Caja'}`;
                    cajaSelect.appendChild(option);
                    
                    // Guardar en caché
                    indexedDBOperation('cajas_cache', 'put', caja);
                });
            }
        } catch (error) {
            console.error('Error cargando locales y cajas:', error);
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
        alert('Completa todos los campos requeridos');
        return;
    }
    
    // Buscar datos completos de local y caja
    let localData, cajaData;
    
    try {
        const locales = await indexedDBOperation('locales_cache', 'getAll') || [];
        const cajas = await indexedDBOperation('cajas_cache', 'getAll') || [];
        
        localData = locales.find(l => l.id === localSelect.value);
        cajaData = cajas.find(c => c.id === cajaSelect.value);
    } catch (error) {
        console.warn('Error buscando datos en caché:', error);
    }
    
    APP_STATE.currentLocal = localData || { 
        id: localSelect.value, 
        nombre: localSelect.options[localSelect.selectedIndex].text 
    };
    APP_STATE.currentCaja = cajaData || { 
        id: cajaSelect.value, 
        numero: cajaSelect.options[cajaSelect.selectedIndex].text.split(' - ')[0] 
    };
    APP_STATE.currentTurno = turnoSelect.value;
    
    // Guardar en localStorage
    localStorage.setItem('currentLocal', JSON.stringify(APP_STATE.currentLocal));
    localStorage.setItem('currentCaja', JSON.stringify(APP_STATE.currentCaja));
    localStorage.setItem('currentTurno', APP_STATE.currentTurno);
    
    // Actualizar UI
    const localInfo = document.getElementById('localInfo');
    const cajaInfo = document.getElementById('cajaInfo');
    const turnoInfo = document.getElementById('turnoInfo');
    
    if (localInfo) localInfo.textContent = `Local: ${APP_STATE.currentLocal.nombre}`;
    if (cajaInfo) cajaInfo.textContent = `Caja: ${APP_STATE.currentCaja.numero}`;
    if (turnoInfo) turnoInfo.textContent = `Turno: ${APP_STATE.currentTurno}`;
    
    // Crear cierre de caja inicial
    if (APP_STATE.supabase && saldoInicial.value) {
        try {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .insert([{
                    local_id: APP_STATE.currentLocal.id,
                    caja_id: APP_STATE.currentCaja.id,
                    usuario_id: APP_STATE.currentUser ? APP_STATE.currentUser.id : 'offline',
                    turno: APP_STATE.currentTurno,
                    fecha: new Date().toISOString().split('T')[0],
                    saldo_inicial: parseFloat(saldoInicial.value) || 0,
                    estado: 'abierto'
                }]);
            
            if (error) throw error;
        } catch (error) {
            console.error('Error creando cierre de caja:', error);
            // Guardar en modo offline
            await savePendingOperation({
                type: 'cierre_caja',
                data: {
                    local_id: APP_STATE.currentLocal.id,
                    caja_id: APP_STATE.currentCaja.id,
                    usuario_id: APP_STATE.currentUser ? APP_STATE.currentUser.id : 'offline',
                    turno: APP_STATE.currentTurno,
                    fecha: new Date().toISOString().split('T')[0],
                    saldo_inicial: parseFloat(saldoInicial.value) || 0,
                    estado: 'abierto'
                }
            });
        }
    }
    
    // Mostrar aplicación principal
    const initialConfig = document.getElementById('initialConfig');
    const mainApp = document.getElementById('mainApp');
    
    if (initialConfig) initialConfig.style.display = 'none';
    if (mainApp) mainApp.style.display = 'block';
    
    // Cargar datos necesarios
    await loadProductos();
}

// ============================================
// NAVEGACIÓN
// ============================================

function switchPage(pageName) {
    // Actualizar navegación
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
        currentPage.textContent = pageName.charAt(0).toUpperCase() + pageName.slice(1);
    }
    
    // Cargar datos de la página si es necesario
    APP_STATE.currentPage = pageName;
    
    switch(pageName) {
        case 'productos':
            loadProductos();
            break;
        case 'clientes':
            loadClientes();
            break;
        case 'caja':
            loadCajaResumen();
            break;
        case 'proveedores':
            loadProveedores();
            break;
    }
}

// ============================================
// SISTEMA DE SINCRONIZACIÓN
// ============================================

async function syncOfflineOperations() {
    if (!APP_STATE.isOnline || APP_STATE.isSyncing || !db) return;
    
    APP_STATE.isSyncing = true;
    updateSyncStatus();
    
    try {
        const operations = await indexedDBOperation('operaciones_pendientes', 'getAll');
        
        for (const op of operations) {
            if (op.attempts > 5) {
                // Marcar como fallida después de 5 intentos
                op.status = 'failed';
                await indexedDBOperation('operaciones_pendientes', 'put', op);
                continue;
            }
            
            try {
                // Intentar sincronizar
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
                    case 'cierre_caja':
                        success = await syncCierreCaja(op.data);
                        break;
                }
                
                if (success) {
                    op.status = 'synced';
                    op.synced_at = new Date().toISOString();
                    await indexedDBOperation('operaciones_pendientes', 'put', op);
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
        
        // Sincronizar caché de productos
        await syncProductosCache();
        
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
        const { data, error } = await APP_STATE.supabase
            .from('ventas')
            .insert([ventaData.venta])
            .select()
            .single();
        
        if (error) throw error;
        
        // Sincronizar items de venta
        for (const item of ventaData.items) {
            item.venta_id = data.id;
            const { error: itemError } = await APP_STATE.supabase
                .from('venta_items')
                .insert([item]);
            
            if (itemError) throw itemError;
        }
        
        // Sincronizar pago
        if (ventaData.pago) {
            ventaData.pago.venta_id = data.id;
            const { error: pagoError } = await APP_STATE.supabase
                .from('pagos')
                .insert([ventaData.pago]);
            
            if (pagoError) throw pagoError;
        }
        
        // Marcar venta offline como sincronizada
        await indexedDBOperation('ventas_offline', 'delete', ventaData.offline_id);
        
        return true;
    } catch (error) {
        console.error('Error sincronizando venta:', error);
        return false;
    }
}

async function syncProductosCache() {
    if (!APP_STATE.supabase) return;
    
    try {
        const { data: productos, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .order('updated_at', { ascending: false })
            .limit(100);
        
        if (error) throw error;
        
        // Actualizar caché local
        for (const producto of productos) {
            await indexedDBOperation('productos_cache', 'put', producto);
        }
        
        console.log(`✅ Cache de productos actualizado: ${productos.length} productos`);
    } catch (error) {
        console.error('❌ Error actualizando cache de productos:', error);
    }
}

// ============================================
// GESTIÓN DE PRODUCTOS
// ============================================

async function loadProductos() {
    try {
        let productos = [];
        
        // Intentar cargar desde caché local primero
        try {
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        } catch (error) {
            console.warn('Error cargando productos desde cache:', error);
        }
        
        // Si no hay en caché y hay conexión, cargar desde Supabase
        if ((!productos || productos.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            try {
                const { data, error } = await APP_STATE.supabase
                    .from('productos')
                    .select('*')
                    .eq('activo', true)
                    .order('nombre');
                
                if (error) throw error;
                
                productos = data || [];
                
                // Guardar en caché
                for (const producto of productos) {
                    await indexedDBOperation('productos_cache', 'put', producto);
                }
            } catch (error) {
                console.error('Error cargando productos desde Supabase:', error);
            }
        }
        
        // Si aún no hay productos, crear algunos de ejemplo
        if (!productos || productos.length === 0) {
            productos = [
                {
                    id: 'prod-1-' + Date.now(),
                    codigo_barras: '7791234567890',
                    nombre: 'Coca Cola 2.25L',
                    descripcion: 'Bebida cola 2.25 litros',
                    precio_costo: 450,
                    porcentaje_ganancia: 30,
                    precio_venta: 585,
                    stock: 100,
                    stock_minimo: 10,
                    categoria: 'Bebidas',
                    activo: true
                },
                {
                    id: 'prod-2-' + Date.now(),
                    codigo_barras: '7791234567891',
                    nombre: 'Pan de Molde Integral',
                    descripcion: 'Pan de molde integral 500g',
                    precio_costo: 320,
                    porcentaje_ganancia: 35,
                    precio_venta: 432,
                    stock: 50,
                    stock_minimo: 5,
                    categoria: 'Panadería',
                    activo: true
                },
                {
                    id: 'prod-3-' + Date.now(),
                    codigo_barras: '7791234567892',
                    nombre: 'Leche Entera 1L',
                    descripcion: 'Leche entera larga vida 1 litro',
                    precio_costo: 280,
                    porcentaje_ganancia: 40,
                    precio_venta: 392,
                    stock: 80,
                    stock_minimo: 15,
                    categoria: 'Lácteos',
                    activo: true
                },
                {
                    id: 'prod-4-' + Date.now(),
                    codigo_barras: '7791234567893',
                    nombre: 'Arroz 1kg',
                    descripcion: 'Arroz blanco 1kg',
                    precio_costo: 380,
                    porcentaje_ganancia: 25,
                    precio_venta: 475,
                    stock: 60,
                    stock_minimo: 10,
                    categoria: 'Almacén',
                    activo: true
                }
            ];
            
            // Guardar en caché
            for (const producto of productos) {
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        // Mostrar productos en la página correspondiente
        if (APP_STATE.currentPage === 'productos') {
            displayProductos(productos);
        }
        
    } catch (error) {
        console.error('Error cargando productos:', error);
    }
}

function displayProductos(productos) {
    const container = document.getElementById('productosList');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (productos.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #9ca3af;">No hay productos disponibles</div>';
        return;
    }
    
    productos.forEach(producto => {
        const stockClass = producto.stock <= producto.stock_minimo ? 'bajo' : 'normal';
        const precioVenta = producto.precio_venta || producto.precio_costo * (1 + (producto.porcentaje_ganancia || 30) / 100);
        
        const card = document.createElement('div');
        card.className = 'producto-card';
        card.innerHTML = `
            <div class="producto-header">
                <h4>${producto.nombre}</h4>
                <span class="producto-codigo">${producto.codigo_barras || 'Sin código'}</span>
            </div>
            <p class="producto-descripcion">${producto.descripcion || ''}</p>
            <div class="producto-info">
                <span class="producto-stock ${stockClass}">Stock: ${producto.stock || 0}</span>
                <span class="producto-precio">$${precioVenta.toFixed(2)}</span>
            </div>
            <div class="producto-actions">
                <button class="btn btn-outline btn-sm" onclick="agregarAlCarrito('${producto.id}')">
                    ➕ Agregar
                </button>
            </div>
        `;
        
        container.appendChild(card);
    });
}

function filterProductosList() {
    const searchInput = document.getElementById('filterProductos');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const productos = Array.from(document.querySelectorAll('.producto-card'));
    
    productos.forEach(card => {
        const nombre = card.querySelector('h4')?.textContent.toLowerCase() || '';
        const codigo = card.querySelector('.producto-codigo')?.textContent.toLowerCase() || '';
        const descripcion = card.querySelector('.producto-descripcion')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || codigo.includes(searchTerm) || descripcion.includes(searchTerm)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

function filterStockBajo() {
    const productos = Array.from(document.querySelectorAll('.producto-card'));
    
    productos.forEach(card => {
        const stockText = card.querySelector('.producto-stock')?.textContent || '';
        const stockMatch = stockText.match(/Stock: (\d+)/);
        
        if (stockMatch) {
            const stock = parseInt(stockMatch[1]);
            if (stock > 10) {
                card.style.display = 'none';
            } else {
                card.style.display = 'block';
            }
        }
    });
}

// ============================================
// SISTEMA POS - CARRITO
// ============================================

async function handleProductSearch(e) {
    if (e.key === 'Enter') {
        const searchTerm = e.target.value.trim();
        if (!searchTerm) return;
        
        let producto = null;
        
        // Buscar por código de barras en caché
        try {
            const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
            producto = productos.find(p => 
                (p.codigo_barras && p.codigo_barras === searchTerm) || 
                (p.nombre && p.nombre.toLowerCase().includes(searchTerm.toLowerCase()))
            );
        } catch (error) {
            console.warn('Error buscando producto en cache:', error);
        }
        
        // Si no se encuentra y hay conexión, buscar en Supabase
        if (!producto && APP_STATE.supabase && APP_STATE.isOnline) {
            try {
                const { data, error } = await APP_STATE.supabase
                    .from('productos')
                    .select('*')
                    .or(`codigo_barras.eq.${searchTerm},nombre.ilike.%${searchTerm}%`)
                    .eq('activo', true)
                    .single();
                
                if (!error && data) {
                    producto = data;
                    // Guardar en caché
                    await indexedDBOperation('productos_cache', 'put', producto);
                }
            } catch (error) {
                console.warn('Error buscando producto en Supabase:', error);
            }
        }
        
        if (producto) {
            agregarAlCarrito(producto);
            e.target.value = '';
            e.target.focus();
        } else {
            alert('Producto no encontrado');
        }
    }
}

async function agregarAlCarrito(productoId) {
    let producto = null;
    
    // Si se pasa solo el ID, buscar el producto completo
    if (typeof productoId === 'string') {
        try {
            // Buscar en caché primero
            const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
            producto = productos.find(p => p.id === productoId);
            
            // Si no está en caché y hay conexión, buscar en Supabase
            if (!producto && APP_STATE.supabase && APP_STATE.isOnline) {
                const { data, error } = await APP_STATE.supabase
                    .from('productos')
                    .select('*')
                    .eq('id', productoId)
                    .single();
                
                if (!error && data) {
                    producto = data;
                    await indexedDBOperation('productos_cache', 'put', producto);
                }
            }
        } catch (error) {
            console.error('Error buscando producto:', error);
        }
        
        // Si aún no se encuentra, crear uno de ejemplo
        if (!producto) {
            producto = {
                id: productoId,
                nombre: `Producto ${productoId.slice(0, 8)}`,
                precio_venta: 100 + Math.floor(Math.random() * 900),
                stock: 10
            };
        }
    } else {
        producto = productoId;
    }
    
    // Verificar stock
    if (producto.stock <= 0) {
        alert('⚠️ Producto sin stock disponible');
        return;
    }
    
    // Verificar si ya está en el carrito
    const existingItem = APP_STATE.carrito.find(item => item.id === producto.id);
    
    if (existingItem) {
        // Verificar que no exceda el stock
        if (existingItem.cantidad >= producto.stock) {
            alert('⚠️ No hay suficiente stock disponible');
            return;
        }
        existingItem.cantidad += 1;
        existingItem.subtotal = existingItem.cantidad * existingItem.precio;
    } else {
        APP_STATE.carrito.push({
            id: producto.id,
            nombre: producto.nombre,
            precio: producto.precio_venta || producto.precio || 100,
            cantidad: 1,
            subtotal: producto.precio_venta || producto.precio || 100
        });
    }
    
    updateCartDisplay();
}

function updateCartDisplay() {
    const container = document.getElementById('cartItems');
    const subtotalElem = document.getElementById('cartSubtotal');
    const totalElem = document.getElementById('cartTotal');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    if (APP_STATE.carrito.length === 0) {
        container.innerHTML = `
            <div class="cart-empty" style="text-align: center; padding: 40px; color: #9ca3af;">
                <p>🎯 Busca y agrega productos al carrito</p>
                <p>🔍 Usa el buscador o escanea códigos de barras</p>
            </div>
        `;
        if (subtotalElem) subtotalElem.textContent = '$0.00';
        if (totalElem) totalElem.textContent = '$0.00';
        return;
    }
    
    let subtotal = 0;
    
    APP_STATE.carrito.forEach((item, index) => {
        subtotal += item.subtotal || 0;
        
        const itemElem = document.createElement('div');
        itemElem.className = 'cart-item';
        itemElem.innerHTML = `
            <span>${item.nombre || 'Producto'}</span>
            <span>
                <button onclick="updateCantidad(${index}, -1)">-</button>
                ${item.cantidad || 1}
                <button onclick="updateCantidad(${index}, 1)">+</button>
            </span>
            <span>$${(item.precio || 0).toFixed(2)}</span>
            <span>$${(item.subtotal || 0).toFixed(2)}</span>
            <span>
                <button onclick="removeFromCart(${index})" class="btn btn-danger btn-sm">🗑️</button>
                <button onclick="changePrice(${index})" class="btn btn-warning btn-sm">💰</button>
            </span>
        `;
        
        container.appendChild(itemElem);
    });
    
    if (subtotalElem) subtotalElem.textContent = `$${subtotal.toFixed(2)}`;
    updateCartTotal();
}

function updateCantidad(index, delta) {
    const item = APP_STATE.carrito[index];
    if (!item) return;
    
    const nuevaCantidad = (item.cantidad || 1) + delta;
    
    if (nuevaCantidad < 1) {
        removeFromCart(index);
        return;
    }
    
    item.cantidad = nuevaCantidad;
    item.subtotal = item.cantidad * (item.precio || 0);
    updateCartDisplay();
}

function removeFromCart(index) {
    APP_STATE.carrito.splice(index, 1);
    updateCartDisplay();
}

function changePrice(index) {
    const item = APP_STATE.carrito[index];
    if (!item) return;
    
    const nuevoPrecio = prompt('Nuevo precio:', item.precio ? item.precio.toFixed(2) : '0.00');
    
    if (nuevoPrecio && !isNaN(nuevoPrecio)) {
        item.precio = parseFloat(nuevoPrecio);
        item.subtotal = (item.cantidad || 1) * item.precio;
        updateCartDisplay();
    }
}

function updateCartTotal() {
    const subtotal = APP_STATE.carrito.reduce((sum, item) => sum + (item.subtotal || 0), 0);
    const discountInput = document.getElementById('cartDiscount');
    const discount = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    const total = Math.max(0, subtotal - discount);
    
    const totalElem = document.getElementById('cartTotal');
    if (totalElem) totalElem.textContent = `$${total.toFixed(2)}`;
}

function cancelarVenta() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito ya está vacío');
        return;
    }
    
    if (confirm('¿Cancelar la venta actual? Se perderán todos los items del carrito.')) {
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '0';
    }
}

// ============================================
// FINALIZAR VENTA
// ============================================

function finalizarVenta() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
        return;
    }
    
    // Mostrar modal de métodos de pago
    const paymentModal = document.getElementById('paymentModal');
    if (paymentModal) {
        paymentModal.style.display = 'flex';
        showPaymentDetails('efectivo'); // Mostrar efectivo por defecto
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
                <div class="form-group">
                    <label>Monto recibido:</label>
                    <input type="number" id="montoRecibido" placeholder="0.00" min="${total}" step="0.01" value="${total}">
                </div>
                <div class="form-group">
                    <label>Vuelto:</label>
                    <input type="number" id="vuelto" placeholder="0.00" value="0.00" readonly>
                </div>
            `;
            break;
        case 'tarjeta':
            html = `
                <div class="form-group">
                    <label>Número de tarjeta (últimos 4 dígitos):</label>
                    <input type="text" id="tarjetaNumero" placeholder="**** **** **** 1234" maxlength="4">
                </div>
                <div class="form-group">
                    <label>Cuotas:</label>
                    <select id="tarjetaCuotas">
                        <option value="1">1 cuota</option>
                        <option value="3">3 cuotas</option>
                        <option value="6">6 cuotas</option>
                        <option value="12">12 cuotas</option>
                    </select>
                </div>
            `;
            break;
        case 'transferencia':
            html = `
                <div class="form-group">
                    <label>Número de transferencia:</label>
                    <input type="text" id="transferenciaNumero" placeholder="TRF-001">
                </div>
                <div class="form-group">
                    <label>Banco:</label>
                    <input type="text" id="transferenciaBanco" placeholder="Nombre del banco">
                </div>
            `;
            break;
        case 'qr':
            html = `
                <div class="form-group">
                    <label>Escanea el código QR para pagar</label>
                    <div style="text-align: center; padding: 20px; background: #f0f0f0; border-radius: 10px;">
                        <p>💰 QR de pago</p>
                        <p>Monto: $${total.toFixed(2)}</p>
                        <button class="btn btn-primary" onclick="simularPagoQR()" style="margin-top: 10px;">
                            Simular Pago QR
                        </button>
                    </div>
                </div>
            `;
            break;
        case 'cuenta':
            html = `
                <div class="form-group">
                    <label>Cliente con cuenta corriente:</label>
                    <select id="clienteCuenta">
                        <option value="">Seleccionar cliente...</option>
                        <option value="cliente1">Cliente Contado</option>
                        <option value="cliente2">Cliente Cuenta Corriente</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Observaciones:</label>
                    <textarea id="cuentaObservaciones" placeholder="Observaciones del pago..." rows="3"></textarea>
                </div>
            `;
            break;
    }
    
    container.innerHTML = html;
    
    // Actualizar vuelto en tiempo real para efectivo
    if (method === 'efectivo') {
        const montoInput = document.getElementById('montoRecibido');
        const vueltoInput = document.getElementById('vuelto');
        
        if (montoInput && vueltoInput) {
            montoInput.addEventListener('input', () => {
                const monto = parseFloat(montoInput.value) || 0;
                const vuelto = monto - total;
                vueltoInput.value = vuelto > 0 ? vuelto.toFixed(2) : '0.00';
            });
            
            // Calcular vuelto inicial
            const monto = parseFloat(montoInput.value) || 0;
            const vuelto = monto - total;
            vueltoInput.value = vuelto > 0 ? vuelto.toFixed(2) : '0.00';
        }
    }
}

function simularPagoQR() {
    alert('✅ Pago con QR simulado correctamente');
    confirmarPago();
}

async function confirmarPago() {
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    
    // Determinar método de pago
    let metodo = 'efectivo';
    const activePaymentBtn = document.querySelector('.payment-btn.active');
    if (activePaymentBtn) {
        metodo = activePaymentBtn.dataset.method || 'efectivo';
    }
    
    // Obtener detalles adicionales según el método
    let referencia = '';
    let detalles = {};
    
    switch (metodo) {
        case 'efectivo':
            const montoRecibido = document.getElementById('montoRecibido');
            const vuelto = document.getElementById('vuelto');
            referencia = `EF-${Date.now().toString().slice(-6)}`;
            detalles = {
                monto_recibido: parseFloat(montoRecibido?.value) || total,
                vuelto: parseFloat(vuelto?.value) || 0
            };
            break;
        case 'tarjeta':
            const tarjetaNumero = document.getElementById('tarjetaNumero');
            const tarjetaCuotas = document.getElementById('tarjetaCuotas');
            referencia = `TJ-${Date.now().toString().slice(-6)}`;
            detalles = {
                ultimos_digitos: tarjetaNumero?.value || '',
                cuotas: parseInt(tarjetaCuotas?.value) || 1
            };
            break;
        case 'transferencia':
            const transferenciaNumero = document.getElementById('transferenciaNumero');
            const transferenciaBanco = document.getElementById('transferenciaBanco');
            referencia = `TRF-${Date.now().toString().slice(-6)}`;
            detalles = {
                numero: transferenciaNumero?.value || '',
                banco: transferenciaBanco?.value || ''
            };
            break;
        case 'qr':
            referencia = `QR-${Date.now().toString().slice(-6)}`;
            detalles = { metodo: 'QR' };
            break;
        case 'cuenta':
            const clienteCuenta = document.getElementById('clienteCuenta');
            referencia = `CC-${Date.now().toString().slice(-6)}`;
            detalles = {
                cliente_id: clienteCuenta?.value || '',
                observaciones: document.getElementById('cuentaObservaciones')?.value || ''
            };
            break;
    }
    
    // Crear venta
    const venta = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        caja_id: APP_STATE.currentCaja?.id || 'offline',
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        cliente_id: metodo === 'cuenta' ? detalles.cliente_id : null,
        total: total,
        descuento: parseFloat(document.getElementById('cartDiscount')?.value) || 0,
        estado: 'completada',
        tipo_venta: metodo === 'cuenta' ? 'cuenta_corriente' : 'contado',
        offline_id: 'venta_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    // Crear items de venta
    const items = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        cantidad: item.cantidad || 1,
        precio_unitario: item.precio || 0,
        subtotal: item.subtotal || 0,
        descuento: 0,
        created_at: new Date().toISOString()
    }));
    
    // Crear pago
    const pago = {
        metodo: metodo,
        monto: total,
        referencia: referencia,
        estado: 'completado',
        detalles: detalles,
        offline_id: 'pago_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            // Online: Guardar en Supabase
            const { data: ventaData, error: ventaError } = await APP_STATE.supabase
                .from('ventas')
                .insert([venta])
                .select()
                .single();
            
            if (ventaError) throw ventaError;
            
            // Guardar items
            for (const item of items) {
                item.venta_id = ventaData.id;
                const { error: itemError } = await APP_STATE.supabase
                    .from('venta_items')
                    .insert([item]);
                
                if (itemError) throw itemError;
            }
            
            // Guardar pago
            pago.venta_id = ventaData.id;
            const { error: pagoError } = await APP_STATE.supabase
                .from('pagos')
                .insert([pago]);
            
            if (pagoError) throw pagoError;
            
            // Actualizar stock de productos (simulado)
            for (const item of APP_STATE.carrito) {
                try {
                    // Buscar producto actual
                    const { data: productoActual } = await APP_STATE.supabase
                        .from('productos')
                        .select('stock')
                        .eq('id', item.id)
                        .single();
                    
                    if (productoActual) {
                        const nuevoStock = productoActual.stock - (item.cantidad || 1);
                        await APP_STATE.supabase
                            .from('productos')
                            .update({ stock: nuevoStock })
                            .eq('id', item.id);
                    }
                } catch (stockError) {
                    console.warn('Error actualizando stock:', stockError);
                }
            }
            
        } else {
            // Offline: Guardar en IndexedDB
            const ventaOffline = {
                ...venta,
                items: items,
                pago: pago,
                carrito: APP_STATE.carrito // Guardar carrito completo para sincronización
            };
            
            await indexedDBOperation('ventas_offline', 'add', ventaOffline);
            
            await savePendingOperation({
                type: 'venta',
                data: {
                    venta: venta,
                    items: items,
                    pago: pago,
                    carrito: APP_STATE.carrito,
                    offline_id: venta.offline_id
                }
            });
        }
        
        // Mostrar ticket
        mostrarTicket(venta, items, pago);
        
        // Reiniciar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '0';
        
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

function mostrarTicket(venta, items, pago) {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (!modal || !modalBody || !modalTitle) return;
    
    const ticketContent = `
        <div class="ticket">
            <h3>${APP_STATE.currentLocal?.nombre || 'MI NEGOCIO'}</h3>
            <p>${APP_STATE.currentLocal?.direccion || 'Dirección no especificada'}</p>
            <p>Tel: ${APP_STATE.currentLocal?.telefono || 'N/A'}</p>
            <hr>
            <p>Fecha: ${new Date().toLocaleString()}</p>
            <p>Venta: ${venta.offline_id?.slice(0, 10) || 'N/A'}</p>
            <p>Vendedor: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Offline'}</p>
            <hr>
            <h4>PRODUCTOS:</h4>
            ${items.map(item => `
                <div style="display: flex; justify-content: space-between; margin: 5px 0;">
                    <span>${item.cantidad} x $${item.precio_unitario.toFixed(2)}</span>
                    <span>$${item.subtotal.toFixed(2)}</span>
                </div>
            `).join('')}
            <hr>
            <div style="display: flex; justify-content: space-between; font-weight: bold;">
                <span>TOTAL:</span>
                <span>$${venta.total.toFixed(2)}</span>
            </div>
            <hr>
            <p>MÉTODO: ${pago.metodo.toUpperCase()}</p>
            <p>REF: ${pago.referencia}</p>
            <hr>
            <p style="text-align: center; font-weight: bold;">¡Gracias por su compra!</p>
            <p style="text-align: center; font-size: 0.9em; color: #666;">Sistema POS v${CONFIG.VERSION}</p>
        </div>
    `;
    
    modalTitle.textContent = 'Ticket de Venta';
    modalBody.innerHTML = ticketContent;
    
    if (modalConfirm) {
        modalConfirm.textContent = 'Imprimir';
        modalConfirm.onclick = () => {
            const printContent = ticketContent;
            const printWindow = window.open('', '_blank');
            printWindow.document.write(`
                <html>
                    <head>
                        <title>Ticket de Venta</title>
                        <style>
                            body { font-family: 'Courier New', monospace; padding: 20px; }
                            .ticket { max-width: 300px; margin: 0 auto; }
                            hr { border: none; border-top: 1px dashed #000; margin: 10px 0; }
                        </style>
                    </head>
                    <body>
                        ${printContent}
                        <script>
                            window.onload = function() {
                                window.print();
                                setTimeout(() => window.close(), 500);
                            }
                        </script>
                    </body>
                </html>
            `);
        };
    }
    
    if (modalCancel) {
        modalCancel.textContent = 'Cerrar';
        modalCancel.onclick = () => {
            modal.style.display = 'none';
        };
    }
    
    modal.style.display = 'flex';
}

// ============================================
// PRESUPUESTOS
// ============================================

async function crearPresupuesto() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
        return;
    }
    
    const clienteSelect = document.getElementById('selectCliente');
    const clienteId = clienteSelect ? clienteSelect.value : null;
    
    // Pedir validez del presupuesto (default 30 días)
    const defaultDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const validoHasta = prompt('Válido hasta (dd/mm/aaaa):', 
        defaultDate.toLocaleDateString('es-AR'));
    
    if (!validoHasta) return;
    
    // Convertir fecha al formato YYYY-MM-DD
    const [dia, mes, anio] = validoHasta.split('/');
    const fechaValida = `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    
    const presupuesto = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        cliente_id: clienteId,
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        total: total,
        valido_hasta: fechaValida,
        estado: 'pendiente',
        offline_id: 'presupuesto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending',
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
            
            alert('✅ Presupuesto creado correctamente - N°: ' + (data.numero_presupuesto || data.id.slice(0, 8)));
        } else {
            await savePendingOperation({
                type: 'presupuesto',
                data: { 
                    presupuesto: presupuesto, 
                    items: items 
                }
            });
            
            alert('✅ Presupuesto guardado localmente. Se sincronizará cuando haya conexión.');
        }
        
        // Limpiar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '0';
        
    } catch (error) {
        console.error('Error creando presupuesto:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

// ============================================
// SCANNER DE CÓDIGO DE BARRAS
// ============================================

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
        // Solicitar acceso a la cámara
        scannerStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        
        scannerVideo.srcObject = scannerStream;
        scannerContainer.style.display = 'block';
        APP_STATE.scannerActive = true;
        
        // En una implementación real, aquí usarías una librería como Quagga.js
        // Por ahora, solo mostramos la cámara
        console.log('📷 Cámara activada para escaneo');
        
    } catch (error) {
        console.error('Error accediendo a la cámara:', error);
        alert('No se pudo acceder a la cámara. Asegúrate de conceder los permisos necesarios.');
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

function activateKeyboardMode() {
    const productSearch = document.getElementById('productSearch');
    if (productSearch) {
        productSearch.focus();
        productSearch.value = '';
        productSearch.select();
    }
}

// ============================================
// UTILIDADES
// ============================================

function updateSyncStatus() {
    const statusBtn = document.getElementById('syncStatus');
    if (!statusBtn) return;
    
    if (!APP_STATE.isOnline) {
        statusBtn.textContent = '🔴 Offline';
        statusBtn.className = 'btn-status offline';
        statusBtn.title = 'Modo offline activado';
    } else if (APP_STATE.isSyncing) {
        statusBtn.textContent = '🟡 Sincronizando...';
        statusBtn.className = 'btn-status syncing';
        statusBtn.title = 'Sincronizando datos...';
    } else {
        statusBtn.textContent = '🟢 Online';
        statusBtn.className = 'btn-status online';
        statusBtn.title = 'Conectado a Supabase';
    }
}

// ============================================
// FUNCIONES DE INICIALIZACIÓN DE DATOS
// ============================================

async function loadInitialData() {
    // Cargar productos
    await loadProductos();
    
    // Cargar locales y cajas si estamos en Supabase
    if (APP_STATE.supabase && APP_STATE.isOnline) {
        await loadLocalesYCajas();
    }
}

async function loadClientes() {
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: #9ca3af;">Cargando clientes...</div>';
    
    let clientes = [];
    
    try {
        // Intentar cargar desde caché
        clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        
        // Si no hay en caché y hay conexión, cargar desde Supabase
        if ((!clientes || clientes.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('clientes')
                .select('*')
                .eq('activo', true)
                .order('nombre');
            
            if (!error && data) {
                clientes = data;
                
                // Guardar en caché
                for (const cliente of clientes) {
                    await indexedDBOperation('clientes_cache', 'put', cliente);
                }
            }
        }
        
        // Si aún no hay clientes, mostrar algunos de ejemplo
        if (!clientes || clientes.length === 0) {
            clientes = [
                {
                    id: 'cli-1-' + Date.now(),
                    nombre: 'Consumidor Final',
                    apellido: '',
                    tipo_documento: 'DNI',
                    numero_documento: '00000000',
                    telefono: '',
                    email: '',
                    tipo_cliente: 'consumidor_final',
                    saldo: 0,
                    categoria_iva: 'consumidor_final'
                },
                {
                    id: 'cli-2-' + Date.now(),
                    nombre: 'Juan',
                    apellido: 'Pérez',
                    tipo_documento: 'DNI',
                    numero_documento: '30123456',
                    telefono: '011-1234-5678',
                    email: 'juan@email.com',
                    tipo_cliente: 'contado',
                    saldo: 0,
                    categoria_iva: 'monotributista'
                },
                {
                    id: 'cli-3-' + Date.now(),
                    nombre: 'María',
                    apellido: 'Gómez',
                    tipo_documento: 'DNI',
                    numero_documento: '28987654',
                    telefono: '011-8765-4321',
                    email: 'maria@email.com',
                    tipo_cliente: 'cuenta_corriente',
                    saldo: 1500.50,
                    limite_credito: 10000,
                    categoria_iva: 'responsable_inscripto'
                }
            ];
            
            // Guardar en caché
            for (const cliente of clientes) {
                await indexedDBOperation('clientes_cache', 'put', cliente);
            }
        }
        
        // Mostrar clientes
        if (clientes.length === 0) {
            container.innerHTML = '<div style="text-align: center; padding: 40px; color: #9ca3af;">No hay clientes disponibles</div>';
            return;
        }
        
        let html = '';
        clientes.forEach(cliente => {
            const saldoClass = cliente.saldo > 0 ? 'negativo' : 'positivo';
            html += `
                <div class="cliente-row">
                    <span>${cliente.nombre} ${cliente.apellido || ''}</span>
                    <span>${cliente.numero_documento || 'Sin DNI'}</span>
                    <span>${cliente.telefono || 'Sin teléfono'}</span>
                    <span class="cliente-saldo ${saldoClass}">$${(cliente.saldo || 0).toFixed(2)}</span>
                </div>
            `;
        });
        
        container.innerHTML = html;
        
    } catch (error) {
        console.error('Error cargando clientes:', error);
        container.innerHTML = '<div style="text-align: center; padding: 40px; color: #ef4444;">Error cargando clientes</div>';
    }
}

async function loadProveedores() {
    // Similar a loadClientes pero para proveedores
    console.log('Cargando proveedores...');
}

async function loadCajaResumen() {
    const saldoInicialElem = document.getElementById('saldoInicialResumen');
    const ventasEfectivoElem = document.getElementById('ventasEfectivo');
    const ventasTarjetaElem = document.getElementById('ventasTarjeta');
    const totalVentasElem = document.getElementById('totalVentas');
    const saldoFinalElem = document.getElementById('saldoFinal');
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        alert('Primero configura el local y la caja');
        return;
    }
    
    // Valores de ejemplo - en una implementación real buscarías estos datos
    const saldoInicial = 10000;
    const ventasEfectivo = 12500;
    const ventasTarjeta = 8500;
    const totalVentas = ventasEfectivo + ventasTarjeta;
    const saldoFinal = saldoInicial + ventasEfectivo; // Solo el efectivo suma a la caja
    
    if (saldoInicialElem) saldoInicialElem.textContent = `$${saldoInicial.toFixed(2)}`;
    if (ventasEfectivoElem) ventasEfectivoElem.textContent = `$${ventasEfectivo.toFixed(2)}`;
    if (ventasTarjetaElem) ventasTarjetaElem.textContent = `$${ventasTarjeta.toFixed(2)}`;
    if (totalVentasElem) totalVentasElem.textContent = `$${totalVentas.toFixed(2)}`;
    if (saldoFinalElem) saldoFinalElem.textContent = `$${saldoFinal.toFixed(2)}`;
}

async function cerrarCajaFunc() {
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        alert('Primero configura el local y la caja');
        return;
    }
    
    const confirmacion = confirm('¿Estás seguro de cerrar la caja? Esta acción no se puede deshacer.');
    if (!confirmacion) return;
    
    // Aquí iría la lógica real de cierre de caja
    // Por ahora es solo un ejemplo
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .update({ estado: 'cerrado' })
                .eq('local_id', APP_STATE.currentLocal.id)
                .eq('caja_id', APP_STATE.currentCaja.id)
                .eq('estado', 'abierto');
            
            if (error) throw error;
            
            alert('✅ Caja cerrada correctamente');
            loadCajaResumen(); // Recargar resumen
        } else {
            await savePendingOperation({
                type: 'cierre_caja',
                data: {
                    local_id: APP_STATE.currentLocal.id,
                    caja_id: APP_STATE.currentCaja.id,
                    estado: 'cerrado',
                    fecha: new Date().toISOString().split('T')[0]
                }
            });
            
            alert('✅ Solicitud de cierre guardada localmente. Se sincronizará cuando haya conexión.');
        }
    } catch (error) {
        console.error('Error cerrando caja:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

function showNuevoProductoModal() {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (!modal || !modalBody || !modalTitle) return;
    
    modalTitle.textContent = '➕ Nuevo Producto';
    modalBody.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 15px;">
            <div class="form-group">
                <label>Nombre del producto:</label>
                <input type="text" id="nuevoProductoNombre" placeholder="Ej: Coca Cola 2.25L" style="width: 100%; padding: 10px;">
            </div>
            <div class="form-group">
                <label>Código de barras:</label>
                <input type="text" id="nuevoProductoCodigo" placeholder="7791234567890 (opcional)" style="width: 100%; padding: 10px;">
            </div>
            <div class="form-group">
                <label>Precio de costo:</label>
                <input type="number" id="nuevoProductoCosto" placeholder="0.00" step="0.01" style="width: 100%; padding: 10px;">
            </div>
            <div class="form-group">
                <label>Porcentaje de ganancia:</label>
                <input type="number" id="nuevoProductoGanancia" placeholder="30" value="30" style="width: 100%; padding: 10px;">
            </div>
            <div class="form-group">
                <label>Stock inicial:</label>
                <input type="number" id="nuevoProductoStock" placeholder="0" value="0" style="width: 100%; padding: 10px;">
            </div>
            <div class="form-group">
                <label>Categoría:</label>
                <select id="nuevoProductoCategoria" style="width: 100%; padding: 10px;">
                    <option value="General">General</option>
                    <option value="Bebidas">Bebidas</option>
                    <option value="Almacén">Almacén</option>
                    <option value="Lácteos">Lácteos</option>
                    <option value="Panadería">Panadería</option>
                    <option value="Otros">Otros</option>
                </select>
            </div>
        </div>
    `;
    
    if (modalConfirm) {
        modalConfirm.textContent = 'Guardar';
        modalConfirm.onclick = async () => {
            const nombre = document.getElementById('nuevoProductoNombre')?.value;
            const codigo = document.getElementById('nuevoProductoCodigo')?.value;
            const costo = parseFloat(document.getElementById('nuevoProductoCosto')?.value) || 0;
            const ganancia = parseFloat(document.getElementById('nuevoProductoGanancia')?.value) || 30;
            const stock = parseInt(document.getElementById('nuevoProductoStock')?.value) || 0;
            const categoria = document.getElementById('nuevoProductoCategoria')?.value;
            
            if (!nombre) {
                alert('El nombre del producto es obligatorio');
                return;
            }
            
            const precioVenta = costo * (1 + ganancia / 100);
            
            const nuevoProducto = {
                id: 'prod-nuevo-' + Date.now(),
                nombre: nombre,
                codigo_barras: codigo || null,
                descripcion: '',
                precio_costo: costo,
                porcentaje_ganancia: ganancia,
                precio_venta: precioVenta,
                stock: stock,
                stock_minimo: 5,
                categoria: categoria,
                activo: true,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            
            try {
                // Guardar en caché local
                await indexedDBOperation('productos_cache', 'put', nuevoProducto);
                
                // Si hay conexión, guardar en Supabase también
                if (APP_STATE.supabase && APP_STATE.isOnline) {
                    const { error } = await APP_STATE.supabase
                        .from('productos')
                        .insert([nuevoProducto]);
                    
                    if (error) throw error;
                } else {
                    // Guardar operación pendiente para sincronizar
                    await savePendingOperation({
                        type: 'producto',
                        data: nuevoProducto
                    });
                }
                
                alert('✅ Producto creado correctamente');
                modal.style.display = 'none';
                
                // Recargar lista de productos si estamos en esa página
                if (APP_STATE.currentPage === 'productos') {
                    await loadProductos();
                }
                
            } catch (error) {
                console.error('Error creando producto:', error);
                alert(`❌ Error: ${error.message || 'Error desconocido'}`);
            }
        };
    }
    
    if (modalCancel) {
        modalCancel.textContent = 'Cancelar';
        modalCancel.onclick = () => {
            modal.style.display = 'none';
        };
    }
    
    modal.style.display = 'flex';
}

function showNuevoClienteModal() {
    alert('Funcionalidad de nuevo cliente en desarrollo');
    // Implementación similar a showNuevoProductoModal
}

// ============================================
// FUNCIONES GLOBALES (para acceso desde HTML)
// ============================================

// Hacer funciones disponibles globalmente
window.agregarAlCarrito = agregarAlCarrito;
window.updateCantidad = updateCantidad;
window.removeFromCart = removeFromCart;
window.changePrice = changePrice;
window.simularPagoQR = simularPagoQR;

// ============================================
// INICIALIZACIÓN FINAL
// ============================================

// Guardar estado antes de cerrar
window.addEventListener('beforeunload', saveAppState);

// Iniciar Realtime subscriptions si hay Supabase
if (APP_STATE.supabase) {
    setTimeout(() => {
        setupRealtimeSubscriptions();
    }, 1000);
}

async function setupRealtimeSubscriptions() {
    if (!APP_STATE.supabase) return;
    
    // Suscribirse a cambios en productos
    try {
        const productosChannel = APP_STATE.supabase
            .channel('productos-changes')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'productos' }, 
                async (payload) => {
                    console.log('Cambio en productos:', payload);
                    
                    // Actualizar caché local
                    if (payload.new) {
                        await indexedDBOperation('productos_cache', 'put', payload.new);
                    } else if (payload.old) {
                        await indexedDBOperation('productos_cache', 'delete', payload.old.id);
                    }
                    
                    // Refrescar lista si estamos en la página de productos
                    if (APP_STATE.currentPage === 'productos') {
                        await loadProductos();
                    }
                }
            )
            .subscribe();
        
        console.log('✅ Suscripción a cambios en productos activada');
    } catch (error) {
        console.error('Error configurando suscripción:', error);
    }
}

console.log('✅ Sistema POS cargado completamente');
