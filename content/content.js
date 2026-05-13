(function () {
  'use strict';

  const PFX = 'fbos';
  const INJECTED = `data-${PFX}-injected`;
  const SAVED    = `data-${PFX}-saved`;

  /* ── utils ──────────────────────────────────────────────────────── */
  const qs  = (r, s) => { try { return r.querySelector(s); }           catch { return null; } };
  const qsa = (r, s) => { try { return [...r.querySelectorAll(s)]; }  catch { return []; }   };

  let _scanTimer = null;
  function debounceScan() { clearTimeout(_scanTimer); _scanTimer = setTimeout(scan, 600); }

  /* ── saved-ID cache ─────────────────────────────────────────────── */
  const savedIds = new Set();
  function loadSavedIds() {
    chrome.storage.local.get('savedPostIds', r => {
      (r.savedPostIds || []).forEach(id => savedIds.add(id));
      qsa(document, `[${INJECTED}]`).forEach(el => {
        if (savedIds.has(el.dataset[`${PFX}Id`])) markSaved(el);
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

  /* ── toast ──────────────────────────────────────────────────────── */
  let _toastRoot = null;
  function toastRoot() {
    if (!_toastRoot || !document.body.contains(_toastRoot)) {
      _toastRoot = document.createElement('div');
      _toastRoot.id = `${PFX}-toasts`;
      document.body.appendChild(_toastRoot);
    }
    return _toastRoot;
  }
  function showToast(msg, type = 'info', ms = 3000) {
    const el = document.createElement('div');
    el.className = `${PFX}-toast ${PFX}-toast--${type}`;
    el.innerHTML = `<span class="${PFX}-ti">${{info:'🔖',success:'✅',error:'❌'}[type]||'🔖'}</span><span>${msg}</span>`;
    toastRoot().appendChild(el);
    requestAnimationFrame(() => el.classList.add(`${PFX}-toast--in`));
    if (ms > 0) setTimeout(() => dismiss(el), ms);
    return el;
  }
  function dismiss(el) {
    el.classList.remove(`${PFX}-toast--in`);
    setTimeout(() => el.remove(), 320);
  }
  function updateToast(el, msg, type) {
    el.className = `${PFX}-toast ${PFX}-toast--${type} ${PFX}-toast--in`;
    const ti = el.querySelector(`.${PFX}-ti`);
    if (ti) ti.textContent = {info:'🔖',success:'✅',error:'❌'}[type]||'🔖';
    const sp = el.querySelectorAll('span')[1];
    if (sp) sp.textContent = msg;
    setTimeout(() => dismiss(el), 3200);
  }

  /* ── data extraction ────────────────────────────────────────────── */
  function extractText(el) {
    const candidates = [
      '[data-ad-preview="message"]',
      '[data-ad-comet-preview="message"]',
      '[data-testid="post_message"]',
    ];
    for (const s of candidates) {
      const n = qs(el, s);
      if (n?.textContent?.trim().length > 5) return n.textContent.trim();
    }
    // Real FB: biggest div[dir="auto"] that is NOT inside a nested article (comments)
    const divTexts = qsa(el, 'div[dir="auto"]').filter(d => {
      const t = d.textContent.trim();
      if (t.length < 10) return false;
      // Skip if inside a nested article (comment)
      let p = d.parentElement;
      while (p && p !== el) {
        if (p.getAttribute('role') === 'article') return false;
        p = p.parentElement;
      }
      return true;
    });
    if (divTexts.length) {
      return divTexts.reduce((a, b) =>
        a.textContent.length > b.textContent.length ? a : b
      ).textContent.trim();
    }
    // Fallback: biggest span[dir=auto] not in nested article
    const spans = qsa(el, 'span[dir="auto"]').filter(s => {
      if (s.textContent.trim().length < 10) return false;
      let p = s.parentElement;
      while (p && p !== el) {
        if (p.getAttribute('role') === 'article') return false;
        p = p.parentElement;
      }
      return true;
    });
    if (spans.length) {
      return spans.reduce((a, b) =>
        a.textContent.length > b.textContent.length ? a : b
      ).textContent.trim();
    }
    return el.textContent.trim().slice(0, 2000);
  }

  function extractImages(el) {
    const srcs = new Set();
    qsa(el, 'img').forEach(img => {
      // Skip images inside nested articles (comments, commenter avatars)
      let p = img.parentElement;
      while (p && p !== el) {
        if (p.getAttribute('role') === 'article') return;
        p = p.parentElement;
      }
      const src = img.src || img.getAttribute('data-src') || '';
      if (src && src.includes('fbcdn') && !src.includes('emoji') && !src.includes('static'))
        srcs.add(src);
    });
    return [...srcs];
  }

  function extractSeller(el) {
    // Group posts: seller link is /groups/[id]/user/[userId]/
    const groupUserLink = qs(el, 'a[href*="/groups/"][href*="/user/"]');
    if (groupUserLink) {
      const name = groupUserLink.getAttribute('aria-label') ||
                   qs(groupUserLink, 'span')?.textContent?.trim() ||
                   groupUserLink.textContent.trim();
      if (name) return { sellerName: name, sellerUrl: groupUserLink.href.split('?')[0] };
    }
    // Personal posts: <a aria-label="NAME" href="...profile.php?id=...">
    const profilePhpLink = qs(el, 'a[aria-label][href*="profile.php"]');
    if (profilePhpLink) {
      const name = profilePhpLink.getAttribute('aria-label');
      if (name) {
        const u = new URL(profilePhpLink.href);
        const sellerUrl = `${u.origin}${u.pathname}?id=${u.searchParams.get('id')}`;
        return { sellerName: name, sellerUrl };
      }
    }
    // data-ad-rendering-role="profile_name" pattern (personal posts alternate)
    const profileNameEl = qs(el, '[data-ad-rendering-role="profile_name"] a');
    if (profileNameEl?.textContent?.trim()) {
      return { sellerName: profileNameEl.textContent.trim(), sellerUrl: profileNameEl.href };
    }
    // Profile links via h2/h3/h4
    for (const tag of ['h2','h3','h4','strong']) {
      const a = qs(el, `${tag} a[href]`);
      if (a?.textContent?.trim()) return { sellerName: a.textContent.trim(), sellerUrl: a.href };
    }
    return { sellerName: '', sellerUrl: '' };
  }

  function extractPostUrl(el) {
    const a = qs(el,
      'a[href*="/posts/"], a[href*="story_fbid"], a[href*="permalink/"], a[href*="/marketplace/item/"]'
    );
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

  /* ── extract group info ─────────────────────────────────────────── */
  function extractGroupInfo(postEl) {
    // Primary: group link with aria-label directly on the post element
    // FB renders: <a aria-label="GROUP NAME" href="/groups/ID/?...">
    const groupLink = postEl
      ? qs(postEl, 'a[href*="/groups/"][aria-label]:not([href*="/user/"])')
      : null;
    if (groupLink) {
      const m = groupLink.href.match(/\/groups\/([^/?#]+)/);
      return {
        groupId:   m ? m[1] : '',
        groupName: groupLink.getAttribute('aria-label') || '',
        groupUrl:  m ? `${location.origin}/groups/${m[1]}` : groupLink.href.split('?')[0],
      };
    }

    // Fallback: URL-based (when on a group page directly)
    const urlMatch = location.pathname.match(/\/groups\/([^/?#]+)/);
    if (!urlMatch) return {};

    const groupId  = urlMatch[1];
    const groupUrl = `${location.origin}/groups/${groupId}`;
    let groupName  = '';

    const nameSels = ['h1', '[role="main"] h1', 'a[href*="/groups/"] span', 'nav [aria-current] span'];
    for (const s of nameSels) {
      const el = qs(document, s);
      if (el?.textContent?.trim().length > 0 && el.textContent.trim().length < 120) {
        groupName = el.textContent.trim();
        break;
      }
    }
    if (!groupName && document.title) {
      groupName = document.title.replace(/\s*[|–-].*$/, '').trim();
    }

    return { groupId, groupName, groupUrl };
  }

  function buildPostData(el) {
    const { sellerName, sellerUrl } = extractSeller(el);
    const isMP = /\/marketplace/.test(window.location.pathname) ||
                 !!qs(el, 'a[href*="/marketplace/item/"]');
    return {
      id: el.dataset[`${PFX}Id`] || getPostId(el),
      rawText: extractText(el),
      images: extractImages(el),
      sellerName, sellerUrl,
      postUrl: extractPostUrl(el),
      savedAt: new Date().toISOString(),
      isMarketplace: isMP,
      pageUrl: window.location.href,
      ...extractGroupInfo(el),
    };
  }

  /* ── mark saved ─────────────────────────────────────────────────── */
  function markSaved(postEl) {
    postEl.setAttribute(SAVED, '1');
    const btn = qs(postEl, `.${PFX}-btn`);
    if (!btn) return;
    btn.classList.add(`${PFX}-btn--saved`);
    btn.title = 'Đã lưu đơn hàng';
    const icon  = btn.querySelector(`.${PFX}-bi`);
    const label = btn.querySelector(`.${PFX}-bl`);
    if (icon)  icon.textContent  = '🔖';
    if (label) label.textContent = 'Đã lưu';
  }

  /* ── save handler ───────────────────────────────────────────────── */
  function handleSave(postEl, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const t = showToast('Đang lưu...', 'info', 0);
    const data = buildPostData(postEl);
    chrome.runtime.sendMessage({ type: 'SAVE_POST', data }, res => {
      if (chrome.runtime.lastError) {
        updateToast(t, 'Lỗi kết nối extension', 'error');
        btn.disabled = false;
        return;
      }
      if (res?.success) {
        persistId(data.id);
        markSaved(postEl);
        updateToast(t, res.aiAnalyzed ? 'Đã lưu & phân tích AI ✓' : 'Đã lưu! (chưa cấu hình AI)', 'success');
      } else {
        updateToast(t, `Lỗi: ${res?.error || 'Không xác định'}`, 'error');
        btn.disabled = false;
      }
    });
  }

  /* ── create button element ──────────────────────────────────────── */
  function makeBtn(isSaved) {
    const btn = document.createElement('button');
    btn.className = `${PFX}-btn${isSaved ? ` ${PFX}-btn--saved` : ''}`;
    btn.title = isSaved ? 'Đã lưu đơn hàng' : 'Lưu đơn hàng';
    btn.setAttribute('type', 'button');
    btn.innerHTML =
      `<span class="${PFX}-bi">${isSaved ? '🔖' : '🛍️'}</span>` +
      `<span class="${PFX}-bl">${isSaved ? 'Đã lưu' : 'Lưu đơn hàng'}</span>`;
    return btn;
  }

  /* ── find action bar using Share button as post anchor ─────────── */
  function findActionBar(postEl) {
    // Posts always have Share; comments only have Reply — use this to distinguish.
    // Try to find a Share-type button and walk up to its row container.
    const shareSelectors = [
      '[aria-label="Share"]',
      '[aria-label^="Share "]',
      '[aria-label="Chia sẻ"]',
      '[aria-label^="Chia sẻ"]',
    ];
    for (const s of shareSelectors) {
      const btn = qs(postEl, s);
      if (!btn) continue;
      let p = btn.parentElement;
      for (let i = 0; i < 6 && p && p !== postEl; i++) {
        if (p.children.length >= 2) return p;
        p = p.parentElement;
      }
    }

    // Fallback: "bài viết" appears in post-level Like/Comment aria-labels in Vietnamese FB
    //           ("Thích bài viết của X", "Bình luận bài viết của X") but NOT in comment buttons
    const postBtn = qs(postEl, '[aria-label*="bài viết"], [aria-label*="this post"]');
    if (postBtn) {
      let p = postBtn.parentElement;
      for (let i = 0; i < 6 && p && p !== postEl; i++) {
        if (p.children.length >= 2) return p;
        p = p.parentElement;
      }
    }

    return null; // No post-level action found → this is not a post article
  }

  /* ── inject into action bar ─────────────────────────────────────── */
  function injectIntoPost(postEl) {
    if (postEl.hasAttribute(INJECTED)) return;
    if ((postEl.textContent?.trim().length || 0) < 30) return;

    // findActionBar returns null when no post-level Share/Like exists → skip comments
    const bar = findActionBar(postEl);
    if (!bar) return;

    const postId  = getPostId(postEl);
    const isSaved = savedIds.has(postId);
    postEl.setAttribute(INJECTED, '1');
    postEl.dataset[`${PFX}Id`] = postId;
    if (isSaved) postEl.setAttribute(SAVED, '1');

    const btn = makeBtn(isSaved);
    btn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      handleSave(postEl, btn);
    });

    const wrap = document.createElement('div');
    wrap.className = `${PFX}-wrap`;
    wrap.appendChild(btn);
    bar.appendChild(wrap);
  }

  /* ── scan all posts ─────────────────────────────────────────────── */
  function isComment(el) {
    return !!el.parentElement?.closest('[role="article"]');
  }

  function scan() {
    qsa(document, 'div[role="article"]').forEach(el => {
      if (isComment(el)) return; // quick bailout for clearly nested comment articles
      injectIntoPost(el);        // findActionBar inside will reject non-posts
    });

    // Marketplace cards
    if (/\/marketplace/.test(window.location.pathname)) {
      qsa(document, 'div[data-testid="marketplace_feed_item"]').forEach(injectIntoPost);
      qsa(document, 'a[href*="/marketplace/item/"]').forEach(a => {
        const card = a.parentElement;
        if (card && !card.hasAttribute(INJECTED)) injectIntoPost(card);
      });
    }
  }

  /* ── MutationObserver ───────────────────────────────────────────── */
  new MutationObserver(muts => {
    const added = muts.some(m =>
      [...m.addedNodes].some(n => n.nodeType === 1 && !n.id?.startsWith(PFX))
    );
    if (added) debounceScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ── SPA nav ────────────────────────────────────────────────────── */
  ['pushState','replaceState'].forEach(m => {
    const orig = history[m].bind(history);
    history[m] = (...a) => { orig(...a); setTimeout(scan, 900); };
  });
  window.addEventListener('popstate', () => setTimeout(scan, 900));

  /* ── messages from background ───────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    switch (msg?.type) {
      case 'PING':
        reply({ ok: true });
        break;

      case 'EXTRACT_CURRENT_POST': {
        // Find the most visible injected article on screen
        let best = null, bestArea = 0;
        qsa(document, `[${INJECTED}]`).forEach(el => {
          const r = el.getBoundingClientRect();
          const h = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
          const w = Math.min(r.right,  window.innerWidth)  - Math.max(r.left, 0);
          const area = Math.max(0, h) * Math.max(0, w);
          if (area > bestArea) { bestArea = area; best = el; }
        });
        if (!best) best = qs(document, 'div[role="article"]');
        reply({ postData: best ? buildPostData(best) : {
          rawText: msg.selectedText || '',
          images: [],
          postUrl: window.location.href,
          savedAt: new Date().toISOString(),
          pageUrl: window.location.href,
        }});
        break;
      }

      case 'POST_SAVED':
        if (msg.success && msg.product?.id) {
          const el = document.querySelector(`[data-${PFX}-id="${msg.product.id}"]`);
          if (el) markSaved(el);
          showToast('Đã lưu đơn hàng ✓', 'success');
        }
        break;

      case 'REFRESH_SAVED_IDS':
        loadSavedIds();
        reply({ ok: true });
        break;

      case 'GET_PAGE_INFO':
        reply({ url: window.location.href, posts: document.querySelectorAll(`[${INJECTED}]`).length });
        break;
    }
    return true;
  });

  /* ── bootstrap ──────────────────────────────────────────────────── */
  loadSavedIds();
  scan();
  setTimeout(scan, 1500);
  setTimeout(scan, 4000);
})();
