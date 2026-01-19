// app.js - Sistema POS Ferretería - Versión corregida
// Compatible con todos los archivos JS existentes

// ============================================
// INICIALIZACIÓN Y CONFIGURACIÓN GLOBAL
// ============================================

// Variables globales (se sobreescriben si ya existen)
window.db = window.db || null;
window.auth = window.auth || null;
window.currentUser = window.currentUser || null;
window.currentLocal = window.currentLocal || null;
window.currentTurn = window.currentTurn || null;
window.isOnline = window.isOnline || navigator.onLine;

// Managers globales
window.AuthManager = window.AuthManager || null;
window.OfflineManager = window.OfflineManager || null;
window.UIManager = window.UIManager || null;
window.ProductManager = window.ProductManager || null;
window.CartManager = window.CartManager || null;

// ============================================
// FUNCIONES DE INICIALIZACIÓN
// ============================================

/**
 * Inicializa la aplicación completa
 */
async function initializeApp() {
    console.log('🚀 Inicializando POS Ferretería...');
    
    try {
        // 1. Inicializar Firebase
        await initializeFirebase();
        
        // 2. Configurar listeners globales
        setupGlobalListeners();
        
        // 3. Verificar autenticación previa
        await checkPreviousSession();
        
        // 4. Cargar datos iniciales
        await loadInitialData();
        
        // 5. Inicializar UI
        initializeUI();
        
        console.log('✅ Aplicación inicializada correctamente');
        
    } catch (error) {
        console.error('❌ Error inicializando aplicación:', error);
        showError('Error al iniciar la aplicación: ' + error.message);
    }
}

/**
 * Inicializa Firebase
 */
async function initializeFirebase() {
    console.log('🔥 Inicializando Firebase...');
    
    // Configuración de Firebase
    const firebaseConfig = {
        apiKey: "AIzaSyCtOiUy2tUQeixUiJxTdI_ESULY4WpqXzw",
        authDomain: "whatsappau-30dc1.firebaseapp.com",
        projectId: "whatsappau-30dc1",
        storageBucket: "whatsappau-30dc1.firebasestorage.app",
        messagingSenderId: "456068013185",
        appId: "1:456068013185:web:5bdd49337fb622e56f0180"
    };
    
    // Evitar inicialización múltiple
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }
    
    // Asignar a variables globales
    window.db = firebase.firestore();
    window.auth = firebase.auth();
    
    // Habilitar persistencia offline
    try {
        await window.db.enablePersistence();
        console.log('✅ Persistencia offline habilitada');
    } catch (err) {
        console.warn('⚠️ Persistencia no disponible:', err.message);
    }
    
    console.log('✅ Firebase inicializado');
}

/**
 * Configura listeners globales
 */
function setupGlobalListeners() {
    console.log('🎧 Configurando listeners...');
    
    // Conexión/desconexión
    window.addEventListener('online', updateConnectionStatus);
    window.addEventListener('offline', updateConnectionStatus);
    
    // Login button
    const loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
        loginBtn.addEventListener('click', handleLogin);
    }
    
    // Login con Enter
    document.addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && isLoginScreenVisible()) {
            handleLogin();
        }
    });
    
    // Logout button
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }
    
    // Toggle sidebar
    const menuToggle = document.getElementById('menu-toggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', toggleSidebar);
    }
    
    // Navegación
    setupNavigationListeners();
    
    console.log('✅ Listeners configurados');
}

/**
 * Configura listeners de navegación
 */
function setupNavigationListeners() {
    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const section = this.getAttribute('data-section');
            loadSection(section);
        });
    });
}

/**
 * Verifica sesión previa
 */
async function checkPreviousSession() {
    console.log('🔍 Verificando sesión previa...');
    
    // Verificar en localStorage
    const savedSession = localStorage.getItem('pos_session');
    if (savedSession) {
        try {
            const session = JSON.parse(savedSession);
            
            // Autorellenar formulario
            const emailInput = document.getElementById('email');
            if (emailInput) emailInput.value = session.email || '';
            
            // Cargar locales disponibles
            await loadLocals();
            
            // Seleccionar local guardado si existe
            const localSelect = document.getElementById('local-select');
            if (localSelect && session.localId) {
                setTimeout(() => {
                    localSelect.value = session.localId;
                }, 500);
            }
            
        } catch (error) {
            console.warn('⚠️ Error restaurando sesión:', error);
        }
    }
    
    // Verificar usuario autenticado en Firebase
    if (window.auth && window.auth.currentUser) {
        console.log('✅ Usuario ya autenticado');
        await handleAuthSuccess(window.auth.currentUser);
    }
}

/**
 * Carga datos iniciales
 */
async function loadInitialData() {
    console.log('📊 Cargando datos iniciales...');
    
    // Solo cargar si hay usuario autenticado
    if (!window.currentUser) return;
    
    // Cargar locales
    await loadLocals();
    
    // Actualizar estadísticas
    updateStats();
    
    console.log('✅ Datos iniciales cargados');
}

/**
 * Inicializa la interfaz de usuario
 */
function initializeUI() {
    console.log('🎨 Inicializando UI...');
    
    // Actualizar estado de conexión
    updateConnectionStatus();
    
    // Actualizar año actual
    const yearElements = document.querySelectorAll('.current-year');
    yearElements.forEach(el => {
        el.textContent = new Date().getFullYear();
    });
    
    // Configurar carrito minimizado
    const cartToggle = document.getElementById('toggle-cart');
    if (cartToggle) {
        cartToggle.addEventListener('click', function() {
            loadSection('cart');
        });
    }
    
    // Inicializar managers UI si existen
    if (window.UIManager && typeof window.UIManager.init === 'function') {
        try {
            // Parche para función faltante
            if (!window.UIManager.setupGlobalListeners) {
                window.UIManager.setupGlobalListeners = function() {
                    console.log('UIManager.setupGlobalListeners llamado');
                };
            }
            window.UIManager.init();
        } catch (error) {
            console.warn('⚠️ Error inicializando UIManager:', error);
        }
    }
    
    console.log('✅ UI inicializada');
}

// ============================================
// MANEJO DE AUTENTICACIÓN
// ============================================

/**
 * Maneja el proceso de login
 */
async function handleLogin() {
    console.log('🔐 Procesando login...');
    
    // Obtener valores del formulario
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const localId = document.getElementById('local-select').value;
    const turno = document.getElementById('turno-select').value;
    
    // Validar campos
    if (!email || !password || !localId || !turno) {
        showError('Por favor, completa todos los campos');
        return;
    }
    
    // Mostrar loading
    showLoginLoading(true);
    
    try {
        // Usar AuthManager si existe, si no usar Firebase directamente
        let userCredential;
        
        if (window.AuthManager && typeof window.AuthManager.login === 'function') {
            const result = await window.AuthManager.login(email, password, localId, turno);
            if (!result.success) throw new Error(result.error);
            userCredential = { user: result.user };
        } else {
            // Login directo con Firebase
            userCredential = await window.auth.signInWithEmailAndPassword(email, password);
        }
        
        // Guardar sesión
        await saveSession(email, localId, turno, userCredential.user.uid);
        
        // Manejar éxito
        await handleAuthSuccess(userCredential.user, localId, turno);
        
    } catch (error) {
        console.error('❌ Error en login:', error);
        showLoginError(error);
    } finally {
        showLoginLoading(false);
    }
}

/**
 * Maneja logout
 */
async function handleLogout() {
    console.log('🚪 Cerrando sesión...');
    
    try {
        // Cerrar sesión en Firebase
        if (window.auth) {
            await window.auth.signOut();
        }
        
        // Limpiar datos locales
        localStorage.removeItem('pos_session');
        localStorage.removeItem('pos_user_data');
        
        window.currentUser = null;
        window.currentLocal = null;
        window.currentTurn = null;
        
        // Recargar para mostrar login
        window.location.reload();
        
    } catch (error) {
        console.error('❌ Error en logout:', error);
        showError('Error al cerrar sesión');
    }
}

/**
 * Guarda la sesión en localStorage
 */
async function saveSession(email, localId, turno, userId) {
    const sessionData = {
        email: email,
        localId: localId,
        turno: turno,
        userId: userId,
        timestamp: new Date().toISOString()
    };
    
    localStorage.setItem('pos_session', JSON.stringify(sessionData));
}

/**
 * Maneja éxito de autenticación
 */
async function handleAuthSuccess(user, localId = null, turno = null) {
    console.log('✅ Autenticación exitosa');
    
    // Actualizar variables globales
    window.currentUser = user;
    window.currentLocal = localId || window.currentLocal;
    window.currentTurn = turno || window.currentTurn;
    
    // Ocultar login, mostrar app
    showAppScreen();
    
    // Actualizar información de usuario
    updateUserInfo();
    
    // Cargar datos del usuario
    await loadUserData(user.uid);
    
    // Inicializar otros managers
    initializeOtherManagers();
}

/**
 * Carga datos del usuario
 */
async function loadUserData(userId) {
    try {
        if (!window.db) return;
        
        const userDoc = await window.db.collection('users').doc(userId).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            localStorage.setItem('pos_user_data', JSON.stringify(userData));
            
            // Actualizar variables
            window.currentLocal = userData.localId || window.currentLocal;
            window.currentTurn = userData.currentTurn || window.currentTurn;
        }
    } catch (error) {
        console.warn('⚠️ Error cargando datos de usuario:', error);
    }
}

// ============================================
// MANEJO DE UI
// ============================================

/**
 * Muestra/oculta pantalla de login
 */
function showAppScreen() {
    const loginScreen = document.getElementById('login-screen');
    const appScreen = document.getElementById('app-screen');
    
    if (loginScreen) loginScreen.classList.remove('active');
    if (appScreen) appScreen.style.display = 'flex';
}

/**
 * Verifica si la pantalla de login es visible
 */
function isLoginScreenVisible() {
    const loginScreen = document.getElementById('login-screen');
    return loginScreen && loginScreen.classList.contains('active');
}

/**
 * Actualiza información del usuario en la UI
 */
function updateUserInfo() {
    if (!window.currentUser) return;
    
    // Email del usuario
    const userEmail = window.currentUser.email || '';
    const userName = userEmail.split('@')[0] || 'Usuario';
    
    // Actualizar elementos
    const userElements = {
        'current-user': userName,
        'current-local': window.currentLocal || 'No asignado',
        'current-turn': window.currentTurn || '--'
    };
    
    Object.keys(userElements).forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = userElements[id];
        }
    });
}

/**
 * Actualiza estado de conexión
 */
function updateConnectionStatus() {
    const isOnline = navigator.onLine;
    window.isOnline = isOnline;
    
    // Actualizar indicadores
    const statusElements = [
        { id: 'connection-status', onlineText: '● Conectado', offlineText: '● Sin conexión' },
        { id: 'app-connection-status', onlineText: 'ONLINE', offlineText: 'OFFLINE' }
    ];
    
    statusElements.forEach(item => {
        const element = document.getElementById(item.id);
        if (element) {
            element.textContent = isOnline ? item.onlineText : item.offlineText;
            element.className = isOnline ? 'status-online' : 'status-offline';
        }
    });
    
    // Mostrar/ocultar indicador de sincronización
    const syncIndicator = document.getElementById('pending-sync');
    if (syncIndicator) {
        // Aquí podríamos verificar operaciones pendientes
        syncIndicator.style.display = 'none';
    }
}

/**
 * Carga una sección específica
 */
function loadSection(section) {
    console.log('📂 Cargando sección:', section);
    
    // Remover active de todos los links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.remove('active');
    });
    
    // Activar link actual
    const activeLink = document.querySelector(`.nav-link[data-section="${section}"]`);
    if (activeLink) {
        activeLink.classList.add('active');
    }
    
    // Aquí se cargaría el contenido dinámico
    // Por ahora solo actualizamos el placeholder
    const content = document.getElementById('main-content');
    if (content) {
        content.innerHTML = `
            <div class="content-placeholder">
                <div class="placeholder-icon">${getSectionIcon(section)}</div>
                <h2>${getSectionTitle(section)}</h2>
                <p>Sección en desarrollo. Próximamente disponible.</p>
                <div class="placeholder-stats">
                    <div class="stat-card">
                        <div class="stat-value" id="stat-products">0</div>
                        <div class="stat-label">Productos</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="stat-sales-today">0</div>
                        <div class="stat-label">Ventas Hoy</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-value" id="stat-pending">0</div>
                        <div class="stat-label">Pendientes</div>
                    </div>
                </div>
            </div>
        `;
    }
    
    // Actualizar estadísticas
    updateStats();
}

/**
 * Obtiene ícono para sección
 */
function getSectionIcon(section) {
    const icons = {
        'pos': '🏪',
        'products': '📦',
        'clients': '👥',
        'budgets': '📄',
        'sales': '📊',
        'reports': '📈',
        'providers': '🚚',
        'cashbox': '💰',
        'users': '👤',
        'locals': '🏪',
        'config': '⚙️',
        'cart': '🛒'
    };
    return icons[section] || '📁';
}

/**
 * Obtiene título para sección
 */
function getSectionTitle(section) {
    const titles = {
        'pos': 'Punto de Venta',
        'products': 'Productos',
        'clients': 'Clientes',
        'budgets': 'Presupuestos',
        'sales': 'Ventas',
        'reports': 'Reportes',
        'providers': 'Proveedores',
        'cashbox': 'Caja Diaria',
        'users': 'Usuarios',
        'locals': 'Locales',
        'config': 'Configuración',
        'cart': 'Carrito de Compras'
    };
    return titles[section] || 'Sección';
}

/**
 * Toggle sidebar
 */
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('collapsed');
    }
}

// ============================================
// FUNCIONES DE DATOS
// ============================================

/**
 * Carga locales disponibles
 */
async function loadLocals() {
    const localSelect = document.getElementById('local-select');
    if (!localSelect) return;
    
    try {
        // Intentar cargar de Firestore
        if (window.db) {
            const localsSnapshot = await window.db.collection('locals')
                .where('isActive', '==', true)
                .get();
            
            if (!localsSnapshot.empty) {
                localSelect.innerHTML = '<option value="">Selecciona un local</option>';
                
                localsSnapshot.forEach(doc => {
                    const local = doc.data();
                    const option = document.createElement('option');
                    option.value = doc.id;
                    option.textContent = `${local.name} (${local.code})`;
                    localSelect.appendChild(option);
                });
                
                console.log(`✅ ${localsSnapshot.size} locales cargados`);
                return;
            }
        }
        
        // Fallback: locales por defecto
        localSelect.innerHTML = `
            <option value="local_1">Local Principal</option>
            <option value="local_2">Sucursal Norte</option>
            <option value="local_3">Sucursal Sur</option>
        `;
        
    } catch (error) {
        console.error('❌ Error cargando locales:', error);
        localSelect.innerHTML = `
            <option value="local_1">Local Principal</option>
            <option value="">Error cargando locales</option>
        `;
    }
}

/**
 * Actualiza estadísticas
 */
function updateStats() {
    // Valores de ejemplo - en producción vendrían de la base de datos
    const stats = {
        'products': Math.floor(Math.random() * 500) + 100,
        'sales-today': Math.floor(Math.random() * 50) + 5,
        'pending': Math.floor(Math.random() * 10)
    };
    
    Object.keys(stats).forEach(stat => {
        const element = document.getElementById(`stat-${stat}`);
        if (element) {
            animateCount(element, parseInt(element.textContent) || 0, stats[stat]);
        }
    });
}

/**
 * Animación de conteo
 */
function animateCount(element, start, end) {
    if (start === end) return;
    
    const duration = 500;
    const stepTime = 20;
    const steps = duration / stepTime;
    const increment = (end - start) / steps;
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.round(current);
    }, stepTime);
}

// ============================================
// INICIALIZACIÓN DE MANAGERS
// ============================================

/**
 * Inicializa otros managers
 */
function initializeOtherManagers() {
    console.log('🔄 Inicializando managers...');
    
    // Lista de managers a inicializar
    const managers = [
        { name: 'OfflineManager', initFn: 'init' },
        { name: 'ProductManager', initFn: 'init' },
        { name: 'CartManager', initFn: 'init' },
        { name: 'SyncManager', initFn: 'init' },
        { name: 'RealtimeManager', initFn: 'init' },
        { name: 'SalesManager', initFn: 'init' },
        { name: 'BudgetsManager', initFn: 'init' },
        { name: 'ClientsManager', initFn: 'init' },
        { name: 'ProvidersManager', initFn: 'init' },
        { name: 'CashboxManager', initFn: 'init' },
        { name: 'ReportsManager', initFn: 'init' }
    ];
    
    managers.forEach(manager => {
        if (window[manager.name] && typeof window[manager.name][manager.initFn] === 'function') {
            try {
                window[manager.name][manager.initFn]();
                console.log(`✅ ${manager.name} inicializado`);
            } catch (error) {
                console.warn(`⚠️ Error inicializando ${manager.name}:`, error);
            }
        }
    });
}

// ============================================
// FUNCIONES DE UTILIDAD
// ============================================

/**
 * Muestra/oculta loading en login
 */
function showLoginLoading(show) {
    const loginBtn = document.getElementById('login-btn');
    if (!loginBtn) return;
    
    const btnText = loginBtn.querySelector('.btn-text');
    const btnSpinner = loginBtn.querySelector('.btn-spinner');
    
    if (btnText && btnSpinner) {
        if (show) {
            btnText.style.display = 'none';
            btnSpinner.style.display = 'inline-block';
            loginBtn.disabled = true;
        } else {
            btnText.style.display = 'inline-block';
            btnSpinner.style.display = 'none';
            loginBtn.disabled = false;
        }
    }
}

/**
 * Muestra error en login
 */
function showLoginError(error) {
    const errorDiv = document.getElementById('login-error');
    if (!errorDiv) return;
    
    let message = 'Error al iniciar sesión';
    
    if (error.code) {
        switch(error.code) {
            case 'auth/user-not-found':
                message = 'Usuario no encontrado';
                break;
            case 'auth/wrong-password':
                message = 'Contraseña incorrecta';
                break;
            case 'auth/too-many-requests':
                message = 'Demasiados intentos. Intenta más tarde';
                break;
            case 'auth/network-request-failed':
                message = 'Error de conexión. Verifica tu internet';
                break;
            default:
                message = error.message || 'Error desconocido';
        }
    } else if (error.message) {
        message = error.message;
    }
    
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    // Ocultar después de 5 segundos
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}

/**
 * Muestra error general
 */
function showError(message) {
    console.error('❌ Error:', message);
    
    // Intentar usar toast si existe
    if (window.UIManager && typeof window.UIManager.showToast === 'function') {
        window.UIManager.showToast(message, 'error');
    } else {
        // Fallback: alert simple
        alert('Error: ' + message);
    }
}

// ============================================
// INICIALIZACIÓN AL CARGAR LA PÁGINA
// ============================================

// Esperar a que el DOM esté completamente cargado
document.addEventListener('DOMContentLoaded', function() {
    console.log('📄 DOM cargado, iniciando aplicación...');
    
    // Inicializar después de un pequeño delay para asegurar que todos los scripts se carguen
    setTimeout(() => {
        initializeApp();
    }, 100);
});

// Exportar funciones principales para acceso global
window.initializeApp = initializeApp;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.loadSection = loadSection;
window.updateConnectionStatus = updateConnectionStatus;

console.log('✅ app.js cargado correctamente');
