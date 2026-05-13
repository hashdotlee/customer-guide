(function () {
  'use strict';

  const PFX = 'fbos';
  const INJECTED_ATTR = `data-${PFX}-injected`;
  const SAVED_ATTR = `data-${PFX}-saved`;
  const DEBOUNCE_MS = 500;

  /* ─── Utilities ─────────────────────────────────────────────── */
  function qs(root, sel) { try { return root.querySelector(sel); } catch { return null; } }
  function qsa(root, sel) { try { return Array.from(root.querySelectorAll(sel)); } catch { return []; } }

  function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /* ─── Saved ID cache ─────────────────────────────────────────── */
  const savedIds = new Set();
  function loadSavedIds() {
    chrome.storage.local.get('savedPostIds', r => {
      (r.savedPostIds || []).forEach(id => savedIds.add(id));
      document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(el => {
        const id = el.dataset[`${PFX}Id`];
        if (id && savedIds.has(id)) markSaved(el);
      });
    });
  }
  function persistId(id) {
    savedIds.add(id);
    chrome.storage.local.get('savedPostIds', r => {
      const ids = r.savedPostIds || [];
      if (!ids.includes(id)) chrome.storage.local.set({ savedPostIds: [...ids, id] });
    });
  }

  /* ─── Toast ──────────────────────────────────────────────────── */
  let _toastWrap = null;
  function getToastWrap() {
    if (!_toastWrap || !document.body.contains(_toastWrap)) {
      _toastWrap = document.createElement('div');
      _toastWrap.id = `${PFX}-toasts`;
      document.body.appendChild(_toastWrap);
    }
    return _toastWrap;
  }
  function toast(msg, type = 'info', ms = 3000) {
    const el = document.createElement('div');
    el.className = `${PFX}-toast ${PFX}-toast--${type}`;
    el.innerHTML = `<span>${{ info: '🔖', success: '✅', error: '❌' }[type]}</span><span>${msg}</span>`;
    getToastWrap().appendChild(el);
    requestAnimationFrame(() => el.classList.add(`${PFX}-toast--in`));
    if (ms) setTimeout(() => { el.classList.remove(`${PFX}-toast--in`); setTimeout(() => el.remove(), 320); }, ms);
    return el;
  }
  function updateToast(el, msg, type) {
    el.className = `${PFX}-toast ${PFX}-toast--${type} ${PFX}-toast--in`;
    el.innerHTML = `<span>${{ info: '🔖', success: '✅', error: '❌' }[type]}</span><span>${msg}</span>`;
    setTimeout(() => { el.classList.remove(`${PFX}-toast--in`); setTimeout(() => el.remove(), 320); }, 3000);
  }

  /* ─── Data extraction ────────────────────────────────────────── */
  function extractText(el) {
    const sels = [
      '[data-ad-preview="message"]',
      '[data-testid="post_message"]',
      'div[data-ad-comet-preview="message"]',
    ];
    for (const s of sels) {
      const n = qs(el, s);
      if (n?.textContent?.trim().length > 5) return n.textContent.trim();
    }
    // Grab largest span[dir=auto]
    const spans = qsa(el, 'span[dir="auto"]').filter(s => s.textContent.trim().length > 10);
    if (spans.length) return spans.reduce((a, b) => a.textContent.length > b.textContent.length ? a : b).textContent.trim();
    return el.textContent.trim().slice(0, 2000);
  }

  function extractImages(el) {
    const srcs = new Set();
    qsa(el, 'img').forEach(img => {
      const src = img.src || img.getAttribute('data-src') || '';
      if (src && src.includes('fbcdn') && !src.includes('emoji') && !src.includes('static')) srcs.add(src);
    });
    return [...srcs];
  }

  function extractSeller(el) {
    // First h2/h3/h4 link that looks like a profile
    for (const tag of ['h2', 'h3', 'h4', 'strong']) {
      const a = qs(el, `${tag} a[href]`);
      if (a?.textContent?.trim()) return { sellerName: a.textContent.trim(), sellerUrl: a.href };
    }
    // Link near top of post
    const links = qsa(el, 'a[href*="facebook.com/"]').filter(a => {
      const t = a.textContent.trim();
      return t.length > 1 && t.length < 80 && !a.href.includes('/posts/') && !a.href.includes('story_fbid');
    });
    if (links.length) return { sellerName: links[0].textContent.trim(), sellerUrl: links[0].href };
    return { sellerName: '', sellerUrl: '' };
  }

  function extractPostUrl(el) {
    const a = qs(el, 'a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink/"], a[href*="/marketplace/item/"]');
    return a ? a.href : window.location.href;
  }

  function getPostId(el) {
    const url = extractPostUrl(el);
    const m = url.match(/(?:posts\/|story_fbid=|permalink\/|marketplace\/item\/)([A-Za-z0-9_-]+)/);
    if (m) return `post_${m[1]}`;
    let hash = 0;
    const t = el.textContent.slice(0, 200);
    for (let i = 0; i < t.length; i++) hash = ((hash << 5) - hash + t.charCodeAt(i)) | 0;
    return `post_h${Math.abs(hash)}`;
  }

  function extractMarketData(el) {
    const data = {};
    // Price patterns for VND
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.textContent.trim();
      if (/[\d.,]{3,}\s*[đ₫]|[đ₫]\s*[\d.,]{3,}|\d{4,}\s*VND/i.test(t) && t.length < 40) {
        data.price = t; break;
      }
    }
    // Title from heading
    const h = qs(el, 'h1, h2, h3, [class*="title"]');
    if (h) data.title = h.textContent.trim();
    return data;
  }

  function isMarketplace() { return /\/marketplace/.test(window.location.pathname); }

  /* ─── Build post data for a given element ─────────────────────── */
  function buildPostData(el) {
    const postId = getPostId(el);
    const { sellerName, sellerUrl } = extractSeller(el);
    const isMP = isMarketplace() || !!qs(el, 'a[href*="/marketplace/item/"]');
    return {
      id: postId,
      rawText: extractText(el),
      images: extractImages(el),
      sellerName,
      sellerUrl,
      postUrl: extractPostUrl(el),
      savedAt: new Date().toISOString(),
      isMarketplace: isMP,
      pageUrl: window.location.href,
      ...(isMP ? extractMarketData(el) : {}),
    };
  }

  /* ─── Mark saved ─────────────────────────────────────────────── */
  function markSaved(postEl) {
    postEl.setAttribute(SAVED_ATTR, '1');
    const btn = qs(postEl, `.${PFX}-btn`);
    if (btn) {
      btn.classList.add(`${PFX}-btn--saved`);
      btn.title = 'Đã lưu';
      btn.querySelector(`.${PFX}-btn-icon`).textContent = '🔖';
      btn.querySelector(`.${PFX}-btn-label`).textContent = 'Đã lưu';
    }
  }

  /* ─── Save handler ───────────────────────────────────────────── */
  async function handleSave(postEl, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const t = toast('Đang lưu...', 'info', 0);
    try {
      const postData = buildPostData(postEl);
      chrome.runtime.sendMessage({ type: 'SAVE_POST', data: postData }, (res) => {
        if (chrome.runtime.lastError) {
          updateToast(t, 'Lỗi kết nối extension', 'error');
          btn.disabled = false;
          return;
        }
        if (res?.success) {
          persistId(postData.id);
          markSaved(postEl);
          updateToast(t, res.aiAnalyzed ? 'Đã lưu & phân tích AI ✓' : 'Đã lưu! (chưa có AI key)', 'success');
        } else {
          updateToast(t, `Lỗi: ${res?.error || 'Không xác định'}`, 'error');
          btn.disabled = false;
        }
      });
    } catch (err) {
      updateToast(t, 'Lỗi: ' + err.message, 'error');
      btn.disabled = false;
    }
  }

  /* ─── Inject button ──────────────────────────────────────────── */
  function injectButton(postEl) {
    if (postEl.hasAttribute(INJECTED_ATTR)) return;

    // Only inject on elements with some text content (skip stubs/ads)
    const textLen = postEl.textContent?.trim().length || 0;
    if (textLen < 20) return;

    const postId = getPostId(postEl);
    postEl.setAttribute(INJECTED_ATTR, '1');
    postEl.dataset[`${PFX}Id`] = postId;

    const isSaved = savedIds.has(postId);
    if (isSaved) postEl.setAttribute(SAVED_ATTR, '1');

    // Create button
    const btn = document.createElement('button');
    btn.className = `${PFX}-btn${isSaved ? ` ${PFX}-btn--saved` : ''}`;
    btn.title = isSaved ? 'Đã lưu đơn hàng' : 'Lưu đơn hàng';
    btn.innerHTML = `<span class="${PFX}-btn-icon">${isSaved ? '🔖' : '🛍️'}</span><span class="${PFX}-btn-label">${isSaved ? 'Đã lưu' : 'Lưu đơn hàng'}</span>`;
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); handleSave(postEl, btn); });

    // Wrapper – positioned absolutely on top-right of the post
    const wrap = document.createElement('div');
    wrap.className = `${PFX}-wrap`;
    wrap.appendChild(btn);

    // Ensure postEl can contain absolute children
    const pos = getComputedStyle(postEl).position;
    if (pos === 'static') postEl.style.position = 'relative';

    postEl.appendChild(wrap);
  }

  /* ─── Find posts ─────────────────────────────────────────────── */
  function isValidPost(el) {
    // Must have reasonable content and not be a tiny widget
    const rect = el.getBoundingClientRect();
    // During initial load, rect may be 0; allow those too
    if (rect.width > 0 && rect.width < 100) return false;
    if (rect.height > 0 && rect.height < 80) return false;
    return true;
  }

  function scanPosts() {
    // Feed posts use role="article"; pick top-level ones (not nested inside another article)
    const articles = qsa(document, 'div[role="article"]');
    articles.forEach(el => {
      // Skip if this article is nested inside another article already injected
      const parentArticle = el.parentElement?.closest(`[${INJECTED_ATTR}]`);
      if (parentArticle) return;
      if (isValidPost(el)) injectButton(el);
    });

    // Marketplace listing cards
    if (isMarketplace()) {
      qsa(document, 'div[data-testid="marketplace_feed_item"], a[href*="/marketplace/item/"]').forEach(el => {
        const target = el.tagName === 'A' ? (el.parentElement || el) : el;
        if (!target.hasAttribute(INJECTED_ATTR) && isValidPost(target)) injectButton(target);
      });
    }
  }

  /* ─── MutationObserver ───────────────────────────────────────── */
  const debouncedScan = debounce(scanPosts, DEBOUNCE_MS);
  new MutationObserver(muts => {
    if (muts.some(m => m.addedNodes.length)) debouncedScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ─── SPA navigation ─────────────────────────────────────────── */
  ['pushState', 'replaceState'].forEach(method => {
    const orig = history[method].bind(history);
    history[method] = function (...args) { orig(...args); setTimeout(scanPosts, 800); };
  });
  window.addEventListener('popstate', () => setTimeout(scanPosts, 800));

  /* ─── Context menu / background messages ────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.type) {
      case 'PING':
        reply({ ok: true });
        break;

      case 'EXTRACT_CURRENT_POST': {
        // Context menu: find the most visible article on screen
        const articles = qsa(document, `[${INJECTED_ATTR}]`);
        let best = null, bestArea = 0;
        articles.forEach(el => {
          const r = el.getBoundingClientRect();
          const visH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
          const visW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
          const area = Math.max(0, visH) * Math.max(0, visW);
          if (area > bestArea) { bestArea = area; best = el; }
        });
        if (!best) {
          // No injected article found, try any article
          const any = qs(document, 'div[role="article"]');
          if (any) best = any;
        }
        if (best) {
          reply({ postData: buildPostData(best) });
        } else {
          // Fall back to page-level extraction
          reply({ postData: { rawText: msg.selectedText || document.body.innerText.slice(0, 2000), images: [], postUrl: window.location.href, savedAt: new Date().toISOString(), pageUrl: window.location.href } });
        }
        break;
      }

      case 'POST_SAVED': {
        if (msg.success && msg.product?.id) {
          const el = document.querySelector(`[data-${PFX}-id="${msg.product.id}"]`);
          if (el) markSaved(el);
          toast(msg.aiAnalyzed ? 'Đã lưu & phân tích AI ✓' : 'Đã lưu đơn hàng ✓', 'success');
        }
        break;
      }

      case 'REFRESH_SAVED_IDS':
        loadSavedIds();
        reply({ ok: true });
        break;

      case 'GET_PAGE_INFO':
        reply({ url: window.location.href, isMarketplace: isMarketplace(), posts: document.querySelectorAll(`[${INJECTED_ATTR}]`).length });
        break;

      default: break;
    }
    return true;
  });

  /* ─── Init ───────────────────────────────────────────────────── */
  loadSavedIds();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanPosts);
  } else {
    scanPosts();
    // Also retry after FB finishes rendering
    setTimeout(scanPosts, 1500);
    setTimeout(scanPosts, 3000);
  }
})();
