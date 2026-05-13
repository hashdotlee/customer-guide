/**
 * StorageManager - Quản lý lưu trữ dữ liệu đơn hàng bằng IndexedDB
 * Hỗ trợ: lưu/đọc/xóa sản phẩm, tìm kiếm, cài đặt, export/import
 */

const DB_NAME = 'FBOrderSaverDB';
const DB_VERSION = 1;
const STORE_PRODUCTS = 'products';
const STORE_SETTINGS = 'settings';

export class StorageManager {
  #db = null;

  /**
   * Khởi tạo IndexedDB, tạo các object store nếu chưa có.
   * @returns {Promise<void>}
   */
  async init() {
    if (this.#db) return;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // --- Products store ---
        if (!db.objectStoreNames.contains(STORE_PRODUCTS)) {
          const productStore = db.createObjectStore(STORE_PRODUCTS, {
            keyPath: 'id',
          });
          productStore.createIndex('savedAt', 'savedAt', { unique: false });
          productStore.createIndex('title', 'title', { unique: false });
          productStore.createIndex('sellerName', 'sellerName', { unique: false });
          productStore.createIndex('condition', 'condition', { unique: false });
          productStore.createIndex('tags', 'tags', {
            unique: false,
            multiEntry: true,
          });
        }

        // --- Settings store ---
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.#db = event.target.result;

        this.#db.onerror = (dbEvent) => {
          console.error('[StorageManager] Lỗi IndexedDB:', dbEvent.target.error);
        };

        resolve();
      };

      request.onerror = (event) => {
        console.error('[StorageManager] Không thể mở IndexedDB:', event.target.error);
        reject(new Error(`Không thể khởi tạo cơ sở dữ liệu: ${event.target.error?.message}`));
      };

      request.onblocked = () => {
        console.warn('[StorageManager] Mở IndexedDB bị chặn, vui lòng đóng các tab khác.');
      };
    });
  }

  /**
   * Lấy DB instance, tự động init nếu chưa sẵn sàng.
   * @returns {Promise<IDBDatabase>}
   */
  async #getDB() {
    if (!this.#db) await this.init();
    return this.#db;
  }

  /**
   * Helper: bọc IDBRequest thành Promise.
   * @param {IDBRequest} request
   * @returns {Promise<any>}
   */
  #promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = (event) => resolve(event.target.result);
      request.onerror = (event) => reject(event.target.error);
    });
  }

  /**
   * Helper: lấy transaction và object store.
   * @param {string} storeName
   * @param {'readonly'|'readwrite'} mode
   * @returns {Promise<IDBObjectStore>}
   */
  async #getStore(storeName, mode = 'readonly') {
    const db = await this.#getDB();
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  // ─────────────────────────────────────────────
  //  PRODUCTS
  // ─────────────────────────────────────────────

  /**
   * Lưu hoặc cập nhật sản phẩm.
   * @param {Product} product
   * @returns {Promise<Product>}
   */
  async saveProduct(product) {
    if (!product || typeof product !== 'object') {
      throw new TypeError('Dữ liệu sản phẩm không hợp lệ.');
    }

    const now = new Date().toISOString();
    const normalized = {
      id: product.id ?? this.#generateUUID(),
      url: product.url ?? '',
      title: product.title ?? '',
      price: product.price ?? '',
      priceNumber: product.priceNumber ?? null,
      currency: product.currency ?? 'VND',
      condition: product.condition ?? '',
      description: product.description ?? '',
      images: Array.isArray(product.images) ? product.images : [],
      sellerName: product.sellerName ?? '',
      sellerUrl: product.sellerUrl ?? '',
      rawText: product.rawText ?? '',
      savedAt: product.savedAt ?? now,
      updatedAt: now,
      tags: Array.isArray(product.tags) ? product.tags : [],
      notes: product.notes ?? '',
      aiAnalyzed: product.aiAnalyzed ?? false,
      category: product.category ?? '',
      keyFeatures: Array.isArray(product.keyFeatures) ? product.keyFeatures : [],
      estimatedValue: product.estimatedValue ?? null,
    };

    const store = await this.#getStore(STORE_PRODUCTS, 'readwrite');
    await this.#promisify(store.put(normalized));
    return normalized;
  }

  /**
   * Lấy sản phẩm theo id.
   * @param {string} id
   * @returns {Promise<Product|undefined>}
   */
  async getProduct(id) {
    const store = await this.#getStore(STORE_PRODUCTS, 'readonly');
    return this.#promisify(store.get(id));
  }

  /**
   * Lấy tất cả sản phẩm, sắp xếp giảm dần theo savedAt.
   * @returns {Promise<Product[]>}
   */
  async getAllProducts() {
    const store = await this.#getStore(STORE_PRODUCTS, 'readonly');
    const all = await this.#promisify(store.getAll());
    return all.sort((a, b) => {
      const ta = a.savedAt ? new Date(a.savedAt).getTime() : 0;
      const tb = b.savedAt ? new Date(b.savedAt).getTime() : 0;
      return tb - ta;
    });
  }

  /**
   * Xóa sản phẩm theo id.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async deleteProduct(id) {
    const store = await this.#getStore(STORE_PRODUCTS, 'readwrite');
    await this.#promisify(store.delete(id));
  }

  /**
   * Tìm kiếm sản phẩm theo từ khóa (toàn văn trên title, description, sellerName, tags, notes).
   * @param {string} query
   * @returns {Promise<Product[]>}
   */
  async searchProducts(query) {
    if (!query || typeof query !== 'string') return this.getAllProducts();

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (terms.length === 0) return this.getAllProducts();

    const all = await this.getAllProducts();

    return all.filter((product) => {
      const searchableText = [
        product.title,
        product.description,
        product.sellerName,
        product.notes,
        product.category,
        ...(product.tags ?? []),
        ...(product.keyFeatures ?? []),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return terms.every((term) => searchableText.includes(term));
    });
  }

  /**
   * Xóa nhiều sản phẩm cùng lúc.
   * @param {string[]} ids
   * @returns {Promise<void>}
   */
  async deleteProducts(ids) {
    const db = await this.#getDB();
    const tx = db.transaction(STORE_PRODUCTS, 'readwrite');
    const store = tx.objectStore(STORE_PRODUCTS);

    await Promise.all(ids.map((id) => this.#promisify(store.delete(id))));

    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  /**
   * Đếm tổng số sản phẩm.
   * @returns {Promise<number>}
   */
  async countProducts() {
    const store = await this.#getStore(STORE_PRODUCTS, 'readonly');
    return this.#promisify(store.count());
  }

  // ─────────────────────────────────────────────
  //  SETTINGS
  // ─────────────────────────────────────────────

  /**
   * Trả về tất cả cài đặt dưới dạng object { key: value }.
   * @returns {Promise<Object>}
   */
  async getSettings() {
    const store = await this.#getStore(STORE_SETTINGS, 'readonly');
    const records = await this.#promisify(store.getAll());
    return records.reduce((acc, { key, value }) => {
      acc[key] = value;
      return acc;
    }, {});
  }

  /**
   * Lưu một cặp cài đặt key/value.
   * @param {string} key
   * @param {*} value
   * @returns {Promise<void>}
   */
  async setSetting(key, value) {
    const store = await this.#getStore(STORE_SETTINGS, 'readwrite');
    await this.#promisify(store.put({ key, value }));
  }

  /**
   * Lấy giá trị một cài đặt theo key.
   * @param {string} key
   * @param {*} defaultValue
   * @returns {Promise<*>}
   */
  async getSetting(key, defaultValue = undefined) {
    const store = await this.#getStore(STORE_SETTINGS, 'readonly');
    const record = await this.#promisify(store.get(key));
    return record !== undefined ? record.value : defaultValue;
  }

  /**
   * Lưu nhiều cài đặt cùng lúc.
   * @param {Object} settingsObj - { key: value, ... }
   * @returns {Promise<void>}
   */
  async saveSettings(settingsObj) {
    const db = await this.#getDB();
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_SETTINGS);

    for (const [key, value] of Object.entries(settingsObj)) {
      store.put({ key, value });
    }

    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ─────────────────────────────────────────────
  //  EXPORT / IMPORT
  // ─────────────────────────────────────────────

  /**
   * Xuất toàn bộ sản phẩm dưới dạng JSON string.
   * @returns {Promise<string>}
   */
  async exportData() {
    const products = await this.getAllProducts();
    const settings = await this.getSettings();

    const exportPayload = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      totalProducts: products.length,
      products,
      settings,
    };

    return JSON.stringify(exportPayload, null, 2);
  }

  /**
   * Nhập sản phẩm từ JSON string (xuất bởi exportData).
   * Nếu sản phẩm đã tồn tại (cùng id), sẽ cập nhật nếu bản nhập mới hơn.
   * @param {string} json
   * @returns {Promise<{ imported: number, skipped: number, errors: number }>}
   */
  async importData(json) {
    let payload;
    try {
      payload = JSON.parse(json);
    } catch {
      throw new SyntaxError('Dữ liệu JSON không hợp lệ.');
    }

    // Hỗ trợ cả mảng thuần và object xuất từ exportData
    const rawProducts = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.products)
        ? payload.products
        : null;

    if (!rawProducts) {
      throw new TypeError('Không tìm thấy danh sách sản phẩm trong dữ liệu.');
    }

    let imported = 0;
    let skipped = 0;
    let errors = 0;

    for (const product of rawProducts) {
      try {
        if (!product || typeof product !== 'object' || !product.id) {
          errors++;
          continue;
        }

        const existing = await this.getProduct(product.id);
        if (existing) {
          const existingTime = existing.updatedAt
            ? new Date(existing.updatedAt).getTime()
            : 0;
          const importedTime = product.updatedAt
            ? new Date(product.updatedAt).getTime()
            : 0;

          if (importedTime <= existingTime) {
            skipped++;
            continue;
          }
        }

        await this.saveProduct(product);
        imported++;
      } catch (err) {
        console.error('[StorageManager] Lỗi khi nhập sản phẩm:', err);
        errors++;
      }
    }

    return { imported, skipped, errors };
  }

  // ─────────────────────────────────────────────
  //  CLOUD SYNC
  // ─────────────────────────────────────────────

  /**
   * Lấy thời điểm đồng bộ cuối cùng.
   * @returns {Promise<string|null>}
   */
  async getLastSyncTime() {
    return this.getSetting('lastSyncTime', null);
  }

  /**
   * Cập nhật thời điểm đồng bộ cuối cùng.
   * @returns {Promise<void>}
   */
  async updateLastSyncTime() {
    await this.setSetting('lastSyncTime', new Date().toISOString());
  }

  /**
   * Lấy danh sách sản phẩm được thêm/sửa sau lastSyncTime.
   * @param {string} lastSyncTime - ISO string
   * @returns {Promise<Product[]>}
   */
  async getProductsModifiedAfter(lastSyncTime) {
    if (!lastSyncTime) return this.getAllProducts();

    const cutoff = new Date(lastSyncTime).getTime();
    const all = await this.getAllProducts();

    return all.filter((p) => {
      const t = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
      return t > cutoff;
    });
  }

  // ─────────────────────────────────────────────
  //  UTILITIES
  // ─────────────────────────────────────────────

  /**
   * Tạo UUID v4 ngẫu nhiên.
   * @returns {string}
   */
  #generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback cho môi trường không hỗ trợ
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Đóng kết nối DB (dùng khi cleanup).
   */
  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}

// Singleton dùng chung trong extension
export const storageManager = new StorageManager();
