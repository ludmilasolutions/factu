// ============================================
// SISTEMA POS - APP.JS - VERSIÓN 100% ONLINE
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '3.0.0',
    SYNC_INTERVAL: 10000,
    STOCK_ALERT_THRESHOLD: 5
};

// Estado global de la aplicación
const APP_STATE = {
    supabase: null,
    currentUser: null,
    currentLocal: null,
    currentCaja: null,
    currentTurno: null,
    isOnline: navigator.onLine,
    carrito: [],
    currentPage: 'pos',
    scannerActive: false,
    currentCliente: null,
    ventasHoy: 0,
    presupuestosPendientes: 0
};

// Inicialización
document.addEventListener('DOMContentLoaded', async () => {
    console.log('🚀 Inicializando Sistema POS Online...');
    
    // Configurar Supabase
    await initSupabase();
    
    // Configurar eventos
    setupEventListeners();
    
    // Verificar sesión
    await checkSession();
    
    // Iniciar Realtime subscriptions
    setTimeout(setupRealtimeSubscriptions, 2000);
    
    console.log('✅ Sistema Online inicializado');
});

// ============================================
// INICIALIZACIÓN SUPABASE
// ============================================

async function initSupabase() {
    // URL y Key de Supabase (reemplaza con tus credenciales)
    const supabaseUrl = 'https://cnspoegifxkzdpkcyguj.supabase.co';
    const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuc3BvZWdpZnhremRwa2N5Z3VqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5NjQzODMsImV4cCI6MjA4NDU0MDM4M30.IVoJZAFNzVAlDZx4Ppwz8_P0x1QTXQyWBF3FjUVOYYQ';
    
    try {
        if (!window.supabase) {
            await loadSupabase();
        }
        
        APP_STATE.supabase = window.supabase.createClient(supabaseUrl, supabaseKey, {
            auth: {
                persistSession: true,
                autoRefreshToken: true,
                detectSessionInUrl: true
            },
            realtime: {
                params: {
                    eventsPerSecond: 10
                }
            }
        });
        
        console.log('✅ Supabase configurado');
        
        // Verificar sesión existente
        const { data: { session } } = await APP_STATE.supabase.auth.getSession();
        if (session) {
            APP_STATE.currentUser = session.user;
            await loadUserData(session.user.email);
        }
    } catch (error) {
        console.error('❌ Error configurando Supabase:', error);
        alert('Error de conexión con la base de datos. Verifica tu conexión a internet.');
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
    try {
        const { data: { session }, error } = await APP_STATE.supabase.auth.getSession();
        
        if (error) {
            console.error('Error verificando sesión:', error);
            showLoginScreen();
            return;
        }
        
        if (session) {
            APP_STATE.currentUser = session.user;
            await loadUserData(session.user.email);
            showAppScreen();
        } else {
            showLoginScreen();
        }
    } catch (error) {
        console.error('Error en checkSession:', error);
        showLoginScreen();
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
            
            // Guardar sesión en localStorage para persistencia
            localStorage.setItem('pos_user', JSON.stringify(APP_STATE.currentUser));
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
    
    // Cargar locales y cajas disponibles
    loadLocalesYCajas();
    
    // Verificar si ya hay una sesión de trabajo activa
    const savedLocal = localStorage.getItem('currentLocal');
    const savedCaja = localStorage.getItem('currentCaja');
    const savedTurno = localStorage.getItem('currentTurno');
    
    if (savedLocal && savedCaja && savedTurno) {
        APP_STATE.currentLocal = JSON.parse(savedLocal);
        APP_STATE.currentCaja = JSON.parse(savedCaja);
        APP_STATE.currentTurno = savedTurno;
        
        if (initialConfig) initialConfig.style.display = 'none';
        if (mainApp) mainApp.style.display = 'block';
        updateSessionInfo();
        loadInitialData();
    } else {
        if (initialConfig) initialConfig.style.display = 'block';
        if (mainApp) mainApp.style.display = 'none';
    }
}

function updateSessionInfo() {
    const userInfo = document.getElementById('userInfo');
    const localInfo = document.getElementById('localInfo');
    const cajaInfo = document.getElementById('cajaInfo');
    const turnoInfo = document.getElementById('turnoInfo');
    const syncStatus = document.getElementById('syncStatus');
    
    if (userInfo) userInfo.textContent = `Usuario: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email || 'Sin nombre'}`;
    if (localInfo) localInfo.textContent = `Local: ${APP_STATE.currentLocal?.nombre || 'Sin local'}`;
    if (cajaInfo) cajaInfo.textContent = `Caja: ${APP_STATE.currentCaja?.numero || 'Sin caja'}`;
    if (turnoInfo) turnoInfo.textContent = `Turno: ${APP_STATE.currentTurno || 'Sin turno'}`;
    if (syncStatus) {
        syncStatus.textContent = '🟢 Online';
        syncStatus.className = 'btn-status online';
        syncStatus.title = 'Conectado a la base de datos';
    }
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
    
    try {
        if (status) status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
        
        const { data, error } = await APP_STATE.supabase.auth.signInWithPassword({
            email: email,
            password: password
        });
        
        if (error) {
            throw error;
        }
        
        APP_STATE.currentUser = data.user;
        
        // Cargar datos adicionales del usuario
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
        
        showAppScreen();
        
    } catch (error) {
        console.error('Error en login:', error);
        if (status) status.innerHTML = `<p class="error">❌ Error: ${error.message || 'Error de autenticación'}</p>`;
    }
}

function handleLogout() {
    if (APP_STATE.supabase) {
        APP_STATE.supabase.auth.signOut();
    }
    
    localStorage.removeItem('pos_user');
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
        
        // Cargar locales desde Supabase
        console.log('🌐 Cargando locales y cajas desde Supabase...');
        
        // Locales
        const { data: locales, error: localesError } = await APP_STATE.supabase
            .from('locales')
            .select('id, nombre, direccion')
            .eq('activo', true)
            .order('nombre');
        
        if (localesError) throw localesError;
        
        if (locales && locales.length > 0) {
            locales.forEach(local => {
                const option = document.createElement('option');
                option.value = local.id;
                option.textContent = local.nombre;
                option.dataset.direccion = local.direccion;
                localSelect.appendChild(option);
            });
            console.log(`✅ ${locales.length} locales cargados`);
        } else {
            console.warn('⚠️ No hay locales configurados en la base de datos');
        }
        
        // Cajas
        const { data: cajas, error: cajasError } = await APP_STATE.supabase
            .from('cajas')
            .select('id, numero, nombre')
            .eq('activo', true)
            .order('numero');
        
        if (cajasError) throw cajasError;
        
        if (cajas && cajas.length > 0) {
            cajas.forEach(caja => {
                const option = document.createElement('option');
                option.value = caja.id;
                option.textContent = `${caja.numero} - ${caja.nombre || ''}`;
                cajaSelect.appendChild(option);
            });
            console.log(`✅ ${cajas.length} cajas cargadas`);
        } else {
            console.warn('⚠️ No hay cajas configuradas en la base de datos');
        }
        
    } catch (error) {
        console.error('❌ Error cargando locales y cajas:', error);
        alert('Error cargando datos de locales y cajas. Verifica tu conexión.');
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
    
    // Guardar en localStorage para persistencia
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
        usuario_id: APP_STATE.currentUser?.id,
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
        const { data, error } = await APP_STATE.supabase
            .from('cierres_caja')
            .insert([cierreData])
            .select()
            .single();
        
        if (error) throw error;
        
        console.log('✅ Caja abierta correctamente:', data);
        
    } catch (error) {
        console.error('Error abriendo caja:', error);
        alert('Error al abrir caja. Verifica los datos.');
    }
}

// ============================================
// CONFIGURACIÓN DE EVENTOS
// ============================================

function setupEventListeners() {
    // Login
    const loginBtn = document.getElementById('loginBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    
    if (loginBtn) loginBtn.addEventListener('click', handleLogin);
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
    
    // Sincronización manual
    const syncManual = document.getElementById('syncManual');
    if (syncManual) syncManual.addEventListener('click', syncData);
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
// SINCRONIZACIÓN DE DATOS
// ============================================

async function syncData() {
    try {
        // Forzar recarga de todos los datos
        await loadProductosParaVenta();
        await loadClientesParaVenta();
        
        if (APP_STATE.currentPage === 'productos') await loadProductos();
        if (APP_STATE.currentPage === 'clientes') await loadClientes();
        if (APP_STATE.currentPage === 'proveedores') await loadProveedores();
        if (APP_STATE.currentPage === 'presupuestos') await loadPresupuestos();
        if (APP_STATE.currentPage === 'caja') await loadCajaResumen();
        if (APP_STATE.currentPage === 'reportes') await loadReportes();
        
        alert('✅ Datos sincronizados correctamente');
    } catch (error) {
        console.error('Error sincronizando datos:', error);
        alert('❌ Error al sincronizar datos');
    }
}

// ============================================
// GESTIÓN DE PRODUCTOS
// ============================================

async function loadInitialData() {
    await loadProductosParaVenta();
    await loadClientesParaVenta();
}

async function loadProductosParaVenta() {
    try {
        if (!APP_STATE.supabase) {
            console.error('Supabase no está inicializado');
            return;
        }
        
        const { data: productos, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .eq('activo', true)
            .order('nombre')
            .limit(100);
        
        if (error) throw error;
        
        if (APP_STATE.currentPage === 'pos') {
            actualizarBuscadorProductos(productos);
            mostrarProductosEnVenta(productos);
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

function mostrarProductosEnVenta(productos) {
    const container = document.getElementById('productsGrid');
    if (!container) return;
    
    container.innerHTML = '';
    
    if (!productos || productos.length === 0) {
        container.innerHTML = '<div class="no-data">No hay productos disponibles</div>';
        return;
    }
    
    productos.forEach(producto => {
        const stockClass = producto.stock <= producto.stock_minimo ? 'bajo' : 
                          producto.stock <= (producto.stock_minimo * 2) ? 'critico' : 'normal';
        
        const card = document.createElement('div');
        card.className = 'product-card';
        card.innerHTML = `
            <h4>${producto.nombre}</h4>
            <p class="price">$${(producto.precio_venta || 0).toFixed(2)}</p>
            <p class="stock ${stockClass}">Stock: ${producto.stock || 0}</p>
            <button class="btn btn-sm btn-outline" onclick="agregarAlCarrito('${producto.id}')">
                <i class="fas fa-plus"></i> Agregar
            </button>
        `;
        
        container.appendChild(card);
    });
}

async function loadProductos() {
    try {
        const { data: productos, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .order('nombre')
            .limit(200);
        
        if (error) throw error;
        
        displayProductos(productos);
        
    } catch (error) {
        console.error('Error cargando productos:', error);
        const container = document.getElementById('productosList');
        if (container) {
            container.innerHTML = '<div class="error">Error cargando productos</div>';
        }
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
        const { data: producto, error } = await APP_STATE.supabase
            .from('productos')
            .select('*')
            .eq('id', productoId)
            .single();
        
        if (error) throw error;
        
        if (!producto) {
            alert('Producto no encontrado');
            return;
        }
        
        if (producto.stock <= 0) {
            alert('Producto sin stock disponible');
            return;
        }
        
        const existingItem = APP_STATE.carrito.find(item => item.id === producto.id);
        
        if (existingItem) {
            if (existingItem.cantidad >= producto.stock) {
                alert('Stock insuficiente');
                return;
            }
            existingItem.cantidad += 1;
            existingItem.subtotal = existingItem.cantidad * existingItem.precio;
        } else {
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
    
    if (nuevaCantidad > item.stock) {
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
// VENTAS Y PAGOS
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
    
    const ventaData = {
        local_id: APP_STATE.currentLocal?.id,
        caja_id: APP_STATE.currentCaja?.id,
        usuario_id: APP_STATE.currentUser?.id,
        cliente_id: clienteId,
        total: total,
        descuento: descuento,
        subtotal: subtotal,
        estado: 'completada',
        tipo_venta: metodo === 'cuenta' ? 'cuenta_corriente' : 'contado',
        tipo_comprobante: 'ticket',
        numero_venta: `V${Date.now().toString().slice(-8)}`,
        created_at: new Date().toISOString()
    };
    
    try {
        // Iniciar transacción
        const { data: venta, error: ventaError } = await APP_STATE.supabase
            .from('ventas')
            .insert([ventaData])
            .select()
            .single();
        
        if (ventaError) throw ventaError;
        
        // Insertar items de la venta
        const items = APP_STATE.carrito.map(item => ({
            venta_id: venta.id,
            producto_id: item.id,
            cantidad: item.cantidad || 1,
            precio_unitario: item.precio || 0,
            descuento_unitario: 0,
            subtotal: item.subtotal || 0,
            created_at: new Date().toISOString()
        }));
        
        for (const item of items) {
            const { error: itemError } = await APP_STATE.supabase
                .from('venta_items')
                .insert([item]);
            
            if (itemError) throw itemError;
            
            // Actualizar stock del producto
            await APP_STATE.supabase.rpc('decrementar_stock', {
                product_id: item.producto_id,
                cantidad: item.cantidad
            });
        }
        
        // Registrar pago
        const pagoData = {
            venta_id: venta.id,
            metodo: metodo,
            monto: total,
            referencia: referencia,
            estado: 'completado',
            detalles: JSON.stringify(detalles),
            created_at: new Date().toISOString()
        };
        
        const { error: pagoError } = await APP_STATE.supabase
            .from('pagos')
            .insert([pagoData]);
        
        if (pagoError) throw pagoError;
        
        // Si es cuenta corriente, registrar movimiento
        if (metodo === 'cuenta' && clienteId) {
            const movimientoCC = {
                cliente_id: clienteId,
                tipo_movimiento: 'venta',
                monto: total,
                saldo_anterior: 0,
                saldo_nuevo: total,
                venta_id: venta.id,
                observaciones: 'Venta a cuenta corriente',
                created_at: new Date().toISOString()
            };
            
            const { error: ccError } = await APP_STATE.supabase
                .from('cuentas_corrientes')
                .insert([movimientoCC]);
            
            if (ccError) throw ccError;
            
            // Actualizar saldo del cliente
            await APP_STATE.supabase.rpc('incrementar_saldo_cliente', {
                cliente_id: clienteId,
                monto: total
            });
        }
        
        // Actualizar cierre de caja
        await actualizarCierreCaja(total, metodo);
        
        // Mostrar ticket
        mostrarTicket(venta, items, pagoData, metodo);
        
        // Limpiar carrito
        APP_STATE.carrito = [];
        updateCartDisplay();
        if (discountInput) discountInput.value = '0';
        
        const paymentModal = document.getElementById('paymentModal');
        if (paymentModal) paymentModal.style.display = 'none';
        
        APP_STATE.ventasHoy++;
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        alert(`❌ Error: ${error.message || 'Error al registrar la venta'}`);
    }
}

async function actualizarCierreCaja(total, metodo) {
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        // Buscar cierre actual
        const { data: cierre, error: cierreError } = await APP_STATE.supabase
            .from('cierres_caja')
            .select('*')
            .eq('fecha', hoy)
            .eq('local_id', APP_STATE.currentLocal?.id)
            .eq('caja_id', APP_STATE.currentCaja?.id)
            .eq('turno', APP_STATE.currentTurno)
            .eq('estado', 'abierto')
            .single();
        
        if (cierreError) throw cierreError;
        
        // Actualizar cierre
        const updateData = {
            total_ventas: (cierre.total_ventas || 0) + total,
            updated_at: new Date().toISOString()
        };
        
        // Incrementar el método de pago correspondiente
        switch (metodo) {
            case 'efectivo':
                updateData.ventas_efectivo = (cierre.ventas_efectivo || 0) + total;
                break;
            case 'tarjeta':
                updateData.ventas_tarjeta = (cierre.ventas_tarjeta || 0) + total;
                break;
            case 'transferencia':
                updateData.ventas_transferencia = (cierre.ventas_transferencia || 0) + total;
                break;
            case 'qr':
                updateData.ventas_qr = (cierre.ventas_qr || 0) + total;
                break;
            case 'cuenta':
                updateData.ventas_cuenta_corriente = (cierre.ventas_cuenta_corriente || 0) + total;
                break;
        }
        
        const { error: updateError } = await APP_STATE.supabase
            .from('cierres_caja')
            .update(updateData)
            .eq('id', cierre.id);
        
        if (updateError) throw updateError;
        
    } catch (error) {
        console.error('Error actualizando cierre de caja:', error);
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
            <p>Venta: ${venta.numero_venta}</p>
            <p>Vendedor: ${APP_STATE.currentUser?.nombre || APP_STATE.currentUser?.email}</p>
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
    ventana.close();
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
// CLIENTES Y CUENTA CORRIENTE
// ============================================

async function loadClientes() {
    const container = document.getElementById('clientesList');
    if (!container) return;
    
    container.innerHTML = '<div class="loading">Cargando clientes...</div>';
    
    try {
        const { data: clientes, error } = await APP_STATE.supabase
            .from('clientes')
            .select('*')
            .eq('activo', true)
            .order('nombre')
            .limit(200);
        
        if (error) throw error;
        
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
        const { data: clientes, error } = await APP_STATE.supabase
            .from('clientes')
            .select('*')
            .eq('activo', true)
            .order('nombre')
            .limit(100);
        
        if (error) throw error;
        
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
        const { data, error } = await APP_STATE.supabase
            .from('clientes')
            .insert([clienteData])
            .select()
            .single();
        
        if (error) throw error;
        
        alert('✅ Cliente guardado correctamente');
        
        const modal = document.getElementById('genericModal');
        if (modal) modal.style.display = 'none';
        
        await loadClientes();
        await loadClientesParaVenta();
        
    } catch (error) {
        console.error('Error guardando cliente:', error);
        alert(`❌ Error: ${error.message || 'Error al guardar cliente'}`);
    }
}

// ============================================
// CAJA Y CIERRES
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
        const hoy = new Date().toISOString().split('T')[0];
        
        const { data: cierreActual, error: cierreError } = await APP_STATE.supabase
            .from('cierres_caja')
            .select('*')
            .eq('fecha', hoy)
            .eq('local_id', APP_STATE.currentLocal?.id)
            .eq('caja_id', APP_STATE.currentCaja?.id)
            .eq('turno', APP_STATE.currentTurno)
            .eq('estado', 'abierto')
            .single();
        
        if (cierreError) {
            console.warn('No hay caja abierta:', cierreError.message);
            resetearResumenCaja();
            return;
        }
        
        if (cierreActual) {
            saldoInicialElem.textContent = `$${cierreActual.saldo_inicial.toFixed(2)}`;
            ventasEfectivoElem.textContent = `$${(cierreActual.ventas_efectivo || 0).toFixed(2)}`;
            ventasTarjetaElem.textContent = `$${(cierreActual.ventas_tarjeta || 0).toFixed(2)}`;
            ventasTransferenciaElem.textContent = `$${(cierreActual.ventas_transferencia || 0).toFixed(2)}`;
            ventasQrElem.textContent = `$${(cierreActual.ventas_qr || 0).toFixed(2)}`;
            ventasCuentaElem.textContent = `$${(cierreActual.ventas_cuenta_corriente || 0).toFixed(2)}`;
            totalVentasElem.textContent = `$${(cierreActual.total_ventas || 0).toFixed(2)}`;
            
            const saldoFinal = cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0);
            const diferencia = cierreActual.diferencia || 0;
            
            saldoFinalElem.textContent = `$${saldoFinal.toFixed(2)}`;
            diferenciaElem.textContent = `$${diferencia.toFixed(2)}`;
            
            diferenciaElem.className = diferencia >= 0 ? 'positivo' : 'negativo';
        } else {
            resetearResumenCaja();
        }
        
    } catch (error) {
        console.error('Error cargando resumen de caja:', error);
        resetearResumenCaja();
    }
}

function resetearResumenCaja() {
    const elementos = [
        'saldoInicialResumen', 'ventasEfectivo', 'ventasTarjeta',
        'ventasTransferencia', 'ventasQr', 'ventasCuenta',
        'totalVentas', 'saldoFinal', 'diferenciaResumen'
    ];
    
    elementos.forEach(id => {
        const elem = document.getElementById(id);
        if (elem) elem.textContent = '$0.00';
    });
}

async function cerrarCaja() {
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja || !APP_STATE.currentTurno) {
        alert('Primero debes iniciar una sesión de trabajo');
        return;
    }
    
    if (!confirm('¿Estás seguro de cerrar la caja?')) return;
    
    try {
        const hoy = new Date().toISOString().split('T')[0];
        
        const { data: cierreActual, error: fetchError } = await APP_STATE.supabase
            .from('cierres_caja')
            .select('*')
            .eq('fecha', hoy)
            .eq('local_id', APP_STATE.currentLocal?.id)
            .eq('caja_id', APP_STATE.currentCaja?.id)
            .eq('turno', APP_STATE.currentTurno)
            .eq('estado', 'abierto')
            .single();
        
        if (fetchError) {
            alert('No hay caja abierta para cerrar');
            return;
        }
        
        const saldoFinalInput = prompt('Ingrese el saldo final en caja:', 
                                      (cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0)).toFixed(2));
        if (!saldoFinalInput) return;
        
        const saldoFinal = parseFloat(saldoFinalInput) || 0;
        const diferencia = saldoFinal - (cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0));
        
        const observaciones = prompt('Observaciones del cierre:', 'Cierre normal');
        
        const updateData = {
            saldo_final: saldoFinal,
            diferencia: diferencia,
            estado: 'cerrado',
            observaciones: observaciones,
            updated_at: new Date().toISOString()
        };
        
        const { error: updateError } = await APP_STATE.supabase
            .from('cierres_caja')
            .update(updateData)
            .eq('id', cierreActual.id);
        
        if (updateError) throw updateError;
        
        alert(`✅ Caja cerrada correctamente\n` +
              `Saldo Inicial: $${cierreActual.saldo_inicial.toFixed(2)}\n` +
              `Ventas Efectivo: $${(cierreActual.ventas_efectivo || 0).toFixed(2)}\n` +
              `Saldo Esperado: $${(cierreActual.saldo_inicial + (cierreActual.ventas_efectivo || 0)).toFixed(2)}\n` +
              `Saldo Final: $${saldoFinal.toFixed(2)}\n` +
              `Diferencia: $${diferencia.toFixed(2)}`);
        
        // Limpiar sesión de trabajo
        APP_STATE.currentLocal = null;
        APP_STATE.currentCaja = null;
        APP_STATE.currentTurno = null;
        
        localStorage.removeItem('currentLocal');
        localStorage.removeItem('currentCaja');
        localStorage.removeItem('currentTurno');
        
        showAppScreen();
        
    } catch (error) {
        console.error('Error cerrando caja:', error);
        alert(`❌ Error: ${error.message || 'Error al cerrar caja'}`);
    }
}

// ============================================
// SCANNER Y BÚSQUEDA
// ============================================

async function handleProductSearch(e) {
    if (e.key === 'Enter') {
        const searchTerm = e.target.value.trim();
        if (!searchTerm) return;
        
        try {
            const { data: productos, error } = await APP_STATE.supabase
                .from('productos')
                .select('*')
                .or(`codigo_barras.eq.${searchTerm},codigo_interno.eq.${searchTerm},nombre.ilike.%${searchTerm}%`)
                .eq('activo', true)
                .limit(1);
            
            if (error) throw error;
            
            if (productos && productos.length > 0) {
                await agregarAlCarrito(productos[0].id);
                e.target.value = '';
                e.target.focus();
            } else {
                alert('Producto no encontrado');
            }
        } catch (error) {
            console.error('Error buscando producto:', error);
            alert('Error al buscar producto');
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
        
        // Usar la API BarcodeDetector si está disponible
        if ('BarcodeDetector' in window) {
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
    if (!scannerVideo || !window.BarcodeDetector) return;
    
    const barcodeDetector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'codabar', 'itf', 'qr_code'] });
    
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
// FUNCIONES AUXILIARES
// ============================================

function handleModalConfirm() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

function handleModalCancel() {
    const modal = document.getElementById('genericModal');
    if (modal) modal.style.display = 'none';
}

// ============================================
// REAL-TIME SUBSCRIPTIONS
// ============================================

async function setupRealtimeSubscriptions() {
    if (!APP_STATE.supabase) return;
    
    try {
        // Suscripción a cambios en productos
        const productosChannel = APP_STATE.supabase
            .channel('productos-changes')
            .on('postgres_changes', 
                { event: '*', schema: 'public', table: 'productos' }, 
                (payload) => {
                    console.log('Cambio en productos:', payload);
                    
                    // Recargar productos si estamos en la página de productos o POS
                    if (APP_STATE.currentPage === 'productos') {
                        loadProductos();
                    } else if (APP_STATE.currentPage === 'pos') {
                        loadProductosParaVenta();
                    }
                }
            )
            .subscribe();
        
        // Suscripción a nuevas ventas
        const ventasChannel = APP_STATE.supabase
            .channel('ventas-changes')
            .on('postgres_changes', 
                { event: 'INSERT', schema: 'public', table: 'ventas' }, 
                (payload) => {
                    console.log('Nueva venta registrada:', payload);
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
// FUNCIONES GLOBALES
// ============================================

// Exportar funciones al ámbito global
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
window.toggleScanner = toggleScanner;
window.stopScanner = stopScanner;
window.activateKeyboardMode = activateKeyboardMode;

// Nota: Las funciones de importar/exportar Excel, editar/eliminar productos/clientes,
// verCliente, editarCliente, etc., se pueden agregar según sea necesario.
// Por ahora mantenemos las funciones básicas para simplificar.

console.log('✅ app.js cargado completamente - Versión Online');
