/**
 * Módulo de gestión de carrito de compras para sistema POS
 * Responsabilidad: Gestión del carrito y proceso de venta
 * Almacenamiento: localStorage
 * Compatibilidad: Online/Offline
 */

class CartManager {
  constructor(localId, userId, permissions = {}) {
    this.localId = localId;
    this.userId = userId;
    this.permissions = permissions;
    this.cartKey = `cart_${localId}_${userId}`;
    this.cacheKey = `productCache_${localId}`;
    this.holdTimeout = null;
    this.init();
  }

  // Inicialización del carrito
  init() {
    if (!this.getCartFromStorage()) {
      this.saveCartToStorage({
        items: [],
        discounts: {},
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        saleId: this.generateSaleId(),
        subtotal: 0,
        tax: 0,
        total: 0,
        appliedDiscounts: []
      });
    }
    this.setupRealtimeListeners();
  }

  // Generar ID único para venta
  generateSaleId() {
    return `SALE_${this.localId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Obtener carrito desde localStorage
  getCartFromStorage() {
    try {
      const cartData = localStorage.getItem(this.cartKey);
      return cartData ? JSON.parse(cartData) : null;
    } catch (error) {
      console.error('Error al leer carrito:', error);
      return null;
    }
  }

  // Guardar carrito en localStorage
  saveCartToStorage(cart) {
    try {
      cart.updatedAt = new Date().toISOString();
      localStorage.setItem(this.cartKey, JSON.stringify(cart));
      this.dispatchCartUpdate(cart);
      return true;
    } catch (error) {
      console.error('Error al guardar carrito:', error);
      return false;
    }
  }

  // Disparar evento de actualización
  dispatchCartUpdate(cart) {
    const event = new CustomEvent('cartUpdated', { detail: cart });
    window.dispatchEvent(event);
  }

  // Obtener caché de productos
  getProductCache() {
    try {
      const cache = localStorage.getItem(this.cacheKey);
      return cache ? JSON.parse(cache) : {};
    } catch {
      return {};
    }
  }

  // Actualizar caché de producto individual
  updateProductCache(productId, data) {
    const cache = this.getProductCache();
    cache[productId] = {
      ...cache[productId],
      ...data,
      lastUpdated: new Date().toISOString()
    };
    localStorage.setItem(this.cacheKey, JSON.stringify(cache));
  }

  // Validar stock disponible
  validateStock(productId, requestedQuantity) {
    const cache = this.getProductCache();
    const product = cache[productId];
    
    if (!product) {
      throw new Error('Producto no encontrado en caché');
    }

    if (!product.active) {
      throw new Error('Producto desactivado');
    }

    const cart = this.getCartFromStorage();
    const currentInCart = cart.items
      .filter(item => item.productId === productId)
      .reduce((sum, item) => sum + item.quantity, 0);

    const availableStock = (product.stock || 0) - currentInCart;
    
    if (requestedQuantity > availableStock) {
      throw new Error(`Stock insuficiente. Disponible: ${availableStock}`);
    }

    return {
      available: availableStock,
      price: product.price,
      cost: product.cost,
      name: product.name
    };
  }

  // 1. Agregar producto al carrito
  async addToCart(product, quantity) {
    try {
      // Validaciones básicas
      if (!product || !product.id) {
        throw new Error('Producto inválido');
      }

      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error('Cantidad inválida');
      }

      // Validar stock
      const stockInfo = this.validateStock(product.id, quantity);
      
      // Prevenir precio menor al costo
      if (product.price < stockInfo.cost) {
        throw new Error('El precio no puede ser menor al costo');
      }

      const cart = this.getCartFromStorage();
      const existingItemIndex = cart.items.findIndex(
        item => item.productId === product.id && item.price === product.price
      );

      let newItems;
      if (existingItemIndex >= 0) {
        // Actualizar cantidad existente
        newItems = [...cart.items];
        newItems[existingItemIndex].quantity += quantity;
        newItems[existingItemIndex].subtotal = this.calculateItemSubtotal(
          newItems[existingItemIndex]
        );
      } else {
        // Agregar nuevo item
        const newItem = {
          id: `item_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          productId: product.id,
          name: stockInfo.name || product.name,
          price: product.price,
          originalPrice: product.price, // Guardar precio original
          quantity: quantity,
          subtotal: product.price * quantity,
          cost: stockInfo.cost,
          addedAt: new Date().toISOString(),
          discounts: []
        };
        newItems = [...cart.items, newItem];
      }

      // Actualizar carrito
      cart.items = newItems;
      this.recalculateCart(cart);
      
      // Guardar cambios
      this.saveCartToStorage(cart);
      
      // Notificar éxito
      this.dispatchNotification('Producto agregado al carrito', 'success');
      
      return {
        success: true,
        cart: cart,
        item: existingItemIndex >= 0 ? newItems[existingItemIndex] : newItems[newItems.length - 1]
      };
    } catch (error) {
      console.error('Error al agregar al carrito:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // 2. Remover producto del carrito
  removeFromCart(itemId) {
    try {
      const cart = this.getCartFromStorage();
      const initialLength = cart.items.length;
      
      cart.items = cart.items.filter(item => item.id !== itemId);
      
      if (cart.items.length === initialLength) {
        throw new Error('Item no encontrado en el carrito');
      }

      this.recalculateCart(cart);
      this.saveCartToStorage(cart);
      
      this.dispatchNotification('Producto removido del carrito', 'success');
      return { success: true, cart: cart };
    } catch (error) {
      console.error('Error al remover del carrito:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // 3. Actualizar cantidad de item
  async updateCartItem(itemId, quantity) {
    try {
      if (!Number.isInteger(quantity) || quantity < 0) {
        throw new Error('Cantidad inválida');
      }

      if (quantity === 0) {
        return this.removeFromCart(itemId);
      }

      const cart = this.getCartFromStorage();
      const itemIndex = cart.items.findIndex(item => item.id === itemId);
      
      if (itemIndex === -1) {
        throw new Error('Item no encontrado');
      }

      const item = cart.items[itemIndex];
      const quantityChange = quantity - item.quantity;
      
      if (quantityChange > 0) {
        // Validar stock adicional
        const stockInfo = this.validateStock(item.productId, quantityChange);
        
        // Verificar si el precio cambió
        if (Math.abs(stockInfo.price - item.originalPrice) > 0.01) {
          this.dispatchNotification(
            `El precio del producto cambió de $${item.originalPrice} a $${stockInfo.price}`,
            'warning'
          );
          item.originalPrice = stockInfo.price;
          item.price = stockInfo.price;
        }
      }

      item.quantity = quantity;
      item.subtotal = this.calculateItemSubtotal(item);
      
      this.recalculateCart(cart);
      this.saveCartToStorage(cart);
      
      return { success: true, cart: cart, item: item };
    } catch (error) {
      console.error('Error al actualizar cantidad:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // 4. Vaciar carrito
  clearCart() {
    try {
      const emptyCart = {
        items: [],
        discounts: {},
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        saleId: this.generateSaleId(),
        subtotal: 0,
        tax: 0,
        total: 0,
        appliedDiscounts: []
      };
      
      this.saveCartToStorage(emptyCart);
      this.dispatchNotification('Carrito vaciado', 'success');
      
      return { success: true, cart: emptyCart };
    } catch (error) {
      console.error('Error al vaciar carrito:', error);
      return { success: false, error: error.message };
    }
  }

  // 5. Obtener carrito actual
  getCart() {
    return this.getCartFromStorage();
  }

  // 6. Calcular total del carrito
  getCartTotal() {
    const cart = this.getCartFromStorage();
    return {
      subtotal: cart.subtotal,
      tax: cart.tax,
      total: cart.total,
      itemsCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
      itemsTotal: cart.items.length
    };
  }

  // 7. Aplicar descuento general
  applyDiscount(percentage) {
    try {
      // Validar permisos de descuento
      if (!this.permissions.canApplyDiscount) {
        throw new Error('No tiene permisos para aplicar descuentos');
      }

      const maxDiscount = this.permissions.maxDiscount || 50;
      if (percentage > maxDiscount) {
        throw new Error(`El descuento no puede superar el ${maxDiscount}%`);
      }

      const cart = this.getCartFromStorage();
      
      // Aplicar límite de descuento si existe
      const discountLimit = this.permissions.discountLimit;
      const discountAmount = (cart.subtotal * percentage) / 100;
      
      if (discountLimit && discountAmount > discountLimit) {
        percentage = (discountLimit / cart.subtotal) * 100;
        this.dispatchNotification(
          `Descuento limitado a $${discountLimit.toFixed(2)}`,
          'warning'
        );
      }

      cart.discounts.general = {
        percentage: percentage,
        amount: (cart.subtotal * percentage) / 100,
        appliedAt: new Date().toISOString(),
        appliedBy: this.userId
      };

      this.recalculateCart(cart);
      this.saveCartToStorage(cart);
      
      this.dispatchNotification(`Descuento del ${percentage}% aplicado`, 'success');
      return { success: true, cart: cart };
    } catch (error) {
      console.error('Error al aplicar descuento:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // 8. Aplicar descuento a item específico
  applyItemDiscount(itemId, discount) {
    try {
      // Validar permisos
      if (!this.permissions.canApplyItemDiscount) {
        throw new Error('No tiene permisos para aplicar descuentos por item');
      }

      const cart = this.getCartFromStorage();
      const itemIndex = cart.items.findIndex(item => item.id === itemId);
      
      if (itemIndex === -1) {
        throw new Error('Item no encontrado');
      }

      const item = cart.items[itemIndex];
      
      // Validar que el descuento no haga el precio menor al costo
      const discountedPrice = item.price * (1 - discount / 100);
      if (discountedPrice < item.cost) {
        throw new Error('El descuento haría que el precio sea menor al costo');
      }

      // Aplicar descuento
      item.discounts.push({
        percentage: discount,
        amount: (item.subtotal * discount) / 100,
        appliedAt: new Date().toISOString(),
        appliedBy: this.userId
      });

      item.subtotal = this.calculateItemSubtotal(item);
      
      this.recalculateCart(cart);
      this.saveCartToStorage(cart);
      
      this.dispatchNotification(`Descuento aplicado al item`, 'success');
      return { success: true, cart: cart, item: item };
    } catch (error) {
      console.error('Error al aplicar descuento al item:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // 9. Dividir pago en múltiples medios
  splitPayment(amounts) {
    try {
      const cart = this.getCartFromStorage();
      const total = cart.total;
      const sumAmounts = amounts.reduce((sum, amount) => sum + amount, 0);
      
      // Validar que la suma coincida con el total
      if (Math.abs(sumAmounts - total) > 0.01) {
        throw new Error(`La suma de los pagos ($${sumAmounts.toFixed(2)}) no coincide con el total ($${total.toFixed(2)})`);
      }

      const paymentSplit = {
        total: total,
        amounts: amounts,
        timestamp: new Date().toISOString(),
        status: 'pending'
      };

      // Guardar división de pago
      cart.paymentSplit = paymentSplit;
      this.saveCartToStorage(cart);
      
      return { success: true, paymentSplit: paymentSplit };
    } catch (error) {
      console.error('Error al dividir el pago:', error);
      return { success: false, error: error.message };
    }
  }

  // 10. Pausar venta actual
  holdCart() {
    try {
      const cart = this.getCartFromStorage();
      
      if (cart.items.length === 0) {
        throw new Error('No hay items en el carrito para pausar');
      }

      cart.status = 'hold';
      cart.heldAt = new Date().toISOString();
      cart.heldBy = this.userId;
      
      this.saveCartToStorage(cart);
      
      // Configurar timeout para liberación automática (30 minutos)
      if (this.holdTimeout) clearTimeout(this.holdTimeout);
      this.holdTimeout = setTimeout(() => {
        this.releaseHeldCart();
      }, 30 * 60 * 1000);
      
      this.dispatchNotification('Venta pausada', 'success');
      return { success: true, cart: cart };
    } catch (error) {
      console.error('Error al pausar venta:', error);
      this.dispatchNotification(error.message, 'error');
      return { success: false, error: error.message };
    }
  }

  // Liberar carrito pausado automáticamente
  releaseHeldCart() {
    const cart = this.getCartFromStorage();
    if (cart.status === 'hold') {
      cart.status = 'active';
      this.saveCartToStorage(cart);
      this.dispatchNotification('Venta en pausa liberada automáticamente', 'warning');
    }
  }

  // Calcular subtotal de item con descuentos
  calculateItemSubtotal(item) {
    let subtotal = item.price * item.quantity;
    
    if (item.discounts && item.discounts.length > 0) {
      const totalDiscount = item.discounts.reduce((sum, discount) => sum + discount.amount, 0);
      subtotal -= totalDiscount;
    }
    
    // Redondear a 2 decimales
    return Math.round(subtotal * 100) / 100;
  }

  // Recalcular totales del carrito
  recalculateCart(cart) {
    // Calcular subtotal de items
    cart.subtotal = cart.items.reduce((sum, item) => sum + item.subtotal, 0);
    
    // Aplicar descuento general
    let discountAmount = 0;
    if (cart.discounts && cart.discounts.general) {
      discountAmount = cart.discounts.general.amount;
    }
    
    // Calcular IVA (16% como ejemplo)
    const taxableAmount = cart.subtotal - discountAmount;
    cart.tax = Math.round(taxableAmount * 0.16 * 100) / 100;
    
    // Calcular total
    cart.total = Math.round((taxableAmount + cart.tax) * 100) / 100;
    
    return cart;
  }

  // Configurar listeners en tiempo real
  setupRealtimeListeners() {
    // Escuchar cambios en productos desde Firestore (implementación específica)
    // Esta es una implementación genérica que debe adaptarse
    window.addEventListener('productUpdated', (event) => {
      this.handleProductUpdate(event.detail);
    });

    window.addEventListener('online', () => {
      this.syncCartWithServer();
    });
  }

  // Manejar actualización de producto en tiempo real
  handleProductUpdate(productUpdate) {
    const cart = this.getCartFromStorage();
    const affectedItems = cart.items.filter(item => item.productId === productUpdate.id);
    
    if (affectedItems.length > 0) {
      // Notificar cambios de precio
      if (productUpdate.priceChanged) {
        this.dispatchNotification(
          `El precio de ${productUpdate.name} ha cambiado. Verifique el carrito.`,
          'warning'
        );
      }
      
      // Marcar productos desactivados
      if (productUpdate.active === false) {
        affectedItems.forEach(item => {
          item.disabled = true;
          item.disabledReason = 'Producto desactivado';
        });
        this.dispatchNotification(
          `Un producto en su carrito ha sido desactivado`,
          'error'
        );
      }
      
      this.saveCartToStorage(cart);
    }
    
    // Actualizar caché
    this.updateProductCache(productUpdate.id, productUpdate);
  }

  // Sincronizar con servidor cuando esté online
  async syncCartWithServer() {
    try {
      const cart = this.getCartFromStorage();
      
      // Verificar stock real con servidor
      for (const item of cart.items) {
        const stockResponse = await this.checkServerStock(item.productId);
        
        if (stockResponse.available < item.quantity) {
          item.disabled = true;
          item.disabledReason = `Stock insuficiente. Disponible: ${stockResponse.available}`;
        }
        
        // Actualizar caché con información del servidor
        this.updateProductCache(item.productId, {
          stock: stockResponse.available,
          price: stockResponse.price,
          lastSynced: new Date().toISOString()
        });
      }
      
      this.saveCartToStorage(cart);
      
    } catch (error) {
      console.error('Error en sincronización:', error);
    }
  }

  // Verificar stock en servidor (implementación específica)
  async checkServerStock(productId) {
    // Implementar según tu backend
    return { available: 0, price: 0 };
  }

  // Disparar notificación
  dispatchNotification(message, type = 'info') {
    const event = new CustomEvent('cartNotification', {
      detail: { message, type, timestamp: new Date().toISOString() }
    });
    window.dispatchEvent(event);
  }

  // Métodos adicionales para integración

  // Restaurar venta pausada
  resumeHold(saleId) {
    const holdKey = `hold_${saleId}`;
    const heldCart = localStorage.getItem(holdKey);
    
    if (heldCart) {
      localStorage.setItem(this.cartKey, heldCart);
      localStorage.removeItem(holdKey);
      this.dispatchNotification('Venta reanudada', 'success');
      return JSON.parse(heldCart);
    }
    
    return null;
  }

  // Exportar datos del carrito para backend
  exportCartForCheckout() {
    const cart = this.getCartFromStorage();
    
    return {
      saleId: cart.saleId,
      localId: this.localId,
      userId: this.userId,
      items: cart.items.map(item => ({
        productId: item.productId,
        quantity: item.quantity,
        price: item.price,
        originalPrice: item.originalPrice,
        discounts: item.discounts,
        subtotal: item.subtotal
      })),
      totals: {
        subtotal: cart.subtotal,
        tax: cart.tax,
        total: cart.total,
        discount: cart.discounts?.general?.amount || 0
      },
      discounts: cart.discounts,
      metadata: {
        createdAt: cart.createdAt,
        updatedAt: cart.updatedAt,
        itemsCount: cart.items.length,
        totalItems: cart.items.reduce((sum, item) => sum + item.quantity, 0)
      }
    };
  }
}

// Exportar clase para uso global
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CartManager;
} else {
  window.CartManager = CartManager;
}

// Inicialización automática si hay datos en localStorage
document.addEventListener('DOMContentLoaded', () => {
  // Buscar carrito existente
  const cartKeys = Object.keys(localStorage).filter(key => key.startsWith('cart_'));
  
  if (cartKeys.length > 0) {
    const cartKey = cartKeys[0];
    const parts = cartKey.split('_');
    
    if (parts.length >= 3) {
      const localId = parts[1];
      const userId = parts[2];
      
      // Inicializar automáticamente si no existe instancia global
      if (!window.currentCart) {
        window.currentCart = new CartManager(localId, userId);
      }
    }
  }
});
