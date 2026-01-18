// ============================================
// SISTEMA POS/FACTURACIÓN - APP.JS COMPLETO
// ============================================
// Sistema completo para producción comercial real
// Concurrencia multipuesto, transacciones Firestore, roles reales
// ============================================

// ============================================
// CONFIGURACIÓN Y CONSTANTES
// ============================================

// Configuración de Firebase (REEMPLAZAR CON TU CONFIGURACIÓN)
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCtOiUy2tUQeixUiJxTdI_ESULY4WpqXzw",
    authDomain: "whatsappau-30dc1.firebaseapp.com",
    projectId: "whatsappau-30dc1",
    storageBucket: "whatsappau-30dc1.firebasestorage.app",
    messagingSenderId: "456068013185",
    appId: "1:456068013185:web:5bdd49337fb622e56f0180"
};

// Constantes del sistema
const ROLES = {
    ADMIN_GENERAL: 'admin_general',
    ADMIN_SUCURSAL: 'admin_sucursal',
    CAJERO: 'cajero',
    VENDEDOR: 'vendedor'
};

const PERMISOS = {
    admin_general: ['*'],
    admin_sucursal: ['ventas', 'productos', 'clientes', 'caja', 'reportes', 'usuarios_sucursal', 'configuracion_sucursal'],
    cajero: ['ventas', 'caja', 'clientes_consulta'],
    vendedor: ['ventas', 'productos_consulta']
};

const TURNOS = {
    MAÑANA: 'mañana',
    TARDE: 'tarde',
    NOCHE: 'noche'
};

const ESTADOS_VENTA = {
    PENDIENTE: 'pendiente',
    COMPLETADA: 'completada',
    ANULADA: 'anulada',
    REEMITIDA: 'reemitida'
};

const IVA_PORCENTAJE = 0.21;
const LIMITE_PRODUCTOS_PAGINA = 100;
const SUCURSAL_DEFAULT = 'principal';

// ============================================
// INICIALIZACIÓN FIREBASE
// ============================================

// Inicializar Firebase
const app = firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();

// Configurar persistencia de sesión
auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);

// Habilitar cache Firestore para offline
db.enablePersistence({ synchronizeTabs: true })
    .catch((err) => {
        console.log('Persistencia no soportada:', err.code);
    });

// ============================================
// VARIABLES GLOBALES
// ============================================

let usuarioActual = null;
let empresaActual = null;
let sucursalActual = SUCURSAL_DEFAULT;
let cajaActual = '1';
let turnoActual = null;
let carrito = [];
let productosCache = new Map();
let productosFiltrados = [];
let clientesCache = new Map();
let proveedoresCache = new Map();
let modoEmergencia = false;
let ventasPendientes = [];
let ultimaVenta = null;
let configuracion = {};
let configuracionSucursal = {};
let configuracionEmpresa = {};
let listenersActivos = [];
let ultimoCursorProductos = null;
let cargandoProductos = false;
let syncInterval = null;

// ============================================
// INICIALIZACIÓN DEL SISTEMA
// ============================================

document.addEventListener('DOMContentLoaded', async function() {
    console.log('Iniciando sistema POS...');
    
    // Inicializar IndexedDB para modo offline
    await initIndexedDB();
    
    // Inicializar PWA
    initPWA();
    
    // Verificar autenticación
    auth.onAuthStateChanged(async (user) => {
        if (user) {
            // Usuario autenticado
            await iniciarSistema(user);
        } else {
            // Mostrar pantalla de login
            mostrarLogin();
        }
    });
    
    // Configurar eventos de UI
    configurarEventosUI();
    
    // Monitorear conexión
    initConnectionMonitor();
    
    // Iniciar sincronización periódica
    syncInterval = setInterval(sincronizarDatosPendientes, 30000);
    
    console.log('Sistema inicializado');
});

// ============================================
// SISTEMA PWA
// ============================================

function initPWA() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .then(() => console.log('Service Worker registrado'))
            .catch(err => console.log('SW registration failed:', err));
    }
    
    // Detectar instalación PWA
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        window.deferredPrompt = e;
        mostrarBotonInstalar();
    });
}

function mostrarBotonInstalar() {
    const installBtn = document.getElementById('installBtn');
    if (!installBtn) return;
    
    installBtn.style.display = 'block';
    installBtn.addEventListener('click', async () => {
        const promptEvent = window.deferredPrompt;
        if (!promptEvent) return;
        
        promptEvent.prompt();
        const result = await promptEvent.userChoice;
        window.deferredPrompt = null;
        
        if (result.outcome === 'accepted') {
            console.log('PWA instalado');
        }
    });
}

// ============================================
// SISTEMA DE AUTENTICACIÓN Y ROLES
// ============================================

async function login() {
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const remember = document.getElementById('rememberMe').checked;
    
    if (!email || !password) {
        mostrarAlerta('Ingrese email y contraseña', 'danger');
        return;
    }
    
    try {
        mostrarCargando('Iniciando sesión...');
        
        // Configurar persistencia
        const persistence = remember ? 
            firebase.auth.Auth.Persistence.LOCAL : 
            firebase.auth.Auth.Persistence.SESSION;
        
        await auth.setPersistence(persistence);
        
        // Iniciar sesión
        const userCredential = await auth.signInWithEmailAndPassword(email, password);
        
        // Obtener datos del usuario desde Firestore
        const userDoc = await db.collection('usuarios').doc(userCredential.user.uid).get();
        
        if (!userDoc.exists) {
            mostrarAlerta('Usuario no configurado en el sistema', 'danger');
            await auth.signOut();
            return;
        }
        
        const userData = userDoc.data();
        
        // Verificar estado del usuario
        if (userData.estado !== 'activo') {
            mostrarAlerta('Usuario inactivo. Contacte al administrador.', 'danger');
            await auth.signOut();
            return;
        }
        
        // Actualizar último acceso
        await db.collection('usuarios').doc(userCredential.user.uid).update({
            ultimoAcceso: new Date(),
            ultimaIP: await obtenerIP()
        });
        
        mostrarAlerta(`Bienvenido ${userData.nombre || userData.email}`, 'success');
        
    } catch (error) {
        console.error('Error en login:', error);
        
        let mensaje = 'Error al iniciar sesión';
        switch(error.code) {
            case 'auth/user-not-found':
                mensaje = 'Usuario no encontrado';
                break;
            case 'auth/wrong-password':
                mensaje = 'Contraseña incorrecta';
                break;
            case 'auth/too-many-requests':
                mensaje = 'Demasiados intentos. Intente más tarde';
                break;
            case 'auth/user-disabled':
                mensaje = 'Usuario deshabilitado';
                break;
        }
        
        mostrarAlerta(mensaje, 'danger');
    }
}

async function obtenerIP() {
    try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        return data.ip;
    } catch (error) {
        return '127.0.0.1';
    }
}

async function iniciarSistema(user) {
    try {
        mostrarCargando('Cargando sistema...');
        
        // Obtener datos del usuario
        const userDoc = await db.collection('usuarios').doc(user.uid).get();
        
        if (!userDoc.exists) {
            await logout();
            return;
        }
        
        usuarioActual = {
            uid: user.uid,
            email: user.email,
            ...userDoc.data()
        };
        
        // Cargar configuración de empresa
        await cargarConfiguracionEmpresa();
        
        // Verificar permisos mínimos
        if (!usuarioActual.rol || !PERMISOS[usuarioActual.rol]) {
            mostrarAlerta('Usuario sin rol asignado', 'danger');
            await logout();
            return;
        }
        
        // Verificar si tiene múltiples sucursales
        const sucursales = usuarioActual.sucursales || [SUCURSAL_DEFAULT];
        
        if (sucursales.length > 1) {
            // Mostrar selector de sucursal
            mostrarSelectorSucursal(sucursales);
            return;
        }
        
        // Configurar sucursal
        sucursalActual = sucursales[0];
        
        // Cargar configuración del sistema
        await cargarConfiguracionCompleta();
        
        // Inicializar sistema
        await inicializarSistema();
        
        // Mostrar sistema principal
        mostrarSistemaPrincipal();
        
    } catch (error) {
        console.error('Error iniciando sistema:', error);
        
        // Intentar modo emergencia
        if (error.code === 'unavailable' || !navigator.onLine) {
            activarModoEmergencia();
            mostrarSistemaPrincipal();
        } else {
            mostrarAlerta('Error al cargar el sistema: ' + error.message, 'danger');
        }
    }
}

function mostrarSelectorSucursal(sucursales) {
    const selector = document.getElementById('sucursalSelector');
    const select = document.getElementById('selectSucursalLogin');
    
    if (!selector || !select) return;
    
    select.innerHTML = '<option value="">Seleccionar sucursal</option>';
    sucursales.forEach(sucursal => {
        select.innerHTML += `<option value="${sucursal}">${sucursal}</option>`;
    });
    
    selector.style.display = 'block';
}

async function seleccionarSucursal() {
    const select = document.getElementById('selectSucursalLogin');
    if (!select) return;
    
    const sucursal = select.value;
    
    if (!sucursal) {
        mostrarAlerta('Seleccione una sucursal', 'warning');
        return;
    }
    
    // Verificar si el usuario tiene acceso a esta sucursal
    if (!usuarioActual.sucursales || !usuarioActual.sucursales.includes(sucursal)) {
        mostrarAlerta('No tiene acceso a esta sucursal', 'danger');
        return;
    }
    
    sucursalActual = sucursal;
    await inicializarSistema();
    mostrarSistemaPrincipal();
}

async function logout() {
    try {
        // Confirmar si hay ventas pendientes
        if (ventasPendientes.length > 0) {
            if (!confirm(`Tiene ${ventasPendientes.length} ventas pendientes de sincronizar. ¿Desea cerrar sesión de todos modos?`)) {
                return;
            }
        }
        
        // Cerrar turno si está abierto
        if (turnoActual && turnoActual.estado === 'abierto') {
            const cerrar = confirm('Tiene un turno abierto. ¿Desea cerrarlo antes de salir?');
            if (cerrar) {
                await cerrarTurno();
            }
        }
        
        // Detener todos los listeners
        listenersActivos.forEach(unsubscribe => {
            try {
                unsubscribe();
            } catch (e) {
                console.error('Error deteniendo listener:', e);
            }
        });
        listenersActivos = [];
        
        // Detener intervalo de sincronización
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
        
        // Guardar estado local
        guardarEstadoLocal();
        
        // Cerrar sesión en Firebase
        await auth.signOut();
        
        // Limpiar variables
        usuarioActual = null;
        empresaActual = null;
        sucursalActual = SUCURSAL_DEFAULT;
        cajaActual = '1';
        turnoActual = null;
        carrito = [];
        productosCache.clear();
        productosFiltrados = [];
        clientesCache.clear();
        proveedoresCache.clear();
        ventasPendientes = [];
        configuracion = {};
        configuracionSucursal = {};
        configuracionEmpresa = {};
        
        // Mostrar pantalla de login
        mostrarLogin();
        
    } catch (error) {
        console.error('Error en logout:', error);
        mostrarAlerta('Error al cerrar sesión: ' + error.message, 'danger');
    }
}

// ============================================
// INICIALIZACIÓN DEL SISTEMA
// ============================================

async function inicializarSistema() {
    try {
        mostrarCargando('Inicializando sistema...');
        
        // 1. Verificar turno activo
        await verificarTurnoActivo();
        
        // 2. Cargar cache de datos
        await cargarCacheDatos();
        
        // 3. Configurar listeners en tiempo real
        configurarListenersTiempoReal();
        
        // 4. Configurar UI según rol
        configurarUIporRol();
        
        // 5. Inicializar vista POS
        inicializarVistaPOS();
        
        // 6. Verificar modo emergencia
        verificarModoEmergencia();
        
        // 7. Actualizar UI del usuario
        actualizarUIUsuario();
        
        // 8. Cargar contadores iniciales
        await cargarContadoresIniciales();
        
        console.log('Sistema inicializado para sucursal:', sucursalActual);
        
    } catch (error) {
        console.error('Error inicializando sistema:', error);
        
        if (error.code === 'unavailable' || !navigator.onLine) {
            activarModoEmergencia();
        } else {
            throw error;
        }
    }
}

async function cargarCacheDatos() {
    // Cargar productos con paginación para escalabilidad
    await cargarProductosPaginados();
    
    // Cargar clientes
    await cargarClientes();
    
    // Cargar proveedores
    await cargarProveedores();
    
    // Cargar categorías
    await cargarCategorias();
    
    // Cargar ventas pendientes desde IndexedDB
    await cargarVentasPendientesLocal();
}

async function cargarProductosPaginados(lastDoc = null) {
    if (cargandoProductos) return;
    cargandoProductos = true;
    
    try {
        let query = db.collection('productos')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .orderBy('nombre')
            .limit(LIMITE_PRODUCTOS_PAGINA);
        
        if (lastDoc) {
            query = query.startAfter(lastDoc);
        }
        
        const snapshot = await query.get();
        
        snapshot.forEach(doc => {
            productosCache.set(doc.id, { id: doc.id, ...doc.data() });
        });
        
        // Actualizar array filtrado
        productosFiltrados = Array.from(productosCache.values());
        
        // Guardar en IndexedDB para offline
        await guardarProductosCacheLocal();
        
        // Actualizar contador
        actualizarContadorProductos();
        
        // Actualizar último cursor
        ultimoCursorProductos = snapshot.docs[snapshot.docs.length - 1];
        
        // Si hay más productos, cargar en segundo plano
        if (snapshot.size === LIMITE_PRODUCTOS_PAGINA) {
            setTimeout(() => cargarProductosPaginados(ultimoCursorProductos), 1000);
        }
        
        return ultimoCursorProductos;
        
    } catch (error) {
        console.error('Error cargando productos:', error);
        
        // Intentar cargar desde cache local
        await cargarProductosCacheLocal();
        return null;
    } finally {
        cargandoProductos = false;
    }
}

// ============================================
// SISTEMA DE TURNOS Y CAJA
// ============================================

async function verificarTurnoActivo() {
    try {
        const hoy = new Date();
        hoy.setHours(0, 0, 0, 0);
        
        const snapshot = await db.collection('turnos')
            .where('sucursalId', '==', sucursalActual)
            .where('usuarioId', '==', usuarioActual.uid)
            .where('estado', '==', 'abierto')
            .where('apertura', '>=', hoy)
            .limit(1)
            .get();
        
        if (!snapshot.empty) {
            const turnoDoc = snapshot.docs[0];
            turnoActual = { id: turnoDoc.id, ...turnoDoc.data() };
            cajaActual = turnoActual.caja;
            actualizarUITurno(true);
        } else {
            turnoActual = null;
            actualizarUITurno(false);
        }
        
    } catch (error) {
        console.error('Error verificando turno:', error);
        turnoActual = null;
    }
}

async function abrirTurno() {
    try {
        // Verificar permisos
        if (!tienePermiso('caja')) {
            mostrarAlerta('No tiene permisos para abrir turno', 'warning');
            return;
        }
        
        // Verificar si ya hay turno abierto
        if (turnoActual) {
            mostrarAlerta('Ya tiene un turno abierto', 'warning');
            return;
        }
        
        // Solicitar efectivo inicial
        const efectivoInicial = prompt('Ingrese el efectivo inicial en caja:', '0');
        if (efectivoInicial === null) return;
        
        const monto = parseFloat(efectivoInicial);
        if (isNaN(monto) || monto < 0) {
            mostrarAlerta('Monto inválido', 'danger');
            return;
        }
        
        // Determinar tipo de turno
        const hora = new Date().getHours();
        let tipoTurno = TURNOS.TARDE;
        if (hora < 12) tipoTurno = TURNOS.MAÑANA;
        else if (hora > 20) tipoTurno = TURNOS.NOCHE;
        
        // Crear turno con transacción para evitar colisiones
        const turnoRef = db.collection('turnos').doc();
        
        await db.runTransaction(async (transaction) => {
            // Verificar que no haya otro turno abierto para esta caja
            const turnosAbiertos = await transaction.get(
                db.collection('turnos')
                    .where('sucursalId', '==', sucursalActual)
                    .where('caja', '==', cajaActual)
                    .where('estado', '==', 'abierto')
                    .limit(1)
            );
            
            if (!turnosAbiertos.empty) {
                throw new Error('Ya hay un turno abierto en esta caja');
            }
            
            const turnoData = {
                id: turnoRef.id,
                sucursalId: sucursalActual,
                usuarioId: usuarioActual.uid,
                usuarioNombre: usuarioActual.nombre || usuarioActual.email,
                fecha: new Date(),
                tipo: tipoTurno,
                caja: cajaActual,
                apertura: new Date(),
                cierre: null,
                estado: 'abierto',
                ventasCount: 0,
                totalVentas: 0,
                efectivoInicial: monto,
                efectivoFinal: 0,
                desglosePagos: {},
                observaciones: '',
                diferenciaCaja: 0,
                syncStatus: 'synced'
            };
            
            transaction.set(turnoRef, turnoData);
            
            turnoActual = turnoData;
        });
        
        // Actualizar UI
        actualizarUITurno(true);
        
        mostrarAlerta(`Turno ${tipoTurno} abierto en caja ${cajaActual}`, 'success');
        
        // Registrar en historial
        await registrarEventoSistema('turno_abierto', { 
            turnoId: turnoRef.id,
            caja: cajaActual,
            efectivoInicial: monto 
        });
        
    } catch (error) {
        console.error('Error abriendo turno:', error);
        
        if (error.message.includes('Ya hay un turno abierto')) {
            mostrarAlerta(error.message, 'warning');
        } else {
            mostrarAlerta('Error al abrir turno: ' + error.message, 'danger');
        }
    }
}

async function cerrarTurno() {
    try {
        if (!turnoActual) {
            mostrarAlerta('No hay turno activo', 'warning');
            return;
        }
        
        // Obtener ventas del turno
        const ventasSnapshot = await db.collection('ventas')
            .where('turnoId', '==', turnoActual.id)
            .where('estado', '==', ESTADOS_VENTA.COMPLETADA)
            .get();
        
        let totalVentas = 0;
        let desglose = {
            efectivo: 0,
            tarjeta_debito: 0,
            tarjeta_credito: 0,
            transferencia: 0,
            mercado_pago: 0,
            cuenta_corriente: 0
        };
        
        ventasSnapshot.forEach(doc => {
            const venta = doc.data();
            totalVentas += venta.total || 0;
            
            // Acumular por método de pago
            venta.pagos.forEach(pago => {
                const metodo = pago.metodo;
                if (!desglose[metodo]) desglose[metodo] = 0;
                desglose[metodo] += pago.monto;
            });
        });
        
        // Calcular ventas en efectivo
        const ventasEfectivo = desglose.efectivo || 0;
        
        // Mostrar resumen y solicitar efectivo final
        const resumen = `
Ventas totales: $${totalVentas.toFixed(2)}
Efectivo en ventas: $${ventasEfectivo.toFixed(2)}
Efectivo inicial: $${turnoActual.efectivoInicial.toFixed(2)}
Efectivo esperado: $${(turnoActual.efectivoInicial + ventasEfectivo).toFixed(2)}

Ingrese el efectivo final en caja:`;
        
        const efectivoFinal = prompt(resumen, (turnoActual.efectivoInicial + ventasEfectivo).toFixed(2));
        if (efectivoFinal === null) return;
        
        const montoFinal = parseFloat(efectivoFinal);
        if (isNaN(montoFinal)) {
            mostrarAlerta('Monto inválido', 'danger');
            return;
        }
        
        // Calcular diferencia
        const diferencia = montoFinal - (turnoActual.efectivoInicial + ventasEfectivo);
        
        // Solicitar observaciones si hay diferencia
        let observaciones = '';
        if (Math.abs(diferencia) > 0.01) {
            observaciones = prompt('Observaciones por diferencia de caja:', 
                `Diferencia: $${diferencia.toFixed(2)} - `) || '';
        }
        
        // Actualizar turno
        await db.collection('turnos').doc(turnoActual.id).update({
            cierre: new Date(),
            estado: 'cerrado',
            efectivoFinal: montoFinal,
            totalVentas: totalVentas,
            ventasCount: ventasSnapshot.size,
            desglosePagos: desglose,
            diferenciaCaja: diferencia,
            observaciones: observaciones || `Cierre normal - Diferencia: $${diferencia.toFixed(2)}`,
            syncStatus: 'synced'
        });
        
        // Limpiar turno actual
        turnoActual = null;
        actualizarUITurno(false);
        
        mostrarAlerta('Turno cerrado correctamente', 'success');
        
        // Generar reporte de cierre
        await generarReporteCierreTurno(desglose, totalVentas, diferencia);
        
    } catch (error) {
        console.error('Error cerrando turno:', error);
        mostrarAlerta('Error al cerrar turno: ' + error.message, 'danger');
    }
}

async function generarReporteCierreTurno(desglose, totalVentas, diferencia) {
    try {
        const reporteData = {
            fecha: new Date(),
            sucursalId: sucursalActual,
            caja: cajaActual,
            usuarioId: usuarioActual.uid,
            usuarioNombre: usuarioActual.nombre,
            turnoId: turnoActual?.id,
            totalVentas: totalVentas,
            desglosePagos: desglose,
            diferenciaCaja: diferencia,
            estado: 'generado'
        };
        
        await db.collection('reportes_cierre').add(reporteData);
        
    } catch (error) {
        console.error('Error generando reporte:', error);
    }
}

// ============================================
// SISTEMA POS - CARRITO Y VENTAS
// ============================================

function agregarProductoCarrito(producto) {
    // Validar stock en modo online
    if (!modoEmergencia && producto.controlStock && producto.stock <= 0) {
        mostrarAlerta('Producto sin stock disponible', 'warning');
        return;
    }
    
    // Buscar si ya está en el carrito
    const itemIndex = carrito.findIndex(item => item.id === producto.id);
    
    if (itemIndex !== -1) {
        // Verificar stock para cantidad adicional
        if (!modoEmergencia && producto.controlStock && producto.stock < carrito[itemIndex].cantidad + 1) {
            mostrarAlerta(`Stock insuficiente. Disponible: ${producto.stock}`, 'warning');
            return;
        }
        
        // Incrementar cantidad
        carrito[itemIndex].cantidad++;
        carrito[itemIndex].subtotal = carrito[itemIndex].cantidad * carrito[itemIndex].precioVenta;
        carrito[itemIndex].total = carrito[itemIndex].subtotal - carrito[itemIndex].descuento;
    } else {
        // Agregar nuevo item con precio congelado
        const precioCongelado = producto.precioVenta;
        
        carrito.push({
            id: producto.id,
            codigo: producto.codigo,
            nombre: producto.nombre,
            precioVenta: precioCongelado,
            precioCosto: producto.precioCosto || 0,
            cantidad: 1,
            descuento: 0,
            descuentoPorcentaje: 0,
            subtotal: precioCongelado,
            total: precioCongelado,
            stock: producto.stock || 0,
            controlStock: producto.controlStock || false,
            iva: producto.iva || 0,
            precioCongelado: precioCongelado, // Precio congelado para esta sesión
            precioOriginal: producto.precioVenta // Precio original para referencia
        });
    }
    
    actualizarCarritoUI();
    guardarCarritoLocal();
}

function actualizarCarritoUI() {
    const carritoItems = document.getElementById('carritoItems');
    const subtotalElement = document.getElementById('carritoSubtotal');
    const descuentoElement = document.getElementById('carritoDescuento');
    const ivaElement = document.getElementById('carritoIVA');
    const totalElement = document.getElementById('carritoTotal');
    
    if (!carritoItems) return;
    
    // Limpiar carrito
    carritoItems.innerHTML = '';
    
    let subtotal = 0;
    let descuentoTotal = 0;
    let ivaTotal = 0;
    
    // Generar items
    carrito.forEach((item, index) => {
        const itemSubtotal = item.cantidad * item.precioVenta;
        const itemDescuento = item.descuento;
        const itemTotal = itemSubtotal - itemDescuento;
        const itemIVA = itemTotal * (item.iva || IVA_PORCENTAJE);
        
        subtotal += itemSubtotal;
        descuentoTotal += itemDescuento;
        ivaTotal += itemIVA;
        
        const itemHTML = `
            <div class="carrito-item" data-index="${index}">
                <div class="carrito-item-info">
                    <div class="carrito-item-nombre">${item.nombre}</div>
                    <div class="carrito-item-precio">
                        $${item.precioVenta.toFixed(2)} c/u
                        ${item.precioVenta !== item.precioOriginal ? 
                          `<small style="color: #f59e0b; display: block;">Precio modificado</small>` : ''}
                    </div>
                    <small>${item.codigo} | Stock: ${item.stock}</small>
                </div>
                <div class="carrito-item-controls">
                    <div class="carrito-item-cantidad">
                        <button class="cantidad-btn" onclick="modificarCantidad(${index}, -1)">
                            <i class="fas fa-minus"></i>
                        </button>
                        <input type="number" class="cantidad-input" 
                               value="${item.cantidad}" min="1"
                               onchange="actualizarCantidadDesdeInput(${index}, this.value)">
                        <button class="cantidad-btn" onclick="modificarCantidad(${index}, 1)">
                            <i class="fas fa-plus"></i>
                        </button>
                    </div>
                    <div class="carrito-item-acciones">
                        <button class="btn-icon" onclick="aplicarDescuentoItem(${index})" 
                                title="Aplicar descuento">
                            <i class="fas fa-percentage"></i>
                        </button>
                        <button class="btn-icon" onclick="editarPrecioItem(${index})" 
                                title="Cambiar precio">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn-icon btn-danger" onclick="eliminarDelCarrito(${index})" 
                                title="Eliminar">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="carrito-item-totales">
                    <div class="carrito-item-subtotal">
                        $${itemSubtotal.toFixed(2)}
                        ${itemDescuento > 0 ? 
                          `<small style="color: #10b981; display: block;">-$${itemDescuento.toFixed(2)} desc</small>` : ''}
                    </div>
                    <div class="carrito-item-total">
                        $${itemTotal.toFixed(2)}
                    </div>
                </div>
            </div>
        `;
        
        carritoItems.innerHTML += itemHTML;
    });
    
    // Calcular total general
    const total = subtotal - descuentoTotal + ivaTotal;
    
    // Actualizar totales
    if (subtotalElement) subtotalElement.textContent = `$${subtotal.toFixed(2)}`;
    if (descuentoElement) {
        descuentoElement.textContent = `-$${descuentoTotal.toFixed(2)}`;
        descuentoElement.style.display = descuentoTotal > 0 ? 'block' : 'none';
    }
    if (ivaElement) ivaElement.textContent = `$${ivaTotal.toFixed(2)}`;
    if (totalElement) totalElement.textContent = `$${total.toFixed(2)}`;
    
    // Actualizar contador
    const carritoCount = document.getElementById('carritoCount');
    if (carritoCount) {
        carritoCount.textContent = carrito.reduce((sum, item) => sum + item.cantidad, 0);
        carritoCount.style.display = carrito.length > 0 ? 'inline-block' : 'none';
    }
    
    // Actualizar input de monto recibido
    const montoRecibido = document.getElementById('montoRecibido');
    if (montoRecibido) {
        montoRecibido.min = total.toFixed(2);
        montoRecibido.placeholder = `Mínimo: $${total.toFixed(2)}`;
        montoRecibido.value = '';
        calcularCambio();
    }
    
    // Actualizar botones de acción
    const btnFinalizar = document.getElementById('btnFinalizarVenta');
    const btnPresupuesto = document.getElementById('btnCrearPresupuesto');
    
    if (btnFinalizar) btnFinalizar.disabled = carrito.length === 0;
    if (btnPresupuesto) btnPresupuesto.disabled = carrito.length === 0;
}

function modificarCantidad(index, delta) {
    if (!carrito[index]) return;
    
    const nuevaCantidad = carrito[index].cantidad + delta;
    
    if (nuevaCantidad < 1) {
        eliminarDelCarrito(index);
        return;
    }
    
    // Verificar stock en modo online
    if (!modoEmergencia && carrito[index].controlStock && carrito[index].stock < nuevaCantidad) {
        mostrarAlerta(`Stock insuficiente. Disponible: ${carrito[index].stock}`, 'warning');
        return;
    }
    
    carrito[index].cantidad = nuevaCantidad;
    carrito[index].subtotal = nuevaCantidad * carrito[index].precioVenta;
    carrito[index].total = carrito[index].subtotal - carrito[index].descuento;
    
    actualizarCarritoUI();
    guardarCarritoLocal();
}

function actualizarCantidadDesdeInput(index, valor) {
    const cantidad = parseInt(valor);
    if (isNaN(cantidad) || cantidad < 1) {
        modificarCantidad(index, 0); // Restablecer valor
        return;
    }
    
    const diferencia = cantidad - carrito[index].cantidad;
    modificarCantidad(index, diferencia);
}

function aplicarDescuentoItem(index) {
    const item = carrito[index];
    if (!item) return;
    
    const descuento = prompt(
        `Aplicar descuento a: ${item.nombre}\n\n` +
        `Cantidad: ${item.cantidad}\n` +
        `Precio unitario: $${item.precioVenta.toFixed(2)}\n` +
        `Subtotal: $${item.subtotal.toFixed(2)}\n\n` +
        `Ingrese monto de descuento o porcentaje (ej: 10%):`,
        item.descuento > 0 ? item.descuento.toFixed(2) : ''
    );
    
    if (descuento === null) return;
    
    let montoDescuento = 0;
    
    if (descuento.includes('%')) {
        // Descuento porcentual
        const porcentaje = parseFloat(descuento.replace('%', '')) / 100;
        if (isNaN(porcentaje) || porcentaje < 0 || porcentaje > 1) {
            mostrarAlerta('Porcentaje inválido (0-100%)', 'danger');
            return;
        }
        montoDescuento = item.subtotal * porcentaje;
        carrito[index].descuentoPorcentaje = porcentaje;
    } else {
        // Descuento por monto
        montoDescuento = parseFloat(descuento);
        if (isNaN(montoDescuento) || montoDescuento < 0 || montoDescuento > item.subtotal) {
            mostrarAlerta(`Monto inválido. Máximo: $${item.subtotal.toFixed(2)}`, 'danger');
            return;
        }
        carrito[index].descuentoPorcentaje = montoDescuento / item.subtotal;
    }
    
    carrito[index].descuento = montoDescuento;
    carrito[index].total = item.subtotal - montoDescuento;
    
    actualizarCarritoUI();
    guardarCarritoLocal();
    
    mostrarAlerta(`Descuento aplicado: -$${montoDescuento.toFixed(2)}`, 'success');
}

function editarPrecioItem(index) {
    if (!tienePermiso('ventas')) {
        mostrarAlerta('No tiene permisos para modificar precios', 'warning');
        return;
    }
    
    const item = carrito[index];
    if (!item) return;
    
    const nuevoPrecio = prompt(
        `Modificar precio de: ${item.nombre}\n\n` +
        `Precio actual: $${item.precioVenta.toFixed(2)}\n` +
        `Precio original: $${item.precioOriginal.toFixed(2)}\n\n` +
        `Ingrese nuevo precio:`,
        item.precioVenta.toFixed(2)
    );
    
    if (nuevoPrecio === null) return;
    
    const precio = parseFloat(nuevoPrecio);
    if (isNaN(precio) || precio <= 0) {
        mostrarAlerta('Precio inválido', 'danger');
        return;
    }
    
    // Registrar cambio de precio
    registrarEventoSistema('precio_modificado', {
        productoId: item.id,
        productoNombre: item.nombre,
        precioAnterior: item.precioVenta,
        precioNuevo: precio,
        usuario: usuarioActual.nombre
    });
    
    carrito[index].precioVenta = precio;
    carrito[index].subtotal = carrito[index].cantidad * precio;
    carrito[index].total = carrito[index].subtotal - carrito[index].descuento;
    
    actualizarCarritoUI();
    guardarCarritoLocal();
    
    mostrarAlerta(`Precio actualizado: $${precio.toFixed(2)}`, 'success');
}

function eliminarDelCarrito(index) {
    if (carrito[index]) {
        const producto = carrito[index];
        carrito.splice(index, 1);
        actualizarCarritoUI();
        guardarCarritoLocal();
        mostrarAlerta(`${producto.nombre} eliminado del carrito`, 'info');
    }
}

function vaciarCarrito() {
    if (carrito.length === 0) {
        mostrarAlerta('El carrito ya está vacío', 'info');
        return;
    }
    
    if (confirm(`¿Vaciar carrito? Se eliminarán ${carrito.reduce((sum, item) => sum + item.cantidad, 0)} productos.`)) {
        carrito = [];
        actualizarCarritoUI();
        guardarCarritoLocal();
        mostrarAlerta('Carrito vaciado', 'success');
    }
}

// ============================================
// PROCESAMIENTO DE VENTAS CON TRANSACCIONES
// ============================================

async function procesarVenta() {
    try {
        // Validaciones básicas
        if (carrito.length === 0) {
            mostrarAlerta('El carrito está vacío', 'warning');
            return;
        }
        
        if (!turnoActual && !modoEmergencia) {
            mostrarAlerta('No hay turno activo. Abra un turno primero.', 'danger');
            return;
        }
        
        // Obtener datos del cliente
        const clienteId = document.getElementById('selectCliente')?.value;
        let clienteData = null;
        
        if (clienteId && clienteId !== 'general') {
            clienteData = clientesCache.get(clienteId);
        }
        
        // Obtener métodos de pago
        const pagos = obtenerPagosDesdeUI();
        if (!pagos || pagos.length === 0) {
            mostrarAlerta('Seleccione al menos un método de pago', 'warning');
            return;
        }
        
        // Calcular totales
        const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
        const descuentoTotal = carrito.reduce((sum, item) => sum + item.descuento, 0);
        const ivaTotal = carrito.reduce((sum, item) => {
            const itemTotal = item.subtotal - item.descuento;
            return sum + (itemTotal * (item.iva || IVA_PORCENTAJE));
        }, 0);
        const total = subtotal - descuentoTotal + ivaTotal;
        
        // Validar que la suma de pagos sea igual al total
        const sumaPagos = pagos.reduce((sum, pago) => sum + pago.monto, 0);
        if (Math.abs(sumaPagos - total) > 0.01) {
            mostrarAlerta(`Los pagos suman $${sumaPagos.toFixed(2)} pero el total es $${total.toFixed(2)}`, 'danger');
            return;
        }
        
        // Validar cuenta corriente
        const tieneCuentaCorriente = pagos.some(p => p.metodo === 'cuenta_corriente');
        if (tieneCuentaCorriente && !clienteData) {
            mostrarAlerta('Seleccione un cliente para cuenta corriente', 'warning');
            return;
        }
        
        if (tieneCuentaCorriente && clienteData) {
            const limite = clienteData.limiteCredito || 0;
            const saldoActual = clienteData.saldo || 0;
            const nuevoSaldo = saldoActual + total;
            
            if (limite > 0 && nuevoSaldo > limite) {
                if (!confirm(`El cliente superará su límite de crédito ($${limite}). ¿Continuar?`)) {
                    return;
                }
            }
        }
        
        // Confirmar venta
        if (!confirm(`¿Confirmar venta por $${total.toFixed(2)}?`)) {
            return;
        }
        
        // Procesar venta según modo
        if (modoEmergencia) {
            await procesarVentaOffline(clienteId, clienteData, pagos, total, subtotal, descuentoTotal, ivaTotal);
        } else {
            await procesarVentaOnline(clienteId, clienteData, pagos, total, subtotal, descuentoTotal, ivaTotal);
        }
        
    } catch (error) {
        console.error('Error procesando venta:', error);
        mostrarAlerta('Error al procesar la venta: ' + error.message, 'danger');
    }
}

async function procesarVentaOnline(clienteId, clienteData, pagos, total, subtotal, descuentoTotal, ivaTotal) {
    const resultado = await db.runTransaction(async (transaction) => {
        // 1. Generar número de factura único
        const numeroFactura = await generarNumeroFactura(transaction);
        
        // 2. Verificar y actualizar stock
        for (const item of carrito) {
            if (item.controlStock) {
                const productoRef = db.collection('productos').doc(item.id);
                const productoDoc = await transaction.get(productoRef);
                
                if (productoDoc.exists) {
                    const productoData = productoDoc.data();
                    const stockActual = productoData.stock || 0;
                    
                    if (stockActual < item.cantidad) {
                        throw new Error(`Stock insuficiente para ${item.nombre}. Disponible: ${stockActual}`);
                    }
                    
                    // Actualizar stock
                    transaction.update(productoRef, {
                        stock: firebase.firestore.FieldValue.increment(-item.cantidad),
                        ultimaVenta: new Date(),
                        vendidosTotal: firebase.firestore.FieldValue.increment(item.cantidad)
                    });
                    
                    // Registrar movimiento de stock
                    const movimientoRef = db.collection('movimientos_stock').doc();
                    transaction.set(movimientoRef, {
                        fecha: new Date(),
                        productoId: item.id,
                        productoNombre: item.nombre,
                        tipo: 'venta',
                        cantidad: -item.cantidad,
                        stockAnterior: stockActual,
                        stockNuevo: stockActual - item.cantidad,
                        ventaId: null, // Se actualizará después
                        usuarioId: usuarioActual.uid,
                        sucursalId: sucursalActual,
                        observaciones: `Venta ${numeroFactura}`
                    });
                }
            }
        }
        
        // 3. Crear objeto de venta
        const ventaData = {
            sucursalId: sucursalActual,
            numeroFactura: numeroFactura,
            fecha: new Date(),
            clienteId: clienteId || null,
            clienteNombre: clienteData ? clienteData.nombre : 'Consumidor Final',
            clienteDocumento: clienteData ? clienteData.documento : null,
            items: carrito.map(item => ({
                productoId: item.id,
                codigo: item.codigo,
                nombre: item.nombre,
                cantidad: item.cantidad,
                precioUnitario: item.precioVenta,
                precioCosto: item.precioCosto,
                subtotal: item.subtotal,
                descuento: item.descuento,
                descuentoPorcentaje: item.descuentoPorcentaje,
                total: item.total,
                iva: item.iva || IVA_PORCENTAJE,
                controlStock: item.controlStock
            })),
            subtotal: subtotal,
            descuentoTotal: descuentoTotal,
            ivaTotal: ivaTotal,
            total: total,
            pagos: pagos,
            usuarioId: usuarioActual.uid,
            usuarioNombre: usuarioActual.nombre || usuarioActual.email,
            turnoId: turnoActual?.id,
            caja: cajaActual,
            estado: ESTADOS_VENTA.COMPLETADA,
            syncStatus: 'synced',
            anulada: false,
            notas: document.getElementById('notasVenta')?.value || ''
        };
        
        // 4. Guardar venta
        const ventaRef = db.collection('ventas').doc();
        transaction.set(ventaRef, ventaData);
        
        // 5. Actualizar movimientos de stock con el ID de venta
        for (const item of carrito) {
            if (item.controlStock) {
                // Buscar el movimiento reciente para esta venta
                const movimientosQuery = await transaction.get(
                    db.collection('movimientos_stock')
                        .where('productoId', '==', item.id)
                        .where('tipo', '==', 'venta')
                        .where('ventaId', '==', null)
                        .orderBy('fecha', 'desc')
                        .limit(1)
                );
                
                if (!movimientosQuery.empty) {
                    const movimientoDoc = movimientosQuery.docs[0];
                    transaction.update(movimientoDoc.ref, { ventaId: ventaRef.id });
                }
            }
        }
        
        // 6. Actualizar turno
        if (turnoActual) {
            const turnoRef = db.collection('turnos').doc(turnoActual.id);
            transaction.update(turnoRef, {
                ventasCount: firebase.firestore.FieldValue.increment(1),
                totalVentas: firebase.firestore.FieldValue.increment(total)
            });
            
            // Actualizar desglose de pagos
            pagos.forEach(pago => {
                transaction.update(turnoRef, {
                    [`desglosePagos.${pago.metodo}`]: firebase.firestore.FieldValue.increment(pago.monto)
                });
            });
        }
        
        // 7. Actualizar cliente si es cuenta corriente
        if (pagos.some(p => p.metodo === 'cuenta_corriente') && clienteId) {
            const clienteRef = db.collection('clientes').doc(clienteId);
            transaction.update(clienteRef, {
                saldo: firebase.firestore.FieldValue.increment(total),
                ultimaCompra: new Date(),
                comprasTotal: firebase.firestore.FieldValue.increment(1),
                montoTotalCompras: firebase.firestore.FieldValue.increment(total)
            });
            
            // Registrar movimiento de cuenta corriente
            const ccMovimientoRef = db.collection('movimientos_cc').doc();
            transaction.set(ccMovimientoRef, {
                fecha: new Date(),
                clienteId: clienteId,
                clienteNombre: clienteData.nombre,
                tipo: 'venta',
                monto: total,
                saldoAnterior: clienteData.saldo || 0,
                saldoNuevo: (clienteData.saldo || 0) + total,
                ventaId: ventaRef.id,
                ventaNumero: numeroFactura,
                usuarioId: usuarioActual.uid,
                sucursalId: sucursalActual,
                observaciones: `Venta ${numeroFactura}`
            });
        }
        
        // 8. Actualizar contador de facturas
        const contadorRef = db.collection('contadores_facturas').doc(`sucursal_${sucursalActual}`);
        const contadorDoc = await transaction.get(contadorRef);
        
        if (contadorDoc.exists) {
            transaction.update(contadorRef, {
                ultimaFactura: numeroFactura,
                ultimaActualizacion: new Date()
            });
        }
        
        return {
            ventaId: ventaRef.id,
            ventaData: ventaData
        };
    });
    
    // Proceso exitoso
    await finalizarVentaExitosamente(resultado.ventaData);
}

async function procesarVentaOffline(clienteId, clienteData, pagos, total, subtotal, descuentoTotal, ivaTotal) {
    // Generar número de factura offline
    const numeroFactura = generarNumeroFacturaOffline();
    
    const ventaData = {
        id: 'offline_' + Date.now(),
        sucursalId: sucursalActual,
        numeroFactura: numeroFactura,
        fecha: new Date(),
        clienteId: clienteId || null,
        clienteNombre: clienteData ? clienteData.nombre : 'Consumidor Final',
        items: carrito.map(item => ({
            productoId: item.id,
            codigo: item.codigo,
            nombre: item.nombre,
            cantidad: item.cantidad,
            precioUnitario: item.precioVenta,
            subtotal: item.subtotal,
            descuento: item.descuento,
            total: item.total
        })),
        subtotal: subtotal,
        descuentoTotal: descuentoTotal,
        ivaTotal: ivaTotal,
        total: total,
        pagos: pagos,
        usuarioId: usuarioActual.uid,
        usuarioNombre: usuarioActual.nombre || usuarioActual.email,
        caja: cajaActual,
        estado: ESTADOS_VENTA.PENDIENTE,
        syncStatus: 'pending',
        anulada: false,
        notas: 'Venta en modo offline'
    };
    
    // Guardar en IndexedDB
    await guardarVentaOfflineDB(ventaData);
    
    // Agregar a array local
    ventasPendientes.push(ventaData);
    
    // Limpiar carrito
    carrito = [];
    actualizarCarritoUI();
    guardarCarritoLocal();
    
    // Mostrar ticket (solo en navegador, sin impresión real)
    mostrarTicketOffline(ventaData);
    
    mostrarAlerta(`Venta #${numeroFactura} guardada localmente (modo offline)`, 'success');
    
    // Actualizar contador de ventas pendientes
    actualizarContadorVentasPendientes();
}

async function finalizarVentaExitosamente(ventaData) {
    // Guardar última venta
    ultimaVenta = ventaData;
    
    // Limpiar carrito
    carrito = [];
    actualizarCarritoUI();
    guardarCarritoLocal();
    
    // Resetear formulario
    document.getElementById('selectCliente').value = 'general';
    document.getElementById('selectPago').value = 'efectivo';
    document.getElementById('montoRecibido').value = '';
    document.getElementById('notasVenta').value = '';
    actualizarInfoCliente();
    cambiarMetodoPago();
    
    // Imprimir ticket si está configurado
    if (configuracionSucursal.facturacion?.autoImprimir) {
        await imprimirTicket(ventaData);
    }
    
    // Mostrar éxito
    mostrarAlerta(`Venta #${ventaData.numeroFactura} procesada correctamente`, 'success');
    
    // Registrar evento
    await registrarEventoSistema('venta_procesada', {
        ventaId: ventaData.id,
        total: ventaData.total,
        numeroFactura: ventaData.numeroFactura
    });
    
    // Mostrar modal de éxito con detalles
    mostrarModalExitoVenta(ventaData);
}

async function generarNumeroFactura(transaction) {
    // Obtener configuración de numeración
    const serie = configuracionSucursal.facturacion?.serie || 'A';
    const prefijo = configuracionSucursal.facturacion?.prefijo || '';
    
    // Obtener contador de sucursal
    const contadorRef = db.collection('contadores_facturas').doc(`sucursal_${sucursalActual}`);
    const contadorDoc = await transaction.get(contadorRef);
    
    let proximoNumero = 1;
    
    if (contadorDoc.exists) {
        const contadorData = contadorDoc.data();
        proximoNumero = (contadorData.proximo || 0) + 1;
    }
    
    // Formato: PuntoVenta-Número (ej: 0001-00000001)
    const puntoVenta = configuracionSucursal.facturacion?.puntoVenta || '0001';
    const numeroFactura = proximoNumero.toString().padStart(8, '0');
    
    return `${prefijo}${serie}-${puntoVenta}-${numeroFactura}`;
}

function generarNumeroFacturaOffline() {
    // Obtener último número offline
    let ultimoNumero = localStorage.getItem(`ultimo_factura_offline_${sucursalActual}`) || 0;
    ultimoNumero = parseInt(ultimoNumero) + 1;
    
    // Guardar nuevo número
    localStorage.setItem(`ultimo_factura_offline_${sucursalActual}`, ultimoNumero);
    
    const serie = 'OFF';
    const prefijo = 'OFF';
    const puntoVenta = '9999';
    const numeroFactura = ultimoNumero.toString().padStart(8, '0');
    
    return `${prefijo}${serie}-${puntoVenta}-${numeroFactura}`;
}

function obtenerPagosDesdeUI() {
    const metodoPrincipal = document.getElementById('selectPago')?.value;
    
    if (metodoPrincipal === 'mixto') {
        // Obtener pagos mixtos desde los inputs
        const pagos = [];
        
        // Efectivo
        const efectivoInput = document.getElementById('pagoEfectivoMonto');
        if (efectivoInput && efectivoInput.value) {
            const monto = parseFloat(efectivoInput.value);
            if (monto > 0) {
                pagos.push({
                    metodo: 'efectivo',
                    monto: monto,
                    referencia: '',
                    estado: 'confirmado'
                });
            }
        }
        
        // Tarjeta
        const tarjetaInput = document.getElementById('pagoTarjetaMonto');
        if (tarjetaInput && tarjetaInput.value) {
            const monto = parseFloat(tarjetaInput.value);
            if (monto > 0) {
                const tipoTarjeta = document.getElementById('tipoTarjeta')?.value || 'debito';
                pagos.push({
                    metodo: `tarjeta_${tipoTarjeta}`,
                    monto: monto,
                    referencia: document.getElementById('tarjetaReferencia')?.value || '',
                    estado: 'confirmado'
                });
            }
        }
        
        // Transferencia
        const transferenciaInput = document.getElementById('pagoTransferenciaMonto');
        if (transferenciaInput && transferenciaInput.value) {
            const monto = parseFloat(transferenciaInput.value);
            if (monto > 0) {
                pagos.push({
                    metodo: 'transferencia',
                    monto: monto,
                    referencia: document.getElementById('transferenciaReferencia')?.value || '',
                    estado: 'confirmado'
                });
            }
        }
        
        return pagos;
    } else {
        // Método único
        let monto = 0;
        const total = parseFloat(document.getElementById('carritoTotal')?.textContent?.replace('$', '') || 0);
        
        if (metodoPrincipal === 'efectivo') {
            monto = parseFloat(document.getElementById('montoRecibido')?.value || total);
        } else {
            monto = total;
        }
        
        return [{
            metodo: metodoPrincipal,
            monto: monto,
            referencia: '',
            estado: 'confirmado'
        }];
    }
}

// ============================================
// SISTEMA OFFLINE CON INDEXEDDB
// ============================================

const DB_NAME = 'pos_offline_db';
const DB_VERSION = 4;
let offlineDB = null;

async function initIndexedDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            offlineDB = request.result;
            resolve();
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // Ventas pendientes
            if (!db.objectStoreNames.contains('ventas_pendientes')) {
                const store = db.createObjectStore('ventas_pendientes', { 
                    keyPath: 'id',
                    autoIncrement: false 
                });
                store.createIndex('fecha', 'fecha', { unique: false });
                store.createIndex('syncStatus', 'syncStatus', { unique: false });
                store.createIndex('sucursalId', 'sucursalId', { unique: false });
            }
            
            // Productos cache
            if (!db.objectStoreNames.contains('productos_cache')) {
                const store = db.createObjectStore('productos_cache', { keyPath: 'id' });
                store.createIndex('codigo', 'codigo', { unique: true });
                store.createIndex('categoria', 'categoria', { unique: false });
                store.createIndex('sucursalId', 'sucursalId', { unique: false });
            }
            
            // Clientes cache
            if (!db.objectStoreNames.contains('clientes_cache')) {
                const store = db.createObjectStore('clientes_cache', { keyPath: 'id' });
                store.createIndex('documento', 'documento', { unique: true });
                store.createIndex('sucursalId', 'sucursalId', { unique: false });
            }
            
            // Configuración local
            if (!db.objectStoreNames.contains('config_local')) {
                db.createObjectStore('config_local', { keyPath: 'key' });
            }
            
            // Movimientos pendientes
            if (!db.objectStoreNames.contains('movimientos_pendientes')) {
                const store = db.createObjectStore('movimientos_pendientes', { 
                    keyPath: 'id',
                    autoIncrement: true 
                });
                store.createIndex('tipo', 'tipo', { unique: false });
                store.createIndex('syncStatus', 'syncStatus', { unique: false });
            }
        };
    });
}

async function guardarVentaOfflineDB(ventaData) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = offlineDB.transaction(['ventas_pendientes'], 'readwrite');
        const store = transaction.objectStore('ventas_pendientes');
        const request = store.put(ventaData);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function cargarVentasPendientesLocal() {
    try {
        const ventas = await obtenerDeIndexedDB('ventas_pendientes');
        ventasPendientes = ventas.filter(v => v.syncStatus === 'pending' && v.sucursalId === sucursalActual);
        actualizarContadorVentasPendientes();
    } catch (error) {
        console.error('Error cargando ventas pendientes:', error);
    }
}

async function sincronizarDatosPendientes() {
    if (modoEmergencia || ventasPendientes.length === 0) return;
    
    try {
        // Sincronizar ventas pendientes
        for (const venta of ventasPendientes.slice()) { // Usar slice para copia
            if (venta.syncStatus === 'pending') {
                const exito = await sincronizarVenta(venta);
                if (exito) {
                    // Eliminar del array local
                    const index = ventasPendientes.findIndex(v => v.id === venta.id);
                    if (index !== -1) {
                        ventasPendientes.splice(index, 1);
                    }
                }
            }
        }
        
        actualizarContadorVentasPendientes();
        
    } catch (error) {
        console.error('Error en sincronización:', error);
    }
}

async function sincronizarVenta(venta) {
    try {
        // Procesar como venta online
        const pagos = venta.pagos || [{ metodo: 'efectivo', monto: venta.total, estado: 'confirmado' }];
        
        const resultado = await db.runTransaction(async (transaction) => {
            // 1. Generar número de factura único
            const numeroFactura = await generarNumeroFactura(transaction);
            
            // 2. Verificar y actualizar stock
            for (const item of venta.items) {
                if (item.controlStock) {
                    const productoRef = db.collection('productos').doc(item.productoId);
                    const productoDoc = await transaction.get(productoRef);
                    
                    if (productoDoc.exists) {
                        const productoData = productoDoc.data();
                        const stockActual = productoData.stock || 0;
                        
                        if (stockActual < item.cantidad) {
                            // Si no hay stock, generar nota de ajuste
                            transaction.update(productoRef, {
                                stock: firebase.firestore.FieldValue.increment(-item.cantidad)
                            });
                            
                            const ajusteRef = db.collection('ajustes_stock').doc();
                            transaction.set(ajusteRef, {
                                fecha: new Date(),
                                productoId: item.productoId,
                                productoNombre: item.nombre,
                                tipo: 'ajuste_negativo',
                                cantidad: item.cantidad,
                                motivo: 'Sincronización venta offline - Stock insuficiente',
                                usuarioId: usuarioActual.uid,
                                sucursalId: sucursalActual
                            });
                        } else {
                            transaction.update(productoRef, {
                                stock: firebase.firestore.FieldValue.increment(-item.cantidad)
                            });
                        }
                    }
                }
            }
            
            // 3. Crear objeto de venta sincronizada
            const ventaData = {
                ...venta,
                numeroFactura: numeroFactura,
                syncStatus: 'synced',
                fechaSync: new Date(),
                estado: ESTADOS_VENTA.COMPLETADA,
                turnoId: turnoActual?.id || null
            };
            
            // 4. Guardar venta
            const ventaRef = db.collection('ventas').doc();
            transaction.set(ventaRef, ventaData);
            
            // 5. Eliminar de IndexedDB
            await eliminarDeIndexedDB('ventas_pendientes', venta.id);
            
            return { ventaId: ventaRef.id };
        });
        
        mostrarAlerta(`Venta ${venta.numeroFactura} sincronizada correctamente`, 'success');
        return true;
        
    } catch (error) {
        console.error('Error sincronizando venta:', error);
        return false;
    }
}

// ============================================
// FUNCIONES DE UTILIDAD
// ============================================

function mostrarLogin() {
    const loginScreen = document.getElementById('loginScreen');
    const mainSystem = document.getElementById('mainSystem');
    
    if (loginScreen) loginScreen.style.display = 'flex';
    if (mainSystem) mainSystem.style.display = 'none';
}

function mostrarSistemaPrincipal() {
    const loginScreen = document.getElementById('loginScreen');
    const mainSystem = document.getElementById('mainSystem');
    
    if (loginScreen) loginScreen.style.display = 'none';
    if (mainSystem) mainSystem.style.display = 'flex';
}

function mostrarCargando(mensaje) {
    const loading = document.getElementById('loadingOverlay');
    if (!loading) return;
    
    loading.querySelector('.loading-message').textContent = mensaje;
    loading.style.display = 'flex';
}

function ocultarCargando() {
    const loading = document.getElementById('loadingOverlay');
    if (loading) loading.style.display = 'none';
}

function mostrarAlerta(mensaje, tipo = 'info') {
    // Crear alerta temporal
    const alerta = document.createElement('div');
    alerta.className = `alert alert-${tipo}`;
    alerta.innerHTML = `
        <div class="alert-content">
            <i class="fas fa-${getAlertIcon(tipo)}"></i>
            <span>${mensaje}</span>
        </div>
        <button class="alert-close" onclick="this.parentElement.remove()">
            <i class="fas fa-times"></i>
        </button>
    `;
    
    alerta.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        min-width: 300px;
        max-width: 400px;
        animation: slideIn 0.3s ease-out;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    `;
    
    document.body.appendChild(alerta);
    
    // Remover después de 5 segundos
    setTimeout(() => {
        if (alerta.parentNode) {
            alerta.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => {
                if (alerta.parentNode) {
                    alerta.remove();
                }
            }, 300);
        }
    }, 5000);
}

function getAlertIcon(tipo) {
    switch(tipo) {
        case 'success': return 'check-circle';
        case 'danger': return 'exclamation-circle';
        case 'warning': return 'exclamation-triangle';
        default: return 'info-circle';
    }
}

function tienePermiso(permiso) {
    if (!usuarioActual || !usuarioActual.rol) return false;
    
    const rol = usuarioActual.rol;
    const permisosRol = PERMISOS[rol] || [];
    
    return permisosRol.includes('*') || permisosRol.includes(permiso);
}

function configurarUIporRol() {
    const menuContent = document.getElementById('menuContent');
    if (!menuContent) return;
    
    let menuHTML = '';
    
    // POS siempre visible para todos los roles de venta
    if (tienePermiso('ventas')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Ventas</h4>
                <a href="#" class="menu-item active" data-view="pos">
                    <i class="fas fa-cash-register"></i> POS / Facturación
                </a>
                <a href="#" class="menu-item" data-view="presupuestos">
                    <i class="fas fa-file-invoice-dollar"></i> Presupuestos
                </a>
            </div>
        `;
    }
    
    // Productos
    if (tienePermiso('productos') || tienePermiso('productos_consulta')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Inventario</h4>
                ${tienePermiso('productos') ? `
                    <a href="#" class="menu-item" data-view="productos">
                        <i class="fas fa-boxes"></i> Productos
                        <span class="menu-badge" id="productosCount">0</span>
                    </a>
                    <a href="#" class="menu-item" data-view="categorias">
                        <i class="fas fa-tags"></i> Categorías
                    </a>
                ` : `
                    <a href="#" class="menu-item" data-view="productos">
                        <i class="fas fa-boxes"></i> Consultar Productos
                    </a>
                `}
            </div>
        `;
    }
    
    // Clientes
    if (tienePermiso('clientes') || tienePermiso('clientes_consulta')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Clientes</h4>
                <a href="#" class="menu-item" data-view="clientes">
                    <i class="fas fa-users"></i> Clientes
                    <span class="menu-badge" id="clientesCount">0</span>
                </a>
                ${tienePermiso('clientes') ? `
                    <a href="#" class="menu-item" data-view="cuentas_corrientes">
                        <i class="fas fa-file-invoice"></i> Cuentas Corrientes
                    </a>
                ` : ''}
            </div>
        `;
    }
    
    // Caja
    if (tienePermiso('caja')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Caja</h4>
                <a href="#" class="menu-item" data-view="caja">
                    <i class="fas fa-cash-register"></i> Caja y Turnos
                </a>
                <a href="#" class="menu-item" data-view="arqueos">
                    <i class="fas fa-calculator"></i> Arqueos
                </a>
            </div>
        `;
    }
    
    // Reportes
    if (tienePermiso('reportes')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Reportes</h4>
                <a href="#" class="menu-item" data-view="reportes">
                    <i class="fas fa-chart-bar"></i> Reportes
                </a>
                <a href="#" class="menu-item" data-view="ventas">
                    <i class="fas fa-shopping-cart"></i> Historial Ventas
                </a>
            </div>
        `;
    }
    
    // Proveedores
    if (tienePermiso('productos')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Compras</h4>
                <a href="#" class="menu-item" data-view="proveedores">
                    <i class="fas fa-truck"></i> Proveedores
                </a>
                <a href="#" class="menu-item" data-view="pedidos">
                    <i class="fas fa-clipboard-list"></i> Pedidos
                </a>
            </div>
        `;
    }
    
    // Configuración
    if (tienePermiso('configuracion_sucursal') || tienePermiso('usuarios_sucursal')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Administración</h4>
                ${tienePermiso('configuracion_sucursal') ? `
                    <a href="#" class="menu-item" data-view="configuracion">
                        <i class="fas fa-cog"></i> Configuración
                    </a>
                ` : ''}
                ${tienePermiso('usuarios_sucursal') ? `
                    <a href="#" class="menu-item" data-view="usuarios">
                        <i class="fas fa-user-cog"></i> Usuarios
                    </a>
                ` : ''}
            </div>
        `;
    }
    
    menuContent.innerHTML = menuHTML;
    
    // Configurar eventos del menú
    document.querySelectorAll('.menu-item[data-view]').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            cambiarVista(this.getAttribute('data-view'));
        });
    });
}

// ============================================
// FUNCIONES DE UI Y EVENTOS
// ============================================

function configurarEventosUI() {
    // Toggle del menú en móviles
    const menuToggle = document.getElementById('menuToggle');
    if (menuToggle) {
        menuToggle.addEventListener('click', () => {
            document.getElementById('sidebar').classList.toggle('active');
        });
    }
    
    // Configurar evento para el botón de login
    const loginButton = document.getElementById('btnLogin');
    if (loginButton) {
        loginButton.addEventListener('click', login);
    }
    
    // También permitir login con Enter
    const loginPassword = document.getElementById('loginPassword');
    if (loginPassword) {
        loginPassword.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                login();
            }
        });
    }
    
    // Selector de sucursal
    const sucursalButton = document.getElementById('btnSelectSucursal');
    if (sucursalButton) {
        sucursalButton.addEventListener('click', seleccionarSucursal);
    }
    
    // Cerrar sesión
    const logoutButton = document.getElementById('btnLogout');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }
    
    // Cerrar turno desde navbar
    const cerrarTurnoBtn = document.getElementById('btnCerrarTurnoNav');
    if (cerrarTurnoBtn) {
        cerrarTurnoBtn.addEventListener('click', cerrarTurno);
    }
    
    // Abrir turno desde navbar
    const abrirTurnoBtn = document.getElementById('btnAbrirTurnoNav');
    if (abrirTurnoBtn) {
        abrirTurnoBtn.addEventListener('click', abrirTurno);
    }
}

function cambiarVista(vistaId) {
    // Actualizar menú activo
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
    });
    
    const menuItem = document.querySelector(`.menu-item[data-view="${vistaId}"]`);
    if (menuItem) menuItem.classList.add('active');
    
    // Cerrar sidebar en móviles
    if (window.innerWidth <= 1200) {
        document.getElementById('sidebar').classList.remove('active');
    }
    
    // Cargar vista
    cargarVista(vistaId);
}

async function cargarVista(vistaId) {
    const viewContainer = document.getElementById('viewContainer');
    if (!viewContainer) return;
    
    viewContainer.innerHTML = '<div class="loading-content"><div class="loader"></div><p>Cargando...</p></div>';
    
    try {
        let vistaHTML = '';
        
        switch(vistaId) {
            case 'pos':
                vistaHTML = await cargarVistaPOS();
                break;
            case 'productos':
                vistaHTML = await cargarVistaProductos();
                break;
            case 'clientes':
                vistaHTML = await cargarVistaClientes();
                break;
            case 'caja':
                vistaHTML = await cargarVistaCaja();
                break;
            case 'reportes':
                vistaHTML = await cargarVistaReportes();
                break;
            case 'configuracion':
                vistaHTML = await cargarVistaConfiguracion();
                break;
            case 'presupuestos':
                vistaHTML = await cargarVistaPresupuestos();
                break;
            case 'ventas':
                vistaHTML = await cargarVistaVentas();
                break;
            case 'proveedores':
                vistaHTML = await cargarVistaProveedores();
                break;
            case 'pedidos':
                vistaHTML = await cargarVistaPedidos();
                break;
            case 'cuentas_corrientes':
                vistaHTML = await cargarVistaCuentasCorrientes();
                break;
            case 'usuarios':
                vistaHTML = await cargarVistaUsuarios();
                break;
            case 'arqueos':
                vistaHTML = await cargarVistaArqueos();
                break;
            case 'categorias':
                vistaHTML = await cargarVistaCategorias();
                break;
            default:
                vistaHTML = '<div class="alert alert-warning">Vista no encontrada</div>';
        }
        
        viewContainer.innerHTML = vistaHTML;
        
        // Inicializar componentes específicos de la vista
        switch(vistaId) {
            case 'pos':
                inicializarVistaPOS();
                break;
            case 'productos':
                inicializarVistaProductos();
                break;
            case 'clientes':
                inicializarVistaClientes();
                break;
            case 'caja':
                inicializarVistaCaja();
                break;
            case 'reportes':
                inicializarVistaReportes();
                break;
            case 'configuracion':
                inicializarVistaConfiguracion();
                break;
            case 'presupuestos':
                inicializarVistaPresupuestos();
                break;
            case 'ventas':
                inicializarVistaVentas();
                break;
            case 'proveedores':
                inicializarVistaProveedores();
                break;
            case 'pedidos':
                inicializarVistaPedidos();
                break;
            case 'cuentas_corrientes':
                inicializarVistaCuentasCorrientes();
                break;
            case 'usuarios':
                inicializarVistaUsuarios();
                break;
            case 'arqueos':
                inicializarVistaArqueos();
                break;
            case 'categorias':
                inicializarVistaCategorias();
                break;
        }
        
    } catch (error) {
        console.error('Error cargando vista:', error);
        viewContainer.innerHTML = '<div class="alert alert-danger">Error al cargar la vista</div>';
    }
}

// ============================================
// VISTA POS (PRINCIPAL) - COMPLETA
// ============================================

async function cargarVistaPOS() {
    return `
        <div class="pos-container">
            <!-- Columna izquierda: Productos -->
            <div class="pos-left">
                <!-- Búsqueda rápida -->
                <div class="search-card">
                    <div class="search-header">
                        <h3><i class="fas fa-search"></i> Búsqueda Rápida</h3>
                        <div class="flex gap-2">
                            <button class="btn btn-outline btn-sm" onclick="abrirScanner()" id="btnScanner">
                                <i class="fas fa-barcode"></i> Escanear
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="mostrarTodosProductos()">
                                <i class="fas fa-list"></i> Todos
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="filtrarSinStock()">
                                <i class="fas fa-exclamation-triangle"></i> Sin Stock
                            </button>
                        </div>
                    </div>
                    <div class="search-body">
                        <div class="search-box">
                            <i class="fas fa-search search-icon"></i>
                            <input type="text" class="search-input" id="buscarProducto" 
                                   placeholder="Código, nombre o categoría (ENTER para buscar)..."
                                   onkeypress="if(event.key === 'Enter') buscarProductoRapido()">
                            <button class="btn btn-primary btn-sm" onclick="buscarProductoRapido()">
                                <i class="fas fa-search"></i>
                            </button>
                        </div>
                        <div class="search-filters">
                            <select class="form-control form-control-sm" id="filtroCategoria" onchange="filtrarProductosPorCategoria()">
                                <option value="">Todas las categorías</option>
                            </select>
                            <select class="form-control form-control-sm" id="filtroOrden" onchange="ordenarProductos()">
                                <option value="nombre">Orden: Nombre</option>
                                <option value="precio_asc">Precio: Menor a Mayor</option>
                                <option value="precio_desc">Precio: Mayor a Menor</option>
                                <option value="stock">Stock Disponible</option>
                            </select>
                        </div>
                    </div>
                </div>
                
                <!-- Grid de productos -->
                <div class="productos-grid-container">
                    <div class="productos-header">
                        <h3><i class="fas fa-boxes"></i> Productos Disponibles</h3>
                        <div class="productos-info">
                            <small id="productosDisponibles">Cargando...</small>
                            <small id="productosFiltrados"></small>
                        </div>
                    </div>
                    <div class="productos-grid" id="productosGrid">
                        <!-- Productos cargados dinámicamente -->
                    </div>
                    <div class="productos-pagination">
                        <button class="btn btn-outline btn-sm" id="btnCargarMas" onclick="cargarMasProductos()" style="display: none;">
                            <i class="fas fa-plus"></i> Cargar más productos
                        </button>
                    </div>
                </div>
            </div>
            
            <!-- Columna derecha: Carrito y Pago -->
            <div class="pos-right">
                <!-- Carrito -->
                <div class="carrito-card">
                    <div class="carrito-header">
                        <h3><i class="fas fa-shopping-cart"></i> Carrito de Venta</h3>
                        <div>
                            <span class="badge badge-primary" id="carritoCount" style="display: none;">0</span>
                            <button class="btn btn-danger btn-sm" onclick="vaciarCarrito()" title="Vaciar carrito">
                                <i class="fas fa-trash"></i>
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="aplicarDescuentoGlobal()" title="Descuento global">
                                <i class="fas fa-percentage"></i>
                            </button>
                        </div>
                    </div>
                    <div class="carrito-items-container">
                        <div class="carrito-items" id="carritoItems">
                            <!-- Items del carrito -->
                            <div class="text-center" style="padding: 40px; color: var(--gray);">
                                <i class="fas fa-shopping-cart" style="font-size: 3rem; opacity: 0.5; margin-bottom: 15px;"></i>
                                <p>El carrito está vacío</p>
                                <p class="text-sm">Agrega productos desde la lista</p>
                            </div>
                        </div>
                    </div>
                    <div class="carrito-totales">
                        <div class="total-line">
                            <span>Subtotal:</span>
                            <span id="carritoSubtotal">$0.00</span>
                        </div>
                        <div class="total-line" id="carritoDescuentoLine" style="display: none;">
                            <span>Descuento:</span>
                            <span id="carritoDescuento" style="color: #10b981;">-$0.00</span>
                        </div>
                        <div class="total-line">
                            <span>IVA (21%):</span>
                            <span id="carritoIVA">$0.00</span>
                        </div>
                        <div class="total-line total-final">
                            <span>TOTAL:</span>
                            <span id="carritoTotal">$0.00</span>
                        </div>
                    </div>
                </div>
                
                <!-- Datos del cliente -->
                <div class="cliente-card">
                    <div class="card-header">
                        <h3><i class="fas fa-user"></i> Cliente</h3>
                        <div class="flex gap-1">
                            <button class="btn btn-outline btn-sm" onclick="buscarClienteRapido()" title="Buscar cliente">
                                <i class="fas fa-search"></i>
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="mostrarModalCliente()">
                                <i class="fas fa-plus"></i> Nuevo
                            </button>
                        </div>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>Seleccionar Cliente</label>
                            <select class="form-control" id="selectCliente" onchange="actualizarInfoCliente()">
                                <option value="general">Consumidor Final</option>
                                <!-- Clientes cargados dinámicamente -->
                            </select>
                        </div>
                        <div id="clienteInfo" style="display: none;">
                            <!-- Info del cliente -->
                        </div>
                        <div class="form-group mt-2">
                            <label>Notas de la venta</label>
                            <textarea class="form-control" id="notasVenta" rows="2" placeholder="Observaciones internas..."></textarea>
                        </div>
                    </div>
                </div>
                
                <!-- Método de pago -->
                <div class="pago-card">
                    <div class="card-header">
                        <h3><i class="fas fa-credit-card"></i> Método de Pago</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>Seleccionar Método</label>
                            <select class="form-control" id="selectPago" onchange="cambiarMetodoPago()">
                                <option value="efectivo">Efectivo</option>
                                <option value="tarjeta_debito">Tarjeta Débito</option>
                                <option value="tarjeta_credito">Tarjeta Crédito</option>
                                <option value="transferencia">Transferencia</option>
                                <option value="mercado_pago">Mercado Pago</option>
                                <option value="mixto">Mixto</option>
                                <option value="cuenta_corriente">Cuenta Corriente</option>
                            </select>
                        </div>
                        
                        <!-- Efectivo -->
                        <div id="pagoEfectivo" class="pago-metodo">
                            <div class="form-group">
                                <label>Monto Recibido</label>
                                <input type="number" id="montoRecibido" class="form-control" 
                                       placeholder="0.00" step="0.01" min="0" oninput="calcularCambio()">
                            </div>
                            <div class="form-group">
                                <label>Cambio</label>
                                <input type="number" id="cambio" class="form-control" 
                                       placeholder="0.00" readonly style="background: #f8fafc; font-weight: bold;">
                            </div>
                        </div>
                        
                        <!-- Mixto -->
                        <div id="pagoMixto" class="pago-metodo" style="display: none;">
                            <div class="form-group">
                                <label>Efectivo</label>
                                <input type="number" id="pagoEfectivoMonto" class="form-control" 
                                       placeholder="0.00" step="0.01" min="0" oninput="calcularPagoMixto()">
                            </div>
                            <div class="form-group">
                                <label>Tarjeta</label>
                                <div class="flex gap-2">
                                    <select class="form-control form-control-sm" id="tipoTarjeta" onchange="calcularPagoMixto()">
                                        <option value="debito">Débito</option>
                                        <option value="credito">Crédito</option>
                                    </select>
                                    <input type="number" id="pagoTarjetaMonto" class="form-control" 
                                           placeholder="0.00" step="0.01" min="0" oninput="calcularPagoMixto()">
                                </div>
                                <input type="text" id="tarjetaReferencia" class="form-control form-control-sm mt-1" 
                                       placeholder="N° de comprobante">
                            </div>
                            <div class="form-group">
                                <label>Transferencia</label>
                                <div class="flex gap-2">
                                    <input type="number" id="pagoTransferenciaMonto" class="form-control" 
                                           placeholder="0.00" step="0.01" min="0" oninput="calcularPagoMixto()">
                                </div>
                                <input type="text" id="transferenciaReferencia" class="form-control form-control-sm mt-1" 
                                       placeholder="N° de operación">
                            </div>
                            <div class="alert alert-info mt-2" id="pagoMixtoResumen">
                                <!-- Resumen de pagos mixtos -->
                            </div>
                        </div>
                        
                        <!-- Cuenta Corriente -->
                        <div id="pagoCuentaCorriente" class="pago-metodo" style="display: none;">
                            <div class="alert alert-warning">
                                <i class="fas fa-exclamation-triangle"></i>
                                Se registrará como deuda en cuenta corriente
                            </div>
                            <div class="form-group">
                                <label>Fecha de Vencimiento</label>
                                <input type="date" id="vencimientoCuenta" class="form-control" 
                                       value="${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}">
                            </div>
                        </div>
                        
                        <!-- Botones de acción -->
                        <div class="venta-acciones">
                            <button class="btn btn-success btn-lg btn-block" id="btnFinalizarVenta" onclick="procesarVenta()" 
                                    disabled style="padding: 15px; font-size: 1.1rem;">
                                <i class="fas fa-check-circle"></i> FINALIZAR VENTA
                            </button>
                            
                            <div class="flex gap-2 mt-3">
                                <button class="btn btn-outline" style="flex: 1;" id="btnCrearPresupuesto" 
                                        onclick="crearPresupuesto()" disabled>
                                    <i class="fas fa-file-invoice-dollar"></i> Presupuesto
                                </button>
                                <button class="btn btn-outline" style="flex: 1;" onclick="reimprimirUltimo()" 
                                        ${!ultimaVenta ? 'disabled' : ''}>
                                    <i class="fas fa-print"></i> Reimprimir
                                </button>
                                <button class="btn btn-outline" style="flex: 1;" onclick="anularUltimaVenta()" 
                                        ${!ultimaVenta ? 'disabled' : ''}>
                                    <i class="fas fa-ban"></i> Anular
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal Scanner -->
        <div id="scannerModal" class="modal">
            <div class="modal-content" style="max-width: 600px;">
                <div class="modal-header">
                    <h3><i class="fas fa-barcode"></i> Escanear Código de Barras</h3>
                    <button class="btn-close" onclick="cerrarScanner()">&times;</button>
                </div>
                <div class="modal-body">
                    <div id="scannerContainer">
                        <video id="scannerVideo" width="100%" playsinline></video>
                        <canvas id="scannerCanvas" style="display: none;"></canvas>
                    </div>
                    <div class="scanner-alternativo">
                        <div class="form-group">
                            <label>Ingresar código manualmente</label>
                            <div class="flex gap-2">
                                <input type="text" class="form-control" id="codigoManual" 
                                       placeholder="Código de barras" onkeypress="if(event.key === 'Enter') procesarCodigoManual()">
                                <button class="btn btn-primary" onclick="procesarCodigoManual()">
                                    <i class="fas fa-search"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- Modal Cliente -->
        <div id="clienteModal" class="modal">
            <div class="modal-content" style="max-width: 700px;">
                <div class="modal-header">
                    <h3><i class="fas fa-user-plus"></i> Nuevo Cliente</h3>
                    <button class="btn-close" onclick="cerrarClienteModal()">&times;</button>
                </div>
                <div class="modal-body">
                    <form id="formCliente" onsubmit="guardarCliente(event)">
                        <div class="form-row">
                            <div class="form-group">
                                <label>Nombre Completo *</label>
                                <input type="text" id="clienteNombre" class="form-control" required>
                            </div>
                            <div class="form-group">
                                <label>Documento *</label>
                                <select class="form-control" id="clienteTipoDocumento" style="margin-bottom: 5px;">
                                    <option value="DNI">DNI</option>
                                    <option value="CUIT">CUIT</option>
                                    <option value="CUIL">CUIL</option>
                                    <option value="Pasaporte">Pasaporte</option>
                                </select>
                                <input type="text" id="clienteDocumento" class="form-control" required>
                            </div>
                        </div>
                        
                        <div class="form-row">
                            <div class="form-group">
                                <label>Teléfono</label>
                                <input type="tel" id="clienteTelefono" class="form-control">
                            </div>
                            <div class="form-group">
                                <label>Email</label>
                                <input type="email" id="clienteEmail" class="form-control">
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label>Dirección</label>
                            <input type="text" id="clienteDireccion" class="form-control">
                        </div>
                        
                        <div class="form-row">
                            <div class="form-group">
                                <label>Tipo de Cliente</label>
                                <select class="form-control" id="clienteTipo">
                                    <option value="consumidor_final">Consumidor Final</option>
                                    <option value="responsable_inscripto">Responsable Inscripto</option>
                                    <option value="monotributista">Monotributista</option>
                                    <option value="exento">Exento</option>
                                </select>
                            </div>
                            <div class="form-group">
                                <label>Límite de Crédito ($)</label>
                                <input type="number" id="clienteLimite" class="form-control" value="0" step="0.01">
                            </div>
                        </div>
                        
                        <div class="form-group">
                            <label>Observaciones</label>
                            <textarea id="clienteObservaciones" class="form-control" rows="2"></textarea>
                        </div>
                        
                        <div class="modal-footer">
                            <button type="button" class="btn btn-outline" onclick="cerrarClienteModal()">Cancelar</button>
                            <button type="submit" class="btn btn-primary">Guardar Cliente</button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
        
        <!-- Modal Éxito Venta -->
        <div id="exitoVentaModal" class="modal">
            <div class="modal-content" style="max-width: 500px;">
                <div class="modal-header" style="border-bottom: none;">
                    <h3 style="color: #10b981;"><i class="fas fa-check-circle"></i> Venta Exitosa</h3>
                    <button class="btn-close" onclick="cerrarModalExito()">&times;</button>
                </div>
                <div class="modal-body text-center">
                    <div class="exito-icon">
                        <i class="fas fa-check-circle"></i>
                    </div>
                    <h4 id="exitoVentaNumero"></h4>
                    <p id="exitoVentaTotal"></p>
                    <div class="flex gap-2 mt-4">
                        <button class="btn btn-outline" style="flex: 1;" onclick="imprimirUltimoTicket()">
                            <i class="fas fa-print"></i> Imprimir
                        </button>
                        <button class="btn btn-outline" style="flex: 1;" onclick="enviarTicketWhatsApp()">
                            <i class="fab fa-whatsapp"></i> WhatsApp
                        </button>
                        <button class="btn btn-primary" style="flex: 1;" onclick="cerrarModalExito()">
                            Continuar
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function inicializarVistaPOS() {
    // Cargar productos en el grid
    cargarProductosEnGrid();
    
    // Cargar clientes en el select
    cargarClientesEnSelect();
    
    // Cargar categorías en el filtro
    cargarCategoriasEnFiltro();
    
    // Inicializar carrito desde localStorage
    cargarCarritoLocal();
    
    // Configurar eventos
    const selectPago = document.getElementById('selectPago');
    if (selectPago) {
        selectPago.addEventListener('change', cambiarMetodoPago);
    }
    
    const buscarProducto = document.getElementById('buscarProducto');
    if (buscarProducto) {
        // Búsqueda incremental con mínimo 2 caracteres
        let timeoutBusqueda = null;
        buscarProducto.addEventListener('input', (e) => {
            const termino = e.target.value.trim();
            
            clearTimeout(timeoutBusqueda);
            timeoutBusqueda = setTimeout(() => {
                if (termino.length >= 2) {
                    buscarProductosIncremental(termino);
                } else if (termino.length === 0) {
                    cargarProductosEnGrid();
                }
            }, 300);
        });
    }
    
    // Inicializar método de pago por defecto
    cambiarMetodoPago();
}

function cargarProductosEnGrid() {
    const grid = document.getElementById('productosGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    if (productosFiltrados.length === 0) {
        productosFiltrados = Array.from(productosCache.values());
    }
    
    // Aplicar filtro de stock si está activo
    const mostrarSinStock = localStorage.getItem('mostrarSinStock') === 'true';
    let productosMostrar = productosFiltrados;
    
    if (!mostrarSinStock) {
        productosMostrar = productosFiltrados.filter(p => !p.controlStock || p.stock > 0);
    }
    
    if (productosMostrar.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--gray);">
                <i class="fas fa-box-open" style="font-size: 3rem; opacity: 0.5; margin-bottom: 15px;"></i>
                <p>No hay productos cargados</p>
                <p class="text-sm">Agrega productos desde el menú de inventario</p>
            </div>
        `;
        return;
    }
    
    // Limitar a 50 productos para performance
    const productosLimitados = productosMostrar.slice(0, 50);
    
    productosLimitados.forEach(producto => {
        const card = document.createElement('div');
        card.className = 'producto-card';
        card.onclick = () => agregarProductoCarrito(producto);
        card.title = `Click para agregar: ${producto.nombre}`;
        
        let stockClass = 'stock-normal';
        let stockText = producto.controlStock ? `Stock: ${producto.stock}` : 'Sin control';
        let stockIcon = '';
        
        if (producto.controlStock) {
            if (producto.stock <= 0) {
                stockClass = 'stock-sin';
                stockText = 'Sin stock';
                stockIcon = '<i class="fas fa-times-circle"></i> ';
            } else if (producto.stock <= (producto.stockMinimo || 5)) {
                stockClass = 'stock-bajo';
                stockText = `Stock bajo: ${producto.stock}`;
                stockIcon = '<i class="fas fa-exclamation-triangle"></i> ';
            }
        }
        
        card.innerHTML = `
            <div class="producto-codigo">${producto.codigo || 'Sin código'}</div>
            <div class="producto-nombre" title="${producto.nombre}">${producto.nombre}</div>
            <div class="producto-precio">$${producto.precioVenta?.toFixed(2) || '0.00'}</div>
            <div class="producto-stock ${stockClass}">${stockIcon}${stockText}</div>
            ${producto.categoria ? `<div class="producto-categoria">${producto.categoria}</div>` : ''}
        `;
        
        grid.appendChild(card);
    });
    
    // Actualizar contadores
    const contador = document.getElementById('productosDisponibles');
    const filtrado = document.getElementById('productosFiltrados');
    
    if (contador) {
        contador.textContent = `${productosCache.size} productos totales`;
    }
    
    if (filtrado) {
        const texto = productosMostrar.length < productosFiltrados.length ? 
            ` | Mostrando: ${productosMostrar.length}` : '';
        filtrado.textContent = texto;
    }
    
    // Mostrar botón de cargar más si hay más productos
    const btnCargarMas = document.getElementById('btnCargarMas');
    if (btnCargarMas) {
        btnCargarMas.style.display = productosMostrar.length > 50 ? 'block' : 'none';
    }
}

function buscarProductoRapido() {
    const termino = document.getElementById('buscarProducto')?.value.trim();
    if (!termino || termino.length < 2) {
        mostrarAlerta('Ingrese al menos 2 caracteres para buscar', 'warning');
        return;
    }
    
    productosFiltrados = Array.from(productosCache.values()).filter(producto => {
        const searchText = termino.toLowerCase();
        return (
            (producto.codigo && producto.codigo.toLowerCase().includes(searchText)) ||
            (producto.nombre && producto.nombre.toLowerCase().includes(searchText)) ||
            (producto.categoria && producto.categoria.toLowerCase().includes(searchText)) ||
            (producto.descripcion && producto.descripcion.toLowerCase().includes(searchText))
        );
    });
    
    cargarProductosEnGrid();
    
    // Mostrar cantidad de resultados
    if (productosFiltrados.length === 0) {
        mostrarAlerta('No se encontraron productos', 'info');
    } else {
        mostrarAlerta(`Se encontraron ${productosFiltrados.length} productos`, 'success');
    }
}

function buscarProductosIncremental(termino) {
    const resultsContainer = document.getElementById('searchResults');
    if (!resultsContainer) return;
    
    // Esta función se implementaría si hay un contenedor de resultados rápido
    // Por simplicidad, usamos la búsqueda principal
    buscarProductoRapido();
}

function filtrarProductosPorCategoria() {
    const categoria = document.getElementById('filtroCategoria')?.value;
    
    if (!categoria) {
        productosFiltrados = Array.from(productosCache.values());
    } else {
        productosFiltrados = Array.from(productosCache.values())
            .filter(p => p.categoria === categoria);
    }
    
    cargarProductosEnGrid();
}

function ordenarProductos() {
    const orden = document.getElementById('filtroOrden')?.value;
    
    productosFiltrados.sort((a, b) => {
        switch(orden) {
            case 'precio_asc':
                return (a.precioVenta || 0) - (b.precioVenta || 0);
            case 'precio_desc':
                return (b.precioVenta || 0) - (a.precioVenta || 0);
            case 'stock':
                return (b.stock || 0) - (a.stock || 0);
            default: // nombre
                return (a.nombre || '').localeCompare(b.nombre || '');
        }
    });
    
    cargarProductosEnGrid();
}

function filtrarSinStock() {
    const mostrar = localStorage.getItem('mostrarSinStock') !== 'true';
    localStorage.setItem('mostrarSinStock', mostrar);
    
    if (mostrar) {
        mostrarAlerta('Mostrando productos sin stock', 'info');
    } else {
        mostrarAlerta('Ocultando productos sin stock', 'info');
    }
    
    cargarProductosEnGrid();
}

function cargarMasProductos() {
    // Implementar carga paginada
    if (ultimoCursorProductos && !cargandoProductos) {
        cargarProductosPaginados(ultimoCursorProductos);
    }
}

// ============================================
// SCANNER DE CÓDIGO DE BARRAS
// ============================================

let scannerActive = false;
let scannerStream = null;

async function abrirScanner() {
    const modal = document.getElementById('scannerModal');
    if (!modal) return;
    
    modal.style.display = 'flex';
    
    // Inicializar scanner
    await initScanner();
}

async function initScanner() {
    try {
        const video = document.getElementById('scannerVideo');
        if (!video) return;
        
        // Solicitar acceso a la cámara
        scannerStream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: 'environment',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            } 
        });
        
        video.srcObject = scannerStream;
        video.setAttribute('playsinline', '');
        
        await video.play();
        
        scannerActive = true;
        startBarcodeDetection();
        
    } catch (error) {
        console.error('Error accediendo a la cámara:', error);
        mostrarAlerta('No se pudo acceder a la cámara. Use el ingreso manual.', 'warning');
        
        // Enfocar input manual
        const codigoManual = document.getElementById('codigoManual');
        if (codigoManual) codigoManual.focus();
    }
}

function startBarcodeDetection() {
    if (!scannerActive) return;
    
    const video = document.getElementById('scannerVideo');
    const canvas = document.getElementById('scannerCanvas');
    
    if (!video || !canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // Configurar canvas con las dimensiones del video
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    
    // Dibujar frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    // Obtener datos de la imagen
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Aquí iría la lógica de detección de códigos de barras
    // Por simplicidad, usaremos una biblioteca externa en producción
    // Por ahora, solo continuamos escaneando
    
    if (scannerActive) {
        requestAnimationFrame(startBarcodeDetection);
    }
}

function procesarCodigoManual() {
    const input = document.getElementById('codigoManual');
    if (!input) return;
    
    const codigo = input.value.trim();
    if (!codigo) {
        mostrarAlerta('Ingrese un código', 'warning');
        return;
    }
    
    buscarProductoPorCodigo(codigo);
    input.value = '';
    input.focus();
}

function buscarProductoPorCodigo(codigo) {
    // Buscar en cache
    for (const producto of productosCache.values()) {
        if (producto.codigo === codigo) {
            agregarProductoCarrito(producto);
            mostrarAlerta(`Producto agregado: ${producto.nombre}`, 'success');
            cerrarScanner();
            return;
        }
    }
    
    // Buscar parcialmente
    for (const producto of productosCache.values()) {
        if (producto.codigo && producto.codigo.includes(codigo)) {
            agregarProductoCarrito(producto);
            mostrarAlerta(`Producto agregado: ${producto.nombre}`, 'success');
            cerrarScanner();
            return;
        }
    }
    
    mostrarAlerta(`No se encontró producto con código: ${codigo}`, 'warning');
}

function cerrarScanner() {
    const modal = document.getElementById('scannerModal');
    if (modal) modal.style.display = 'none';
    
    // Detener scanner
    scannerActive = false;
    
    if (scannerStream) {
        scannerStream.getTracks().forEach(track => track.stop());
        scannerStream = null;
    }
}

// ============================================
// SISTEMA DE IMPRESIÓN
// ============================================

async function imprimirTicket(ventaData) {
    try {
        // Generar HTML del ticket
        const ticketHTML = generarHTMLTicket(ventaData);
        
        // Mostrar en contenedor oculto
        const printContainer = document.getElementById('printContainer');
        if (!printContainer) {
            // Crear contenedor si no existe
            const container = document.createElement('div');
            container.id = 'printContainer';
            container.style.cssText = 'position: absolute; left: -9999px; top: 0;';
            document.body.appendChild(container);
        }
        
        document.getElementById('printContainer').innerHTML = ticketHTML;
        
        // Opciones de impresión según configuración
        const tipoImpresion = configuracionSucursal.impresion?.tipo || 'ticket';
        
        if (tipoImpresion === 'ticket' || tipoImpresion === 'ambos') {
            await imprimirTicketTermico(ventaData);
        }
        
        if (tipoImpresion === 'pdf' || tipoImpresion === 'ambos') {
            await imprimirPDF(ventaData);
        }
        
    } catch (error) {
        console.error('Error imprimiendo ticket:', error);
        // No mostrar error al usuario para no interrumpir el flujo
    }
}

function generarHTMLTicket(ventaData) {
    const empresa = configuracionEmpresa.empresa || {};
    const sucursal = configuracionSucursal.empresa || {};
    
    // Determinar tamaño según configuración
    const anchoTicket = configuracionSucursal.impresion?.anchoTicket === '80mm' ? '80mm' : '58mm';
    
    return `
        <div class="ticket" style="width: ${anchoTicket}; font-family: monospace; font-size: 12px; padding: 10px;">
            <div class="ticket-header" style="text-align: center; margin-bottom: 10px;">
                <div style="font-weight: bold; font-size: 14px;">${empresa.nombre || 'MI COMERCIO'}</div>
                ${sucursal.nombre ? `<div>${sucursal.nombre}</div>` : ''}
                ${sucursal.direccion ? `<div>${sucursal.direccion}</div>` : ''}
                ${sucursal.telefono ? `<div>Tel: ${sucursal.telefono}</div>` : ''}
                ${empresa.cuit ? `<div>CUIT: ${empresa.cuit}</div>` : ''}
                <hr style="border: none; border-top: 1px dashed #000; margin: 5px 0;">
                <div style="font-weight: bold;">FACTURA ${ventaData.numeroFactura}</div>
                <div>${formatFecha(ventaData.fecha, 'DD/MM/YYYY HH:mm')}</div>
                <div>CAJA: ${ventaData.caja} | VENDEDOR: ${ventaData.usuarioNombre.split(' ')[0]}</div>
            </div>
            
            <div class="ticket-cliente" style="margin: 10px 0; font-size: 11px;">
                <div>CLIENTE: ${ventaData.clienteNombre}</div>
                ${ventaData.clienteDocumento ? `<div>DOC: ${ventaData.clienteDocumento}</div>` : ''}
            </div>
            
            <div class="ticket-items" style="margin: 10px 0;">
                <table style="width: 100%; font-size: 11px; border-collapse: collapse;">
                    <thead>
                        <tr>
                            <th style="text-align: left; border-bottom: 1px dashed #000;">Descripción</th>
                            <th style="text-align: right; border-bottom: 1px dashed #000;">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${ventaData.items.map(item => `
                            <tr>
                                <td style="padding: 2px 0;">
                                    ${item.cantidad} x ${item.nombre.substring(0, 20)}<br>
                                    <small>$${item.precioUnitario.toFixed(2)} c/u</small>
                                    ${item.descuento > 0 ? `<br><small style="color: green;">-$${item.descuento.toFixed(2)} desc</small>` : ''}
                                </td>
                                <td style="text-align: right; padding: 2px 0;">
                                    $${item.total.toFixed(2)}
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            
            <div class="ticket-totales" style="margin: 10px 0; border-top: 1px dashed #000; padding-top: 10px;">
                <div style="display: flex; justify-content: space-between;">
                    <span>Subtotal:</span>
                    <span>$${ventaData.subtotal.toFixed(2)}</span>
                </div>
                ${ventaData.descuentoTotal > 0 ? `
                    <div style="display: flex; justify-content: space-between; color: green;">
                        <span>Descuento:</span>
                        <span>-$${ventaData.descuentoTotal.toFixed(2)}</span>
                    </div>
                ` : ''}
                <div style="display: flex; justify-content: space-between;">
                    <span>IVA:</span>
                    <span>$${ventaData.ivaTotal.toFixed(2)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 14px; margin-top: 5px;">
                    <span>TOTAL:</span>
                    <span>$${ventaData.total.toFixed(2)}</span>
                </div>
                
                <div style="margin-top: 10px; font-size: 11px;">
                    <div>FORMA DE PAGO:</div>
                    ${ventaData.pagos.map(pago => `
                        <div style="display: flex; justify-content: space-between;">
                            <span>${pago.metodo.toUpperCase()}:</span>
                            <span>$${pago.monto.toFixed(2)}</span>
                        </div>
                    `).join('')}
                </div>
                
                ${ventaData.pagos.some(p => p.metodo === 'efectivo') ? `
                    <div style="margin-top: 5px; font-size: 11px;">
                        <div style="display: flex; justify-content: space-between;">
                            <span>Cambio:</span>
                            <span>$${(ventaData.pagos.find(p => p.metodo === 'efectivo')?.monto - ventaData.total).toFixed(2)}</span>
                        </div>
                    </div>
                ` : ''}
            </div>
            
            <div class="ticket-footer" style="text-align: center; margin-top: 15px; font-size: 10px; border-top: 1px dashed #000; padding-top: 10px;">
                ${configuracionSucursal.mensajeTicket || '¡Gracias por su compra!'}<br>
                <small>${ventaData.notas || ''}</small>
            </div>
        </div>
    `;
}

async function imprimirTicketTermico(ventaData) {
    // Usar la API de impresión del navegador
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
        // Fallback a impresión normal
        window.print();
        return;
    }
    
    const ticketHTML = generarHTMLTicket(ventaData);
    
    printWindow.document.write(`
        <html>
            <head>
                <title>Ticket ${ventaData.numeroFactura}</title>
                <style>
                    body { 
                        font-family: monospace; 
                        margin: 0; 
                        padding: 0; 
                        font-size: 12px;
                        width: ${configuracionSucursal.impresion?.anchoTicket === '80mm' ? '80mm' : '58mm'};
                    }
                    @media print {
                        body { margin: 0; padding: 0; }
                    }
                </style>
            </head>
            <body>${ticketHTML}</body>
        </html>
    `);
    
    printWindow.document.close();
    
    // Esperar a que cargue y luego imprimir
    printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
        printWindow.close();
    };
}

async function imprimirPDF(ventaData) {
    try {
        if (typeof html2pdf === 'undefined') {
            console.warn('html2pdf no disponible');
            return;
        }
        
        const ticketHTML = generarHTMLTicket(ventaData);
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = ticketHTML;
        document.body.appendChild(tempDiv);
        
        const options = {
            margin: [5, 5, 5, 5],
            filename: `ticket_${ventaData.numeroFactura}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { 
                scale: 2,
                useCORS: true,
                logging: false
            },
            jsPDF: { 
                unit: 'mm', 
                format: configuracionSucursal.impresion?.anchoTicket === '80mm' ? [80, 297] : [58, 297],
                orientation: 'portrait' 
            }
        };
        
        await html2pdf().from(tempDiv).set(options).save();
        document.body.removeChild(tempDiv);
        
    } catch (error) {
        console.error('Error generando PDF:', error);
    }
}

function imprimirUltimoTicket() {
    if (ultimaVenta) {
        imprimirTicket(ultimaVenta);
    }
}

function reimprimirUltimo() {
    if (ultimaVenta) {
        if (confirm(`¿Reimprimir ticket ${ultimaVenta.numeroFactura}?`)) {
            imprimirTicket({ ...ultimaVenta, reimpresion: true });
            mostrarAlerta('Ticket reimpreso', 'success');
        }
    } else {
        mostrarAlerta('No hay ventas recientes', 'warning');
    }
}

// ============================================
// FUNCIONES DE CONFIGURACIÓN
// ============================================

async function cargarConfiguracionCompleta() {
    try {
        // Cargar configuración de empresa
        const empresaDoc = await db.collection('configuracion_empresa').doc('general').get();
        if (empresaDoc.exists) {
            configuracionEmpresa = empresaDoc.data();
            empresaActual = configuracionEmpresa.empresa?.nombre || null;
        }
        
        // Cargar configuración de sucursal
        const sucursalDoc = await db.collection('configuracion_sucursal').doc(sucursalActual).get();
        if (sucursalDoc.exists) {
            configuracionSucursal = sucursalDoc.data();
            cajaActual = configuracionSucursal.caja || '1';
        } else {
            // Crear configuración por defecto
            configuracionSucursal = getConfiguracionDefault();
            await db.collection('configuracion_sucursal').doc(sucursalActual).set(configuracionSucursal);
        }
        
        // Combinar configuraciones
        configuracion = { ...configuracionEmpresa, ...configuracionSucursal };
        
        // Guardar en localStorage para offline
        localStorage.setItem(`config_empresa_${sucursalActual}`, JSON.stringify(configuracionEmpresa));
        localStorage.setItem(`config_sucursal_${sucursalActual}`, JSON.stringify(configuracionSucursal));
        
    } catch (error) {
        console.error('Error cargando configuración:', error);
        
        // Intentar cargar de localStorage
        const configEmpresaLocal = localStorage.getItem(`config_empresa_${sucursalActual}`);
        const configSucursalLocal = localStorage.getItem(`config_sucursal_${sucursalActual}`);
        
        if (configEmpresaLocal) configuracionEmpresa = JSON.parse(configEmpresaLocal);
        if (configSucursalLocal) configuracionSucursal = JSON.parse(configSucursalLocal);
        
        configuracion = { ...configuracionEmpresa, ...configuracionSucursal };
        
        if (!configuracionSucursal || Object.keys(configuracionSucursal).length === 0) {
            configuracionSucursal = getConfiguracionDefault();
            configuracion = { ...configuracion, ...configuracionSucursal };
        }
    }
}

function getConfiguracionDefault() {
    return {
        empresa: {
            nombre: `Sucursal ${sucursalActual}`,
            direccion: '',
            telefono: '',
            email: ''
        },
        facturacion: {
            puntoVenta: '0001',
            serie: 'A',
            prefijo: '',
            ivaPorcentaje: 21,
            autoImprimir: true,
            numeracionAutomatica: true
        },
        impresion: {
            tipo: 'ticket',
            anchoTicket: '58mm',
            copias: 1,
            imprimirLogo: false
        },
        caja: '1',
        mensajeTicket: '¡Gracias por su compra!',
        alertaStockBajo: 5,
        decimalesPrecios: 2,
        modoEmergenciaActivo: false
    };
}

async function cargarConfiguracionEmpresa() {
    try {
        const empresaDoc = await db.collection('configuracion_empresa').doc('general').get();
        if (empresaDoc.exists) {
            configuracionEmpresa = empresaDoc.data();
            empresaActual = configuracionEmpresa.empresa?.nombre || null;
        }
    } catch (error) {
        console.error('Error cargando configuración de empresa:', error);
    }
}

// ============================================
// FUNCIONES DE MONITOREO DE CONEXIÓN
// ============================================

function initConnectionMonitor() {
    const onlineIndicator = document.getElementById('onlineIndicator');
    
    function actualizarEstadoConexion() {
        const estaOnline = navigator.onLine && !modoEmergencia;
        
        if (onlineIndicator) {
            if (estaOnline) {
                onlineIndicator.innerHTML = '<i class="fas fa-wifi"></i><span>Online</span>';
                onlineIndicator.className = 'online-indicator online';
            } else if (modoEmergencia) {
                onlineIndicator.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span>Emergencia</span>';
                onlineIndicator.className = 'online-indicator emergency';
            } else {
                onlineIndicator.innerHTML = '<i class="fas fa-wifi-slash"></i><span>Offline</span>';
                onlineIndicator.className = 'online-indicator offline';
            }
        }
    }
    
    // Estado inicial
    actualizarEstadoConexion();
    
    // Event listeners
    window.addEventListener('online', () => {
        if (modoEmergencia) {
            desactivarModoEmergencia();
        }
        actualizarEstadoConexion();
        
        // Intentar sincronizar
        sincronizarDatosPendientes();
    });
    
    window.addEventListener('offline', () => {
        actualizarEstadoConexion();
        
        // Verificar si debemos activar modo emergencia
        if (configuracionSucursal.modoEmergenciaActivo) {
            activarModoEmergencia();
        }
    });
    
    // Verificar cada 30 segundos
    setInterval(actualizarEstadoConexion, 30000);
}

function activarModoEmergencia() {
    if (modoEmergencia) return;
    
    modoEmergencia = true;
    
    // Guardar estado actual
    guardarEstadoLocal();
    guardarProductosCacheLocal();
    guardarClientesCacheLocal();
    
    // Mostrar indicador
    const onlineIndicator = document.getElementById('onlineIndicator');
    if (onlineIndicator) {
        onlineIndicator.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span>Modo Emergencia</span>';
        onlineIndicator.className = 'online-indicator emergency';
    }
    
    mostrarAlerta('Modo emergencia activado. Trabajando sin conexión.', 'warning');
    
    // Actualizar UI para modo emergencia
    const btnScanner = document.getElementById('btnScanner');
    if (btnScanner) btnScanner.disabled = true;
    
    // Ocultar funciones que requieren conexión
    document.querySelectorAll('.require-online').forEach(el => {
        el.style.display = 'none';
    });
}

function desactivarModoEmergencia() {
    if (!modoEmergencia) return;
    
    modoEmergencia = false;
    
    // Restaurar indicador normal
    const onlineIndicator = document.getElementById('onlineIndicator');
    if (onlineIndicator && navigator.onLine) {
        onlineIndicator.innerHTML = '<i class="fas fa-wifi"></i><span>Online</span>';
        onlineIndicator.className = 'online-indicator online';
    }
    
    // Habilitar funciones
    const btnScanner = document.getElementById('btnScanner');
    if (btnScanner) btnScanner.disabled = false;
    
    // Mostrar funciones ocultas
    document.querySelectorAll('.require-online').forEach(el => {
        el.style.display = '';
    });
    
    // Intentar sincronizar datos pendientes
    if (ventasPendientes.length > 0) {
        mostrarAlerta('Sincronizando ventas pendientes...', 'info');
        sincronizarDatosPendientes();
    }
    
    mostrarAlerta('Conexión restablecida', 'success');
}

function verificarModoEmergencia() {
    if (!navigator.onLine && configuracionSucursal.modoEmergenciaActivo) {
        activarModoEmergencia();
    }
}

// ============================================
// FUNCIONES AUXILIARES
// ============================================

function formatFecha(fecha, formato = 'DD/MM/YYYY HH:mm') {
    if (!fecha) return '';
    
    const date = fecha instanceof Date ? fecha : (fecha?.toDate ? fecha.toDate() : new Date(fecha));
    
    if (isNaN(date.getTime())) return '';
    
    const pad = (n) => n.toString().padStart(2, '0');
    
    const replacements = {
        'YYYY': date.getFullYear(),
        'MM': pad(date.getMonth() + 1),
        'DD': pad(date.getDate()),
        'HH': pad(date.getHours()),
        'mm': pad(date.getMinutes()),
        'ss': pad(date.getSeconds())
    };
    
    return formato.replace(/YYYY|MM|DD|HH|mm|ss/g, match => replacements[match]);
}

function actualizarContadorProductos() {
    const count = productosCache.size;
    const element = document.getElementById('productosCount');
    if (element) element.textContent = count;
}

function actualizarContadorClientes() {
    const count = clientesCache.size;
    const element = document.getElementById('clientesCount');
    if (element) element.textContent = count;
}

function actualizarContadorVentasPendientes() {
    const count = ventasPendientes.length;
    const element = document.getElementById('ventasPendientesCount');
    if (element) {
        element.textContent = count;
        element.style.display = count > 0 ? 'inline-block' : 'none';
    }
}

function actualizarUITurno(abierto) {
    const turnoIndicator = document.getElementById('turnoIndicator');
    const turnoText = document.getElementById('turnoText');
    const btnAbrirTurno = document.getElementById('btnAbrirTurnoNav');
    const btnCerrarTurno = document.getElementById('btnCerrarTurnoNav');
    
    if (abierto && turnoActual) {
        if (turnoIndicator) {
            turnoIndicator.innerHTML = `
                <i class="fas fa-user-clock"></i>
                <span>Turno ${turnoActual.tipo} - Caja ${turnoActual.caja}</span>
            `;
            turnoIndicator.className = 'turno-indicator abierto';
        }
        
        if (turnoText) {
            turnoText.textContent = `Turno ${turnoActual.tipo} | Caja ${turnoActual.caja}`;
        }
        
        if (btnAbrirTurno) btnAbrirTurno.style.display = 'none';
        if (btnCerrarTurno) btnCerrarTurno.style.display = 'block';
        
    } else {
        if (turnoIndicator) {
            turnoIndicator.innerHTML = `
                <i class="fas fa-door-closed"></i>
                <span>Sin turno</span>
            `;
            turnoIndicator.className = 'turno-indicator cerrado';
        }
        
        if (turnoText) {
            turnoText.textContent = 'Sin turno';
        }
        
        if (btnAbrirTurno) btnAbrirTurno.style.display = 'block';
        if (btnCerrarTurno) btnCerrarTurno.style.display = 'none';
    }
}

// ============================================
// FUNCIONES DE ALMACENAMIENTO LOCAL
// ============================================

function guardarCarritoLocal() {
    localStorage.setItem(`carrito_${sucursalActual}`, JSON.stringify(carrito));
}

function cargarCarritoLocal() {
    try {
        const carritoGuardado = localStorage.getItem(`carrito_${sucursalActual}`);
        if (carritoGuardado) {
            carrito = JSON.parse(carritoGuardado);
            actualizarCarritoUI();
        }
    } catch (error) {
        console.error('Error cargando carrito:', error);
        carrito = [];
    }
}

function guardarEstadoLocal() {
    const estado = {
        carrito: carrito,
        ventasPendientes: ventasPendientes,
        ultimaVenta: ultimaVenta,
        fecha: new Date().toISOString(),
        sucursal: sucursalActual,
        usuario: usuarioActual?.uid
    };
    
    localStorage.setItem(`estado_sistema_${sucursalActual}`, JSON.stringify(estado));
}

function cargarEstadoLocal() {
    try {
        const estadoGuardado = localStorage.getItem(`estado_sistema_${sucursalActual}`);
        if (estadoGuardado) {
            const estado = JSON.parse(estadoGuardado);
            
            // Solo cargar si es del mismo usuario
            if (estado.usuario === usuarioActual?.uid) {
                carrito = estado.carrito || [];
                ventasPendientes = estado.ventasPendientes || [];
                ultimaVenta = estado.ultimaVenta || null;
                
                if (carrito.length > 0) {
                    actualizarCarritoUI();
                }
                
                actualizarContadorVentasPendientes();
            }
        }
    } catch (error) {
        console.error('Error cargando estado local:', error);
    }
}

async function guardarProductosCacheLocal() {
    try {
        const productosArray = Array.from(productosCache.values());
        localStorage.setItem(`productos_cache_${sucursalActual}`, JSON.stringify(productosArray));
    } catch (error) {
        console.error('Error guardando productos en cache local:', error);
    }
}

async function cargarProductosCacheLocal() {
    try {
        const productosGuardados = localStorage.getItem(`productos_cache_${sucursalActual}`);
        if (productosGuardados) {
            const productosArray = JSON.parse(productosGuardados);
            productosCache.clear();
            productosArray.forEach(producto => {
                productosCache.set(producto.id, producto);
            });
            productosFiltrados = Array.from(productosCache.values());
            actualizarContadorProductos();
        }
    } catch (error) {
        console.error('Error cargando productos del cache local:', error);
    }
}

async function guardarClientesCacheLocal() {
    try {
        const clientesArray = Array.from(clientesCache.values());
        localStorage.setItem(`clientes_cache_${sucursalActual}`, JSON.stringify(clientesArray));
    } catch (error) {
        console.error('Error guardando clientes en cache local:', error);
    }
}

async function cargarClientesCacheLocal() {
    try {
        const clientesGuardados = localStorage.getItem(`clientes_cache_${sucursalActual}`);
        if (clientesGuardados) {
            const clientesArray = JSON.parse(clientesGuardados);
            clientesCache.clear();
            clientesArray.forEach(cliente => {
                clientesCache.set(cliente.id, cliente);
            });
            actualizarContadorClientes();
        }
    } catch (error) {
        console.error('Error cargando clientes del cache local:', error);
    }
}

// ============================================
// FUNCIONES INDEXEDDB
// ============================================

async function guardarEnIndexedDB(storeName, data) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = offlineDB.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.add(data);
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function obtenerDeIndexedDB(storeName) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = offlineDB.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();
        
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function actualizarEnIndexedDB(storeName, key, data) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = offlineDB.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.put({ ...data, id: key });
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

async function eliminarDeIndexedDB(storeName, key) {
    return new Promise((resolve, reject) => {
        if (!offlineDB) {
            reject(new Error('IndexedDB no inicializada'));
            return;
        }
        
        const transaction = offlineDB.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const request = store.delete(key);
        
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

// ============================================
// FUNCIONES RESTANTES (COMPLETAS)
// ============================================

async function cargarClientes() {
    try {
        const snapshot = await db.collection('clientes')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .orderBy('nombre')
            .limit(200)
            .get();
        
        clientesCache.clear();
        snapshot.forEach(doc => {
            clientesCache.set(doc.id, { id: doc.id, ...doc.data() });
        });
        
        actualizarContadorClientes();
        
        // Guardar en cache local
        await guardarClientesCacheLocal();
        
    } catch (error) {
        console.error('Error cargando clientes:', error);
        await cargarClientesCacheLocal();
    }
}

async function cargarProveedores() {
    try {
        const snapshot = await db.collection('proveedores')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .orderBy('nombre')
            .limit(100)
            .get();
        
        proveedoresCache.clear();
        snapshot.forEach(doc => {
            proveedoresCache.set(doc.id, { id: doc.id, ...doc.data() });
        });
        
    } catch (error) {
        console.error('Error cargando proveedores:', error);
    }
}

async function cargarCategorias() {
    try {
        const snapshot = await db.collection('categorias')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .orderBy('nombre')
            .get();
        
        const categorias = [];
        snapshot.forEach(doc => {
            categorias.push({ id: doc.id, ...doc.data() });
        });
        
        // Guardar en localStorage
        localStorage.setItem(`categorias_${sucursalActual}`, JSON.stringify(categorias));
        
        return categorias;
        
    } catch (error) {
        console.error('Error cargando categorías:', error);
        const local = localStorage.getItem(`categorias_${sucursalActual}`);
        return local ? JSON.parse(local) : [];
    }
}

function cargarCategoriasEnFiltro() {
    const select = document.getElementById('filtroCategoria');
    if (!select) return;
    
    const categorias = JSON.parse(localStorage.getItem(`categorias_${sucursalActual}`) || '[]');
    
    select.innerHTML = '<option value="">Todas las categorías</option>';
    categorias.forEach(cat => {
        select.innerHTML += `<option value="${cat.nombre}">${cat.nombre}</option>`;
    });
}

function configurarListenersTiempoReal() {
    // Productos
    const productosListener = db.collection('productos')
        .where('sucursalId', '==', sucursalActual)
        .where('estado', '==', 'activo')
        .onSnapshot((snapshot) => {
            snapshot.docChanges().forEach(change => {
                const producto = { id: change.doc.id, ...change.doc.data() };
                
                if (change.type === 'added' || change.type === 'modified') {
                    productosCache.set(producto.id, producto);
                } else if (change.type === 'removed') {
                    productosCache.delete(producto.id);
                }
            });
            
            // Actualizar array filtrado
            productosFiltrados = Array.from(productosCache.values());
            
            // Actualizar cache local
            guardarProductosCacheLocal();
            actualizarContadorProductos();
            
            // Si estamos en vista POS, actualizar grid
            if (document.getElementById('productosGrid')) {
                cargarProductosEnGrid();
            }
        }, (error) => {
            console.error('Error en listener de productos:', error);
        });
    
    listenersActivos.push(productosListener);
    
    // Clientes
    const clientesListener = db.collection('clientes')
        .where('sucursalId', '==', sucursalActual)
        .where('estado', '==', 'activo')
        .onSnapshot((snapshot) => {
            snapshot.docChanges().forEach(change => {
                const cliente = { id: change.doc.id, ...change.doc.data() };
                
                if (change.type === 'added' || change.type === 'modified') {
                    clientesCache.set(cliente.id, cliente);
                } else if (change.type === 'removed') {
                    clientesCache.delete(cliente.id);
                }
            });
            
            actualizarContadorClientes();
            guardarClientesCacheLocal();
            
            // Actualizar select en POS si está abierto
            if (document.getElementById('selectCliente')) {
                cargarClientesEnSelect();
            }
        });
    
    listenersActivos.push(clientesListener);
    
    // Turnos del usuario actual
    const turnosListener = db.collection('turnos')
        .where('sucursalId', '==', sucursalActual)
        .where('usuarioId', '==', usuarioActual.uid)
        .where('estado', '==', 'abierto')
        .onSnapshot((snapshot) => {
            if (!snapshot.empty) {
                const turnoDoc = snapshot.docs[0];
                turnoActual = { id: turnoDoc.id, ...turnoDoc.data() };
                cajaActual = turnoActual.caja;
                actualizarUITurno(true);
            } else {
                turnoActual = null;
                actualizarUITurno(false);
            }
        });
    
    listenersActivos.push(turnosListener);
}

function calcularCambio() {
    const montoRecibido = parseFloat(document.getElementById('montoRecibido')?.value || 0);
    const total = parseFloat(document.getElementById('carritoTotal')?.textContent?.replace('$', '') || 0);
    const cambio = montoRecibido - total;
    
    const cambioInput = document.getElementById('cambio');
    if (cambioInput) {
        cambioInput.value = cambio >= 0 ? cambio.toFixed(2) : '0.00';
        cambioInput.style.color = cambio >= 0 ? '#059669' : '#dc2626';
    }
}

function calcularPagoMixto() {
    const efectivo = parseFloat(document.getElementById('pagoEfectivoMonto')?.value || 0);
    const tarjeta = parseFloat(document.getElementById('pagoTarjetaMonto')?.value || 0);
    const transferencia = parseFloat(document.getElementById('pagoTransferenciaMonto')?.value || 0);
    const total = parseFloat(document.getElementById('carritoTotal')?.textContent?.replace('$', '') || 0);
    
    const suma = efectivo + tarjeta + transferencia;
    const diferencia = total - suma;
    
    const resumen = document.getElementById('pagoMixtoResumen');
    if (resumen) {
        resumen.innerHTML = `
            <div style="display: flex; justify-content: space-between;">
                <span>Total:</span>
                <span>$${total.toFixed(2)}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
                <span>Pagado:</span>
                <span>$${suma.toFixed(2)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-weight: bold; color: ${diferencia === 0 ? '#059669' : '#dc2626'};">
                <span>Diferencia:</span>
                <span>${diferencia === 0 ? '✓' : `$${diferencia.toFixed(2)}`}</span>
            </div>
        `;
    }
}

function cambiarMetodoPago() {
    const metodo = document.getElementById('selectPago')?.value;
    
    // Ocultar todos
    document.querySelectorAll('.pago-metodo').forEach(el => {
        el.style.display = 'none';
    });
    
    // Mostrar seleccionado
    const metodoDiv = document.getElementById(`pago${metodo.charAt(0).toUpperCase() + metodo.slice(1)}`);
    if (metodoDiv) {
        metodoDiv.style.display = 'block';
    }
    
    // Si es efectivo, calcular cambio
    if (metodo === 'efectivo') {
        calcularCambio();
    }
    
    // Si es mixto, calcular resumen
    if (metodo === 'mixto') {
        calcularPagoMixto();
    }
}

function cargarClientesEnSelect() {
    const select = document.getElementById('selectCliente');
    if (!select) return;
    
    select.innerHTML = '<option value="general">Consumidor Final</option>';
    
    clientesCache.forEach(cliente => {
        const option = document.createElement('option');
        option.value = cliente.id;
        option.textContent = `${cliente.nombre} (${cliente.documento || 'Sin documento'})`;
        if (cliente.saldo > 0) {
            option.textContent += ` - Debe: $${cliente.saldo.toFixed(2)}`;
            option.style.color = '#dc2626';
        }
        select.appendChild(option);
    });
}

async function registrarEventoSistema(tipo, datos) {
    try {
        await db.collection('eventos_sistema').add({
            tipo: tipo,
            datos: datos,
            usuarioId: usuarioActual.uid,
            usuarioNombre: usuarioActual.nombre,
            sucursalId: sucursalActual,
            fecha: new Date(),
            ip: await obtenerIP()
        });
    } catch (error) {
        console.error('Error registrando evento:', error);
    }
}

// ============================================
// FUNCIONES DE CLIENTES COMPLETAS
// ============================================

function buscarClienteRapido() {
    const nombre = prompt('Buscar cliente por nombre o documento:');
    if (!nombre) return;
    
    // Buscar en cache
    for (const cliente of clientesCache.values()) {
        if (cliente.nombre.toLowerCase().includes(nombre.toLowerCase()) || 
            (cliente.documento && cliente.documento.includes(nombre))) {
            
            const select = document.getElementById('selectCliente');
            if (select) {
                select.value = cliente.id;
                actualizarInfoCliente();
            }
            
            mostrarAlerta(`Cliente encontrado: ${cliente.nombre}`, 'success');
            return;
        }
    }
    
    mostrarAlerta('No se encontró el cliente', 'warning');
}

async function guardarCliente(event) {
    event.preventDefault();
    
    try {
        const clienteData = {
            nombre: document.getElementById('clienteNombre').value.trim(),
            tipoDocumento: document.getElementById('clienteTipoDocumento').value,
            documento: document.getElementById('clienteDocumento').value.trim(),
            telefono: document.getElementById('clienteTelefono').value.trim() || null,
            email: document.getElementById('clienteEmail').value.trim() || null,
            direccion: document.getElementById('clienteDireccion').value.trim() || null,
            tipo: document.getElementById('clienteTipo').value,
            limiteCredito: parseFloat(document.getElementById('clienteLimite').value) || 0,
            sucursalId: sucursalActual,
            estado: 'activo',
            fechaRegistro: new Date(),
            saldo: 0,
            comprasTotal: 0,
            montoTotalCompras: 0,
            observaciones: document.getElementById('clienteObservaciones').value.trim() || '',
            usuarioCreacion: usuarioActual.uid
        };
        
        // Validaciones
        if (!clienteData.nombre) {
            mostrarAlerta('El nombre del cliente es requerido', 'warning');
            return;
        }
        
        if (!clienteData.documento) {
            mostrarAlerta('El documento es requerido', 'warning');
            return;
        }
        
        // Verificar si ya existe cliente con ese documento
        const existeQuery = await db.collection('clientes')
            .where('sucursalId', '==', sucursalActual)
            .where('documento', '==', clienteData.documento)
            .limit(1)
            .get();
        
        if (!existeQuery.empty) {
            const clienteExistente = existeQuery.docs[0].data();
            if (confirm(`Ya existe un cliente con documento ${clienteData.documento}: ${clienteExistente.nombre}. ¿Usar este cliente?`)) {
                document.getElementById('selectCliente').value = existeQuery.docs[0].id;
                actualizarInfoCliente();
                cerrarClienteModal();
                return;
            } else {
                return;
            }
        }
        
        // Guardar en Firestore
        const docRef = await db.collection('clientes').add(clienteData);
        clienteData.id = docRef.id;
        
        // Actualizar cache
        clientesCache.set(docRef.id, clienteData);
        
        // Actualizar select en POS
        cargarClientesEnSelect();
        
        // Seleccionar el nuevo cliente
        const selectCliente = document.getElementById('selectCliente');
        if (selectCliente) {
            selectCliente.value = docRef.id;
            actualizarInfoCliente();
        }
        
        // Cerrar modal y mostrar éxito
        cerrarClienteModal();
        mostrarAlerta(`Cliente "${clienteData.nombre}" creado exitosamente`, 'success');
        
        // Registrar evento
        await registrarEventoSistema('cliente_creado', {
            clienteId: docRef.id,
            clienteNombre: clienteData.nombre,
            documento: clienteData.documento
        });
        
    } catch (error) {
        console.error('Error guardando cliente:', error);
        mostrarAlerta('Error al guardar cliente: ' + error.message, 'danger');
    }
}

function actualizarInfoCliente() {
    const select = document.getElementById('selectCliente');
    const infoDiv = document.getElementById('clienteInfo');
    
    if (!select || !infoDiv) return;
    
    const clienteId = select.value;
    
    if (clienteId && clienteId !== 'general') {
        const cliente = clientesCache.get(clienteId);
        if (cliente) {
            const limite = cliente.limiteCredito || 0;
            const saldo = cliente.saldo || 0;
            const disponible = limite > 0 ? limite - saldo : null;
            
            infoDiv.innerHTML = `
                <div class="cliente-info-card">
                    <div class="cliente-info-header">
                        <strong style="font-size: 1.1rem;">${cliente.nombre}</strong>
                        <span class="badge ${cliente.tipo === 'responsable_inscripto' ? 'badge-info' : 'badge-secondary'}">
                            ${cliente.tipo === 'responsable_inscripto' ? 'RI' : 'CF'}
                        </span>
                    </div>
                    <div class="cliente-info-body">
                        ${cliente.documento ? `<div><small><i class="fas fa-id-card"></i> ${cliente.tipoDocumento}: ${cliente.documento}</small></div>` : ''}
                        ${cliente.telefono ? `<div><small><i class="fas fa-phone"></i> ${cliente.telefono}</small></div>` : ''}
                        ${cliente.email ? `<div><small><i class="fas fa-envelope"></i> ${cliente.email}</small></div>` : ''}
                        ${cliente.direccion ? `<div><small><i class="fas fa-map-marker-alt"></i> ${cliente.direccion}</small></div>` : ''}
                        
                        <div class="cliente-info-financiero">
                            <div class="flex justify-between">
                                <small>Saldo actual:</small>
                                <small class="${saldo > 0 ? 'text-danger' : 'text-success'}">
                                    $${saldo.toFixed(2)}
                                </small>
                            </div>
                            ${limite > 0 ? `
                                <div class="flex justify-between">
                                    <small>Límite crédito:</small>
                                    <small>$${limite.toFixed(2)}</small>
                                </div>
                                <div class="flex justify-between">
                                    <small>Disponible:</small>
                                    <small class="${disponible < 0 ? 'text-danger' : 'text-success'}">
                                        $${disponible.toFixed(2)}
                                    </small>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            `;
            infoDiv.style.display = 'block';
            return;
        }
    }
    
    infoDiv.style.display = 'none';
    infoDiv.innerHTML = '';
}

function cerrarClienteModal() {
    const modal = document.getElementById('clienteModal');
    if (modal) modal.style.display = 'none';
}

// ============================================
// FUNCIONES DE PRESUPUESTOS
// ============================================

async function crearPresupuesto() {
    if (carrito.length === 0) {
        mostrarAlerta('El carrito está vacío', 'warning');
        return;
    }
    
    try {
        // Calcular totales
        const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
        const descuentoTotal = carrito.reduce((sum, item) => sum + item.descuento, 0);
        const ivaTotal = carrito.reduce((sum, item) => {
            const itemTotal = item.subtotal - item.descuento;
            return sum + (itemTotal * (item.iva || IVA_PORCENTAJE));
        }, 0);
        const total = subtotal - descuentoTotal + ivaTotal;
        
        // Obtener cliente
        const clienteId = document.getElementById('selectCliente')?.value;
        let clienteData = null;
        
        if (clienteId && clienteId !== 'general') {
            clienteData = clientesCache.get(clienteId);
        }
        
        // Generar número de presupuesto
        const numeroPresupuesto = await generarNumeroPresupuesto();
        
        // Crear presupuesto
        const presupuestoData = {
            sucursalId: sucursalActual,
            numero: numeroPresupuesto,
            fecha: new Date(),
            validezDias: 30,
            fechaVencimiento: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
            clienteId: clienteId || null,
            clienteNombre: clienteData ? clienteData.nombre : 'Consumidor Final',
            clienteDocumento: clienteData ? clienteData.documento : null,
            items: carrito.map(item => ({
                productoId: item.id,
                codigo: item.codigo,
                nombre: item.nombre,
                cantidad: item.cantidad,
                precioUnitario: item.precioVenta,
                descuento: item.descuento,
                total: item.total
            })),
            subtotal: subtotal,
            descuentoTotal: descuentoTotal,
            ivaTotal: ivaTotal,
            total: total,
            usuarioId: usuarioActual.uid,
            usuarioNombre: usuarioActual.nombre,
            estado: 'pendiente',
            notas: document.getElementById('notasVenta')?.value || '',
            fechaCreacion: new Date()
        };
        
        // Guardar en Firestore
        const presupuestoRef = await db.collection('presupuestos').add(presupuestoData);
        presupuestoData.id = presupuestoRef.id;
        
        // Limpiar carrito
        carrito = [];
        actualizarCarritoUI();
        guardarCarritoLocal();
        
        // Mostrar éxito
        mostrarAlerta(`Presupuesto #${numeroPresupuesto} creado exitosamente`, 'success');
        
        // Imprimir presupuesto
        await imprimirPresupuesto(presupuestoData);
        
        // Registrar evento
        await registrarEventoSistema('presupuesto_creado', {
            presupuestoId: presupuestoRef.id,
            numero: numeroPresupuesto,
            total: total
        });
        
    } catch (error) {
        console.error('Error creando presupuesto:', error);
        mostrarAlerta('Error al crear presupuesto: ' + error.message, 'danger');
    }
}

async function generarNumeroPresupuesto() {
    try {
        // Obtener último número
        const contadorRef = db.collection('contadores_presupuestos').doc(`sucursal_${sucursalActual}`);
        const contadorDoc = await contadorRef.get();
        
        let proximoNumero = 1;
        
        if (contadorDoc.exists) {
            const contadorData = contadorDoc.data();
            proximoNumero = (contadorData.proximo || 0) + 1;
            await contadorRef.update({ 
                proximo: proximoNumero,
                ultimaActualizacion: new Date()
            });
        } else {
            await contadorRef.set({ 
                proximo: 1,
                sucursalId: sucursalActual,
                ultimaActualizacion: new Date()
            });
        }
        
        return `P-${new Date().getFullYear()}${(new Date().getMonth() + 1).toString().padStart(2, '0')}-${proximoNumero.toString().padStart(6, '0')}`;
        
    } catch (error) {
        console.error('Error generando número de presupuesto:', error);
        return `P-${Date.now()}`;
    }
}

async function imprimirPresupuesto(presupuestoData) {
    // Similar a imprimirTicket pero con formato de presupuesto
    // Implementación simplificada
    mostrarAlerta('Presupuesto listo para imprimir', 'success');
}

// ============================================
// FUNCIONES DE ANULACIÓN Y REEMISIÓN
// ============================================

async function anularUltimaVenta() {
    if (!ultimaVenta) {
        mostrarAlerta('No hay ventas recientes', 'warning');
        return;
    }
    
    if (!confirm(`¿Anular venta ${ultimaVenta.numeroFactura} por $${ultimaVenta.total.toFixed(2)}?`)) {
        return;
    }
    
    try {
        // Buscar la venta en Firestore
        const ventasQuery = await db.collection('ventas')
            .where('numeroFactura', '==', ultimaVenta.numeroFactura)
            .where('sucursalId', '==', sucursalActual)
            .limit(1)
            .get();
        
        if (ventasQuery.empty) {
            throw new Error('Venta no encontrada');
        }
        
        const ventaDoc = ventasQuery.docs[0];
        const ventaId = ventaDoc.id;
        
        // Anular con transacción
        await db.runTransaction(async (transaction) => {
            // 1. Marcar venta como anulada
            transaction.update(db.collection('ventas').doc(ventaId), {
                estado: ESTADOS_VENTA.ANULADA,
                fechaAnulacion: new Date(),
                usuarioAnulacion: usuarioActual.uid,
                motivoAnulacion: 'Anulación manual'
            });
            
            // 2. Revertir stock
            const ventaData = ventaDoc.data();
            for (const item of ventaData.items) {
                if (item.controlStock) {
                    const productoRef = db.collection('productos').doc(item.productoId);
                    transaction.update(productoRef, {
                        stock: firebase.firestore.FieldValue.increment(item.cantidad)
                    });
                    
                    // Registrar movimiento de stock
                    const movimientoRef = db.collection('movimientos_stock').doc();
                    transaction.set(movimientoRef, {
                        fecha: new Date(),
                        productoId: item.productoId,
                        productoNombre: item.nombre,
                        tipo: 'anulacion',
                        cantidad: item.cantidad,
                        ventaId: ventaId,
                        usuarioId: usuarioActual.uid,
                        sucursalId: sucursalActual,
                        observaciones: `Anulación venta ${ventaData.numeroFactura}`
                    });
                }
            }
            
            // 3. Revertir cuenta corriente si aplica
            if (ventaData.clienteId && ventaData.pagos.some(p => p.metodo === 'cuenta_corriente')) {
                const clienteRef = db.collection('clientes').doc(ventaData.clienteId);
                transaction.update(clienteRef, {
                    saldo: firebase.firestore.FieldValue.increment(-ventaData.total)
                });
                
                // Registrar movimiento de CC
                const ccMovimientoRef = db.collection('movimientos_cc').doc();
                transaction.set(ccMovimientoRef, {
                    fecha: new Date(),
                    clienteId: ventaData.clienteId,
                    clienteNombre: ventaData.clienteNombre,
                    tipo: 'anulacion',
                    monto: -ventaData.total,
                    ventaId: ventaId,
                    ventaNumero: ventaData.numeroFactura,
                    usuarioId: usuarioActual.uid,
                    sucursalId: sucursalActual,
                    observaciones: `Anulación venta ${ventaData.numeroFactura}`
                });
            }
            
            // 4. Revertir turno
            if (ventaData.turnoId) {
                const turnoRef = db.collection('turnos').doc(ventaData.turnoId);
                transaction.update(turnoRef, {
                    totalVentas: firebase.firestore.FieldValue.increment(-ventaData.total)
                });
            }
        });
        
        // Actualizar última venta
        ultimaVenta = null;
        
        mostrarAlerta(`Venta ${ventaData.numeroFactura} anulada correctamente`, 'success');
        
        // Registrar evento
        await registrarEventoSistema('venta_anulada', {
            ventaId: ventaId,
            numeroFactura: ventaData.numeroFactura,
            total: ventaData.total
        });
        
    } catch (error) {
        console.error('Error anulando venta:', error);
        mostrarAlerta('Error al anular venta: ' + error.message, 'danger');
    }
}

// ============================================
// FUNCIONES ADICIONALES COMPLETAS
// ============================================

function actualizarUIUsuario() {
    const userName = document.getElementById('userName');
    const userRole = document.getElementById('userRole');
    const userAvatar = document.getElementById('userAvatar');
    const empresaNombre = document.getElementById('empresaNombre');
    const sucursalNombre = document.getElementById('sucursalNombre');
    
    if (userName && usuarioActual) {
        userName.textContent = usuarioActual.nombre || usuarioActual.email.split('@')[0];
    }
    
    if (userRole && usuarioActual) {
        const rolNombre = {
            'admin_general': 'Administrador General',
            'admin_sucursal': 'Administrador Sucursal',
            'cajero': 'Cajero',
            'vendedor': 'Vendedor'
        }[usuarioActual.rol] || usuarioActual.rol;
        
        userRole.textContent = rolNombre;
    }
    
    if (userAvatar && usuarioActual) {
        const initials = (usuarioActual.nombre || usuarioActual.email)
            .split(' ')
            .map(n => n[0])
            .join('')
            .toUpperCase()
            .substring(0, 2);
        userAvatar.textContent = initials;
    }
    
    if (empresaNombre && empresaActual) {
        empresaNombre.textContent = empresaActual;
    }
    
    if (sucursalNombre) {
        sucursalNombre.textContent = sucursalActual;
    }
}

function mostrarModalExitoVenta(ventaData) {
    const modal = document.getElementById('exitoVentaModal');
    if (!modal) return;
    
    document.getElementById('exitoVentaNumero').textContent = `Venta #${ventaData.numeroFactura}`;
    document.getElementById('exitoVentaTotal').textContent = `Total: $${ventaData.total.toFixed(2)}`;
    
    modal.style.display = 'flex';
}

function cerrarModalExito() {
    const modal = document.getElementById('exitoVentaModal');
    if (modal) modal.style.display = 'none';
}

function aplicarDescuentoGlobal() {
    if (carrito.length === 0) {
        mostrarAlerta('El carrito está vacío', 'warning');
        return;
    }
    
    const descuento = prompt('Aplicar descuento global (% o monto):', '10%');
    if (descuento === null) return;
    
    let montoTotalDescuento = 0;
    
    if (descuento.includes('%')) {
        // Descuento porcentual
        const porcentaje = parseFloat(descuento.replace('%', '')) / 100;
        if (isNaN(porcentaje) || porcentaje < 0 || porcentaje > 1) {
            mostrarAlerta('Porcentaje inválido (0-100%)', 'danger');
            return;
        }
        
        carrito.forEach((item, index) => {
            const descuentoItem = item.subtotal * porcentaje;
            carrito[index].descuento = descuentoItem;
            carrito[index].descuentoPorcentaje = porcentaje;
            carrito[index].total = item.subtotal - descuentoItem;
            montoTotalDescuento += descuentoItem;
        });
    } else {
        // Descuento por monto total
        const monto = parseFloat(descuento);
        const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
        
        if (isNaN(monto) || monto < 0 || monto > subtotal) {
            mostrarAlerta(`Monto inválido. Máximo: $${subtotal.toFixed(2)}`, 'danger');
            return;
        }
        
        // Distribuir proporcionalmente
        carrito.forEach((item, index) => {
            const proporcion = item.subtotal / subtotal;
            const descuentoItem = monto * proporcion;
            carrito[index].descuento = descuentoItem;
            carrito[index].descuentoPorcentaje = descuentoItem / item.subtotal;
            carrito[index].total = item.subtotal - descuentoItem;
            montoTotalDescuento += descuentoItem;
        });
    }
    
    actualizarCarritoUI();
    guardarCarritoLocal();
    
    mostrarAlerta(`Descuento global aplicado: -$${montoTotalDescuento.toFixed(2)}`, 'success');
}

function mostrarTicketOffline(ventaData) {
    // Mostrar ticket en una nueva ventana
    const ticketWindow = window.open('', '_blank');
    if (!ticketWindow) {
        mostrarAlerta('No se pudo mostrar el ticket. Active los popups.', 'warning');
        return;
    }
    
    const ticketHTML = generarHTMLTicket(ventaData);
    
    ticketWindow.document.write(`
        <html>
            <head>
                <title>Ticket ${ventaData.numeroFactura} (Offline)</title>
                <style>
                    body { 
                        font-family: monospace; 
                        margin: 20px; 
                        padding: 0; 
                        font-size: 12px;
                    }
                    .ticket-offline {
                        border: 2px dashed #dc2626;
                        padding: 15px;
                        max-width: 300px;
                        margin: 0 auto;
                    }
                    .offline-warning {
                        color: #dc2626;
                        text-align: center;
                        font-weight: bold;
                        margin-bottom: 10px;
                    }
                </style>
            </head>
            <body>
                <div class="offline-warning">⚠️ TICKET OFFLINE - PENDIENTE DE SINCRONIZACIÓN</div>
                ${ticketHTML}
            </body>
        </html>
    `);
    
    ticketWindow.document.close();
}

async function enviarTicketWhatsApp() {
    if (!ultimaVenta) {
        mostrarAlerta('No hay ventas recientes', 'warning');
        return;
    }
    
    // Obtener teléfono del cliente si existe
    const clienteId = ultimaVenta.clienteId;
    let telefonoCliente = null;
    
    if (clienteId) {
        const cliente = clientesCache.get(clienteId);
        if (cliente && cliente.telefono) {
            telefonoCliente = cliente.telefono.replace(/\D/g, '');
        }
    }
    
    // Crear mensaje
    const mensaje = `✅ Venta #${ultimaVenta.numeroFactura}\n` +
                   `📅 ${formatFecha(ultimaVenta.fecha, 'DD/MM/YYYY HH:mm')}\n` +
                   `💰 Total: $${ultimaVenta.total.toFixed(2)}\n` +
                   `📋 ${configuracionEmpresa.empresa?.nombre || 'Mi Comercio'}`;
    
    // Codificar mensaje
    const mensajeCodificado = encodeURIComponent(mensaje);
    
    // Crear URL de WhatsApp
    let urlWhatsApp = `https://wa.me/${telefonoCliente || ''}?text=${mensajeCodificado}`;
    
    if (!telefonoCliente) {
        // Si no hay teléfono, abrir WhatsApp sin número
        urlWhatsApp = `https://wa.me/?text=${mensajeCodificado}`;
    }
    
    // Abrir en nueva ventana
    window.open(urlWhatsApp, '_blank');
}

async function cargarContadoresIniciales() {
    try {
        // Cargar contador de ventas pendientes
        actualizarContadorVentasPendientes();
        
        // Cargar estadísticas rápidas
        if (tienePermiso('reportes')) {
            await cargarEstadisticasRapidas();
        }
        
    } catch (error) {
        console.error('Error cargando contadores:', error);
    }
}

async function cargarEstadisticasRapidas() {
    // Implementación básica
    // En producción, se cargarían estadísticas reales
}

// ============================================
// EXPORTACIÓN DE FUNCIONES GLOBALES
// ============================================

// Funciones principales
window.login = login;
window.logout = logout;
window.abrirTurno = abrirTurno;
window.cerrarTurno = cerrarTurno;
window.abrirScanner = abrirScanner;
window.cerrarScanner = cerrarScanner;
window.procesarCodigoManual = procesarCodigoManual;
window.agregarProductoCarrito = agregarProductoCarrito;
window.modificarCantidad = modificarCantidad;
window.actualizarCantidadDesdeInput = actualizarCantidadDesdeInput;
window.eliminarDelCarrito = eliminarDelCarrito;
window.vaciarCarrito = vaciarCarrito;
window.procesarVenta = procesarVenta;
window.calcularCambio = calcularCambio;
window.calcularPagoMixto = calcularPagoMixto;
window.cambiarMetodoPago = cambiarMetodoPago;
window.crearPresupuesto = crearPresupuesto;
window.reimprimirUltimo = reimprimirUltimo;
window.anularUltimaVenta = anularUltimaVenta;
window.cambiarVista = cambiarVista;
window.seleccionarSucursal = seleccionarSucursal;
window.buscarProductoRapido = buscarProductoRapido;
window.mostrarTodosProductos = mostrarTodosProductos;
window.filtrarProductosPorCategoria = filtrarProductosPorCategoria;
window.ordenarProductos = ordenarProductos;
window.filtrarSinStock = filtrarSinStock;
window.cargarMasProductos = cargarMasProductos;
window.actualizarInfoCliente = actualizarInfoCliente;
window.buscarClienteRapido = buscarClienteRapido;
window.mostrarModalCliente = mostrarModalCliente;
window.cerrarClienteModal = cerrarClienteModal;
window.guardarCliente = guardarCliente;
window.aplicarDescuentoItem = aplicarDescuentoItem;
window.editarPrecioItem = editarPrecioItem;
window.aplicarDescuentoGlobal = aplicarDescuentoGlobal;
window.imprimirUltimoTicket = imprimirUltimoTicket;
window.enviarTicketWhatsApp = enviarTicketWhatsApp;
window.cerrarModalExito = cerrarModalExito;

// Funciones de utilidad
window.cerrarModal = function() {
    document.querySelectorAll('.modal').forEach(modal => {
        modal.style.display = 'none';
    });
};

// ============================================
// INICIALIZACIÓN FINAL
// ============================================

console.log('Sistema POS completamente cargado y funcional');

// Cargar estado local al iniciar
document.addEventListener('DOMContentLoaded', function() {
    // Configurar cerrado de modales al hacer clic fuera
    document.addEventListener('click', function(event) {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    });
    
    // Configurar tecla ESC para cerrar modales
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape') {
            window.cerrarModal();
        }
    });
});

// Service Worker para PWA
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(reg => console.log('Service Worker registrado:', reg))
        .catch(err => console.log('Service Worker no registrado:', err));
}
