(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  // ─── Toast helper (uses settings.html's built-in toast) ─────────
  function showToast(message, type = 'info') {
    const toast = document.querySelector('.toast');
    const toastIcon = $('toastIcon');
    const toastMessage = $('toastMessage');
    if (!toast) return;

    toast.className = `toast toast-${type}`;
    if (toastMessage) toastMessage.textContent = message;

    const icons = {
      success: '<polyline points="20 6 9 17 4 12"/>',
      error: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
      info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    };
    if (toastIcon) toastIcon.innerHTML = icons[type] || icons.info;

    toast.removeAttribute('hidden');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.setAttribute('hidden', ''), 3000);
  }

  let currentSettings = {};

  // ─── Nav sidebar ────────────────────────────────────────────────
  function setupNav() {
    const menuToggle = $('menuToggle');
    const sidebar = document.querySelector('.sidebar');
    menuToggle?.addEventListener('click', () => {
      sidebar?.classList.toggle('open');
    });

    document.querySelectorAll('.nav-link[data-section]').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const target = link.dataset.section;
        document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
        document.querySelectorAll('.settings-section').forEach(s => s.classList.remove('active'));
        link.classList.add('active');
        $('section-' + target)?.classList.add('active');
        sidebar?.classList.remove('open');
      });
    });
  }

  // ─── Load settings ──────────────────────────────────────────────
  async function loadSettings() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      currentSettings = res?.settings || {};
      applyToUI(currentSettings);
    } catch (err) {
      console.error('loadSettings:', err);
    }
  }

  function applyToUI(s) {
    // AI provider
    const providerRadio = document.querySelector(`input[name="aiProvider"][value="${s.aiProvider || s.provider || 'openai'}"]`);
    if (providerRadio) { providerRadio.checked = true; updateProviderHint(providerRadio.value); }

    // API key
    const apiKeyInput = $('apiKeyInput');
    if (apiKeyInput) {
      apiKeyInput.value = s.hasApiKey ? '••••••••••••••••' : '';
      apiKeyInput.dataset.masked = s.hasApiKey ? '1' : '0';
    }

    // Auto-analyze
    const autoAnalyze = $('autoAnalyze');
    if (autoAnalyze) autoAnalyze.checked = s.autoAnalyze !== false;

    // Cloud sync
    const enableSync = $('enableSync');
    if (enableSync) { enableSync.checked = !!s.syncEnabled; toggleSyncConfig(!!s.syncEnabled); }
    if ($('cloudEndpoint')) $('cloudEndpoint').value = s.cloudEndpoint || '';

    const cloudApiKey = $('cloudApiKey');
    if (cloudApiKey) {
      cloudApiKey.value = s.hasSyncApiKey ? '••••••••••••••••' : '';
      cloudApiKey.dataset.masked = s.hasSyncApiKey ? '1' : '0';
    }

    // Show save button on
    const showOn = document.querySelector(`input[name="showSaveBtn"][value="${s.showOn || 'both'}"]`);
    if (showOn) showOn.checked = true;

    // Notification style
    const notifStyle = document.querySelector(`input[name="notificationStyle"][value="${s.notifStyle || 'toast'}"]`);
    if (notifStyle) notifStyle.checked = true;

    // Last sync
    if ($('lastSyncTime') && s.lastSyncAt) {
      $('lastSyncTime').textContent = new Date(s.lastSyncAt).toLocaleString('vi-VN');
    }
  }

  function toggleSyncConfig(enabled) {
    const syncConfig = document.querySelector('.sync-config');
    if (syncConfig) syncConfig.style.display = enabled ? 'block' : 'none';
  }

  function updateProviderHint(provider) {
    const cardTitle = $('apiKeyCardTitle');
    if (!cardTitle) return;
    const labels = {
      openai: 'OpenAI API Key',
      anthropic: 'Anthropic API Key',
      gemini: 'Google Gemini API Key',
      cloud: 'Cloud Service Token',
    };
    cardTitle.textContent = labels[provider] || 'API Key';
  }

  // ─── Collect settings ───────────────────────────────────────────
  function collectSettings() {
    const provider = document.querySelector('input[name="aiProvider"]:checked')?.value || 'openai';
    const showOn = document.querySelector('input[name="showSaveBtn"]:checked')?.value || 'both';
    const notifStyle = document.querySelector('input[name="notificationStyle"]:checked')?.value || 'toast';

    const settings = {
      aiProvider: provider,
      provider,
      autoAnalyze: $('autoAnalyze')?.checked !== false,
      syncEnabled: $('enableSync')?.checked || false,
      cloudEndpoint: $('cloudEndpoint')?.value?.trim() || '',
      showOn,
      notifStyle,
    };

    // Only include keys if they changed (not the masked placeholder)
    const apiKeyInput = $('apiKeyInput');
    if (apiKeyInput?.dataset.masked !== '1') {
      settings.apiKey = apiKeyInput?.value?.trim() || '';
    }

    const cloudApiKey = $('cloudApiKey');
    if (cloudApiKey?.dataset.masked !== '1') {
      settings.syncApiKey = cloudApiKey?.value?.trim() || '';
    }

    return settings;
  }

  // ─── Save ────────────────────────────────────────────────────────
  async function saveSettings() {
    const btn = $('btnSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang lưu...'; }
    try {
      const settings = collectSettings();
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings });
      currentSettings = { ...currentSettings, ...settings };
      showToast('Đã lưu cài đặt thành công!', 'success');
    } catch (err) {
      showToast('Lỗi khi lưu cài đặt', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>Lưu cài đặt'; }
    }
  }

  // ─── Test API ────────────────────────────────────────────────────
  async function testApi() {
    const btn = $('btnTestApi');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang kiểm tra...'; }
    try {
      const settings = collectSettings();
      const res = await chrome.runtime.sendMessage({ type: 'TEST_API', settings });
      if (res?.ok) {
        showToast('✅ Kết nối thành công!', 'success');
      } else {
        showToast(`❌ ${res?.error || 'Không thể kết nối'}`, 'error');
      }
    } catch (err) {
      showToast('❌ Không thể kiểm tra kết nối', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Kiểm tra kết nối'; }
    }
  }

  // ─── Sync now ────────────────────────────────────────────────────
  async function syncNow() {
    const btn = $('btnSyncNow');
    if (btn) { btn.disabled = true; btn.textContent = 'Đang đồng bộ...'; }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
      if (res?.ok || res?.success) {
        showToast(`✅ Đồng bộ thành công! ${res.count || 0} sản phẩm`, 'success');
        if ($('lastSyncTime')) $('lastSyncTime').textContent = new Date().toLocaleString('vi-VN');
      } else {
        showToast(`❌ ${res?.error || 'Lỗi đồng bộ'}`, 'error');
      }
    } catch (err) {
      showToast('❌ Không thể đồng bộ', 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔄 Đồng bộ ngay'; }
    }
  }

  // ─── Export ──────────────────────────────────────────────────────
  async function exportData() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'EXPORT_DATA' });
      const json = JSON.stringify(res?.data || {}, null, 2);
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

  // ─── Import ──────────────────────────────────────────────────────
  async function importData(file) {
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      const res = await chrome.runtime.sendMessage({ type: 'IMPORT_DATA', data: json });
      showToast(`Đã nhập ${res?.count || 0} sản phẩm`, 'success');
    } catch (err) {
      showToast('File không hợp lệ hoặc lỗi khi nhập', 'error');
    }
  }

  // ─── Delete all ──────────────────────────────────────────────────
  async function deleteAll() {
    const deleteBtn = $('btnDeleteAll');
    if (deleteBtn?.dataset.confirmed !== '1') {
      if (deleteBtn) {
        deleteBtn.dataset.confirmed = '1';
        deleteBtn.textContent = 'Nhấn lần nữa để xác nhận';
        deleteBtn.style.background = '#dc2626';
      }
      setTimeout(() => {
        if (deleteBtn) {
          deleteBtn.dataset.confirmed = '0';
          deleteBtn.textContent = '🗑️ Xóa tất cả dữ liệu';
          deleteBtn.style.background = '';
        }
      }, 4000);
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_ALL_PRODUCTS' });
      showToast('Đã xóa tất cả dữ liệu', 'success');
      if (deleteBtn) { deleteBtn.dataset.confirmed = '0'; }
    } catch (err) {
      showToast('Lỗi khi xóa dữ liệu', 'error');
    }
  }

  // ─── Toggle API key visibility ──────────────────────────────────
  function setupKeyToggle(inputId, btnId) {
    const input = $(inputId);
    const btn = $(btnId);
    if (!input || !btn) return;
    input.addEventListener('focus', () => {
      if (input.dataset.masked === '1') { input.value = ''; input.dataset.masked = '0'; }
    });
    btn.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  }

  // ─── Events ──────────────────────────────────────────────────────
  function setupEvents() {
    $('btnSave')?.addEventListener('click', saveSettings);
    $('btnTestApi')?.addEventListener('click', testApi);
    $('btnSyncNow')?.addEventListener('click', syncNow);
    $('btnExport')?.addEventListener('click', exportData);

    const importBtn = $('btnImport');
    const importFile = $('importFileInput');
    importBtn?.addEventListener('click', () => importFile?.click());
    importFile?.addEventListener('change', e => {
      const file = e.target.files[0];
      if (file) { importData(file); e.target.value = ''; }
    });

    $('btnDeleteAll')?.addEventListener('click', deleteAll);

    $('enableSync')?.addEventListener('change', e => toggleSyncConfig(e.target.checked));

    document.querySelectorAll('input[name="aiProvider"]').forEach(radio => {
      radio.addEventListener('change', () => updateProviderHint(radio.value));
    });

    setupKeyToggle('apiKeyInput', 'toggleApiKey');
    setupKeyToggle('cloudApiKey', 'toggleCloudKey');
  }

  // ─── Init ────────────────────────────────────────────────────────
  async function init() {
    setupNav();
    setupEvents();
    await loadSettings();
  }

  init();
})();
