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

// Depuración - verificar que los botones existen
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const navButtons = document.querySelectorAll('.nav-btn');
        console.log('Botones de navegación encontrados:', navButtons.length);
        navButtons.forEach((btn, i) => {
            console.log(`Botón ${i}:`, {
                text: btn.textContent,
                dataPage: btn.dataset.page,
                className: btn.className
            });
        });
    }, 1000);
});

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
    const supabaseUrl = localStorage.getItem('https://manccbrodsboxtkrgpvm.supabase.co');
    const supabaseKey = localStorage.getItem('sb_publishable_uFJcZUlmh3htTha0wX7knQ_4h8Z3FH3');
    
    if (supabaseUrl && supabaseKey) {
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
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        if (initialConfig) initialConfig.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';
        loadLocalesYCajas();
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
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            // Cargar locales - CORRECTO: usa 'activo'
            const { data: locales, error: errorLocales } = await APP_STATE.supabase
                .from('locales')
                .select('*')
                .eq('activo', true)
                .order('nombre');
            
            // Cargar cajas - CORREGIDO: 'activo' en lugar de 'activa'
            const { data: cajas, error: errorCajas } = await APP_STATE.supabase
                .from('cajas')
                .select('*')
                .eq('activo', true)  // ✅ CORRECCIÓN CRÍTICA AQUÍ
                .order('numero');
            
            if (!errorLocales && locales) {
                localSelect.innerHTML = '<option value="">Seleccionar local...</option>';
                locales.forEach(local => {
                    const option = document.createElement('option');
                    option.value = local.id;
                    option.textContent = local.nombre;
                    localSelect.appendChild(option);
                });
            }
            
            if (!errorCajas && cajas) {
                cajaSelect.innerHTML = '<option value="">Seleccionar caja...</option>';
                cajas.forEach(caja => {
                    const option = document.createElement('option');
                    option.value = caja.id;
                    option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
                    cajaSelect.appendChild(option);
                });
            }
        }
    } catch (error) {
        console.warn('Error cargando locales y cajas:', error);
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
// CONFIGURACIÓN DE EVENTOS - CORREGIDA
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
    
    // Navegación - versión mejorada
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
// NAVEGACIÓN Y PÁGINAS - VERSIÓN CORREGIDA
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
// VENTAS Y PAGOS COMPLETOS - SIMPLIFICADOS
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
                <div class="payment-simple">
                    <div class="payment-icon">
                        <i class="fas fa-credit-card fa-3x"></i>
                    </div>
                    <p>Se registrará como pago con tarjeta</p>
                    <p><strong>Referencia automática generada</strong></p>
                </div>
            `;
            break;
        case 'transferencia':
            html = `
                <div class="payment-simple">
                    <div class="payment-icon">
                        <i class="fas fa-university fa-3x"></i>
                    </div>
                    <p>Se registrará como transferencia bancaria</p>
                    <p><strong>Referencia automática generada</strong></p>
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
            html = `
                <div class="payment-simple">
                    <div class="payment-icon">
                        <i class="fas fa-file-invoice-dollar fa-3x"></i>
                    </div>
                    <p>Se registrará en cuenta corriente del cliente</p>
                    <p><strong>Referencia automática generada</strong></p>
                </div>
            `;
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
    
    const activePaymentBtn = document.querySelector('.payment-btn.active');
    if (activePaymentBtn) {
        metodo = activePaymentBtn.dataset.method || 'efectivo';
    }
    
    switch (metodo) {
        case 'efectivo':
            referencia = `EF-${Date.now().toString().slice(-6)}`;
            break;
        case 'tarjeta':
            referencia = `TJ-${Date.now().toString().slice(-6)}`;
            break;
        case 'transferencia':
            referencia = `TRF-${Date.now().toString().slice(-6)}`;
            break;
        case 'qr':
            referencia = `QR-${Date.now().toString().slice(-6)}`;
            break;
        case 'cuenta':
            referencia = `CC-${Date.now().toString().slice(-6)}`;
            break;
    }
    
    let montoRecibido = total;
    let vuelto = 0;
    if (metodo === 'efectivo') {
        const montoInput = document.getElementById('montoRecibido');
        if (montoInput) {
            montoRecibido = parseFloat(montoInput.value) || total;
            vuelto = montoRecibido - total;
            if (vuelto < 0) vuelto = 0;
        }
    }
    
    const clienteSelect = document.getElementById('selectCliente');
    const clienteId = clienteSelect && clienteSelect.value === 'cuenta' ? 'cliente_cc' : null;
    
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
        ...(metodo === 'efectivo' && {
            monto_recibido: montoRecibido,
            vuelto: vuelto
        }),
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
            ${metodo === 'efectivo' && pago.vuelto > 0 ? `
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
                <p>Valido hasta: ${new Date(presupuesto.valido_hasta).toLocaleDateString('es-AR')}</p>
                <p>Total: $${presupuesto.total.toFixed(2)}</p>
                <div class="presupuesto-actions">
                    <button class="btn btn-sm btn-primary" onclick="verPresupuesto('${presupuesto.id}')">Ver</button>
                    ${presupuesto.estado === 'pendiente' ? 
                        `<button class="btn btn-sm btn-success" onclick="convertirPresupuestoAVenta('${presupuesto.id}')">Vender</button>` : 
                        ''}
                </div>
            `;
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error cargando presupuestos:', error);
        container.innerHTML = '<div class="error">Error cargando presupuestos</div>';
    }
}

function verPresupuesto(presupuestoId) {
    alert(`Ver presupuesto ${presupuestoId}. Implementación pendiente.`);
}

function convertirPresupuestoAVenta(presupuestoId) {
    if (confirm('¿Convertir este presupuesto en una venta?')) {
        alert(`Presupuesto ${presupuestoId} convertido a venta. Implementación pendiente.`);
    }
}

// ============================================
// CLIENTES Y CUENTA CORRIENTE
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
        
        select.innerHTML = '<option value="">Cliente Contado</option>';
        
        clientes.forEach(cliente => {
            if (cliente.tipo_cliente === 'cuenta_corriente') {
                const option = document.createElement('option');
                option.value = cliente.id;
                option.textContent = `${cliente.nombre} (CC) - Saldo: $${cliente.saldo.toFixed(2)}`;
                select.appendChild(option);
            }
        });
        
    } catch (error) {
        console.error('Error cargando clientes para venta:', error);
    }
}

function verCliente(clienteId) {
    alert(`Ver cliente ${clienteId}. Implementación pendiente.`);
}

function editarCliente(clienteId) {
    alert(`Editar cliente ${clienteId}. Implementación pendiente.`);
}

// ============================================
// CAJA Y CIERRES
// ============================================

async function loadCajaResumen() {
    const saldoInicialElem = document.getElementById('saldoInicialResumen');
    const ventasEfectivoElem = document.getElementById('ventasEfectivo');
    const ventasTarjetaElem = document.getElementById('ventasTarjeta');
    const totalVentasElem = document.getElementById('totalVentas');
    const saldoFinalElem = document.getElementById('saldoFinal');
    
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
            
            let ventasEfectivo = 0;
            let ventasTarjeta = 0;
            let totalVentas = 0;
            
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
                            if (venta.pagos[0].metodo === 'efectivo') ventasEfectivo += venta.total;
                            if (venta.pagos[0].metodo === 'tarjeta') ventasTarjeta += venta.total;
                        }
                    });
                }
            }
            
            ventasEfectivoElem.textContent = `$${ventasEfectivo.toFixed(2)}`;
            ventasTarjetaElem.textContent = `$${ventasTarjeta.toFixed(2)}`;
            totalVentasElem.textContent = `$${totalVentas.toFixed(2)}`;
            
            const saldoFinal = cierreActual.saldo_inicial + ventasEfectivo;
            saldoFinalElem.textContent = `$${saldoFinal.toFixed(2)}`;
        } else {
            saldoInicialElem.textContent = '$0.00';
            ventasEfectivoElem.textContent = '$0.00';
            ventasTarjetaElem.textContent = '$0.00';
            totalVentasElem.textContent = '$0.00';
            saldoFinalElem.textContent = '$0.00';
        }
        
    } catch (error) {
        console.error('Error cargando resumen de caja:', error);
    }
}

async function cerrarCaja() {
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
        
        const saldoFinalInput = prompt('Ingrese el saldo final en caja:', '0.00');
        if (!saldoFinalInput) return;
        
        const saldoFinal = parseFloat(saldoFinalInput) || 0;
        const diferencia = saldoFinal - (cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0));
        
        cierreActual.saldo_final = saldoFinal;
        cierreActual.diferencia = diferencia;
        cierreActual.estado = 'cerrado';
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
        
        alert(`✅ Caja cerrada correctamente\nDiferencia: $${diferencia.toFixed(2)}`);
        
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
// PROVEEDORES
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
                <div class="proveedor-actions">
                    <button class="btn btn-sm btn-primary" onclick="contactarProveedor('${proveedor.telefono}', '${proveedor.nombre}')">📞 Contactar</button>
                    <button class="btn btn-sm btn-secondary" onclick="verProveedor('${proveedor.id}')">Ver</button>
                </div>
            `;
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error cargando proveedores:', error);
        container.innerHTML = '<div class="error">Error cargando proveedores</div>';
    }
}

function verProveedor(proveedorId) {
    alert(`Ver proveedor ${proveedorId}. Implementación pendiente.`);
}

function contactarProveedor(telefono, nombre) {
    if (!telefono || telefono === 'Sin teléfono') {
        alert('No hay teléfono registrado');
        return;
    }
    
    const mensaje = `Hola ${nombre}, necesito hacer un pedido`;
    const url = `https://wa.me/${telefono.replace(/\D/g, '')}?text=${encodeURIComponent(mensaje)}`;
    window.open(url, '_blank');
}

// ============================================
// REPORTES
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
        </div>
    `;
    
    await cargarDatosReportes();
}

async function cargarDatosReportes() {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        let ventasHoy = 0;
        let totalVentasHoy = 0;
        
        if (APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('ventas')
                .select('total')
                .eq('DATE(created_at)', hoy);
            
            if (!error && data) {
                ventasHoy = data.length;
                totalVentasHoy = data.reduce((sum, v) => sum + v.total, 0);
            }
        }
        
        document.getElementById('reporteVentasHoy').innerHTML = `
            <p>Ventas: ${ventasHoy}</p>
            <p>Total: $${totalVentasHoy.toFixed(2)}</p>
        `;
        
        const productos = await indexedDBOperation('productos_cache', 'getAll') || [];
        const stockBajo = productos.filter(p => p.stock <= p.stock_minimo);
        
        document.getElementById('reporteStockBajo').innerHTML = `
            <p>Productos: ${stockBajo.length}</p>
            ${stockBajo.slice(0, 3).map(p => `<p>${p.nombre}: ${p.stock}</p>`).join('')}
            ${stockBajo.length > 3 ? `<p>... y ${stockBajo.length - 3} más</p>` : ''}
        `;
        
        const clientes = await indexedDBOperation('clientes_cache', 'getAll') || [];
        const clientesDeuda = clientes.filter(c => c.saldo > 0);
        
        document.getElementById('reporteClientesDeuda').innerHTML = `
            <p>Clientes: ${clientesDeuda.length}</p>
            <p>Deuda total: $${clientesDeuda.reduce((sum, c) => sum + c.saldo, 0).toFixed(2)}</p>
        `;
        
        document.getElementById('reporteCierreCaja').innerHTML = `
            <p>Turno: ${APP_STATE.currentTurno || 'No iniciado'}</p>
            <p>Caja: ${APP_STATE.currentCaja?.numero || 'No seleccionada'}</p>
            <p>Local: ${APP_STATE.currentLocal?.nombre || 'No seleccionado'}</p>
        `;
        
    } catch (error) {
        console.error('Error cargando reportes:', error);
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

// Funciones de modales (stubs para evitar errores)
function showNuevoProductoModal() {
    alert('Funcionalidad de nuevo producto - Implementación pendiente');
}

function showNuevoClienteModal() {
    alert('Funcionalidad de nuevo cliente - Implementación pendiente');
}

function showNuevoProveedorModal() {
    alert('Funcionalidad de nuevo proveedor - Implementación pendiente');
}

function importarExcelProductos() {
    alert('Funcionalidad de importar Excel - Implementación pendiente');
}

function exportarExcelProductos() {
    alert('Funcionalidad de exportar Excel - Implementación pendiente');
}

function editarProducto(productoId) {
    alert(`Editar producto ${productoId} - Implementación pendiente`);
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
window.verCliente = verCliente;
window.editarCliente = editarCliente;
window.verProveedor = verProveedor;
window.contactarProveedor = contactarProveedor;
window.verPresupuesto = verPresupuesto;
window.convertirPresupuestoAVenta = convertirPresupuestoAVenta;
window.toggleScanner = toggleScanner;
window.stopScanner = stopScanner;
window.activateKeyboardMode = activateKeyboardMode;

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
