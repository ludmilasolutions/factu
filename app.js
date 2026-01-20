// ============================================
// SISTEMA POS - APP.JS - VERSIÓN CORREGIDA
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '1.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 5, // Incrementado de 1 a 5 para coincidir con la versión existente
    SYNC_INTERVAL: 30000, // 30 segundos
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
    
    // Inicializar IndexedDB - CON MIGRACIÓN DE VERSIÓN
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
// BASE DE DATOS OFFLINE (IndexedDB) - VERSIÓN CORREGIDA
// ============================================

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = (event) => {
            console.error('❌ Error abriendo IndexedDB:', event.target.error);
            
            // Si hay error de versión, intentar eliminar y recrear
            if (event.target.error.name === 'VersionError') {
                console.log('⚠️ Error de versión. Intentando eliminar base de datos...');
                const deleteRequest = indexedDB.deleteDatabase(CONFIG.DB_NAME);
                
                deleteRequest.onsuccess = () => {
                    console.log('✅ Base de datos eliminada. Reintentando...');
                    const newRequest = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
                    
                    newRequest.onerror = (e) => reject(e.target.error);
                    newRequest.onsuccess = (e) => {
                        db = e.target.result;
                        console.log('✅ IndexedDB inicializada después de eliminar');
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
    // Crear object stores si no existen
    const objectStores = [
        {
            name: 'operaciones_pendientes',
            keyPath: 'id',
            autoIncrement: true,
            indexes: [
                { name: 'type', keyPath: 'type', unique: false },
                { name: 'status', keyPath: 'status', unique: false },
                { name: 'timestamp', keyPath: 'timestamp', unique: false }
            ]
        },
        {
            name: 'productos_cache',
            keyPath: 'id',
            indexes: [
                { name: 'codigo_barras', keyPath: 'codigo_barras', unique: true },
                { name: 'updated_at', keyPath: 'updated_at', unique: false }
            ]
        },
        {
            name: 'clientes_cache',
            keyPath: 'id',
            indexes: [
                { name: 'dni', keyPath: 'dni', unique: true }
            ]
        },
        {
            name: 'ventas_offline',
            keyPath: 'offline_id',
            indexes: [
                { name: 'sync_status', keyPath: 'sync_status', unique: false },
                { name: 'created_at', keyPath: 'created_at', unique: false }
            ]
        },
        {
            name: 'configuracion',
            keyPath: 'key'
        }
    ];
    
    // Crear cada object store
    for (const storeConfig of objectStores) {
        if (!db.objectStoreNames.contains(storeConfig.name)) {
            const store = db.createObjectStore(storeConfig.name, {
                keyPath: storeConfig.keyPath,
                autoIncrement: storeConfig.autoIncrement || false
            });
            
            // Crear índices
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
        
        transaction.oncomplete = () => {
            // Transacción completada
        };
        
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
    
    if (productSearch) productSearch.addEventListener('keyup', handleProductSearch);
    if (scanBarcode) scanBarcode.addEventListener('click', toggleScanner);
    if (stopScanner) stopScanner.addEventListener('click', stopScanner);
    if (keyboardMode) keyboardMode.addEventListener('click', activateKeyboardMode);
    if (finalizarVenta) finalizarVenta.addEventListener('click', finalizarVenta);
    if (crearPresupuesto) crearPresupuesto.addEventListener('click', crearPresupuesto);
    if (cancelarVenta) cancelarVenta.addEventListener('click', cancelarVenta);
    if (cartDiscount) cartDiscount.addEventListener('input', updateCartTotal);
    
    // Modal de pagos
    document.querySelectorAll('.payment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
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
    
    if (nuevoProducto) nuevoProducto.addEventListener('click', showNuevoProductoModal);
    if (filterProductos) filterProductos.addEventListener('input', filterProductos);
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
        if (status) status.innerHTML = '<p class="error">❌ Completa todos los campos</p>';
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
            expires: Date.now() + (8 * 60 * 60 * 1000) // 8 horas
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        showAppScreen();
        return;
    }
    
    // Login con Supabase
    try {
        if (status) status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
        
        const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        
        if (error) throw error;
        
        APP_STATE.currentUser = data.user;
        
        // Obtener datos del usuario desde la tabla usuarios
        const { data: usuarioData, error: usuarioError } = await APP_STATE.supabase
            .from('usuarios')
            .select('*')
            .eq('email', email)
            .single();
        
        if (!usuarioError && usuarioData) {
            APP_STATE.currentUser = { ...APP_STATE.currentUser, ...usuarioData };
        }
        
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
        if (status) status.innerHTML = `<p class="error">❌ Error: ${error.message}</p>`;
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
    APP_STATE.currentUser = null;
    APP_STATE.currentLocal = null;
    APP_STATE.currentCaja = null;
    APP_STATE.currentTurno = null;
    showLoginScreen();
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
    
    // En una implementación real, aquí cargarías los objetos completos
    APP_STATE.currentLocal = { 
        id: localSelect.value, 
        nombre: localSelect.options[localSelect.selectedIndex].text 
    };
    APP_STATE.currentCaja = { 
        id: cajaSelect.value, 
        numero: cajaSelect.options[cajaSelect.selectedIndex].text 
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
                    precio_costo: 320,
                    porcentaje_ganancia: 35,
                    precio_venta: 432,
                    stock: 50,
                    stock_minimo: 5,
                    categoria: 'Panadería',
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

function filterProductos() {
    const searchInput = document.getElementById('filterProductos');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const productos = Array.from(document.querySelectorAll('.producto-card'));
    
    productos.forEach(card => {
        const nombre = card.querySelector('h4')?.textContent.toLowerCase() || '';
        const codigo = card.querySelector('.producto-codigo')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || codigo.includes(searchTerm)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
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

function agregarAlCarrito(producto) {
    // Si se pasa solo el ID, buscar el producto completo
    if (typeof producto === 'string') {
        // En una implementación real, buscarías el producto por ID
        // Por ahora, creamos un producto dummy
        producto = {
            id: producto,
            nombre: `Producto ${producto.slice(0, 8)}`,
            precio_venta: 100 + Math.floor(Math.random() * 900),
            stock: 10
        };
    }
    
    // Verificar si ya está en el carrito
    const existingItem = APP_STATE.carrito.find(item => item.id === producto.id);
    
    if (existingItem) {
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
    const total = subtotal - discount;
    
    const totalElem = document.getElementById('cartTotal');
    if (totalElem) totalElem.textContent = `$${total.toFixed(2)}`;
}

function cancelarVenta() {
    if (confirm('¿Cancelar la venta actual? Se perderán todos los items del carrito.')) {
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '';
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
    if (paymentModal) paymentModal.style.display = 'flex';
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
                    <input type="number" id="montoRecibido" placeholder="0.00" min="${total}" step="0.01">
                </div>
                <div class="form-group">
                    <label>Vuelto:</label>
                    <input type="number" id="vuelto" placeholder="0.00" readonly>
                </div>
            `;
            break;
        case 'tarjeta':
            html = `
                <div class="form-group">
                    <label>Número de tarjeta (últimos 4 dígitos):</label>
                    <input type="text" id="tarjetaNumero" placeholder="**** **** **** 1234" maxlength="4">
                </div>
            `;
            break;
        case 'transferencia':
            html = `
                <div class="form-group">
                    <label>Número de transferencia:</label>
                    <input type="text" id="transferenciaNumero" placeholder="TRF-001">
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
                        <button class="btn btn-primary" onclick="simularPagoQR()">Simular Pago</button>
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
    
    // Crear venta
    const venta = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        caja_id: APP_STATE.currentCaja?.id || 'offline',
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        cliente_id: null,
        total: total,
        descuento: 0,
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
        referencia: generarReferenciaPago(metodo),
        estado: 'completado',
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
            
        } else {
            // Offline: Guardar en IndexedDB
            const ventaOffline = {
                ...venta,
                items: items,
                pago: pago
            };
            
            await indexedDBOperation('ventas_offline', 'add', ventaOffline);
            
            await savePendingOperation({
                type: 'venta',
                data: {
                    venta: venta,
                    items: items,
                    pago: pago,
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
        if (discountInput) discountInput.value = '';
        
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
        
        alert('✅ Venta registrada correctamente');
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

function generarReferenciaPago(metodo) {
    const prefix = {
        efectivo: 'EF',
        tarjeta: 'TJ',
        transferencia: 'TRF',
        qr: 'QR',
        cuenta: 'CC'
    }[metodo] || 'OT';
    
    return `${prefix}-${Date.now().toString().slice(-6)}`;
}

function mostrarTicket(venta, items, pago) {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    if (!modal || !modalBody || !modalTitle) return;
    
    const ticketContent = `
        <div class="ticket">
            <h3>${APP_STATE.currentLocal?.nombre || 'LOCAL'}</h3>
            <p>${APP_STATE.currentLocal?.direccion || ''}</p>
            <p>Tel: ${APP_STATE.currentLocal?.telefono || ''}</p>
            <hr>
            <p>Fecha: ${new Date().toLocaleString()}</p>
            <p>Venta: ${venta.offline_id || 'N/A'}</p>
            <p>Vendedor: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Offline'}</p>
            <hr>
            <h4>PRODUCTOS:</h4>
            ${items.map(item => `
                <p>${item.cantidad} x $${item.precio_unitario.toFixed(2)} = $${item.subtotal.toFixed(2)}</p>
            `).join('')}
            <hr>
            <p>TOTAL: $${venta.total.toFixed(2)}</p>
            <hr>
            <p>MÉTODO: ${pago.metodo.toUpperCase()}</p>
            <p>REF: ${pago.referencia}</p>
            <hr>
            <p>¡Gracias por su compra!</p>
        </div>
    `;
    
    modalTitle.textContent = 'Ticket de Venta';
    modalBody.innerHTML = ticketContent;
    
    modal.style.display = 'flex';
    
    // Configurar botones del modal
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (modalConfirm) {
        modalConfirm.textContent = 'Imprimir';
        modalConfirm.onclick = () => {
            window.print();
        };
    }
    
    if (modalCancel) {
        modalCancel.textContent = 'Cerrar';
        modalCancel.onclick = () => {
            modal.style.display = 'none';
        };
    }
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
    
    const validoHasta = prompt('Válido hasta (dd/mm/aaaa):', 
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('es-AR'));
    
    if (!validoHasta) return;
    
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    
    const presupuesto = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        cliente_id: clienteId,
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        total: total,
        valido_hasta: validoHasta,
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
        } else {
            await savePendingOperation({
                type: 'presupuesto',
                data: { presupuesto, items }
            });
        }
        
        alert('✅ Presupuesto creado correctamente');
        
        // Limpiar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '';
        
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
        
        // Simular detección (en producción usarías una librería como Quagga.js)
        simulateBarcodeDetection();
        
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
    APP_STATE.scannerCode = null;
}

function simulateBarcodeDetection() {
    // En una implementación real, usarías una librería de scanning
    console.log('Simulando detección de código de barras...');
    
    // Después de 3 segundos, simular detección
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
    }, 3000);
}

function activateKeyboardMode() {
    const productSearch = document.getElementById('productSearch');
    if (productSearch) {
        productSearch.focus();
        productSearch.value = '';
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
        try {
            // Cargar locales
            const { data: locales } = await APP_STATE.supabase
                .from('locales')
                .select('*')
                .eq('activo', true);
            
            // Cargar cajas
            const { data: cajas } = await APP_STATE.supabase
                .from('cajas')
                .select('*')
                .eq('activa', true);
            
            // Actualizar selects si estamos en configuración inicial
            const localSelect = document.getElementById('selectLocal');
            const cajaSelect = document.getElementById('selectCaja');
            
            if (localSelect && locales) {
                localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
                locales.forEach(local => {
                    const option = document.createElement('option');
                    option.value = local.id;
                    option.textContent = local.nombre;
                    localSelect.appendChild(option);
                });
            }
            
            if (cajaSelect && cajas) {
                cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
                cajas.forEach(caja => {
                    const option = document.createElement('option');
                    option.value = caja.id;
                    option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
                    cajaSelect.appendChild(option);
                });
            }
            
        } catch (error) {
            console.warn('Error cargando datos iniciales:', error);
        }
    }
}

async function loadClientes() {
    // Implementación básica para cargar clientes
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    container.innerHTML = '<p>Cargando clientes...</p>';
    
    // En una implementación real, cargarías clientes de Supabase o IndexedDB
    setTimeout(() => {
        container.innerHTML = `
            <div class="cliente-row">
                <span>Cliente Contado</span>
                <span>12345678</span>
                <span>011-9876-5432</span>
                <span class="cliente-saldo positivo">$0.00</span>
            </div>
            <div class="cliente-row">
                <span>Cliente Cuenta Corriente</span>
                <span>87654321</span>
                <span>011-1234-4321</span>
                <span class="cliente-saldo positivo">$0.00</span>
            </div>
        `;
    }, 500);
}

async function loadCajaResumen() {
    // Implementación básica para cargar resumen de caja
    const saldoInicialElem = document.getElementById('saldoInicialResumen');
    const ventasEfectivoElem = document.getElementById('ventasEfectivo');
    const ventasTarjetaElem = document.getElementById('ventasTarjeta');
    const totalVentasElem = document.getElementById('totalVentas');
    const saldoFinalElem = document.getElementById('saldoFinal');
    
    if (saldoInicialElem) saldoInicialElem.textContent = '$0.00';
    if (ventasEfectivoElem) ventasEfectivoElem.textContent = '$0.00';
    if (ventasTarjetaElem) ventasTarjetaElem.textContent = '$0.00';
    if (totalVentasElem) totalVentasElem.textContent = '$0.00';
    if (saldoFinalElem) saldoFinalElem.textContent = '$0.00';
}

function showNuevoProductoModal() {
    alert('Funcionalidad de nuevo producto en desarrollo');
    // En una implementación completa, aquí abrirías un modal para agregar productos
}

// ============================================
// FUNCIONES GLOBALES (para acceso desde HTML)
// ============================================

// Hacer funciones disponibles globalmente
window.agregarAlCarrito = agregarAlCarrito;
window.updateCantidad = updateCantidad;
window.removeFromCart = removeFromCart;
window.changePrice = changePrice;

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

console.log('✅ app.js cargado completamente');
