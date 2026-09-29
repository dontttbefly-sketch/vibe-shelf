import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/landing.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function blockAfter(label) {
  const labelAt = css.indexOf(label);
  assert.notEqual(labelAt, -1, `missing CSS block: ${label}`);
  const start = css.indexOf('{', labelAt);
  let depth = 1, end = start + 1;
  for (; end < css.length && depth; end++) {
    if (css[end] === '{') depth++;
    else if (css[end] === '}') depth--;
  }
  assert.equal(depth, 0, `unclosed CSS block: ${label}`);
  return css.slice(start + 1, end - 1);
}
function animation(selector) {
  const rule = blockAfter(selector + ' {');
  const match = rule.match(/animation:\s*([\w-]+)\s+(\d+)ms\s+var\(--ease\)(?:\s+(\d+)ms)?\s+both;/);
  assert.ok(match, `${selector} needs a finite arrival with a static final state`);
  return { name: match[1], duration: Number(match[2]), delay: Number(match[3] || 0), rule };
}

test('the hero tells one ordered source-to-pages-to-cover story within 1.2–1.8 seconds', () => {
  const source = animation('.landing-source-sheet');
  const back = animation('.landing-page-back'), middle = animation('.landing-page-middle');
  const cover = animation('.landing-hero-book'), note = animation('.landing-margin-note'), reference = animation('.landing-floating-ref');
  assert.equal(source.delay, 0);
  assert.ok(source.delay < back.delay && back.delay < middle.delay && middle.delay < cover.delay);
  assert.ok(note.delay >= cover.delay + cover.duration);
  const finish = Math.max(...[source, back, middle, cover, note, reference].map(item => item.delay + item.duration));
  assert.ok(finish >= 1200 && finish <= 1800, `whole story finishes after ${finish}ms`);
  assert.match(blockAfter('.landing-transformation[data-motion-complete="true"]'), /animation:\s*none/);
});

test('hero motion and the quiet writing indicator animate only composited properties', () => {
  for (const name of ['landing-source-arrive', 'landing-page-back-form', 'landing-page-middle-form', 'landing-book-arrive', 'landing-note-arrive', 'landing-generation-wait']) {
    const frames = blockAfter('@keyframes ' + name);
    const properties = [...frames.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]);
    assert.ok(properties.length > 0);
    assert.ok(properties.every(property => ['transform', 'opacity', 'clip-path'].includes(property)), `${name}: ${properties.join(', ')}`);
  }
  assert.match(blockAfter('[data-launcher-state="generating"][data-generation-stage="writing"] .landing-generation-art::after'), /3200ms\s+ease-in-out\s+infinite/);
  for (const selector of ['.landing-generation-art > span', '.landing-generation-art > i']) assert.doesNotMatch(blockAfter(selector + ' {'), /animation:/);
});

test('each real stage has a distinct paper arrangement and reduced motion shows stable final geometry', () => {
  const transforms = ['reading', 'writing', 'compiling', 'ready'].map(stage => {
    const rule = blockAfter(`[data-generation-stage="${stage}"] .landing-generation-art > span:nth-child(1)`);
    return rule.match(/transform:\s*([^;]+);/)[1];
  });
  assert.equal(new Set(transforms).size, 4);
  const reduced = blockAfter('@media (prefers-reduced-motion: reduce)');
  for (const selector of ['.landing-source-sheet', '.landing-page-sheet', '.landing-hero-book', '.landing-margin-note', '.landing-floating-ref']) assert.ok(reduced.includes(selector));
  assert.match(reduced, /animation:\s*none;\s*opacity:\s*1;\s*clip-path:\s*none/);
  assert.match(reduced, /\.landing-generation-art::after\s*\{\s*animation:\s*none\s*!important/);
  assert.match(reduced, /\.landing-generation-art > span[\s\S]*?transition:\s*none/);
});
