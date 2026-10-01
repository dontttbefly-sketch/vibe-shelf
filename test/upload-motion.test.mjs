import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/upload-motion.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

// A small DOM: enough geometry, cloning and selectors for the opening story.
function camel(name) { return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase()); }
function simpleMatch(node, simple) {
  const parts = simple.match(/^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!parts) throw new Error('unsupported selector ' + simple);
  if (parts[1] && node.tag !== parts[1]) return false;
  for (const name of parts[2].match(/\.[\w-]+/g) || []) if (!node.classes.has(name.slice(1))) return false;
  for (const attribute of parts[3].match(/\[[^\]]+\]/g) || []) {
    const [, name, value] = attribute.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    const actual = name in node.attributes ? node.attributes[name] : name.startsWith('data-') ? node.dataset[camel(name.slice(5))] : undefined;
    if (actual === undefined) return false;
    if (value !== undefined && actual !== value) return false;
  }
  return true;
}
function matches(node, selector) {
  return selector.split(',').some(one => {
    const chain = one.trim().split(/\s+/);
    if (!simpleMatch(node, chain.pop())) return false;
    let cursor = node.parent;
    while (chain.length && cursor) { if (simpleMatch(cursor, chain.at(-1))) chain.pop(); cursor = cursor.parent; }
    return chain.length === 0;
  });
}
class DOMMatrixReadOnly {
  constructor(value) {
    Object.assign(this, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const matrix = value && value.match(/matrix\(([^)]+)\)/);
    if (matrix) [this.a, this.b, this.c, this.d, this.e, this.f] = matrix[1].split(',').map(Number);
  }
}

function makeDom({ reduced = false, width = 1280, height = 800 } = {}) {
  const animations = [], timers = new Map();
  let clock = 0, nextTimer = 0;
  class FakeNode {
    constructor(spec = {}) {
      this.tag = spec.tag || 'div';
      this.classes = new Set(spec.classes || []);
      this.attributes = { ...spec.attributes };
      this.dataset = { ...spec.dataset };
      this.style = {};
      this.children = []; this.parent = null;
      this.rect = spec.rect || null;
      this.offsetWidth = spec.offsetWidth ?? (spec.rect ? spec.rect.width : 0);
      this.offsetHeight = spec.offsetHeight ?? (spec.rect ? spec.rect.height : 0);
      this.transform = spec.transform || 'none';
      this.type = spec.type; this.value = ''; this.checked = false;
      this.hidden = false; this.inert = false;
      (spec.children || []).forEach(child => this.appendChild(child));
    }
    get isConnected() { return true; }
    get className() { return [...this.classes].join(' '); }
    set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get classList() {
      const classes = this.classes;
      return {
        add: (...names) => names.forEach(name => classes.add(name)),
        remove: (...names) => names.forEach(name => classes.delete(name)),
        contains: name => classes.has(name),
        toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); return on; },
      };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
    removeAttribute(name) { delete this.attributes[name]; }
    appendChild(child) { child.remove(); this.children.push(child); child.parent = this; return child; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
    matches(selector) { return matches(this, selector); }
    querySelectorAll(selector) {
      const found = [];
      const walk = node => node.children.forEach(child => { if (matches(child, selector)) found.push(child); walk(child); });
      walk(this); return found;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getBoundingClientRect() {
      const { left = 0, top = 0, width = 0, height = 0 } = this.rect || {};
      return { left, top, width, height, right: left + width, bottom: top + height };
    }
    cloneNode(deep) {
      const copy = new FakeNode({ tag: this.tag, classes: this.classes, attributes: this.attributes, dataset: this.dataset, rect: this.rect,
        offsetWidth: this.offsetWidth, offsetHeight: this.offsetHeight, transform: this.transform, type: this.type });
      if (deep) this.children.forEach(child => copy.appendChild(child.cloneNode(true)));
      return copy;
    }
    animate(frames, options) {
      let resolve, reject;
      const finished = new Promise((done, fail) => { resolve = done; reject = fail; });
      finished.catch(() => {});
      const animation = { node: this, frames, options, finished, cancelled: false,
        complete() { resolve(animation); },
        cancel() { this.cancelled = true; reject(new Error('AbortError')); },
      };
      animations.push(animation);
      return animation;
    }
  }
  const body = new FakeNode({ tag: 'body' });
  // Scene trees are searched like a document without being body children, so
  // body.children lists only what the motion adds.
  const roots = [];
  const document = {
    body, createElement: tag => new FakeNode({ tag }),
    querySelector: selector => { for (const root of [body, ...roots]) { const found = root.matches(selector) && root !== body ? root : root.querySelector(selector); if (found) return found; } return null; },
  };
  const window = {
    innerWidth: width, innerHeight: height,
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: node => ({ transform: node.transform }),
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    window, DOMMatrixReadOnly,
    document,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; clock = timer.at; timers.delete(id); timer.callback();
    }
    clock = until;
  }
  return { FakeNode, body, roots, animations, timers, advance, motion: window.ShelfUploadMotion,
    animationFor: node => animations.findLast(animation => animation.node === node),
    animationsFor: node => animations.filter(animation => animation.node === node),
    layer: name => body.children.find(node => node.classes.has(name)) };
}

// The landing: a hero book in its hover/launch pose (translate(0,-6px) rotate(4deg)
// scale(1.012)) whose resting centre is (965, 385); below an 88px topbar, the
// workspace desk carries an open book of two 466×616 pages (the hero book's 0.756).
const WORKSPACE = { left: 0, top: 88, width: 1280, height: 712 };
const SPREAD = { left: 174, top: 136, width: 932, height: 616 };
const TITLE = { left: 174, top: 136, width: 466, height: 616 };
const PAGE = { left: 640, top: 136, width: 466, height: 616 };
const NARROW_PAGE = { left: 16, top: 110, width: 358, height: 474 };
const NARROW_BELOW = { left: 16, top: 598, width: 358, height: 420 };
const SETTLED = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';
function landingScene({ bookOnScreen = true, reduced = false, narrow = false } = {}) {
  const dom = makeDom({ reduced }), { FakeNode } = dom;
  const angle = 4 * Math.PI / 180, scale = 1.012, cos = Math.cos(angle) * scale, sin = Math.sin(angle) * scale;
  const width = (292 * Math.cos(angle) + 386 * Math.sin(angle)) * scale, height = (292 * Math.sin(angle) + 386 * Math.cos(angle)) * scale;
  const centreY = bookOnScreen ? 385 : 780;
  const book = new FakeNode({ classes: ['landing-hero-book'], offsetWidth: 292, offsetHeight: 386,
    transform: `matrix(${cos}, ${sin}, ${-sin}, ${cos}, 0, -6)`, rect: { left: 965 - width / 2, top: centreY - 6 - height / 2, width, height } });
  const arrow = new FakeNode({ tag: 'svg' });
  const trigger = new FakeNode({ tag: 'button', classes: ['landing-primary'], attributes: { 'data-import-open': '' },
    rect: { left: 140, top: 470, width: 230, height: 56 }, children: [new FakeNode({ classes: ['landing-primary-arrow'], children: [arrow] })] });
  const tilt = -3 * Math.PI / 180, noteWidth = 141 * Math.cos(-tilt) + 120 * Math.sin(-tilt), noteHeight = 141 * Math.sin(-tilt) + 120 * Math.cos(-tilt);
  const note = new FakeNode({ classes: ['landing-margin-note'], offsetWidth: 141, offsetHeight: 120,
    transform: `matrix(${Math.cos(tilt)}, ${Math.sin(tilt)}, ${-Math.sin(tilt)}, ${Math.cos(tilt)}, 3, -3)`, rect: { left: 1150 + 3 - noteWidth / 2, top: 440 - 3 - noteHeight / 2, width: noteWidth, height: noteHeight } });
  const figure = new FakeNode({ classes: ['landing-transformation'], children: [book, note] });
  const hero = new FakeNode({ classes: ['landing-hero'], children: [trigger, figure] });
  const landing = new FakeNode({ tag: 'main', attributes: { 'data-landing': '' }, rect: { left: 0, top: 88, width: 1280, height: 2400 }, children: [hero] });
  const topbar = new FakeNode({ tag: 'header', classes: ['shelf-topbar'], rect: { left: 0, top: 0, width: 1280, height: 88 } });
  const shade = () => new FakeNode({ tag: 'i', classes: ['upload-leaf-shade'] });
  // Open, the writing page (verso) is the cover's other face and the title page
  // (recto) travels; stacked on a narrow screen, the writing page travels.
  const titlepage = new FakeNode({ tag: 'section', classes: ['upload-verso'], rect: narrow ? NARROW_PAGE : TITLE, children: [shade()] });
  const page = new FakeNode({ tag: 'aside', classes: ['upload-recto'], rect: narrow ? NARROW_BELOW : PAGE, children: [shade()] });
  const spread = new FakeNode({ classes: ['upload-book'], rect: narrow ? { left: 16, top: 110, width: 358, height: 908 } : SPREAD, children: [titlepage, page] });
  const desk = new FakeNode({ classes: ['upload-desk-surface'], rect: WORKSPACE });
  const workspace = new FakeNode({ tag: 'main', classes: ['upload-workspace'], rect: WORKSPACE, children: [desk, spread] });
  dom.roots.push(topbar, landing, workspace);
  return { ...dom, book, note, trigger, arrow, figure, hero, landing, topbar, workspace, spread, titlepage, page, desk };
}
// Values made inside the vm carry its own Array/Object prototypes; compare their data.
function same(actual, expected, message) { assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message); }
function approx(actual, expected, label) { assert.ok(Math.abs(actual - expected) < .01, `${label || 'value'}: ${actual} ≠ ${expected}`); }
function flight(transform) {
  const match = transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) rotate\(([-\d.e]+)deg\) scale\(([-\d.e]+), ([-\d.e]+)\)$/);
  assert.ok(match, 'unexpected flight transform ' + transform);
  const [dx, dy, angle, sx, sy] = match.slice(1).map(Number);
  return { dx, dy, angle, sx, sy };
}
// Where a page carried by this transform (about its own centre) stands on screen.
function landed(page, transform) {
  const f = flight(transform);
  return { cx: page.left + page.width / 2 + f.dx, cy: page.top + page.height / 2 + f.dy, w: page.width * f.sx, h: page.height * f.sy, angle: f.angle };
}
function assertStance(actual, expected, label) { for (const key of ['cx', 'cy', 'w', 'h', 'angle']) approx(actual[key], expected[key], label + ' ' + key); }
function flightOf(app, node) { return app.animationsFor(node).find(animation => /^translate/.test(animation.frames[0].transform || '')); }
const HOVER = { cx: 965, cy: 379, w: 292 * 1.012, h: 386 * 1.012, angle: 4 };
function buttonBook(r) { const h = Math.min(120, Math.max(56, r.height * 1.6)); return { cx: r.left + r.width / 2, cy: Math.max(r.top + r.height / 2, 88 + h / 2 + 8), w: h * .756, h, angle: -4 }; }

test('reduced motion enters and leaves with a short opacity fade and no layers', async () => {
  for (const mode of ['enter', 'leave']) {
    const app = makeDom({ reduced: true }), target = new app.FakeNode(), copy = new app.FakeNode();
    let completions = 0;
    app.motion.run(mode, { copy }, target, () => completions++);
    assert.equal(app.body.children.length, 0, 'no copy or book is added');
    assert.equal(app.animations.length, 1);
    const animation = app.animationFor(target);
    assert.ok(animation.options.duration > 0 && animation.options.duration <= 150);
    same(animation.frames.map(frame => frame.opacity), [0, 1]);
    assert.ok(animation.frames.every(frame => Object.keys(frame).every(key => key === 'opacity')));
    animation.complete(); await settle();
    assert.equal(completions, 1);
    assert.equal(app.body.dataset.workspaceMotion, undefined);
    assert.equal(app.timers.size, 0);
  }
});

test('opening flies the hero book to the desk and turns its cover into the left page', async () => {
  const app = landingScene();
  const snapshot = app.motion.capture(app.landing, app.trigger);
  assert.equal(app.figure.dataset.motionComplete, 'true', 'a still-running arrival is finished before measuring');
  assert.ok(snapshot.book, 'the on-screen hero book is the origin');
  assert.equal(snapshot.bookNode, app.book, 'the cover is cloned from the real hero book');
  assert.equal(app.hero.classList.contains('is-launching'), false, 'the launch pose is only borrowed for the measurement and the copy');
  assert.equal(app.trigger.getAttribute('data-motion-trigger'), null);
  assert.ok(snapshot.copy.classList.contains('upload-motion-copy') && snapshot.copy.inert);
  const pressed = snapshot.copy.querySelector('[data-motion-trigger]');
  assert.ok(pressed && pressed.classList.contains('is-launching'), 'the copy keeps the pressed button');
  assert.equal(snapshot.copy.querySelector('.landing-hero-book').style.visibility, 'hidden', 'the flying cover stands in for the kept book');
  assert.equal(snapshot.copy.querySelector('.landing-margin-note').style.visibility, 'hidden', 'and its note flies on its own layer');

  let completions = 0;
  app.motion.run('enter', snapshot, app.workspace, () => completions++);
  assert.equal(snapshot.copy.parent, app.body, 'the old page stays on screen underneath');
  assert.ok(app.animationsFor(snapshot.copy).every(animation => animation.frames.every(frame => frame.opacity === undefined)), 'the old page is never faded out; the desk covers it');
  assert.equal(app.animationFor(snapshot.copy).frames.at(-1).transform, 'scale(.97)', 'it steps back instead');
  same(app.animationFor(app.desk).frames.map(frame => frame.opacity), [0, 1]);

  // The real right page travels under the cover from the hero book to its place.
  const fly = flightOf(app, app.spread);
  assertStance(landed(PAGE, fly.frames[0].transform), HOVER, 'the right page starts exactly under the hero book');
  const start = flight(fly.frames[0].transform);
  approx(start.sx, start.sy, 'an even scale: pages keep the book proportions');
  assert.equal(fly.frames.at(-1).transform, SETTLED);
  assert.equal(app.spread.style.transformOrigin, '699px 308px', 'the spread turns about the right page centre');
  const cover = app.layer('upload-motion-book');
  same([cover.style.left, cover.style.top, cover.style.width, cover.style.height], ['640px', '136px', '466px', '616px']);
  const coverFly = flightOf(app, cover);
  same(coverFly.frames, fly.frames, 'cover and page fly as one');
  same(coverFly.options, fly.options);
  const face = cover.children[0].children[0];
  assert.ok(face.classList.contains('landing-hero-book'));
  assert.equal(face.style.transform, `scale(${466 / 292}, ${616 / 386})`);

  // Cover and title page are the two faces of one turning leaf.
  const swing = app.animationFor(cover.children[0]), turn = app.animationFor(app.titlepage);
  same(swing.frames.map(frame => frame.transform), ['perspective(3728px) rotateY(0deg)', 'perspective(3728px) rotateY(-180deg)']);
  same(turn.frames.map(frame => frame.transform), ['perspective(3728px) rotateY(180deg)', 'perspective(3728px) rotateY(0deg)']);
  same(turn.options, swing.options, 'both faces turn on the same clock, so they meet edge-on');
  assert.ok(swing.options.delay > 0 && swing.options.delay < fly.options.duration, 'the cover opens while the book is still flying');
  assert.ok(swing.frames.every(frame => frame.opacity === undefined), 'the cover never fades over the page; it turns away');
  assert.equal(app.animationFor(app.page.querySelector('.upload-leaf-shade')).frames.at(-1).opacity, 0);
  assert.equal(app.animationFor(app.titlepage.querySelector('.upload-leaf-shade')).frames.at(-1).opacity, 0);
  const note = app.layer('upload-motion-note');
  assert.equal(app.animationFor(note).frames.at(-1).opacity, 0, 'the margin note drifts off the book');
  assert.match(app.animationFor(pressed.querySelector('.landing-primary-arrow svg')).frames.at(-1).transform, /translate\(15px, -15px\)/);
  same(app.body.children.map(node => node.className).sort(), ['upload-motion-book', 'upload-motion-copy', 'upload-motion-note'], 'no sheet, scrim or window layer');
  for (const animation of app.animations) for (const frame of animation.frames) {
    // offset and easing only time a keyframe; everything that moves is composited.
    for (const key of Object.keys(frame)) assert.ok(['transform', 'opacity', 'offset', 'easing'].includes(key), key);
  }

  app.animations.forEach(animation => animation.complete()); await settle();
  assert.equal(completions, 1);
  assert.equal(app.body.children.length, 0);
  assert.equal(app.spread.style.transformOrigin, undefined, 'the live spread gets its own style back');
  assert.equal(app.body.dataset.workspaceMotion, undefined);
  assert.equal(app.timers.size, 0);
});

test('a book summoned by a button off the hero rises small from that button', () => {
  const app = landingScene({ bookOnScreen: false });
  const snapshot = app.motion.capture(app.landing, app.trigger);
  assert.equal(snapshot.book, null);
  assert.equal(snapshot.copy.querySelector('.landing-hero-book').style.visibility, undefined, 'a book that does not fly stays on the kept page');
  app.motion.run('enter', snapshot, app.workspace, () => {});
  assertStance(landed(PAGE, flightOf(app, app.spread).frames[0].transform), buttonBook(app.trigger.rect), 'starts as a small book on the button');
  for (const node of [app.layer('upload-motion-book'), app.spread]) {
    const appear = app.animationsFor(node).find(animation => animation.frames[0].opacity === 0);
    assert.ok(appear && appear.options.duration <= 160, 'the small book appears at once');
  }
});

test('from the library bar the book starts below the bar and the real button springs back', () => {
  const app = landingScene();
  const shelf = new app.FakeNode({ tag: 'main', classes: ['shelf-home'], rect: { left: 0, top: 88, width: 1280, height: 1400 } });
  const barButton = new app.FakeNode({ tag: 'button', classes: ['shelf-new-book'], rect: { left: 1040, top: 26, width: 120, height: 36 } });
  app.topbar.appendChild(barButton); app.roots.push(shelf);
  app.motion.run('enter', app.motion.capture(shelf, barButton), app.workspace, () => {});
  const start = landed(PAGE, flightOf(app, app.spread).frames[0].transform);
  assertStance(start, buttonBook(barButton.rect), 'the small book');
  assert.ok(start.cy - start.h / 2 >= 88, 'the book appears below the bar, not under it');
  assert.equal(app.animationFor(barButton).frames.at(-1).transform, 'scale(1)', 'the pressed bar button springs back');
});

test('on a narrow screen the writing page travels alone and the page below arrives after the cover', () => {
  const app = landingScene({ bookOnScreen: false, narrow: true });
  app.motion.run('enter', app.motion.capture(app.landing, app.trigger), app.workspace, () => {});
  assert.equal(app.animationsFor(app.titlepage).some(animation => /rotateY/.test(animation.frames[0].transform || '')), false, 'a stacked page is not turned');
  const below = app.animationFor(app.page);
  same(below.frames.map(frame => frame.opacity), [0, 1]);
  assert.ok(below.options.delay >= 300, 'it waits until the small book has opened');
  same(app.animationFor(app.layer('upload-motion-book').children[0]).frames.map(frame => frame.transform.split(' ').at(-1)), ['rotateY(0deg)', 'rotateY(-180deg)']);
  assertStance(landed(NARROW_PAGE, flightOf(app, app.spread).frames[0].transform), buttonBook(app.trigger.rect), 'the page rises from the button');
});

function restingScene(options) {
  const app = landingScene(options);
  const angle = 6 * Math.PI / 180;
  const width = 292 * Math.cos(angle) + 386 * Math.sin(angle), height = 292 * Math.sin(angle) + 386 * Math.cos(angle);
  app.book.transform = `matrix(${Math.cos(angle)}, ${Math.sin(angle)}, ${-Math.sin(angle)}, ${Math.cos(angle)}, 0, 0)`;
  app.book.rect = { left: 965 - width / 2, top: (options && options.bookOnScreen === false ? 780 : 385) - height / 2, width, height };
  delete app.figure.dataset.motionComplete;
  return app;
}

test('leaving closes the book and flies it back onto the resting hero book', async () => {
  const app = restingScene();
  const snapshot = app.motion.capture(app.workspace, app.trigger);
  let completions = 0;
  app.motion.run('leave', snapshot, app.landing, () => completions++);
  assert.equal(app.figure.dataset.motionComplete, 'true', 'the landing does not replay its arrival under the closing book');
  assert.equal(snapshot.copy.style.zIndex, '3', 'the kept workspace lies above the page it returns to');
  const cover = app.layer('upload-motion-book');
  const fold = app.animationFor(snapshot.copy.querySelector('.upload-verso')), swing = app.animationFor(cover.children[0]);
  same(fold.frames.map(frame => frame.transform), ['perspective(3728px) rotateY(0deg)', 'perspective(3728px) rotateY(180deg)']);
  same(swing.frames.map(frame => frame.transform), ['perspective(3728px) rotateY(-180deg)', 'perspective(3728px) rotateY(0deg)']);
  same(fold.options, swing.options);
  const fly = flightOf(app, snapshot.copy.querySelector('.upload-book'));
  assert.equal(fly.frames[0].transform, SETTLED);
  assertStance(landed(PAGE, fly.frames.at(-1).transform), { cx: 965, cy: 385, w: 292, h: 386, angle: 6 }, 'it lands on the resting book');
  assert.ok(fly.options.delay > 0 && fly.options.delay < swing.options.duration, 'the book heads home before its cover has fully closed');
  same(flightOf(app, cover).frames, fly.frames);
  same(app.animationFor(snapshot.copy.querySelector('.upload-desk-surface')).frames.map(frame => frame.opacity), [1, 0]);
  assert.equal(app.book.style.visibility, 'hidden', 'the real book waits under the returning one');
  assert.equal(app.note.style.visibility, 'hidden', 'and so does its note');
  assert.equal(app.animationFor(app.layer('upload-motion-note')).frames.at(-1).opacity, 1, 'the note settles back onto the book');
  app.animations.forEach(animation => animation.complete()); await settle();
  assert.equal(completions, 1);
  assert.equal(app.body.children.length, 0);
  assert.equal(app.book.style.visibility, undefined, 'the real book is shown again');
  assert.equal(app.note.style.visibility, undefined);
});

test('leaving with the hero book off screen closes the book into the button that opened it', () => {
  const app = restingScene({ bookOnScreen: false });
  const snapshot = app.motion.capture(app.workspace, app.trigger);
  app.motion.run('leave', snapshot, app.landing, () => {});
  const spread = snapshot.copy.querySelector('.upload-book');
  assertStance(landed(PAGE, flightOf(app, spread).frames.at(-1).transform), buttonBook(app.trigger.rect), 'ends as a small book on the button');
  same(app.animationsFor(spread).find(animation => animation.frames[0].opacity === 1).frames.map(frame => frame.opacity), [1, 0]);
  assert.equal(app.book.style.visibility, undefined, 'a book that is not landed on is never hidden');
});

test('leaving with neither the book nor the button in view fades the kept workspace out', () => {
  const app = restingScene({ bookOnScreen: false });
  app.trigger.rect = { left: 140, top: -300, width: 230, height: 56 };
  const snapshot = app.motion.capture(app.workspace, app.trigger);
  app.motion.run('leave', snapshot, app.landing, () => {});
  assert.equal(app.layer('upload-motion-book'), undefined);
  same(app.animationsFor(snapshot.copy).find(animation => animation.frames[0].opacity !== undefined).frames.map(frame => frame.opacity), [1, 0]);
});

test('a late completion from a cancelled opening cannot finish the next one or take focus', async () => {
  const app = landingScene();
  const focused = [];
  app.motion.run('enter', app.motion.capture(app.landing, app.trigger), app.workspace, () => focused.push('first'));
  const stale = [...app.animations];
  app.motion.cancel();
  assert.ok(stale.every(animation => animation.cancelled), 'cancelling puts the real spread and pages back');
  assert.equal(app.spread.style.transformOrigin, undefined);
  app.motion.run('enter', app.motion.capture(app.landing, app.trigger), app.workspace, () => focused.push('second'));
  stale.forEach(animation => animation.complete()); await settle();
  same(focused, []);
  assert.equal(app.body.dataset.workspaceMotion, 'enter');
  assert.ok(app.body.children.length > 0, 'the new opening keeps its layers');
  app.animations.filter(animation => !stale.includes(animation)).forEach(animation => animation.complete()); await settle();
  same(focused, ['second']);
  assert.equal(app.body.children.length, 0);
});

test('a suspended animation clock cannot leave the book mid-turn after the deadline', async () => {
  const app = landingScene();
  let completions = 0;
  app.motion.run('enter', app.motion.capture(app.landing, app.trigger), app.workspace, () => completions++);
  // Deliberately never resolve any animation: a suspended compositor may do this.
  app.advance(1200);
  assert.equal(completions, 1, 'navigation still completes without a finished event');
  assert.equal(app.body.children.length, 0, 'copy, cover and note are removed');
  assert.ok(app.animations.every(animation => animation.cancelled), 'the flight and the turn on the real pages are removed too');
  assert.equal(app.body.dataset.workspaceMotion, undefined);
  assert.equal(app.timers.size, 0);
  app.animations.forEach(animation => animation.complete()); await settle();
  assert.equal(completions, 1, 'a late completion does not complete navigation twice');
});

test('clones are frozen by a rule scoped to them and keep what was typed', () => {
  assert.doesNotMatch(source, /\*\s*\{\s*animation:\s*none/, 'no page-wide freeze is injected');
  const css = fs.readFileSync(new URL('../public/upload-workspace.css', import.meta.url), 'utf8');
  assert.match(css, /\.upload-motion-copy \*[^{]*\{\s*animation:\s*none !important;\s*transition:\s*none !important;/);
  const app = makeDom(), { FakeNode } = app;
  const name = new FakeNode({ tag: 'input', type: 'hidden' }), folder = new FakeNode({ tag: 'input', type: 'file' }), focus = new FakeNode({ tag: 'textarea' });
  name.value = 'vibe-shelf'; folder.value = 'C:\\fakepath\\x'; focus.value = '讲清请求链路';
  const from = new FakeNode({ tag: 'main', rect: WORKSPACE, children: [name, folder, focus] });
  const [nameTwin, folderTwin, focusTwin] = app.motion.capture(from, null).copy.querySelectorAll('input, textarea, select');
  assert.equal(nameTwin.value, 'vibe-shelf');
  assert.equal(folderTwin.value, '', 'file inputs cannot and need not be carried over');
  assert.equal(focusTwin.value, '讲清请求链路', 'the written focus stays on the kept page');
});
