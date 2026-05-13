/**
 * FB Order Saver – Content Script
 * Injects "Lưu đơn hàng" buttons into Facebook posts and Marketplace listings,
 * extracts post data on click, and forwards it to the background service worker.
 */

(function () {
  'use strict';

  /* ─────────────────────────── Constants ─────────────────────────── */

  const EXT_PREFIX = 'fbos';                     // CSS / data-attr namespace
  const SAVED_ATTR = `data-${EXT_PREFIX}-saved`; // marks already-saved posts
  const INJECTED_ATTR = `data-${EXT_PREFIX}-btn`; // marks posts with a button
  const DEBOUNCE_MS = 400;                       // MutationObserver debounce

  /* ──────────────────────────── Utilities ────────────────────────── */

  /** Debounce: returns a function that delays execution until idle. */
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  /** Safe querySelector that never throws. */
  function qs(root, sel) {
    try { return root.querySelector(sel); } catch { return null; }
  }

  /** Safe querySelectorAll that never throws. */
  function qsa(root, sel) {
    try { return Array.from(root.querySelectorAll(sel)); } catch { return []; }
  }

  /** Generate a stable DOM-based ID for a post element. */
  function getPostId(postEl) {
    const link = qs(postEl, 'a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink"]');
    if (link) {
      const url = link.href;
      const m = url.match(/(?:posts\/|story_fbid=|permalink\/)(\d+)/);
      if (m) return `post_${m[1]}`;
    }
    // Fallback: hash the first 200 chars of text content
    const text = (postEl.textContent || '').trim().slice(0, 200);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash |= 0;
    }
    return `post_h${Math.abs(hash)}`;
  }

  /** Retrieve all unique image URLs inside a post element. */
  function extractImages(postEl) {
    const srcs = new Set();

    // <img> tags – Facebook uses data-src for lazy images
    qsa(postEl, 'img[src], img[data-src]').forEach(img => {
      const src = img.src || img.dataset.src;
      if (src && !src.includes('data:') && !src.includes('emoji') && src.includes('fbcdn')) {
        srcs.add(src);
      }
    });

    // background-image on divs (used in some post layouts)
    qsa(postEl, '[style*="background-image"]').forEach(el => {
      const m = el.style.backgroundImage.match(/url\("?([^")]+)"?\)/);
      if (m && m[1].includes('fbcdn')) srcs.add(m[1]);
    });

    // Open Graph / data attributes used in Marketplace cards
    qsa(postEl, '[data-imgperflogname]').forEach(el => {
      const src = el.getAttribute('src') || el.getAttribute('data-src');
      if (src) srcs.add(src);
    });

    return Array.from(srcs);
  }

  /** Extract seller name and profile URL from a post. */
  function extractSeller(postEl) {
    // Profile links: exclude "See more", share links, page links via role check
    const profileLinks = qsa(postEl,
      'a[href*="/profile.php"], a[href*="facebook.com/"][role="link"], h2 a, h3 a'
    ).filter(a => {
      const href = a.href || '';
      // Exclude action links
      return (
        href.includes('facebook.com') &&
        !href.includes('/posts/') &&
        !href.includes('story_fbid') &&
        !href.includes('/photos/') &&
        !href.includes('/videos/') &&
        !href.includes('/groups/') &&
        a.textContent.trim().length > 0 &&
        a.textContent.trim().length < 80
      );
    });

    if (profileLinks.length) {
      return {
        sellerName: profileLinks[0].textContent.trim(),
        sellerUrl: profileLinks[0].href,
      };
    }

    // Fallback: aria-label on actor element
    const actor = qs(postEl, '[data-ad-preview="message"] ~ * a, [data-testid="story-subtitle"] a');
    if (actor) {
      return { sellerName: actor.textContent.trim(), sellerUrl: actor.href };
    }

    return { sellerName: '', sellerUrl: '' };
  }

  /** Get the canonical URL of a post. */
  function extractPostUrl(postEl) {
    // Permalink anchor (timestamp link is usually the most reliable)
    const timeLink = qs(postEl, 'a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink/"]');
    if (timeLink) return timeLink.href;

    // Marketplace card URL
    const marketLink = qs(postEl, 'a[href*="/marketplace/item/"]');
    if (marketLink) return marketLink.href;

    return window.location.href;
  }

  /** Get post timestamp (ISO string). */
  function extractTimestamp(postEl) {
    const timeEl = qs(postEl, 'abbr[data-utime], time[datetime]');
    if (timeEl) {
      const utime = timeEl.dataset.utime;
      if (utime) return new Date(parseInt(utime, 10) * 1000).toISOString();
      const dt = timeEl.getAttribute('datetime');
      if (dt) return new Date(dt).toISOString();
    }
    return new Date().toISOString();
  }

  /** Extract raw visible text from a post. */
  function extractText(postEl) {
    // Facebook stores post body in data-ad-preview or inside specific spans
    const bodySelectors = [
      '[data-ad-preview="message"]',
      '[data-testid="post_message"]',
      'div[dir="auto"] > span',
      '.x11i5rnm span[dir="auto"]',   // newer FB layout
    ];

    for (const sel of bodySelectors) {
      const el = qs(postEl, sel);
      if (el && el.textContent.trim().length > 10) {
        return el.textContent.trim();
      }
    }

    // Fallback: strip UI chrome text, grab first large text block
    const spans = qsa(postEl, 'span[dir="auto"]').filter(s => s.textContent.trim().length > 20);
    if (spans.length) return spans[0].textContent.trim();

    return postEl.textContent.trim().slice(0, 1000);
  }

  /** Extract Marketplace-specific fields (price, title, condition). */
  function extractMarketplaceData(postEl) {
    const data = {};

    // Title: usually the first heading-like element in a card
    const titleEl = qs(postEl,
      '[data-testid="marketplace_listing_title"], ' +
      'span.x1lliihq, h2, h3, [class*="title"]'
    );
    if (titleEl) data.title = titleEl.textContent.trim();

    // Price: look for currency patterns
    const priceEl = qs(postEl, '[data-testid="marketplace_listing_price"]');
    if (priceEl) {
      data.price = priceEl.textContent.trim();
    } else {
      // Scan all text nodes for Vietnamese currency patterns
      const walker = document.createTreeWalker(postEl, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.textContent.trim();
        if (/[\d.,]+\s*[đ₫]|VND|[đ₫]\s*[\d.,]+|\d{4,}/.test(t) && t.length < 30) {
          data.price = t;
          break;
        }
      }
    }

    // Condition: look for common Vietnamese/English condition keywords
    const conditionEl = qs(postEl, '[data-testid="marketplace_listing_condition"]');
    if (conditionEl) {
      data.condition = conditionEl.textContent.trim();
    } else {
      const text = postEl.textContent;
      const m = text.match(/\b(New|Used|Like new|Mới|Đã qua sử dụng|Còn mới|Cũ)\b/i);
      if (m) data.condition = m[0];
    }

    return data;
  }

  /** Check current page context. */
  function isMarketplacePage() {
    return window.location.pathname.startsWith('/marketplace');
  }

  /* ──────────────────────────── Saved-state cache ────────────────── */

  /** In-memory set of saved post IDs (synced from storage on load). */
  const savedPostIds = new Set();

  function loadSavedIds() {
    chrome.storage.local.get('savedPostIds', result => {
      if (result.savedPostIds && Array.isArray(result.savedPostIds)) {
        result.savedPostIds.forEach(id => savedPostIds.add(id));
      }
      // Re-mark any already-injected posts
      document.querySelectorAll(`[${INJECTED_ATTR}]`).forEach(postEl => {
        const id = postEl.dataset[`${EXT_PREFIX}Id`];
        if (id && savedPostIds.has(id)) markPostAsSaved(postEl);
      });
    });
  }

  function persistSavedId(id) {
    savedPostIds.add(id);
    chrome.storage.local.get('savedPostIds', result => {
      const ids = result.savedPostIds || [];
      if (!ids.includes(id)) {
        ids.push(id);
        chrome.storage.local.set({ savedPostIds: ids });
      }
    });
  }

  /* ──────────────────────────── Toast ────────────────────────────── */

  let toastContainer = null;

  function getToastContainer() {
    if (!toastContainer || !document.body.contains(toastContainer)) {
      toastContainer = document.createElement('div');
      toastContainer.id = `${EXT_PREFIX}-toast-container`;
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  /**
   * Show a toast notification.
   * @param {string} message
   * @param {'info'|'success'|'error'} type
   * @param {number} duration  ms before auto-dismiss (0 = manual)
   * @returns {HTMLElement} toast element (can be updated)
   */
  function showToast(message, type = 'info', duration = 3000) {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `${EXT_PREFIX}-toast ${EXT_PREFIX}-toast--${type}`;
    toast.setAttribute('role', 'alert');

    const iconMap = { info: '🔖', success: '✅', error: '❌' };
    toast.innerHTML =
      `<span class="${EXT_PREFIX}-toast__icon">${iconMap[type] || '🔖'}</span>` +
      `<span class="${EXT_PREFIX}-toast__msg">${message}</span>`;

    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => toast.classList.add(`${EXT_PREFIX}-toast--visible`));

    if (duration > 0) {
      setTimeout(() => dismissToast(toast), duration);
    }

    return toast;
  }

  function dismissToast(toast) {
    toast.classList.remove(`${EXT_PREFIX}-toast--visible`);
    toast.classList.add(`${EXT_PREFIX}-toast--exit`);
    setTimeout(() => toast.remove(), 350);
  }

  function updateToast(toast, message, type = 'success') {
    const msgEl = toast.querySelector(`.${EXT_PREFIX}-toast__msg`);
    const iconEl = toast.querySelector(`.${EXT_PREFIX}-toast__icon`);
    const iconMap = { info: '🔖', success: '✅', error: '❌' };
    if (msgEl) msgEl.textContent = message;
    if (iconEl) iconEl.textContent = iconMap[type] || '🔖';
    toast.className = `${EXT_PREFIX}-toast ${EXT_PREFIX}-toast--${type} ${EXT_PREFIX}-toast--visible`;
    setTimeout(() => dismissToast(toast), 3000);
  }

  /* ────────────────────────── Save-button injection ──────────────── */

  /** Create the "Lưu đơn hàng" button element. */
  function createSaveButton(postId, isSaved) {
    const btn = document.createElement('button');
    btn.className = `${EXT_PREFIX}-save-btn${isSaved ? ` ${EXT_PREFIX}-save-btn--saved` : ''}`;
    btn.setAttribute(`data-${EXT_PREFIX}-postid`, postId);
    btn.title = isSaved ? 'Đã lưu đơn hàng' : 'Lưu đơn hàng';
    btn.innerHTML =
      `<span class="${EXT_PREFIX}-save-btn__icon">${isSaved ? '🔖' : '🛍️'}</span>` +
      `<span class="${EXT_PREFIX}-save-btn__label">${isSaved ? 'Đã lưu' : 'Lưu đơn hàng'}</span>`;
    return btn;
  }

  /** Create the "already-saved" corner indicator. */
  function createSavedIndicator() {
    const ind = document.createElement('div');
    ind.className = `${EXT_PREFIX}-saved-indicator`;
    ind.title = 'Đã lưu đơn hàng';
    ind.textContent = '🔖';
    return ind;
  }

  /** Mark a post element as saved (visual update). */
  function markPostAsSaved(postEl) {
    postEl.setAttribute(SAVED_ATTR, 'true');

    // Update button if present
    const btn = qs(postEl, `.${EXT_PREFIX}-save-btn`);
    if (btn) {
      btn.classList.add(`${EXT_PREFIX}-save-btn--saved`);
      btn.title = 'Đã lưu đơn hàng';
      const icon = btn.querySelector(`.${EXT_PREFIX}-save-btn__icon`);
      const label = btn.querySelector(`.${EXT_PREFIX}-save-btn__label`);
      if (icon) icon.textContent = '🔖';
      if (label) label.textContent = 'Đã lưu';
    }

    // Add corner indicator if not already present
    if (!qs(postEl, `.${EXT_PREFIX}-saved-indicator`)) {
      // Make the post relatively positioned so we can use absolute corner
      const style = getComputedStyle(postEl);
      if (style.position === 'static') postEl.style.position = 'relative';
      postEl.appendChild(createSavedIndicator());
    }
  }

  /* ────────────────────────── Post-action bar detection ──────────────────── */

  /**
   * Find the best insertion point for the save button within a post.
   * Returns { container, insertBefore } or null.
   */
  function findActionBar(postEl) {
    // Standard Feed: action bar contains Like / Comment / Share buttons
    const actionBar = qs(postEl,
      '[data-testid="UFI2Actions"], ' +           // older FB
      '[aria-label="Leave a comment"], ' +         // comment button vicinity
      'div[role="toolbar"], ' +
      '.x1i10hfl[role="button"][tabindex="0"]'     // generic action rows
    );
    if (actionBar && actionBar.parentElement) {
      return { container: actionBar.parentElement, insertBefore: actionBar.nextSibling };
    }

    // Marketplace card: bottom metadata row
    const metaRow = qs(postEl, 'div > span > span, [class*="price"], [class*="location"]');
    if (metaRow) {
      const parent = metaRow.closest('div');
      if (parent) return { container: parent, insertBefore: null };
    }

    // Fallback: append to bottom of post
    return { container: postEl, insertBefore: null };
  }

  /* ──────────────────────── handleSaveClick ──────────────────────── */

  async function handleSaveClick(postEl, btn) {
    if (btn.disabled) return;
    btn.disabled = true;

    const toast = showToast('Đã lưu! AI đang phân tích...', 'info', 0);

    try {
      // ── Extract post data ──────────────────────────────────────────
      const postId = postEl.dataset[`${EXT_PREFIX}Id`] || getPostId(postEl);
      const isMarketplace = isMarketplacePage() ||
        !!qs(postEl, 'a[href*="/marketplace/item/"]');

      const { sellerName, sellerUrl } = extractSeller(postEl);

      const postData = {
        id: postId,
        rawText: extractText(postEl),
        images: extractImages(postEl),
        sellerName,
        sellerUrl,
        postUrl: extractPostUrl(postEl),
        timestamp: extractTimestamp(postEl),
        savedAt: new Date().toISOString(),
        isMarketplace,
        pageUrl: window.location.href,
        ...(isMarketplace ? extractMarketplaceData(postEl) : {}),
      };

      // ── Send to background ─────────────────────────────────────────
      chrome.runtime.sendMessage(
        { type: 'SAVE_POST', data: postData },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[FBOS] sendMessage error:', chrome.runtime.lastError.message);
            updateToast(toast, 'Lỗi kết nối tiện ích. Thử lại.', 'error');
            btn.disabled = false;
            return;
          }

          if (response && response.success) {
            persistSavedId(postId);
            markPostAsSaved(postEl);
            updateToast(toast, 'Phân tích hoàn thành ✓', 'success');
          } else {
            const errMsg = (response && response.error) || 'Lỗi không xác định';
            updateToast(toast, `Lỗi: ${errMsg}`, 'error');
            btn.disabled = false;
          }
        }
      );
    } catch (err) {
      console.error('[FBOS] handleSaveClick error:', err);
      updateToast(toast, 'Có lỗi xảy ra. Thử lại.', 'error');
      btn.disabled = false;
    }
  }

  /* ──────────────────────── injectButton (single post) ───────────── */

  function injectButtonIntoPost(postEl) {
    if (postEl.hasAttribute(INJECTED_ATTR)) return; // already done

    const postId = getPostId(postEl);
    postEl.setAttribute(INJECTED_ATTR, 'true');
    postEl.dataset[`${EXT_PREFIX}Id`] = postId;

    const isSaved = savedPostIds.has(postId);
    const btn = createSaveButton(postId, isSaved);

    if (isSaved) markPostAsSaved(postEl);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSaveClick(postEl, btn);
    });

    // Wrap in a container so we can position it without disrupting layout
    const wrapper = document.createElement('div');
    wrapper.className = `${EXT_PREFIX}-btn-wrapper`;
    wrapper.appendChild(btn);

    const insertion = findActionBar(postEl);
    if (insertion) {
      const { container, insertBefore } = insertion;
      if (insertBefore) {
        container.insertBefore(wrapper, insertBefore);
      } else {
        container.appendChild(wrapper);
      }
    } else {
      postEl.appendChild(wrapper);
    }
  }

  /* ────────────────────── Post detection selectors ───────────────── */

  /**
   * Selectors that identify individual post root elements.
   * We prefer role="article" which Facebook uses for feed stories.
   */
  const POST_SELECTORS = [
    // Feed posts
    'div[role="article"]',
    // Marketplace listing cards (grid view)
    'div[data-testid="marketplace_feed_item"]',
    'a[href*="/marketplace/item/"] > div',
    // Fallback: any large card-like container
  ];

  /** Return all candidate post elements currently in the DOM. */
  function getAllPosts() {
    const seen = new Set();
    const results = [];
    POST_SELECTORS.forEach(sel => {
      qsa(document, sel).forEach(el => {
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      });
    });
    return results;
  }

  /* ──────────────────────── Marketplace card handling ───────────── */

  /**
   * On Marketplace pages the listings are <a> elements wrapping a card.
   * We want to inject onto the card itself, not the anchor (to avoid interfering
   * with navigation).
   */
  function handleMarketplaceCards() {
    const cards = qsa(document,
      'a[href*="/marketplace/item/"]'
    ).map(a => a.closest('div[style], div[class]') || a.parentElement)
      .filter(Boolean);

    cards.forEach(card => {
      if (!card.hasAttribute(INJECTED_ATTR)) {
        injectButtonIntoPost(card);
      }
    });
  }

  /* ──────────────────────── Main scan ───────────────────────────── */

  function scanAndInject() {
    getAllPosts().forEach(injectButtonIntoPost);

    if (isMarketplacePage()) {
      handleMarketplaceCards();
    }
  }

  /* ──────────────────────── MutationObserver ─────────────────────── */

  const debouncedScan = debounce(scanAndInject, DEBOUNCE_MS);

  const observer = new MutationObserver((mutations) => {
    // Quick check: did any mutation add element nodes?
    const hasNewElements = mutations.some(m =>
      m.addedNodes.length > 0 &&
      Array.from(m.addedNodes).some(n => n.nodeType === Node.ELEMENT_NODE)
    );
    if (hasNewElements) debouncedScan();
  });

  function startObserver() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  /* ──────────────────────── Background messages ──────────────────── */

  /**
   * Listen for messages from the background/popup (e.g. to refresh saved-state).
   */
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case 'REFRESH_SAVED_IDS': {
        // Background or popup signals that saved IDs changed
        loadSavedIds();
        sendResponse({ ok: true });
        break;
      }

      case 'GET_PAGE_INFO': {
        sendResponse({
          url: window.location.href,
          isMarketplace: isMarketplacePage(),
          postsFound: document.querySelectorAll(`[${INJECTED_ATTR}]`).length,
        });
        break;
      }

      case 'HIGHLIGHT_POST': {
        // Jump to a specific post by ID
        const target = document.querySelector(
          `[data-${EXT_PREFIX}-id="${message.postId}"]`
        );
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add(`${EXT_PREFIX}-highlight-pulse`);
          setTimeout(() => target.classList.remove(`${EXT_PREFIX}-highlight-pulse`), 2000);
        }
        sendResponse({ found: !!target });
        break;
      }

      default:
        break;
    }
    return true; // keep message channel open for async sendResponse
  });

  /* ──────────────────────── Bootstrap ───────────────────────────── */

  function init() {
    loadSavedIds();
    scanAndInject();
    startObserver();
  }

  // Wait for the body to be available (should always be ready at document_idle)
  if (document.body) {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  }

  // Also re-scan on Facebook's SPA navigation events
  window.addEventListener('popstate', () => setTimeout(scanAndInject, 600));

  // Facebook uses pushState for navigation
  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    setTimeout(scanAndInject, 600);
  };

  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    setTimeout(scanAndInject, 600);
  };
})();
