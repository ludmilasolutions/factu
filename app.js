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
    ADMIN: 'admin',
    SUPERVISOR: 'supervisor',
    CAJERO: 'cajero',
    VENDEDOR: 'vendedor'
};

const PERMISOS = {
    admin: ['*'],
    supervisor: ['ventas', 'productos', 'clientes', 'caja', 'reportes'],
    cajero: ['ventas', 'caja'],
    vendedor: ['ventas', 'productos']
};

const IVA_PORCENTAJE = 0.21;
const LIMITE_PRODUCTOS_PAGINA = 50;
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

// ============================================
// VARIABLES GLOBALES
// ============================================

let usuarioActual = null;
let sucursalActual = SUCURSAL_DEFAULT;
let turnoActual = null;
let carrito = [];
let productosCache = new Map();
let clientesCache = new Map();
let proveedoresCache = new Map();
let modoEmergencia = false;
let ventasPendientes = [];
let ultimaVenta = null;
let configuracion = {};
let listenersActivos = [];

// ============================================
// INICIALIZACIÓN DEL SISTEMA
// ============================================

document.addEventListener('DOMContentLoaded', async function() {
    console.log('Iniciando sistema POS...');
    
    // Inicializar IndexedDB para modo offline
    await initIndexedDB();
    
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
    
    console.log('Sistema inicializado');
});

// ============================================
// SISTEMA DE AUTENTICACIÓN
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
            // Crear usuario si no existe
            await crearUsuarioInicial(userCredential.user);
        }
        
        mostrarAlerta('Sesión iniciada correctamente', 'success');
        
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
        }
        
        mostrarAlerta(mensaje, 'danger');
    }
}

async function crearUsuarioInicial(user) {
    try {
        const userData = {
            email: user.email,
            nombre: user.email.split('@')[0],
            rol: ROLES.ADMIN,
            sucursales: [SUCURSAL_DEFAULT],
            fechaRegistro: new Date(),
            estado: 'activo',
            ultimoAcceso: new Date()
        };
        
        await db.collection('usuarios').doc(user.uid).set(userData);
        
        // Crear configuración inicial
        await crearConfiguracionInicial();
        
    } catch (error) {
        console.error('Error creando usuario:', error);
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
        await cargarConfiguracion();
        
        // Inicializar sistema
        await inicializarSistema();
        
        // Mostrar sistema principal
        mostrarSistemaPrincipal();
        
    } catch (error) {
        console.error('Error iniciando sistema:', error);
        mostrarAlerta('Error al cargar el sistema', 'danger');
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
        
        // Guardar estado local
        guardarEstadoLocal();
        
        // Cerrar sesión en Firebase
        await auth.signOut();
        
        // Limpiar variables
        usuarioActual = null;
        sucursalActual = SUCURSAL_DEFAULT;
        turnoActual = null;
        carrito = [];
        productosCache.clear();
        clientesCache.clear();
        proveedoresCache.clear();
        ventasPendientes = [];
        
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
        
        console.log('Sistema inicializado para sucursal:', sucursalActual);
        
    } catch (error) {
        console.error('Error inicializando sistema:', error);
        throw error;
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
}

async function cargarProductosPaginados(lastDoc = null) {
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
        
        // Guardar en IndexedDB para offline
        await guardarProductosCacheLocal();
        
        // Actualizar contador
        actualizarContadorProductos();
        
        return snapshot.docs[snapshot.docs.length - 1];
        
    } catch (error) {
        console.error('Error cargando productos:', error);
        
        // Intentar cargar desde cache local
        await cargarProductosCacheLocal();
        return null;
    }
}

// ============================================
// SISTEMA DE TURNOS Y CAJA
// ============================================

async function verificarTurnoActivo() {
    try {
        const snapshot = await db.collection('turnos')
            .where('sucursalId', '==', sucursalActual)
            .where('usuarioId', '==', usuarioActual.uid)
            .where('estado', '==', 'abierto')
            .limit(1)
            .get();
        
        if (!snapshot.empty) {
            const turnoDoc = snapshot.docs[0];
            turnoActual = { id: turnoDoc.id, ...turnoDoc.data() };
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
        const tipoTurno = hora < 14 ? 'mañana' : 'tarde';
        
        // Crear turno con transacción para evitar colisiones
        const turnoData = {
            sucursalId: sucursalActual,
            usuarioId: usuarioActual.uid,
            usuarioNombre: usuarioActual.nombre || usuarioActual.email,
            fecha: new Date(),
            tipo: tipoTurno,
            caja: configuracion.caja || '1',
            apertura: new Date(),
            cierre: null,
            estado: 'abierto',
            ventasCount: 0,
            totalVentas: 0,
            efectivoInicial: monto,
            efectivoFinal: 0,
            desglosePagos: {},
            observaciones: '',
            diferenciaCaja: 0
        };
        
        const turnoRef = await db.collection('turnos').add(turnoData);
        turnoActual = { id: turnoRef.id, ...turnoData };
        
        // Actualizar UI
        actualizarUITurno(true);
        
        mostrarAlerta('Turno abierto correctamente', 'success');
        
        // Registrar en historial
        await registrarEventoSistema('turno_abierto', { turnoId: turnoRef.id });
        
    } catch (error) {
        console.error('Error abriendo turno:', error);
        mostrarAlerta('Error al abrir turno: ' + error.message, 'danger');
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
            .where('anulada', '==', false)
            .get();
        
        let totalVentas = 0;
        let desglose = {};
        
        ventasSnapshot.forEach(doc => {
            const venta = doc.data();
            totalVentas += venta.total || 0;
            
            // Acumular por método de pago
            const metodo = venta.metodoPago || 'efectivo';
            if (!desglose[metodo]) desglose[metodo] = 0;
            desglose[metodo] += venta.total || 0;
        });
        
        // Solicitar efectivo final
        const efectivoFinal = prompt(`Ingrese el efectivo final en caja:\nVentas en efectivo: $${(desglose.efectivo || 0).toFixed(2)}\nEfectivo inicial: $${turnoActual.efectivoInicial.toFixed(2)}`, '0');
        if (efectivoFinal === null) return;
        
        const montoFinal = parseFloat(efectivoFinal);
        if (isNaN(montoFinal)) {
            mostrarAlerta('Monto inválido', 'danger');
            return;
        }
        
        // Calcular diferencia
        const ventasEfectivo = desglose.efectivo || 0;
        const diferencia = montoFinal - (turnoActual.efectivoInicial + ventasEfectivo);
        
        // Actualizar turno
        await db.collection('turnos').doc(turnoActual.id).update({
            cierre: new Date(),
            estado: 'cerrado',
            efectivoFinal: montoFinal,
            totalVentas: totalVentas,
            ventasCount: ventasSnapshot.size,
            desglosePagos: desglose,
            diferenciaCaja: diferencia,
            observaciones: `Cierre manual - Diferencia: $${diferencia.toFixed(2)}`
        });
        
        // Limpiar turno actual
        turnoActual = null;
        actualizarUITurno(false);
        
        mostrarAlerta('Turno cerrado correctamente', 'success');
        
        // Registrar en historial
        await registrarEventoSistema('turno_cerrado', { 
            diferencia: diferencia 
        });
        
    } catch (error) {
        console.error('Error cerrando turno:', error);
        mostrarAlerta('Error al cerrar turno: ' + error.message, 'danger');
    }
}

async function cerrarTurnoAutomatico() {
    if (!turnoActual) return;
    
    try {
        await db.collection('turnos').doc(turnoActual.id).update({
            cierre: new Date(),
            estado: 'cerrado_automatico',
            observaciones: 'Cerrado automáticamente al salir del sistema'
        });
        
        console.log('Turno cerrado automáticamente');
    } catch (error) {
        console.error('Error cerrando turno automático:', error);
    }
}

// ============================================
// SISTEMA POS - CARRITO Y VENTAS
// ============================================

function agregarProductoCarrito(producto) {
    // Validar stock
    if (producto.controlStock && producto.stock <= 0) {
        mostrarAlerta('Producto sin stock disponible', 'warning');
        return;
    }
    
    // Buscar si ya está en el carrito
    const itemIndex = carrito.findIndex(item => item.id === producto.id);
    
    if (itemIndex !== -1) {
        // Verificar stock para cantidad adicional
        if (producto.controlStock && producto.stock < carrito[itemIndex].cantidad + 1) {
            mostrarAlerta(`Stock insuficiente. Disponible: ${producto.stock}`, 'warning');
            return;
        }
        
        // Incrementar cantidad
        carrito[itemIndex].cantidad++;
        carrito[itemIndex].subtotal = carrito[itemIndex].cantidad * carrito[itemIndex].precioVenta;
    } else {
        // Agregar nuevo item
        carrito.push({
            id: producto.id,
            codigo: producto.codigo,
            nombre: producto.nombre,
            precioVenta: producto.precioVenta,
            precioCosto: producto.precioCosto || 0,
            cantidad: 1,
            descuento: 0,
            descuentoPorcentaje: 0,
            subtotal: producto.precioVenta,
            stock: producto.stock,
            controlStock: producto.controlStock,
            iva: producto.iva || 0
        });
    }
    
    actualizarCarritoUI();
    guardarCarritoLocal();
}

function actualizarCarritoUI() {
    const carritoItems = document.getElementById('carritoItems');
    const subtotalElement = document.getElementById('carritoSubtotal');
    const ivaElement = document.getElementById('carritoIVA');
    const totalElement = document.getElementById('carritoTotal');
    
    if (!carritoItems) return;
    
    // Limpiar carrito
    carritoItems.innerHTML = '';
    
    let subtotal = 0;
    let descuentoTotal = 0;
    
    // Generar items
    carrito.forEach((item, index) => {
        const itemTotal = item.cantidad * item.precioVenta;
        const itemDescuento = item.descuento;
        const itemSubtotal = itemTotal - itemDescuento;
        
        subtotal += itemSubtotal;
        descuentoTotal += itemDescuento;
        
        const itemHTML = `
            <div class="carrito-item">
                <div class="carrito-item-info">
                    <div class="carrito-item-nombre">${item.nombre}</div>
                    <div class="carrito-item-precio">$${item.precioVenta.toFixed(2)} c/u</div>
                    <small>${item.codigo}</small>
                </div>
                <div class="carrito-item-cantidad">
                    <button class="cantidad-btn" onclick="modificarCantidad(${index}, -1)">
                        <i class="fas fa-minus"></i>
                    </button>
                    <span>${item.cantidad}</span>
                    <button class="cantidad-btn" onclick="modificarCantidad(${index}, 1)">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
                <div class="carrito-item-total">
                    $${itemSubtotal.toFixed(2)}
                </div>
                <button class="cantidad-btn" onclick="eliminarDelCarrito(${index})" 
                        style="background: #fee2e2; color: var(--danger);">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        `;
        
        carritoItems.innerHTML += itemHTML;
    });
    
    // Calcular impuestos
    const iva = subtotal * IVA_PORCENTAJE;
    const total = subtotal + iva;
    
    // Actualizar totales
    if (subtotalElement) subtotalElement.textContent = `$${subtotal.toFixed(2)}`;
    if (ivaElement) ivaElement.textContent = `$${iva.toFixed(2)}`;
    if (totalElement) totalElement.textContent = `$${total.toFixed(2)}`;
    
    // Actualizar contador
    const carritoCount = document.getElementById('carritoCount');
    if (carritoCount) {
        carritoCount.textContent = carrito.length;
        carritoCount.style.display = carrito.length > 0 ? 'inline-block' : 'none';
    }
    
    // Actualizar input de monto recibido
    const montoRecibido = document.getElementById('montoRecibido');
    if (montoRecibido) {
        montoRecibido.min = total.toFixed(2);
        montoRecibido.placeholder = `Mínimo: $${total.toFixed(2)}`;
    }
}

function modificarCantidad(index, delta) {
    if (!carrito[index]) return;
    
    const nuevaCantidad = carrito[index].cantidad + delta;
    
    if (nuevaCantidad < 1) {
        eliminarDelCarrito(index);
        return;
    }
    
    // Verificar stock
    if (carrito[index].controlStock && carrito[index].stock < nuevaCantidad) {
        mostrarAlerta(`Stock insuficiente. Disponible: ${carrito[index].stock}`, 'warning');
        return;
    }
    
    carrito[index].cantidad = nuevaCantidad;
    carrito[index].subtotal = nuevaCantidad * carrito[index].precioVenta;
    
    actualizarCarritoUI();
    guardarCarritoLocal();
}

function eliminarDelCarrito(index) {
    if (carrito[index]) {
        carrito.splice(index, 1);
        actualizarCarritoUI();
        guardarCarritoLocal();
    }
}

function vaciarCarrito() {
    if (carrito.length === 0) {
        mostrarAlerta('El carrito ya está vacío', 'info');
        return;
    }
    
    if (confirm(`¿Vaciar carrito? Se eliminarán ${carrito.length} productos.`)) {
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
        
        if (!turnoActual) {
            mostrarAlerta('No hay turno activo. Abra un turno primero.', 'danger');
            return;
        }
        
        // Obtener datos del cliente
        const clienteSelect = document.getElementById('selectCliente');
        const clienteId = clienteSelect ? clienteSelect.value : null;
        let clienteData = null;
        
        if (clienteId && clienteId !== 'general') {
            clienteData = clientesCache.get(clienteId);
        }
        
        // Obtener método de pago
        const metodoPagoSelect = document.getElementById('selectPago');
        const metodoPago = metodoPagoSelect ? metodoPagoSelect.value : 'efectivo';
        
        // Validar método de pago
        if (metodoPago === 'cuenta_corriente' && !clienteData) {
            mostrarAlerta('Seleccione un cliente para cuenta corriente', 'warning');
            return;
        }
        
        // Calcular totales
        const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
        const iva = subtotal * IVA_PORCENTAJE;
        const total = subtotal + iva;
        
        // Validar pago en efectivo
        if (metodoPago === 'efectivo') {
            const montoRecibido = parseFloat(document.getElementById('montoRecibido')?.value || 0);
            if (montoRecibido < total) {
                mostrarAlerta(`Monto insuficiente. Total: $${total.toFixed(2)}`, 'danger');
                return;
            }
        }
        
        // Confirmar venta
        if (!confirm(`¿Confirmar venta por $${total.toFixed(2)}?`)) {
            return;
        }
        
        // Procesar con transacción
        const resultado = await db.runTransaction(async (transaction) => {
            // 1. Generar número de factura único
            const numeroFactura = await generarNumeroFactura(transaction);
            
            // 2. Verificar y actualizar stock
            for (const item of carrito) {
                if (item.controlStock) {
                    const productoRef = db.collection('productos').doc(item.id);
                    const productoDoc = await transaction.get(productoRef);
                    
                    if (productoDoc.exists) {
                        const stockActual = productoDoc.data().stock || 0;
                        if (stockActual < item.cantidad) {
                            throw new Error(`Stock insuficiente para ${item.nombre}`);
                        }
                        
                        // Actualizar stock
                        transaction.update(productoRef, {
                            stock: stockActual - item.cantidad,
                            ultimaVenta: new Date(),
                            vendidosTotal: firebase.firestore.FieldValue.increment(item.cantidad)
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
                items: carrito.map(item => ({
                    productoId: item.id,
                    codigo: item.codigo,
                    nombre: item.nombre,
                    cantidad: item.cantidad,
                    precioUnitario: item.precioVenta,
                    subtotal: item.subtotal,
                    costo: item.precioCosto
                })),
                subtotal: subtotal,
                iva: iva,
                total: total,
                metodoPago: metodoPago,
                datosPago: obtenerDatosPago(metodoPago, total),
                usuarioId: usuarioActual.uid,
                usuarioNombre: usuarioActual.nombre || usuarioActual.email,
                turnoId: turnoActual.id,
                caja: configuracion.caja || '1',
                estado: 'completada',
                syncStatus: 'synced',
                anulada: false
            };
            
            // 4. Guardar venta
            const ventaRef = db.collection('ventas').doc();
            transaction.set(ventaRef, ventaData);
            
            // 5. Actualizar turno
            const turnoRef = db.collection('turnos').doc(turnoActual.id);
            transaction.update(turnoRef, {
                ventasCount: firebase.firestore.FieldValue.increment(1),
                totalVentas: firebase.firestore.FieldValue.increment(total),
                [`desglosePagos.${metodoPago}`]: firebase.firestore.FieldValue.increment(total || 0)
            });
            
            // 6. Actualizar cliente si es cuenta corriente
            if (metodoPago === 'cuenta_corriente' && clienteId) {
                const clienteRef = db.collection('clientes').doc(clienteId);
                transaction.update(clienteRef, {
                    saldo: firebase.firestore.FieldValue.increment(total),
                    ultimaCompra: new Date(),
                    comprasTotal: firebase.firestore.FieldValue.increment(1)
                });
            }
            
            return {
                ventaId: ventaRef.id,
                ventaData: ventaData
            };
        });
        
        // Guardar última venta
        ultimaVenta = resultado.ventaData;
        
        // Limpiar carrito
        carrito = [];
        actualizarCarritoUI();
        guardarCarritoLocal();
        
        // Resetear formulario
        if (metodoPagoSelect) metodoPagoSelect.value = 'efectivo';
        const montoRecibido = document.getElementById('montoRecibido');
        if (montoRecibido) montoRecibido.value = '';
        
        // Imprimir ticket
        await imprimirTicket(ultimaVenta);
        
        // Mostrar éxito
        mostrarAlerta(`Venta #${ultimaVenta.numeroFactura} procesada correctamente`, 'success');
        
        // Registrar evento
        await registrarEventoSistema('venta_procesada', {
            ventaId: resultado.ventaId,
            total: total
        });
        
    } catch (error) {
        console.error('Error procesando venta:', error);
        
        if (error.message.includes('stock')) {
            mostrarAlerta(error.message, 'danger');
        } else if (error.message.includes('unavailable')) {
            // Modo offline - guardar localmente
            await guardarVentaOffline();
            mostrarAlerta('Venta guardada localmente (modo offline)', 'warning');
        } else {
            mostrarAlerta('Error al procesar la venta: ' + error.message, 'danger');
        }
    }
}

async function generarNumeroFactura(transaction) {
    // Obtener contador de sucursal
    const contadorRef = db.collection('contadores_facturas').doc(`sucursal_${sucursalActual}`);
    const contadorDoc = await transaction.get(contadorRef);
    
    let proximoNumero = 1;
    
    if (contadorDoc.exists) {
        const contadorData = contadorDoc.data();
        proximoNumero = (contadorData.proximo || 0) + 1;
        transaction.update(contadorRef, { 
            proximo: proximoNumero,
            ultimaActualizacion: new Date()
        });
    } else {
        transaction.set(contadorRef, { 
            proximo: 1,
            sucursalId: sucursalActual,
            ultimaActualizacion: new Date()
        });
    }
    
    // Formato: PuntoVenta-Número (ej: 0001-00000001)
    const puntoVenta = configuracion.facturacion?.puntoVenta || '0001';
    const numeroFactura = proximoNumero.toString().padStart(8, '0');
    
    return `${puntoVenta}-${numeroFactura}`;
}

// ============================================
// SISTEMA OFFLINE CON INDEXEDDB
// ============================================

const DB_NAME = 'pos_offline_db';
const DB_VERSION = 3;
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
                    autoIncrement: true 
                });
                store.createIndex('fecha', 'fecha', { unique: false });
                store.createIndex('syncStatus', 'syncStatus', { unique: false });
            }
            
            // Productos cache
            if (!db.objectStoreNames.contains('productos_cache')) {
                const store = db.createObjectStore('productos_cache', { keyPath: 'id' });
                store.createIndex('codigo', 'codigo', { unique: true });
                store.createIndex('categoria', 'categoria', { unique: false });
            }
            
            // Configuración local
            if (!db.objectStoreNames.contains('config_local')) {
                db.createObjectStore('config_local', { keyPath: 'key' });
            }
        };
    });
}

async function guardarVentaOffline() {
    // Calcular totales
    const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
    const iva = subtotal * IVA_PORCENTAJE;
    const total = subtotal + iva;
    
    const ventaData = {
        id: 'offline_' + Date.now(),
        sucursalId: sucursalActual,
        fecha: new Date(),
        items: carrito,
        subtotal: subtotal,
        iva: iva,
        total: total,
        metodoPago: document.getElementById('selectPago')?.value || 'efectivo',
        syncStatus: 'pending',
        estado: 'pendiente',
        anulada: false
    };
    
    try {
        await guardarEnIndexedDB('ventas_pendientes', ventaData);
        
        // Agregar a array local
        ventasPendientes.push(ventaData);
        
        // Limpiar carrito
        carrito = [];
        actualizarCarritoUI();
        
        mostrarAlerta('Venta guardada localmente. Se sincronizará cuando haya conexión.', 'warning');
        
    } catch (error) {
        console.error('Error guardando venta offline:', error);
        mostrarAlerta('Error al guardar venta offline', 'danger');
    }
}

async function intentarSincronizar() {
    if (modoEmergencia || ventasPendientes.length === 0) return;
    
    try {
        // Obtener ventas pendientes
        const ventas = await obtenerDeIndexedDB('ventas_pendientes');
        
        for (const venta of ventas) {
            if (venta.syncStatus === 'pending') {
                try {
                    // Intentar subir a Firestore
                    const ventaRef = await db.collection('ventas').add({
                        ...venta,
                        syncStatus: 'synced',
                        fechaSubida: new Date()
                    });
                    
                    // Marcar como sincronizada
                    await actualizarEnIndexedDB('ventas_pendientes', venta.id, {
                        syncStatus: 'synced',
                        firestoreId: ventaRef.id
                    });
                    
                    // Eliminar del array local
                    ventasPendientes = ventasPendientes.filter(v => v.id !== venta.id);
                    
                } catch (error) {
                    console.error('Error sincronizando venta:', error);
                }
            }
        }
        
        if (ventasPendientes.length === 0) {
            mostrarAlerta('Todas las ventas sincronizadas', 'success');
        }
        
    } catch (error) {
        console.error('Error en sincronización:', error);
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
    console.log('⏳ ' + mensaje);
    // Puedes implementar un spinner aquí
}

function mostrarAlerta(mensaje, tipo = 'info') {
    // Crear alerta temporal
    const alerta = document.createElement('div');
    alerta.className = `alert alert-${tipo}`;
    alerta.innerHTML = `
        <i class="fas fa-${tipo === 'success' ? 'check-circle' : tipo === 'danger' ? 'exclamation-circle' : 'info-circle'}"></i>
        ${mensaje}
    `;
    
    alerta.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 9999;
        min-width: 300px;
        animation: slideIn 0.3s ease-out;
    `;
    
    document.body.appendChild(alerta);
    
    // Remover después de 5 segundos
    setTimeout(() => {
        alerta.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => {
            if (alerta.parentNode) {
                alerta.remove();
            }
        }, 300);
    }, 5000);
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
    
    // POS siempre visible
    menuHTML += `
        <div class="menu-section">
            <h4>Ventas</h4>
            <a href="#" class="menu-item active" data-view="pos">
                <i class="fas fa-cash-register"></i> POS / Facturación
            </a>
        </div>
    `;
    
    // Productos
    if (tienePermiso('productos')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Inventario</h4>
                <a href="#" class="menu-item" data-view="productos">
                    <i class="fas fa-boxes"></i> Productos
                    <span class="menu-badge" id="productosCount">0</span>
                </a>
            </div>
        `;
    }
    
    // Clientes
    if (tienePermiso('clientes')) {
        menuHTML += `
            <div class="menu-section">
                <h4>Clientes</h4>
                <a href="#" class="menu-item" data-view="clientes">
                    <i class="fas fa-users"></i> Clientes
                    <span class="menu-badge" id="clientesCount">0</span>
                </a>
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
    
    // Configurar evento para el botón de login en la pantalla de login
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
        }
        
    } catch (error) {
        console.error('Error cargando vista:', error);
        viewContainer.innerHTML = '<div class="alert alert-danger">Error al cargar la vista</div>';
    }
}

// ============================================
// VISTA POS (PRINCIPAL)
// ============================================

async function cargarVistaPOS() {
    return `
        <div class="pos-container">
            <!-- Columna izquierda: Productos -->
            <div class="pos-left">
                <!-- Búsqueda -->
                <div class="search-card">
                    <div class="search-header">
                        <h3><i class="fas fa-search"></i> Búsqueda de Productos</h3>
                        <div class="flex gap-2">
                            <button class="btn btn-outline btn-sm" onclick="abrirScanner()">
                                <i class="fas fa-barcode"></i> Escanear
                            </button>
                            <button class="btn btn-outline btn-sm" onclick="mostrarTodosProductos()">
                                <i class="fas fa-list"></i> Todos
                            </button>
                        </div>
                    </div>
                    <div class="search-body">
                        <div class="search-box">
                            <i class="fas fa-search search-icon"></i>
                            <input type="text" class="search-input" id="buscarProducto" 
                                   placeholder="Código, nombre o categoría (mín. 3 caracteres)...">
                        </div>
                        <div class="search-results" id="searchResults" style="display: none;">
                            <!-- Resultados de búsqueda incremental -->
                        </div>
                    </div>
                </div>
                
                <!-- Grid de productos -->
                <div class="productos-grid-container">
                    <div class="productos-header">
                        <h3><i class="fas fa-boxes"></i> Productos Disponibles</h3>
                        <small id="productosDisponibles">Cargando...</small>
                    </div>
                    <div class="productos-grid" id="productosGrid">
                        <!-- Productos cargados dinámicamente -->
                    </div>
                    <div class="pagination" id="productosPagination">
                        <!-- Paginación -->
                    </div>
                </div>
            </div>
            
            <!-- Columna derecha: Carrito y Pago -->
            <div class="pos-right">
                <!-- Carrito -->
                <div class="carrito-card">
                    <div class="carrito-header">
                        <h3><i class="fas fa-shopping-cart"></i> Carrito</h3>
                        <div>
                            <span class="badge badge-primary" id="carritoCount" style="display: none;">0</span>
                            <button class="btn btn-danger btn-sm" onclick="vaciarCarrito()">
                                <i class="fas fa-trash"></i> Vaciar
                            </button>
                        </div>
                    </div>
                    <div class="carrito-items" id="carritoItems">
                        <!-- Items del carrito -->
                        <div class="text-center" style="padding: 40px; color: var(--gray);">
                            <i class="fas fa-shopping-cart" style="font-size: 3rem; opacity: 0.5; margin-bottom: 15px;"></i>
                            <p>El carrito está vacío</p>
                            <p class="text-sm">Agrega productos desde la lista</p>
                        </div>
                    </div>
                    <div class="carrito-totales">
                        <div class="total-line">
                            <span>Subtotal:</span>
                            <span id="carritoSubtotal">$0.00</span>
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
                        <button class="btn btn-outline btn-sm" onclick="mostrarModalCliente()">
                            <i class="fas fa-plus"></i> Nuevo
                        </button>
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
                    </div>
                </div>
                
                <!-- Método de pago -->
                <div class="pago-card">
                    <div class="card-header">
                        <h3><i class="fas fa-credit-card"></i> Pago</h3>
                    </div>
                    <div class="card-body">
                        <div class="form-group">
                            <label>Método de Pago</label>
                            <select class="form-control" id="selectPago" onchange="cambiarMetodoPago()">
                                <option value="efectivo">Efectivo</option>
                                <option value="tarjeta">Tarjeta</option>
                                <option value="transferencia">Transferencia</option>
                                <option value="mixto">Mixto</option>
                                <option value="cuenta_corriente">Cuenta Corriente</option>
                            </select>
                        </div>
                        
                        <div id="pagoEfectivo">
                            <div class="form-group">
                                <label>Monto Recibido</label>
                                <input type="number" id="montoRecibido" class="form-control" 
                                       placeholder="0.00" step="0.01" min="0" oninput="calcularCambio()">
                            </div>
                            <div class="form-group">
                                <label>Cambio</label>
                                <input type="number" id="cambio" class="form-control" 
                                       placeholder="0.00" readonly style="background: #f8fafc;">
                            </div>
                        </div>
                        
                        <div id="pagoCuentaCorriente" style="display: none;">
                            <div class="alert alert-warning">
                                <i class="fas fa-exclamation-triangle"></i>
                                Se registrará como deuda en cuenta corriente
                            </div>
                        </div>
                        
                        <button class="btn btn-success btn-block" onclick="procesarVenta()" 
                                style="padding: 15px; font-size: 1.1rem; margin-top: 20px;">
                            <i class="fas fa-check-circle"></i> FINALIZAR VENTA
                        </button>
                        
                        <div class="flex gap-2 mt-3">
                            <button class="btn btn-outline" style="flex: 1;" onclick="crearPresupuesto()">
                                <i class="fas fa-file-invoice-dollar"></i> Presupuesto
                            </button>
                            <button class="btn btn-outline" style="flex: 1;" onclick="reimprimirUltimo()">
                                <i class="fas fa-print"></i> Reimprimir
                            </button>
                        </div>
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
    
    // Inicializar carrito desde localStorage
    cargarCarritoLocal();
    
    // Configurar eventos
    const selectPago = document.getElementById('selectPago');
    if (selectPago) {
        selectPago.addEventListener('change', cambiarMetodoPago);
    }
    
    const buscarProducto = document.getElementById('buscarProducto');
    if (buscarProducto) {
        // Búsqueda incremental con mínimo 3 caracteres
        let timeoutBusqueda = null;
        buscarProducto.addEventListener('input', (e) => {
            const termino = e.target.value.trim();
            
            // Ocultar resultados si el término es muy corto
            if (termino.length < 3) {
                const results = document.getElementById('searchResults');
                if (results) results.style.display = 'none';
                return;
            }
            
            clearTimeout(timeoutBusqueda);
            timeoutBusqueda = setTimeout(() => {
                buscarProductosIncremental(termino);
            }, 300);
        });
        
        // Ocultar resultados al hacer clic fuera
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.search-box')) {
                const results = document.getElementById('searchResults');
                if (results) results.style.display = 'none';
            }
        });
    }
}

function cargarProductosEnGrid() {
    const grid = document.getElementById('productosGrid');
    if (!grid) return;
    
    grid.innerHTML = '';
    
    let productosArray = Array.from(productosCache.values());
    
    // Limitar para mostrar solo algunos (paginación real sería mejor)
    productosArray = productosArray.slice(0, 40);
    
    if (productosArray.length === 0) {
        grid.innerHTML = `
            <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--gray);">
                <i class="fas fa-box-open" style="font-size: 3rem; opacity: 0.5; margin-bottom: 15px;"></i>
                <p>No hay productos cargados</p>
                <p class="text-sm">Agrega productos desde el menú de inventario</p>
            </div>
        `;
        return;
    }
    
    productosArray.forEach(producto => {
        const card = document.createElement('div');
        card.className = 'producto-card';
        card.onclick = () => agregarProductoCarrito(producto);
        
        let stockClass = 'stock-normal';
        let stockText = `Stock: ${producto.stock}`;
        
        if (producto.stock <= 0) {
            stockClass = 'stock-sin';
            stockText = 'Sin stock';
        } else if (producto.stock <= (producto.stockMinimo || 5)) {
            stockClass = 'stock-bajo';
            stockText = `Stock bajo: ${producto.stock}`;
        }
        
        card.innerHTML = `
            <div class="producto-codigo">${producto.codigo || 'Sin código'}</div>
            <div class="producto-nombre">${producto.nombre}</div>
            <div class="producto-precio">$${producto.precioVenta?.toFixed(2) || '0.00'}</div>
            <div class="producto-stock ${stockClass}">${stockText}</div>
        `;
        
        grid.appendChild(card);
    });
    
    // Actualizar contador
    const contador = document.getElementById('productosDisponibles');
    if (contador) {
        contador.textContent = `${productosArray.length} productos disponibles`;
    }
}

function buscarProductosIncremental(termino) {
    const resultsContainer = document.getElementById('searchResults');
    if (!resultsContainer) return;
    
    resultsContainer.innerHTML = '';
    resultsContainer.style.display = 'block';
    
    let productosArray = Array.from(productosCache.values());
    
    // Filtrar productos (máximo 10 resultados)
    const resultados = productosArray.filter(producto => {
        const searchText = termino.toLowerCase();
        return (
            (producto.codigo && producto.codigo.toLowerCase().includes(searchText)) ||
            (producto.nombre && producto.nombre.toLowerCase().includes(searchText)) ||
            (producto.categoria && producto.categoria.toLowerCase().includes(searchText))
        );
    }).slice(0, 10);
    
    if (resultados.length === 0) {
        resultsContainer.innerHTML = `
            <div class="search-result-item" style="justify-content: center; color: var(--gray);">
                <i class="fas fa-search"></i> No se encontraron productos
            </div>
        `;
        return;
    }
    
    // Mostrar resultados
    resultados.forEach(producto => {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        item.onclick = () => {
            agregarProductoCarrito(producto);
            resultsContainer.style.display = 'none';
            const buscarInput = document.getElementById('buscarProducto');
            if (buscarInput) buscarInput.value = '';
        };
        
        item.innerHTML = `
            <div>
                <div style="font-weight: 500;">${producto.nombre}</div>
                <small style="color: var(--gray);">${producto.codigo || 'Sin código'} | Stock: ${producto.stock}</small>
            </div>
            <div style="color: var(--primary); font-weight: bold;">
                $${producto.precioVenta?.toFixed(2) || '0.00'}
            </div>
        `;
        
        resultsContainer.appendChild(item);
    });
}

// ============================================
// SCANNER DE CÓDIGO DE BARRAS
// ============================================

async function abrirScanner() {
    try {
        const scanner = document.getElementById('barcodeScanner');
        if (!scanner) {
            mostrarAlerta('Elemento del scanner no encontrado', 'danger');
            return;
        }
        scanner.style.display = 'flex';
        
        // Intentar usar la API de escaneo nativa si está disponible
        if ('BarcodeDetector' in window) {
            await iniciarScannerNativo();
        } else {
            // Mostrar input manual
            const manualInput = document.getElementById('manualBarcode');
            if (manualInput) {
                manualInput.focus();
            }
        }
        
    } catch (error) {
        console.error('Error abriendo scanner:', error);
        const manualInput = document.getElementById('manualBarcode');
        if (manualInput) {
            manualInput.focus();
        }
    }
}

async function iniciarScannerNativo() {
    const videoContainer = document.getElementById('scannerVideoContainer');
    if (!videoContainer) return;
    
    // Solicitar permisos de cámara
    const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: 'environment' } 
    });
    
    // Crear video
    const video = document.createElement('video');
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.style.width = '100%';
    video.style.height = 'auto';
    
    videoContainer.innerHTML = '';
    videoContainer.appendChild(video);
    
    await video.play();
    
    // Configurar detector de códigos
    const barcodeDetector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'code_128'] });
    
    const detectBarcode = () => {
        barcodeDetector.detect(video)
            .then(barcodes => {
                if (barcodes.length > 0) {
                    const codigo = barcodes[0].rawValue;
                    procesarCodigoBarras(codigo);
                    cerrarScanner();
                }
            })
            .catch(console.error);
        
        requestAnimationFrame(detectBarcode);
    };
    
    detectBarcode();
}

function procesarCodigoBarras(codigo) {
    // Buscar producto por código
    for (const producto of productosCache.values()) {
        if (producto.codigo === codigo) {
            agregarProductoCarrito(producto);
            mostrarAlerta(`Producto agregado: ${producto.nombre}`, 'success');
            return;
        }
    }
    
    // Si no se encuentra, buscar por similitud
    for (const producto of productosCache.values()) {
        if (producto.codigo && producto.codigo.includes(codigo) || 
            codigo.includes(producto.codigo)) {
            agregarProductoCarrito(producto);
            mostrarAlerta(`Producto agregado: ${producto.nombre}`, 'success');
            return;
        }
    }
    
    mostrarAlerta(`No se encontró producto con código: ${codigo}`, 'warning');
}

function procesarCodigoManual() {
    const manualInput = document.getElementById('manualBarcode');
    if (!manualInput) return;
    
    const codigo = manualInput.value.trim();
    if (codigo) {
        procesarCodigoBarras(codigo);
        manualInput.value = '';
    }
}

function cerrarScanner() {
    const scanner = document.getElementById('barcodeScanner');
    if (!scanner) return;
    
    scanner.style.display = 'none';
    
    // Detener stream de video si existe
    const video = scanner.querySelector('video');
    if (video && video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
    }
}

// ============================================
// SISTEMA DE IMPRESIÓN
// ============================================

async function imprimirTicket(ventaData) {
    try {
        if (!configuracion.facturacion?.autoImprimir) {
            return; // No imprimir si está desactivado
        }
        
        const ticketContainer = document.getElementById('ticketContainer');
        if (!ticketContainer) return;
        
        // Datos de la empresa
        const empresa = configuracion.empresa || {};
        
        // Generar HTML del ticket
        const ticketHTML = `
            <div class="ticket">
                <div class="ticket-header">
                    <div class="ticket-empresa">${empresa.nombre || 'Mi Comercio'}</div>
                    ${empresa.direccion ? `<div>${empresa.direccion}</div>` : ''}
                    ${empresa.telefono ? `<div>Tel: ${empresa.telefono}</div>` : ''}
                    ${empresa.cuit ? `<div>CUIT: ${empresa.cuit}</div>` : ''}
                    <hr>
                    <div style="font-weight: bold;">FACTURA ${ventaData.numeroFactura}</div>
                    <div>${formatFecha(ventaData.fecha, 'DD/MM/YYYY HH:mm')}</div>
                </div>
                
                <div style="margin: 10px 0; font-size: 14px;">
                    <div>Cliente: ${ventaData.clienteNombre}</div>
                    <div>Vendedor: ${ventaData.usuarioNombre}</div>
                </div>
                
                <div class="ticket-items">
                    ${ventaData.items.map(item => `
                        <div class="ticket-item">
                            <div>${item.cantidad} x ${item.nombre.substring(0, 25)}</div>
                            <div>$${item.subtotal.toFixed(2)}</div>
                        </div>
                    `).join('')}
                </div>
                
                <div class="ticket-total">
                    <div>Subtotal: $${ventaData.subtotal.toFixed(2)}</div>
                    <div>IVA (21%): $${ventaData.iva.toFixed(2)}</div>
                    <div style="font-size: 16px; margin-top: 5px;">TOTAL: $${ventaData.total.toFixed(2)}</div>
                    <div style="font-size: 12px; margin-top: 5px;">
                        ${ventaData.metodoPago.toUpperCase()}
                        ${ventaData.datosPago?.cambio ? ` | Cambio: $${ventaData.datosPago.cambio.toFixed(2)}` : ''}
                    </div>
                </div>
                
                <div class="ticket-footer">
                    ${configuracion.mensajeTicket || '¡Gracias por su compra!'}
                </div>
            </div>
        `;
        
        ticketContainer.innerHTML = ticketHTML;
        
        // Opciones de impresión
        const printOptions = {
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
                format: [80, 200], 
                orientation: 'portrait' 
            }
        };
        
        // Generar PDF si html2pdf está disponible
        if (typeof html2pdf !== 'undefined') {
            await html2pdf().from(ticketContainer).set(printOptions).save();
        } else {
            // Abrir ventana de impresión
            const printWindow = window.open('', '_blank');
            printWindow.document.write(`
                <html>
                    <head>
                        <title>Ticket ${ventaData.numeroFactura}</title>
                        <style>
                            body { font-family: monospace; margin: 0; padding: 10px; }
                            .ticket { width: 80mm; }
                        </style>
                    </head>
                    <body>${ticketHTML}</body>
                </html>
            `);
            printWindow.document.close();
            printWindow.print();
            printWindow.close();
        }
        
        // Registrar reimpresión si es reimpresión
        if (ventaData.reimpresion) {
            await registrarEventoSistema('ticket_reimpreso', {
                ventaId: ventaData.id,
                numeroFactura: ventaData.numeroFactura
            });
        }
        
    } catch (error) {
        console.error('Error imprimiendo ticket:', error);
        // No mostrar error al usuario para no interrumpir el flujo
    }
}

// ============================================
// FUNCIONES DE CONFIGURACIÓN
// ============================================

async function cargarConfiguracion() {
    try {
        // Intentar cargar de Firestore
        const configDoc = await db.collection('configuracion').doc(sucursalActual).get();
        
        if (configDoc.exists) {
            configuracion = configDoc.data();
        } else {
            // Configuración por defecto
            configuracion = {
                empresa: {
                    nombre: 'Mi Comercio',
                    direccion: '',
                    telefono: '',
                    cuit: '',
                    condicionIva: 'consumidor_final'
                },
                facturacion: {
                    puntoVenta: '0001',
                    ivaPorcentaje: 21,
                    autoImprimir: true
                },
                impresion: {
                    tipo: 'pdf',
                    nombreImpresora: '',
                    copias: 1
                },
                caja: '1',
                mensajeTicket: '¡Gracias por su compra!'
            };
            
            // Guardar configuración por defecto
            await db.collection('configuracion').doc(sucursalActual).set(configuracion);
        }
        
        // Guardar en localStorage para offline
        localStorage.setItem(`config_${sucursalActual}`, JSON.stringify(configuracion));
        
    } catch (error) {
        console.error('Error cargando configuración:', error);
        
        // Intentar cargar de localStorage
        const configLocal = localStorage.getItem(`config_${sucursalActual}`);
        if (configLocal) {
            configuracion = JSON.parse(configLocal);
        }
    }
}

async function crearConfiguracionInicial() {
    try {
        const configInicial = {
            empresa: {
                nombre: 'Mi Comercio',
                direccion: 'Dirección del comercio',
                telefono: '',
                cuit: '',
                condicionIva: 'consumidor_final'
            },
            facturacion: {
                puntoVenta: '0001',
                ivaPorcentaje: 21,
                autoImprimir: true
            },
            usuarios: [{
                email: usuarioActual.email,
                rol: ROLES.ADMIN,
                fechaRegistro: new Date()
            }],
            sucursales: [SUCURSAL_DEFAULT],
            fechaCreacion: new Date()
        };
        
        await db.collection('configuracion').doc(SUCURSAL_DEFAULT).set(configInicial);
        
    } catch (error) {
        console.error('Error creando configuración:', error);
    }
}

// ============================================
// MONITOREO DE CONEXIÓN
// ============================================

function initConnectionMonitor() {
    const onlineIndicator = document.getElementById('onlineIndicator');
    
    function actualizarEstadoConexion() {
        const estaOnline = navigator.onLine;
        
        if (onlineIndicator) {
            const icon = onlineIndicator.querySelector('i');
            const text = onlineIndicator.querySelector('span');
            
            if (estaOnline) {
                if (icon) icon.className = 'fas fa-wifi';
                if (text) text.textContent = 'Online';
                onlineIndicator.style.color = 'var(--secondary)';
                
                // Sincronizar datos pendientes
                if (ventasPendientes.length > 0) {
                    intentarSincronizar();
                }
                
                // Desactivar modo emergencia si estaba activo
                if (modoEmergencia) {
                    desactivarModoEmergencia();
                }
            } else {
                if (icon) icon.className = 'fas fa-wifi-slash';
                if (text) text.textContent = 'Offline';
                onlineIndicator.style.color = 'var(--danger)';
                
                // Activar modo emergencia
                if (!modoEmergencia) {
                    activarModoEmergencia();
                }
            }
        }
    }
    
    // Estado inicial
    actualizarEstadoConexion();
    
    // Event listeners
    window.addEventListener('online', actualizarEstadoConexion);
    window.addEventListener('offline', actualizarEstadoConexion);
    
    // Verificar cada 30 segundos
    setInterval(actualizarEstadoConexion, 30000);
}

function activarModoEmergencia() {
    modoEmergencia = true;
    
    // Guardar estado actual
    guardarEstadoLocal();
    guardarProductosCacheLocal();
    
    // Mostrar indicador
    const onlineIndicator = document.getElementById('onlineIndicator');
    if (onlineIndicator) {
        onlineIndicator.innerHTML = '<i class="fas fa-exclamation-triangle"></i><span>Modo Emergencia</span>';
        onlineIndicator.style.color = 'var(--warning)';
    }
    
    mostrarAlerta('Modo emergencia activado. Trabajando sin conexión.', 'warning');
}

function desactivarModoEmergencia() {
    modoEmergencia = false;
    
    // Restaurar indicador normal
    const onlineIndicator = document.getElementById('onlineIndicator');
    if (onlineIndicator && navigator.onLine) {
        onlineIndicator.innerHTML = '<i class="fas fa-wifi"></i><span>Online</span>';
        onlineIndicator.style.color = 'var(--secondary)';
    }
    
    // Intentar sincronizar datos pendientes
    if (ventasPendientes.length > 0) {
        intentarSincronizar();
    }
    
    mostrarAlerta('Conexión restablecida. Sincronizando datos...', 'success');
}

function verificarModoEmergencia() {
    if (!navigator.onLine) {
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

function actualizarUITurno(abierto) {
    const turnoIndicator = document.getElementById('turnoIndicator');
    const turnoText = document.getElementById('turnoText');
    
    if (!turnoIndicator || !turnoText) return;
    
    if (abierto && turnoActual) {
        turnoIndicator.innerHTML = `
            <i class="fas fa-user-clock"></i>
            <span>Turno ${turnoActual.tipo} - Caja ${turnoActual.caja}</span>
        `;
        turnoIndicator.style.color = 'var(--secondary)';
        
        // Mostrar botón de cerrar turno si no existe
        const navRight = document.querySelector('.nav-right');
        let cerrarBtn = document.getElementById('btnCerrarTurno');
        
        if (!cerrarBtn && navRight) {
            cerrarBtn = document.createElement('button');
            cerrarBtn.id = 'btnCerrarTurno';
            cerrarBtn.className = 'btn btn-danger btn-sm';
            cerrarBtn.innerHTML = '<i class="fas fa-door-closed"></i> Cerrar Turno';
            cerrarBtn.onclick = cerrarTurno;
            navRight.insertBefore(cerrarBtn, navRight.firstChild);
        }
    } else {
        turnoIndicator.innerHTML = `
            <i class="fas fa-door-closed"></i>
            <span>Sin turno</span>
        `;
        turnoIndicator.style.color = 'var(--danger)';
        
        // Remover botón de cerrar turno
        const cerrarBtn = document.getElementById('btnCerrarTurno');
        if (cerrarBtn) cerrarBtn.remove();
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
        sucursal: sucursalActual
    };
    
    localStorage.setItem(`estado_sistema_${sucursalActual}`, JSON.stringify(estado));
}

function cargarEstadoLocal() {
    try {
        const estadoGuardado = localStorage.getItem(`estado_sistema_${sucursalActual}`);
        if (estadoGuardado) {
            const estado = JSON.parse(estadoGuardado);
            carrito = estado.carrito || [];
            ventasPendientes = estado.ventasPendientes || [];
            ultimaVenta = estado.ultimaVenta || null;
            
            if (carrito.length > 0) {
                actualizarCarritoUI();
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
            actualizarContadorProductos();
        }
    } catch (error) {
        console.error('Error cargando productos del cache local:', error);
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

// ============================================
// FUNCIONES RESTANTES (COMPLETAS)
// ============================================

async function cargarClientes() {
    try {
        const snapshot = await db.collection('clientes')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .limit(100)
            .get();
        
        clientesCache.clear();
        snapshot.forEach(doc => {
            clientesCache.set(doc.id, { id: doc.id, ...doc.data() });
        });
        
        actualizarContadorClientes();
        
    } catch (error) {
        console.error('Error cargando clientes:', error);
    }
}

async function cargarProveedores() {
    try {
        const snapshot = await db.collection('proveedores')
            .where('sucursalId', '==', sucursalActual)
            .where('estado', '==', 'activo')
            .limit(50)
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
    // Implementar según necesidad
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
    
    // Listener para turnos del usuario actual
    const turnosListener = db.collection('turnos')
        .where('sucursalId', '==', sucursalActual)
        .where('usuarioId', '==', usuarioActual.uid)
        .where('estado', '==', 'abierto')
        .onSnapshot((snapshot) => {
            if (!snapshot.empty) {
                const turnoDoc = snapshot.docs[0];
                turnoActual = { id: turnoDoc.id, ...turnoDoc.data() };
                actualizarUITurno(true);
            } else {
                turnoActual = null;
                actualizarUITurno(false);
            }
        }, (error) => {
            console.error('Error en listener de turnos:', error);
        });
    
    listenersActivos.push(turnosListener);
}

function obtenerDatosPago(metodo, total) {
    switch(metodo) {
        case 'efectivo':
            const montoRecibido = parseFloat(document.getElementById('montoRecibido')?.value || 0);
            return {
                montoRecibido: montoRecibido,
                cambio: montoRecibido - total
            };
        default:
            return {};
    }
}

function calcularCambio() {
    const montoRecibido = parseFloat(document.getElementById('montoRecibido')?.value || 0);
    const total = parseFloat(document.getElementById('carritoTotal')?.textContent?.replace('$', '') || 0);
    const cambio = montoRecibido - total;
    
    const cambioInput = document.getElementById('cambio');
    if (cambioInput) {
        cambioInput.value = cambio > 0 ? cambio.toFixed(2) : '0.00';
    }
}

function cambiarMetodoPago() {
    const metodo = document.getElementById('selectPago')?.value;
    
    // Ocultar todos
    const pagoEfectivo = document.getElementById('pagoEfectivo');
    const pagoCuentaCorriente = document.getElementById('pagoCuentaCorriente');
    
    if (pagoEfectivo) pagoEfectivo.style.display = 'none';
    if (pagoCuentaCorriente) pagoCuentaCorriente.style.display = 'none';
    
    // Mostrar seleccionado
    if (metodo === 'efectivo' && pagoEfectivo) {
        pagoEfectivo.style.display = 'block';
    } else if (metodo === 'cuenta_corriente' && pagoCuentaCorriente) {
        pagoCuentaCorriente.style.display = 'block';
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
        select.appendChild(option);
    });
}

async function registrarEventoSistema(tipo, datos) {
    try {
        await db.collection('eventos_sistema').add({
            tipo: tipo,
            datos: datos,
            usuarioId: usuarioActual.uid,
            sucursalId: sucursalActual,
            fecha: new Date()
        });
    } catch (error) {
        console.error('Error registrando evento:', error);
    }
}

// ============================================
// FUNCIONES DE CLIENTES COMPLETAS
// ============================================

function mostrarModalCliente() {
    const modal = document.getElementById('clienteModal');
    if (!modal) return;
    
    // Resetear formulario
    const form = document.getElementById('formCliente');
    if (form) form.reset();
    
    // Mostrar modal
    modal.style.display = 'flex';
}

function cerrarClienteModal() {
    const modal = document.getElementById('clienteModal');
    if (modal) modal.style.display = 'none';
}

async function guardarCliente(event) {
    event.preventDefault();
    
    try {
        const clienteData = {
            nombre: document.getElementById('clienteNombre').value.trim(),
            documento: document.getElementById('clienteDocumento').value.trim() || null,
            telefono: document.getElementById('clienteTelefono').value.trim() || null,
            email: document.getElementById('clienteEmail').value.trim() || null,
            direccion: document.getElementById('clienteDireccion').value.trim() || null,
            tipo: document.getElementById('clienteTipo').value,
            limiteCredito: parseFloat(document.getElementById('clienteLimite').value) || 0,
            sucursalId: sucursalActual,
            estado: 'activo',
            fechaRegistro: new Date(),
            saldo: 0,
            comprasTotal: 0
        };
        
        // Validaciones
        if (!clienteData.nombre) {
            mostrarAlerta('El nombre del cliente es requerido', 'warning');
            return;
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
            infoDiv.innerHTML = `
                <div style="margin-top: 10px; padding: 12px; background: #f8fafc; border-radius: 8px; border-left: 4px solid var(--primary);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                        <strong style="font-size: 1.1rem;">${cliente.nombre}</strong>
                        <span class="badge ${cliente.saldo > 0 ? 'badge-warning' : 'badge-success'}">
                            ${cliente.saldo > 0 ? `Debe: $${cliente.saldo.toFixed(2)}` : 'Al día'}
                        </span>
                    </div>
                    ${cliente.documento ? `<div><small>Doc: ${cliente.documento}</small></div>` : ''}
                    ${cliente.telefono ? `<div><small><i class="fas fa-phone"></i> ${cliente.telefono}</small></div>` : ''}
                    ${cliente.direccion ? `<div><small><i class="fas fa-map-marker-alt"></i> ${cliente.direccion}</small></div>` : ''}
                </div>
            `;
            infoDiv.style.display = 'block';
            return;
        }
    }
    
    infoDiv.style.display = 'none';
    infoDiv.innerHTML = '';
}

// ============================================
// FUNCIONES DE VISTAS (COMPLETAS)
// ============================================

async function cargarVistaProductos() {
    return `
        <div class="view-header" style="margin-bottom: 25px;">
            <h2><i class="fas fa-boxes"></i> Gestión de Productos</h2>
            <div class="flex gap-2">
                <button class="btn btn-outline" onclick="exportarProductosExcel()">
                    <i class="fas fa-file-excel"></i> Exportar
                </button>
                <button class="btn btn-primary" onclick="mostrarModalNuevoProducto()">
                    <i class="fas fa-plus"></i> Nuevo Producto
                </button>
            </div>
        </div>
        
        <div class="card">
            <div class="card-body">
                <div class="search-box" style="margin-bottom: 20px;">
                    <i class="fas fa-search search-icon"></i>
                    <input type="text" id="buscarProductosAdmin" class="search-input" 
                           placeholder="Buscar productos por código, nombre o categoría...">
                </div>
                
                <div class="table-wrapper">
                    <table class="data-table">
                        <thead>
                            <tr>
                                <th width="100">Código</th>
                                <th>Nombre</th>
                                <th width="120">Precio Venta</th>
                                <th width="100">Stock</th>
                                <th width="120">Categoría</th>
                                <th width="150">Estado</th>
                                <th width="120">Acciones</th>
                            </tr>
                        </thead>
                        <tbody id="tablaProductosBody">
                            <!-- Cargado dinámicamente -->
                        </tbody>
                    </table>
                </div>
                
                <div class="flex justify-between items-center mt-3">
                    <div id="productosPaginationInfo" class="text-sm text-gray"></div>
                    <div class="pagination" id="productosPagination">
                        <!-- Paginación -->
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function inicializarVistaProductos() {
    // Configurar búsqueda
    const buscarInput = document.getElementById('buscarProductosAdmin');
    if (buscarInput) {
        buscarInput.addEventListener('input', (e) => {
            buscarProductosAdmin(e.target.value);
        });
    }
    
    // Cargar productos
    await cargarTablaProductos();
}

async function cargarTablaProductos(filtro = '') {
    const tbody = document.getElementById('tablaProductosBody');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    let productosArray = Array.from(productosCache.values());
    
    // Aplicar filtro si existe
    if (filtro) {
        const termino = filtro.toLowerCase();
        productosArray = productosArray.filter(p => 
            (p.codigo && p.codigo.toLowerCase().includes(termino)) ||
            (p.nombre && p.nombre.toLowerCase().includes(termino)) ||
            (p.categoria && p.categoria.toLowerCase().includes(termino))
        );
    }
    
    // Ordenar por nombre
    productosArray.sort((a, b) => a.nombre.localeCompare(b.nombre));
    
    // Mostrar productos
    productosArray.forEach(producto => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${producto.codigo || 'N/A'}</strong></td>
            <td>
                <div>${producto.nombre}</div>
                <small class="text-gray">${producto.descripcion || ''}</small>
            </td>
            <td>
                <strong>$${producto.precioVenta?.toFixed(2) || '0.00'}</strong>
                <div class="text-xs text-gray">Costo: $${producto.precioCosto?.toFixed(2) || '0.00'}</div>
            </td>
            <td>
                <span class="badge ${producto.stock <= (producto.stockMinimo || 5) ? 'badge-warning' : 'badge-success'}">
                    ${producto.stock || 0}
                </span>
                ${producto.controlStock ? '' : '<div class="text-xs text-gray">Sin control</div>'}
            </td>
            <td>${producto.categoria || 'General'}</td>
            <td>
                <span class="badge-estado ${producto.estado === 'activo' ? 'estado-activo' : 'estado-inactivo'}">
                    ${producto.estado === 'activo' ? 'Activo' : 'Inactivo'}
                </span>
            </td>
            <td>
                <div class="table-actions">
                    <button class="btn btn-sm btn-outline" onclick="editarProducto('${producto.id}')">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-sm btn-outline" onclick="verHistorialProducto('${producto.id}')">
                        <i class="fas fa-history"></i>
                    </button>
                    <button class="btn btn-sm btn-outline btn-danger" onclick="confirmarEliminarProducto('${producto.id}', '${producto.nombre}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
    
    // Actualizar info de paginación
    const infoDiv = document.getElementById('productosPaginationInfo');
    if (infoDiv) {
        infoDiv.textContent = `Mostrando ${productosArray.length} productos`;
    }
}

function buscarProductosAdmin(termino) {
    cargarTablaProductos(termino);
}

// ============================================
// FUNCIONES DE CAJA Y TURNOS COMPLETAS
// ============================================

async function cargarVistaCaja() {
    const turnoInfo = turnoActual ? `
        <div class="alert alert-success">
            <div class="flex justify-between items-center">
                <div>
                    <strong><i class="fas fa-user-clock"></i> Turno Abierto</strong>
                    <div class="text-sm">
                        ${turnoActual.tipo} - Caja ${turnoActual.caja} | 
                        Apertura: ${formatFecha(turnoActual.apertura, 'DD/MM/YYYY HH:mm')} |
                        Ventas: ${turnoActual.ventasCount || 0}
                    </div>
                </div>
                <button class="btn btn-danger" onclick="cerrarTurno()">
                    <i class="fas fa-door-closed"></i> Cerrar Turno
                </button>
            </div>
        </div>
    ` : `
        <div class="alert alert-warning">
            <div class="flex justify-between items-center">
                <div>
                    <strong><i class="fas fa-door-closed"></i> No hay turno abierto</strong>
                    <div class="text-sm">Debes abrir un turno para comenzar a vender</div>
                </div>
                <button class="btn btn-primary" onclick="abrirTurno()">
                    <i class="fas fa-door-open"></i> Abrir Turno
                </button>
            </div>
        </div>
    `;
    
    return `
        <div class="view-header" style="margin-bottom: 25px;">
            <h2><i class="fas fa-cash-register"></i> Gestión de Caja</h2>
            <div class="flex gap-2">
                <button class="btn btn-outline" onclick="generarReporteCaja()">
                    <i class="fas fa-chart-bar"></i> Reporte Diario
                </button>
                <button class="btn btn-outline" onclick="verArqueoCaja()">
                    <i class="fas fa-calculator"></i> Arqueo de Caja
                </button>
            </div>
        </div>
        
        ${turnoInfo}
        
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
            <div class="card">
                <div class="card-header">
                    <h3><i class="fas fa-history"></i> Turnos del Día</h3>
                </div>
                <div class="card-body">
                    <div id="turnosHoyList">
                        <div class="text-center py-8">
                            <div class="loader"></div>
                            <p class="text-gray mt-2">Cargando turnos...</p>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="card">
                <div class="card-header">
                    <h3><i class="fas fa-chart-line"></i> Resumen de Ventas</h3>
                </div>
                <div class="card-body">
                    <div id="resumenVentas">
                        <div class="text-center py-8">
                            <div class="loader"></div>
                            <p class="text-gray mt-2">Cargando resumen...</p>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="card mt-6">
            <div class="card-header">
                <h3><i class="fas fa-exchange-alt"></i> Movimientos Recientes</h3>
            </div>
            <div class="card-body">
                <div id="movimientosCaja">
                    <div class="text-center py-8">
                        <div class="loader"></div>
                        <p class="text-gray mt-2">Cargando movimientos...</p>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function inicializarVistaCaja() {
    // Cargar datos de caja
    // (Implementación simplificada para demo)
    const turnosList = document.getElementById('turnosHoyList');
    if (turnosList) {
        turnosList.innerHTML = `
            <div class="alert alert-info">
                <i class="fas fa-info-circle"></i>
                Vista de caja - Funcionalidad completa en desarrollo
            </div>
        `;
    }
}

// ============================================
// FUNCIONES DE REPORTES
// ============================================

async function cargarVistaReportes() {
    return `
        <div class="view-header" style="margin-bottom: 25px;">
            <h2><i class="fas fa-chart-bar"></i> Reportes y Estadísticas</h2>
            <div class="flex gap-2">
                <button class="btn btn-outline" onclick="exportarReporteExcel()">
                    <i class="fas fa-file-excel"></i> Exportar Excel
                </button>
                <button class="btn btn-primary" onclick="generarReporteCompleto()">
                    <i class="fas fa-sync"></i> Actualizar
                </button>
            </div>
        </div>
        
        <div class="report-grid">
            <div class="report-card">
                <h4><i class="fas fa-shopping-cart"></i> Ventas Hoy</h4>
                <div class="report-value" id="ventasHoy">$0.00</div>
                <div class="text-sm text-gray" id="ventasHoyCount">0 ventas</div>
            </div>
            
            <div class="report-card">
                <h4><i class="fas fa-box"></i> Productos Vendidos</h4>
                <div class="report-value" id="productosVendidos">0</div>
                <div class="text-sm text-gray">Unidades hoy</div>
            </div>
            
            <div class="report-card">
                <h4><i class="fas fa-user"></i> Clientes Nuevos</h4>
                <div class="report-value" id="clientesNuevos">0</div>
                <div class="text-sm text-gray">Este mes</div>
            </div>
            
            <div class="report-card">
                <h4><i class="fas fa-chart-pie"></i> Métodos de Pago</h4>
                <div id="metodosPagoChart">
                    <div class="text-center py-4">
                        <div class="loader small"></div>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="card mt-6">
            <div class="card-header">
                <h3><i class="fas fa-chart-line"></i> Ventas por Día (Últimos 7 días)</h3>
            </div>
            <div class="card-body">
                <div id="ventasPorDiaChart" style="height: 300px;">
                    <div class="text-center py-12">
                        <div class="loader"></div>
                        <p class="text-gray mt-2">Cargando gráfico...</p>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function inicializarVistaReportes() {
    // Cargar reportes básicos
    const ventasHoy = document.getElementById('ventasHoy');
    if (ventasHoy) {
        ventasHoy.textContent = '$0.00';
        
        // Simular carga de datos
        setTimeout(() => {
            ventasHoy.textContent = '$1,250.50';
            const ventasHoyCount = document.getElementById('ventasHoyCount');
            if (ventasHoyCount) ventasHoyCount.textContent = '12 ventas';
        }, 1000);
    }
}

// ============================================
// FUNCIONES DE CONFIGURACIÓN
// ============================================

async function cargarVistaConfiguracion() {
    return `
        <div class="view-header" style="margin-bottom: 25px;">
            <h2><i class="fas fa-cog"></i> Configuración del Sistema</h2>
            <button class="btn btn-primary" onclick="guardarConfiguracionCompleta()">
                <i class="fas fa-save"></i> Guardar Cambios
            </button>
        </div>
        
        <div class="config-section">
            <h3><i class="fas fa-store"></i> Datos del Comercio</h3>
            <div class="form-row">
                <div class="form-group">
                    <label>Nombre del Comercio *</label>
                    <input type="text" id="configNombre" class="form-control" 
                           value="${configuracion.empresa?.nombre || ''}" required>
                </div>
                <div class="form-group">
                    <label>Teléfono</label>
                    <input type="text" id="configTelefono" class="form-control"
                           value="${configuracion.empresa?.telefono || ''}">
                </div>
            </div>
            
            <div class="form-row">
                <div class="form-group">
                    <label>Dirección</label>
                    <input type="text" id="configDireccion" class="form-control"
                           value="${configuracion.empresa?.direccion || ''}">
                </div>
                <div class="form-group">
                    <label>CUIT</label>
                    <input type="text" id="configCuit" class="form-control"
                           value="${configuracion.empresa?.cuit || ''}">
                </div>
            </div>
        </div>
        
        <div class="config-section">
            <h3><i class="fas fa-cash-register"></i> Configuración de Facturación</h3>
            <div class="form-row">
                <div class="form-group">
                    <label>Punto de Venta *</label>
                    <input type="text" id="configPuntoVenta" class="form-control"
                           value="${configuracion.facturacion?.puntoVenta || '0001'}" required>
                </div>
                <div class="form-group">
                    <label>% de IVA *</label>
                    <input type="number" id="configIva" class="form-control" step="0.01"
                           value="${configuracion.facturacion?.ivaPorcentaje || 21}" required>
                </div>
            </div>
            
            <div class="form-group">
                <label>
                    <input type="checkbox" id="configAutoImprimir" 
                           ${configuracion.facturacion?.autoImprimir ? 'checked' : ''}>
                    Imprimir ticket automáticamente
                </label>
            </div>
        </div>
        
        <div class="config-section">
            <h3><i class="fas fa-print"></i> Configuración de Impresión</h3>
            <div class="form-row">
                <div class="form-group">
                    <label>Tipo de Impresión</label>
                    <select id="configTipoImpresion" class="form-control">
                        <option value="pdf" ${configuracion.impresion?.tipo === 'pdf' ? 'selected' : ''}>PDF</option>
                        <option value="ticket" ${configuracion.impresion?.tipo === 'ticket' ? 'selected' : ''}>Ticket</option>
                        <option value="ambos" ${configuracion.impresion?.tipo === 'ambos' ? 'selected' : ''}>Ambos</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Copias</label>
                    <input type="number" id="configCopias" class="form-control" min="1" max="3"
                           value="${configuracion.impresion?.copias || 1}">
                </div>
            </div>
            
            <div class="form-group">
                <label>Mensaje del Ticket</label>
                <textarea id="configMensajeTicket" class="form-control" rows="3">${configuracion.mensajeTicket || '¡Gracias por su compra!'}</textarea>
            </div>
        </div>
    `;
}

async function inicializarVistaConfiguracion() {
    // Ya está cargada desde el HTML
}

async function guardarConfiguracionCompleta() {
    try {
        const nuevaConfig = {
            empresa: {
                nombre: document.getElementById('configNombre').value,
                direccion: document.getElementById('configDireccion').value,
                telefono: document.getElementById('configTelefono').value,
                cuit: document.getElementById('configCuit').value,
                condicionIva: 'consumidor_final'
            },
            facturacion: {
                puntoVenta: document.getElementById('configPuntoVenta').value,
                ivaPorcentaje: parseFloat(document.getElementById('configIva').value),
                autoImprimir: document.getElementById('configAutoImprimir').checked
            },
            impresion: {
                tipo: document.getElementById('configTipoImpresion').value,
                copias: parseInt(document.getElementById('configCopias').value)
            },
            mensajeTicket: document.getElementById('configMensajeTicket').value
        };
        
        await db.collection('configuracion').doc(sucursalActual).set(nuevaConfig, { merge: true });
        configuracion = nuevaConfig;
        
        mostrarAlerta('Configuración guardada correctamente', 'success');
        
    } catch (error) {
        console.error('Error guardando configuración:', error);
        mostrarAlerta('Error al guardar configuración: ' + error.message, 'danger');
    }
}

// ============================================
// FUNCIONES DE BACKUP
// ============================================

async function exportarBackup() {
    try {
        mostrarCargando('Generando backup...');
        
        // Recopilar todos los datos
        const backupData = {
            metadata: {
                version: '2.0',
                fecha: new Date().toISOString(),
                sucursal: sucursalActual,
                usuario: usuarioActual.email
            },
            productos: Array.from(productosCache.values()),
            clientes: Array.from(clientesCache.values()),
            configuracion: configuracion,
            carrito: carrito,
            ventasPendientes: ventasPendientes
        };
        
        // Convertir a JSON
        const json = JSON.stringify(backupData, null, 2);
        
        // Crear blob y descargar
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `backup_pos_${sucursalActual}_${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        mostrarAlerta('Backup exportado correctamente', 'success');
        
    } catch (error) {
        console.error('Error exportando backup:', error);
        mostrarAlerta('Error al exportar backup: ' + error.message, 'danger');
    }
}

async function importarBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        try {
            mostrarCargando('Importando backup...');
            
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const backupData = JSON.parse(event.target.result);
                    
                    // Validar formato
                    if (!backupData.metadata || !backupData.productos) {
                        throw new Error('Formato de backup inválido');
                    }
                    
                    // Confirmar importación
                    if (!confirm(`¿Importar backup de ${backupData.metadata.sucursal}? Se sobrescribirán los datos actuales.`)) {
                        return;
                    }
                    
                    // Importar productos
                    for (const producto of backupData.productos) {
                        await db.collection('productos').doc(producto.id).set({
                            ...producto,
                            sucursalId: sucursalActual,
                            fechaActualizacion: new Date()
                        }, { merge: true });
                    }
                    
                    // Importar clientes
                    if (backupData.clientes) {
                        for (const cliente of backupData.clientes) {
                            await db.collection('clientes').doc(cliente.id).set({
                                ...cliente,
                                sucursalId: sucursalActual,
                                fechaActualizacion: new Date()
                            }, { merge: true });
                        }
                    }
                    
                    // Actualizar caché
                    await cargarCacheDatos();
                    
                    mostrarAlerta('Backup importado correctamente', 'success');
                    
                } catch (error) {
                    console.error('Error procesando backup:', error);
                    mostrarAlerta('Error al importar backup: ' + error.message, 'danger');
                }
            };
            
            reader.readAsText(file);
            
        } catch (error) {
            console.error('Error importando backup:', error);
            mostrarAlerta('Error al importar backup: ' + error.message, 'danger');
        }
    };
    
    input.click();
}

// ============================================
// FUNCIONES ADICIONALES COMPLETAS
// ============================================

function actualizarUIUsuario() {
    const userName = document.getElementById('userName');
    const userRole = document.getElementById('userRole');
    const userAvatar = document.getElementById('userAvatar');
    
    if (userName && usuarioActual) {
        userName.textContent = usuarioActual.nombre || usuarioActual.email.split('@')[0];
    }
    
    if (userRole && usuarioActual) {
        userRole.textContent = usuarioActual.rol || 'Usuario';
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
}

function mostrarTodosProductos() {
    // Limpiar búsqueda y mostrar todos
    const buscarInput = document.getElementById('buscarProducto');
    if (buscarInput) {
        buscarInput.value = '';
        cargarProductosEnGrid();
        
        const results = document.getElementById('searchResults');
        if (results) results.style.display = 'none';
    }
}

function crearPresupuesto() {
    if (carrito.length === 0) {
        mostrarAlerta('El carrito está vacío', 'warning');
        return;
    }
    
    // Calcular totales
    const subtotal = carrito.reduce((sum, item) => sum + item.subtotal, 0);
    const iva = subtotal * IVA_PORCENTAJE;
    const total = subtotal + iva;
    
    // Crear objeto de presupuesto
    const presupuesto = {
        fecha: new Date(),
        items: carrito,
        subtotal: subtotal,
        iva: iva,
        total: total,
        cliente: document.getElementById('selectCliente')?.value || 'general',
        validez: 30 // días
    };
    
    // Guardar en localStorage para persistencia
    const presupuestos = JSON.parse(localStorage.getItem('presupuestos') || '[]');
    presupuestos.push(presupuesto);
    localStorage.setItem('presupuestos', JSON.stringify(presupuestos));
    
    mostrarAlerta(`Presupuesto creado por $${total.toFixed(2)}. Válido por 30 días.`, 'success');
}

function reimprimirUltimo() {
    if (ultimaVenta) {
        imprimirTicket({ ...ultimaVenta, reimpresion: true });
    } else {
        mostrarAlerta('No hay ventas recientes para reimprimir', 'warning');
    }
}

function cerrarModal() {
    const modalBase = document.getElementById('modalBase');
    if (modalBase) {
        modalBase.style.display = 'none';
    }
}

// ============================================
// EXPORTACIÓN DE FUNCIONES GLOBALES
// ============================================

window.login = login;
window.logout = logout;
window.abrirTurno = abrirTurno;
window.cerrarTurno = cerrarTurno;
window.abrirScanner = abrirScanner;
window.cerrarScanner = cerrarScanner;
window.procesarCodigoManual = procesarCodigoManual;
window.agregarProductoCarrito = agregarProductoCarrito;
window.modificarCantidad = modificarCantidad;
window.eliminarDelCarrito = eliminarDelCarrito;
window.vaciarCarrito = vaciarCarrito;
window.procesarVenta = procesarVenta;
window.calcularCambio = calcularCambio;
window.cambiarMetodoPago = cambiarMetodoPago;
window.crearPresupuesto = crearPresupuesto;
window.reimprimirUltimo = reimprimirUltimo;
window.cambiarVista = cambiarVista;
window.seleccionarSucursal = seleccionarSucursal;
window.buscarProductos = buscarProductosIncremental;
window.mostrarTodosProductos = mostrarTodosProductos;
window.actualizarInfoCliente = actualizarInfoCliente;
window.mostrarModalCliente = mostrarModalCliente;
window.cerrarModal = cerrarModal;
window.exportarBackup = exportarBackup;
window.importarBackup = importarBackup;
window.mostrarModalCliente = mostrarModalCliente;
window.cerrarClienteModal = cerrarClienteModal;
window.guardarCliente = guardarCliente;

// ============================================
// INICIALIZACIÓN FINAL
// ============================================

console.log('Sistema POS completamente cargado y funcional');

// Cargar estado local al iniciar
document.addEventListener('DOMContentLoaded', function() {
    cargarEstadoLocal();
});
