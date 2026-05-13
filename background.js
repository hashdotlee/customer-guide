/**
 * background.js - Chrome Extension Service Worker
 * Xử lý tin nhắn từ content script, quản lý lưu trữ, AI, context menu, và cloud sync.
 */

import { StorageManager } from './utils/storage.js';
import { AIService } from './utils/ai-service.js';

// ─── Khởi tạo singleton ────────────────────────────────────────────────────────

const storage = new StorageManager();
const aiService = new AIService();

/** @type {boolean} */
let isStorageReady = false;

/** @type {Promise<void>} */
let storageInitPromise = null;

/**
 * Đảm bảo storage đã khởi tạo trước khi dùng.
 * @returns {Promise<void>}
 */
async function ensureStorage() {
  if (isStorageReady) return;
  if (!storageInitPromise) {
    storageInitPromise = storage.init().then(() => {
      isStorageReady = true;
      console.log('[Background] StorageManager đã sẵn sàng.');
    });
  }
  return storageInitPromise;
}

// ─── Extension install / startup ──────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[Background] Extension đã cài đặt:', details.reason);

  await ensureStorage();

  // Tạo context menu
  setupContextMenus();

  if (details.reason === 'install') {
    // Cài đặt mặc định khi cài lần đầu
    await storage.saveSettings({
      provider: 'openai',
      apiKey: '',
      cloudEndpoint: '',
      syncEnabled: false,
      syncEndpoint: '',
      syncApiKey: '',
      autoAnalyze: false,
      language: 'vi',
      installedAt: new Date().toISOString(),
    });
    console.log('[Background] Đã khởi tạo cài đặt mặc định.');
  }

  // Tải cài đặt AI
  await loadAISettings();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureStorage();
  setupContextMenus();
  await loadAISettings();
  console.log('[Background] Service worker đã khởi động lại.');
});

// ─── Context Menu ──────────────────────────────────────────────────────────────

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-as-order',
      title: 'Lưu bài đăng làm đơn hàng',
      contexts: ['page', 'selection'],
      documentUrlPatterns: [
        'https://www.facebook.com/*',
        'https://*.facebook.com/*',
      ],
    });

    chrome.contextMenus.create({
      id: 'open-dashboard',
      title: 'Mở danh sách đơn hàng',
      contexts: ['page'],
      documentUrlPatterns: [
        'https://www.facebook.com/*',
        'https://*.facebook.com/*',
      ],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === 'save-as-order') {
    // Yêu cầu content script thu thập dữ liệu bài đăng hiện tại
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXTRACT_CURRENT_POST',
        selectedText: info.selectionText ?? '',
      });

      if (response?.postData) {
        const result = await handleSavePost(response.postData);
        // Thông báo lại cho content script
        chrome.tabs.sendMessage(tab.id, {
          type: 'POST_SAVED',
          product: result.product,
          success: result.success,
          message: result.message,
        }).catch(() => {});
      }
    } catch (err) {
      console.error('[Background] Lỗi khi lưu từ context menu:', err);
    }
  }

  if (info.menuItemId === 'open-dashboard') {
    chrome.tabs.create({
      url: chrome.runtime.getURL('dashboard/index.html'),
    });
  }
});

// ─── Message Listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.type) return false;

  // Xử lý bất đồng bộ và trả kết quả qua sendResponse
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error(`[Background] Lỗi xử lý message "${message.type}":`, err);
      sendResponse({ success: false, error: err.message });
    });

  // Giữ message channel mở cho async response
  return true;
});

/**
 * Điều phối xử lý message theo type.
 * @param {Object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<Object>}
 */
async function handleMessage(message, sender) {
  await ensureStorage();

  switch (message.type) {
    case 'SAVE_POST':
      return handleSavePost(message.data);

    case 'GET_PRODUCTS':
      return handleGetProducts();

    case 'GET_PRODUCT':
      return handleGetProduct(message.id);

    case 'DELETE_PRODUCT':
      return handleDeleteProduct(message.id);

    case 'DELETE_PRODUCTS':
      return handleDeleteProducts(message.ids);

    case 'SEARCH_PRODUCTS':
      return handleSearchProducts(message.query);

    case 'ANALYZE_PRODUCT':
      return handleAnalyzeProduct(message.id);

    case 'COMPARE_PRODUCTS':
      return handleCompareProducts(message.ids);

    case 'GET_SETTINGS':
      return handleGetSettings();

    case 'SAVE_SETTINGS':
      return handleSaveSettings(message.settings);

    case 'EXPORT_DATA':
      return handleExportData();

    case 'IMPORT_DATA':
    case 'IMPORT_PRODUCTS':
      return handleImportData(message.data || message.products || message.json);

    case 'DELETE_ALL_PRODUCTS':
    case 'DELETE_ALL_DATA':
      return handleDeleteAllProducts();

    case 'UPDATE_PRODUCT_NOTES':
      return handleUpdateProductNotes(message.id, message.notes);

    case 'TEST_API':
      // settings.js sends { type, provider, apiKey }
      // other callers may send { type, settings: { aiProvider, apiKey } }
      return handleTestApi(message.settings || message);

    case 'SYNC_NOW':
      return handleSyncNow(message);

    case 'OPEN_DASHBOARD':
      return handleOpenDashboard();

    case 'PING':
      return { success: true, pong: true };

    default:
      console.warn('[Background] Loại message không được hỗ trợ:', message.type);
      return { success: false, error: `Loại message không hỗ trợ: ${message.type}` };
  }
}

// ─── Handler: SAVE_POST ────────────────────────────────────────────────────────

/**
 * Lưu bài đăng Facebook thành sản phẩm, tùy chọn phân tích AI và sync.
 * @param {Object} postData
 * @returns {Promise<{ success: boolean, product: Object, message: string }>}
 */
async function handleSavePost(postData) {
  if (!postData || typeof postData !== 'object') {
    return { success: false, error: 'Dữ liệu bài đăng không hợp lệ.' };
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  let product = {
    id,
    url: postData.url ?? '',
    title: postData.title ?? '',
    price: postData.price ?? '',
    priceNumber: postData.priceNumber ?? null,
    currency: postData.currency ?? 'VND',
    condition: postData.condition ?? '',
    description: postData.description ?? '',
    images: Array.isArray(postData.images) ? postData.images : [],
    sellerName: postData.sellerName ?? '',
    sellerUrl: postData.sellerUrl ?? '',
    rawText: postData.rawText ?? '',
    savedAt: now,
    updatedAt: now,
    tags: Array.isArray(postData.tags) ? postData.tags : [],
    notes: postData.notes ?? '',
    aiAnalyzed: false,
    category: '',
    keyFeatures: [],
    estimatedValue: null,
  };

  // Lưu ngay lập tức để không mất dữ liệu
  product = await storage.saveProduct(product);

  // Tùy chọn: phân tích AI tự động
  const settings = await storage.getSettings();
  if (settings.autoAnalyze && aiService.isConfigured()) {
    try {
      const aiResult = await aiService.analyzePost(postData);
      if (aiResult) {
        product = await storage.saveProduct({
          ...product,
          ...aiResult,
          id: product.id,
          savedAt: product.savedAt,
          updatedAt: new Date().toISOString(),
          aiAnalyzed: true,
        });
      }
    } catch (err) {
      console.warn('[Background] Phân tích AI tự động thất bại:', err.message);
    }
  }

  // Tùy chọn: cloud sync
  if (settings.syncEnabled) {
    syncProductToCloud(product, settings).catch((err) => {
      console.warn('[Background] Cloud sync thất bại:', err.message);
    });
  }

  return {
    success: true,
    product,
    message: `Đã lưu sản phẩm "${product.title || 'Không có tên'}" thành công.`,
  };
}

// ─── Handler: GET_PRODUCTS ─────────────────────────────────────────────────────

async function handleGetProducts() {
  const products = await storage.getAllProducts();
  return { success: true, products };
}

// ─── Handler: GET_PRODUCT ──────────────────────────────────────────────────────

async function handleGetProduct(id) {
  if (!id) return { success: false, error: 'Thiếu ID sản phẩm.' };
  const product = await storage.getProduct(id);
  if (!product) return { success: false, error: 'Không tìm thấy sản phẩm.' };
  return { success: true, product };
}

// ─── Handler: DELETE_PRODUCT ───────────────────────────────────────────────────

async function handleDeleteProduct(id) {
  if (!id) return { success: false, error: 'Thiếu ID sản phẩm.' };
  await storage.deleteProduct(id);
  return { success: true, message: 'Đã xóa sản phẩm.' };
}

// ─── Handler: DELETE_PRODUCTS ──────────────────────────────────────────────────

async function handleDeleteProducts(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { success: false, error: 'Thiếu danh sách ID sản phẩm.' };
  }
  await storage.deleteProducts(ids);
  return { success: true, message: `Đã xóa ${ids.length} sản phẩm.` };
}

// ─── Handler: SEARCH_PRODUCTS ─────────────────────────────────────────────────

async function handleSearchProducts(query) {
  const products = await storage.searchProducts(query ?? '');
  return { success: true, products, query };
}

// ─── Handler: ANALYZE_PRODUCT ─────────────────────────────────────────────────

async function handleAnalyzeProduct(id) {
  if (!id) return { success: false, error: 'Thiếu ID sản phẩm.' };

  const product = await storage.getProduct(id);
  if (!product) return { success: false, error: 'Không tìm thấy sản phẩm.' };

  if (!aiService.isConfigured()) {
    return {
      success: false,
      error: 'Chưa cấu hình AI API key. Vui lòng vào Cài đặt để thêm API key.',
    };
  }

  const aiResult = await aiService.analyzePost(product);
  if (!aiResult) {
    return { success: false, error: 'Phân tích AI thất bại. Vui lòng thử lại.' };
  }

  const updated = await storage.saveProduct({
    ...product,
    ...aiResult,
    id: product.id,
    savedAt: product.savedAt,
    updatedAt: new Date().toISOString(),
    aiAnalyzed: true,
  });

  return {
    success: true,
    product: updated,
    message: 'Đã phân tích AI thành công.',
  };
}

// ─── Handler: COMPARE_PRODUCTS ────────────────────────────────────────────────

async function handleCompareProducts(ids) {
  if (!Array.isArray(ids) || ids.length < 2) {
    return { success: false, error: 'Cần ít nhất 2 sản phẩm để so sánh.' };
  }

  if (!aiService.isConfigured()) {
    return {
      success: false,
      error: 'Chưa cấu hình AI API key. Vui lòng vào Cài đặt để thêm API key.',
    };
  }

  const products = await Promise.all(ids.map((id) => storage.getProduct(id)));
  const validProducts = products.filter(Boolean);

  if (validProducts.length < 2) {
    return { success: false, error: 'Không đủ sản phẩm hợp lệ để so sánh.' };
  }

  const comparison = await aiService.compareProducts(validProducts);
  if (!comparison) {
    return { success: false, error: 'So sánh sản phẩm thất bại. Vui lòng thử lại.' };
  }

  return { success: true, comparison };
}

// ─── Handler: GET_SETTINGS ────────────────────────────────────────────────────

async function handleGetSettings() {
  const settings = await storage.getSettings();
  // Ẩn API key trong response (chỉ cho biết đã có hay chưa)
  const safeSettings = {
    ...settings,
    hasApiKey: Boolean(settings.apiKey),
    hasSyncApiKey: Boolean(settings.syncApiKey),
    apiKey: settings.apiKey ? '••••••••' : '',
    syncApiKey: settings.syncApiKey ? '••••••••' : '',
  };
  return { success: true, settings: safeSettings };
}

// ─── Handler: SAVE_SETTINGS ───────────────────────────────────────────────────

async function handleSaveSettings(newSettings) {
  if (!newSettings || typeof newSettings !== 'object') {
    return { success: false, error: 'Dữ liệu cài đặt không hợp lệ.' };
  }

  // Không ghi đè API key nếu client gửi giá trị ẩn
  const existing = await storage.getSettings();
  const toSave = { ...newSettings };

  if (toSave.apiKey === '••••••••') {
    toSave.apiKey = existing.apiKey ?? '';
  }
  if (toSave.syncApiKey === '••••••••') {
    toSave.syncApiKey = existing.syncApiKey ?? '';
  }

  await storage.saveSettings(toSave);

  // Cập nhật AI service với cài đặt mới
  await loadAISettings();

  return { success: true, message: 'Đã lưu cài đặt thành công.' };
}

// ─── Handler: EXPORT_DATA ─────────────────────────────────────────────────────

async function handleExportData() {
  const data = await storage.exportData();
  return { success: true, data };
}

// ─── Handler: IMPORT_DATA ─────────────────────────────────────────────────────

async function handleImportData(data) {
  if (!data) {
    return { success: false, error: 'Dữ liệu import không hợp lệ.' };
  }

  try {
    const input = typeof data === 'string' ? data : JSON.stringify(data);
    const result = await storage.importData(input);
    return {
      success: true,
      count: result.imported,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors,
    };
  } catch (err) {
    return { success: false, error: `Lỗi khi nhập dữ liệu: ${err.message}` };
  }
}

// ─── Handler: DELETE_ALL_PRODUCTS ─────────────────────────────────────────────

async function handleDeleteAllProducts() {
  try {
    const all = await storage.getAllProducts();
    await Promise.all(all.map(p => storage.deleteProduct(p.id)));
    return { success: true, deleted: all.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Handler: UPDATE_PRODUCT_NOTES ────────────────────────────────────────────

async function handleUpdateProductNotes(id, notes) {
  try {
    const product = await storage.getProduct(id);
    if (!product) return { success: false, error: 'Không tìm thấy sản phẩm.' };
    product.notes = notes;
    product.updatedAt = new Date().toISOString();
    await storage.saveProduct(product);
    return { success: true, product };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Handler: TEST_API ────────────────────────────────────────────────────────

async function handleTestApi(testSettings) {
  if (!testSettings || typeof testSettings !== 'object') {
    return { success: false, ok: false, error: 'Thiếu thông tin cài đặt.' };
  }
  try {
    const provider = testSettings.aiProvider || testSettings.provider || 'openai';
    const apiKey   = testSettings.apiKey || '';
    if (!apiKey) return { success: false, ok: false, error: 'Chưa nhập API key.' };

    const tempAI = new AIService({
      provider,
      apiKey,
      cloudEndpoint: testSettings.cloudEndpoint || '',
    });
    const result = await tempAI.analyzePost({
      rawText: 'Bán iPhone 14 Pro Max 256GB màu đen, mới 99%, giá 25 triệu. LH: 0901234567',
      images: [],
    });
    if (result) {
      return { success: true, ok: true, message: 'Kết nối thành công!' };
    }
    return { success: false, ok: false, error: 'Không nhận được kết quả từ AI.' };
  } catch (err) {
    return { success: false, ok: false, error: err.message };
  }
}

// ─── Handler: SYNC_NOW ────────────────────────────────────────────────────────

async function handleSyncNow(msg = {}) {
  const stored = await storage.getSettings();
  // Allow caller to pass endpoint/key directly (settings.js sends them inline)
  const endpoint = msg.endpoint || stored.cloudEndpoint || stored.syncEndpoint || '';
  const apiKey   = msg.cloudApiKey || stored.syncApiKey || stored.cloudApiKey || '';

  if (!endpoint) return { success: false, error: 'Chưa cấu hình Cloud endpoint.' };
  if (!apiKey)   return { success: false, error: 'Chưa cấu hình Cloud API key.' };

  const syncSettings = { ...stored, syncEndpoint: endpoint, syncApiKey: apiKey };
  const result = await performCloudSync(syncSettings);
  return result;
}

// ─── Handler: OPEN_DASHBOARD ──────────────────────────────────────────────────

async function handleOpenDashboard() {
  const url = chrome.runtime.getURL('dashboard/index.html');

  // Kiểm tra tab dashboard đã mở chưa
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }

  return { success: true };
}

// ─── Cloud Sync ────────────────────────────────────────────────────────────────

/**
 * Đồng bộ một sản phẩm lên cloud.
 * @param {Object} product
 * @param {Object} settings
 */
async function syncProductToCloud(product, settings) {
  if (!settings?.syncEndpoint || !settings?.syncApiKey) return;

  const response = await fetch(`${settings.syncEndpoint}/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.syncApiKey}`,
    },
    body: JSON.stringify(product),
  });

  if (!response.ok) {
    throw new Error(`Sync lỗi HTTP ${response.status}`);
  }

  await storage.updateLastSyncTime();
  console.log('[Background] Đã sync sản phẩm lên cloud:', product.id);
}

/**
 * Đồng bộ toàn bộ sản phẩm chưa sync lên cloud.
 * @param {Object} settings
 * @returns {Promise<{ success: boolean, synced: number, message: string }>}
 */
async function performCloudSync(settings) {
  const lastSyncTime = await storage.getLastSyncTime();
  const products = await storage.getProductsModifiedAfter(lastSyncTime);

  if (products.length === 0) {
    return { success: true, synced: 0, message: 'Không có sản phẩm mới cần đồng bộ.' };
  }

  let synced = 0;
  const errors = [];

  for (const product of products) {
    try {
      const response = await fetch(`${settings.syncEndpoint}/products/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.syncApiKey}`,
        },
        body: JSON.stringify({ products: [product] }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      synced++;
    } catch (err) {
      errors.push(`${product.id}: ${err.message}`);
      console.error('[Background] Lỗi sync sản phẩm:', product.id, err.message);
    }
  }

  if (synced > 0) {
    await storage.updateLastSyncTime();
  }

  const message =
    errors.length === 0
      ? `Đã đồng bộ ${synced} sản phẩm lên cloud.`
      : `Đã đồng bộ ${synced}/${products.length} sản phẩm. ${errors.length} lỗi.`;

  return { success: errors.length === 0, synced, errors, message };
}

// ─── Load AI Settings ──────────────────────────────────────────────────────────

/**
 * Tải cài đặt AI từ storage và cập nhật aiService.
 */
async function loadAISettings() {
  try {
    await ensureStorage();
    const settings = await storage.getSettings();
    aiService.updateSettings({
      provider: settings.provider ?? 'openai',
      apiKey: settings.apiKey ?? '',
      cloudEndpoint: settings.cloudEndpoint ?? '',
    });
    console.log('[Background] Đã tải cài đặt AI, provider:', settings.provider ?? 'openai');
  } catch (err) {
    console.error('[Background] Không thể tải cài đặt AI:', err);
  }
}

// ─── Tab update listener ───────────────────────────────────────────────────────
// Khi người dùng điều hướng trên Facebook, đảm bảo content script vẫn active

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === 'complete' &&
    tab.url &&
    /^https:\/\/(www\.)?facebook\.com/.test(tab.url)
  ) {
    // Content script đã được inject qua manifest, không cần inject lại
    // Chỉ gửi ping để kiểm tra kết nối
    chrome.tabs
      .sendMessage(tabId, { type: 'PING' })
      .catch(() => {
        // Content script chưa sẵn sàng - bình thường khi trang mới load
      });
  }
});

// ─── Khởi tạo khi service worker load ─────────────────────────────────────────

(async () => {
  try {
    await ensureStorage();
    await loadAISettings();
    setupContextMenus();
    console.log('[Background] Service worker đã khởi tạo thành công.');
  } catch (err) {
    console.error('[Background] Lỗi khởi tạo service worker:', err);
  }
})();
