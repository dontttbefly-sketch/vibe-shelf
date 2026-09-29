import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/upload-motion.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function scene({ reduced = false } = {}) {
  const animations = [], timers = new Map(), listeners = new Map();
  let clock = 0, nextTimer = 0;
  function node({ story = false, baseTransform = 'none', groups = [] } = {}) {
    return {
      style: {}, dataset: {}, children: [], attributes: {}, baseTransform, parent: null,
      setAttribute(name, value) { this.attributes[name] = value; },
      appendChild(child) { this.children.push(child); child.parent = this; },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      closest(selector) { return selector === '.upload-story' && story ? this : null; },
      querySelectorAll(selector) { return selector === '[data-workspace-reveal]' ? groups : []; },
      animate(frames, options) {
        let resolve;
        const finished = new Promise(done => { resolve = done; });
        const animation = { node: this, frames, options, finished, cancelled: false,
          complete: resolve,
          cancel() { this.cancelled = true; },
        };
        animations.push(animation);
        return animation;
      },
    };
  }
  const body = node();
  const window = {
    innerWidth: 1280, innerHeight: 800,
    matchMedia: () => ({ matches: reduced }),
    getComputedStyle: target => ({ transform: target.baseTransform }),
    addEventListener(type, listener) { listeners.set(type, listener); },
  };
  vm.runInNewContext(source, {
    window,
    document: { body, createElement: () => node(), querySelector: () => null },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  function advance(ms) {
    const until = clock + ms;
    while (true) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next; clock = timer.at; timers.delete(id); timer.callback();
    }
    clock = until;
  }
  return { node, body, animations, timers, advance, motion: window.ShelfUploadMotion,
    paper: () => body.children.find(child => child.className === 'upload-page-turn'),
    animationFor: target => animations.findLast(animation => animation.node === target),
  };
}

test('reduced motion enters and leaves with a short opacity fade and no paper layers', async () => {
  for (const mode of ['enter', 'leave']) {
    const app = scene({ reduced: true }), target = app.node(), copy = app.node();
    let completions = 0;
    app.motion.run(mode, { copy }, target, () => completions++);
    assert.equal(app.body.children.length, 0, 'no full-screen paper or cloned content is added');
    assert.equal(app.animations.length, 1);
    const animation = app.animationFor(target);
    assert.ok(animation.options.duration > 0 && animation.options.duration <= 150);
    assert.equal(animation.frames[0].opacity, 0);
    assert.equal(animation.frames.at(-1).opacity, 1);
    assert.ok(animation.frames.every(frame => Object.keys(frame).every(key => key === 'opacity')));
    animation.complete(); await settle();
    assert.equal(completions, 1);
    assert.equal(app.body.dataset.workspaceMotion, undefined);
    assert.equal(app.timers.size, 0);
  }
});

test('a queued completion from a cancelled entry cannot remove the new entry or take focus', async () => {
  const app = scene(), firstTarget = app.node(), secondTarget = app.node();
  const focused = [];
  app.motion.run('enter', { copy: app.node() }, firstTarget, () => focused.push('first'));
  const oldPaper = app.paper(), oldAnimation = app.animationFor(oldPaper);
  // Resolution has queued its promise callback, but a new navigation wins first.
  oldAnimation.complete();
  app.motion.cancel();
  app.motion.run('enter', { copy: app.node() }, secondTarget, () => focused.push('second'));
  const newPaper = app.paper(), newAnimation = app.animationFor(newPaper);
  await settle();
  assert.equal(oldPaper.parent, null);
  assert.equal(newPaper.parent, app.body);
  assert.equal(newAnimation.cancelled, false);
  assert.equal(app.body.dataset.workspaceMotion, 'enter');
  assert.deepEqual(focused, []);
  newAnimation.complete(); await settle();
  assert.deepEqual(focused, ['second']);
  assert.equal(app.body.children.length, 0);
});

test('a suspended animation clock cannot leave the workspace obscured after the deadline', async () => {
  const app = scene(), field = app.node(), target = app.node({ groups: [field] });
  let completions = 0;
  app.motion.run('enter', { copy: app.node() }, target, () => completions++);
  const paper = app.paper(), sentinel = app.animationFor(paper);
  assert.equal(app.body.children.length, 2);
  // Deliberately never resolve any animation: a suspended compositor may do this.
  app.advance(1200);
  assert.equal(completions, 1, 'navigation still completes without a WAAPI finished event');
  assert.equal(app.body.children.length, 0, 'both the snapshot and covering paper are removed');
  assert.equal(app.body.dataset.workspaceMotion, undefined);
  assert.ok(app.animations.every(animation => animation.cancelled), 'invisible fill effects are removed from fields too');
  assert.equal(app.timers.size, 0);
  sentinel.complete(); await settle();
  assert.equal(completions, 1, 'late compositor completion must not complete navigation twice');
});

function rotation(transform) {
  const matrix = transform.match(/matrix\(([^)]+)\)/);
  if (matrix) { const [a, b] = matrix[1].split(',').map(Number); return Math.atan2(b, a); }
  const rotate = transform.match(/rotate\((-?[\d.]+)deg\)/);
  return rotate ? Number(rotate[1]) * Math.PI / 180 : 0;
}

test('the project leaf keeps its rotation throughout reveal and after animation cleanup', async () => {
  const app = scene();
  const angle = -3 * Math.PI / 180;
  const leaf = app.node({ story: true, baseTransform: `matrix(${Math.cos(angle)}, ${Math.sin(angle)}, ${-Math.sin(angle)}, ${Math.cos(angle)}, 0, 0)` });
  app.motion.run('enter', null, app.node({ groups: [leaf] }));
  const reveal = app.animationFor(leaf), base = rotation(leaf.baseTransform);
  assert.ok(reveal, 'the leaf participates in the entry sequence');
  for (const frame of reveal.frames) assert.ok(Math.abs(rotation(frame.transform) - base) < 1e-9, 'translation must not straighten the leaf');
  const displayedEnd = rotation(reveal.frames.at(-1).transform);
  app.animationFor(app.paper()).complete(); await settle();
  assert.equal(reveal.cancelled, true);
  assert.ok(Math.abs(displayedEnd - rotation(leaf.baseTransform)) < 1e-9, 'removing the animation cannot introduce a rotation jump');
});
