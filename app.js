// ============================================
// SISTEMA POS - APP.JS - VERSIÓN COMPLETA Y CORREGIDA
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '2.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 10,
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
// BASE DE DATOS OFFLINE (IndexedDB) - CORREGIDA
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
            
            const objectStoreNames = Array.from(db.objectStoreNames);
            if (objectStoreNames.length === 0) {
                console.log('🔄 Creando object stores...');
                const newVersionRequest = indexedDB.open(CONFIG.DB_NAME, db.version + 1);
                newVersionRequest.onupgradeneeded = (e) => {
                    db = e.target.result;
                    setupObjectStores(db);
                };
                newVersionRequest.onsuccess = (e) => {
                    db = e.target.result;
                    resolve(db);
                };
                newVersionRequest.onerror = (e) => {
                    console.error('Error actualizando versión:', e.target.error);
                    reject(e.target.error);
                };
            } else {
                resolve(db);
            }
        };
        
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            console.log('🔄 Actualizando IndexedDB a versión:', event.newVersion);
            setupObjectStores(db);
        };
    });
}

function setupObjectStores(db) {
    const stores = [
        'operaciones_pendientes',
        'productos_cache',
        'clientes_cache',
        'ventas_offline',
        'presupuestos_offline',
        'configuracion',
        'cierres_offline',
        'movimientos_inventario',
        'proveedores_cache',
        'categorias_cache'
    ];
    
    stores.forEach(storeName => {
        if (!db.objectStoreNames.contains(storeName)) {
            console.log(`Creando store: ${storeName}`);
            
            let options = { keyPath: 'id' };
            if (storeName === 'operaciones_pendientes') {
                options.autoIncrement = true;
            } else if (storeName === 'ventas_offline' || 
                      storeName === 'presupuestos_offline' || 
                      storeName === 'cierres_offline') {
                options.keyPath = 'offline_id';
                options.autoIncrement = false;
            }
            
            const store = db.createObjectStore(storeName, options);
            
            switch(storeName) {
                case 'productos_cache':
                    store.createIndex('codigo_barras', 'codigo_barras', { unique: true });
                    store.createIndex('nombre', 'nombre', { unique: false });
                    break;
                case 'clientes_cache':
                    store.createIndex('dni', 'numero_documento', { unique: true });
                    store.createIndex('nombre', 'nombre', { unique: false });
                    break;
                case 'operaciones_pendientes':
                    store.createIndex('type', 'type', { unique: false });
                    store.createIndex('status', 'status', { unique: false });
                    break;
                case 'ventas_offline':
                    store.createIndex('sync_status', 'sync_status', { unique: false });
                    break;
            }
        }
    });
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
// INICIALIZACIÓN SUPABASE
// ============================================

async function initSupabase() {
    const supabaseUrl = localStorage.getItem('supabase_url') || 'https://manccbrodsboxtkrgpvm.supabase.co';
    const supabaseKey = localStorage.getItem('supabase_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1hbmNjYnJvZHNib3h0a3JncHZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzgzNzcsImV4cCI6MjA4NDQ1NDM3N30.rtmunxjtbj2KbruHNt-ul5o3CQLcyZ6eKGi3s3okDlY';
    
    try {
        if (!window.supabase) {
            await loadSupabase();
        }
        
        APP_STATE.supabase = window.supabase.createClient(supabaseUrl, supabaseKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true
            },
            realtime: {
                params: {
                    eventsPerSecond: 10
                }
            }
        });
        
        console.log('✅ Supabase configurado');
        
        const { data: { session } } = await APP_STATE.supabase.auth.getSession();
        if (session) {
            APP_STATE.currentUser = session.user;
            await loadUserData(session.user.email);
        }
    } catch (error) {
        console.warn('⚠️ Error configurando Supabase:', error);
    }
}

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
    
    loadLocalesYCajas();
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        if (initialConfig) initialConfig.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';
        if (!APP_STATE.isOnline) {
            loadEjemploLocalesYCajas();
        }
    } else {
        if (initialConfig) initialConfig.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        updateSessionInfo();
    }
}

function updateSessionInfo() {
    const userInfo = document.getElementById('userInfo');
    const localInfo = document.getElementById('localInfo');
    const cajaInfo = document.getElementById('cajaInfo');
    const turnoInfo = document.getElementById('turnoInfo');
    
    if (userInfo) userInfo.textContent = `Usuario: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Sin nombre'}`;
    if (localInfo) localInfo.textContent = `Local: ${APP_STATE.currentLocal?.nombre || 'Sin local'}`;
    if (cajaInfo) cajaInfo.textContent = `Caja: ${APP_STATE.currentCaja?.numero || 'Sin caja'}`;
    if (turnoInfo) turnoInfo.textContent = `Turno: ${APP_STATE.currentTurno || 'Sin turno'}`;
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
    
    if (!APP_STATE.supabase) {
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
        showAppScreen();
        return;
    }
    
    try {
        if (status) status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
        
        const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        
        if (error) throw error;
        
        APP_STATE.currentUser = data.user;
        
        try {
            const { data: usuarioData, error: userError } = await APP_STATE.supabase
                .from('usuarios')
                .select('*')
                .eq('email', email)
                .single();
            
            if (!userError && usuarioData) {
                APP_STATE.currentUser = { ...APP_STATE.currentUser, ...usuarioData };
            }
        } catch (userError) {
            console.warn('No se pudieron cargar datos adicionales del usuario:', userError);
        }
        
        const session = {
            user: APP_STATE.currentUser,
            expires: Date.now() + (8 * 60 * 60 * 1000)
        };
        
        localStorage.setItem('pos_session', JSON.stringify(session));
        
        showAppScreen();
        
        await loadInitialData();
        
    } catch (error) {
        console.error('Error en login:', error);
        if (status) status.innerHTML = `<p class="error">❌ Error: ${error.message || 'Error desconocido'}</p>`;
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
    
    showLoginScreen();
}

async function loadLocalesYCajas() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    
    if (!localSelect || !cajaSelect) return;
    
    try {
        localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
        cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            console.log('🌐 Intentando cargar locales y cajas desde Supabase...');
            
            let locales = [];
            try {
                const { data, error } = await APP_STATE.supabase
                    .from('locales')
                    .select('id, nombre')
                    .eq('activo', true)
                    .order('nombre');
                
                if (error) throw error;
                locales = data || [];
            } catch (error) {
                console.warn('No se pudieron cargar locales:', error);
            }
            
            let cajas = [];
            try {
                const { data, error } = await APP_STATE.supabase
                    .from('cajas')
                    .select('id, numero, nombre')
                    .eq('activo', true)
                    .order('numero');
                
                if (error) throw error;
                cajas = data || [];
            } catch (error) {
                console.warn('No se pudieron cargar cajas:', error);
            }
            
            if (locales.length > 0) {
                locales.forEach(local => {
                    const option = document.createElement('option');
                    option.value = local.id;
                    option.textContent = local.nombre;
                    localSelect.appendChild(option);
                });
                console.log(`✅ ${locales.length} locales cargados`);
            } else {
                const option = document.createElement('option');
                option.value = 'local_default';
                option.textContent = 'Local Principal';
                localSelect.appendChild(option);
            }
            
            if (cajas.length > 0) {
                cajas.forEach(caja => {
                    const option = document.createElement('option');
                    option.value = caja.id;
                    option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
                    cajaSelect.appendChild(option);
                });
                console.log(`✅ ${cajas.length} cajas cargadas`);
            } else {
                const option = document.createElement('option');
                option.value = 'caja_default';
                option.textContent = 'Caja 1';
                cajaSelect.appendChild(option);
            }
            
        } else {
            console.log('📴 Modo offline - cargando datos de ejemplo');
            loadEjemploLocalesYCajas();
        }
        
    } catch (error) {
        console.error('❌ Error general cargando locales y cajas:', error);
        loadEjemploLocalesYCajas();
    }
}

function loadEjemploLocalesYCajas() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    
    if (!localSelect || !cajaSelect) return;
    
    localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
    cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
    
    const localesEjemplo = [
        { id: 'local_offline_1', nombre: 'Local Central (Offline)' },
        { id: 'local_offline_2', nombre: 'Sucursal Norte (Offline)' }
    ];
    
    const cajasEjemplo = [
        { id: 'caja_offline_1', numero: 'Caja 1', nombre: 'Caja Principal' },
        { id: 'caja_offline_2', numero: 'Caja 2', nombre: 'Caja Secundaria' }
    ];
    
    localesEjemplo.forEach(local => {
        const option = document.createElement('option');
        option.value = local.id;
        option.textContent = local.nombre;
        localSelect.appendChild(option);
    });
    
    cajasEjemplo.forEach(caja => {
        const option = document.createElement('option');
        option.value = caja.id;
        option.textContent = `${caja.numero} - ${caja.nombre}`;
        cajaSelect.appendChild(option);
    });
    
    console.log('✅ Datos de ejemplo cargados para modo offline');
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
    
    const localId = localSelect.value;
    const localNombre = localSelect.options[localSelect.selectedIndex].text;
    const cajaId = cajaSelect.value;
    const cajaNumero = cajaSelect.options[cajaSelect.selectedIndex].text;
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
        ventas_efectivo: 0,
        ventas_tarjeta: 0,
        ventas_transferencia: 0,
        ventas_qr: 0,
        ventas_cuenta_corriente: 0,
        total_ventas: 0,
        created_at: new Date().toISOString()
    };
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .insert([cierreData]);
            
            if (error) throw error;
        } else {
            cierreData.offline_id = 'cierre_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            cierreData.sync_status = 'pending';
            await indexedDBOperation('cierres_offline', 'add', cierreData);
            
            await savePendingOperation({
                type: 'cierre_caja',
                data: cierreData,
                priority: 10
            });
        }
    } catch (error) {
        console.error('Error abriendo caja:', error);
    }
}

// ============================================
// CONFIGURACIÓN DE EVENTOS - COMPLETADA
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
            let target = e.target;
            while (target && !target.classList.contains('nav-btn')) {
                target = target.parentElement;
            }
            if (target && target.dataset.page) {
                const page = target.dataset.page;
                console.log('Navegando a:', page);
                switchPage(page);
            }
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
    
    // Productos
    const nuevoProducto = document.getElementById('nuevoProducto');
    const filterProductos = document.getElementById('filterProductos');
    const importarExcel = document.getElementById('importarExcel');
    const exportarExcel = document.getElementById('exportarExcel');
    const filterStockBajo = document.getElementById('filterStockBajo');
    
    if (nuevoProducto) nuevoProducto.addEventListener('click', showNuevoProductoModal);
    if (filterProductos) filterProductos.addEventListener('input', handleFilterProductos);
    if (importarExcel) importarExcel.addEventListener('click', importarExcelProductos);
    if (exportarExcel) exportarExcel.addEventListener('click', exportarExcelProductos);
    if (filterStockBajo) filterStockBajo.addEventListener('click', () => filterProductosPorStock('bajo'));
    
    // Clientes
    const nuevoCliente = document.getElementById('nuevoCliente');
    const nuevoClientePage = document.getElementById('nuevoClientePage');
    
    if (nuevoCliente) nuevoCliente.addEventListener('click', showNuevoClienteModal);
    if (nuevoClientePage) nuevoClientePage.addEventListener('click', showNuevoClienteModal);
    
    // Caja
    const cerrarCajaBtn = document.getElementById('cerrarCaja');
    if (cerrarCajaBtn) cerrarCajaBtn.addEventListener('click', cerrarCaja);
    
    // Proveedores
    const nuevoProveedor = document.getElementById('nuevoProveedor');
    if (nuevoProveedor) nuevoProveedor.addEventListener('click', showNuevoProveedorModal);
    
    // Modal genérico
    const modalConfirm = document.getElementById('modalConfirm');
    const modalCancel = document.getElementById('modalCancel');
    
    if (modalConfirm) modalConfirm.addEventListener('click', handleModalConfirm);
    if (modalCancel) modalCancel.addEventListener('click', handleModalCancel);
    
    // Scanner
    const stopScanner = document.getElementById('stopScanner');
    if (stopScanner) stopScanner.addEventListener('click', stopScanner);
    
    // Clientes select
    const selectCliente = document.getElementById('selectCliente');
    if (selectCliente) {
        selectCliente.addEventListener('change', (e) => {
            if (e.target.value === 'nuevo') {
                showNuevoClienteModal();
            }
        });
    }
    
    // Impresora
    const configImpresora = document.getElementById('configImpresora');
    if (configImpresora) configImpresora.addEventListener('click', configurarImpresora);
    
    // Sincronización manual
    const syncManual = document.getElementById('syncManual');
    if (syncManual) syncManual.addEventListener('click', syncOfflineOperations);
}

function setupNetworkListeners() {
    window.addEventListener('online', () => {
        APP_STATE.isOnline = true;
        updateSyncStatus();
        syncOfflineOperations();
        loadInitialData();
    });
    
    window.addEventListener('offline', () => {
        APP_STATE.isOnline = false;
        updateSyncStatus();
    });
}

// ============================================
// NAVEGACIÓN Y PÁGINAS
// ============================================

function switchPage(pageName) {
    console.log('Cambiando a página:', pageName);
    
    if (!pageName) {
        console.error('Error: pageName es undefined');
        return;
    }
    
    document.querySelectorAll('.nav-btn').forEach(btn => {
        const btnPage = btn.dataset.page;
        btn.classList.toggle('active', btnPage === pageName);
    });
    
    document.querySelectorAll('.page').forEach(page => {
        const pageId = page.id;
        const targetPageId = 'page' + pageName.charAt(0).toUpperCase() + pageName.slice(1);
        page.classList.toggle('active', pageId === targetPageId);
    });
    
    const currentPage = document.getElementById('currentPage');
    if (currentPage) {
        currentPage.textContent = pageName.charAt(0).toUpperCase() + pageName.slice(1);
    }
    
    APP_STATE.currentPage = pageName;
    
    switch(pageName) {
        case 'pos':
            loadProductosParaVenta();
            loadClientesParaVenta();
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
// GESTIÓN DE PRODUCTOS COMPLETA
// ============================================

async function loadInitialData() {
    await loadProductosParaVenta();
    await loadClientesParaVenta();
    await loadConfiguraciones();
}

async function loadProductosParaVenta() {
    try {
        let productos = [];
        
        try {
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        } catch (error) {
            console.warn('Error cargando productos desde cache:', error);
        }
        
        if ((!productos || productos.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            await syncProductosCache();
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        }
        
        if (!productos || productos.length === 0) {
            productos = generarProductosEjemplo();
            for (const producto of productos) {
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        if (APP_STATE.currentPage === 'pos') {
            actualizarBuscadorProductos(productos);
        }
        
    } catch (error) {
        console.error('Error cargando productos:', error);
    }
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

async function loadProductos() {
    try {
        let productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        
        if ((!productos || productos.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            await syncProductosCache();
            productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        }
        
        displayProductos(productos);
        
    } catch (error) {
        console.error('Error cargando productos:', error);
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
    
    productos.forEach(producto => {
        const stockClass = producto.stock <= producto.stock_minimo ? 'bajo' : 
                          producto.stock <= (producto.stock_minimo * 2) ? 'critico' : 'normal';
        const precioVenta = producto.precio_venta || producto.precio_costo * (1 + (producto.porcentaje_ganancia || 30) / 100);
        const ganancia = precioVenta - (producto.precio_costo || 0);
        const margen = producto.precio_costo ? ((ganancia / producto.precio_costo) * 100).toFixed(1) : '0';
        
        const card = document.createElement('div');
        card.className = 'producto-card';
        card.innerHTML = `
            <div class="producto-header">
                <h4>${producto.nombre}</h4>
                <span class="producto-codigo">${producto.codigo_barras || producto.codigo_interno || 'Sin código'}</span>
            </div>
            <p class="producto-descripcion">${producto.descripcion || ''}</p>
            <div class="producto-info">
                <span class="producto-categoria">${producto.categoria || 'Sin categoría'}</span>
                <span class="producto-stock ${stockClass}">Stock: ${producto.stock || 0}</span>
            </div>
            <div class="producto-precios">
                <span class="producto-costo">Costo: $${(producto.precio_costo || 0).toFixed(2)}</span>
                <span class="producto-venta">Venta: $${precioVenta.toFixed(2)}</span>
                <span class="producto-margen">Margen: ${margen}%</span>
            </div>
            <div class="producto-actions">
                <button class="btn btn-outline btn-sm" onclick="agregarAlCarrito('${producto.id}')">
                    ➕ Agregar
                </button>
                <button class="btn btn-secondary btn-sm" onclick="editarProducto('${producto.id}')">
                    ✏️ Editar
                </button>
                <button class="btn btn-danger btn-sm" onclick="eliminarProducto('${producto.id}')">
                    🗑️ Eliminar
                </button>
            </div>
        `;
        
        container.appendChild(card);
    });
}

function handleFilterProductos() {
    const searchInput = document.getElementById('filterProductos');
    if (!searchInput) return;
    
    const searchTerm = searchInput.value.toLowerCase();
    const productos = Array.from(document.querySelectorAll('.producto-card'));
    
    productos.forEach(card => {
        const nombre = card.querySelector('h4')?.textContent.toLowerCase() || '';
        const codigo = card.querySelector('.producto-codigo')?.textContent.toLowerCase() || '';
        const categoria = card.querySelector('.producto-categoria')?.textContent.toLowerCase() || '';
        
        if (nombre.includes(searchTerm) || codigo.includes(searchTerm) || categoria.includes(searchTerm)) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

function filterProductosPorStock(tipo) {
    const productos = document.querySelectorAll('.producto-card');
    
    productos.forEach(card => {
        const stockElement = card.querySelector('.producto-stock');
        if (!stockElement) return;
        
        const hasClass = stockElement.classList.contains(tipo);
        card.style.display = hasClass ? 'block' : 'none';
    });
}

async function agregarAlCarrito(productoId) {
    try {
        let producto = await indexedDBOperation('productos_cache', 'get', productoId);
        
        if (!producto) {
            if (APP_STATE.supabase && APP_STATE.isOnline) {
                const { data, error } = await APP_STATE.supabase
                    .from('productos')
                    .select('*')
                    .eq('id', productoId)
                    .single();
                
                if (error) throw error;
                producto = data;
                await indexedDBOperation('productos_cache', 'put', producto);
            }
        }
        
        if (!producto) {
            alert('Producto no encontrado');
            return;
        }
        
        const existingItem = APP_STATE.carrito.find(item => item.id === producto.id);
        
        if (existingItem) {
            if (existingItem.cantidad >= (producto.stock || 9999)) {
                alert('Stock insuficiente');
                return;
            }
            existingItem.cantidad += 1;
            existingItem.subtotal = existingItem.cantidad * existingItem.precio;
        } else {
            if ((producto.stock || 0) <= 0) {
                alert('Producto sin stock');
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
        
    } catch (error) {
        console.error('Error agregando al carrito:', error);
        alert('Error al agregar producto');
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
        alert('Stock insuficiente');
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

async function changePrice(index) {
    const item = APP_STATE.carrito[index];
    if (!item) return;
    
    const nuevoPrecio = prompt('Nuevo precio:', item.precio ? item.precio.toFixed(2) : '0.00');
    
    if (nuevoPrecio && !isNaN(nuevoPrecio) && parseFloat(nuevoPrecio) >= 0) {
        item.precio = parseFloat(nuevoPrecio);
        item.subtotal = (item.cantidad || 1) * item.precio;
        updateCartDisplay();
    }
}

function updateCartDisplay() {
    const container = document.getElementById('cartItems');
    const subtotalElem = document.getElementById('cartSubtotal');
    const totalElem = document.getElementById('cartTotal');
    const descuentoElem = document.getElementById('cartDiscount');
    
    if (!container) return;
    
    container.innerHTML = '';
    
    if (APP_STATE.carrito.length === 0) {
        container.innerHTML = '<div class="cart-empty">🎯 Busca y agrega productos al carrito</div>';
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
            <span class="cantidad-controls">
                <button onclick="updateCantidad(${index}, -1)">-</button>
                ${item.cantidad || 1}
                <button onclick="updateCantidad(${index}, 1)">+</button>
            </span>
            <span>$${(item.precio || 0).toFixed(2)}</span>
            <span>$${(item.subtotal || 0).toFixed(2)}</span>
            <span class="cart-item-actions">
                <button onclick="removeFromCart(${index})" class="btn btn-danger btn-sm">🗑️</button>
                <button onclick="changePrice(${index})" class="btn btn-warning btn-sm">💰</button>
            </span>
        `;
        
        container.appendChild(itemElem);
    });
    
    if (subtotalElem) subtotalElem.textContent = `$${subtotal.toFixed(2)}`;
    
    const descuento = descuentoElem ? parseFloat(descuentoElem.value) || 0 : 0;
    const total = subtotal - descuento;
    
    if (totalElem) totalElem.textContent = `$${total.toFixed(2)}`;
    
    saveAppState();
}

function updateCartTotal() {
    const subtotalElem = document.getElementById('cartSubtotal');
    const totalElem = document.getElementById('cartTotal');
    const discountInput = document.getElementById('cartDiscount');
    
    const subtotalText = subtotalElem ? subtotalElem.textContent : '$0.00';
    const subtotal = parseFloat(subtotalText.replace('$', '').replace(',', '')) || 0;
    const discount = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    const total = subtotal - discount;
    
    if (totalElem) totalElem.textContent = `$${total.toFixed(2)}`;
}

function cancelarVenta() {
    if (APP_STATE.carrito.length === 0) return;
    
    if (confirm('¿Cancelar la venta actual? Se perderán todos los items del carrito.')) {
        APP_STATE.carrito = [];
        updateCartDisplay();
        const discountInput = document.getElementById('cartDiscount');
        if (discountInput) discountInput.value = '0';
    }
}

// ============================================
// VENTAS Y PAGOS COMPLETOS
// ============================================

function finalizarVenta() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
        return;
    }
    
    const paymentModal = document.getElementById('paymentModal');
    if (paymentModal) paymentModal.style.display = 'flex';
    
    const totalElem = document.getElementById('cartTotal');
    const paymentTotal = document.getElementById('paymentTotalAmount');
    if (totalElem && paymentTotal) {
        paymentTotal.textContent = totalElem.textContent;
    }
    
    showPaymentDetails('efectivo');
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
                    <input type="number" id="vuelto" placeholder="0.00" readonly value="0.00">
                </div>
            `;
            break;
        case 'tarjeta':
            html = `
                <div class="form-group">
                    <label>Tarjeta:</label>
                    <select id="tipoTarjeta">
                        <option value="debito">Débito</option>
                        <option value="credito">Crédito</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Número de autorización:</label>
                    <input type="text" id="autorizacionTarjeta" placeholder="Ej: 123456">
                </div>
                <div id="cuotasContainer" style="display: none;">
                    <div class="form-group">
                        <label>Cuotas:</label>
                        <select id="cuotasTarjeta">
                            ${[1,2,3,4,5,6,12].map(n => `<option value="${n}">${n} cuota${n > 1 ? 's' : ''}</option>`).join('')}
                        </select>
                    </div>
                </div>
            `;
            break;
        case 'transferencia':
            html = `
                <div class="form-group">
                    <label>Número de operación:</label>
                    <input type="text" id="operacionTransferencia" placeholder="Ej: TRF-123456">
                </div>
                <div class="form-group">
                    <label>Banco:</label>
                    <input type="text" id="bancoTransferencia" placeholder="Nombre del banco">
                </div>
            `;
            break;
        case 'qr':
            html = `
                <div class="payment-simple">
                    <div class="payment-icon">
                        <i class="fas fa-qrcode fa-3x"></i>
                    </div>
                    <p>Se registrará como pago digital (QR)</p>
                    <p><strong>Referencia automática generada</strong></p>
                </div>
            `;
            break;
        case 'cuenta':
            const clienteSelect = document.getElementById('selectCliente');
            if (clienteSelect && clienteSelect.value && clienteSelect.value !== '') {
                html = `
                    <div class="payment-simple">
                        <div class="payment-icon">
                            <i class="fas fa-file-invoice-dollar fa-3x"></i>
                        </div>
                        <p>Se registrará en cuenta corriente del cliente</p>
                        <p><strong>Total a cargar: $${total.toFixed(2)}</strong></p>
                    </div>
                `;
            } else {
                html = `
                    <div class="alert alert-warning">
                        <p>⚠️ No hay cliente seleccionado</p>
                        <p>Selecciona un cliente con cuenta corriente primero</p>
                    </div>
                `;
            }
            break;
    }
    
    container.innerHTML = html;
    
    if (method === 'efectivo') {
        const montoInput = document.getElementById('montoRecibido');
        const vueltoInput = document.getElementById('vuelto');
        
        if (montoInput && vueltoInput) {
            montoInput.addEventListener('input', () => {
                const monto = parseFloat(montoInput.value) || 0;
                const vuelto = monto - total;
                vueltoInput.value = vuelto > 0 ? vuelto.toFixed(2) : '0.00';
            });
            
            montoInput.dispatchEvent(new Event('input'));
        }
    }
    
    if (method === 'tarjeta') {
        const tipoTarjeta = document.getElementById('tipoTarjeta');
        const cuotasContainer = document.getElementById('cuotasContainer');
        
        if (tipoTarjeta && cuotasContainer) {
            tipoTarjeta.addEventListener('change', () => {
                cuotasContainer.style.display = tipoTarjeta.value === 'credito' ? 'block' : 'none';
            });
        }
    }
}

async function confirmarPago() {
    const totalElem = document.getElementById('cartTotal');
    const totalText = totalElem ? totalElem.textContent : '$0.00';
    const total = parseFloat(totalText.replace('$', '').replace(',', '')) || 0;
    const discountInput = document.getElementById('cartDiscount');
    const descuento = discountInput ? parseFloat(discountInput.value) || 0 : 0;
    const subtotal = total + descuento;
    
    let metodo = 'efectivo';
    let referencia = '';
    let detalles = {};
    
    const activePaymentBtn = document.querySelector('.payment-btn.active');
    if (activePaymentBtn) {
        metodo = activePaymentBtn.dataset.method || 'efectivo';
    }
    
    switch (metodo) {
        case 'efectivo':
            referencia = `EF-${Date.now().toString().slice(-6)}`;
            const montoInput = document.getElementById('montoRecibido');
            const vueltoInput = document.getElementById('vuelto');
            if (montoInput && vueltoInput) {
                detalles.monto_recibido = parseFloat(montoInput.value) || total;
                detalles.vuelto = parseFloat(vueltoInput.value) || 0;
            }
            break;
        case 'tarjeta':
            referencia = `TJ-${Date.now().toString().slice(-6)}`;
            const tipoTarjeta = document.getElementById('tipoTarjeta');
            const autorizacion = document.getElementById('autorizacionTarjeta');
            const cuotas = document.getElementById('cuotasTarjeta');
            if (tipoTarjeta) detalles.tipo_tarjeta = tipoTarjeta.value;
            if (autorizacion) detalles.autorizacion = autorizacion.value;
            if (cuotas) detalles.cuotas = parseInt(cuotas.value) || 1;
            break;
        case 'transferencia':
            referencia = `TRF-${Date.now().toString().slice(-6)}`;
            const operacion = document.getElementById('operacionTransferencia');
            const banco = document.getElementById('bancoTransferencia');
            if (operacion) detalles.operacion = operacion.value;
            if (banco) detalles.banco = banco.value;
            break;
        case 'qr':
            referencia = `QR-${Date.now().toString().slice(-6)}`;
            break;
        case 'cuenta':
            referencia = `CC-${Date.now().toString().slice(-6)}`;
            break;
    }
    
    const clienteSelect = document.getElementById('selectCliente');
    const clienteId = clienteSelect && clienteSelect.value && clienteSelect.value !== '' ? clienteSelect.value : null;
    
    if (metodo === 'cuenta' && !clienteId) {
        alert('Selecciona un cliente para venta a cuenta corriente');
        return;
    }
    
    const ventaId = 'venta_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const venta = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        caja_id: APP_STATE.currentCaja?.id || 'offline',
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        cliente_id: clienteId,
        total: total,
        descuento: descuento,
        subtotal: subtotal,
        estado: 'completada',
        tipo_venta: metodo === 'cuenta' ? 'cuenta_corriente' : 'contado',
        tipo_comprobante: 'ticket',
        numero_venta: `V${Date.now().toString().slice(-8)}`,
        offline_id: ventaId,
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending',
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
        detalles: JSON.stringify(detalles),
        offline_id: 'pago_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending',
        created_at: new Date().toISOString()
    };
    
    const movimientosInventario = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        tipo_movimiento: 'venta',
        cantidad: item.cantidad || 1,
        stock_anterior: item.stock || 0,
        stock_nuevo: (item.stock || 0) - (item.cantidad || 1),
        motivo: 'Venta',
        usuario_id: APP_STATE.currentUser?.id || 'offline',
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
        mostrarTicket(venta, items, pago, metodo);
        
        APP_STATE.carrito = [];
        updateCartDisplay();
        if (discountInput) discountInput.value = '0';
        
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
        
        alert('✅ Venta registrada correctamente');
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function actualizarStockLocal(productoId, cantidad) {
    try {
        const producto = await indexedDBOperation('productos_cache', 'get', productoId);
        if (producto) {
            producto.stock = (producto.stock || 0) + cantidad;
            if (producto.stock < 0) producto.stock = 0;
            await indexedDBOperation('productos_cache', 'put', producto);
        }
    } catch (error) {
        console.error('Error actualizando stock local:', error);
    }
}

function mostrarTicket(venta, items, pago, metodo) {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    if (!modal || !modalBody || !modalTitle) return;
    
    const configEmpresa = JSON.parse(localStorage.getItem('config_empresa') || '{"nombre":"Mi Local","direccion":"","telefono":""}');
    
    const ticketContent = `
        <div class="ticket" id="ticketContent">
            <h3>${configEmpresa.nombre}</h3>
            <p>${configEmpresa.direccion}</p>
            <p>Tel: ${configEmpresa.telefono}</p>
            <hr>
            <p>Fecha: ${new Date().toLocaleString('es-AR')}</p>
            <p>Venta: ${venta.numero_venta || venta.offline_id}</p>
            <p>Vendedor: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Offline'}</p>
            <hr>
            <h4>PRODUCTOS:</h4>
            ${items.map(item => `
                <p>${item.cantidad} x $${item.precio_unitario.toFixed(2)} = $${item.subtotal.toFixed(2)}</p>
            `).join('')}
            <hr>
            <p>Subtotal: $${(venta.subtotal || venta.total).toFixed(2)}</p>
            ${venta.descuento > 0 ? `<p>Descuento: -$${venta.descuento.toFixed(2)}</p>` : ''}
            <p><strong>TOTAL: $${venta.total.toFixed(2)}</strong></p>
            <hr>
            <p>MÉTODO: ${pago.metodo.toUpperCase()}</p>
            <p>REF: ${pago.referencia}</p>
            ${metodo === 'efectivo' && pago.monto_recibido > 0 ? `
                <p>Recibido: $${pago.monto_recibido.toFixed(2)}</p>
                <p>Vuelto: $${pago.vuelto.toFixed(2)}</p>
            ` : ''}
            <hr>
            <p>¡Gracias por su compra!</p>
        </div>
        <div class="ticket-actions" style="margin-top: 20px;">
            <button onclick="imprimirTicket()" class="btn btn-primary">🖨️ Imprimir</button>
            <button onclick="enviarTicketWhatsapp()" class="btn btn-success">📱 WhatsApp</button>
        </div>
    `;
    
    modalTitle.textContent = 'Ticket de Venta';
    modalBody.innerHTML = ticketContent;
    modal.style.display = 'flex';
    
    document.getElementById('modalConfirm').style.display = 'none';
    document.getElementById('modalCancel').textContent = 'Cerrar';
}

function imprimirTicket() {
    const ticketContent = document.getElementById('ticketContent');
    if (!ticketContent) return;
    
    if (typeof window.printTicket === 'function') {
        window.printTicket(ticketContent.innerHTML);
    } else {
        const ventana = window.open('', '_blank');
        ventana.document.write(`
            <html>
            <head>
                <title>Ticket de Venta</title>
                <style>
                    body { font-family: 'Courier New', monospace; padding: 10px; }
                    h3 { text-align: center; }
                    hr { border-top: 1px dashed #000; margin: 5px 0; }
                    p { margin: 2px 0; }
                    @media print {
                        body { font-size: 12px; }
                    }
                </style>
            </head>
            <body>
                ${ticketContent.innerHTML}
            </body>
            </html>
        `);
        ventana.document.close();
        ventana.print();
    }
}

function enviarTicketWhatsapp() {
    const ticketContent = document.getElementById('ticketContent');
    if (!ticketContent) return;
    
    const texto = `📋 Ticket de Compra\n${ticketContent.innerText}`;
    const telefono = prompt('Ingrese el número de WhatsApp (sin + ni 0):', '5491122334455');
    
    if (telefono) {
        const url = `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`;
        window.open(url, '_blank');
    }
}

function configurarImpresora() {
    if (navigator.usb) {
        navigator.usb.requestDevice({ filters: [] })
            .then(device => {
                console.log('Impresora conectada:', device);
                alert(`Impresora conectada: ${device.productName}`);
                localStorage.setItem('impresora_config', JSON.stringify({
                    dispositivo: device.productName,
                    conectada: true
                }));
            })
            .catch(error => {
                console.error('Error conectando impresora:', error);
                alert('No se pudo conectar la impresora. Se usará impresión por navegador.');
            });
    } else {
        alert('Tu navegador no soporta conexión USB. Se usará impresión por navegador.');
    }
}

// ============================================
// PRESUPUESTOS COMPLETOS
// ============================================

async function crearPresupuesto() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
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
    const subtotal = total + descuento;
    
    const presupuestoId = 'presupuesto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const presupuesto = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        cliente_id: clienteId,
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        total: total,
        descuento: descuento,
        subtotal: subtotal,
        valido_hasta: fechaValido,
        estado: 'pendiente',
        numero_presupuesto: `P${Date.now().toString().slice(-8)}`,
        offline_id: presupuestoId,
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
        
        alert('✅ Presupuesto creado correctamente');
        
        APP_STATE.carrito = [];
        updateCartDisplay();
        if (discountInput) discountInput.value = '0';
        
    } catch (error) {
        console.error('Error creando presupuesto:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function loadPresupuestos() {
    const container = document.getElementById('presupuestosList');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Cargando presupuestos...</div>';
    
    try {
        let presupuestos = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('presupuestos')
                .select('*, clientes(nombre)')
                .order('created_at', { ascending: false })
                .limit(50);
            
            if (!error && data) {
                presupuestos = data;
            }
        } else {
            presupuestos = await indexedDBOperation('presupuestos_offline', 'getAll') || [];
        }
        
        if (presupuestos.length === 0) {
            container.innerHTML = '<div class="no-data">No hay presupuestos</div>';
            return;
        }
        
        container.innerHTML = '';
        
        presupuestos.forEach(presupuesto => {
            const card = document.createElement('div');
            card.className = 'presupuesto-card';
            card.innerHTML = `
                <div class="presupuesto-header">
                    <h4>${presupuesto.numero_presupuesto || 'Sin número'}</h4>
                    <span class="presupuesto-estado ${presupuesto.estado}">${presupuesto.estado}</span>
                </div>
                <p>Cliente: ${presupuesto.clientes?.nombre || 'Sin cliente'}</p>
                <p>Fecha: ${new Date(presupuesto.created_at).toLocaleDateString('es-AR')}</p>
                <p>Valido hasta: ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}</p>
                <p>Total: $${presupuesto.total.toFixed(2)}</p>
                <div class="presupuesto-actions">
                    <button class="btn btn-sm btn-primary" onclick="verPresupuesto('${presupuesto.id}')">Ver</button>
                    <button class="btn btn-sm btn-info" onclick="enviarPresupuestoWhatsapp('${presupuesto.id}')">📱 WhatsApp</button>
                    ${presupuesto.estado === 'pendiente' ? 
                        `<button class="btn btn-sm btn-success" onclick="convertirPresupuestoAVenta('${presupuesto.id}')">Vender</button>` : 
                        ''}
                    <button class="btn btn-sm btn-danger" onclick="eliminarPresupuesto('${presupuesto.id}')">Eliminar</button>
                </div>
            `;
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error cargando presupuestos:', error);
        container.innerHTML = '<div class="error">Error cargando presupuestos</div>';
    }
}

async function verPresupuesto(presupuestoId) {
    try {
        let presupuesto = null;
        let items = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data: presupuestoData, error } = await APP_STATE.supabase
                .from('presupuestos')
                .select('*, clientes(*)')
                .eq('id', presupuestoId)
                .single();
            
            if (!error) presupuesto = presupuestoData;
            
            const { data: itemsData } = await APP_STATE.supabase
                .from('presupuesto_items')
                .select('*, productos(*)')
                .eq('presupuesto_id', presupuestoId);
            
            if (itemsData) items = itemsData;
        } else {
            const presupuestos = await indexedDBOperation('presupuestos_offline', 'getAll') || [];
            presupuesto = presupuestos.find(p => p.id === presupuestoId || p.offline_id === presupuestoId);
        }
        
        if (!presupuesto) {
            alert('Presupuesto no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        let itemsHTML = '';
        if (items.length > 0) {
            itemsHTML = items.map(item => `
                <tr>
                    <td>${item.productos?.nombre || 'Producto'}</td>
                    <td>${item.cantidad}</td>
                    <td>$${item.precio_unitario.toFixed(2)}</td>
                    <td>$${item.subtotal.toFixed(2)}</td>
                </tr>
            `).join('');
        }
        
        modalTitle.textContent = `Presupuesto ${presupuesto.numero_presupuesto || ''}`;
        modalBody.innerHTML = `
            <div class="presupuesto-detalle">
                <p><strong>Cliente:</strong> ${presupuesto.clientes?.nombre || 'Sin cliente'}</p>
                <p><strong>Fecha:</strong> ${new Date(presupuesto.created_at).toLocaleDateString('es-AR')}</p>
                <p><strong>Válido hasta:</strong> ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}</p>
                <p><strong>Estado:</strong> ${presupuesto.estado}</p>
                <hr>
                <h4>Productos:</h4>
                <table class="table">
                    <thead>
                        <tr>
                            <th>Producto</th>
                            <th>Cantidad</th>
                            <th>Precio</th>
                            <th>Subtotal</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemsHTML}
                    </tbody>
                </table>
                <hr>
                <p><strong>Subtotal:</strong> $${presupuesto.subtotal.toFixed(2)}</p>
                <p><strong>Descuento:</strong> $${presupuesto.descuento.toFixed(2)}</p>
                <p><strong>Total:</strong> $${presupuesto.total.toFixed(2)}</p>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').style.display = 'none';
        document.getElementById('modalCancel').textContent = 'Cerrar';
        
    } catch (error) {
        console.error('Error viendo presupuesto:', error);
        alert('Error al cargar el presupuesto');
    }
}

async function convertirPresupuestoAVenta(presupuestoId) {
    if (!confirm('¿Convertir este presupuesto en una venta?')) return;
    
    try {
        let presupuesto = null;
        let items = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data: presupuestoData, error } = await APP_STATE.supabase
                .from('presupuestos')
                .select('*')
                .eq('id', presupuestoId)
                .single();
            
            if (error) throw error;
            presupuesto = presupuestoData;
            
            const { data: itemsData } = await APP_STATE.supabase
                .from('presupuesto_items')
                .select('*')
                .eq('presupuesto_id', presupuestoId);
            
            if (itemsData) items = itemsData;
        }
        
        if (!presupuesto) {
            alert('Presupuesto no encontrado');
            return;
        }
        
        APP_STATE.carrito = items.map(item => ({
            id: item.producto_id,
            nombre: 'Producto del presupuesto',
            precio: item.precio_unitario,
            cantidad: item.cantidad,
            subtotal: item.subtotal
        }));
        
        updateCartDisplay();
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            await APP_STATE.supabase
                .from('presupuestos')
                .update({ estado: 'convertido' })
                .eq('id', presupuestoId);
        }
        
        switchPage('pos');
        alert('Presupuesto convertido a venta. Completa el pago.');
        
    } catch (error) {
        console.error('Error convirtiendo presupuesto:', error);
        alert('Error al convertir el presupuesto');
    }
}

async function eliminarPresupuesto(presupuestoId) {
    if (!confirm('¿Eliminar este presupuesto?')) return;
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            await APP_STATE.supabase
                .from('presupuestos')
                .delete()
                .eq('id', presupuestoId);
        } else {
            await indexedDBOperation('presupuestos_offline', 'delete', presupuestoId);
        }
        
        loadPresupuestos();
        alert('Presupuesto eliminado');
    } catch (error) {
        console.error('Error eliminando presupuesto:', error);
        alert('Error al eliminar el presupuesto');
    }
}

async function enviarPresupuestoWhatsapp(presupuestoId) {
    try {
        let presupuesto = null;
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('presupuestos')
                .select('*, clientes(*)')
                .eq('id', presupuestoId)
                .single();
            
            if (error) throw error;
            presupuesto = data;
        }
        
        if (!presupuesto) {
            alert('Presupuesto no encontrado');
            return;
        }
        
        const texto = `📋 Presupuesto ${presupuesto.numero_presupuesto}\n` +
                     `Cliente: ${presupuesto.clientes?.nombre || ''}\n` +
                     `Total: $${presupuesto.total.toFixed(2)}\n` +
                     `Válido hasta: ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}\n\n` +
                     `¡Gracias por su confianza!`;
        
        const telefono = prompt('Ingrese el número de WhatsApp (sin + ni 0):', 
                              presupuesto.clientes?.telefono ? presupuesto.clientes.telefono.replace(/\D/g, '') : '');
        
        if (telefono) {
            const url = `https://wa.me/${telefono}?text=${encodeURIComponent(texto)}`;
            window.open(url, '_blank');
        }
    } catch (error) {
        console.error('Error enviando presupuesto:', error);
        alert('Error al enviar el presupuesto');
    }
}

// ============================================
// CLIENTES Y CUENTA CORRIENTE - COMPLETOS
// ============================================

async function loadClientes() {
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Cargando clientes...</div>';
    
    try {
        let clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        
        if ((!clientes || clientes.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            await syncClientesCache();
            clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        }
        
        if (clientes.length === 0) {
            container.innerHTML = '<div class="no-data">No hay clientes cargados</div>';
            return;
        }
        
        container.innerHTML = '';
        
        clientes.forEach(cliente => {
            const saldoClass = cliente.saldo > 0 ? 'negativo' : 'positivo';
            const saldoText = cliente.saldo > 0 ? `-$${Math.abs(cliente.saldo).toFixed(2)}` : `$${cliente.saldo.toFixed(2)}`;
            
            const row = document.createElement('div');
            row.className = 'cliente-row';
            row.innerHTML = `
                <span>${cliente.nombre} ${cliente.apellido || ''}</span>
                <span>${cliente.numero_documento || 'Sin DNI'}</span>
                <span>${cliente.telefono || 'Sin teléfono'}</span>
                <span class="cliente-saldo ${saldoClass}">${saldoText}</span>
                <div class="cliente-actions">
                    <button class="btn btn-sm btn-primary" onclick="verCliente('${cliente.id}')">Ver</button>
                    <button class="btn btn-sm btn-warning" onclick="editarCliente('${cliente.id}')">Editar</button>
                    <button class="btn btn-sm btn-info" onclick="verMovimientosCliente('${cliente.id}')">Movimientos</button>
                    <button class="btn btn-sm btn-success" onclick="registrarPagoCliente('${cliente.id}')">Pago</button>
                </div>
            `;
            container.appendChild(row);
        });
        
    } catch (error) {
        console.error('Error cargando clientes:', error);
        container.innerHTML = '<div class="error">Error cargando clientes</div>';
    }
}

async function loadClientesParaVenta() {
    const select = document.getElementById('selectCliente');
    if (!select) return;
    
    try {
        let clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        
        if (clientes.length === 0 && APP_STATE.supabase && APP_STATE.isOnline) {
            await syncClientesCache();
            clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        }
        
        select.innerHTML = `
            <option value="">Cliente Contado</option>
            <option value="nuevo">➕ Nuevo Cliente</option>
        `;
        
        clientes.forEach(cliente => {
            const option = document.createElement('option');
            option.value = cliente.id;
            option.textContent = `${cliente.nombre} ${cliente.apellido || ''} - ${cliente.tipo_cliente === 'cuenta_corriente' ? 'CC' : 'Contado'}`;
            select.appendChild(option);
        });
        
    } catch (error) {
        console.error('Error cargando clientes para venta:', error);
    }
}

async function verCliente(clienteId) {
    try {
        let cliente = await indexedDBOperation('clientes_cache', 'get', clienteId);
        
        if (!cliente && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('clientes')
                .select('*')
                .eq('id', clienteId)
                .single();
            
            if (error) throw error;
            cliente = data;
        }
        
        if (!cliente) {
            alert('Cliente no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = `Cliente: ${cliente.nombre} ${cliente.apellido || ''}`;
        modalBody.innerHTML = `
            <div class="cliente-detalle">
                <p><strong>Documento:</strong> ${cliente.numero_documento || 'No especificado'}</p>
                <p><strong>Teléfono:</strong> ${cliente.telefono || 'No especificado'}</p>
                <p><strong>Email:</strong> ${cliente.email || 'No especificado'}</p>
                <p><strong>Dirección:</strong> ${cliente.direccion || 'No especificado'}</p>
                <p><strong>Tipo Cliente:</strong> ${cliente.tipo_cliente || 'consumidor_final'}</p>
                <p><strong>Límite Crédito:</strong> $${cliente.limite_credito.toFixed(2)}</p>
                <p><strong>Saldo Actual:</strong> $${cliente.saldo.toFixed(2)}</p>
                <p><strong>Estado:</strong> ${cliente.activo ? 'Activo' : 'Inactivo'}</p>
                <hr>
                <p><strong>Observaciones:</strong></p>
                <p>${cliente.observaciones || 'Sin observaciones'}</p>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').style.display = 'none';
        document.getElementById('modalCancel').textContent = 'Cerrar';
        
    } catch (error) {
        console.error('Error viendo cliente:', error);
        alert('Error al cargar el cliente');
    }
}

function showNuevoClienteModal() {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    modalTitle.textContent = 'Nuevo Cliente';
    modalBody.innerHTML = `
        <div class="form-cliente">
            <div class="form-group">
                <label>Nombre *</label>
                <input type="text" id="clienteNombre" class="form-control" required>
            </div>
            <div class="form-group">
                <label>Apellido</label>
                <input type="text" id="clienteApellido" class="form-control">
            </div>
            <div class="form-group">
                <label>Documento</label>
                <input type="text" id="clienteDocumento" class="form-control">
            </div>
            <div class="form-group">
                <label>Teléfono</label>
                <input type="tel" id="clienteTelefono" class="form-control">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="clienteEmail" class="form-control">
            </div>
            <div class="form-group">
                <label>Dirección</label>
                <textarea id="clienteDireccion" class="form-control" rows="2"></textarea>
            </div>
            <div class="form-group">
                <label>Tipo de Cliente</label>
                <select id="clienteTipo" class="form-control">
                    <option value="consumidor_final">Consumidor Final</option>
                    <option value="cuenta_corriente">Cuenta Corriente</option>
                    <option value="mayorista">Mayorista</option>
                </select>
            </div>
            <div class="form-group">
                <label>Límite de Crédito</label>
                <input type="number" id="clienteLimite" class="form-control" value="10000" step="100">
            </div>
            <div class="form-group">
                <label>Observaciones</label>
                <textarea id="clienteObservaciones" class="form-control" rows="3"></textarea>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
    
    document.getElementById('modalConfirm').textContent = 'Guardar';
    document.getElementById('modalConfirm').style.display = 'inline-block';
    document.getElementById('modalCancel').textContent = 'Cancelar';
    
    document.getElementById('modalConfirm').onclick = async () => {
        await guardarCliente();
    };
}

async function guardarCliente() {
    const clienteData = {
        nombre: document.getElementById('clienteNombre').value.trim(),
        apellido: document.getElementById('clienteApellido').value.trim(),
        numero_documento: document.getElementById('clienteDocumento').value.trim(),
        telefono: document.getElementById('clienteTelefono').value.trim(),
        email: document.getElementById('clienteEmail').value.trim(),
        direccion: document.getElementById('clienteDireccion').value.trim(),
        tipo_cliente: document.getElementById('clienteTipo').value,
        limite_credito: parseFloat(document.getElementById('clienteLimite').value) || 0,
        saldo: 0,
        observaciones: document.getElementById('clienteObservaciones').value.trim(),
        activo: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    if (!clienteData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { data, error } = await APP_STATE.supabase
                .from('clientes')
                .insert([clienteData])
                .select()
                .single();
            
            if (error) throw error;
            
            await indexedDBOperation('clientes_cache', 'put', data);
        } else {
            clienteData.id = 'cliente_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            clienteData.offline_id = clienteData.id;
            clienteData.sync_status = 'pending';
            
            await indexedDBOperation('clientes_cache', 'put', clienteData);
            
            await savePendingOperation({
                type: 'cliente',
                data: clienteData,
                priority: 5
            });
        }
        
        alert('✅ Cliente guardado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadClientes();
        loadClientesParaVenta();
        
    } catch (error) {
        console.error('Error guardando cliente:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function editarCliente(clienteId) {
    try {
        let cliente = await indexedDBOperation('clientes_cache', 'get', clienteId);
        
        if (!cliente && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('clientes')
                .select('*')
                .eq('id', clienteId)
                .single();
            
            if (error) throw error;
            cliente = data;
        }
        
        if (!cliente) {
            alert('Cliente no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = 'Editar Cliente';
        modalBody.innerHTML = `
            <div class="form-cliente">
                <div class="form-group">
                    <label>Nombre *</label>
                    <input type="text" id="clienteNombre" class="form-control" value="${cliente.nombre || ''}" required>
                </div>
                <div class="form-group">
                    <label>Apellido</label>
                    <input type="text" id="clienteApellido" class="form-control" value="${cliente.apellido || ''}">
                </div>
                <div class="form-group">
                    <label>Documento</label>
                    <input type="text" id="clienteDocumento" class="form-control" value="${cliente.numero_documento || ''}">
                </div>
                <div class="form-group">
                    <label>Teléfono</label>
                    <input type="tel" id="clienteTelefono" class="form-control" value="${cliente.telefono || ''}">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="clienteEmail" class="form-control" value="${cliente.email || ''}">
                </div>
                <div class="form-group">
                    <label>Dirección</label>
                    <textarea id="clienteDireccion" class="form-control" rows="2">${cliente.direccion || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Tipo de Cliente</label>
                    <select id="clienteTipo" class="form-control">
                        <option value="consumidor_final" ${cliente.tipo_cliente === 'consumidor_final' ? 'selected' : ''}>Consumidor Final</option>
                        <option value="cuenta_corriente" ${cliente.tipo_cliente === 'cuenta_corriente' ? 'selected' : ''}>Cuenta Corriente</option>
                        <option value="mayorista" ${cliente.tipo_cliente === 'mayorista' ? 'selected' : ''}>Mayorista</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Límite de Crédito</label>
                    <input type="number" id="clienteLimite" class="form-control" value="${cliente.limite_credito || 0}" step="100">
                </div>
                <div class="form-group">
                    <label>Saldo Actual</label>
                    <input type="number" id="clienteSaldo" class="form-control" value="${cliente.saldo || 0}" step="0.01" readonly>
                </div>
                <div class="form-group">
                    <label>Activo</label>
                    <select id="clienteActivo" class="form-control">
                        <option value="true" ${cliente.activo ? 'selected' : ''}>Sí</option>
                        <option value="false" ${!cliente.activo ? 'selected' : ''}>No</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Observaciones</label>
                    <textarea id="clienteObservaciones" class="form-control" rows="3">${cliente.observaciones || ''}</textarea>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').textContent = 'Actualizar';
        document.getElementById('modalConfirm').style.display = 'inline-block';
        document.getElementById('modalCancel').textContent = 'Cancelar';
        
        document.getElementById('modalConfirm').onclick = async () => {
            await actualizarCliente(clienteId);
        };
        
    } catch (error) {
        console.error('Error cargando cliente para editar:', error);
        alert('Error al cargar el cliente');
    }
}

async function actualizarCliente(clienteId) {
    const clienteData = {
        nombre: document.getElementById('clienteNombre').value.trim(),
        apellido: document.getElementById('clienteApellido').value.trim(),
        numero_documento: document.getElementById('clienteDocumento').value.trim(),
        telefono: document.getElementById('clienteTelefono').value.trim(),
        email: document.getElementById('clienteEmail').value.trim(),
        direccion: document.getElementById('clienteDireccion').value.trim(),
        tipo_cliente: document.getElementById('clienteTipo').value,
        limite_credito: parseFloat(document.getElementById('clienteLimite').value) || 0,
        saldo: parseFloat(document.getElementById('clienteSaldo').value) || 0,
        activo: document.getElementById('clienteActivo').value === 'true',
        observaciones: document.getElementById('clienteObservaciones').value.trim(),
        updated_at: new Date().toISOString()
    };
    
    if (!clienteData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { error } = await APP_STATE.supabase
                .from('clientes')
                .update(clienteData)
                .eq('id', clienteId);
            
            if (error) throw error;
            
            clienteData.id = clienteId;
            await indexedDBOperation('clientes_cache', 'put', clienteData);
        } else {
            clienteData.id = clienteId;
            clienteData.sync_status = 'pending';
            
            await indexedDBOperation('clientes_cache', 'put', clienteData);
            
            await savePendingOperation({
                type: 'cliente',
                data: clienteData,
                operation: 'update',
                priority: 5
            });
        }
        
        alert('✅ Cliente actualizado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadClientes();
        loadClientesParaVenta();
        
    } catch (error) {
        console.error('Error actualizando cliente:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function verMovimientosCliente(clienteId) {
    try {
        let movimientos = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('cuentas_corrientes')
                .select('*')
                .eq('cliente_id', clienteId)
                .order('created_at', { ascending: false })
                .limit(50);
            
            if (!error) movimientos = data;
        }
        
        let cliente = await indexedDBOperation('clientes_cache', 'get', clienteId);
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        let movimientosHTML = '';
        if (movimientos.length > 0) {
            movimientosHTML = movimientos.map(mov => `
                <tr>
                    <td>${new Date(mov.created_at).toLocaleDateString('es-AR')}</td>
                    <td>${mov.tipo_movimiento}</td>
                    <td>$${mov.monto.toFixed(2)}</td>
                    <td>$${mov.saldo_anterior.toFixed(2)}</td>
                    <td>$${mov.saldo_nuevo.toFixed(2)}</td>
                    <td>${mov.observaciones || ''}</td>
                </tr>
            `).join('');
        } else {
            movimientosHTML = '<tr><td colspan="6">No hay movimientos</td></tr>';
        }
        
        modalTitle.textContent = `Movimientos de ${cliente?.nombre || 'Cliente'}`;
        modalBody.innerHTML = `
            <div class="movimientos-cliente">
                <p><strong>Saldo Actual:</strong> $${cliente?.saldo?.toFixed(2) || '0.00'}</p>
                <p><strong>Límite de Crédito:</strong> $${cliente?.limite_credito?.toFixed(2) || '0.00'}</p>
                <hr>
                <h4>Historial de Movimientos:</h4>
                <div style="max-height: 400px; overflow-y: auto;">
                    <table class="table">
                        <thead>
                            <tr>
                                <th>Fecha</th>
                                <th>Tipo</th>
                                <th>Monto</th>
                                <th>Saldo Anterior</th>
                                <th>Saldo Nuevo</th>
                                <th>Observaciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${movimientosHTML}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').style.display = 'none';
        document.getElementById('modalCancel').textContent = 'Cerrar';
        
    } catch (error) {
        console.error('Error viendo movimientos:', error);
        alert('Error al cargar los movimientos');
    }
}

async function registrarPagoCliente(clienteId) {
    try {
        let cliente = await indexedDBOperation('clientes_cache', 'get', clienteId);
        
        if (!cliente) {
            alert('Cliente no encontrado');
            return;
        }
        
        const montoPago = prompt(`Ingrese el monto del pago (Saldo actual: $${cliente.saldo.toFixed(2)}):`, cliente.saldo.toFixed(2));
        
        if (!montoPago || isNaN(montoPago) || parseFloat(montoPago) <= 0) {
            alert('Monto inválido');
            return;
        }
        
        const monto = parseFloat(montoPago);
        const saldoAnterior = cliente.saldo;
        const saldoNuevo = saldoAnterior - monto;
        
        if (saldoNuevo < -cliente.limite_credito) {
            alert(`El pago excede el límite de crédito. Límite: $${cliente.limite_credito.toFixed(2)}`);
            return;
        }
        
        const observaciones = prompt('Observaciones:', 'Pago recibido');
        
        const movimientoCC = {
            cliente_id: clienteId,
            tipo_movimiento: 'pago',
            monto: monto,
            saldo_anterior: saldoAnterior,
            saldo_nuevo: saldoNuevo,
            observaciones: observaciones || 'Pago recibido',
            created_at: new Date().toISOString()
        };
        
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { error } = await APP_STATE.supabase
                .from('cuentas_corrientes')
                .insert([movimientoCC]);
            
            if (error) throw error;
            
            cliente.saldo = saldoNuevo;
            await APP_STATE.supabase
                .from('clientes')
                .update({ saldo: saldoNuevo })
                .eq('id', clienteId);
        } else {
            movimientoCC.offline_id = 'cc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            movimientoCC.sync_status = 'pending';
            
            cliente.saldo = saldoNuevo;
            cliente.sync_status = 'pending';
            
            await indexedDBOperation('clientes_cache', 'put', cliente);
            
            await savePendingOperation({
                type: 'cuenta_corriente',
                data: movimientoCC,
                priority: 8
            });
        }
        
        alert(`✅ Pago registrado correctamente. Nuevo saldo: $${saldoNuevo.toFixed(2)}`);
        
        loadClientes();
        loadClientesParaVenta();
        
    } catch (error) {
        console.error('Error registrando pago:', error);
        alert('Error al registrar el pago');
    }
}

// ============================================
// CAJA Y CIERRES - COMPLETOS
// ============================================

async function loadCajaResumen() {
    const saldoInicialElem = document.getElementById('saldoInicialResumen');
    const ventasEfectivoElem = document.getElementById('ventasEfectivo');
    const ventasTarjetaElem = document.getElementById('ventasTarjeta');
    const ventasTransferenciaElem = document.getElementById('ventasTransferencia');
    const ventasQrElem = document.getElementById('ventasQr');
    const ventasCuentaElem = document.getElementById('ventasCuenta');
    const totalVentasElem = document.getElementById('totalVentas');
    const saldoFinalElem = document.getElementById('saldoFinal');
    const diferenciaElem = document.getElementById('diferenciaResumen');
    
    if (!saldoInicialElem) return;
    
    try {
        let cierreActual = null;
        const hoy = new Date().toISOString().split('T')[0];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('cierres_caja')
                .select('*')
                .eq('fecha', hoy)
                .eq('local_id', APP_STATE.currentLocal?.id)
                .eq('caja_id', APP_STATE.currentCaja?.id)
                .eq('turno', APP_STATE.currentTurno)
                .eq('estado', 'abierto')
                .single();
            
            if (!error) cierreActual = data;
        } else {
            const cierres = await indexedDBOperation('cierres_offline', 'getAll') || [];
            cierreActual = cierres.find(c => 
                c.fecha === hoy && 
                c.local_id === APP_STATE.currentLocal?.id &&
                c.caja_id === APP_STATE.currentCaja?.id &&
                c.turno === APP_STATE.currentTurno &&
                c.estado === 'abierto'
            );
        }
        
        if (cierreActual) {
            saldoInicialElem.textContent = `$${cierreActual.saldo_inicial.toFixed(2)}`;
            
            let ventasEfectivo = cierreActual.ventas_efectivo || 0;
            let ventasTarjeta = cierreActual.ventas_tarjeta || 0;
            let ventasTransferencia = cierreActual.ventas_transferencia || 0;
            let ventasQr = cierreActual.ventas_qr || 0;
            let ventasCuenta = cierreActual.ventas_cuenta_corriente || 0;
            let totalVentas = cierreActual.total_ventas || 0;
            
            if (APP_STATE.supabase && APP_STATE.isOnline) {
                const { data: ventasHoy, error } = await APP_STATE.supabase
                    .from('ventas')
                    .select('total, pagos(metodo)')
                    .eq('local_id', APP_STATE.currentLocal?.id)
                    .eq('caja_id', APP_STATE.currentCaja?.id)
                    .eq('DATE(created_at)', hoy);
                
                if (!error && ventasHoy) {
                    ventasHoy.forEach(venta => {
                        totalVentas += venta.total;
                        if (venta.pagos && venta.pagos[0]) {
                            const metodo = venta.pagos[0].metodo;
                            if (metodo === 'efectivo') ventasEfectivo += venta.total;
                            else if (metodo === 'tarjeta') ventasTarjeta += venta.total;
                            else if (metodo === 'transferencia') ventasTransferencia += venta.total;
                            else if (metodo === 'qr') ventasQr += venta.total;
                            else if (metodo === 'cuenta') ventasCuenta += venta.total;
                        }
                    });
                }
            }
            
            ventasEfectivoElem.textContent = `$${ventasEfectivo.toFixed(2)}`;
            ventasTarjetaElem.textContent = `$${ventasTarjeta.toFixed(2)}`;
            ventasTransferenciaElem.textContent = `$${ventasTransferencia.toFixed(2)}`;
            ventasQrElem.textContent = `$${ventasQr.toFixed(2)}`;
            ventasCuentaElem.textContent = `$${ventasCuenta.toFixed(2)}`;
            totalVentasElem.textContent = `$${totalVentas.toFixed(2)}`;
            
            const saldoFinal = cierreActual.saldo_inicial + ventasEfectivo;
            const diferencia = cierreActual.diferencia || 0;
            
            saldoFinalElem.textContent = `$${saldoFinal.toFixed(2)}`;
            diferenciaElem.textContent = `$${diferencia.toFixed(2)}`;
            
            diferenciaElem.className = diferencia >= 0 ? 'positivo' : 'negativo';
        } else {
            saldoInicialElem.textContent = '$0.00';
            ventasEfectivoElem.textContent = '$0.00';
            ventasTarjetaElem.textContent = '$0.00';
            ventasTransferenciaElem.textContent = '$0.00';
            ventasQrElem.textContent = '$0.00';
            ventasCuentaElem.textContent = '$0.00';
            totalVentasElem.textContent = '$0.00';
            saldoFinalElem.textContent = '$0.00';
            diferenciaElem.textContent = '$0.00';
        }
        
    } catch (error) {
        console.error('Error cargando resumen de caja:', error);
    }
}

async function cerrarCaja() {
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja || !APP_STATE.currentTurno) {
        alert('Primero debes iniciar una sesión de trabajo');
        return;
    }
    
    if (!confirm('¿Estás seguro de cerrar la caja?')) return;
    
    try {
        const hoy = new Date().toISOString().split('T')[0];
        let cierreActual = null;
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('cierres_caja')
                .select('*')
                .eq('fecha', hoy)
                .eq('local_id', APP_STATE.currentLocal?.id)
                .eq('caja_id', APP_STATE.currentCaja?.id)
                .eq('turno', APP_STATE.currentTurno)
                .eq('estado', 'abierto')
                .single();
            
            if (!error) cierreActual = data;
        } else {
            const cierres = await indexedDBOperation('cierres_offline', 'getAll') || [];
            cierreActual = cierres.find(c => 
                c.fecha === hoy && 
                c.local_id === APP_STATE.currentLocal?.id &&
                c.caja_id === APP_STATE.currentCaja?.id &&
                c.turno === APP_STATE.currentTurno &&
                c.estado === 'abierto'
            );
        }
        
        if (!cierreActual) {
            alert('No hay caja abierta para cerrar');
            return;
        }
        
        const saldoFinalInput = prompt('Ingrese el saldo final en caja:', 
                                      (cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0)).toFixed(2));
        if (!saldoFinalInput) return;
        
        const saldoFinal = parseFloat(saldoFinalInput) || 0;
        const diferencia = saldoFinal - (cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0));
        
        const observaciones = prompt('Observaciones del cierre:', 'Cierre normal');
        
        cierreActual.saldo_final = saldoFinal;
        cierreActual.diferencia = diferencia;
        cierreActual.estado = 'cerrado';
        cierreActual.observaciones = observaciones;
        cierreActual.updated_at = new Date().toISOString();
        
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .update(cierreActual)
                .eq('id', cierreActual.id);
            
            if (error) throw error;
        } else {
            cierreActual.offline_id = cierreActual.offline_id || 'cierre_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            cierreActual.sync_status = 'pending';
            await indexedDBOperation('cierres_offline', 'put', cierreActual);
            
            await savePendingOperation({
                type: 'cierre_caja',
                data: cierreActual,
                priority: 10
            });
        }
        
        alert(`✅ Caja cerrada correctamente\n` +
              `Saldo Inicial: $${cierreActual.saldo_inicial.toFixed(2)}\n` +
              `Ventas Efectivo: $${(cierreActual.ventas_efectivo || 0).toFixed(2)}\n` +
              `Saldo Esperado: $${(cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0)).toFixed(2)}\n` +
              `Saldo Final: $${saldoFinal.toFixed(2)}\n` +
              `Diferencia: $${diferencia.toFixed(2)}`);
        
        APP_STATE.currentLocal = null;
        APP_STATE.currentCaja = null;
        APP_STATE.currentTurno = null;
        
        localStorage.removeItem('currentLocal');
        localStorage.removeItem('currentCaja');
        localStorage.removeItem('currentTurno');
        
        showAppScreen();
        
    } catch (error) {
        console.error('Error cerrando caja:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

// ============================================
// PROVEEDORES - COMPLETOS
// ============================================

async function loadProveedores() {
    const container = document.getElementById('proveedoresList');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Cargando proveedores...</div>';
    
    try {
        let proveedores = await indexedDBOperation('proveedores_cache', 'getAll') || [];
        
        if ((!proveedores || proveedores.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            await syncProveedoresCache();
            proveedores = await indexedDBOperation('proveedores_cache', 'getAll') || [];
        }
        
        if (proveedores.length === 0) {
            container.innerHTML = '<div class="no-data">No hay proveedores cargados</div>';
            return;
        }
        
        container.innerHTML = '';
        
        proveedores.forEach(proveedor => {
            const card = document.createElement('div');
            card.className = 'proveedor-card';
            card.innerHTML = `
                <div class="proveedor-header">
                    <h4>${proveedor.nombre}</h4>
                    <span class="proveedor-cuit">${proveedor.cuit || 'Sin CUIT'}</span>
                </div>
                <p>Contacto: ${proveedor.contacto || 'Sin contacto'}</p>
                <p>Tel: ${proveedor.telefono || 'Sin teléfono'}</p>
                <p>Email: ${proveedor.email || 'Sin email'}</p>
                <p>Productos: ${proveedor.productos_que_vende || 'No especificado'}</p>
                <div class="proveedor-actions">
                    <button class="btn btn-sm btn-primary" onclick="contactarProveedor('${proveedor.telefono}', '${proveedor.nombre}')">📞 Contactar</button>
                    <button class="btn btn-sm btn-secondary" onclick="verProveedor('${proveedor.id}')">Ver</button>
                    <button class="btn btn-sm btn-warning" onclick="editarProveedor('${proveedor.id}')">Editar</button>
                    <button class="btn btn-sm btn-danger" onclick="eliminarProveedor('${proveedor.id}')">Eliminar</button>
                </div>
            `;
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error cargando proveedores:', error);
        container.innerHTML = '<div class="error">Error cargando proveedores</div>';
    }
}

function showNuevoProveedorModal() {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    modalTitle.textContent = 'Nuevo Proveedor';
    modalBody.innerHTML = `
        <div class="form-proveedor">
            <div class="form-group">
                <label>Nombre *</label>
                <input type="text" id="proveedorNombre" class="form-control" required>
            </div>
            <div class="form-group">
                <label>Razón Social</label>
                <input type="text" id="proveedorRazonSocial" class="form-control">
            </div>
            <div class="form-group">
                <label>Contacto</label>
                <input type="text" id="proveedorContacto" class="form-control">
            </div>
            <div class="form-group">
                <label>Teléfono</label>
                <input type="tel" id="proveedorTelefono" class="form-control">
            </div>
            <div class="form-group">
                <label>Email</label>
                <input type="email" id="proveedorEmail" class="form-control">
            </div>
            <div class="form-group">
                <label>Dirección</label>
                <textarea id="proveedorDireccion" class="form-control" rows="2"></textarea>
            </div>
            <div class="form-group">
                <label>CUIT</label>
                <input type="text" id="proveedorCuit" class="form-control" placeholder="XX-XXXXXXXX-X">
            </div>
            <div class="form-group">
                <label>Condición IVA</label>
                <select id="proveedorCondicionIva" class="form-control">
                    <option value="responsable_inscripto">Responsable Inscripto</option>
                    <option value="monotributista">Monotributista</option>
                    <option value="exento">Exento</option>
                    <option value="consumidor_final">Consumidor Final</option>
                </select>
            </div>
            <div class="form-group">
                <label>Productos que vende</label>
                <textarea id="proveedorProductos" class="form-control" rows="3" placeholder="Lista de productos principales"></textarea>
            </div>
            <div class="form-group">
                <label>Plazo de entrega</label>
                <input type="text" id="proveedorPlazo" class="form-control" placeholder="Ej: 48hs, 1 semana">
            </div>
            <div class="form-group">
                <label>Observaciones</label>
                <textarea id="proveedorObservaciones" class="form-control" rows="3"></textarea>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
    
    document.getElementById('modalConfirm').textContent = 'Guardar';
    document.getElementById('modalConfirm').style.display = 'inline-block';
    document.getElementById('modalCancel').textContent = 'Cancelar';
    
    document.getElementById('modalConfirm').onclick = async () => {
        await guardarProveedor();
    };
}

async function guardarProveedor() {
    const proveedorData = {
        nombre: document.getElementById('proveedorNombre').value.trim(),
        razon_social: document.getElementById('proveedorRazonSocial').value.trim(),
        contacto: document.getElementById('proveedorContacto').value.trim(),
        telefono: document.getElementById('proveedorTelefono').value.trim(),
        email: document.getElementById('proveedorEmail').value.trim(),
        direccion: document.getElementById('proveedorDireccion').value.trim(),
        cuit: document.getElementById('proveedorCuit').value.trim(),
        condicion_iva: document.getElementById('proveedorCondicionIva').value,
        productos_que_vende: document.getElementById('proveedorProductos').value.trim(),
        plazo_entrega: document.getElementById('proveedorPlazo').value.trim(),
        observaciones: document.getElementById('proveedorObservaciones').value.trim(),
        activo: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    if (!proveedorData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { data, error } = await APP_STATE.supabase
                .from('proveedores')
                .insert([proveedorData])
                .select()
                .single();
            
            if (error) throw error;
            
            await indexedDBOperation('proveedores_cache', 'put', data);
        } else {
            proveedorData.id = 'proveedor_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            proveedorData.offline_id = proveedorData.id;
            proveedorData.sync_status = 'pending';
            
            await indexedDBOperation('proveedores_cache', 'put', proveedorData);
            
            await savePendingOperation({
                type: 'proveedor',
                data: proveedorData,
                priority: 5
            });
        }
        
        alert('✅ Proveedor guardado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadProveedores();
        
    } catch (error) {
        console.error('Error guardando proveedor:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function verProveedor(proveedorId) {
    try {
        let proveedor = await indexedDBOperation('proveedores_cache', 'get', proveedorId);
        
        if (!proveedor && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('proveedores')
                .select('*')
                .eq('id', proveedorId)
                .single();
            
            if (error) throw error;
            proveedor = data;
        }
        
        if (!proveedor) {
            alert('Proveedor no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = `Proveedor: ${proveedor.nombre}`;
        modalBody.innerHTML = `
            <div class="proveedor-detalle">
                <p><strong>Razón Social:</strong> ${proveedor.razon_social || 'No especificado'}</p>
                <p><strong>Contacto:</strong> ${proveedor.contacto || 'No especificado'}</p>
                <p><strong>Teléfono:</strong> ${proveedor.telefono || 'No especificado'}</p>
                <p><strong>Email:</strong> ${proveedor.email || 'No especificado'}</p>
                <p><strong>Dirección:</strong> ${proveedor.direccion || 'No especificado'}</p>
                <p><strong>CUIT:</strong> ${proveedor.cuit || 'No especificado'}</p>
                <p><strong>Condición IVA:</strong> ${proveedor.condicion_iva || 'No especificado'}</p>
                <p><strong>Productos que vende:</strong></p>
                <p>${proveedor.productos_que_vende || 'No especificado'}</p>
                <p><strong>Plazo de entrega:</strong> ${proveedor.plazo_entrega || 'No especificado'}</p>
                <hr>
                <p><strong>Observaciones:</strong></p>
                <p>${proveedor.observaciones || 'Sin observaciones'}</p>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').style.display = 'none';
        document.getElementById('modalCancel').textContent = 'Cerrar';
        
    } catch (error) {
        console.error('Error viendo proveedor:', error);
        alert('Error al cargar el proveedor');
    }
}

async function editarProveedor(proveedorId) {
    try {
        let proveedor = await indexedDBOperation('proveedores_cache', 'get', proveedorId);
        
        if (!proveedor && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('proveedores')
                .select('*')
                .eq('id', proveedorId)
                .single();
            
            if (error) throw error;
            proveedor = data;
        }
        
        if (!proveedor) {
            alert('Proveedor no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = 'Editar Proveedor';
        modalBody.innerHTML = `
            <div class="form-proveedor">
                <div class="form-group">
                    <label>Nombre *</label>
                    <input type="text" id="proveedorNombre" class="form-control" value="${proveedor.nombre || ''}" required>
                </div>
                <div class="form-group">
                    <label>Razón Social</label>
                    <input type="text" id="proveedorRazonSocial" class="form-control" value="${proveedor.razon_social || ''}">
                </div>
                <div class="form-group">
                    <label>Contacto</label>
                    <input type="text" id="proveedorContacto" class="form-control" value="${proveedor.contacto || ''}">
                </div>
                <div class="form-group">
                    <label>Teléfono</label>
                    <input type="tel" id="proveedorTelefono" class="form-control" value="${proveedor.telefono || ''}">
                </div>
                <div class="form-group">
                    <label>Email</label>
                    <input type="email" id="proveedorEmail" class="form-control" value="${proveedor.email || ''}">
                </div>
                <div class="form-group">
                    <label>Dirección</label>
                    <textarea id="proveedorDireccion" class="form-control" rows="2">${proveedor.direccion || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>CUIT</label>
                    <input type="text" id="proveedorCuit" class="form-control" value="${proveedor.cuit || ''}" placeholder="XX-XXXXXXXX-X">
                </div>
                <div class="form-group">
                    <label>Condición IVA</label>
                    <select id="proveedorCondicionIva" class="form-control">
                        <option value="responsable_inscripto" ${proveedor.condicion_iva === 'responsable_inscripto' ? 'selected' : ''}>Responsable Inscripto</option>
                        <option value="monotributista" ${proveedor.condicion_iva === 'monotributista' ? 'selected' : ''}>Monotributista</option>
                        <option value="exento" ${proveedor.condicion_iva === 'exento' ? 'selected' : ''}>Exento</option>
                        <option value="consumidor_final" ${proveedor.condicion_iva === 'consumidor_final' ? 'selected' : ''}>Consumidor Final</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Productos que vende</label>
                    <textarea id="proveedorProductos" class="form-control" rows="3">${proveedor.productos_que_vende || ''}</textarea>
                </div>
                <div class="form-group">
                    <label>Plazo de entrega</label>
                    <input type="text" id="proveedorPlazo" class="form-control" value="${proveedor.plazo_entrega || ''}">
                </div>
                <div class="form-group">
                    <label>Activo</label>
                    <select id="proveedorActivo" class="form-control">
                        <option value="true" ${proveedor.activo ? 'selected' : ''}>Sí</option>
                        <option value="false" ${!proveedor.activo ? 'selected' : ''}>No</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Observaciones</label>
                    <textarea id="proveedorObservaciones" class="form-control" rows="3">${proveedor.observaciones || ''}</textarea>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').textContent = 'Actualizar';
        document.getElementById('modalConfirm').style.display = 'inline-block';
        document.getElementById('modalCancel').textContent = 'Cancelar';
        
        document.getElementById('modalConfirm').onclick = async () => {
            await actualizarProveedor(proveedorId);
        };
        
    } catch (error) {
        console.error('Error cargando proveedor para editar:', error);
        alert('Error al cargar el proveedor');
    }
}

async function actualizarProveedor(proveedorId) {
    const proveedorData = {
        nombre: document.getElementById('proveedorNombre').value.trim(),
        razon_social: document.getElementById('proveedorRazonSocial').value.trim(),
        contacto: document.getElementById('proveedorContacto').value.trim(),
        telefono: document.getElementById('proveedorTelefono').value.trim(),
        email: document.getElementById('proveedorEmail').value.trim(),
        direccion: document.getElementById('proveedorDireccion').value.trim(),
        cuit: document.getElementById('proveedorCuit').value.trim(),
        condicion_iva: document.getElementById('proveedorCondicionIva').value,
        productos_que_vende: document.getElementById('proveedorProductos').value.trim(),
        plazo_entrega: document.getElementById('proveedorPlazo').value.trim(),
        activo: document.getElementById('proveedorActivo').value === 'true',
        observaciones: document.getElementById('proveedorObservaciones').value.trim(),
        updated_at: new Date().toISOString()
    };
    
    if (!proveedorData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { error } = await APP_STATE.supabase
                .from('proveedores')
                .update(proveedorData)
                .eq('id', proveedorId);
            
            if (error) throw error;
            
            proveedorData.id = proveedorId;
            await indexedDBOperation('proveedores_cache', 'put', proveedorData);
        } else {
            proveedorData.id = proveedorId;
            proveedorData.sync_status = 'pending';
            
            await indexedDBOperation('proveedores_cache', 'put', proveedorData);
            
            await savePendingOperation({
                type: 'proveedor',
                data: proveedorData,
                operation: 'update',
                priority: 5
            });
        }
        
        alert('✅ Proveedor actualizado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadProveedores();
        
    } catch (error) {
        console.error('Error actualizando proveedor:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function eliminarProveedor(proveedorId) {
    if (!confirm('¿Eliminar este proveedor?')) return;
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            await APP_STATE.supabase
                .from('proveedores')
                .update({ activo: false })
                .eq('id', proveedorId);
        } else {
            const proveedor = await indexedDBOperation('proveedores_cache', 'get', proveedorId);
            if (proveedor) {
                proveedor.activo = false;
                proveedor.sync_status = 'pending';
                await indexedDBOperation('proveedores_cache', 'put', proveedor);
                
                await savePendingOperation({
                    type: 'proveedor',
                    data: proveedor,
                    operation: 'update',
                    priority: 5
                });
            }
        }
        
        loadProveedores();
        alert('Proveedor eliminado');
    } catch (error) {
        console.error('Error eliminando proveedor:', error);
        alert('Error al eliminar el proveedor');
    }
}

async function contactarProveedor(telefono, nombre) {
    if (!telefono || telefono === 'Sin teléfono') {
        alert('No hay teléfono registrado');
        return;
    }
    
    const mensaje = `Hola ${nombre}, necesito hacer un pedido`;
    const url = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
}

// ============================================
// PRODUCTOS CRUD COMPLETO
// ============================================

function showNuevoProductoModal() {
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    modalTitle.textContent = 'Nuevo Producto';
    modalBody.innerHTML = `
        <div class="form-producto">
            <div class="form-row">
                <div class="form-group col-md-6">
                    <label>Nombre *</label>
                    <input type="text" id="productoNombre" class="form-control" required>
                </div>
                <div class="form-group col-md-6">
                    <label>Código de Barras</label>
                    <input type="text" id="productoCodigoBarras" class="form-control">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group col-md-6">
                    <label>Código Interno</label>
                    <input type="text" id="productoCodigoInterno" class="form-control">
                </div>
                <div class="form-group col-md-6">
                    <label>Categoría</label>
                    <input type="text" id="productoCategoria" class="form-control" list="categoriasList">
                    <datalist id="categoriasList"></datalist>
                </div>
            </div>
            <div class="form-group">
                <label>Descripción</label>
                <textarea id="productoDescripcion" class="form-control" rows="2"></textarea>
            </div>
            <div class="form-row">
                <div class="form-group col-md-4">
                    <label>Precio Costo</label>
                    <input type="number" id="productoPrecioCosto" class="form-control" step="0.01" min="0" value="0">
                </div>
                <div class="form-group col-md-4">
                    <label>% Ganancia</label>
                    <input type="number" id="productoPorcentajeGanancia" class="form-control" min="0" max="500" value="40">
                </div>
                <div class="form-group col-md-4">
                    <label>Precio Venta</label>
                    <input type="number" id="productoPrecioVenta" class="form-control" step="0.01" min="0" value="0">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group col-md-4">
                    <label>Stock</label>
                    <input type="number" id="productoStock" class="form-control" step="0.001" min="0" value="0">
                </div>
                <div class="form-group col-md-4">
                    <label>Stock Mínimo</label>
                    <input type="number" id="productoStockMinimo" class="form-control" step="0.001" min="0" value="5">
                </div>
                <div class="form-group col-md-4">
                    <label>Stock Máximo</label>
                    <input type="number" id="productoStockMaximo" class="form-control" step="0.001" min="0" value="100">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group col-md-6">
                    <label>Unidad de Medida</label>
                    <select id="productoUnidadMedida" class="form-control">
                        <option value="unidad">Unidad</option>
                        <option value="metro">Metro</option>
                        <option value="litro">Litro</option>
                        <option value="kilogramo">Kilogramo</option>
                        <option value="par">Par</option>
                        <option value="juego">Juego</option>
                    </select>
                </div>
                <div class="form-group col-md-6">
                    <label>Ubicación</label>
                    <input type="text" id="productoUbicacion" class="form-control">
                </div>
            </div>
            <div class="form-group">
                <label>Observaciones</label>
                <textarea id="productoObservaciones" class="form-control" rows="2"></textarea>
            </div>
        </div>
    `;
    modal.style.display = 'flex';
    
    document.getElementById('modalConfirm').textContent = 'Guardar';
    document.getElementById('modalConfirm').style.display = 'inline-block';
    document.getElementById('modalCancel').textContent = 'Cancelar';
    
    document.getElementById('modalConfirm').onclick = async () => {
        await guardarProducto();
    };
    
    cargarCategoriasParaSelect();
    configurarCalculoPrecioVenta();
}

function configurarCalculoPrecioVenta() {
    const precioCosto = document.getElementById('productoPrecioCosto');
    const porcentajeGanancia = document.getElementById('productoPorcentajeGanancia');
    const precioVenta = document.getElementById('productoPrecioVenta');
    
    if (precioCosto && porcentajeGanancia && precioVenta) {
        const calcularPrecioVenta = () => {
            const costo = parseFloat(precioCosto.value) || 0;
            const porcentaje = parseFloat(porcentajeGanancia.value) || 0;
            const ventaCalculado = costo * (1 + porcentaje / 100);
            precioVenta.value = ventaCalculado.toFixed(2);
        };
        
        precioCosto.addEventListener('input', calcularPrecioVenta);
        porcentajeGanancia.addEventListener('input', calcularPrecioVenta);
        
        calcularPrecioVenta();
    }
}

async function cargarCategoriasParaSelect() {
    try {
        const categorias = await indexedDBOperation('categorias_cache', 'getAll') || [];
        const datalist = document.getElementById('categoriasList');
        
        if (datalist && categorias.length > 0) {
            datalist.innerHTML = categorias.map(cat => 
                `<option value="${cat.nombre}">${cat.nombre}</option>`
            ).join('');
        }
    } catch (error) {
        console.warn('Error cargando categorías:', error);
    }
}

async function guardarProducto() {
    const productoData = {
        nombre: document.getElementById('productoNombre').value.trim(),
        codigo_barras: document.getElementById('productoCodigoBarras').value.trim(),
        codigo_interno: document.getElementById('productoCodigoInterno').value.trim(),
        descripcion: document.getElementById('productoDescripcion').value.trim(),
        categoria: document.getElementById('productoCategoria').value.trim(),
        precio_costo: parseFloat(document.getElementById('productoPrecioCosto').value) || 0,
        porcentaje_ganancia: parseFloat(document.getElementById('productoPorcentajeGanancia').value) || 0,
        precio_venta: parseFloat(document.getElementById('productoPrecioVenta').value) || 0,
        stock: parseFloat(document.getElementById('productoStock').value) || 0,
        stock_minimo: parseFloat(document.getElementById('productoStockMinimo').value) || 5,
        stock_maximo: parseFloat(document.getElementById('productoStockMaximo').value) || 100,
        unidad_medida: document.getElementById('productoUnidadMedida').value,
        ubicacion: document.getElementById('productoUbicacion').value.trim(),
        observaciones: document.getElementById('productoObservaciones').value.trim(),
        activo: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    };
    
    if (!productoData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    if (productoData.precio_venta <= 0) {
        alert('El precio de venta debe ser mayor a 0');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { data, error } = await APP_STATE.supabase
                .from('productos')
                .insert([productoData])
                .select()
                .single();
            
            if (error) throw error;
            
            await indexedDBOperation('productos_cache', 'put', data);
        } else {
            productoData.id = 'producto_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            productoData.offline_id = productoData.id;
            productoData.sync_status = 'pending';
            
            await indexedDBOperation('productos_cache', 'put', productoData);
            
            await savePendingOperation({
                type: 'producto',
                data: productoData,
                priority: 5
            });
        }
        
        alert('✅ Producto guardado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadProductos();
        loadProductosParaVenta();
        
    } catch (error) {
        console.error('Error guardando producto:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function editarProducto(productoId) {
    try {
        let producto = await indexedDBOperation('productos_cache', 'get', productoId);
        
        if (!producto && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('productos')
                .select('*')
                .eq('id', productoId)
                .single();
            
            if (error) throw error;
            producto = data;
        }
        
        if (!producto) {
            alert('Producto no encontrado');
            return;
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = 'Editar Producto';
        modalBody.innerHTML = `
            <div class="form-producto">
                <div class="form-row">
                    <div class="form-group col-md-6">
                        <label>Nombre *</label>
                        <input type="text" id="productoNombre" class="form-control" value="${producto.nombre || ''}" required>
                    </div>
                    <div class="form-group col-md-6">
                        <label>Código de Barras</label>
                        <input type="text" id="productoCodigoBarras" class="form-control" value="${producto.codigo_barras || ''}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group col-md-6">
                        <label>Código Interno</label>
                        <input type="text" id="productoCodigoInterno" class="form-control" value="${producto.codigo_interno || ''}">
                    </div>
                    <div class="form-group col-md-6">
                        <label>Categoría</label>
                        <input type="text" id="productoCategoria" class="form-control" value="${producto.categoria || ''}" list="categoriasList">
                        <datalist id="categoriasList"></datalist>
                    </div>
                </div>
                <div class="form-group">
                    <label>Descripción</label>
                    <textarea id="productoDescripcion" class="form-control" rows="2">${producto.descripcion || ''}</textarea>
                </div>
                <div class="form-row">
                    <div class="form-group col-md-4">
                        <label>Precio Costo</label>
                        <input type="number" id="productoPrecioCosto" class="form-control" step="0.01" min="0" value="${producto.precio_costo || 0}">
                    </div>
                    <div class="form-group col-md-4">
                        <label>% Ganancia</label>
                        <input type="number" id="productoPorcentajeGanancia" class="form-control" min="0" max="500" value="${producto.porcentaje_ganancia || 40}">
                    </div>
                    <div class="form-group col-md-4">
                        <label>Precio Venta</label>
                        <input type="number" id="productoPrecioVenta" class="form-control" step="0.01" min="0" value="${producto.precio_venta || 0}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group col-md-4">
                        <label>Stock</label>
                        <input type="number" id="productoStock" class="form-control" step="0.001" min="0" value="${producto.stock || 0}">
                    </div>
                    <div class="form-group col-md-4">
                        <label>Stock Mínimo</label>
                        <input type="number" id="productoStockMinimo" class="form-control" step="0.001" min="0" value="${producto.stock_minimo || 5}">
                    </div>
                    <div class="form-group col-md-4">
                        <label>Stock Máximo</label>
                        <input type="number" id="productoStockMaximo" class="form-control" step="0.001" min="0" value="${producto.stock_maximo || 100}">
                    </div>
                </div>
                <div class="form-row">
                    <div class="form-group col-md-6">
                        <label>Unidad de Medida</label>
                        <select id="productoUnidadMedida" class="form-control">
                            <option value="unidad" ${producto.unidad_medida === 'unidad' ? 'selected' : ''}>Unidad</option>
                            <option value="metro" ${producto.unidad_medida === 'metro' ? 'selected' : ''}>Metro</option>
                            <option value="litro" ${producto.unidad_medida === 'litro' ? 'selected' : ''}>Litro</option>
                            <option value="kilogramo" ${producto.unidad_medida === 'kilogramo' ? 'selected' : ''}>Kilogramo</option>
                            <option value="par" ${producto.unidad_medida === 'par' ? 'selected' : ''}>Par</option>
                            <option value="juego" ${producto.unidad_medida === 'juego' ? 'selected' : ''}>Juego</option>
                        </select>
                    </div>
                    <div class="form-group col-md-6">
                        <label>Ubicación</label>
                        <input type="text" id="productoUbicacion" class="form-control" value="${producto.ubicacion || ''}">
                    </div>
                </div>
                <div class="form-group">
                    <label>Activo</label>
                    <select id="productoActivo" class="form-control">
                        <option value="true" ${producto.activo ? 'selected' : ''}>Sí</option>
                        <option value="false" ${!producto.activo ? 'selected' : ''}>No</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Observaciones</label>
                    <textarea id="productoObservaciones" class="form-control" rows="2">${producto.observaciones || ''}</textarea>
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').textContent = 'Actualizar';
        document.getElementById('modalConfirm').style.display = 'inline-block';
        document.getElementById('modalCancel').textContent = 'Cancelar';
        
        document.getElementById('modalConfirm').onclick = async () => {
            await actualizarProducto(productoId);
        };
        
        cargarCategoriasParaSelect();
        configurarCalculoPrecioVenta();
        
    } catch (error) {
        console.error('Error cargando producto para editar:', error);
        alert('Error al cargar el producto');
    }
}

async function actualizarProducto(productoId) {
    const productoData = {
        nombre: document.getElementById('productoNombre').value.trim(),
        codigo_barras: document.getElementById('productoCodigoBarras').value.trim(),
        codigo_interno: document.getElementById('productoCodigoInterno').value.trim(),
        descripcion: document.getElementById('productoDescripcion').value.trim(),
        categoria: document.getElementById('productoCategoria').value.trim(),
        precio_costo: parseFloat(document.getElementById('productoPrecioCosto').value) || 0,
        porcentaje_ganancia: parseFloat(document.getElementById('productoPorcentajeGanancia').value) || 0,
        precio_venta: parseFloat(document.getElementById('productoPrecioVenta').value) || 0,
        stock: parseFloat(document.getElementById('productoStock').value) || 0,
        stock_minimo: parseFloat(document.getElementById('productoStockMinimo').value) || 5,
        stock_maximo: parseFloat(document.getElementById('productoStockMaximo').value) || 100,
        unidad_medida: document.getElementById('productoUnidadMedida').value,
        ubicacion: document.getElementById('productoUbicacion').value.trim(),
        activo: document.getElementById('productoActivo').value === 'true',
        observaciones: document.getElementById('productoObservaciones').value.trim(),
        updated_at: new Date().toISOString()
    };
    
    if (!productoData.nombre) {
        alert('El nombre es obligatorio');
        return;
    }
    
    if (productoData.precio_venta <= 0) {
        alert('El precio de venta debe ser mayor a 0');
        return;
    }
    
    try {
        if (APP_STATE.isOnline && APP_STATE.supabase) {
            const { error } = await APP_STATE.supabase
                .from('productos')
                .update(productoData)
                .eq('id', productoId);
            
            if (error) throw error;
            
            productoData.id = productoId;
            await indexedDBOperation('productos_cache', 'put', productoData);
        } else {
            productoData.id = productoId;
            productoData.sync_status = 'pending';
            
            await indexedDBOperation('productos_cache', 'put', productoData);
            
            await savePendingOperation({
                type: 'producto',
                data: productoData,
                operation: 'update',
                priority: 5
            });
        }
        
        alert('✅ Producto actualizado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        loadProductos();
        loadProductosParaVenta();
        
    } catch (error) {
        console.error('Error actualizando producto:', error);
        alert(`❌ Error: ${error.message || 'Error desconocido'}`);
    }
}

async function eliminarProducto(productoId) {
    if (!confirm('¿Eliminar este producto?')) return;
    
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            await APP_STATE.supabase
                .from('productos')
                .update({ activo: false })
                .eq('id', productoId);
        } else {
            const producto = await indexedDBOperation('productos_cache', 'get', productoId);
            if (producto) {
                producto.activo = false;
                producto.sync_status = 'pending';
                await indexedDBOperation('productos_cache', 'put', producto);
                
                await savePendingOperation({
                    type: 'producto',
                    data: producto,
                    operation: 'update',
                    priority: 5
                });
            }
        }
        
        loadProductos();
        loadProductosParaVenta();
        alert('Producto eliminado');
    } catch (error) {
        console.error('Error eliminando producto:', error);
        alert('Error al eliminar el producto');
    }
}

// ============================================
// IMPORTAR/EXPORTAR EXCEL
// ============================================

async function importarExcelProductos() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.xlsx,.xls';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        
        reader.onload = async (event) => {
            try {
                const data = event.target.result;
                const productos = parseCSV(data);
                
                let count = 0;
                for (const producto of productos) {
                    if (producto.nombre && producto.precio_venta) {
                        const productoData = {
                            ...producto,
                            activo: true,
                            created_at: new Date().toISOString(),
                            updated_at: new Date().toISOString()
                        };
                        
                        if (APP_STATE.isOnline && APP_STATE.supabase) {
                            const { error } = await APP_STATE.supabase
                                .from('productos')
                                .insert([productoData]);
                            
                            if (!error) count++;
                        } else {
                            productoData.id = 'producto_imp_' + Date.now() + '_' + count;
                            productoData.offline_id = productoData.id;
                            productoData.sync_status = 'pending';
                            
                            await indexedDBOperation('productos_cache', 'put', productoData);
                            
                            await savePendingOperation({
                                type: 'producto',
                                data: productoData,
                                priority: 3
                            });
                            
                            count++;
                        }
                    }
                }
                
                alert(`✅ ${count} productos importados correctamente`);
                loadProductos();
                loadProductosParaVenta();
                
            } catch (error) {
                console.error('Error importando productos:', error);
                alert('Error al importar productos');
            }
        };
        
        if (file.name.endsWith('.csv')) {
            reader.readAsText(file);
        } else {
            alert('Formato no soportado. Usa CSV.');
        }
    };
    
    input.click();
}

function parseCSV(csvText) {
    const lines = csvText.split('\n');
    const headers = lines[0].split(',').map(h => h.trim());
    const productos = [];
    
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        
        const values = lines[i].split(',').map(v => v.trim());
        const producto = {};
        
        headers.forEach((header, index) => {
            if (values[index]) {
                producto[header] = values[index];
            }
        });
        
        if (producto.nombre) {
            productos.push(producto);
        }
    }
    
    return productos;
}

async function exportarExcelProductos() {
    try {
        const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        
        if (productos.length === 0) {
            alert('No hay productos para exportar');
            return;
        }
        
        const headers = ['nombre', 'codigo_barras', 'codigo_interno', 'categoria', 'precio_costo', 'precio_venta', 'stock', 'stock_minimo', 'unidad_medida', 'ubicacion'];
        const csvContent = [
            headers.join(','),
            ...productos.map(p => headers.map(h => p[h] || '').join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `productos_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        alert(`✅ ${productos.length} productos exportados`);
        
    } catch (error) {
        console.error('Error exportando productos:', error);
        alert('Error al exportar productos');
    }
}

// ============================================
// REPORTES - COMPLETOS
// ============================================

async function loadReportes() {
    const container = document.getElementById('reportesContent');
    if (!container) return;
    
    container.innerHTML = `
        <div class="reportes-grid">
            <div class="reporte-card">
                <h3>📊 Ventas Hoy</h3>
                <div class="reporte-data" id="reporteVentasHoy">Cargando...</div>
            </div>
            <div class="reporte-card">
                <h3>📦 Stock Bajo</h3>
                <div class="reporte-data" id="reporteStockBajo">Cargando...</div>
            </div>
            <div class="reporte-card">
                <h3>👥 Clientes con Deuda</h3>
                <div class="reporte-data" id="reporteClientesDeuda">Cargando...</div>
            </div>
            <div class="reporte-card">
                <h3>💰 Cierre de Caja</h3>
                <div class="reporte-data" id="reporteCierreCaja">Cargando...</div>
            </div>
            <div class="reporte-card">
                <h3>📈 Productos Más Vendidos</h3>
                <div class="reporte-data" id="reporteProductosVendidos">Cargando...</div>
            </div>
            <div class="reporte-card">
                <h3>💳 Métodos de Pago</h3>
                <div class="reporte-data" id="reporteMetodosPago">Cargando...</div>
            </div>
        </div>
        <div class="reporte-actions" style="margin-top: 20px;">
            <button class="btn btn-primary" onclick="generarReporteMensual()">📅 Reporte Mensual</button>
            <button class="btn btn-secondary" onclick="exportarReporteExcel()">📊 Exportar Excel</button>
        </div>
    `;
    
    await cargarDatosReportes();
}

async function cargarDatosReportes() {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        let ventasHoy = [];
        let totalVentasHoy = 0;
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('ventas')
                .select('total, created_at, pagos(metodo)')
                .eq('DATE(created_at)', hoy);
            
            if (!error && data) {
                ventasHoy = data;
                totalVentasHoy = data.reduce((sum, v) => sum + v.total, 0);
            }
        }
        
        document.getElementById('reporteVentasHoy').innerHTML = `
            <p>Ventas: ${ventasHoy.length}</p>
            <p>Total: $${totalVentasHoy.toFixed(2)}</p>
            <p>Promedio: $${ventasHoy.length > 0 ? (totalVentasHoy / ventasHoy.length).toFixed(2) : '0.00'}</p>
        `;
        
        const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        const stockBajo = productos.filter(p => p.stock <= p.stock_minimo);
        
        document.getElementById('reporteStockBajo').innerHTML = `
            <p>Productos: ${stockBajo.length}</p>
            ${stockBajo.slice(0, 3).map(p => `<p>${p.nombre}: ${p.stock} (mín: ${p.stock_minimo})</p>`).join('')}
            ${stockBajo.length > 3 ? `<p>... y ${stockBajo.length - 3} más</p>` : ''}
        `;
        
        const clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        const clientesDeuda = clientes.filter(c => c.saldo > 0);
        const totalDeuda = clientesDeuda.reduce((sum, c) => sum + c.saldo, 0);
        
        document.getElementById('reporteClientesDeuda').innerHTML = `
            <p>Clientes: ${clientesDeuda.length}</p>
            <p>Deuda total: $${totalDeuda.toFixed(2)}</p>
            <p>Promedio: $${clientesDeuda.length > 0 ? (totalDeuda / clientesDeuda.length).toFixed(2) : '0.00'}</p>
        `;
        
        const cierreActual = await obtenerCierreActual();
        
        document.getElementById('reporteCierreCaja').innerHTML = `
            <p>Estado: ${cierreActual ? 'Abierta' : 'Cerrada'}</p>
            ${cierreActual ? `
                <p>Saldo Inicial: $${cierreActual.saldo_inicial.toFixed(2)}</p>
                <p>Ventas Efectivo: $${(cierreActual.ventas_efectivo || 0).toFixed(2)}</p>
                <p>Saldo Esperado: $${(cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0)).toFixed(2)}</p>
            ` : '<p>No hay caja abierta</p>'}
        `;
        
        let productosVendidos = [];
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('venta_items')
                .select('producto_id, cantidad, productos(nombre)')
                .order('cantidad', { ascending: false })
                .limit(5);
            
            if (!error && data) {
                productosVendidos = data;
            }
        }
        
        document.getElementById('reporteProductosVendidos').innerHTML = `
            ${productosVendidos.length > 0 ? 
                productosVendidos.map(item => 
                    `<p>${item.productos?.nombre || 'Producto'}: ${item.cantidad} unidades</p>`
                ).join('') : 
                '<p>No hay datos de ventas</p>'
            }
        `;
        
        const metodosPago = {
            efectivo: 0,
            tarjeta: 0,
            transferencia: 0,
            qr: 0,
            cuenta: 0
        };
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('pagos')
                .select('metodo, monto')
                .eq('DATE(created_at)', hoy);
            
            if (!error && data) {
                data.forEach(pago => {
                    if (metodosPago.hasOwnProperty(pago.metodo)) {
                        metodosPago[pago.metodo] += pago.monto;
                    }
                });
            }
        }
        
        document.getElementById('reporteMetodosPago').innerHTML = `
            ${Object.entries(metodosPago).map(([metodo, monto]) => 
                `<p>${metodo.toUpperCase()}: $${monto.toFixed(2)}</p>`
            ).join('')}
        `;
        
    } catch (error) {
        console.error('Error cargando reportes:', error);
    }
}

async function obtenerCierreActual() {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('cierres_caja')
                .select('*')
                .eq('fecha', hoy)
                .eq('local_id', APP_STATE.currentLocal?.id)
                .eq('caja_id', APP_STATE.currentCaja?.id)
                .eq('turno', APP_STATE.currentTurno)
                .eq('estado', 'abierto')
                .single();
            
            if (!error) return data;
        } else {
            const cierres = await indexedDBOperation('cierres_offline', 'getAll') || [];
            return cierres.find(c => 
                c.fecha === hoy && 
                c.local_id === APP_STATE.currentLocal?.id &&
                c.caja_id === APP_STATE.currentCaja?.id &&
                c.turno === APP_STATE.currentTurno &&
                c.estado === 'abierto'
            );
        }
    } catch (error) {
        console.error('Error obteniendo cierre actual:', error);
        return null;
    }
}

async function generarReporteMensual() {
    const mesActual = new Date().getMonth() + 1;
    const añoActual = new Date().getFullYear();
    
    try {
        let ventasMes = [];
        let totalMes = 0;
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('ventas')
                .select('*, pagos(metodo)')
                .gte('created_at', `${añoActual}-${mesActual.toString().padStart(2, '0')}-01`)
                .lt('created_at', `${añoActual}-${(mesActual + 1).toString().padStart(2, '0')}-01`);
            
            if (!error && data) {
                ventasMes = data;
                totalMes = data.reduce((sum, v) => sum + v.total, 0);
            }
        }
        
        const modal = document.getElementById('genericModal');
        const modalBody = document.getElementById('modalBody');
        const modalTitle = document.getElementById('modalTitle');
        
        modalTitle.textContent = `Reporte Mensual ${mesActual}/${añoActual}`;
        modalBody.innerHTML = `
            <div class="reporte-mensual">
                <h4>Resumen del Mes</h4>
                <p><strong>Total de Ventas:</strong> ${ventasMes.length}</p>
                <p><strong>Total Recaudado:</strong> $${totalMes.toFixed(2)}</p>
                <p><strong>Promedio por Venta:</strong> $${ventasMes.length > 0 ? (totalMes / ventasMes.length).toFixed(2) : '0.00'}</p>
                <hr>
                <h4>Distribución por Día</h4>
                <div style="max-height: 300px; overflow-y: auto;">
                    ${generarResumenPorDia(ventasMes)}
                </div>
                <hr>
                <h4>Top 5 Productos</h4>
                <div style="max-height: 200px; overflow-y: auto;">
                    ${await generarTopProductos()}
                </div>
            </div>
        `;
        modal.style.display = 'flex';
        
        document.getElementById('modalConfirm').style.display = 'none';
        document.getElementById('modalCancel').textContent = 'Cerrar';
        
    } catch (error) {
        console.error('Error generando reporte mensual:', error);
        alert('Error al generar el reporte');
    }
}

function generarResumenPorDia(ventas) {
    const ventasPorDia = {};
    
    ventas.forEach(venta => {
        const fecha = new Date(venta.created_at).toLocaleDateString('es-AR');
        if (!ventasPorDia[fecha]) {
            ventasPorDia[fecha] = {
                cantidad: 0,
                total: 0
            };
        }
        ventasPorDia[fecha].cantidad++;
        ventasPorDia[fecha].total += venta.total;
    });
    
    const dias = Object.entries(ventasPorDia).sort((a, b) => new Date(b[0]) - new Date(a[0]));
    
    if (dias.length === 0) {
        return '<p>No hay ventas este mes</p>';
    }
    
    return dias.map(([fecha, datos]) => `
        <div class="dia-resumen">
            <p><strong>${fecha}:</strong> ${datos.cantidad} ventas - $${datos.total.toFixed(2)}</p>
        </div>
    `).join('');
}

async function generarTopProductos() {
    try {
        let topProductos = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('venta_items')
                .select('producto_id, SUM(cantidad) as total_vendido, productos(nombre)')
                .group('producto_id, productos(nombre)')
                .order('total_vendido', { ascending: false })
                .limit(5);
            
            if (!error && data) {
                topProductos = data;
            }
        }
        
        if (topProductos.length === 0) {
            return '<p>No hay datos de productos vendidos</p>';
        }
        
        return topProductos.map(item => `
            <div class="top-producto">
                <p>${item.productos?.nombre || 'Producto'}: ${item.total_vendido} unidades</p>
            </div>
        `).join('');
    } catch (error) {
        console.error('Error generando top productos:', error);
        return '<p>Error al cargar productos</p>';
    }
}

async function exportarReporteExcel() {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        let ventasHoy = [];
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('ventas')
                .select('*, pagos(metodo), venta_items(*, productos(nombre))')
                .eq('DATE(created_at)', hoy);
            
            if (!error) ventasHoy = data;
        }
        
        if (ventasHoy.length === 0) {
            alert('No hay ventas para exportar hoy');
            return;
        }
        
        const reporteData = [];
        ventasHoy.forEach(venta => {
            venta.venta_items?.forEach(item => {
                reporteData.push({
                    fecha: new Date(venta.created_at).toLocaleString('es-AR'),
                    numero_venta: venta.numero_venta,
                    producto: item.productos?.nombre || 'Producto',
                    cantidad: item.cantidad,
                    precio: item.precio_unitario,
                    subtotal: item.subtotal,
                    metodo_pago: venta.pagos?.[0]?.metodo || 'desconocido',
                    total_venta: venta.total
                });
            });
        });
        
        const headers = ['fecha', 'numero_venta', 'producto', 'cantidad', 'precio', 'subtotal', 'metodo_pago', 'total_venta'];
        const csvContent = [
            headers.join(','),
            ...reporteData.map(row => headers.map(h => row[h] || '').join(','))
        ].join('\n');
        
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        
        link.setAttribute('href', url);
        link.setAttribute('download', `reporte_ventas_${hoy}.csv`);
        link.style.visibility = 'hidden';
        
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        alert(`✅ Reporte exportado: ${reporteData.length} items`);
        
    } catch (error) {
        console.error('Error exportando reporte:', error);
        alert('Error al exportar el reporte');
    }
}

// ============================================
// SCANNER Y BÚSQUEDA - COMPLETOS
// ============================================

async function handleProductSearch(e) {
    if (e.key === 'Enter') {
        const searchTerm = e.target.value.trim();
        if (!searchTerm) return;
        
        let producto = null;
        
        try {
            const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
            producto = productos.find(p => 
                (p.codigo_barras && p.codigo_barras === searchTerm) || 
                (p.codigo_interno && p.codigo_interno === searchTerm) ||
                (p.nombre && p.nombre.toLowerCase().includes(searchTerm.toLowerCase()))
            );
        } catch (error) {
            console.warn('Error buscando producto en cache:', error);
        }
        
        if (!producto && APP_STATE.supabase && APP_STATE.isOnline) {
            try {
                const { data, error } = await APP_STATE.supabase
                    .from('productos')
                    .select('*')
                    .or(`codigo_barras.eq.${searchTerm},codigo_interno.eq.${searchTerm},nombre.ilike.%${searchTerm}%`)
                    .eq('activo', true)
                    .limit(1)
                    .single();
                
                if (!error && data) {
                    producto = data;
                    await indexedDBOperation('productos_cache', 'put', producto);
                }
            } catch (error) {
                console.warn('Error buscando producto en Supabase:', error);
            }
        }
        
        if (producto) {
            agregarAlCarrito(producto.id);
            e.target.value = '';
            e.target.focus();
        } else {
            alert('Producto no encontrado');
        }
    }
}

let scannerStream = null;
let barcodeDetector = null;

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
            alert('Tu navegador no soporta el acceso a la cámara');
            return;
        }
        
        scannerStream = await navigator.mediaDevices.getUserMedia({ 
            video: { facingMode: 'environment' } 
        });
        
        scannerVideo.srcObject = scannerStream;
        scannerContainer.style.display = 'block';
        APP_STATE.scannerActive = true;
        
        if ('BarcodeDetector' in window) {
            barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code'] });
            startBarcodeDetection();
        } else {
            simulateBarcodeDetection();
        }
        
    } catch (error) {
        console.error('Error accediendo a la cámara:', error);
        alert('No se pudo acceder a la cámara. Asegúrate de conceder los permisos necesarios.');
    }
}

async function startBarcodeDetection() {
    const scannerVideo = document.getElementById('scannerVideo');
    if (!scannerVideo || !barcodeDetector) return;
    
    const detectBarcode = async () => {
        if (!APP_STATE.scannerActive) return;
        
        try {
            const barcodes = await barcodeDetector.detect(scannerVideo);
            
            if (barcodes.length > 0) {
                const barcode = barcodes[0];
                const productSearch = document.getElementById('productSearch');
                if (productSearch) {
                    productSearch.value = barcode.rawValue;
                    const event = new KeyboardEvent('keyup', { key: 'Enter' });
                    productSearch.dispatchEvent(event);
                }
                stopScanner();
            }
        } catch (error) {
            console.error('Error detectando código de barras:', error);
        }
        
        if (APP_STATE.scannerActive) {
            requestAnimationFrame(detectBarcode);
        }
    };
    
    scannerVideo.addEventListener('loadeddata', () => {
        detectBarcode();
    });
}

function stopScanner() {
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }
    
    const scannerContainer = document.getElementById('scannerContainer');
    if (scannerContainer) scannerContainer.style.display = 'none';
    
    APP_STATE.scannerActive = false;
    barcodeDetector = null;
}

function simulateBarcodeDetection() {
    console.log('Simulando detección de código de barras...');
    
    const checkForManualInput = () => {
        if (!APP_STATE.scannerActive) return;
        
        const productSearch = document.getElementById('productSearch');
        if (productSearch && productSearch.value.length >= 8) {
            const event = new KeyboardEvent('keyup', { key: 'Enter' });
            productSearch.dispatchEvent(event);
            stopScanner();
        } else {
            setTimeout(checkForManualInput, 500);
        }
    };
    
    checkForManualInput();
}

function activateKeyboardMode() {
    const productSearch = document.getElementById('productSearch');
    if (productSearch) {
        productSearch.focus();
        productSearch.value = '';
    }
}

// ============================================
// CONFIGURACIONES Y UTILIDADES
// ============================================

async function loadConfiguraciones() {
    try {
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('configuraciones')
                .select('*');
            
            if (!error && data) {
                data.forEach(config => {
                    localStorage.setItem(`config_${config.clave}`, JSON.stringify(config.valor));
                });
            }
        }
    } catch (error) {
        console.warn('Error cargando configuraciones:', error);
    }
}

function handleModalConfirm() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

function handleModalCancel() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

function generarProductosEjemplo() {
    return [
        {
            id: 'prod-1-' + Date.now(),
            codigo_barras: '7791234567890',
            codigo_interno: 'HERR-001',
            nombre: 'Martillo de Acero 500g',
            descripcion: 'Martillo con mango de fibra de vidrio',
            marca: 'Truper',
            categoria: 'Herramientas Manuales',
            subcategoria: 'Martillos',
            unidad_medida: 'unidad',
            precio_costo: 1250,
            porcentaje_ganancia: 40,
            precio_venta: 1750,
            stock: 15,
            stock_minimo: 5,
            stock_maximo: 30,
            ubicacion: 'A-01',
            activo: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        },
        {
            id: 'prod-2-' + Date.now(),
            codigo_barras: '7791234567891',
            codigo_interno: 'HERR-002',
            nombre: 'Destornillador Plano 6x100',
            descripcion: 'Destornillador plano profesional',
            marca: 'Bahco',
            categoria: 'Herramientas Manuales',
            subcategoria: 'Destornilladores',
            unidad_medida: 'unidad',
            precio_costo: 850,
            porcentaje_ganancia: 45,
            precio_venta: 1232.5,
            stock: 8,
            stock_minimo: 10,
            stock_maximo: 50,
            ubicacion: 'A-02',
            activo: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }
    ];
}

// ============================================
// FUNCIONES GLOBALES
// ============================================

window.agregarAlCarrito = agregarAlCarrito;
window.updateCantidad = updateCantidad;
window.removeFromCart = removeFromCart;
window.changePrice = changePrice;
window.handleProductSearch = handleProductSearch;
window.finalizarVenta = finalizarVenta;
window.crearPresupuesto = crearPresupuesto;
window.cancelarVenta = cancelarVenta;
window.updateCartTotal = updateCartTotal;
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
window.verProveedor = verProveedor;
window.contactarProveedor = contactarProveedor;
window.verPresupuesto = verPresupuesto;
window.convertirPresupuestoAVenta = convertirPresupuestoAVenta;
window.enviarPresupuestoWhatsapp = enviarPresupuestoWhatsapp;
window.eliminarPresupuesto = eliminarPresupuesto;
window.verMovimientosCliente = verMovimientosCliente;
window.registrarPagoCliente = registrarPagoCliente;
window.editarProveedor = editarProveedor;
window.eliminarProveedor = eliminarProveedor;
window.toggleScanner = toggleScanner;
window.stopScanner = stopScanner;
window.activateKeyboardMode = activateKeyboardMode;
window.configurarImpresora = configurarImpresora;
window.generarReporteMensual = generarReporteMensual;
window.exportarReporteExcel = exportarReporteExcel;

// ============================================
// REAL-TIME SUBSCRIPTIONS
// ============================================

async function setupRealtimeSubscriptions() {
    if (!APP_STATE.supabase) return;
    
    try {
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
                        await loadProductos();
                    }
                }
            )
            .subscribe();
        
        const ventasChannel = APP_STATE.supabase
            .channel('ventas-changes')
            .on('postgres_changes', 
                { event: 'INSERT', schema: 'public', table: 'ventas' }, 
                (payload) => {
                    console.log('Nueva venta:', payload);
                    if (payload.new.local_id === APP_STATE.currentLocal?.id) {
                        APP_STATE.ventasHoy++;
                    }
                }
            )
            .subscribe();
        
        const clientesChannel = APP_STATE.supabase
            .channel('clientes-changes')
            .on('postgres_changes',
                { event: '*', schema: 'public', table: 'clientes' },
                async (payload) => {
                    console.log('Cambio en clientes:', payload);
                    
                    if (payload.new) {
                        await indexedDBOperation('clientes_cache', 'put', payload.new);
                    }
                    
                    if (APP_STATE.currentPage === 'clientes') {
                        await loadClientes();
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
// EVENTOS FINALES
// ============================================

window.addEventListener('beforeunload', saveAppState);
window.addEventListener('load', () => {
    if (APP_STATE.carrito && APP_STATE.carrito.length > 0) {
        updateCartDisplay();
    }
});

console.log('✅ app.js cargado completamente');
