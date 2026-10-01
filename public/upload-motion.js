/* Opening the book: the landing's hero book flies to the middle of the desk and
   its cover swings open around the spine. What it reveals are the real pages of
   the workspace — the right page travels under the cover the whole way and the
   cover's inside lands as the left page — so the eye follows one object from the
   click to the form. The old page stays underneath while the desk fades in over
   it; no frame is a blank sheet. Leaving closes the book and flies it back. */
(function () {
  'use strict';
  var running = [], layers = [], restores = [], epoch = 0, deadline, longest = null, longestEnd = -1;
  var EASE = 'cubic-bezier(.22,1,.36,1)', FLY = 'cubic-bezier(.4,0,.2,1)', EXIT = 'cubic-bezier(.5,0,.75,0)';
  var SWING = 'cubic-bezier(.45,0,.55,1)', FADE = 'cubic-bezier(.33,0,.25,1)';
  // Pages share the hero book's proportions, so the flight is an even scale.
  var BOOK_RATIO = .756, SETTLED = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
  function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function cancel() {
    epoch++;
    clearTimeout(deadline);
    running.forEach(function (animation) { animation.cancel(); }); running = [];
    layers.forEach(function (node) { node.remove(); }); layers = [];
    restores.forEach(function (undo) { undo(); }); restores = [];
    longest = null; longestEnd = -1;
    delete document.body.dataset.workspaceMotion;
  }
  function play(node, frames, options) {
    if (!node || !node.animate) return null;
    var timing = Object.assign({ fill: 'both', easing: EASE, delay: 0 }, options);
    var animation = node.animate(frames, timing);
    running.push(animation);
    if (timing.delay + timing.duration >= longestEnd) { longestEnd = timing.delay + timing.duration; longest = animation; }
    return animation;
  }
  function layer(className) {
    var node = document.createElement('div');
    node.className = className; node.setAttribute('aria-hidden', 'true'); node.inert = true;
    document.body.appendChild(node); layers.push(node);
    return node;
  }
  function mount(copy, zIndex) {
    if (zIndex) copy.style.zIndex = zIndex;
    document.body.appendChild(copy); layers.push(copy);
    return copy;
  }
  // Inline styles on live nodes are put back when the motion ends or is cut short.
  function setStyle(node, name, value) {
    var before = node.style[name];
    node.style[name] = value;
    restores.push(function () { node.style[name] = before; });
  }
  function rectOf(node) { var r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; }
  function box(left, top, width, height) { return { left: left, top: top, right: left + width, bottom: top + height, width: width, height: height }; }
  function barBottom() {
    var bar = document.querySelector && document.querySelector('.shelf-topbar');
    return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
  }
  // Wholly visible below the topbar, which covers every motion layer.
  function onScreen(r) { return Boolean(r && r.width > 0 && r.height > 0 && r.top >= barBottom() && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth); }
  function shown(node) { return node && node.offsetWidth > 0 ? node : null; }
  // A landing piece's own translate, rotate and scale, plus the responsive scale
  // of the figure around it, read from what is on screen now.
  function pose(node) {
    if (!node) return null;
    var rect = rectOf(node), w = node.offsetWidth, h = node.offsetHeight, m;
    if (!w || !h || !rect.width) return null;
    try { m = new DOMMatrixReadOnly(window.getComputedStyle(node).transform); } catch (error) { m = { a: 1, b: 0, e: 0, f: 0 }; }
    var angle = Math.atan2(m.b, m.a), scale = Math.hypot(m.a, m.b) || 1;
    var k = rect.width / ((w * Math.abs(Math.cos(angle)) + h * Math.abs(Math.sin(angle))) * scale);
    return { node: node, rect: rect, w: w, h: h, k: k, tx: m.e, ty: m.f, angle: angle * 180 / Math.PI, scale: scale,
      cx: rect.left + rect.width / 2 - m.e * k, cy: rect.top + rect.height / 2 - m.f * k };
  }
  function placed(p, tx, ty, angle, scale) {
    return 'scale(' + p.k + ') translate(' + tx + 'px,' + ty + 'px) rotate(' + angle + 'deg) scale(' + scale + ')';
  }
  function asIs(p, dx, dy) { return placed(p, p.tx + (dx || 0), p.ty + (dy || 0), p.angle, p.scale); }
  // Where a book stands on screen: its centre, upright size and tilt.
  function stance(p) { return { cx: p.cx + p.tx * p.k, cy: p.cy + p.ty * p.k, w: p.w * p.k * p.scale, h: p.h * p.k * p.scale, angle: p.angle }; }
  // A small closed book standing on the button that summons it, or takes it back.
  function atButton(r) {
    var h = Math.min(120, Math.max(56, r.height * 1.6));
    return { cx: r.left + r.width / 2, cy: Math.max(r.top + r.height / 2, barBottom() + h / 2 + 8), w: h * BOOK_RATIO, h: h, angle: -4, small: true };
  }
  // For a node laid over `page`: moves the page's centre to the stance's centre,
  // tilts it and scales it to the stance's size.
  function toward(page, s) {
    return 'translate(' + (s.cx - page.left - page.width / 2) + 'px, ' + (s.cy - page.top - page.height / 2) + 'px) rotate(' + s.angle + 'deg) scale(' + s.w / page.width + ', ' + s.h / page.height + ')';
  }
  // A far eye: the free edge of a turning page grows by at most a seventh, so a
  // leaf as tall as the desk never reaches past the screen while it turns.
  function hinge(page) { return 'perspective(' + Math.round(page.width * 8) + 'px) '; }
  // Laid open, the right page travels under the cover and the left page is the
  // cover's other face. Stacked on a narrow screen, the top page travels alone
  // and the page below it arrives with the desk.
  function bookIn(root) {
    var spread = root && root.querySelector('.upload-book');
    var verso = root && shown(root.querySelector('.upload-verso')), recto = root && shown(root.querySelector('.upload-recto'));
    if (!spread || !(verso || recto)) return null;
    var open = Boolean(verso && recto && rectOf(recto).left >= rectOf(verso).right - 2);
    var pageNode = open ? recto : verso || recto, page = rectOf(pageNode), frame = rectOf(spread);
    if (!page.width || !page.height) return null;
    // The spread turns about the travelling page's centre, so that page moves exactly as the cover does.
    return { spread: spread, pageNode: pageNode, page: page, leaf: open ? verso : null, below: open || pageNode !== verso ? null : recto,
      origin: (page.left + page.width / 2 - frame.left) + 'px ' + (page.top + page.height / 2 - frame.top) + 'px' };
  }
  // The hero book's cover laid exactly over the right page, hinged at the spine.
  function coverOver(page, bookNode) {
    var holder = layer('upload-motion-book'), leaf = document.createElement('div'), shade = document.createElement('i');
    Object.assign(holder.style, { left: page.left + 'px', top: page.top + 'px', width: page.width + 'px', height: page.height + 'px' });
    leaf.className = 'upload-motion-cover'; shade.className = 'upload-motion-shade';
    var face = bookNode.cloneNode(true);
    face.removeAttribute('id');
    leaf.appendChild(face); leaf.appendChild(shade); holder.appendChild(leaf);
    face.style.transform = 'scale(' + page.width / (face.offsetWidth || 292) + ', ' + page.height / (face.offsetHeight || 386) + ')';
    return { holder: holder, leaf: leaf, shade: shade };
  }
  // A still copy of a landing piece, standing exactly where the original is.
  function stand(p, className) {
    var holder = layer(className);
    Object.assign(holder.style, { left: p.cx - p.w / 2 + 'px', top: p.cy - p.h / 2 + 'px', width: p.w + 'px', height: p.h + 'px' });
    return holder;
  }
  // The margin note lies on the book; it keeps its own layer and drifts off it.
  function note(p) {
    if (!p) return null;
    var holder = stand(p, 'upload-motion-note');
    holder.appendChild(p.node.cloneNode(true));
    return holder;
  }
  // The pressed button springs back while its arrow leaves toward the book.
  function launch(button) {
    if (!button) return;
    play(button, [{ transform: 'scale(.975)' }, { transform: 'scale(1)' }], { duration: 220 });
    var arrow = button.querySelector('.landing-primary-arrow svg');
    if (arrow) play(arrow, [{ transform: 'translate(0px, 0px)' }, { transform: 'translate(15px, -15px)' }], { duration: 180, easing: EXIT });
  }
  // The kept page steps back under the desk that fades in over it.
  function recede(copy, timing) {
    var r = rectOf(copy);
    copy.style.transformOrigin = (window.innerWidth / 2 - r.left) + 'px ' + (window.innerHeight / 2 - r.top) + 'px';
    play(copy, [{ transform: 'scale(1)' }, { transform: 'scale(.97)' }], timing);
  }
  function openBook(snapshot, target) {
    var copy = mount(snapshot.copy), parts = bookIn(target);
    if (!parts || !snapshot.bookNode) { play(target, [{ opacity: 0 }, { opacity: 1 }], { duration: 240 }); return; }
    var trigger = snapshot.triggerRect && snapshot.triggerRect.width ? snapshot.triggerRect : box(window.innerWidth / 2 - 110, window.innerHeight - 120, 220, 56);
    var start = snapshot.book ? stance(snapshot.book) : atButton(trigger), from = toward(parts.page, start);
    var fly = { duration: 540, easing: FLY }, turn = { duration: 480, delay: 170, easing: SWING }, depth = hinge(parts.page);
    setStyle(parts.spread, 'transformOrigin', parts.origin);
    play(parts.spread, [{ transform: from }, { transform: SETTLED }], fly);
    var cover = coverOver(parts.page, snapshot.bookNode);
    play(cover.holder, [{ transform: from }, { transform: SETTLED }], fly);
    // Cover and left page are two faces of one leaf: the cover is seen until it
    // stands edge-on, then the title page takes the rest of the turn.
    play(cover.leaf, [{ transform: depth + 'rotateY(0deg)' }, { transform: depth + 'rotateY(-180deg)' }], turn);
    play(cover.shade, [{ opacity: 0 }, { opacity: .2, offset: .5 }, { opacity: .2 }], turn);
    if (parts.leaf) {
      play(parts.leaf, [{ transform: depth + 'rotateY(180deg)' }, { transform: depth + 'rotateY(0deg)' }], turn);
      play(parts.leaf.querySelector('.upload-leaf-shade'), [{ opacity: 1 }, { opacity: 1, offset: .5 }, { opacity: 0 }], turn);
    }
    play(parts.pageNode.querySelector('.upload-leaf-shade'), [{ opacity: 1 }, { opacity: 0, offset: .55 }, { opacity: 0 }], turn);
    // A stacked page would trail the small flying book; it arrives once the cover is away.
    play(parts.below, [{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 400, easing: FADE });
    if (start.small) {
      var appear = { duration: 140, easing: 'linear' };
      play(cover.holder, [{ opacity: 0 }, { opacity: 1 }], appear);
      play(parts.spread, [{ opacity: 0 }, { opacity: 1 }], appear);
    }
    play(target.querySelector('.upload-desk-surface'), [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: 60, easing: FADE });
    recede(copy, fly);
    var margin = note(snapshot.note);
    if (margin) play(margin, [{ transform: asIs(snapshot.note), opacity: 1 }, { transform: asIs(snapshot.note, 8, -6), opacity: 0 }], { duration: 200, easing: EXIT });
    var pressed = copy.querySelector('[data-motion-trigger]');
    launch(pressed || (snapshot.trigger && snapshot.trigger.isConnected && shown(snapshot.trigger)));
  }
  // The left page folds back over the right one while the cover comes down on it.
  function shut(parts, bookNode, turn) {
    var depth = hinge(parts.page);
    if (parts.leaf) {
      play(parts.leaf, [{ transform: depth + 'rotateY(0deg)' }, { transform: depth + 'rotateY(180deg)' }], turn);
      play(parts.leaf.querySelector('.upload-leaf-shade'), [{ opacity: 0 }, { opacity: 1, offset: .5 }, { opacity: 1 }], turn);
    }
    play(parts.below, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: FADE });
    play(parts.pageNode.querySelector('.upload-leaf-shade'), [{ opacity: 0 }, { opacity: 0, offset: .45 }, { opacity: 1 }], turn);
    var cover = coverOver(parts.page, bookNode);
    play(cover.leaf, [{ transform: depth + 'rotateY(-180deg)' }, { transform: depth + 'rotateY(0deg)' }], turn);
    play(cover.shade, [{ opacity: .2 }, { opacity: .2, offset: .5 }, { opacity: 0 }], turn);
    return cover;
  }
  function flyBack(copy, parts, cover, to, fly) {
    parts.spread.style.transformOrigin = parts.origin;
    play(parts.spread, [{ transform: SETTLED }, { transform: to }], fly);
    play(cover.holder, [{ transform: SETTLED }, { transform: to }], fly);
    play(copy.querySelector('.upload-desk-surface'), [{ opacity: 1 }, { opacity: 0 }], { duration: fly.duration, delay: fly.delay - 40, easing: FADE });
  }
  function hide(node) { setStyle(node, 'visibility', 'hidden'); }
  function closeBook(snapshot, rest) {
    var copy = mount(snapshot.copy, '3'), parts = bookIn(copy);
    if (!parts) return fadeOut(copy);
    var cover = shut(parts, rest.book.node, { duration: 380, easing: SWING });
    flyBack(copy, parts, cover, toward(parts.page, stance(rest.book)), { duration: 420, delay: 220, easing: FLY });
    // The real book and note wait under the returning ones, or they are seen twice.
    hide(rest.book.node);
    var margin = note(rest.note);
    if (margin) {
      hide(rest.note.node);
      play(margin, [{ transform: asIs(rest.note, 8, -6), opacity: 0 }, { transform: asIs(rest.note), opacity: 1 }], { duration: 160, delay: 480 });
    }
  }
  function closeTo(snapshot, r) {
    var copy = mount(snapshot.copy, '3'), parts = bookIn(copy);
    if (!parts || !snapshot.bookNode) return fadeOut(copy);
    var cover = shut(parts, snapshot.bookNode, { duration: 340, easing: SWING });
    var fly = { duration: 380, delay: 200, easing: FLY }, vanish = { duration: 140, delay: 440, easing: 'linear' };
    flyBack(copy, parts, cover, toward(parts.page, atButton(r)), fly);
    play(parts.spread, [{ opacity: 1 }, { opacity: 0 }], vanish);
    play(cover.holder, [{ opacity: 1 }, { opacity: 0 }], vanish);
  }
  function fadeOut(copy) {
    recede(copy, { duration: 240, easing: FLY });
    play(copy, [{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: FADE });
  }
  function restingBook(target) {
    if (!target || !target.matches || !target.matches('[data-landing]')) return null;
    var figure = target.querySelector('.landing-transformation');
    // A landing shown for the first time must not replay its arrival under the closing book.
    if (figure) figure.dataset.motionComplete = 'true';
    var p = pose(target.querySelector('.landing-hero-book'));
    return p && onScreen(p.rect) ? { book: p, note: pose(target.querySelector('.landing-margin-note')) } : null;
  }
  function visibleRect(node) {
    if (!node || !node.isConnected || !node.getBoundingClientRect) return null;
    var r = rectOf(node);
    return onScreen(r) ? r : null;
  }
  function capture(from, trigger) {
    if (!from) return null;
    var hero = from.matches && from.matches('[data-landing]') && from.querySelector('.landing-hero'), book = null, margin = null, marked = [];
    function mark(node) { if (node && node.classList && !node.classList.contains('is-launching')) { node.classList.add('is-launching'); marked.push(node); } }
    if (hero) {
      var figure = hero.querySelector('.landing-transformation');
      // Finish a still-running arrival so the measured book is the settled one.
      if (figure) figure.dataset.motionComplete = 'true';
      mark(hero);
      var measured = pose(hero.querySelector('.landing-hero-book'));
      if (measured && onScreen(measured.rect)) { book = measured; margin = pose(hero.querySelector('.landing-margin-note')); }
    }
    mark(trigger);
    var triggerRect = trigger && trigger.getBoundingClientRect ? rectOf(trigger) : null;
    if (trigger && trigger.setAttribute) trigger.setAttribute('data-motion-trigger', '');
    var bounds = rectOf(from), copy = from.cloneNode(true);
    if (trigger && trigger.removeAttribute) trigger.removeAttribute('data-motion-trigger');
    marked.forEach(function (node) { node.classList.remove('is-launching'); });
    copy.hidden = false; copy.inert = true; copy.setAttribute('aria-hidden', 'true');
    copy.removeAttribute('id'); copy.classList.add('upload-motion-copy');
    copy.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
    // The flying cover and note stand in for the ones on the kept page.
    ['.landing-hero-book', '.landing-margin-note'].forEach(function (selector, index) {
      var twin = (index ? margin : book) && copy.querySelector(selector);
      if (twin) twin.style.visibility = 'hidden';
    });
    // A clone keeps attributes, not what was typed: carry the live values over.
    var twins = copy.querySelectorAll('input, textarea, select');
    from.querySelectorAll('input, textarea, select').forEach(function (field, index) {
      var twin = twins[index];
      if (!twin || field.type === 'file') return;
      if (field.type === 'checkbox' || field.type === 'radio') twin.checked = field.checked; else twin.value = field.value;
    });
    Object.assign(copy.style, { top: bounds.top + 'px', left: bounds.left + 'px', width: bounds.width + 'px' });
    return { copy: copy, trigger: trigger || null, triggerRect: triggerRect, book: book, note: margin, bookNode: document.querySelector('.landing-hero-book') };
  }
  function run(mode, snapshot, target, done) {
    cancel();
    var token = epoch;
    document.body.dataset.workspaceMotion = mode;
    if (reduced() || !snapshot || !snapshot.copy) {
      play(target, [{ opacity: 0 }, { opacity: 1 }], { duration: reduced() ? 140 : 240 });
    } else if (mode === 'enter') {
      openBook(snapshot, target);
    } else {
      var rest = restingBook(target), rect = !rest && visibleRect(snapshot.trigger);
      if (rest) closeBook(snapshot, rest); else if (rect) closeTo(snapshot, rect); else fadeOut(mount(snapshot.copy, '3'));
    }
    function finish() {
      if (token !== epoch) return;
      cancel(); if (done) done();
    }
    if (!longest) { finish(); return; }
    longest.finished.then(finish, function () {});
    // A suspended compositor must not leave the workspace covered or mid-turn.
    deadline = setTimeout(finish, longestEnd + 120);
  }
  window.addEventListener('pagehide', cancel);
  window.ShelfUploadMotion = { capture: capture, run: run, cancel: cancel };
}());
