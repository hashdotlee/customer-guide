/**
 * FB Order Saver – Popup Script
 * Communicates with background service worker via chrome.runtime.sendMessage
 */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  products: [],
  filtered: [],
  searchQuery: '',
  loading: true,
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dom = {
  statTotal:       document.getElementById('statTotal'),
  statToday:       document.getElementById('statToday'),
  searchInput:     document.getElementById('searchInput'),
  searchClear:     document.getElementById('searchClear'),
  productList:     document.getElementById('productList'),
  emptyState:      document.getElementById('emptyState'),
  sectionCount:    document.getElementById('sectionCount'),
  btnDashboard:    document.getElementById('btnDashboard'),
  btnSettings:     document.getElementById('btnSettings'),
  btnOpenDashboard:document.getElementById('btnOpenDashboard'),
  btnOpenSettings: document.getElementById('btnOpenSettings'),
  toast:           document.getElementById('toast'),
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initListeners();
  loadData();
});

function initListeners() {
  // Header icon buttons
  dom.btnDashboard.addEventListener('click', openDashboard);
  dom.btnSettings.addEventListener('click', openSettings);

  // Footer buttons
  dom.btnOpenDashboard.addEventListener('click', openDashboard);
  dom.btnOpenSettings.addEventListener('click', openSettings);

  // Search
  dom.searchInput.addEventListener('input', onSearch);
  dom.searchClear.addEventListener('click', clearSearch);

  // Keyboard: clear on Escape
  dom.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSearch();
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────
function loadData() {
  showSkeletons();

  sendMessage({ type: 'GET_PRODUCTS' })
    .then((response) => {
      const products = Array.isArray(response?.products) ? response.products : [];
      state.products = products;
      state.loading = false;
      updateStats(products);
      applySearch();
    })
    .catch((err) => {
      console.error('[Popup] Failed to load products:', err);
      state.loading = false;
      state.products = [];
      renderProducts([]);
      updateStats([]);
    });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function updateStats(products) {
  const total = products.length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayCount = products.filter((p) => {
    const saved = p.savedAt || p.createdAt || '';
    return saved.startsWith(todayStr);
  }).length;

  dom.statTotal.textContent = formatNumber(total);
  dom.statToday.textContent = formatNumber(todayCount);
  dom.statTotal.classList.remove('loading');
  dom.statToday.classList.remove('loading');
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch(e) {
  state.searchQuery = e.target.value.trim();
  dom.searchClear.classList.toggle('hidden', state.searchQuery === '');
  applySearch();
}

function clearSearch() {
  dom.searchInput.value = '';
  state.searchQuery = '';
  dom.searchClear.classList.add('hidden');
  dom.searchInput.focus();
  applySearch();
}

function applySearch() {
  const q = state.searchQuery.toLowerCase();
  if (!q) {
    // Show latest 5
    state.filtered = state.products.slice().sort(sortByDate).slice(0, 5);
  } else {
    state.filtered = state.products
      .filter((p) => {
        const title = (p.title || p.name || '').toLowerCase();
        const price = String(p.price || '').toLowerCase();
        const note  = (p.note || p.description || '').toLowerCase();
        return title.includes(q) || price.includes(q) || note.includes(q);
      })
      .sort(sortByDate)
      .slice(0, 5);
  }
  renderProducts(state.filtered);
}

function sortByDate(a, b) {
  const ta = new Date(a.savedAt || a.createdAt || 0).getTime();
  const tb = new Date(b.savedAt || b.createdAt || 0).getTime();
  return tb - ta;
}

// ── Render ────────────────────────────────────────────────────────────────────
function showSkeletons() {
  const skels = Array.from({ length: 3 }, () => {
    return `<li class="skeleton-item">
      <div class="skeleton skel-thumb"></div>
      <div class="skel-lines">
        <div class="skeleton skel-line skel-line-long"></div>
        <div class="skeleton skel-line skel-line-short"></div>
      </div>
    </li>`;
  }).join('');

  dom.productList.innerHTML = skels;
  dom.sectionCount.textContent = '';
}

function renderProducts(products) {
  dom.productList.innerHTML = '';

  if (!products.length) {
    if (state.searchQuery) {
      dom.productList.innerHTML = `
        <li class="no-results">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <p>Không tìm thấy "${escHtml(state.searchQuery)}"</p>
        </li>`;
      dom.sectionCount.textContent = '0';
    } else {
      dom.productList.appendChild(dom.emptyState);
      dom.sectionCount.textContent = '';
    }
    return;
  }

  dom.sectionCount.textContent = String(products.length);

  const frag = document.createDocumentFragment();
  products.forEach((product) => {
    const li = buildProductItem(product);
    frag.appendChild(li);
  });
  dom.productList.appendChild(frag);
}

function buildProductItem(product) {
  const li = document.createElement('li');
  li.className = 'product-item';
  li.dataset.id = product.id || '';

  // Thumbnail
  const thumbEl = buildThumb(product);

  // Info
  const infoEl = document.createElement('div');
  infoEl.className = 'product-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'product-title';
  titleEl.textContent = product.title || product.name || 'Không có tiêu đề';
  if (state.searchQuery) {
    titleEl.innerHTML = highlightMatch(escHtml(titleEl.textContent), state.searchQuery);
  }

  const metaEl = document.createElement('div');
  metaEl.className = 'product-meta';

  const priceEl = document.createElement('span');
  const priceText = formatPrice(product.price);
  priceEl.className = 'product-price' + (priceText ? '' : ' no-price');
  priceEl.textContent = priceText || 'Chưa có giá';

  const badge = buildConditionBadge(product.condition);

  metaEl.appendChild(priceEl);
  if (badge) metaEl.appendChild(badge);

  infoEl.appendChild(titleEl);
  infoEl.appendChild(metaEl);

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'product-delete';
  delBtn.title = 'Xóa sản phẩm';
  delBtn.setAttribute('aria-label', 'Xóa sản phẩm');
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6M14 11v6"/>
    <path d="M9 6V4h6v2"/>
  </svg>`;
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteProduct(product, li);
  });

  // Click item → open FB post
  li.addEventListener('click', () => {
    if (product.postUrl) {
      chrome.tabs.create({ url: product.postUrl });
    }
  });

  li.appendChild(thumbEl);
  li.appendChild(infoEl);
  li.appendChild(delBtn);
  return li;
}

function buildThumb(product) {
  if (product.thumbnail || product.imageUrl) {
    const img = document.createElement('img');
    img.className = 'product-thumb';
    img.src = product.thumbnail || product.imageUrl;
    img.alt = product.title || '';
    img.loading = 'lazy';
    img.onerror = function () {
      this.replaceWith(placeholderThumb());
    };
    return img;
  }
  return placeholderThumb();
}

function placeholderThumb() {
  const div = document.createElement('div');
  div.className = 'product-thumb-placeholder';
  div.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
    <rect x="3" y="3" width="18" height="18" rx="3"/>
    <circle cx="8.5" cy="8.5" r="1.5"/>
    <polyline points="21 15 16 10 5 21"/>
  </svg>`;
  return div;
}

function buildConditionBadge(condition) {
  if (!condition) return null;
  const map = {
    new:      { cls: 'badge-new',  label: 'Mới' },
    used:     { cls: 'badge-used', label: 'Cũ' },
    like_new: { cls: 'badge-new',  label: 'Như mới' },
    old:      { cls: 'badge-old',  label: 'Cũ' },
    analyzing:{ cls: 'badge-analyzing', label: 'Đang phân tích' },
  };
  const entry = map[condition.toLowerCase()] || { cls: 'badge-old', label: condition };
  const span = document.createElement('span');
  span.className = `badge ${entry.cls}`;
  span.textContent = entry.label;
  return span;
}

// ── Delete ────────────────────────────────────────────────────────────────────
function deleteProduct(product, li) {
  const id = product.id;
  if (!id) return;

  // Optimistic UI
  li.style.opacity = '0.4';
  li.style.pointerEvents = 'none';

  sendMessage({ type: 'DELETE_PRODUCT', id })
    .then((response) => {
      if (response?.success !== false) {
        // Remove from state
        state.products = state.products.filter((p) => p.id !== id);
        updateStats(state.products);
        applySearch();
        showToast('Đã xóa sản phẩm', 'success');
      } else {
        li.style.opacity = '';
        li.style.pointerEvents = '';
        showToast('Không thể xóa sản phẩm', 'error');
      }
    })
    .catch(() => {
      li.style.opacity = '';
      li.style.pointerEvents = '';
      showToast('Lỗi khi xóa sản phẩm', 'error');
    });
}

// ── Navigation ────────────────────────────────────────────────────────────────
function openDashboard() {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
  window.close();
}

function openSettings() {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });
  window.close();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer = null;

function showToast(message, type = '') {
  clearTimeout(toastTimer);
  dom.toast.textContent = message;
  dom.toast.className = 'toast show' + (type ? ' toast-' + type : '');
  toastTimer = setTimeout(() => {
    dom.toast.classList.remove('show');
  }, 2200);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sendMessage(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

function formatNumber(n) {
  if (typeof n !== 'number') return '0';
  return n.toLocaleString('vi-VN');
}

function formatPrice(price) {
  if (price === null || price === undefined || price === '') return '';
  const num = typeof price === 'string'
    ? parseFloat(price.replace(/[^0-9.]/g, ''))
    : Number(price);
  if (isNaN(num) || num <= 0) return '';
  // Vietnamese Dong typically doesn't use decimal
  return num.toLocaleString('vi-VN') + 'đ';
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function highlightMatch(escaped, query) {
  const re = new RegExp(`(${escRegex(query)})`, 'gi');
  return escaped.replace(re, '<mark style="background:rgba(79,70,229,0.35);color:inherit;border-radius:2px;padding:0 1px">$1</mark>');
}

function escRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
