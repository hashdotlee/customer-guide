(() => {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────
  let allProducts = [];
  let filteredProducts = [];
  let compareIds = new Set();
  let currentView = 'all';
  let currentSort = 'savedAt_desc';
  let currentSearch = '';
  let currentConditionFilter = '';
  let openProductId = null;

  // ─── DOM refs ──────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const searchInput = $('searchInput');
  const searchClear = $('searchClear');
  const sortSelect = $('sortSelect');
  const filterCondition = $('filterCondition');
  const compareBtn = $('compareBtn');
  const compareCount = $('compareCount');
  const compareBadge = $('compareBadge');
  const productsGrid = $('productsGrid');
  const emptyState = $('emptyState');
  const loadingState = $('loadingState');
  const modalOverlay = $('modalOverlay');
  const modalClose = $('modalClose');
  const modalContent = $('modalContent');
  const aiLoadingOverlay = $('aiLoadingOverlay');
  const compareTableWrap = $('compareTableWrap');
  const aiCompareResult = $('aiCompareResult');
  const aiCompareContent = $('aiCompareContent');
  const toastContainer = $('toastContainer');

  // ─── Init ──────────────────────────────────────────────────────
  async function init() {
    setupNavigation();
    setupEventListeners();
    await loadProducts();
  }

  function setupNavigation() {
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', e => {
        e.preventDefault();
        setView(item.dataset.view);
      });
    });
  }

  function setView(view) {
    currentView = view;
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.classList.toggle('active', item.dataset.view === view);
    });
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const viewEl = document.getElementById('view' + view.charAt(0).toUpperCase() + view.slice(1));
    if (viewEl) viewEl.classList.add('active');

    if (view === 'compare') renderCompareView();
    if (view === 'tags') renderTagsView();
  }

  window.setView = setView;

  function setupEventListeners() {
    searchInput.addEventListener('input', () => {
      currentSearch = searchInput.value.trim();
      searchClear.hidden = !currentSearch;
      filterAndRender();
    });
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      currentSearch = '';
      searchClear.hidden = true;
      filterAndRender();
    });
    sortSelect.addEventListener('change', () => {
      currentSort = sortSelect.value;
      filterAndRender();
    });
    filterCondition.addEventListener('change', () => {
      currentConditionFilter = filterCondition.value;
      filterAndRender();
    });
    compareBtn.addEventListener('click', () => {
      setView('compare');
      renderCompareView();
    });
    modalClose.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', e => {
      if (e.target === modalOverlay) closeModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
    });
    $('clearCompare').addEventListener('click', () => {
      compareIds.clear();
      updateCompareUI();
      renderCompareView();
    });
    $('exportBtn').addEventListener('click', exportData);
    $('importBtn').addEventListener('click', () => $('importFile').click());
    $('importFile').addEventListener('change', importData);
    $('deleteAllBtn').addEventListener('click', deleteAllConfirm);
  }

  // ─── Data loading ──────────────────────────────────────────────
  async function loadProducts() {
    loadingState.style.display = 'flex';
    emptyState.hidden = true;
    productsGrid.innerHTML = '';

    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_PRODUCTS' });
      allProducts = response?.products || [];
      updateStats();
      filterAndRender();
    } catch (err) {
      console.error('Failed to load products:', err);
      showToast('Không thể tải dữ liệu', 'error');
    } finally {
      loadingState.style.display = 'none';
    }
  }

  // ─── Stats ─────────────────────────────────────────────────────
  function updateStats() {
    $('totalCount').textContent = allProducts.length;

    const today = new Date().toDateString();
    const todayProducts = allProducts.filter(p => new Date(p.savedAt).toDateString() === today);
    $('todayCount').textContent = todayProducts.length;

    const analyzed = allProducts.filter(p => p.aiAnalyzed).length;
    $('analyzedCount').textContent = analyzed;

    const prices = allProducts.filter(p => p.priceNumber).map(p => p.priceNumber);
    if (prices.length) {
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      $('avgPrice').textContent = formatPrice(avg, allProducts.find(p => p.priceNumber)?.currency);
    } else {
      $('avgPrice').textContent = '–';
    }
  }

  // ─── Filter & sort ─────────────────────────────────────────────
  function filterAndRender() {
    filteredProducts = allProducts.filter(p => {
      const q = currentSearch.toLowerCase();
      const matchSearch = !q || [p.title, p.description, p.sellerName, p.rawText]
        .some(f => f?.toLowerCase().includes(q));
      const matchCond = !currentConditionFilter || p.condition === currentConditionFilter;
      return matchSearch && matchCond;
    });

    const [field, dir] = currentSort.split('_');
    filteredProducts.sort((a, b) => {
      let va = a[field], vb = b[field];
      if (field === 'price') { va = a.priceNumber || 0; vb = b.priceNumber || 0; }
      if (field === 'savedAt') { va = new Date(va); vb = new Date(vb); }
      if (field === 'title') { va = (va || '').toLowerCase(); vb = (vb || '').toLowerCase(); }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });

    renderProducts();
  }

  // ─── Render products ───────────────────────────────────────────
  function renderProducts() {
    productsGrid.innerHTML = '';
    if (!filteredProducts.length) {
      emptyState.hidden = false;
      return;
    }
    emptyState.hidden = true;
    filteredProducts.forEach(p => {
      productsGrid.appendChild(createProductCard(p));
    });
  }

  function createProductCard(product) {
    const card = document.createElement('div');
    card.className = 'product-card' + (compareIds.has(product.id) ? ' selected' : '');
    card.dataset.id = product.id;

    const thumb = product.images?.[0];
    const conditionClass = getConditionClass(product.condition);
    const conditionLabel = getConditionLabel(product.condition);

    card.innerHTML = `
      <input type="checkbox" class="card-checkbox" ${compareIds.has(product.id) ? 'checked' : ''}
             title="Thêm vào so sánh" />
      ${thumb
        ? `<img class="card-img" src="${escHtml(thumb)}" alt="${escHtml(product.title || '')}" loading="lazy" />`
        : `<div class="card-img-placeholder">📦</div>`}
      <div class="card-body">
        <div class="card-title">${escHtml(product.title || 'Không có tiêu đề')}</div>
        <div class="card-price ${product.priceNumber ? '' : 'no-price'}">
          ${product.price || 'Chưa rõ giá'}
        </div>
        <div class="card-meta">
          <span class="badge badge-${conditionClass}">${conditionLabel}</span>
          ${product.aiAnalyzed ? '<span class="badge badge-ai">🤖 AI</span>' : ''}
        </div>
        ${product.groupName ? `<div class="card-group">👥 <a href="${escHtml(product.groupUrl||'#')}" target="_blank" onclick="event.stopPropagation()">${escHtml(product.groupName)}</a></div>` : ''}
        <div class="card-date">${formatDate(product.savedAt)}</div>
      </div>
      <div class="card-actions">
        <button class="btn btn-sm btn-secondary open-btn">Xem chi tiết</button>
        <button class="btn-icon delete-btn" title="Xóa">🗑️</button>
      </div>
    `;

    const checkbox = card.querySelector('.card-checkbox');
    checkbox.addEventListener('click', e => {
      e.stopPropagation();
      toggleCompare(product.id, card);
    });

    card.querySelector('.open-btn').addEventListener('click', e => {
      e.stopPropagation();
      openProductModal(product.id);
    });

    card.querySelector('.delete-btn').addEventListener('click', e => {
      e.stopPropagation();
      deleteProduct(product.id, card);
    });

    card.addEventListener('click', () => openProductModal(product.id));
    return card;
  }

  // ─── Product modal ─────────────────────────────────────────────
  async function openProductModal(id) {
    openProductId = id;
    const product = allProducts.find(p => p.id === id);
    if (!product) return;

    modalContent.innerHTML = renderModalContent(product);

    modalContent.querySelector('#analyzeBtn')?.addEventListener('click', () => analyzeProduct(id));
    modalContent.querySelector('#saveNotesBtn')?.addEventListener('click', () => saveNotes(id));
    modalContent.querySelector('#openUrlBtn')?.addEventListener('click', () => {
      if (product.url) window.open(product.url, '_blank');
    });
    modalContent.querySelector('#addCompareBtn')?.addEventListener('click', () => {
      const card = productsGrid.querySelector(`[data-id="${id}"]`);
      toggleCompare(id, card);
      closeModal();
      setView('compare');
    });

    modalOverlay.hidden = false;
  }

  function renderModalContent(product) {
    const images = product.images || [];
    const ai = product.aiData || {};
    const conditionLabel = getConditionLabel(product.condition || ai.condition);

    return `
      ${images.length ? `
        <div class="modal-images">
          ${images.map(src => `<img class="modal-img" src="${escHtml(src)}" alt="Ảnh sản phẩm" />`).join('')}
        </div>` : ''}

      <div class="modal-title">${escHtml(product.title || ai.title || 'Không có tiêu đề')}</div>
      <div class="modal-price">${product.price || (ai.price ? `${ai.price} ${ai.currency || ''}` : 'Chưa rõ giá')}</div>

      <div class="modal-grid">
        <div class="modal-field">
          <label>Người bán</label>
          <p>${product.sellerName ? `<a href="${escHtml(product.sellerUrl || '#')}" target="_blank" style="color:var(--accent2)">${escHtml(product.sellerName)}</a>` : 'Không rõ'}</p>
        </div>
        <div class="modal-field">
          <label>Tình trạng</label>
          <p><span class="badge badge-${getConditionClass(product.condition || ai.condition)}">${conditionLabel}</span></p>
        </div>
        ${product.groupName ? `
        <div class="modal-field">
          <label>Nhóm bán hàng</label>
          <p><a href="${escHtml(product.groupUrl || '#')}" target="_blank" style="color:var(--accent2)">👥 ${escHtml(product.groupName)}</a></p>
        </div>` : ''}
        <div class="modal-field">
          <label>Đã lưu lúc</label>
          <p>${formatDateFull(product.savedAt)}</p>
        </div>
        <div class="modal-field">
          <label>Danh mục AI</label>
          <p>${ai.category || '–'}</p>
        </div>
      </div>

      ${product.aiAnalyzed && ai ? `
        <div class="ai-section">
          <div class="ai-section-title">🤖 Phân tích AI</div>
          ${ai.description ? `<div class="ai-field"><label>Mô tả</label><p>${escHtml(ai.description)}</p></div>` : ''}
          ${ai.estimatedValue ? `<div class="ai-field"><label>Giá trị ước tính</label><p style="color:var(--green)">${escHtml(String(ai.estimatedValue))}</p></div>` : ''}
          ${ai.keyFeatures?.length ? `
            <div class="ai-field">
              <label>Đặc điểm nổi bật</label>
              <div class="key-features">
                ${ai.keyFeatures.map(f => `<span class="key-feature">${escHtml(f)}</span>`).join('')}
              </div>
            </div>` : ''}
        </div>` : ''}

      <div class="modal-description">${escHtml(product.rawText || product.description || 'Không có mô tả')}</div>

      ${product.tags?.length ? `
        <div class="modal-tags">
          ${product.tags.map(t => `<span class="tag">${escHtml(t)}</span>`).join('')}
        </div>` : ''}

      <div class="modal-notes">
        <label style="font-size:12px;color:var(--text3);display:block;margin-bottom:6px;">GHI CHÚ CÁ NHÂN</label>
        <textarea id="notesInput" placeholder="Thêm ghi chú...">${escHtml(product.notes || '')}</textarea>
      </div>

      <div class="modal-actions">
        ${product.url ? `<button class="btn btn-secondary" id="openUrlBtn">🔗 Xem bài gốc</button>` : ''}
        <button class="btn btn-secondary" id="addCompareBtn">📊 Thêm vào so sánh</button>
        ${!product.aiAnalyzed ? `<button class="btn btn-primary" id="analyzeBtn">🤖 Phân tích AI</button>` : ''}
        <button class="btn btn-ghost" id="saveNotesBtn" style="margin-left:auto">💾 Lưu ghi chú</button>
      </div>
    `;
  }

  function closeModal() {
    modalOverlay.hidden = true;
    openProductId = null;
  }

  // ─── Compare ───────────────────────────────────────────────────
  function toggleCompare(id, cardEl) {
    if (compareIds.has(id)) {
      compareIds.delete(id);
      if (cardEl) {
        cardEl.classList.remove('selected');
        const cb = cardEl.querySelector('.card-checkbox');
        if (cb) cb.checked = false;
      }
    } else {
      if (compareIds.size >= 4) {
        showToast('Tối đa 4 sản phẩm để so sánh', 'error');
        return;
      }
      compareIds.add(id);
      if (cardEl) {
        cardEl.classList.add('selected');
        const cb = cardEl.querySelector('.card-checkbox');
        if (cb) cb.checked = true;
      }
    }
    updateCompareUI();
  }

  function updateCompareUI() {
    const count = compareIds.size;
    compareCount.textContent = count;
    compareBadge.textContent = count;
    compareBtn.disabled = count < 2;
  }

  function renderCompareView() {
    if (compareIds.size === 0) {
      compareTableWrap.innerHTML = `
        <div class="compare-empty">
          <p>Chưa chọn sản phẩm nào để so sánh.</p>
          <button class="btn btn-primary" onclick="setView('all')">Chọn sản phẩm</button>
        </div>`;
      aiCompareResult.hidden = true;
      return;
    }

    const products = [...compareIds].map(id => allProducts.find(p => p.id === id)).filter(Boolean);

    const rows = [
      ['Ảnh', p => p.images?.[0]
        ? `<img class="compare-img" src="${escHtml(p.images[0])}" alt="" />`
        : '<div style="color:var(--text3);font-size:24px">📦</div>'],
      ['Tiêu đề', p => escHtml(p.title || p.aiData?.title || '–')],
      ['Giá', p => `<strong style="color:var(--green)">${p.price || '–'}</strong>`],
      ['Tình trạng', p => `<span class="badge badge-${getConditionClass(p.condition || p.aiData?.condition)}">${getConditionLabel(p.condition || p.aiData?.condition)}</span>`],
      ['Danh mục', p => escHtml(p.aiData?.category || '–')],
      ['Người bán', p => escHtml(p.sellerName || '–')],
      ['Mô tả AI', p => escHtml(p.aiData?.description || p.description || p.rawText?.slice(0, 120) + '…' || '–')],
      ['Ngày lưu', p => formatDate(p.savedAt)],
    ];

    let html = '<table class="compare-table"><thead><tr><th></th>';
    products.forEach(p => {
      html += `<th class="col-header">${escHtml(p.title?.slice(0, 40) || 'Sản phẩm')}</th>`;
    });
    html += '</tr></thead><tbody>';

    rows.forEach(([label, render]) => {
      html += `<tr><th>${label}</th>`;
      products.forEach(p => { html += `<td>${render(p)}</td>`; });
      html += '</tr>';
    });
    html += `<tr><th>Hành động</th>`;
    products.forEach(p => {
      html += `<td>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-sm btn-secondary" onclick="openProductModal('${p.id}')">Chi tiết</button>
          ${p.url ? `<a class="btn btn-sm btn-ghost" href="${escHtml(p.url)}" target="_blank">🔗 Gốc</a>` : ''}
        </div>
      </td>`;
    });
    html += '</tr></tbody></table>';

    compareTableWrap.innerHTML = html;

    const hasAi = products.some(p => p.aiAnalyzed);
    if (!hasAi) {
      const wrap = document.createElement('div');
      wrap.style.marginTop = '16px';
      wrap.innerHTML = `<button class="btn btn-primary" id="aiCompareBtn">🤖 So sánh bằng AI</button>`;
      compareTableWrap.appendChild(wrap);
      wrap.querySelector('#aiCompareBtn').addEventListener('click', () => runAiCompare(products));
    }
  }

  async function runAiCompare(products) {
    aiLoadingOverlay.hidden = false;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'COMPARE_PRODUCTS',
        ids: products.map(p => p.id)
      });
      if (response?.result) {
        renderAiComparison(response.result, products);
      } else {
        showToast('Không thể so sánh AI. Kiểm tra cài đặt API key.', 'error');
      }
    } catch (err) {
      showToast('Lỗi khi so sánh AI', 'error');
    } finally {
      aiLoadingOverlay.hidden = true;
    }
  }

  function renderAiComparison(result, products) {
    aiCompareResult.hidden = false;
    let html = '';
    if (result.summary) {
      html += `<p style="margin-bottom:16px;color:var(--text2)">${escHtml(result.summary)}</p>`;
    }
    if (result.rankings?.length) {
      html += '<div class="ai-ranking">';
      result.rankings.forEach((r, i) => {
        const p = products.find(pr => pr.id === r.id);
        html += `
          <div class="ai-rank-card">
            <div class="ai-rank-num">#${i + 1}</div>
            <div class="ai-rank-title">${escHtml(p?.title?.slice(0, 50) || r.id)}</div>
            <div class="ai-pros-cons">
              ${r.pros?.map(pro => `<div class="pro">✓ ${escHtml(pro)}</div>`).join('') || ''}
              ${r.cons?.map(con => `<div class="con">✗ ${escHtml(con)}</div>`).join('') || ''}
            </div>
            ${r.score !== undefined ? `<div class="ai-score">Điểm: ${r.score}/10</div>` : ''}
          </div>`;
      });
      html += '</div>';
    }
    if (result.recommendation) {
      html += `<p style="margin-top:16px;color:var(--accent2);font-style:italic">💡 ${escHtml(result.recommendation)}</p>`;
    }
    aiCompareContent.innerHTML = html;
  }

  // ─── Tags view ─────────────────────────────────────────────────
  function renderTagsView() {
    const tagsContainer = $('tagsContainer');
    const tagMap = {};
    allProducts.forEach(p => {
      (p.tags || []).forEach(tag => {
        if (!tagMap[tag]) tagMap[tag] = [];
        tagMap[tag].push(p);
      });
    });

    if (!Object.keys(tagMap).length) {
      tagsContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">🏷️</div><h3>Chưa có thẻ nào</h3><p>Thẻ được thêm tự động khi AI phân tích sản phẩm.</p></div>`;
      return;
    }

    const sortedTags = Object.entries(tagMap).sort((a, b) => b[1].length - a[1].length);
    tagsContainer.innerHTML = sortedTags.map(([tag, products]) => `
      <div class="tag-section">
        <h3>${escHtml(tag)} <span class="tag-count">${products.length}</span></h3>
        <div class="products-grid">
          ${products.map(p => createProductCard(p).outerHTML).join('')}
        </div>
      </div>
    `).join('');

    tagsContainer.querySelectorAll('.product-card').forEach(card => {
      const id = card.dataset.id;
      card.addEventListener('click', () => openProductModal(id));
      card.querySelector('.open-btn')?.addEventListener('click', e => { e.stopPropagation(); openProductModal(id); });
      card.querySelector('.delete-btn')?.addEventListener('click', e => { e.stopPropagation(); deleteProduct(id, card); });
    });
  }

  // ─── AI Analyze ────────────────────────────────────────────────
  async function analyzeProduct(id) {
    aiLoadingOverlay.hidden = false;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'ANALYZE_PRODUCT', id });
      if (response?.product) {
        const idx = allProducts.findIndex(p => p.id === id);
        if (idx >= 0) allProducts[idx] = response.product;
        updateStats();
        filterAndRender();
        openProductModal(id);
        showToast('Phân tích AI hoàn thành!', 'success');
      } else {
        showToast('Không thể phân tích. Kiểm tra cài đặt API key.', 'error');
      }
    } catch (err) {
      showToast('Lỗi khi phân tích AI', 'error');
    } finally {
      aiLoadingOverlay.hidden = true;
    }
  }

  // ─── Save notes ────────────────────────────────────────────────
  async function saveNotes(id) {
    const notesInput = document.getElementById('notesInput');
    if (!notesInput) return;
    const notes = notesInput.value;
    try {
      await chrome.runtime.sendMessage({ type: 'UPDATE_PRODUCT_NOTES', id, notes });
      const product = allProducts.find(p => p.id === id);
      if (product) product.notes = notes;
      showToast('Đã lưu ghi chú', 'success');
    } catch (err) {
      showToast('Lỗi khi lưu ghi chú', 'error');
    }
  }

  // ─── Delete ────────────────────────────────────────────────────
  async function deleteProduct(id, cardEl) {
    if (!confirm('Xóa sản phẩm này?')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_PRODUCT', id });
      allProducts = allProducts.filter(p => p.id !== id);
      compareIds.delete(id);
      updateCompareUI();
      updateStats();
      cardEl?.remove();
      if (!productsGrid.children.length) emptyState.hidden = false;
      showToast('Đã xóa sản phẩm', 'success');
    } catch (err) {
      showToast('Lỗi khi xóa', 'error');
    }
  }

  async function deleteAllConfirm() {
    if (!confirm('Xóa TẤT CẢ sản phẩm? Hành động này không thể hoàn tác!')) return;
    if (!confirm('Bạn chắc chắn? Toàn bộ dữ liệu sẽ bị xóa vĩnh viễn.')) return;
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_ALL_PRODUCTS' });
      allProducts = [];
      compareIds.clear();
      updateCompareUI();
      updateStats();
      filterAndRender();
      showToast('Đã xóa tất cả dữ liệu', 'success');
    } catch (err) {
      showToast('Lỗi khi xóa dữ liệu', 'error');
    }
  }

  // ─── Export / Import ───────────────────────────────────────────
  async function exportData() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
      const json = JSON.stringify(response?.data || {}, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `fb-order-saver-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Đã xuất dữ liệu', 'success');
    } catch (err) {
      showToast('Lỗi khi xuất dữ liệu', 'error');
    }
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data: json });
      await loadProducts();
      showToast(`Đã nhập dữ liệu thành công`, 'success');
    } catch (err) {
      showToast('File không hợp lệ hoặc lỗi khi nhập', 'error');
    }
    e.target.value = '';
  }

  // ─── Helpers ───────────────────────────────────────────────────
  function getConditionClass(condition) {
    const map = { new: 'new', like_new: 'like_new', used: 'used', old: 'old' };
    return map[condition?.toLowerCase()] || 'unknown';
  }

  function getConditionLabel(condition) {
    const map = { new: 'Mới', like_new: 'Như mới', used: 'Đã dùng', old: 'Cũ', unknown: 'Không rõ' };
    return map[condition?.toLowerCase()] || 'Không rõ';
  }

  function formatPrice(num, currency = 'đ') {
    return num.toLocaleString('vi-VN') + currency;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return 'Vừa xong';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} phút trước`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} giờ trước`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} ngày trước`;
    return d.toLocaleDateString('vi-VN');
  }

  function formatDateFull(iso) {
    if (!iso) return '–';
    return new Date(iso).toLocaleString('vi-VN');
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }

  // ─── Expose for HTML onclick ───────────────────────────────────
  window.openProductModal = openProductModal;

  // ─── Start ─────────────────────────────────────────────────────
  init();
})();
