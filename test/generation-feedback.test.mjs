import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/generation-feedback.js', import.meta.url), 'utf8');

function mountedFeedback({ hash = '#library', stored = null, visibility = 'visible' } = {}) {
  const listeners = new Map(), frames = [], cards = [], focused = [], scrolled = [], history = [], storage = new Map();
  if (stored) storage.set('shelf-import-flow', JSON.stringify(stored));
  class Event {
    constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
  }
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = new Map();
      this.textContent = ''; this.className = ''; this.hidden = false; this.value = ''; this.classes = new Set();
      this.classList = { add: value => this.classes.add(value), toggle: (value, condition) => condition ? this.classes.add(value) : this.classes.delete(value), contains: value => this.classes.has(value) };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    prepend(node) { node.parent = this; this.children.unshift(node); }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    removeAttribute(name) { delete this.attrs[name]; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    dispatchEvent(event) { for (const fn of this.listeners.get(event.type) || []) fn(event); }
    click() { this.dispatchEvent(new Event('click')); }
    reset() { this.dispatchEvent(new Event('reset')); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
    focus(options) { focused.push({ node: this, options }); }
    scrollIntoView(options) { scrolled.push({ node: this, options }); }
    closest(selector) { return selector === '.shelf-book-item' ? this.article : null; }
  }
  const workspace = new Element('main'), form = new Element('form'), body = new Element('body'), toolbar = new Element('div'), hero = new Element('figure');
  const search = new Element('input'), sort = new Element('select'), filter = new Element('button'), importButton = new Element('button');
  sort.value = 'name';
  search.value = 'old search'; form.dataset.launcherState = 'idle';
  body.dataset.pageView = hash === '#generate' ? 'generate' : hash === '#upload' ? 'upload' : 'library';
  workspace.hidden = !['upload', 'generate'].includes(body.dataset.pageView);
  const steps = Array.from({ length: 4 }, () => new Element('li'));
  // The stages sit on the book's facing page, outside the form.
  workspace.querySelectorAll = selector => selector === '[data-generation-step]' ? steps : [];
  filter.addEventListener('click', () => history.push('filter-all'));
  search.addEventListener('input', () => history.push('search-reset'));
  const doc = {
    body, visibilityState: visibility, readingOverlay: false,
    createElement: tag => new Element(tag), createTextNode: text => ({ textContent: text }),
    querySelector(selector) {
      if (selector === '.shelf-arrival-notice') return body.children.find(node => node.className === 'shelf-arrival-notice') || null;
      if (selector === 'dialog[open]') return doc.readingOverlay ? {} : null;
      if (selector === '.shelf-opening[open]') return doc.readingOverlay ? {} : null;
      return { '[data-upload-workspace]': workspace, '[data-project-import]': form, '.shelf-topbar-actions': toolbar, '.landing-transformation': hero,
        '[data-shelf-search]': search, '[data-shelf-sort]': sort, '[data-catalog-filter="all"]': filter }[selector] || null;
    },
    querySelectorAll: selector => selector === '[data-shelf-focus]' ? cards : selector === '[data-import-open]' ? [importButton] : [],
  };
  let currentHash = hash;
  const location = { get hash() { return currentHash; }, set hash(value) { currentHash = value && !value.startsWith('#') ? '#' + value : value; } };
  const win = {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatchEvent: event => dispatch(event.type, event),
    ShelfLanding: { showLibrary() { navigate('library'); }, showGeneration() { navigate('generate'); }, showUpload() { navigate('upload'); } },
  };
  function navigate(view) {
    history.push(view); location.hash = '#' + view; body.dataset.pageView = view;
    workspace.hidden = !['upload', 'generate'].includes(view);
    dispatch('shelf-view-changed', { detail: { view } });
  }
  function dispatch(type, options = {}) { for (const fn of listeners.get(type) || []) fn(new Event(type, options)); }
  function emit({ id = 'project-a', generationId = 'job-a', state = 'generating', previous = 'generating', stage = 'writing', persist = true } = {}) {
    const project = { id, name: 'Book ' + id };
    const generation = { status: state, stage, ...(generationId ? { generationId } : {}) };
    // Match showFlow's actual ordering: persist its current flow, then dispatch.
    if (persist) storage.set('shelf-import-flow', JSON.stringify({ projectId: id, name: project.name, status: state, ...(generationId ? { generationId } : {}) }));
    dispatch('shelf-generation-state', { detail: { project, generation, state, previous } });
  }
  function addBook(id) {
    const card = new Element('a'); card.setAttribute('data-shelf-focus', 'book:' + id); card.article = new Element('article'); cards.push(card); return card;
  }
  function flushFrames() { while (frames.length) frames.shift()(); }
  vm.runInNewContext(source, { window: win, document: doc, location, localStorage: { getItem: key => storage.get(key) || null }, Event, CustomEvent: Event,
    requestAnimationFrame: fn => frames.push(fn), matchMedia: () => ({ matches: false }) });
  return { win, doc, workspace, form, toolbar, hero, search, sort, steps, location, history, focused, scrolled, storage, importButton, emit, dispatch, navigate, addBook, flushFrames,
    taskButton: () => toolbar.children[0], notice: () => doc.querySelector('.shelf-arrival-notice'),
  };
}

test('first generation follows real stages and waits for the newly rendered book before highlighting', () => {
  const h = mountedFeedback({ hash: '#upload' });
  h.emit({ previous: 'importing', stage: 'writing' });
  assert.equal(h.location.hash, '#generate');
  assert.equal(h.steps[0].classes.has('is-complete'), true);
  assert.equal(h.steps[1].attrs['aria-current'], 'step');
  assert.equal(h.steps[2].classes.has('is-complete'), false);
  assert.equal(h.taskButton().hidden, false);
  h.emit({ state: 'ready' }); h.flushFrames();
  assert.equal(h.workspace.hidden, true); assert.equal(h.location.hash, '#library');
  assert.equal(h.search.value, ''); assert.equal(h.taskButton().hidden, true);
  assert.equal(h.focused.length, 0, 'an early ready response cannot invent an already rendered card');
  const book = h.addBook('project-a');
  h.dispatch('shelf-projects-loaded'); h.flushFrames();
  assert.equal(book.article.classes.has('is-new-book'), true);
  assert.equal(h.focused[0].node, book); assert.equal(h.focused[0].options.preventScroll, true);
  assert.equal(h.scrolled[0].node, book);
  h.dispatch('shelf-projects-loaded'); h.emit({ state: 'ready', previous: 'ready' }); h.flushFrames();
  assert.equal(h.focused.length, 1); assert.equal(h.history.filter(item => item === 'library').length, 1);
});

test('an import that is already ready on its first response completes the same visible journey', () => {
  const h = mountedFeedback({ hash: '#upload' }); const book = h.addBook('project-a');
  h.emit({ state: 'ready', previous: 'importing' }); h.flushFrames();
  assert.equal(h.workspace.hidden, true); assert.equal(h.location.hash, '#library');
  assert.equal(h.focused[0].node, book);
});

test('revealing a new book asks the catalog to include its project after clearing filters without changing the user sort', () => {
  const h = mountedFeedback({ hash: '#upload' });
  let catalogLimit = 40, target = null;
  h.win.addEventListener('shelf-reveal-project', event => {
    assert.equal(event.detail.projectId, 'project-a');
    assert.equal(h.search.value, '');
    assert.equal(h.history.at(-1), 'filter-all', 'reveal must happen after search and filter renders reset their limits');
    assert.equal(h.sort.value, 'name');
    // The catalog owns sorting and pagination. Its handler can now include a
    // project beyond the first 40 while the existing highlight waits for paint.
    catalogLimit = 75; target = h.addBook(event.detail.projectId);
    h.history.push('project-revealed');
  });
  h.emit({ state: 'ready', previous: 'importing' });
  assert.equal(h.focused.length, 0);
  h.flushFrames();
  assert.equal(catalogLimit, 75);
  assert.equal(h.sort.value, 'name');
  assert.equal(h.focused[0].node, target); assert.equal(h.scrolled[0].node, target);
});

test('refreshing the generation route delivers an already finished task from the restored workspace', () => {
  for (const savedStatus of ['generating', 'ready']) {
    const h = mountedFeedback({ hash: '#generate', stored: { projectId: 'project-a', generationId: 'job-a', status: savedStatus } });
    const book = h.addBook('project-a');
    h.emit({ state: 'ready', previous: savedStatus }); h.flushFrames();
    assert.equal(h.location.hash, '#library'); assert.equal(h.workspace.hidden, true);
    assert.equal(h.focused[0].node, book); assert.equal(h.notice(), null);
  }
});

test('the restored generation workspace follows its actual unfinished task without fabricating completed stages', () => {
  const h = mountedFeedback({ hash: '#generate', stored: { projectId: 'project-a', generationId: 'job-a', status: 'generating' } });
  h.emit({ stage: 'reading' });
  assert.equal(h.workspace.hidden, false); assert.equal(h.doc.body.dataset.pageView, 'generate');
  assert.equal(h.steps[0].attrs['aria-current'], 'step');
  assert.equal(h.steps.some(step => step.classes.has('is-complete')), false);
  assert.equal(h.history.includes('library'), false);
});

test('the active task entry returns to the generation workspace without a dialog or a second import', () => {
  const h = mountedFeedback({ hash: '#upload' });
  h.emit({ stage: 'writing' });
  h.navigate('library');
  h.taskButton().click();
  assert.equal(h.location.hash, '#generate');
  assert.equal(h.doc.body.dataset.pageView, 'generate');
  assert.equal(h.workspace.hidden, false);
  assert.equal(h.form.dataset.generationStage, 'writing');
  assert.equal(h.doc.querySelector('[data-import-dialog]'), null);
  assert.equal(h.notice(), null);
});

test('after leaving generation for home or library only a notification appears until the user reveals the book', () => {
  for (const destination of ['home', 'library']) {
    const h = mountedFeedback({ hash: '#upload' }); h.emit(); h.navigate(destination);
    const priorNavigations = h.history.length;
    h.emit({ state: 'ready' }); h.flushFrames();
    assert.equal(h.history.length, priorNavigations, 'completion must not replace the chosen destination');
    assert.equal(h.doc.body.dataset.pageView, destination); assert.equal(h.focused.length, 0);
    const notice = h.notice(); assert.ok(notice);
    assert.equal(h.search.value, 'old search');
    const book = h.addBook('project-a');
    notice.children.find(node => node.tagName === 'A').click(); h.flushFrames();
    assert.equal(h.notice(), null); assert.equal(h.location.hash, '#library');
    assert.equal(h.search.value, ''); assert.equal(h.focused[0].node, book);
  }
});

test('delivery keys deduplicate one generation but allow a later generation even when previous state was ready', () => {
  const h = mountedFeedback(); h.emit({ state: 'ready' });
  const first = h.notice();
  h.emit({ state: 'ready', previous: 'ready' }); assert.equal(h.notice(), first);
  h.emit({ state: 'ready', generationId: 'job-b', previous: 'ready' });
  const second = h.notice(); assert.notEqual(second, first);
  h.emit({ state: 'ready', generationId: 'job-a', persist: false }); assert.equal(h.notice(), second);
  h.emit({ state: 'generating', generationId: 'job-b', persist: false });
  assert.equal(h.form.dataset.launcherState, 'ready', 'a late poll cannot regress an already delivered generation');
  assert.equal(h.taskButton().hidden, true);
});

test('revisiting the library with a persisted ready task does not announce that old delivery again', () => {
  const h = mountedFeedback({ stored: { projectId: 'project-a', generationId: 'job-a', status: 'ready' } });
  h.emit({ state: 'ready', previous: 'ready' }); h.flushFrames();
  assert.equal(h.notice(), null); assert.equal(h.focused.length, 0); assert.equal(h.history.includes('library'), false);
});

test('resetting for a new upload retires old events and hides the stale task button', () => {
  const h = mountedFeedback({ hash: '#upload' }); h.emit();
  h.form.reset(); h.storage.delete('shelf-import-flow');
  h.navigate('upload');
  assert.equal(h.taskButton().hidden, true); assert.equal(h.form.dataset.launcherState, 'idle');
  h.emit({ state: 'ready', persist: false }); h.flushFrames();
  assert.equal(h.workspace.hidden, false); assert.equal(h.doc.body.dataset.pageView, 'upload');
  assert.equal(h.history.includes('library'), false); assert.equal(h.notice(), null);
  h.emit({ id: 'project-b', generationId: 'job-b', previous: 'importing' });
  h.emit({ id: 'project-a', state: 'ready', persist: false });
  assert.equal(h.form.dataset.launcherState, 'generating'); assert.equal(h.taskButton().hidden, false);
  const b = h.addBook('project-b'); h.emit({ id: 'project-b', generationId: 'job-b', state: 'ready' }); h.flushFrames();
  assert.equal(h.focused[0].node, b);
});

test('the explicit import-reset event also clears the old task button and queued arrival', () => {
  const h = mountedFeedback({ hash: '#upload' }); h.emit();
  h.dispatch('shelf-import-reset');
  assert.equal(h.taskButton().hidden, true); assert.equal(h.form.dataset.launcherState, 'idle');
  h.emit({ state: 'ready', persist: false }); h.flushFrames();
  assert.equal(h.history.includes('library'), false); assert.equal(h.notice(), null);
});

test('an older generation on the same project cannot navigate away from the newer generation workspace', () => {
  const h = mountedFeedback({ hash: '#upload' }); h.emit(); h.emit({ generationId: 'job-b' });
  h.emit({ state: 'ready', generationId: 'job-a', persist: false });
  assert.equal(h.workspace.hidden, false); assert.equal(h.form.dataset.launcherState, 'generating');
  assert.equal(h.doc.body.dataset.pageView, 'generate');
  assert.equal(h.history.includes('library'), false);
  h.emit({ state: 'ready', generationId: 'job-b' });
  assert.equal(h.workspace.hidden, true); assert.equal(h.history.filter(item => item === 'library').length, 1);
});

test('a pending arrival highlight cannot steal focus from a new upload or a book the user opens', () => {
  for (const nextAction of ['upload', 'read']) {
    const h = mountedFeedback({ hash: '#upload' });
    h.emit({ state: 'ready', previous: 'importing' });
    if (nextAction === 'upload') { h.importButton.click(); h.form.reset(); h.navigate('upload'); }
    else { h.dispatch('pointerdown'); h.doc.readingOverlay = true; }
    h.addBook('project-a'); h.dispatch('shelf-projects-loaded'); h.flushFrames();
    assert.equal(h.focused.length, 0); assert.equal(h.scrolled.length, 0);
  }
});

test('completion in a hidden tab or while opening another book only notifies and preserves the current workspace', () => {
  for (const situation of ['hidden', 'opening']) {
    const h = mountedFeedback({ hash: '#generate', visibility: situation === 'hidden' ? 'hidden' : 'visible' });
    h.doc.readingOverlay = situation === 'opening';
    h.emit({ state: 'ready' }); h.flushFrames();
    assert.equal(h.workspace.hidden, false); assert.equal(h.doc.body.dataset.pageView, 'generate');
    assert.equal(h.history.includes('library'), false);
    assert.equal(h.focused.length, 0); assert.ok(h.notice());
  }
});

test('generation artwork accepts a first writing stage directly and advances only from trusted service stages', () => {
  const h = mountedFeedback({ hash: '#upload' });
  assert.equal(h.form.dataset.generationStage, undefined);
  h.emit({ stage: 'writing', previous: 'importing' });
  assert.equal(h.form.dataset.generationStage, 'writing', 'the UI must not replay reading when the first observed stage is already writing');
  h.flushFrames(); assert.equal(h.form.dataset.generationStage, 'writing');
  h.emit({ stage: 'compiling' }); assert.equal(h.form.dataset.generationStage, 'compiling');
  h.emit({ stage: 'estimated-done' }); assert.equal(h.form.dataset.generationStage, undefined, 'unknown labels cannot invent a visual completion');
  h.emit({ state: 'failed', stage: 'writing' });
  assert.equal(h.form.dataset.generationStage, 'writing'); assert.equal(h.form.dataset.launcherState, 'failed');
  h.emit({ state: 'ready', stage: 'compiling' });
  assert.equal(h.form.dataset.generationStage, 'ready');
  assert.equal(h.workspace.hidden, true); assert.equal(h.location.hash, '#library', 'the cover state must not add an animation wait before delivery');
  h.form.reset(); assert.equal(h.form.dataset.generationStage, undefined);
});

test('retired generation events cannot change the current artwork stage', () => {
  const h = mountedFeedback({ hash: '#upload' });
  h.emit({ generationId: 'old', stage: 'writing' });
  h.emit({ generationId: 'new', stage: 'compiling' });
  h.emit({ generationId: 'old', stage: 'reading', persist: false });
  assert.equal(h.form.dataset.generationStage, 'compiling');
});

test('the hero records completion only after its final annotation animation, without changing application state', () => {
  const h = mountedFeedback();
  const target = name => ({ classList: { contains: value => value === name } });
  h.hero.dispatchEvent({ type: 'animationend', animationName: 'landing-source-arrive', target: target('landing-source-sheet') });
  assert.equal(h.hero.dataset.motionComplete, undefined);
  h.hero.dispatchEvent({ type: 'animationend', animationName: 'landing-note-arrive', target: target('landing-floating-ref') });
  assert.equal(h.hero.dataset.motionComplete, undefined);
  h.hero.dispatchEvent({ type: 'animationend', animationName: 'landing-note-arrive', target: target('landing-margin-note') });
  assert.equal(h.hero.dataset.motionComplete, 'true');
  assert.equal(h.form.dataset.launcherState, 'idle'); assert.equal(h.form.dataset.generationStage, undefined);
  assert.equal(h.history.length, 0); assert.equal(h.location.hash, '#library');
});
