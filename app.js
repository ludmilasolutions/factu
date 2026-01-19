// ============================================
// SISTEMA POS - APP.JS
// ============================================

// Configuración global
const CONFIG = {
    VERSION: '1.0.0',
    DB_NAME: 'pos_offline_db',
    DB_VERSION: 1,
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
    
    if (supabaseUrl && supabaseKey && window.supabase) {
        APP_STATE.supabase = window.supabase.createClient(supabaseUrl, supabaseKey);
        console.log('✅ Supabase configurado');
    }
    
    // Configurar eventos
    setupEventListeners();
    setupNetworkListeners();
    
    // Verificar si hay sesión activa
    const session = localStorage.getItem('pos_session');
    if (session) {
        const sessionData = JSON.parse(session);
        if (sessionData.expires > Date.now()) {
            APP_STATE.currentUser = sessionData.user;
            showAppScreen();
            loadUserSession();
        } else {
            localStorage.removeItem('pos_session');
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

let db;

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
        
        request.onerror = (event) => {
            console.error('❌ Error abriendo IndexedDB:', event.target.error);
            reject(event.target.error);
        };
        
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('✅ IndexedDB inicializada');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            
            // Crear object stores
            if (!db.objectStoreNames.contains('operaciones_pendientes')) {
                const store = db.createObjectStore('operaciones_pendientes', { 
                    keyPath: 'id',
                    autoIncrement: true 
                });
                store.createIndex('type', 'type', { unique: false });
                store.createIndex('status', 'status', { unique: false });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('productos_cache')) {
                const store = db.createObjectStore('productos_cache', { keyPath: 'id' });
                store.createIndex('codigo_barras', 'codigo_barras', { unique: true });
                store.createIndex('updated_at', 'updated_at', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('clientes_cache')) {
                const store = db.createObjectStore('clientes_cache', { keyPath: 'id' });
                store.createIndex('dni', 'dni', { unique: true });
            }
            
            if (!db.objectStoreNames.contains('ventas_offline')) {
                const store = db.createObjectStore('ventas_offline', { 
                    keyPath: 'offline_id' 
                });
                store.createIndex('sync_status', 'sync_status', { unique: false });
                store.createIndex('created_at', 'created_at', { unique: false });
            }
            
            if (!db.objectStoreNames.contains('configuracion')) {
                db.createObjectStore('configuracion', { keyPath: 'key' });
            }
        };
    });
}

// Operaciones IndexedDB
function indexedDBOperation(storeName, operation, data = null) {
    return new Promise((resolve, reject) => {
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
        }
        
        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
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
    
    await indexedDBOperation('operaciones_pendientes', 'add', op);
    APP_STATE.syncQueue.push(op);
    updateSyncStatus();
}

// ============================================
// SISTEMA DE SINCRONIZACIÓN
// ============================================

async function syncOfflineOperations() {
    if (!APP_STATE.isOnline || APP_STATE.isSyncing) return;
    
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
                switch (op.type) {
                    case 'venta':
                        await syncVenta(op.data);
                        break;
                    case 'pago':
                        await syncPago(op.data);
                        break;
                    case 'cliente':
                        await syncCliente(op.data);
                        break;
                    case 'producto':
                        await syncProducto(op.data);
                        break;
                }
                
                op.status = 'synced';
                op.synced_at = new Date().toISOString();
                await indexedDBOperation('operaciones_pendientes', 'put', op);
                
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
    if (!APP_STATE.supabase) throw new Error('Sin conexión a Supabase');
    
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
    
    // Actualizar stock
    for (const item of ventaData.items) {
        await actualizarStockProducto(item.producto_id, -item.cantidad);
    }
    
    // Marcar venta offline como sincronizada
    await indexedDBOperation('ventas_offline', 'delete', ventaData.offline_id);
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
// AUTENTICACIÓN Y SESIÓN
// ============================================

function showLoginScreen() {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('appScreen').style.display = 'none';
}

function showAppScreen() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    
    if (!APP_STATE.currentLocal || !APP_STATE.currentCaja) {
        document.getElementById('initialConfig').style.display = 'block';
        document.getElementById('mainApp').style.display = 'none';
    } else {
        document.getElementById('initialConfig').style.display = 'none';
        document.getElementById('mainApp').style.display = 'block';
    }
}

function setupEventListeners() {
    // Login
    document.getElementById('loginBtn').addEventListener('click', handleLogin);
    document.getElementById('loginOffline').addEventListener('click', handleOfflineLogin);
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
    
    // Configuración inicial
    document.getElementById('startSession').addEventListener('click', startWorkSession);
    
    // Navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const page = e.target.dataset.page;
            switchPage(page);
        });
    });
    
    // POS
    document.getElementById('productSearch').addEventListener('keyup', handleProductSearch);
    document.getElementById('scanBarcode').addEventListener('click', toggleScanner);
    document.getElementById('stopScanner').addEventListener('click', stopScanner);
    document.getElementById('keyboardMode').addEventListener('click', activateKeyboardMode);
    document.getElementById('finalizarVenta').addEventListener('click', finalizarVenta);
    document.getElementById('crearPresupuesto').addEventListener('click', crearPresupuesto);
    document.getElementById('cancelarVenta').addEventListener('click', cancelarVenta);
    document.getElementById('cartDiscount').addEventListener('input', updateCartTotal);
    
    // Modal de pagos
    document.querySelectorAll('.payment-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const method = e.target.dataset.method;
            showPaymentDetails(method);
        });
    });
    
    document.getElementById('confirmPayment').addEventListener('click', confirmarPago);
    document.getElementById('cancelPayment').addEventListener('click', () => {
        document.getElementById('paymentModal').style.display = 'none';
    });
    
    // Productos
    document.getElementById('nuevoProducto').addEventListener('click', showNuevoProductoModal);
    document.getElementById('filterProductos').addEventListener('input', filterProductos);
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

async function handleLogin() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const status = document.getElementById('loginStatus');
    
    if (!email || !password) {
        status.innerHTML = '<p class="error">❌ Completa todos los campos</p>';
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
        status.innerHTML = '<p class="info">🔄 Iniciando sesión...</p>';
        
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
        await loadInitialData();
        
    } catch (error) {
        status.innerHTML = `<p class="error">❌ Error: ${error.message}</p>`;
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

function loadUserSession() {
    const session = JSON.parse(localStorage.getItem('pos_session'));
    if (session && session.user) {
        APP_STATE.currentUser = session.user;
        document.getElementById('userInfo').textContent = `Usuario: ${APP_STATE.currentUser.nombre}`;
    }
    
    const local = localStorage.getItem('currentLocal');
    const caja = localStorage.getItem('currentCaja');
    const turno = localStorage.getItem('currentTurno');
    
    if (local && caja && turno) {
        APP_STATE.currentLocal = JSON.parse(local);
        APP_STATE.currentCaja = JSON.parse(caja);
        APP_STATE.currentTurno = turno;
        
        document.getElementById('localInfo').textContent = `Local: ${APP_STATE.currentLocal.nombre}`;
        document.getElementById('cajaInfo').textContent = `Caja: ${APP_STATE.currentCaja.numero}`;
        document.getElementById('turnoInfo').textContent = `Turno: ${APP_STATE.currentTurno}`;
        
        showAppScreen();
    }
}

async function startWorkSession() {
    const localSelect = document.getElementById('selectLocal');
    const cajaSelect = document.getElementById('selectCaja');
    const turnoSelect = document.getElementById('selectTurno');
    const saldoInicial = document.getElementById('saldoInicial').value;
    
    if (!localSelect.value || !cajaSelect.value || !turnoSelect.value) {
        alert('Completa todos los campos requeridos');
        return;
    }
    
    // En una implementación real, aquí cargarías los objetos completos
    APP_STATE.currentLocal = { id: localSelect.value, nombre: localSelect.options[localSelect.selectedIndex].text };
    APP_STATE.currentCaja = { id: cajaSelect.value, numero: cajaSelect.options[cajaSelect.selectedIndex].text };
    APP_STATE.currentTurno = turnoSelect.value;
    
    // Guardar en localStorage
    localStorage.setItem('currentLocal', JSON.stringify(APP_STATE.currentLocal));
    localStorage.setItem('currentCaja', JSON.stringify(APP_STATE.currentCaja));
    localStorage.setItem('currentTurno', APP_STATE.currentTurno);
    
    // Actualizar UI
    document.getElementById('localInfo').textContent = `Local: ${APP_STATE.currentLocal.nombre}`;
    document.getElementById('cajaInfo').textContent = `Caja: ${APP_STATE.currentCaja.numero}`;
    document.getElementById('turnoInfo').textContent = `Turno: ${APP_STATE.currentTurno}`;
    
    // Crear cierre de caja inicial
    if (APP_STATE.supabase && saldoInicial) {
        try {
            const { error } = await APP_STATE.supabase
                .from('cierres_caja')
                .insert([{
                    local_id: APP_STATE.currentLocal.id,
                    caja_id: APP_STATE.currentCaja.id,
                    usuario_id: APP_STATE.currentUser.id,
                    turno: APP_STATE.currentTurno,
                    fecha: new Date().toISOString().split('T')[0],
                    saldo_inicial: parseFloat(saldoInicial),
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
                    usuario_id: APP_STATE.currentUser.id,
                    turno: APP_STATE.currentTurno,
                    fecha: new Date().toISOString().split('T')[0],
                    saldo_inicial: parseFloat(saldoInicial),
                    estado: 'abierto'
                }
            });
        }
    }
    
    // Mostrar aplicación principal
    document.getElementById('initialConfig').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    
    // Cargar datos necesarios
    await loadProductos();
}

// ============================================
// GESTIÓN DE PRODUCTOS
// ============================================

async function loadProductos() {
    try {
        let productos = [];
        
        // Intentar cargar desde caché local primero
        productos = await indexedDBOperation('productos_cache', 'getAll');
        
        // Si no hay en caché y hay conexión, cargar desde Supabase
        if ((!productos || productos.length === 0) && APP_STATE.supabase && APP_STATE.isOnline) {
            const { data, error } = await APP_STATE.supabase
                .from('productos')
                .select('*')
                .eq('activo', true)
                .order('nombre');
            
            if (error) throw error;
            
            productos = data;
            
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
        
        const card = document.createElement('div');
        card.className = 'producto-card';
        card.innerHTML = `
            <div class="producto-header">
                <h4>${producto.nombre}</h4>
                <span class="producto-codigo">${producto.codigo_barras || 'Sin código'}</span>
            </div>
            <p class="producto-descripcion">${producto.descripcion || ''}</p>
            <div class="producto-info">
                <span class="producto-stock ${stockClass}">Stock: ${producto.stock}</span>
                <span class="producto-precio">$${producto.precio_venta.toFixed(2)}</span>
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

function filterProductos() {
    const searchTerm = document.getElementById('filterProductos').value.toLowerCase();
    const productos = Array.from(document.querySelectorAll('.producto-card'));
    
    productos.forEach(card => {
        const nombre = card.querySelector('h4').textContent.toLowerCase();
        const codigo = card.querySelector('.producto-codigo').textContent.toLowerCase();
        
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
        const productos = await indexedDBOperation('productos_cache', 'getAll');
        producto = productos.find(p => 
            p.codigo_barras === searchTerm || 
            p.nombre.toLowerCase().includes(searchTerm.toLowerCase())
        );
        
        // Si no se encuentra y hay conexión, buscar en Supabase
        if (!producto && APP_STATE.supabase && APP_STATE.isOnline) {
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

function agregarAlCarrito(productoId) {
    // En una implementación real, buscarías el producto completo
    // Por simplicidad, aquí agregamos un producto dummy
    const producto = {
        id: productoId,
        nombre: `Producto ${Math.floor(Math.random() * 1000)}`,
        precio: 100 + Math.floor(Math.random() * 900),
        cantidad: 1
    };
    
    // Verificar si ya está en el carrito
    const existingItem = APP_STATE.carrito.find(item => item.id === productoId);
    
    if (existingItem) {
        existingItem.cantidad += 1;
        existingItem.subtotal = existingItem.cantidad * existingItem.precio;
    } else {
        APP_STATE.carrito.push({
            ...producto,
            subtotal: producto.precio
        });
    }
    
    updateCartDisplay();
}

function updateCartDisplay() {
    const container = document.getElementById('cartItems');
    const subtotalElem = document.getElementById('cartSubtotal');
    const totalElem = document.getElementById('cartTotal');
    
    container.innerHTML = '';
    
    let subtotal = 0;
    
    APP_STATE.carrito.forEach((item, index) => {
        subtotal += item.subtotal;
        
        const itemElem = document.createElement('div');
        itemElem.className = 'cart-item';
        itemElem.innerHTML = `
            <span>${item.nombre}</span>
            <span>
                <button onclick="updateCantidad(${index}, -1)">-</button>
                ${item.cantidad}
                <button onclick="updateCantidad(${index}, 1)">+</button>
            </span>
            <span>$${item.precio.toFixed(2)}</span>
            <span>$${item.subtotal.toFixed(2)}</span>
            <span>
                <button onclick="removeFromCart(${index})" class="btn btn-danger btn-sm">🗑️</button>
                <button onclick="changePrice(${index})" class="btn btn-warning btn-sm">💰</button>
            </span>
        `;
        
        container.appendChild(itemElem);
    });
    
    subtotalElem.textContent = `$${subtotal.toFixed(2)}`;
    updateCartTotal();
}

function updateCantidad(index, delta) {
    const item = APP_STATE.carrito[index];
    const nuevaCantidad = item.cantidad + delta;
    
    if (nuevaCantidad < 1) {
        removeFromCart(index);
        return;
    }
    
    item.cantidad = nuevaCantidad;
    item.subtotal = item.cantidad * item.precio;
    updateCartDisplay();
}

function removeFromCart(index) {
    APP_STATE.carrito.splice(index, 1);
    updateCartDisplay();
}

function changePrice(index) {
    const item = APP_STATE.carrito[index];
    const nuevoPrecio = prompt('Nuevo precio:', item.precio.toFixed(2));
    
    if (nuevoPrecio && !isNaN(nuevoPrecio)) {
        item.precio = parseFloat(nuevoPrecio);
        item.subtotal = item.cantidad * item.precio;
        updateCartDisplay();
    }
}

function updateCartTotal() {
    const subtotal = APP_STATE.carrito.reduce((sum, item) => sum + item.subtotal, 0);
    const discount = parseFloat(document.getElementById('cartDiscount').value) || 0;
    const total = subtotal - discount;
    
    document.getElementById('cartTotal').textContent = `$${total.toFixed(2)}`;
}

function cancelarVenta() {
    if (confirm('¿Cancelar la venta actual? Se perderán todos los items del carrito.')) {
        APP_STATE.carrito = [];
        updateCartDisplay();
        document.getElementById('cartDiscount').value = '';
    }
}

// ============================================
// FINALIZAR VENTA
// ============================================

async function finalizarVenta() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
        return;
    }
    
    // Mostrar modal de métodos de pago
    document.getElementById('paymentModal').style.display = 'flex';
}

function showPaymentDetails(method) {
    const container = document.getElementById('paymentDetails');
    const total = parseFloat(document.getElementById('cartTotal').textContent.replace('$', ''));
    
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
                <div class="form-group">
                    <label>Cuotas:</label>
                    <select id="cuotas">
                        <option value="1">1 cuota</option>
                        <option value="3">3 cuotas</option>
                        <option value="6">6 cuotas</option>
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
                    <input type="text" id="banco" placeholder="Nombre del banco">
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
                        <!-- Clientes se cargarían dinámicamente -->
                    </select>
                </div>
                <div class="form-group">
                    <label>Observaciones:</label>
                    <textarea id="observacionesCuenta" placeholder="Observaciones del pago..."></textarea>
                </div>
            `;
            break;
    }
    
    container.innerHTML = html;
    
    // Actualizar vuelto en tiempo real para efectivo
    if (method === 'efectivo') {
        const montoInput = document.getElementById('montoRecibido');
        const vueltoInput = document.getElementById('vuelto');
        
        montoInput.addEventListener('input', () => {
            const monto = parseFloat(montoInput.value) || 0;
            const vuelto = monto - total;
            vueltoInput.value = vuelto > 0 ? vuelto.toFixed(2) : '0.00';
        });
    }
}

function simularPagoQR() {
    alert('✅ Pago con QR simulado correctamente');
    confirmarPago();
}

async function confirmarPago() {
    const total = parseFloat(document.getElementById('cartTotal').textContent.replace('$', ''));
    const metodo = document.querySelector('.payment-btn.active')?.dataset.method || 'efectivo';
    
    // Crear venta
    const venta = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        caja_id: APP_STATE.currentCaja?.id || 'offline',
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        cliente_id: document.getElementById('selectCliente').value || null,
        total: total,
        descuento: parseFloat(document.getElementById('cartDiscount').value) || 0,
        estado: 'completada',
        tipo_venta: metodo === 'cuenta' ? 'cuenta_corriente' : 'contado',
        offline_id: 'venta_' + Date.now() + Math.random(),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending'
    };
    
    // Crear items de venta
    const items = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        cantidad: item.cantidad,
        precio_unitario: item.precio,
        subtotal: item.subtotal,
        descuento: 0
    }));
    
    // Crear pago
    const pago = {
        metodo: metodo,
        monto: total,
        referencia: generarReferenciaPago(metodo),
        estado: 'completado',
        offline_id: 'pago_' + Date.now() + Math.random(),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending'
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
            
            // Actualizar stock
            for (const item of items) {
                await actualizarStockProducto(item.producto_id, -item.cantidad);
            }
            
        } else {
            // Offline: Guardar en IndexedDB
            await indexedDBOperation('ventas_offline', 'add', {
                ...venta,
                items: items,
                pago: pago
            });
            
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
        document.getElementById('cartDiscount').value = '';
        document.getElementById('paymentModal').style.display = 'none';
        
        alert('✅ Venta registrada correctamente');
        
    } catch (error) {
        console.error('Error registrando venta:', error);
        alert(`❌ Error: ${error.message}`);
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
    const ticketContent = `
        <div class="ticket">
            <h3>${APP_STATE.currentLocal?.nombre || 'LOCAL'}</h3>
            <p>${APP_STATE.currentLocal?.direccion || ''}</p>
            <p>Tel: ${APP_STATE.currentLocal?.telefono || ''}</p>
            <hr>
            <p>Fecha: ${new Date().toLocaleString()}</p>
            <p>Venta: ${venta.offline_id || 'N/A'}</p>
            <p>Vendedor: ${APP_STATE.currentUser?.nombre || 'Offline'}</p>
            <hr>
            <h4>PRODUCTOS:</h4>
            ${items.map(item => `
                <p>${item.cantidad} x $${item.precio_unitario.toFixed(2)} = $${item.subtotal.toFixed(2)}</p>
            `).join('')}
            <hr>
            <p>SUBTOTAL: $${venta.total.toFixed(2)}</p>
            <p>DESCUENTO: $${venta.descuento.toFixed(2)}</p>
            <p>TOTAL: $${venta.total.toFixed(2)}</p>
            <hr>
            <p>MÉTODO: ${pago.metodo.toUpperCase()}</p>
            <p>REF: ${pago.referencia}</p>
            <hr>
            <p>¡Gracias por su compra!</p>
        </div>
    `;
    
    // Mostrar modal con ticket
    const modal = document.getElementById('genericModal');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    
    modalTitle.textContent = 'Ticket de Venta';
    modalBody.innerHTML = ticketContent;
    
    modal.style.display = 'flex';
    
    // Configurar botones del modal
    document.getElementById('modalConfirm').textContent = 'Imprimir';
    document.getElementById('modalCancel').textContent = 'Cerrar';
    
    document.getElementById('modalConfirm').onclick = () => {
        window.print();
    };
    
    document.getElementById('modalCancel').onclick = () => {
        modal.style.display = 'none';
    };
}

// ============================================
// PRESUPUESTOS
// ============================================

async function crearPresupuesto() {
    if (APP_STATE.carrito.length === 0) {
        alert('El carrito está vacío');
        return;
    }
    
    const clienteId = document.getElementById('selectCliente').value;
    const validoHasta = prompt('Válido hasta (dd/mm/aaaa):', 
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString('es-AR'));
    
    if (!validoHasta) return;
    
    const presupuesto = {
        local_id: APP_STATE.currentLocal?.id || 'offline',
        cliente_id: clienteId,
        usuario_id: APP_STATE.currentUser?.id || 'offline',
        total: parseFloat(document.getElementById('cartTotal').textContent.replace('$', '')),
        valido_hasta: validoHasta,
        estado: 'pendiente',
        offline_id: 'presupuesto_' + Date.now() + Math.random(),
        sync_status: APP_STATE.isOnline ? 'synced' : 'pending'
    };
    
    const items = APP_STATE.carrito.map(item => ({
        producto_id: item.id,
        cantidad: item.cantidad,
        precio_unitario: item.precio,
        subtotal: item.subtotal
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
        document.getElementById('cartDiscount').value = '';
        
    } catch (error) {
        console.error('Error creando presupuesto:', error);
        alert(`❌ Error: ${error.message}`);
    }
}

// ============================================
// SCANNER DE CÓDIGO DE BARRAS
// ============================================

let scannerStream = null;

async function toggleScanner() {
    const scannerContainer = document.getElementById('scannerContainer');
    const scannerVideo = document.getElementById('scannerVideo');
    
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
        
        // Aquí integrarías una librería como quagga.js o zxing
        // Para simplificar, simulamos la detección
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
    
    document.getElementById('scannerContainer').style.display = 'none';
    APP_STATE.scannerActive = false;
    APP_STATE.scannerCode = null;
}

function simulateBarcodeDetection() {
    // En una implementación real, usarías una librería de scanning
    // Esta es una simulación para demostración
    console.log('Simulando detección de código de barras...');
    
    // Después de 3 segundos, simular detección
    setTimeout(() => {
        if (APP_STATE.scannerActive) {
            const fakeBarcode = '779123456789' + Math.floor(Math.random() * 10);
            document.getElementById('productSearch').value = fakeBarcode;
            handleProductSearch({ key: 'Enter' });
            stopScanner();
        }
    }, 3000);
}

function activateKeyboardMode() {
    document.getElementById('productSearch').focus();
    document.getElementById('productSearch').value = '';
}

// ============================================
// UTILIDADES
// ============================================

function switchPage(pageName) {
    // Actualizar navegación
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.page === pageName);
    });
    
    // Actualizar páginas
    document.querySelectorAll('.page').forEach(page => {
        page.classList.toggle('active', page.id === `page${pageName.charAt(0).toUpperCase() + pageName.slice(1)}`);
    });
    
    // Actualizar título
    document.getElementById('currentPage').textContent = pageName.charAt(0).toUpperCase() + pageName.slice(1);
    
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

function updateSyncStatus() {
    const statusBtn = document.getElementById('syncStatus');
    
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

function loadAppState() {
    const savedState = localStorage.getItem('app_state');
    if (savedState) {
        const state = JSON.parse(savedState);
        Object.assign(APP_STATE, state);
    }
}

function saveAppState() {
    localStorage.setItem('app_state', JSON.stringify(APP_STATE));
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
    setupRealtimeSubscriptions();
}

async function setupRealtimeSubscriptions() {
    if (!APP_STATE.supabase) return;
    
    // Suscribirse a cambios en productos
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
    
    // Suscribirse a cambios en ventas
    const ventasChannel = APP_STATE.supabase
        .channel('ventas-changes')
        .on('postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'ventas' },
            (payload) => {
                console.log('Nueva venta:', payload);
                // Actualizar resumen de caja si está abierto
                if (APP_STATE.currentPage === 'caja') {
                    loadCajaResumen();
                }
            }
        )
        .subscribe();
}

console.log('✅ app.js cargado completamente');
