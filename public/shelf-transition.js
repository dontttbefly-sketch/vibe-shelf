/* 开书从选中的封面出发；加载失败留在书架，返回恢复同一位置。 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ShelfTransition = api; api.mount(root, root.document); }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  var STATE_KEY = 'shelf-return-state';
  function safeBookUrl(value, base) {
    try {
      var target = new URL(value, base);
      if (target.origin !== new URL(base).origin || !/^\/(?:projects|examples)\/[a-z0-9-]+\/books\/[a-z0-9-]+\/(?:index\.html)?$/.test(target.pathname)) return null;
      return target.href;
    } catch (_) { return null; }
  }
  function createGate() {
    var sequence = 0, busy = false;
    return {
      begin: function () { if (busy) return null; busy = true; return ++sequence; },
      current: function (token) { return busy && sequence === token; },
      reset: function () { sequence++; busy = false; },
    };
  }
  function mount(win, doc) {
    var gate = createGate(), overlay = null, controller = null, navigationToken = null, lastTrigger = null, returnFocus = null;
    function store(value) { try { win.sessionStorage.setItem(STATE_KEY, JSON.stringify(value)); } catch (_) {} }
    function read() { try { return JSON.parse(win.sessionStorage.getItem(STATE_KEY) || 'null'); } catch (_) { return null; } }
    function capture(trigger, options) {
      var search = doc.querySelector('[data-shelf-search]');
      var sort = doc.querySelector('[data-shelf-sort]');
      var filter = doc.querySelector('[data-catalog-filter][aria-pressed="true"]');
      var list = doc.querySelector("[data-project-list]");
      store({ catalogLimit: Math.max(list && Number(list.dataset.catalogLimit) || 40, Number(options.catalogLimit) || 0), searchLimit: list && Number(list.dataset.searchLimit) || 60, scrollY: win.scrollY, query: search ? search.value : '', sort: sort ? sort.value : 'recent', filter: filter ? filter.dataset.catalogFilter : 'all', focus: options.returnFocus || trigger && trigger.getAttribute('data-shelf-focus'), route: win.location.hash || '', at: Date.now() });
    }
    function cancel(token, stopNavigation) {
      if (token != null && !gate.current(token)) return;
      // Once assign starts, aborting fetch cannot stop the pending document.
      // Only stop the navigation owned by this opening, never a restored page.
      if (stopNavigation !== false && navigationToken !== null && gate.current(navigationToken)) win.stop();
      navigationToken = null;
      gate.reset();
      if (controller) controller.abort(); controller = null;
      try { win.sessionStorage.removeItem('shelf-book-entry'); } catch (_) {}
      if (overlay) { overlay.close(); overlay.remove(); overlay = null; }
      var destination = returnFocus && Array.from(doc.querySelectorAll('[data-shelf-focus]')).find(function (node) { return node.getAttribute('data-shelf-focus') === returnFocus; }) || lastTrigger;
      if (destination && destination.isConnected) destination.focus({ preventScroll: true });
    }
    function el(tag, cls, text) { var n = doc.createElement(tag); n.className = cls; if (text) n.textContent = text; return n; }
    function sourceFrom(trigger, options) {
      var title = trigger && (trigger.querySelector('strong') || trigger.querySelector('.sp-title'));
      var palette = trigger ? win.getComputedStyle(trigger) : null;
      return {
        title: options.title || (title ? title.textContent : trigger && trigger.getAttribute('data-book-title')) || '你的项目读本',
        paper: options.palette && options.palette.paper || palette && palette.getPropertyValue('--cover-paper').trim() || '#fffdf7',
        ink: options.palette && options.palette.ink || palette && palette.getPropertyValue('--cover-ink').trim() || '#151b1e',
        rect: trigger && trigger.getBoundingClientRect(),
      };
    }
    function show(source, token) {
      overlay = el('dialog', 'shelf-opening');
      overlay.setAttribute('aria-label', '正在打开读本');
      var page = el('div', 'shelf-opening-page');
      page.style.setProperty('--opening-paper', source.paper);
      page.style.setProperty('--opening-ink', source.ink);
      var content = el('div', 'shelf-opening-content');
      content.tabIndex = 0; content.setAttribute('role', 'region'); content.setAttribute('aria-label', '正在打开的读本');
      content.append(el('h1', 'shelf-opening-title', source.title), el('span', 'shelf-opening-rule'));
      page.append(el('span', 'shelf-opening-kicker', '知识书架 / 项目读本'), content);
      var status = el('p', 'shelf-opening-status', '正在翻开这本书…'); status.setAttribute('role', 'status');
      var actions = el('div', 'shelf-opening-actions');
      var retry = el('button', '', '重新打开'); retry.type = 'button'; retry.hidden = true;
      var close = el('button', '', '返回书架'); close.type = 'button'; close.addEventListener('click', function () { cancel(token); });
      actions.append(retry, close); page.append(status, actions); overlay.append(page); doc.body.append(overlay);
      overlay.addEventListener('cancel', function (event) { event.preventDefault(); cancel(token); });
      overlay.showModal();
      var start = source.rect, end = page.getBoundingClientRect();
      if (start && start.width && start.height && page.animate) {
        page.animate([{ transform: 'translate(' + (start.left - end.left) + 'px,' + (start.top - end.top) + 'px) scale(' + start.width / end.width + ',' + start.height / end.height + ')' }, { transform: 'translate(0,0) scale(1,1)' }], { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
      return { status: status, retry: retry, title: source.title };
    }
    async function open(trigger, value, options) {
      options = options || {};
      var url = safeBookUrl(value, win.location.href);
      if (!url) return;
      var token = gate.begin(); if (token === null) return;
      lastTrigger = options.returnTrigger || trigger; returnFocus = options.returnFocus || trigger && trigger.getAttribute('data-shelf-focus');
      capture(trigger, options);
      // Read the visible preview before closing its dialog; hidden dialogs have
      // zero geometry. Its close event must not take focus from this new dialog.
      var source = sourceFrom(trigger, options);
      if (options.beforeOpen) options.beforeOpen();
      if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) { win.location.assign(url); return; }
      var ui = show(source, token), started = Date.now();
      var ownController = new win.AbortController(); controller = ownController;
      var timeout = win.setTimeout(function () { if (gate.current(token)) ownController.abort(); }, 20000);
      try {
        var response = await win.fetch(url, { signal: ownController.signal, headers: { Accept: 'text/html' } });
        if (!response.ok || !/text\/html/i.test(response.headers.get('content-type') || '') || !safeBookUrl(response.url || url, win.location.href)) throw Error('暂时没能打开这本书。书架和阅读位置都还在。');
        await response.text();
        if (!gate.current(token)) return;
        if (Date.now() - started < 300) await new Promise(function (resolve) { win.setTimeout(resolve, 300 - (Date.now() - started)); });
        if (!gate.current(token)) return;
        try { win.sessionStorage.setItem('shelf-book-entry', JSON.stringify({ url: url, title: ui.title, at: Date.now() })); } catch (_) {}
        navigationToken = token;
        win.location.assign(url);
      } catch (error) {
        if (!gate.current(token)) return;
        ui.status.textContent = error.name === 'AbortError' ? '加载有些慢。可以重试，或回到书架。' : '未能加载这本书。请检查网络后重试，或返回书架。';
        ui.retry.hidden = false;
        ui.retry.addEventListener('click', function () { if (!gate.current(token)) return; cancel(token); open(trigger, url, options); }, { once: true });
      } finally { win.clearTimeout(timeout); if (controller === ownController) controller = null; }
    }
    function restore() {
      var state = read();
      if (!state || Date.now() - state.at > 86400000 || !/^#(?:library|bookshelf)$/.test(win.location.hash)) return;
      try { win.sessionStorage.removeItem(STATE_KEY); } catch (_) {}
      var search = doc.querySelector('[data-shelf-search]'), sort = doc.querySelector('[data-shelf-sort]');
      if (search && state.query) { search.value = state.query; search.dispatchEvent(new win.Event('input', { bubbles: true })); }
      if (sort && state.sort) { sort.value = state.sort; sort.dispatchEvent(new win.Event('change', { bubbles: true })); }
      var filter = Array.from(doc.querySelectorAll('[data-catalog-filter]')).find(function (n) { return n.dataset.catalogFilter === state.filter; });
      if (filter) filter.click();
      win.dispatchEvent(new win.CustomEvent("shelf-restore-catalog", { detail: state }));
      win.requestAnimationFrame(function () {
        var item = Array.from(doc.querySelectorAll('[data-shelf-focus]')).find(function (n) { return n.getAttribute('data-shelf-focus') === state.focus; });
        if (item) { item.focus({ preventScroll: true }); item.closest('.shelf-book-item')?.classList.add('is-returned'); }
        win.scrollTo({ top: Math.max(0, Number(state.scrollY) || 0), behavior: 'instant' });
      });
    }
    win.addEventListener('shelf-projects-loaded', restore);
    win.addEventListener('pagehide', function () { navigationToken = null; });
    win.addEventListener('pageshow', function (event) { cancel(null, false); if (event.persisted) restore(); });
    api.open = open; api.restore = restore;
  }
  var api = { mount: mount, safeBookUrl: safeBookUrl, createGate: createGate };
  return api;
}));
