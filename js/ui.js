// ui.js - Componentes de interfaz reutilizables y gestión de vistas
// Responsabilidad exacta: Componentes de interfaz reutilizables y gestión de vistas

class UI {
    constructor() {
        this.eventListeners = new Map();
        this.templateCache = new Map();
        this.modalStack = [];
        this.loadingCount = 0;
        this.observers = new Map();
        
        this.init();
    }

    // Inicialización del sistema de UI
    init() {
        this.setupOfflineDetection();
        this.setupGlobalListeners();
        this.setupViewTransitions();
    }

    // ==================== FUNCIONES PÚBLICAS OBLIGATORIAS ====================

    /**
     * Mostrar modal accesible
     * @param {Object} config - Configuración del modal
     * @param {string} config.title - Título del modal
     * @param {string|HTMLElement} config.content - Contenido
     * @param {Array} config.buttons - Botones [{text, action, type}]
     * @param {Function} config.onClose - Callback al cerrar
     * @param {boolean} config.closeOnOutside - Cerrar al hacer clic fuera
     */
    showModal(config) {
        this.closeAllModals();
        
        const modal = this.createModal(config);
        document.body.appendChild(modal);
        
        // Manejar accesibilidad
        this.trapFocus(modal);
        this.modalStack.push(modal);
        
        // Animar entrada
        requestAnimationFrame(() => {
            modal.classList.add('active');
        });
        
        // Guardar referencia para cleanup
        const closeModal = () => this.hideModal(modal);
        this.eventListeners.set(modal, [
            { element: modal.querySelector('.modal-close'), event: 'click', handler: closeModal },
            { element: modal.querySelector('.modal-overlay'), event: 'click', handler: config.closeOnOutside ? closeModal : null },
            { element: document, event: 'keydown', handler: this.handleModalKeydown.bind(this, modal) }
        ].filter(item => item.handler));
        
        return modal;
    }

    /**
     * Mostrar notificación toast
     * @param {string} message - Mensaje a mostrar
     * @param {string} type - Tipo: 'success', 'error', 'warning', 'info'
     */
    showToast(message, type = 'info') {
        const toast = this.createToast(message, type);
        const container = this.getToastContainer();
        container.appendChild(toast);
        
        // Animar entrada
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });
        
        // Auto-remover
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 5000);
    }

    /**
     * Mostrar indicador de carga
     * @param {string} message - Mensaje opcional
     */
    showLoading(message = 'Cargando...') {
        this.loadingCount++;
        
        if (this.loadingCount === 1) {
            const loader = this.createLoader(message);
            loader.id = 'global-loader';
            document.body.appendChild(loader);
            
            // Forzar reflow para animación
            loader.offsetHeight;
            loader.classList.add('active');
        } else {
            const loader = document.getElementById('global-loader');
            if (loader) {
                const messageEl = loader.querySelector('.loader-message');
                if (messageEl) messageEl.textContent = message;
            }
        }
    }

    /**
     * Ocultar indicador de carga
     */
    hideLoading() {
        this.loadingCount = Math.max(0, this.loadingCount - 1);
        
        if (this.loadingCount === 0) {
            const loader = document.getElementById('global-loader');
            if (loader) {
                loader.classList.remove('active');
                setTimeout(() => {
                    if (loader.parentNode) loader.remove();
                }, 300);
            }
        }
    }

    /**
     * Actualizar sección de vista
     * @param {string} section - ID o selector de la sección
     * @param {Object|Array} data - Datos para renderizar
     */
    updateSection(section, data) {
        const element = this.safeGetElement(section);
        if (!element) return;
        
        // Animar actualización
        element.classList.add('updating');
        
        // Usar requestIdleCallback para no bloquear UI
        requestIdleCallback(() => {
            this.renderSection(element, data);
            
            requestAnimationFrame(() => {
                element.classList.remove('updating');
                element.classList.add('updated');
                
                setTimeout(() => {
                    element.classList.remove('updated');
                }, 300);
            });
        }, { timeout: 1000 });
    }

    /**
     * Renderizar lista de productos con virtual scrolling
     * @param {Array} products - Lista de productos
     * @param {Object} config - Configuración de renderizado
     */
    renderProductList(products, config = {}) {
        const container = this.safeGetElement(config.container || '#product-list');
        if (!container) return;
        
        // Limpiar event listeners previos
        this.cleanupContainerEvents(container);
        
        // Configurar virtual scrolling para listas grandes
        if (products.length > 50) {
            this.setupVirtualScroll(container, products, this.renderProductItem.bind(this), config);
        } else {
            this.renderFullList(container, products, this.renderProductItem.bind(this), config);
        }
        
        // Lazy loading de imágenes
        this.setupLazyLoading(container);
    }

    /**
     * Renderizar lista de ventas
     * @param {Array} sales - Lista de ventas
     * @param {Object} config - Configuración de renderizado
     */
    renderSaleList(sales, config = {}) {
        const container = this.safeGetElement(config.container || '#sale-list');
        if (!container) return;
        
        this.cleanupContainerEvents(container);
        
        if (sales.length > 50) {
            this.setupVirtualScroll(container, sales, this.renderSaleItem.bind(this), config);
        } else {
            this.renderFullList(container, sales, this.renderSaleItem.bind(this), config);
        }
    }

    /**
     * Renderizar carrito de compras
     * @param {Array} items - Items del carrito
     */
    renderCart(items) {
        const container = this.safeGetElement('#cart-container');
        if (!container) return;
        
        this.cleanupContainerEvents(container);
        
        const template = this.getTemplate('cart-template');
        container.innerHTML = template({ items });
        
        // Actualizar contadores
        this.updateCartCounters(items);
        
        // Setup eventos del carrito
        this.setupCartEvents(container, items);
    }

    /**
     * Configurar impresión para elemento específico
     * @param {string} elementId - ID del elemento a imprimir
     */
    setupPrint(elementId) {
        const element = document.getElementById(elementId);
        if (!element) return;
        
        const printBtn = element.querySelector('.print-btn') || element;
        
        this.addListener(printBtn, 'click', () => {
            const printWindow = window.open('', '_blank');
            const content = element.innerHTML;
            const styles = Array.from(document.styleSheets)
                .map(sheet => {
                    try {
                        return Array.from(sheet.cssRules)
                            .map(rule => rule.cssText)
                            .join('');
                    } catch (e) {
                        return '';
                    }
                })
                .join('');
            
            printWindow.document.write(`
                <html>
                    <head>
                        <title>Imprimir</title>
                        <style>${styles}</style>
                        <style>
                            @media print {
                                body { margin: 0; padding: 20px; }
                                .no-print { display: none !important; }
                            }
                        </style>
                    </head>
                    <body>${content}</body>
                </html>
            `);
            
            printWindow.document.close();
            printWindow.focus();
            
            setTimeout(() => {
                printWindow.print();
                printWindow.close();
            }, 250);
        });
    }

    /**
     * Configurar búsqueda con debounce
     * @param {string} inputId - ID del input de búsqueda
     * @param {Function} callback - Función a ejecutar al buscar
     * @param {number} delay - Delay en ms (por defecto 300)
     */
    setupSearch(inputId, callback, delay = 300) {
        const input = this.safeGetElement(inputId);
        if (!input || typeof callback !== 'function') return;
        
        let timeoutId;
        
        const searchHandler = (e) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => {
                callback(e.target.value.trim());
            }, delay);
        };
        
        this.addListener(input, 'input', searchHandler);
        
        // Cleanup
        this.eventListeners.set(input, [
            { element: input, event: 'input', handler: searchHandler }
        ]);
    }

    // ==================== MÉTODOS AUXILIARES ====================

    /**
     * Obtener elemento de forma segura
     */
    safeGetElement(selector) {
        if (selector instanceof HTMLElement) return selector;
        if (selector.startsWith('#')) {
            return document.getElementById(selector.slice(1));
        }
        const element = document.querySelector(selector);
        return element || null;
    }

    /**
     * Cleanup de event listeners de contenedor
     */
    cleanupContainerEvents(container) {
        const listeners = this.eventListeners.get(container);
        if (listeners) {
            listeners.forEach(({ element, event, handler }) => {
                element?.removeEventListener(event, handler);
            });
            this.eventListeners.delete(container);
        }
    }

    /**
     * Agregar listener con cleanup automático
     */
    addListener(element, event, handler) {
        element.addEventListener(event, handler);
        
        if (!this.eventListeners.has(element)) {
            this.eventListeners.set(element, []);
        }
        this.eventListeners.get(element).push({ element, event, handler });
    }

    /**
     * Setup de virtual scrolling
     */
    setupVirtualScroll(container, items, renderItem, config) {
        const itemHeight = config.itemHeight || 60;
        const buffer = 5;
        let startIndex = 0;
        
        // Calcular elementos visibles
        const updateVisibleItems = () => {
            const scrollTop = container.scrollTop;
            const visibleCount = Math.ceil(container.clientHeight / itemHeight);
            
            startIndex = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
            const endIndex = Math.min(items.length, startIndex + visibleCount + buffer * 2);
            
            // Renderizar solo elementos visibles
            const visibleItems = items.slice(startIndex, endIndex);
            const offset = startIndex * itemHeight;
            
            container.innerHTML = '';
            const wrapper = document.createElement('div');
            wrapper.style.height = `${items.length * itemHeight}px`;
            wrapper.style.position = 'relative';
            
            const content = document.createElement('div');
            content.style.position = 'absolute';
            content.style.top = `${offset}px`;
            content.style.width = '100%';
            
            visibleItems.forEach((item, index) => {
                const element = renderItem(item, startIndex + index);
                content.appendChild(element);
            });
            
            wrapper.appendChild(content);
            container.appendChild(wrapper);
        };
        
        // Configurar scroll con throttling
        let scrollTimeout;
        const handleScroll = () => {
            if (!scrollTimeout) {
                scrollTimeout = setTimeout(() => {
                    updateVisibleItems();
                    scrollTimeout = null;
                }, 16); // ~60fps
            }
        };
        
        this.addListener(container, 'scroll', handleScroll);
        updateVisibleItems();
        
        // Observar cambios de tamaño
        const resizeObserver = new ResizeObserver(handleScroll);
        resizeObserver.observe(container);
        
        this.observers.set(container, resizeObserver);
    }

    /**
     * Setup lazy loading de imágenes
     */
    setupLazyLoading(container) {
        const images = container.querySelectorAll('img[data-src]');
        
        const imageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.dataset.src;
                    img.removeAttribute('data-src');
                    imageObserver.unobserve(img);
                }
            });
        }, { rootMargin: '50px' });
        
        images.forEach(img => imageObserver.observe(img));
        
        this.observers.set(container, imageObserver);
    }

    /**
     * Sistema de templates con cache
     */
    getTemplate(templateName) {
        if (this.templateCache.has(templateName)) {
            return this.templateCache.get(templateName);
        }
        
        const templateElement = document.getElementById(templateName);
        if (!templateElement) {
            return (data) => `<div>Template ${templateName} no encontrado</div>`;
        }
        
        const templateFunc = (data) => {
            let html = templateElement.innerHTML;
            Object.keys(data).forEach(key => {
                const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
                html = html.replace(regex, data[key]);
            });
            return html;
        };
        
        this.templateCache.set(templateName, templateFunc);
        return templateFunc;
    }

    /**
     * Detección de estado offline
     */
    setupOfflineDetection() {
        const updateOnlineStatus = () => {
            const isOnline = navigator.onLine;
            document.body.classList.toggle('offline', !isOnline);
            
            // Mostrar/ocultar indicador offline
            let indicator = document.getElementById('offline-indicator');
            if (!indicator) {
                indicator = document.createElement('div');
                indicator.id = 'offline-indicator';
                indicator.className = 'offline-indicator';
                indicator.innerHTML = `
                    <div class="offline-message">
                        <span class="offline-icon">⚠️</span>
                        <span>Estás trabajando sin conexión</span>
                    </div>
                `;
                document.body.appendChild(indicator);
            }
            
            indicator.classList.toggle('show', !isOnline);
            
            // Deshabilitar acciones no disponibles offline
            this.toggleOfflineActions(!isOnline);
        };
        
        window.addEventListener('online', updateOnlineStatus);
        window.addEventListener('offline', updateOnlineStatus);
        
        updateOnlineStatus();
    }

    /**
     * Deshabilitar/habilitar acciones offline
     */
    toggleOfflineActions(offline) {
        const selectors = [
            '[data-requires-online]',
            '.requires-online',
            'button[type="submit"]',
            '.sync-button'
        ];
        
        selectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(element => {
                if (offline) {
                    element.setAttribute('disabled', 'true');
                    element.setAttribute('title', 'No disponible sin conexión');
                } else {
                    element.removeAttribute('disabled');
                    element.removeAttribute('title');
                }
            });
        });
    }

    /**
     * Configurar transiciones entre vistas
     */
    setupViewTransitions() {
        // Usar la API de View Transitions si está disponible
        if (document.startViewTransition) {
            // Interceptar navegación
            document.addEventListener('click', (e) => {
                const anchor = e.target.closest('a[data-view-transition]');
                if (anchor) {
                    e.preventDefault();
                    document.startViewTransition(() => {
                        window.location.href = anchor.href;
                    });
                }
            });
        }
    }

    /**
     * Focus trap para modales
     */
    trapFocus(modal) {
        const focusableElements = modal.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];
        
        const handleTabKey = (e) => {
            if (e.key !== 'Tab') return;
            
            if (e.shiftKey) {
                if (document.activeElement === firstElement) {
                    lastElement.focus();
                    e.preventDefault();
                }
            } else {
                if (document.activeElement === lastElement) {
                    firstElement.focus();
                    e.preventDefault();
                }
            }
        };
        
        modal.addEventListener('keydown', handleTabKey);
        firstElement?.focus();
        
        // Guardar listener para cleanup
        const listeners = this.eventListeners.get(modal) || [];
        listeners.push({ element: modal, event: 'keydown', handler: handleTabKey });
        this.eventListeners.set(modal, listeners);
    }

    /**
     * Manejar teclado en modales
     */
    handleModalKeydown(modal, e) {
        if (e.key === 'Escape') {
            this.hideModal(modal);
        }
    }

    /**
     * Cerrar modal específico
     */
    hideModal(modal) {
        modal.classList.remove('active');
        setTimeout(() => {
            if (modal.parentNode) modal.remove();
            this.modalStack = this.modalStack.filter(m => m !== modal);
            
            // Cleanup listeners
            const listeners = this.eventListeners.get(modal);
            if (listeners) {
                listeners.forEach(({ element, event, handler }) => {
                    element?.removeEventListener(event, handler);
                });
                this.eventListeners.delete(modal);
            }
            
            // Restaurar focus
            const lastModal = this.modalStack[this.modalStack.length - 1];
            if (lastModal) {
                lastModal.focus();
            }
        }, 300);
    }

    /**
     * Cerrar todos los modales
     */
    closeAllModals() {
        this.modalStack.forEach(modal => {
            this.hideModal(modal);
        });
    }

    // ==================== MÉTODOS DE RENDERIZADO ====================

    renderProductItem(product, index) {
        const template = this.getTemplate('product-item-template');
        const element = this.createElementFromString(template(product));
        
        // Lazy load para imagen
        const img = element.querySelector('.product-img');
        if (img) {
            img.dataset.src = product.image;
            img.src = '/placeholder.jpg'; // Imagen placeholder
        }
        
        return element;
    }

    renderSaleItem(sale, index) {
        const template = this.getTemplate('sale-item-template');
        return this.createElementFromString(template(sale));
    }

    renderFullList(container, items, renderItem, config) {
        container.innerHTML = '';
        
        // Fragmento para mejor performance
        const fragment = document.createDocumentFragment();
        
        items.forEach((item, index) => {
            const element = renderItem(item, index);
            fragment.appendChild(element);
        });
        
        container.appendChild(fragment);
    }

    createElementFromString(html) {
        const template = document.createElement('template');
        template.innerHTML = html.trim();
        return template.content.firstElementChild;
    }

    // ==================== CLEANUP ====================

    /**
     * Limpieza completa de recursos
     */
    cleanup() {
        // Remover todos los event listeners
        this.eventListeners.forEach((listeners, element) => {
            listeners.forEach(({ event, handler }) => {
                element.removeEventListener(event, handler);
            });
        });
        this.eventListeners.clear();
        
        // Desconectar observers
        this.observers.forEach((observer, element) => {
            observer.disconnect();
        });
        this.observers.clear();
        
        // Limpiar modales
        this.closeAllModals();
        
        // Limpiar loaders
        const loader = document.getElementById('global-loader');
        if (loader) loader.remove();
    }
}

// Instancia global única
const ui = new UI();

// Exportar para uso global (ajustar según sistema de módulos)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ui;
} else {
    window.UI = ui;
}

// Polyfill para requestIdleCallback
if (!window.requestIdleCallback) {
    window.requestIdleCallback = (callback) => {
        return setTimeout(() => {
            const start = Date.now();
            callback({
                didTimeout: false,
                timeRemaining: () => Math.max(0, 50 - (Date.now() - start))
            });
        }, 1);
    };
}

if (!window.cancelIdleCallback) {
    window.cancelIdleCallback = (id) => {
        clearTimeout(id);
    };
}
