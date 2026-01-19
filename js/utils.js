// utils.js - Utilidades generales y funciones helper
// Responsabilidad: Funciones puras y helpers reutilizables
// Reglas: Offline, tiempo real, sin dependencias externas

// ============================================================================
// FORMATO DE MONEDA
// ============================================================================

/**
 * Formatea un monto numérico a moneda con separadores de miles y decimales
 * @param {number|string} amount - Monto a formatear
 * @param {Object} options - Opciones de formato
 * @param {string} options.symbol - Símbolo de moneda (default: '$')
 * @param {number} options.decimals - Decimales (default: 2)
 * @param {string} options.thousandsSeparator - Separador de miles (default: '.')
 * @param {string} options.decimalSeparator - Separador decimal (default: ',')
 * @returns {string} Monto formateado como moneda
 */
export const formatCurrency = (amount, options = {}) => {
  const {
    symbol = '$',
    decimals = 2,
    thousandsSeparator = '.',
    decimalSeparator = ','
  } = options;

  // Validar input
  if (amount === null || amount === undefined || amount === '') {
    return `${symbol} 0${decimalSeparator}${'0'.repeat(decimals)}`;
  }

  // Convertir a número
  const numericAmount = typeof amount === 'string' 
    ? parseFloat(amount.replace(',', '.')) 
    : Number(amount);

  if (isNaN(numericAmount)) {
    throw new Error('Invalid amount for currency formatting');
  }

  // Redondear a decimales especificados
  const rounded = Math.abs(numericAmount).toFixed(decimals);
  const [integerPart, decimalPart] = rounded.split('.');

  // Agrupar miles
  let formattedInteger = '';
  for (let i = integerPart.length - 1, j = 0; i >= 0; i--, j++) {
    if (j > 0 && j % 3 === 0) {
      formattedInteger = thousandsSeparator + formattedInteger;
    }
    formattedInteger = integerPart[i] + formattedInteger;
  }

  const sign = numericAmount < 0 ? '-' : '';
  const decimalValue = decimalPart ? decimalPart.padEnd(decimals, '0') : '0'.repeat(decimals);

  return `${sign}${symbol} ${formattedInteger}${decimalSeparator}${decimalValue}`;
};

// ============================================================================
// FORMATO DE FECHAS
// ============================================================================

/**
 * Formatea una fecha según el patrón especificado
 * @param {Date|string|number} date - Fecha a formatear
 * @param {string} format - Formato de salida (ej: 'DD/MM/YYYY HH:mm')
 * @returns {string} Fecha formateada
 */
export const formatDate = (date, format = 'DD/MM/YYYY') => {
  let dateObj;

  // Convertir entrada a Date
  if (date instanceof Date) {
    dateObj = date;
  } else if (typeof date === 'string' || typeof date === 'number') {
    dateObj = new Date(date);
    if (isNaN(dateObj.getTime())) {
      throw new Error('Invalid date input');
    }
  } else {
    throw new Error('Invalid date type');
  }

  // Extraer componentes de la fecha
  const day = dateObj.getDate().toString().padStart(2, '0');
  const month = (dateObj.getMonth() + 1).toString().padStart(2, '0');
  const year = dateObj.getFullYear();
  const hours = dateObj.getHours().toString().padStart(2, '0');
  const minutes = dateObj.getMinutes().toString().padStart(2, '0');
  const seconds = dateObj.getSeconds().toString().padStart(2, '0');

  // Reemplazar tokens
  return format
    .replace('DD', day)
    .replace('MM', month)
    .replace('YYYY', year)
    .replace('YY', year.toString().slice(-2))
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds);
};

// ============================================================================
// GENERACIÓN DE IDs ÚNICOS
// ============================================================================

/**
 * Genera un ID único compatible con Firestore
 * @param {string} type - Tipo de ID (opcional, para prefijo)
 * @returns {string} ID único
 */
export const generateId = (type = '') => {
  // Usa timestamp + random para garantizar unicidad
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  const id = `${timestamp}${random}`.padEnd(20, '0').substring(0, 20);
  
  // Firestore IDs: solo letras minúsculas, números, sin caracteres especiales
  const firestoreId = id.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  return type ? `${type}_${firestoreId}` : firestoreId;
};

// ============================================================================
// DEBOUNCE FUNCTION
// ============================================================================

/**
 * Implementa debounce para limitar llamadas frecuentes
 * @param {Function} func - Función a debouncear
 * @param {number} wait - Tiempo de espera en ms
 * @returns {Function} Función debounceada
 */
export const debounce = (func, wait) => {
  let timeout;
  
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func.apply(this, args);
    };
    
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
};

// ============================================================================
// THROTTLE FUNCTION
// ============================================================================

/**
 * Implementa throttle para limitar ejecuciones por tiempo
 * @param {Function} func - Función a throttlear
 * @param {number} limit - Límite de tiempo en ms
 * @returns {Function} Función throttleada
 */
export const throttle = (func, limit) => {
  let inThrottle;
  
  return function executedFunction(...args) {
    if (!inThrottle) {
      func.apply(this, args);
      inThrottle = true;
      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
};

// ============================================================================
// DEEP CLONE
// ============================================================================

/**
 * Clona profundamente un objeto o array
 * @param {*} obj - Objeto a clonar
 * @returns {*} Clon profundo del objeto
 */
export const deepClone = (obj) => {
  // Casos base: primitivos, null, undefined
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Cache para manejar referencias circulares
  const cache = new WeakMap();
  
  const clone = (item) => {
    // Si ya fue clonado, retornar el clon
    if (cache.has(item)) {
      return cache.get(item);
    }

    let cloned;
    
    // Arrays
    if (Array.isArray(item)) {
      cloned = [];
      cache.set(item, cloned);
      item.forEach((value, index) => {
        cloned[index] = clone(value);
      });
      return cloned;
    }

    // Date
    if (item instanceof Date) {
      cloned = new Date(item.getTime());
      cache.set(item, cloned);
      return cloned;
    }

    // RegExp
    if (item instanceof RegExp) {
      cloned = new RegExp(item.source, item.flags);
      cache.set(item, cloned);
      return cloned;
    }

    // Map
    if (item instanceof Map) {
      cloned = new Map();
      cache.set(item, cloned);
      item.forEach((value, key) => {
        cloned.set(key, clone(value));
      });
      return cloned;
    }

    // Set
    if (item instanceof Set) {
      cloned = new Set();
      cache.set(item, cloned);
      item.forEach(value => {
        cloned.add(clone(value));
      });
      return cloned;
    }

    // Objetos planos
    cloned = {};
    cache.set(item, cloned);
    
    // Usar Reflect.ownKeys para incluir propiedades no enumerables y símbolos
    Reflect.ownKeys(item).forEach(key => {
      cloned[key] = clone(item[key]);
    });
    
    return cloned;
  };

  return clone(obj);
};

// ============================================================================
// VALIDACIONES
// ============================================================================

/**
 * Valida formato de email
 * @param {string} email - Email a validar
 * @returns {boolean} true si el email es válido
 */
export const validateEmail = (email) => {
  if (typeof email !== 'string') return false;
  
  const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailRegex.test(email.trim());
};

/**
 * Valida DNI argentino (7 u 8 dígitos)
 * @param {string|number} dni - DNI a validar
 * @returns {boolean} true si el DNI es válido
 */
export const validateDNI = (dni) => {
  if (!dni) return false;
  
  const dniStr = dni.toString().trim();
  const dniRegex = /^\d{7,8}$/;
  
  return dniRegex.test(dniStr);
};

// ============================================================================
// CÁLCULOS
// ============================================================================

/**
 * Calcula porcentaje de un valor
 * @param {number} value - Valor base
 * @param {number} percentage - Porcentaje a calcular
 * @returns {number} Resultado del cálculo
 */
export const calculatePercentage = (value, percentage) => {
  if (typeof value !== 'number' || typeof percentage !== 'number') {
    throw new Error('Both parameters must be numbers');
  }
  
  return (value * percentage) / 100;
};

// ============================================================================
// MANIPULACIÓN DE DATOS
// ============================================================================

/**
 * Agrupa elementos de un array por clave
 * @param {Array} array - Array a agrupar
 * @param {string|Function} key - Clave para agrupar (string o función)
 * @returns {Object} Objeto con grupos
 */
export const groupBy = (array, key) => {
  if (!Array.isArray(array)) {
    throw new Error('First parameter must be an array');
  }

  return array.reduce((groups, item) => {
    const groupKey = typeof key === 'function' 
      ? key(item)
      : item[key];
    
    if (groupKey === undefined || groupKey === null) {
      const undefinedKey = 'undefined';
      if (!groups[undefinedKey]) {
        groups[undefinedKey] = [];
      }
      groups[undefinedKey].push(item);
    } else {
      if (!groups[groupKey]) {
        groups[groupKey] = [];
      }
      groups[groupKey].push(item);
    }
    
    return groups;
  }, {});
};

// ============================================================================
// CACHE DE CÁLCULOS FRECUENTES (Memoization)
// ============================================================================

/**
 * Crea una versión memoizada de una función
 * @param {Function} fn - Función a memoizar
 * @returns {Function} Función memoizada
 */
export const memoize = (fn) => {
  const cache = new Map();
  
  return (...args) => {
    const key = JSON.stringify(args);
    
    if (cache.has(key)) {
      return cache.get(key);
    }
    
    const result = fn(...args);
    cache.set(key, result);
    return result;
  };
};

// ============================================================================
// UTILIDADES ADICIONALES PARA PERFORMANCE
// ============================================================================

/**
 * Verifica si un valor es objeto plano (no array, date, regexp, etc.)
 * @param {*} value - Valor a verificar
 * @returns {boolean} true si es objeto plano
 */
export const isPlainObject = (value) => {
  return value !== null && 
         typeof value === 'object' && 
         value.constructor === Object &&
         Object.prototype.toString.call(value) === '[object Object]';
};

/**
 * Combina múltiples objetos sin mutar los originales
 * @param {...Object} objects - Objetos a combinar
 * @returns {Object} Nuevo objeto combinado
 */
export const mergeObjects = (...objects) => {
  return objects.reduce((merged, current) => {
    if (!current || typeof current !== 'object') return merged;
    
    Object.keys(current).forEach(key => {
      const currentVal = current[key];
      const mergedVal = merged[key];
      
      if (isPlainObject(currentVal) && isPlainObject(mergedVal)) {
        merged[key] = mergeObjects(mergedVal, currentVal);
      } else {
        merged[key] = deepClone(currentVal);
      }
    });
    
    return merged;
  }, {});
};

/**
 * Genera un hash simple para strings (no criptográfico)
 * @param {string} str - String a hashear
 * @returns {string} Hash del string
 */
export const simpleHash = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convertir a 32-bit integer
  }
  return Math.abs(hash).toString(36);
};

// ============================================================================
// EXPORTACIÓN POR DEFECTO
// ============================================================================

export default {
  formatCurrency,
  formatDate,
  generateId,
  debounce,
  throttle,
  deepClone,
  validateEmail,
  validateDNI,
  calculatePercentage,
  groupBy,
  memoize,
  isPlainObject,
  mergeObjects,
  simpleHash
};
