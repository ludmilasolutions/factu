/**
 * Sistema POS CommerceFire - Aplicación Principal
 * Arquitectura: Firebase Compat + IndexedDB + Offline-First
 */

// Importar módulos
import { loginUser, logoutUser, getCurrentUser, auth, db } from './js/auth.js';

// Variables globales de la aplicación
let currentUser = null;
let currentLocal = null;
let currentTurn = null;
let isOnline = navigator.onLine;
let pendingOperations = [];
let cart = [];
let ui = null;

// Configuración de Firebase
const firebaseConfig = {
    apiKey: "AIzaSyCtOiUy2tUQeixUiJxTdI_ESULY4WpqXzw",
    authDomain: "whatsappau-30dc1.firebaseapp.com",
    projectId: "whatsappau-30dc1",
    storageBucket: "whatsappau-30dc1.firebasestorage.app",
    messagingSenderId: "456068013185",
    appId: "1:456068013185:web:5bdd49337fb622e56f0180"
};

// Sistema de Logging
const logger = {
    log: (message, ...args) => console.log(`📝 ${message}`, ...args),
    info: (message, ...args) => console.info(`ℹ️ ${message}`, ...args),
    warn: (message, ...args) => console.warn(`⚠️ ${message}`, ...args),
    error: (message, ...args) => console.error(`❌ ${message}`, ...args),
    success: (message, ...args) => console.log(`✅ ${message}`, ...args)
};

/**
 * Clase UI - Gestión de interfaz de usuario
 */
class UI {
    constructor() {
        this.isSidebarOpen = true;
        this.currentSection = 'pos';
    }
    
    init() {
        logger.info('Inicializando UI...');
        
        // Configurar listeners
        this.setupEventListeners();
        
        // Configurar estado inicial
        this.updateConnectionStatus();
        this.setupConnectionListeners();
        
        // Cargar sección inicial
        this.loadSection('pos');
        
        logger.success('UI inicializada');
    }
    
    setupEventListeners() {
        // Login
        document.getElementById('login-btn')?.addEventListener('click', () => this.handleLogin());
        document.getElementById('password')?.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleLogin();
        });
        
        // Navegación
        document.getElementById('menu-toggle')?.addEventListener('click', () => this.toggleSidebar());
        document.getElementById('logout-btn')?.addEventListener('click', () => this.handleLogout());
        document.getElementById('cart-btn')?.addEventListener('click', () => this.showCart());
        document.getElementById('cashbox-btn')?.addEventListener('click', () => this.loadSection('cashbox'));
        document.getElementById('toggle-cart')?.addEventListener('click', () => this.showCart());
        
        // Navegación del sidebar
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = e.target.dataset.section || e.target.closest('a').dataset.section;
                this.loadSection(section);
            });
        });
        
        // Cargar locales al iniciar
        this.loadLocals();
        
        logger.info('Listeners de UI configurados');
    }
    
    setupConnectionListeners() {
        window.addEventListener('online', () => {
            isOnline = true;
            this.updateConnectionStatus();
            this.syncPendingOperations();
        });
        
        window.addEventListener('offline', () => {
            isOnline = false;
            this.updateConnectionStatus();
        });
    }
    
    updateConnectionStatus() {
        const statusElement = document.getElementById('connection-status');
        const appStatusElement = document.getElementById('app-connection-status');
        
        if (isOnline) {
            statusElement?.classList.remove('status-offline');
            statusElement?.classList.add('status-online');
            statusElement && (statusElement.textContent = '● Conectado');
            
            appStatusElement?.classList.remove('status-offline');
            appStatusElement?.classList.add('status-online');
            appStatusElement && (appStatusElement.textContent = 'ONLINE');
        } else {
            statusElement?.classList.remove('status-online');
            statusElement?.classList.add('status-offline');
            statusElement && (statusElement.textContent = '● Sin conexión');
            
            appStatusElement?.classList.remove('status-online');
            appStatusElement?.classList.add('status-offline');
            appStatusElement && (appStatusElement.textContent = 'OFFLINE');
        }
    }
    
    async loadLocals() {
        try {
            const localsSelect = document.getElementById('local-select');
            if (!localsSelect) return;
            
            // Intentar obtener locales desde Firestore
            const localsSnapshot = await db.collection('locals').get();
            
            localsSelect.innerHTML = '<option value="">Seleccionar local...</option>';
            
            localsSnapshot.forEach(doc => {
                const local = doc.data();
                const option = document.createElement('option');
                option.value = doc.id;
                option.textContent = local.name || `Local ${doc.id}`;
                localsSelect.appendChild(option);
            });
            
            // Si no hay conexión o no hay locales, usar opciones por defecto
            if (localsSnapshot.empty) {
                const defaultLocals = [
                    { id: 'local1', name: 'Local Central' },
                    { id: 'local2', name: 'Sucursal Norte' },
                    { id: 'local3', name: 'Sucursal Sur' }
                ];
                
                defaultLocals.forEach(local => {
                    const option = document.createElement('option');
                    option.value = local.id;
                    option.textContent = local.name;
                    localsSelect.appendChild(option);
                });
            }
            
        } catch (error) {
            logger.error('Error cargando locales:', error);
            
            // Crear opciones por defecto
            const localsSelect = document.getElementById('local-select');
            if (localsSelect) {
                localsSelect.innerHTML = `
                    <option value="">Seleccionar local...</option>
                    <option value="local1">Local Central</option>
                    <option value="local2">Sucursal Norte</option>
                    <option value="local3">Sucursal Sur</option>
                `;
            }
        }
    }
    
    async handleLogin() {
        try {
            const email = document.getElementById('email').value.trim();
            const password = document.getElementById('password').value.trim();
            const localId = document.getElementById('local-select').value;
            const turno = document.getElementById('turno-select').value;
            
            // Validaciones
            if (!email || !password) {
                this.showError('Por favor, completa todos los campos');
                return;
            }
            
            if (!localId) {
                this.showError('Por favor, selecciona un local');
                return;
            }
            
            // Mostrar loading
            const loginBtn = document.getElementById('login-btn');
            const btnText = loginBtn.querySelector('.btn-text');
            const btnSpinner = loginBtn.querySelector('.btn-spinner');
            
            btnText.style.display = 'none';
            btnSpinner.style.display = 'inline';
            loginBtn.disabled = true;
            
            // Limpiar errores previos
            this.hideError();
            
            logger.info(`Intentando login: ${email}, local: ${localId}, turno: ${turno}`);
            
            // Intentar login
            const userData = await loginUser(email, password, localId, turno);
            
            if (userData) {
                currentUser = userData;
                currentLocal = localId;
                currentTurn = turno;
                
                logger.success(`Login exitoso: ${userData.name || userData.email}`);
                
                // Guardar en localStorage para persistencia
                localStorage.setItem('lastLogin', JSON.stringify({
                    email,
                    localId,
                    turno,
                    timestamp: Date.now()
                }));
                
                // Mostrar aplicación principal
                this.showApp();
                
                // Actualizar UI con datos del usuario
                this.updateUserInfo(userData);
                
                // Cargar datos iniciales
                this.loadInitialData();
            }
            
        } catch (error) {
            logger.error('Error en login:', error);
            this.showError(error.message || 'Error al iniciar sesión');
        } finally {
            // Restaurar botón
            const loginBtn = document.getElementById('login-btn');
            if (loginBtn) {
                const btnText = loginBtn.querySelector('.btn-text');
                const btnSpinner = loginBtn.querySelector('.btn-spinner');
                
                btnText.style.display = 'inline';
                btnSpinner.style.display = 'none';
                loginBtn.disabled = false;
            }
        }
    }
    
    async handleLogout() {
        try {
            if (confirm('¿Estás seguro de que quieres salir?')) {
                await logoutUser();
                
                // Limpiar estado
                currentUser = null;
                currentLocal = null;
                currentTurn = null;
                cart = [];
                
                // Limpiar localStorage
                localStorage.removeItem('lastLogin');
                
                // Mostrar pantalla de login
                this.showLogin();
                
                logger.success('Sesión cerrada correctamente');
            }
        } catch (error) {
            logger.error('Error al cerrar sesión:', error);
            this.showError('Error al cerrar sesión');
        }
    }
    
    showLogin() {
        document.getElementById('login-screen').classList.add('active');
        document.getElementById('app-screen').classList.remove('active');
    }
    
    showApp() {
        document.getElementById('login-screen').classList.remove('active');
        document.getElementById('app-screen').classList.add('active');
    }
    
    updateUserInfo(userData) {
        // Actualizar barra superior
        const userElement = document.getElementById('current-user');
        const localElement = document.getElementById('current-local');
        const turnElement = document.getElementById('current-turn');
        
        if (userElement) userElement.textContent = userData.name || userData.email;
        if (localElement) {
            // Obtener nombre del local desde el select
            const select = document.getElementById('local-select');
            const selectedOption = select?.options[select.selectedIndex];
            localElement.textContent = selectedOption?.textContent || currentLocal;
        }
        if (turnElement) turnElement.textContent = currentTurn;
        
        // Actualizar indicador local
        const localIndicator = document.getElementById('local-indicator');
        if (localIndicator) {
            localIndicator.textContent = `Local: ${currentLocal}`;
        }
    }
    
    async loadInitialData() {
        try {
            logger.info('Cargando datos iniciales...');
            
            // Cargar estadísticas
            await this.loadStats();
            
            // Sincronizar operaciones pendientes
            await this.syncPendingOperations();
            
            logger.success('Datos iniciales cargados');
        } catch (error) {
            logger.error('Error cargando datos iniciales:', error);
        }
    }
    
    async loadStats() {
        try {
            // Productos
            const productsSnapshot = await db.collection('products').get();
            document.getElementById('stat-products').textContent = productsSnapshot.size;
            
            // Ventas de hoy
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            
            const salesQuery = db.collection('sales')
                .where('createdAt', '>=', today)
                .where('localId', '==', currentLocal);
                
            const salesSnapshot = await salesQuery.get();
            document.getElementById('stat-sales-today').textContent = salesSnapshot.size;
            
            // Actualizar contador de pendientes
            const pendingCount = pendingOperations.length;
            document.getElementById('stat-pending').textContent = pendingCount;
            
            const pendingSync = document.getElementById('pending-sync');
            if (pendingCount > 0) {
                pendingSync.style.display = 'inline';
                pendingSync.textContent = `🔄 ${pendingCount} pendientes`;
            } else {
                pendingSync.style.display = 'none';
            }
            
        } catch (error) {
            logger.error('Error cargando estadísticas:', error);
        }
    }
    
    async syncPendingOperations() {
        if (!isOnline || pendingOperations.length === 0) return;
        
        logger.info(`Sincronizando ${pendingOperations.length} operaciones pendientes...`);
        
        const successOps = [];
        const failedOps = [];
        
        for (const op of pendingOperations) {
            try {
                // Ejecutar operación según tipo
                switch (op.type) {
                    case 'sale':
                        await db.collection('sales').add(op.data);
                        break;
                    case 'product_update':
                        await db.collection('products').doc(op.id).update(op.data);
                        break;
                    // Agregar más tipos según necesidad
                }
                
                successOps.push(op);
            } catch (error) {
                logger.error(`Error sincronizando operación ${op.type}:`, error);
                failedOps.push({ ...op, error: error.message });
            }
        }
        
        // Actualizar lista de pendientes
        pendingOperations = failedOps;
        
        // Actualizar UI
        this.loadStats();
        
        if (successOps.length > 0) {
            logger.success(`${successOps.length} operaciones sincronizadas exitosamente`);
        }
        
        if (failedOps.length > 0) {
            logger.warn(`${failedOps.length} operaciones fallaron y se mantienen pendientes`);
        }
    }
    
    loadSection(section) {
        if (!section) return;
        
        logger.info(`Cargando sección: ${section}`);
        
        // Actualizar navegación activa
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.remove('active');
        });
        
        document.querySelector(`[data-section="${section}"]`)?.classList.add('active');
        
        // Cargar contenido de la sección
        const contentElement = document.getElementById('main-content');
        
        switch (section) {
            case 'pos':
                contentElement.innerHTML = this.getPOSContent();
                this.setupPOSListeners();
                break;
                
            case 'products':
                contentElement.innerHTML = this.getProductsContent();
                this.loadProducts();
                break;
                
            case 'clients':
                contentElement.innerHTML = this.getClientsContent();
                this.loadClients();
                break;
                
            case 'sales':
                contentElement.innerHTML = this.getSalesContent();
                this.loadSales();
                break;
                
            case 'cashbox':
                contentElement.innerHTML = this.getCashboxContent();
                this.loadCashbox();
                break;
                
            case 'reports':
                contentElement.innerHTML = this.getReportsContent();
                this.loadReports();
                break;
                
            case 'budgets':
                contentElement.innerHTML = this.getBudgetsContent();
                this.loadBudgets();
                break;
                
            case 'providers':
                contentElement.innerHTML = this.getProvidersContent();
                this.loadProviders();
                break;
                
            default:
                contentElement.innerHTML = `
                    <div class="section-header">
                        <h2>${section.charAt(0).toUpperCase() + section.slice(1)}</h2>
                    </div>
                    <div class="section-content">
                        <p>Esta sección está en desarrollo.</p>
                    </div>
                `;
        }
        
        this.currentSection = section;
    }
    
    getPOSContent() {
        return `
            <div class="pos-container">
                <div class="pos-header">
                    <h2>🏪 Punto de Venta</h2>
                    <div class="pos-actions">
                        <button id="clear-cart" class="btn-secondary">🗑️ Limpiar</button>
                        <button id="quick-sale" class="btn-success">💰 Venta Rápida</button>
                    </div>
                </div>
                
                <div class="pos-grid">
                    <!-- Panel de productos -->
                    <div class="pos-products-panel">
                        <div class="search-bar">
                            <input type="text" id="product-search" placeholder="🔍 Buscar producto por código o nombre...">
                            <button id="scan-barcode" class="icon-btn">📷</button>
                        </div>
                        
                        <div class="categories">
                            <button class="category-btn active" data-category="all">Todos</button>
                            <button class="category-btn" data-category="herramientas">Herramientas</button>
                            <button class="category-btn" data-category="electricidad">Electricidad</button>
                            <button class="category-btn" data-category="fontaneria">Fontanería</button>
                            <button class="category-btn" data-category="pintura">Pintura</button>
                        </div>
                        
                        <div id="products-grid" class="products-grid">
                            <!-- Productos cargados dinámicamente -->
                            <div class="loading-products">Cargando productos...</div>
                        </div>
                    </div>
                    
                    <!-- Panel del carrito -->
                    <div class="pos-cart-panel">
                        <div class="cart-header">
                            <h3>🛒 Carrito de Venta</h3>
                            <span id="cart-items-count">0 items</span>
                        </div>
                        
                        <div class="cart-items" id="cart-items-list">
                            <div class="empty-cart">
                                <p>El carrito está vacío</p>
                                <p class="small">Agrega productos desde el panel izquierdo</p>
                            </div>
                        </div>
                        
                        <div class="cart-summary">
                            <div class="summary-row">
                                <span>Subtotal:</span>
                                <span id="cart-subtotal">$0.00</span>
                            </div>
                            <div class="summary-row">
                                <span>IVA (21%):</span>
                                <span id="cart-tax">$0.00</span>
                            </div>
                            <div class="summary-row total">
                                <span>Total:</span>
                                <span id="cart-total-amount">$0.00</span>
                            </div>
                        </div>
                        
                        <div class="cart-actions">
                            <div class="payment-methods">
                                <label class="payment-option">
                                    <input type="radio" name="payment" value="cash" checked>
                                    💵 Efectivo
                                </label>
                                <label class="payment-option">
                                    <input type="radio" name="payment" value="card">
                                    💳 Tarjeta
                                </label>
                                <label class="payment-option">
                                    <input type="radio" name="payment" value="transfer">
                                    📤 Transferencia
                                </label>
                            </div>
                            
                            <button id="process-sale" class="btn-primary btn-large">
                                🧾 Procesar Venta
                            </button>
                            
                            <div class="client-info">
                                <input type="text" id="client-search" placeholder="👤 Cliente (opcional)">
                                <button id="add-client" class="btn-secondary">+</button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }
    
    getProductsContent() {
        return `
            <div class="section-header">
                <h2>📦 Gestión de Productos</h2>
                <div class="header-actions">
                    <button id="add-product" class="btn-primary">➕ Nuevo Producto</button>
                    <button id="import-products" class="btn-secondary">📥 Importar</button>
                    <button id="export-products" class="btn-secondary">📤 Exportar</button>
                </div>
            </div>
            
            <div class="section-content">
                <div class="filters-bar">
                    <input type="text" id="filter-products" placeholder="🔍 Buscar productos...">
                    <select id="filter-category">
                        <option value="">Todas las categorías</option>
                        <option value="herramientas">Herramientas</option>
                        <option value="electricidad">Electricidad</option>
                        <option value="fontaneria">Fontanería</option>
                        <option value="pintura">Pintura</option>
                    </select>
                    <select id="filter-stock">
                        <option value="">Todo el stock</option>
                        <option value="low">Stock bajo</option>
                        <option value="out">Sin stock</option>
                    </select>
                </div>
                
                <div class="table-container">
                    <table id="products-table">
                        <thead>
                            <tr>
                                <th>Código</th>
                                <th>Nombre</th>
                                <th>Categoría</th>
                                <th>Precio</th>
                                <th>Stock</th>
                                <th>Estado</th>
                                <th>Acciones</th>
                            </tr>
                        </thead>
                        <tbody id="products-table-body">
                            <!-- Datos cargados dinámicamente -->
                        </tbody>
                    </table>
                </div>
                
                <div class="table-footer">
                    <div class="table-info">
                        Mostrando <span id="products-count">0</span> productos
                    </div>
                    <div class="pagination">
                        <button id="prev-page" disabled>◀</button>
                        <span>Página <span id="current-page">1</span></span>
                        <button id="next-page" disabled>▶</button>
                    </div>
                </div>
            </div>
        `;
    }
    
    setupPOSListeners() {
        // Buscar productos
        document.getElementById('product-search')?.addEventListener('input', (e) => {
            this.filterProducts(e.target.value);
        });
        
        // Categorías
        document.querySelectorAll('.category-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                this.filterByCategory(e.target.dataset.category);
            });
        });
        
        // Procesar venta
        document.getElementById('process-sale')?.addEventListener('click', () => {
            this.processSale();
        });
        
        // Limpiar carrito
        document.getElementById('clear-cart')?.addEventListener('click', () => {
            this.clearCart();
        });
    }
    
    async loadProducts() {
        try {
            const productsSnapshot = await db.collection('products').get();
            const tbody = document.getElementById('products-table-body');
            
            if (!tbody) return;
            
            tbody.innerHTML = '';
            
            productsSnapshot.forEach(doc => {
                const product = doc.data();
                const row = document.createElement('tr');
                
                row.innerHTML = `
                    <td>${product.code || 'N/A'}</td>
                    <td>${product.name || 'Sin nombre'}</td>
                    <td><span class="badge category-${product.category || 'other'}">${product.category || 'General'}</span></td>
                    <td>${Utils?.formatCurrency?.(product.price) || `$${product.price || '0.00'}`}</td>
                    <td>
                        <span class="stock-badge ${product.stock <= 5 ? 'low' : product.stock <= 0 ? 'out' : 'ok'}">
                            ${product.stock || 0}
                        </span>
                    </td>
                    <td>
                        <span class="status-badge ${product.active ? 'active' : 'inactive'}">
                            ${product.active ? 'Activo' : 'Inactivo'}
                        </span>
                    </td>
                    <td>
                        <button class="btn-icon" onclick="app.ui.editProduct('${doc.id}')">✏️</button>
                        <button class="btn-icon" onclick="app.ui.deleteProduct('${doc.id}')">🗑️</button>
                    </td>
                `;
                
                tbody.appendChild(row);
            });
            
            // Actualizar contador
            document.getElementById('products-count').textContent = productsSnapshot.size;
            
        } catch (error) {
            logger.error('Error cargando productos:', error);
            
            // Mostrar mensaje de error
            const tbody = document.getElementById('products-table-body');
            if (tbody) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="error-message">
                            ❌ Error cargando productos: ${error.message}
                        </td>
                    </tr>
                `;
            }
        }
    }
    
    filterProducts(searchTerm) {
        // Implementar búsqueda de productos
        console.log('Buscando:', searchTerm);
    }
    
    filterByCategory(category) {
        // Implementar filtro por categoría
        console.log('Filtrando por categoría:', category);
    }
    
    async processSale() {
        if (cart.length === 0) {
            this.showError('El carrito está vacío');
            return;
        }
        
        try {
            const paymentMethod = document.querySelector('input[name="payment"]:checked')?.value || 'cash';
            const clientInput = document.getElementById('client-search')?.value || '';
            
            // Calcular totales
            const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
            const tax = subtotal * 0.21;
            const total = subtotal + tax;
            
            // Crear objeto de venta
            const sale = {
                items: cart.map(item => ({
                    productId: item.id,
                    code: item.code,
                    name: item.name,
                    quantity: item.quantity,
                    price: item.price,
                    subtotal: item.price * item.quantity
                })),
                subtotal,
                tax,
                total,
                paymentMethod,
                client: clientInput || null,
                localId: currentLocal,
                userId: currentUser?.uid,
                userName: currentUser?.name || currentUser?.email,
                turn: currentTurn,
                status: isOnline ? 'completed' : 'pending',
                createdAt: new Date().toISOString(),
                offline: !isOnline
            };
            
            // Guardar venta
            if (isOnline) {
                await db.collection('sales').add(sale);
                logger.success('Venta procesada exitosamente');
                
                // Mostrar comprobante
                this.showReceipt(sale);
            } else {
                // Guardar como operación pendiente
                pendingOperations.push({
                    type: 'sale',
                    data: sale,
                    timestamp: Date.now()
                });
                
                this.showSuccess('Venta guardada localmente. Se sincronizará cuando haya conexión.');
                
                // Guardar en IndexedDB para persistencia
                await this.savePendingOperations();
            }
            
            // Limpiar carrito
            this.clearCart();
            
            // Actualizar estadísticas
            this.loadStats();
            
        } catch (error) {
            logger.error('Error procesando venta:', error);
            this.showError('Error al procesar la venta: ' + error.message);
        }
    }
    
    clearCart() {
        cart = [];
        this.updateCartUI();
        logger.info('Carrito limpiado');
    }
    
    updateCartUI() {
        // Actualizar contador en header
        document.getElementById('cart-count').textContent = cart.length;
        document.getElementById('cart-items-count').textContent = `${cart.length} items`;
        
        // Actualizar lista de productos en el carrito
        const cartItemsList = document.getElementById('cart-items-list');
        if (cartItemsList) {
            if (cart.length === 0) {
                cartItemsList.innerHTML = `
                    <div class="empty-cart">
                        <p>El carrito está vacío</p>
                        <p class="small">Agrega productos desde el panel izquierdo</p>
                    </div>
                `;
            } else {
                let html = '';
                cart.forEach(item => {
                    html += `
                        <div class="cart-item">
                            <div class="cart-item-info">
                                <strong>${item.name}</strong>
                                <small>${item.code}</small>
                            </div>
                            <div class="cart-item-controls">
                                <button class="btn-icon" onclick="app.ui.decreaseQuantity('${item.id}')">-</button>
                                <span>${item.quantity}</span>
                                <button class="btn-icon" onclick="app.ui.increaseQuantity('${item.id}')">+</button>
                            </div>
                            <div class="cart-item-price">
                                ${Utils?.formatCurrency?.(item.price * item.quantity) || `$${(item.price * item.quantity).toFixed(2)}`}
                            </div>
                            <button class="btn-icon danger" onclick="app.ui.removeFromCart('${item.id}')">×</button>
                        </div>
                    `;
                });
                cartItemsList.innerHTML = html;
            }
        }
        
        // Calcular y actualizar totales
        const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const tax = subtotal * 0.21;
        const total = subtotal + tax;
        
        document.getElementById('cart-subtotal').textContent = 
            Utils?.formatCurrency?.(subtotal) || `$${subtotal.toFixed(2)}`;
        document.getElementById('cart-tax').textContent = 
            Utils?.formatCurrency?.(tax) || `$${tax.toFixed(2)}`;
        document.getElementById('cart-total-amount').textContent = 
            Utils?.formatCurrency?.(total) || `$${total.toFixed(2)}`;
        
        // Actualizar carrito flotante
        document.getElementById('cart-total').textContent = 
            Utils?.formatCurrency?.(total) || `$${total.toFixed(2)}`;
        document.getElementById('cart-items').textContent = `${cart.length} items`;
    }
    
    showCart() {
        // Implementar visualización completa del carrito
        alert(`Carrito: ${cart.length} productos\nTotal: $${cart.reduce((sum, item) => sum + (item.price * item.quantity), 0).toFixed(2)}`);
    }
    
    showReceipt(sale) {
        // Crear contenido del comprobante
        const receiptContent = `
            <h3>🧾 Comprobante de Venta</h3>
            <p><strong>Fecha:</strong> ${new Date(sale.createdAt).toLocaleString()}</p>
            <p><strong>Vendedor:</strong> ${sale.userName}</p>
            <p><strong>Local:</strong> ${currentLocal}</p>
            <p><strong>Turno:</strong> ${sale.turn}</p>
            <p><strong>Método de pago:</strong> ${sale.paymentMethod === 'cash' ? 'Efectivo' : 
                sale.paymentMethod === 'card' ? 'Tarjeta' : 'Transferencia'}</p>
            <hr>
            <h4>Productos:</h4>
            ${sale.items.map(item => `
                <p>${item.quantity}x ${item.name} - ${Utils?.formatCurrency?.(item.subtotal) || `$${item.subtotal.toFixed(2)}`}</p>
            `).join('')}
            <hr>
            <p><strong>Subtotal:</strong> ${Utils?.formatCurrency?.(sale.subtotal) || `$${sale.subtotal.toFixed(2)}`}</p>
            <p><strong>IVA (21%):</strong> ${Utils?.formatCurrency?.(sale.tax) || `$${sale.tax.toFixed(2)}`}</p>
            <p><strong>TOTAL:</strong> ${Utils?.formatCurrency?.(sale.total) || `$${sale.total.toFixed(2)}`}</p>
            <hr>
            <p class="small">Gracias por su compra</p>
        `;
        
        // Mostrar modal
        if (window.showModal) {
            window.showModal('Comprobante de Venta', receiptContent, [
                { text: 'Imprimir', action: () => window.print() },
                { text: 'Cerrar', action: 'close' }
            ]);
        } else {
            alert('Venta completada exitosamente');
        }
    }
    
    async savePendingOperations() {
        try {
            localStorage.setItem('pendingOperations', JSON.stringify(pendingOperations));
        } catch (error) {
            logger.error('Error guardando operaciones pendientes:', error);
        }
    }
    
    loadPendingOperations() {
        try {
            const saved = localStorage.getItem('pendingOperations');
            if (saved) {
                pendingOperations = JSON.parse(saved) || [];
                logger.info(`Cargadas ${pendingOperations.length} operaciones pendientes`);
            }
        } catch (error) {
            logger.error('Error cargando operaciones pendientes:', error);
        }
    }
    
    showError(message) {
        const errorElement = document.getElementById('login-error');
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.display = 'block';
            
            // Auto-ocultar después de 5 segundos
            setTimeout(() => {
                errorElement.style.display = 'none';
            }, 5000);
        } else {
            alert(`Error: ${message}`);
        }
    }
    
    showSuccess(message) {
        // Crear notificación temporal
        const notification = document.createElement('div');
        notification.className = 'notification success';
        notification.innerHTML = `
            <span>✅ ${message}</span>
            <button onclick="this.parentElement.remove()">×</button>
        `;
        
        document.body.appendChild(notification);
        
        // Auto-remover después de 3 segundos
        setTimeout(() => {
            if (notification.parentElement) {
                notification.remove();
            }
        }, 3000);
    }
    
    hideError() {
        const errorElement = document.getElementById('login-error');
        if (errorElement) {
            errorElement.style.display = 'none';
        }
    }
    
    toggleSidebar() {
        const sidebar = document.getElementById('sidebar');
        const mainContent = document.getElementById('main-content');
        
        this.isSidebarOpen = !this.isSidebarOpen;
        
        if (this.isSidebarOpen) {
            sidebar.classList.remove('collapsed');
            mainContent.classList.remove('expanded');
        } else {
            sidebar.classList.add('collapsed');
            mainContent.classList.add('expanded');
        }
    }
    
    // Métodos para el carrito (disponibles globalmente)
    addToCart(product) {
        const existingItem = cart.find(item => item.id === product.id);
        
        if (existingItem) {
            existingItem.quantity += 1;
        } else {
            cart.push({
                ...product,
                quantity: 1
            });
        }
        
        this.updateCartUI();
        this.showSuccess(`${product.name} agregado al carrito`);
    }
    
    removeFromCart(productId) {
        cart = cart.filter(item => item.id !== productId);
        this.updateCartUI();
    }
    
    increaseQuantity(productId) {
        const item = cart.find(item => item.id === productId);
        if (item) {
            item.quantity += 1;
            this.updateCartUI();
        }
    }
    
    decreaseQuantity(productId) {
        const item = cart.find(item => item.id === productId);
        if (item) {
            if (item.quantity > 1) {
                item.quantity -= 1;
            } else {
                cart = cart.filter(i => i.id !== productId);
            }
            this.updateCartUI();
        }
    }
    
    // Métodos para productos
    editProduct(productId) {
        console.log('Editando producto:', productId);
        // Implementar lógica de edición
    }
    
    deleteProduct(productId) {
        if (confirm('¿Estás seguro de eliminar este producto?')) {
            console.log('Eliminando producto:', productId);
            // Implementar lógica de eliminación
        }
    }
    
    // Métodos para otras secciones (simplificados)
    getClientsContent() {
        return '<h2>👥 Gestión de Clientes</h2><p>Sección en desarrollo.</p>';
    }
    
    getSalesContent() {
        return '<h2>📊 Historial de Ventas</h2><p>Sección en desarrollo.</p>';
    }
    
    getCashboxContent() {
        return '<h2>💰 Caja Diaria</h2><p>Sección en desarrollo.</p>';
    }
    
    getReportsContent() {
        return '<h2>📈 Reportes y Estadísticas</h2><p>Sección en desarrollo.</p>';
    }
    
    getBudgetsContent() {
        return '<h2>📄 Presupuestos</h2><p>Sección en desarrollo.</p>';
    }
    
    getProvidersContent() {
        return '<h2>🚚 Proveedores</h2><p>Sección en desarrollo.</p>';
    }
    
    loadClients() { /* Implementar */ }
    loadSales() { /* Implementar */ }
    loadCashbox() { /* Implementar */ }
    loadReports() { /* Implementar */ }
    loadBudgets() { /* Implementar */ }
    loadProviders() { /* Implementar */ }
}

/**
 * Inicializar aplicación
 */
async function initializeApp() {
    logger.info('🚀 Inicializando POS Ferretería...');
    
    try {
        // Crear instancia de UI
        ui = new UI();
        
        // Verificar si hay una sesión previa
        const lastLogin = localStorage.getItem('lastLogin');
        if (lastLogin) {
            try {
                const loginData = JSON.parse(lastLogin);
                
                // Auto-rellenar formulario
                const emailInput = document.getElementById('email');
                const localSelect = document.getElementById('local-select');
                const turnoSelect = document.getElementById('turno-select');
                
                if (emailInput && loginData.email) {
                    emailInput.value = loginData.email;
                }
                
                if (turnoSelect && loginData.turno) {
                    turnoSelect.value = loginData.turno;
                }
                
                // Cargar locales y seleccionar el último
                setTimeout(() => {
                    if (localSelect && loginData.localId) {
                        localSelect.value = loginData.localId;
                    }
                }, 1000);
                
            } catch (error) {
                logger.warn('Error cargando sesión previa:', error);
            }
        }
        
        // Cargar operaciones pendientes
        ui.loadPendingOperations();
        
        // Inicializar UI
        ui.init();
        
        // Configurar listener de Firebase Auth
        auth.onAuthStateChanged(async (user) => {
            if (user) {
                // Usuario autenticado
                try {
                    const userData = await getCurrentUser();
                    if (userData) {
                        currentUser = userData;
                        logger.success(`Usuario autenticado: ${userData.email}`);
                        
                        // Si ya estamos en la app, actualizar info
                        if (document.getElementById('app-screen').classList.contains('active')) {
                            ui.updateUserInfo(userData);
                        }
                    }
                } catch (error) {
                    logger.error('Error obteniendo datos de usuario:', error);
                }
            } else {
                // Usuario no autenticado
                currentUser = null;
                logger.info('Usuario no autenticado');
            }
        });
        
        logger.success('✅ Aplicación inicializada correctamente');
        
    } catch (error) {
        logger.error('❌ Error inicializando aplicación:', error);
        
        // Mostrar error al usuario
        const errorElement = document.getElementById('login-error');
        if (errorElement) {
            errorElement.textContent = 'Error inicializando la aplicación. Recarga la página.';
            errorElement.style.display = 'block';
        }
    }
}

// Inicializar cuando el DOM esté listo
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Hacer UI disponible globalmente
window.app = {
    ui,
    cart: {
        add: (product) => ui.addToCart(product),
        remove: (productId) => ui.removeFromCart(productId),
        clear: () => ui.clearCart()
    }
};

// Exportar para módulos
export { ui, currentUser, currentLocal, currentTurn };
