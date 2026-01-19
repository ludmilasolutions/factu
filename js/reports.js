// reports.js - Módulo de Reportes y Estadísticas
import { collection, query, where, getDocs } from 'firebase/firestore';
import { WorkerManager } from './workers/ReportWorker';
import { CacheManager } from './cache/ReportCache';
import { OfflineManager } from './offline/ReportOffline';
import { format, subDays } from 'date-fns';
import { validatePermissions, REPORT_PERMISSIONS } from './security/permissions';
import { TIMEZONE } from '../config/constants';

const MAX_REPORT_DAYS = 90;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const PRE_CALCULATED_REPORTS = ['dashboard', 'stock'];

export class ReportsManager {
  constructor(db, auth) {
    this.db = db;
    this.auth = auth;
    this.cache = new CacheManager();
    this.offline = new OfflineManager(db);
    this.workerManager = new WorkerManager();
    this.scheduledReports = new Map();
  }

  // ========== FUNCIONES PRINCIPALES ==========

  /**
   * Reporte de ventas con filtros
   * @param {Object} dateRange - {start: Date, end: Date}
   * @param {Object} filters - {productId, category, paymentMethod}
   */
  async getSalesReport(dateRange, filters = {}) {
    await validatePermissions(this.auth, REPORT_PERMISSIONS.SALES);
    this._validateDateRange(dateRange);
    
    const cacheKey = `sales_${dateRange.start}_${dateRange.end}_${JSON.stringify(filters)}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    // Usar web worker para procesamiento pesado
    const salesData = await this.workerManager.process({
      type: 'sales',
      dateRange,
      filters,
      userId: this.auth.currentUser.uid
    });

    const report = {
      summary: this._calculateSalesSummary(salesData),
      dailyBreakdown: this._groupByDay(salesData),
      categoryBreakdown: this._groupByCategory(salesData),
      paymentMethods: this._groupByPaymentMethod(salesData),
      generatedAt: new Date().toISOString()
    };

    await this.cache.set(cacheKey, report, CACHE_TTL);
    return report;
  }

  /**
   * Reporte de productos más vendidos
   */
  async getProductsReport(dateRange) {
    this._validateDateRange(dateRange);
    
    const products = await this._fetchProducts(dateRange);
    
    return {
      topSelling: products.slice(0, 10),
      lowStock: products.filter(p => p.stock < p.minStock),
      performance: this._calculateProductPerformance(products),
      categories: this._groupProductsByCategory(products)
    };
  }

  /**
   * Flujo de caja (ingresos vs egresos)
   */
  async getCashflowReport(dateRange) {
    this._validateDateRange(dateRange);
    
    const [incomes, expenses] = await Promise.all([
      this._fetchTransactions('income', dateRange),
      this._fetchTransactions('expense', dateRange)
    ]);

    return {
      cashflow: {
        incomes: this._sumTransactions(incomes),
        expenses: this._sumTransactions(expenses),
        net: this._sumTransactions(incomes) - this._sumTransactions(expenses)
      },
      dailyCashflow: this._calculateDailyCashflow(incomes, expenses),
      categories: {
        incomeCategories: this._groupTransactionsByCategory(incomes),
        expenseCategories: this._groupTransactionsByCategory(expenses)
      }
    };
  }

  /**
   * Reporte de clientes (segmentado)
   */
  async getClientsReport() {
    const clients = await this._fetchClients();
    
    // Solo datos necesarios para reporte
    const clientData = clients.map(client => ({
      id: client.id,
      name: client.name,
      totalPurchases: client.totalSpent || 0,
      lastPurchase: client.lastPurchase,
      segment: this._segmentClient(client)
    }));

    return {
      summary: {
        totalClients: clients.length,
        activeClients: clients.filter(c => c.lastPurchase > subDays(new Date(), 30)).length,
        averageValue: this._calculateAverageClientValue(clients)
      },
      segmentation: this._segmentClients(clientData),
      topClients: clientData.sort((a, b) => b.totalPurchases - a.totalPurchases).slice(0, 20)
    };
  }

  /**
   * Reporte de stock con alertas
   */
  async getStockReport() {
    // Intentar cache primero para reportes frecuentes
    if (this.cache.has('stock_report')) {
      return this.cache.get('stock_report');
    }

    const products = await this._fetchAllProducts();
    
    const report = {
      totalProducts: products.length,
      totalValue: products.reduce((sum, p) => sum + (p.stock * p.cost), 0),
      lowStock: products.filter(p => p.stock <= p.minStock),
      outOfStock: products.filter(p => p.stock === 0),
      byCategory: this._groupProductsByCategory(products),
      reorderSuggestions: this._generateReorderSuggestions(products)
    };

    this.cache.set('stock_report', report, CACHE_TTL);
    return report;
  }

  /**
   * Reporte de ganancias (margen)
   */
  async getProfitReport(dateRange) {
    this._validateDateRange(dateRange);
    
    const [sales, costs] = await Promise.all([
      this._fetchSales(dateRange),
      this._fetchProductCosts(dateRange)
    ]);

    // Usar worker para cálculo complejo
    const profitAnalysis = await this.workerManager.process({
      type: 'profit',
      sales,
      costs,
      dateRange
    });

    return {
      grossProfit: profitAnalysis.grossProfit,
      netProfit: profitAnalysis.netProfit,
      margin: profitAnalysis.margin,
      byProduct: profitAnalysis.byProduct.slice(0, 50), // Limitar para performance
      trend: profitAnalysis.trend
    };
  }

  /**
   * Exportar reporte en diferentes formatos
   */
  async exportReport(data, format = 'csv') {
    // Validar que no se exporten todos los datos
    if (this._isFullDataExport(data)) {
      throw new Error('Exportación completa no permitida');
    }

    switch (format) {
      case 'csv':
        return this._exportToCSV(data);
      case 'pdf':
        return this._exportToPDF(data);
      case 'excel':
        return this._exportToExcel(data);
      default:
        throw new Error('Formato no soportado');
    }
  }

  /**
   * Programar reporte recurrente
   */
  async scheduleReport(reportConfig) {
    const { type, frequency, recipients, format } = reportConfig;
    
    const jobId = `report_${Date.now()}`;
    const job = {
      id: jobId,
      type,
      frequency,
      lastRun: null,
      nextRun: this._calculateNextRun(frequency),
      config: reportConfig
    };

    this.scheduledReports.set(jobId, job);
    this._startScheduler(job);
    
    return jobId;
  }

  /**
   * Estadísticas para dashboard
   */
  async getDashboardStats() {
    // Reporte precalculado - cache intensivo
    if (this.cache.has('dashboard_stats')) {
      return this.cache.get('dashboard_stats');
    }

    const today = new Date();
    const last30Days = { start: subDays(today, 30), end: today };

    const [sales, clients, products] = await Promise.all([
      this._fetchSales(last30Days),
      this._fetchClients(),
      this._fetchAllProducts()
    ]);

    const stats = {
      today: {
        sales: this._calculateTodaySales(sales),
        newClients: this._countNewClients(clients, today),
        topProduct: this._getTodayTopProduct(sales)
      },
      weekTrend: this._calculateWeekTrend(sales),
      alerts: {
        lowStock: products.filter(p => p.stock < p.minStock).length,
        pendingOrders: await this._countPendingOrders()
      },
      kpis: this._calculateKPIs(sales, clients, products)
    };

    this.cache.set('dashboard_stats', stats, 2 * 60 * 1000); // 2 minutos cache
    return stats;
  }

  /**
   * Comparar dos períodos
   */
  async comparePeriods(period1, period2) {
    this._validateDateRange(period1);
    this._validateDateRange(period2);

    const [report1, report2] = await Promise.all([
      this.getSalesReport(period1),
      this.getSalesReport(period2)
    ]);

    return {
      period1: report1.summary,
      period2: report2.summary,
      comparison: {
        salesChange: this._calculatePercentageChange(
          report1.summary.totalSales,
          report2.summary.totalSales
        ),
        avgTicketChange: this._calculatePercentageChange(
          report1.summary.averageTicket,
          report2.summary.averageTicket
        ),
        volumeChange: this._calculatePercentageChange(
          report1.summary.totalItems,
          report2.summary.totalItems
        )
      },
      insights: this._generateComparisonInsights(report1, report2)
    };
  }

  // ========== MÉTODOS PRIVADOS ==========

  /**
   * Validar rango de fechas (max 90 días)
   */
  _validateDateRange(dateRange) {
    const { start, end } = dateRange;
    const diffDays = (end - start) / (1000 * 60 * 60 * 24);
    
    if (diffDays > MAX_REPORT_DAYS) {
      throw new Error(`El período máximo permitido es ${MAX_REPORT_DAYS} días`);
    }

    // Ajustar timezone
    dateRange.start = this._adjustTimezone(start);
    dateRange.end = this._adjustTimezone(end);
  }

  /**
   * Ajustar fecha según timezone configurado
   */
  _adjustTimezone(date) {
    return new Date(date.toLocaleString('en-US', { timeZone: TIMEZONE }));
  }

  /**
   * Verificar si es una exportación completa (no permitida)
   */
  _isFullDataExport(data) {
    const MAX_EXPORT_ROWS = 10000;
    return data.rows > MAX_EXPORT_ROWS || data.isCompleteExport;
  }

  /**
   * Calcular siguiente ejecución para reporte programado
   */
  _calculateNextRun(frequency) {
    const now = new Date();
    switch (frequency) {
      case 'daily':
        return new Date(now.setDate(now.getDate() + 1));
      case 'weekly':
        return new Date(now.setDate(now.getDate() + 7));
      case 'monthly':
        return new Date(now.setMonth(now.getMonth() + 1));
      default:
        throw new Error('Frecuencia no válida');
    }
  }

  /**
   * Iniciar scheduler para reporte programado
   */
  _startScheduler(job) {
    const interval = setInterval(async () => {
      if (new Date() >= job.nextRun) {
        await this._executeScheduledReport(job);
        job.lastRun = new Date();
        job.nextRun = this._calculateNextRun(job.frequency);
      }
    }, 60000); // Revisar cada minuto

    job.intervalId = interval;
  }

  /**
   * Ejecutar reporte programado
   */
  async _executeScheduledReport(job) {
    try {
      const report = await this[`get${job.type}Report`](job.config.dateRange);
      const exported = await this.exportReport(report, job.config.format);
      
      await this._sendReportEmail(job.config.recipients, exported);
      
      console.log(`Reporte ${job.type} enviado exitosamente`);
    } catch (error) {
      console.error(`Error en reporte programado ${job.id}:`, error);
    }
  }

  // ========== MÉTODOS DE AGRUPACIÓN Y CÁLCULO ==========

  _calculateSalesSummary(salesData) {
    return {
      totalSales: salesData.reduce((sum, s) => sum + s.total, 0),
      totalItems: salesData.reduce((sum, s) => sum + s.quantity, 0),
      averageTicket: salesData.length > 0 
        ? salesData.reduce((sum, s) => sum + s.total, 0) / salesData.length 
        : 0
    };
  }

  _groupByDay(data) {
    const groups = {};
    data.forEach(item => {
      const date = format(item.date, 'yyyy-MM-dd');
      if (!groups[date]) groups[date] = [];
      groups[date].push(item);
    });
    return groups;
  }

  _groupByCategory(data) {
    // Implementación específica según estructura de datos
    return data.reduce((acc, item) => {
      const category = item.category || 'Sin categoría';
      if (!acc[category]) acc[category] = 0;
      acc[category] += item.total;
      return acc;
    }, {});
  }

  _segmentClient(client) {
    const total = client.totalSpent || 0;
    if (total > 10000) return 'Premium';
    if (total > 5000) return 'Regular';
    return 'Ocasional';
  }

  // ========== MÉTODOS DE SINCRONIZACIÓN OFFLINE ==========

  /**
   * Preparar datos para modo offline
   */
  async prepareOfflineReports() {
    const today = new Date();
    const last7Days = { start: subDays(today, 7), end: today };
    
    const [sales, products] = await Promise.all([
      this._fetchSales(last7Days),
      this._fetchAllProducts()
    ]);

    await this.offline.cacheReports({
      salesReport: this._calculateSalesSummary(sales),
      stockReport: {
        totalProducts: products.length,
        lowStock: products.filter(p => p.stock < p.minStock)
      },
      dashboardStats: await this.getDashboardStats()
    });
  }

  /**
   * Obtener reporte offline
   */
  async getOfflineReport(reportType) {
    if (!navigator.onLine) {
      return this.offline.getReport(reportType);
    }
    throw new Error('No disponible online');
  }

  // ========== LISTENERS TIEMPO REAL ==========

  /**
   * Suscribirse a cambios en tiempo real
   */
  subscribeToRealtimeUpdates() {
    // Suscripción a ventas
    this.salesUnsubscribe = onSnapshot(
      query(collection(this.db, 'sales'), where('date', '>=', subDays(new Date(), 1))),
      (snapshot) => {
        this._handleSalesUpdate(snapshot);
        this.cache.invalidate('dashboard_stats');
      }
    );

    // Suscripción a stock
    this.stockUnsubscribe = onSnapshot(
      query(collection(this.db, 'products'), where('stock', '<=', minStock)),
      (snapshot) => {
        this._handleStockAlert(snapshot);
        this.cache.invalidate('stock_report');
      }
    );
  }

  /**
   * Manejar actualización de ventas en tiempo real
   */
  _handleSalesUpdate(snapshot) {
    const changes = snapshot.docChanges();
    const significantChange = changes.some(change => 
      change.type === 'added' && change.doc.data().total > 1000
    );

    if (significantChange) {
      this._notifySignificantChange('sales', changes.length);
    }
  }

  /**
   * Notificar cambio significativo
   */
  _notifySignificantChange(type, count) {
    // Implementar sistema de notificaciones
    console.log(`Cambio significativo en ${type}: ${count} registros`);
  }

  // ========== CLEANUP ==========

  /**
   * Limpiar recursos
   */
  cleanup() {
    this.salesUnsubscribe?.();
    this.stockUnsubscribe?.();
    this.scheduledReports.forEach(job => clearInterval(job.intervalId));
    this.workerManager.terminateAll();
  }
}

// ========== EXPORTACIÓN ==========
export default ReportsManager;
