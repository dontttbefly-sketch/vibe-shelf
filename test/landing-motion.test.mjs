import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('../public/landing.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const workspaceCss = fs.readFileSync(new URL('../public/upload-workspace.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
function blockAfter(label, source = css) {
  const css = source;
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
  const match = rule.match(/animation:\s*([\w-]+)\s+(\d+)ms\s+var\(--ease(?:-morph)?\)(?:\s+(\d+)ms)?\s+both;/);
  assert.ok(match, `${selector} needs a finite arrival with a static final state`);
  return { name: match[1], duration: Number(match[2]), delay: Number(match[3] || 0), rule };
}

test('the hero tells one ordered source-to-pages-to-cover story within 1.2–2.4 seconds', () => {
  const source = animation('.landing-source-sheet');
  const back = animation('.landing-page-back'), middle = animation('.landing-page-middle');
  const cover = animation('.landing-hero-book'), note = animation('.landing-margin-note'), reference = animation('.landing-floating-ref');
  assert.equal(source.delay, 0);
  assert.ok(source.delay < back.delay && back.delay < middle.delay && middle.delay < cover.delay);
  assert.ok(note.delay >= cover.delay + cover.duration);
  const finish = Math.max(...[source, back, middle, cover, note, reference].map(item => item.delay + item.duration));
  assert.ok(finish >= 1200 && finish <= 2400, `whole story finishes after ${finish}ms`);
  assert.match(blockAfter('.landing-transformation[data-motion-complete="true"]'), /animation:\s*none/);
});

test('hero motion and the quiet writing indicator animate only composited properties', () => {
  for (const [name, source] of [...['landing-source-arrive', 'landing-page-back-form', 'landing-page-middle-form', 'landing-book-arrive', 'landing-note-arrive', 'landing-arrow-loop'].map(name => [name, css]), ['upload-step-breathe', workspaceCss], ['upload-step-pulse', workspaceCss]]) {
    const frames = blockAfter('@keyframes ' + name, source);
    // A per-keyframe easing times a segment; it is not an animated property.
    const properties = [...frames.matchAll(/([a-z-]+)\s*:/g)].map(match => match[1]).filter(property => property !== 'animation-timing-function');
    assert.ok(properties.length > 0);
    assert.ok(properties.every(property => ['transform', 'opacity', 'clip-path'].includes(property)), `${name}: ${properties.join(', ')}`);
  }
  // Only a running generation breathes; it never estimates a percentage.
  const pulsing = blockAfter('.upload-workspace[data-phase="generating"] .upload-progress li[aria-current="step"] > span {', workspaceCss);
  assert.match(pulsing, /animation:\s*upload-step-pulse\s+\d+ms\s+ease-in-out\s+infinite/);
  assert.match(blockAfter('.upload-workspace[data-phase="generating"] [data-contents-row="book"] .upload-contents-mark::after', workspaceCss), /animation:\s*upload-step-breathe\s+\d+ms\s+ease-out\s+infinite/);
});

test('reduced motion shows the hero and the writing indicator in stable final geometry', () => {
  const reduced = blockAfter('@media (prefers-reduced-motion: reduce)');
  for (const selector of ['.landing-source-sheet', '.landing-page-sheet', '.landing-hero-book', '.landing-margin-note', '.landing-floating-ref']) assert.ok(reduced.includes(selector));
  assert.match(reduced, /animation:\s*none;\s*opacity:\s*1;\s*clip-path:\s*none/);
  const quiet = blockAfter('@media (prefers-reduced-motion: reduce)', workspaceCss);
  assert.match(quiet, /li\[aria-current="step"\] > span\s*\{\s*animation:\s*none/);
  assert.match(quiet, /upload-contents-mark::after\s*\{\s*animation:\s*none/);
});

test('the outlined primary action shows its press with a mouse, after the hover styles', () => {
  const primary = blockAfter('.landing-primary {');
  assert.match(primary, /border:\s*1\.5px solid var\(--clay\)/);
  assert.match(primary, /background:\s*transparent/);
  // Hover and press share one specificity; the press must come later to win.
  const fine = blockAfter('@media (hover: hover) and (pointer: fine) {');
  const hover = fine.indexOf('.landing-primary:hover'), press = fine.indexOf('.landing-primary:active');
  assert.ok(hover !== -1 && press > hover, 'press follows hover inside the fine-pointer block');
  assert.match(blockAfter('.landing-hero.is-launching .landing-transformation'), /transition:\s*none/);
});
