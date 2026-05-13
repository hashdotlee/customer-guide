/**
 * FB Order Saver – Settings Page Script
 * Full implementation: nav, validation, API key format check,
 * test connection, cloud sync, export/import, dialog confirm.
 */

'use strict';

// ── API Key validation patterns ───────────────────────────────────────────────
const API_KEY_PATTERNS = {
  openai:    /^sk-[A-Za-z0-9\-_]{20,}$/,
  anthropic: /^sk-ant-[A-Za-z0-9\-_]{20,}$/,
  gemini:    /^AIza[A-Za-z0-9\-_]{30,}$/,
  cloud:     /^.{8,}$/,
};

const API_KEY_META = {
  openai:    { placeholder: 'sk-…',          hint: 'Nhập API key từ platform.openai.com',    label: 'OpenAI API Key',         cardTitle: 'OpenAI API Key' },
  anthropic: { placeholder: 'sk-ant-…',      hint: 'Nhập API key từ console.anthropic.com',  label: 'Anthropic API Key',      cardTitle: 'Anthropic (Claude) API Key' },
  gemini:    { placeholder: 'AIzaSy…',       hint: 'Nhập API key từ aistudio.google.com',    label: 'Google Gemini API Key',  cardTitle: 'Google Gemini API Key' },
  cloud:     { placeholder: 'Bearer token…', hint: 'Token xác thực cho Cloud endpoint',       label: 'Cloud Service API Key',  cardTitle: 'Cloud Service API Key' },
};

const DEFAULT_SETTINGS = {
  aiProvider:        'openai',
  apiKey:            '',
  autoAnalyze:       false,
  enableSync:        false,
  cloudEndpoint:     '',
  cloudApiKey:       '',
  lastSync:          null,
  language:          'vi',
  showSaveBtn:       'both',
  notificationStyle: 'toast',
};

// ── State ─────────────────────────────────────────────────────────────────────
let _settings   = { ...DEFAULT_SETTINGS };
let _sidebarOpen = false;

// ── DOM shorthand ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNav();
  setupEvents();
  loadSettings();
});

// ══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════════════════════════════════════════════
function setupNav() {
  // Sidebar nav links (use data-section attribute)
  document.querySelectorAll('.nav-item[data-section]').forEach(item => {
    item.addEventListener('click', e => {
      e.preventDefault();
      navigateTo(item.dataset.section);
      if (window.innerWidth <= 680) closeSidebar();
    });
  });

  // Mobile hamburger
  $('menuToggle')?.addEventListener('click', () => {
    _sidebarOpen ? closeSidebar() : openSidebar();
  });

  // Sidebar overlay for mobile dismiss
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  overlay.id = 'sidebarOverlay';
  document.body.appendChild(overlay);
  overlay.addEventListener('click', closeSidebar);

  // Back link
  $('btnBack')?.addEventListener('click', e => { e.preventDefault(); window.close(); });

  // Navigate to hash on load
  const hash = location.hash.replace('#', '');
  navigateTo((hash && $(hash)) ? hash : 'ai-provider');
}

function navigateTo(sectionId) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === sectionId);
  });
  document.querySelectorAll('.settings-section').forEach(sec => {
    sec.classList.toggle('hidden', sec.id !== sectionId);
  });
  const sec = $(sectionId);
  if (sec && $('topbarTitle')) {
    $('topbarTitle').textContent = sec.dataset.title || sectionId;
  }
  history.replaceState(null, '', '#' + sectionId);
}

function openSidebar() {
  _sidebarOpen = true;
  document.querySelector('.sidebar')?.classList.add('open');
  $('menuToggle')?.setAttribute('aria-expanded', 'true');
  $('sidebarOverlay')?.classList.add('visible');
}

function closeSidebar() {
  _sidebarOpen = false;
  document.querySelector('.sidebar')?.classList.remove('open');
  $('menuToggle')?.setAttribute('aria-expanded', 'false');
  $('sidebarOverlay')?.classList.remove('visible');
}

// ══════════════════════════════════════════════════════════════════════════════
// EVENTS
// ══════════════════════════════════════════════════════════════════════════════
function setupEvents() {
  // Save
  $('btnSave')?.addEventListener('click', saveSettings);
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveSettings(); }
    if (e.key === 'Escape' && !$('dialogOverlay')?.classList.contains('hidden')) hideDialog();
  });

  // Provider radio
  document.querySelectorAll('input[name="aiProvider"]').forEach(radio => {
    radio.addEventListener('change', () => { if (radio.checked) onProviderChange(radio.value); });
  });

  // API key input + show/hide
  $('apiKeyInput')?.addEventListener('input', () => clearErr($('apiKeyInput'), $('apiKeyError')));
  $('toggleApiKey')?.addEventListener('click', () => {
    togglePwdVis($('apiKeyInput'), $('iconShow'), $('iconHide'));
  });

  // Auto analyze
  $('autoAnalyze');  // just referenced; no special handler needed beyond markDirty

  // Test API
  $('btnTestApi')?.addEventListener('click', testApiConnection);

  // Sync enable toggle
  $('enableSync')?.addEventListener('change', updateSyncFieldsVisibility);

  // Cloud endpoint
  $('cloudEndpoint')?.addEventListener('input', () => clearErr($('cloudEndpoint'), $('endpointError')));

  // Cloud key show/hide
  $('toggleCloudKey')?.addEventListener('click', () => {
    const input = $('cloudApiKey');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    const svg = $('toggleCloudKey').querySelector('svg');
    if (svg) svg.innerHTML = show
      ? `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`
      : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`;
  });

  // Sync Now
  $('btnSyncNow')?.addEventListener('click', syncNow);

  // Export / Import
  $('btnExport')?.addEventListener('click', exportData);
  $('btnImport')?.addEventListener('click', () => $('importFileInput')?.click());
  $('importFileInput')?.addEventListener('change', importData);

  // Danger zone – opens confirmation dialog
  $('btnDeleteAll')?.addEventListener('click', showDialog);
  $('dialogCancel')?.addEventListener('click', hideDialog);
  $('dialogOverlay')?.addEventListener('click', e => { if (e.target === $('dialogOverlay')) hideDialog(); });
  $('dialogConfirm')?.addEventListener('click', deleteAllData);
}

// ══════════════════════════════════════════════════════════════════════════════
// LOAD / SAVE
// ══════════════════════════════════════════════════════════════════════════════
function loadSettings() {
  sendMsg({ type: 'GET_SETTINGS' })
    .then(res => {
      if (res?.settings) _settings = { ...DEFAULT_SETTINGS, ...res.settings };
      populateForm();
    })
    .catch(() => {
      // Fallback: read directly from chrome.storage
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['settings'], result => {
          if (result.settings) _settings = { ...DEFAULT_SETTINGS, ...result.settings };
          populateForm();
        });
      } else {
        populateForm();
      }
    });
}

function populateForm() {
  // Provider
  const providerRadio = document.querySelector(`input[name="aiProvider"][value="${_settings.aiProvider}"]`);
  if (providerRadio) { providerRadio.checked = true; onProviderChange(_settings.aiProvider, true); }

  // API key – show masked dots if key exists, clear field
  const apiKeyInput = $('apiKeyInput');
  if (apiKeyInput) {
    apiKeyInput.value = _settings.apiKey ? '•'.repeat(16) : '';
    apiKeyInput.dataset.masked = _settings.apiKey ? '1' : '0';
    // Clear mask on focus so user can type new key
    if (!apiKeyInput._maskListenerAttached) {
      apiKeyInput.addEventListener('focus', () => {
        if (apiKeyInput.dataset.masked === '1') { apiKeyInput.value = ''; apiKeyInput.dataset.masked = '0'; }
      });
      apiKeyInput._maskListenerAttached = true;
    }
  }

  if ($('autoAnalyze')) $('autoAnalyze').checked = Boolean(_settings.autoAnalyze);

  // Cloud sync
  if ($('enableSync')) $('enableSync').checked = Boolean(_settings.enableSync);
  if ($('cloudEndpoint')) $('cloudEndpoint').value = _settings.cloudEndpoint || '';

  const cloudKeyInput = $('cloudApiKey');
  if (cloudKeyInput) {
    cloudKeyInput.value = _settings.cloudApiKey ? '•'.repeat(16) : '';
    cloudKeyInput.dataset.masked = _settings.cloudApiKey ? '1' : '0';
    if (!cloudKeyInput._maskListenerAttached) {
      cloudKeyInput.addEventListener('focus', () => {
        if (cloudKeyInput.dataset.masked === '1') { cloudKeyInput.value = ''; cloudKeyInput.dataset.masked = '0'; }
      });
      cloudKeyInput._maskListenerAttached = true;
    }
  }

  updateLastSyncDisplay(_settings.lastSync);
  updateSyncFieldsVisibility();

  // Display
  if ($('languageSelect')) $('languageSelect').value = _settings.language || 'vi';
  setRadio('showSaveBtn', _settings.showSaveBtn || 'both');
  setRadio('notificationStyle', _settings.notificationStyle || 'toast');
}

async function saveSettings() {
  if (!validateForm()) return;

  const btn = $('btnSave');
  if (btn) { btn.disabled = true; btn.innerHTML = `<svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Đang lưu…`; }

  const newSettings = collectForm();

  try {
    await sendMsg({ type: 'SAVE_SETTINGS', settings: newSettings });
    if (typeof chrome !== 'undefined' && chrome.storage) {
      await storageSet({ settings: newSettings });
    }
    _settings = { ...newSettings };
    showFeedback('Đã lưu!', 'success');
    showPageToast('Cài đặt đã được lưu thành công.', 'success');
  } catch {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        await storageSet({ settings: newSettings });
        _settings = { ...newSettings };
        showFeedback('Đã lưu!', 'success');
        showPageToast('Cài đặt đã được lưu thành công.', 'success');
      } else throw new Error('no storage');
    } catch {
      showFeedback('Lỗi khi lưu!', 'error');
      showPageToast('Không thể lưu cài đặt. Vui lòng thử lại.', 'error');
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Lưu cài đặt`;
    }
  }
}

function collectForm() {
  const apiKeyInput  = $('apiKeyInput');
  const cloudKeyInput = $('cloudApiKey');
  return {
    aiProvider:        getRadio('aiProvider') || 'openai',
    // Preserve existing key if field is still masked
    apiKey:            (apiKeyInput?.dataset.masked === '1') ? _settings.apiKey : (apiKeyInput?.value.trim() || ''),
    autoAnalyze:       Boolean($('autoAnalyze')?.checked),
    enableSync:        Boolean($('enableSync')?.checked),
    cloudEndpoint:     $('cloudEndpoint')?.value.trim() || '',
    cloudApiKey:       (cloudKeyInput?.dataset.masked === '1') ? _settings.cloudApiKey : (cloudKeyInput?.value.trim() || ''),
    lastSync:          _settings.lastSync,
    language:          $('languageSelect')?.value || 'vi',
    showSaveBtn:       getRadio('showSaveBtn') || 'both',
    notificationStyle: getRadio('notificationStyle') || 'toast',
  };
}

// ── Validation ────────────────────────────────────────────────────────────────
function validateForm() {
  let ok = true;

  const provider    = getRadio('aiProvider') || 'openai';
  const apiKeyInput = $('apiKeyInput');
  const apiKey      = (apiKeyInput?.dataset.masked === '1') ? null : apiKeyInput?.value.trim();

  if (apiKey) {
    const pattern = API_KEY_PATTERNS[provider];
    if (pattern && !pattern.test(apiKey)) {
      showErr(apiKeyInput, $('apiKeyError'), getKeyErrMsg(provider));
      ok = false;
    }
  }

  if ($('enableSync')?.checked) {
    const ep = $('cloudEndpoint')?.value.trim();
    if (ep && !isUrl(ep)) {
      showErr($('cloudEndpoint'), $('endpointError'), 'URL không hợp lệ. Phải bắt đầu bằng https://');
      ok = false;
    }
  }

  return ok;
}

function getKeyErrMsg(p) {
  return { openai: 'API key OpenAI phải bắt đầu bằng sk-', anthropic: 'API key Anthropic phải bắt đầu bằng sk-ant-', gemini: 'API key Gemini phải bắt đầu bằng AIzaSy…', cloud: 'Key phải có ít nhất 8 ký tự.' }[p] || 'Định dạng API key không hợp lệ.';
}

function isUrl(s) {
  try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

// ── Provider change ───────────────────────────────────────────────────────────
function onProviderChange(provider, init = false) {
  const meta = API_KEY_META[provider] || API_KEY_META.openai;
  if ($('apiKeyInput'))     $('apiKeyInput').placeholder    = meta.placeholder;
  if ($('apiKeyHint'))      $('apiKeyHint').textContent      = meta.hint;
  if ($('apiKeyLabel'))     $('apiKeyLabel').textContent     = meta.label;
  if ($('apiKeyCardTitle')) $('apiKeyCardTitle').textContent = meta.cardTitle;
  if (!init) clearErr($('apiKeyInput'), $('apiKeyError'));
}

// ── Show/hide password ────────────────────────────────────────────────────────
function togglePwdVis(input, showIcon, hideIcon) {
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  showIcon?.classList.toggle('hidden', reveal);
  hideIcon?.classList.toggle('hidden', !reveal);
}

// ── Test API ──────────────────────────────────────────────────────────────────
async function testApiConnection() {
  const provider    = getRadio('aiProvider') || 'openai';
  const apiKeyInput = $('apiKeyInput');
  const apiKey      = apiKeyInput?.dataset.masked === '1' ? _settings.apiKey : apiKeyInput?.value.trim();

  if (!apiKey) {
    setStatus($('testStatus'), 'Vui lòng nhập API key trước.', 'error');
    return;
  }

  const pattern = API_KEY_PATTERNS[provider];
  if (pattern && !pattern.test(apiKey)) {
    setStatus($('testStatus'), 'API key sai định dạng.', 'error');
    return;
  }

  const btn = $('btnTestApi');
  if (btn) btn.disabled = true;
  setStatus($('testStatus'), 'Đang kiểm tra…', 'loading');

  try {
    const res = await sendMsg({ type: 'TEST_API', provider, apiKey });
    setStatus($('testStatus'), res?.success ? '✓ Kết nối thành công!' : `✗ ${res?.error || 'Kết nối thất bại'}`, res?.success ? 'success' : 'error');
  } catch {
    setStatus($('testStatus'), '✗ Không kết nối được với background.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setStatus($('testStatus'), '', ''), 6000);
  }
}

// ── Sync Now ──────────────────────────────────────────────────────────────────
async function syncNow() {
  const endpoint = $('cloudEndpoint')?.value.trim();
  if (!endpoint) { setStatus($('syncStatus'), 'Vui lòng nhập Endpoint URL.', 'error'); return; }
  if (!isUrl(endpoint)) { setStatus($('syncStatus'), 'Endpoint URL không hợp lệ.', 'error'); return; }

  const btn = $('btnSyncNow');
  if (btn) btn.disabled = true;
  setStatus($('syncStatus'), 'Đang đồng bộ…', 'loading');

  try {
    const cloudApiKey = $('cloudApiKey');
    const key = cloudApiKey?.dataset.masked === '1' ? _settings.cloudApiKey : cloudApiKey?.value.trim();
    const res = await sendMsg({ type: 'SYNC_NOW', endpoint, cloudApiKey: key });
    if (res?.success || res?.ok) {
      const now = new Date().toISOString();
      _settings.lastSync = now;
      updateLastSyncDisplay(now);
      setStatus($('syncStatus'), '✓ Đồng bộ thành công!', 'success');
    } else {
      setStatus($('syncStatus'), `✗ ${res?.error || 'Đồng bộ thất bại'}`, 'error');
    }
  } catch {
    setStatus($('syncStatus'), '✗ Lỗi khi đồng bộ.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setStatus($('syncStatus'), '', ''), 6000);
  }
}

function updateSyncFieldsVisibility() {
  const enabled = Boolean($('enableSync')?.checked);
  ['syncFields', 'syncKeyField', 'lastSyncRow'].forEach(id => {
    const el = $(id);
    if (el) el.style.opacity = enabled ? '1' : '0.45';
  });
  if ($('cloudEndpoint'))  $('cloudEndpoint').disabled  = !enabled;
  if ($('cloudApiKey'))    $('cloudApiKey').disabled    = !enabled;
  if ($('btnSyncNow'))     $('btnSyncNow').disabled     = !enabled;
}

function updateLastSyncDisplay(iso) {
  const el = $('lastSyncTime');
  if (!el) return;
  if (!iso) { el.textContent = 'Chưa đồng bộ'; return; }
  try {
    el.textContent = new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { el.textContent = iso; }
}

// ── Export ────────────────────────────────────────────────────────────────────
async function exportData() {
  const btn = $('btnExport');
  if (btn) btn.disabled = true;
  setStatus($('importExportStatus'), 'Đang xuất…', 'loading');

  try {
    const res      = await sendMsg({ type: 'GET_PRODUCTS' });
    const products = res?.products ?? [];
    const blob     = new Blob([JSON.stringify({ version: '1.0', exportedAt: new Date().toISOString(), count: products.length, products }, null, 2)], { type: 'application/json' });
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    a.href         = url;
    a.download     = `fb-order-saver-export-${datestamp()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus($('importExportStatus'), `✓ Đã xuất ${products.length} sản phẩm.`, 'success');
  } catch {
    setStatus($('importExportStatus'), '✗ Không thể xuất dữ liệu.', 'error');
  } finally {
    if (btn) btn.disabled = false;
    setTimeout(() => setStatus($('importExportStatus'), '', ''), 5000);
  }
}

// ── Import ────────────────────────────────────────────────────────────────────
function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  $('importFileInput').value = '';

  if (!file.name.endsWith('.json')) {
    setStatus($('importExportStatus'), '✗ Chỉ chấp nhận file .json', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = async evt => {
    try {
      const data = JSON.parse(evt.target.result);
      if (!Array.isArray(data.products)) throw new Error('File không đúng định dạng. Thiếu trường "products".');

      setStatus($('importExportStatus'), 'Đang nhập…', 'loading');
      const res = await sendMsg({ type: 'IMPORT_PRODUCTS', products: data.products });
      if (res?.success === false) throw new Error(res.error || 'Import failed');

      const count = data.products.length;
      setStatus($('importExportStatus'), `✓ Đã nhập ${count} sản phẩm.`, 'success');
      showPageToast(`Nhập thành công ${count} sản phẩm.`, 'success');
    } catch (err) {
      setStatus($('importExportStatus'), `✗ ${err.message || 'Không thể nhập dữ liệu.'}`, 'error');
    } finally {
      setTimeout(() => setStatus($('importExportStatus'), '', ''), 6000);
    }
  };
  reader.onerror = () => setStatus($('importExportStatus'), '✗ Không thể đọc file.', 'error');
  reader.readAsText(file, 'UTF-8');
}

// ── Delete All ────────────────────────────────────────────────────────────────
async function deleteAllData() {
  hideDialog();
  try {
    await sendMsg({ type: 'DELETE_ALL_DATA' });
  } catch { /* best-effort */ }
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      await new Promise((res, rej) => chrome.storage.local.clear(() => chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()));
    }
    _settings = { ...DEFAULT_SETTINGS };
    populateForm();
    showPageToast('Đã xóa toàn bộ dữ liệu.', 'success');
  } catch {
    showPageToast('Không thể xóa dữ liệu. Vui lòng thử lại.', 'error');
  }
}

// ── Dialog ────────────────────────────────────────────────────────────────────
function showDialog() {
  $('dialogOverlay')?.classList.remove('hidden');
  $('dialogConfirm')?.focus();
}

function hideDialog() {
  $('dialogOverlay')?.classList.add('hidden');
  $('btnDeleteAll')?.focus();
}

// ── Toast / Feedback ──────────────────────────────────────────────────────────
let _toastTimer = null;

function showPageToast(message, type = '') {
  clearTimeout(_toastTimer);
  const el = $('pageToast');
  if (!el) return;
  $('toastMessage').textContent = message;
  el.className = 'page-toast' + (type ? ' toast-' + type : '');
  $('toastIcon').innerHTML = type === 'error'
    ? `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`
    : `<polyline points="20 6 9 17 4 12"/>`;
  _toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

let _feedbackTimer = null;
function showFeedback(msg, type) {
  clearTimeout(_feedbackTimer);
  const el = $('saveFeedback');
  if (!el) return;
  el.textContent = msg;
  el.className = 'save-feedback ' + type;
  _feedbackTimer = setTimeout(() => { el.textContent = ''; el.className = 'save-feedback'; }, 3500);
}

// ── Field helpers ─────────────────────────────────────────────────────────────
function showErr(input, errEl, msg) {
  input?.classList.add('input-error');
  if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
  input?.focus();
}
function clearErr(input, errEl) {
  input?.classList.remove('input-error');
  errEl?.classList.add('hidden');
}
function setStatus(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.className = 'test-status' + (type ? ' ' + type : '');
}

// ── Radio helpers ─────────────────────────────────────────────────────────────
function getRadio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}
function setRadio(name, value) {
  const r = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (r) r.checked = true;
}

// ── Chrome messaging ──────────────────────────────────────────────────────────
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      reject(new Error('chrome.runtime not available'));
      return;
    }
    try {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(res);
      });
    } catch (err) { reject(err); }
  });
}

function storageSet(data) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

function datestamp() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}
