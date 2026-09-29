/* 生成的视觉阶段只跟随服务端事件，不使用估算百分比。 */
(function () {
  'use strict';
  var workspace = document.querySelector('[data-upload-workspace]');
  var form = document.querySelector('[data-project-import]');
  if (!workspace || !form) return;
  var hero = document.querySelector('.landing-transformation');
  if (hero) hero.addEventListener('animationend', function (event) {
    if (event.animationName === 'landing-note-arrive' && event.target.classList.contains('landing-margin-note')) hero.dataset.motionComplete = 'true';
  });
  var taskButton = document.createElement('button');
  taskButton.type = 'button'; taskButton.className = 'shelf-task-status'; taskButton.hidden = true;
  taskButton.setAttribute('data-active-generation', '');
  document.querySelector('.shelf-topbar-actions')?.prepend(taskButton);
  taskButton.addEventListener('click', function () { if (activeKey) window.ShelfLanding?.showGeneration({ focus: true }); });
  function key(projectId, generationId) { return projectId + ':' + (generationId || 'legacy'); }
  var initialFlow;
  try { initialFlow = JSON.parse(localStorage.getItem('shelf-import-flow') || 'null'); } catch (_) {}
  var activeKey = initialFlow && initialFlow.projectId ? key(initialFlow.projectId, initialFlow.generationId) : null;
  var previousReady = new Set(), retired = new Set(), pendingHighlight = null, epoch = 0;
  // A saved ready flow already delivered on a previous visit. A refresh of the
  // generation route still needs to finish its visible journey to the shelf.
  if (activeKey && initialFlow.status === 'ready' && location.hash !== '#generate') previousReady.add(activeKey);
  function cancelHighlight() { epoch++; pendingHighlight = null; }
  function requestHighlight(project) {
    pendingHighlight = { project: project, epoch: epoch };
    highlight();
  }
  function reveal(project) {
    window.ShelfLanding?.showLibrary();
    var search = document.querySelector('[data-shelf-search]');
    if (search) { search.value = ''; search.dispatchEvent(new Event('input')); }
    document.querySelector('[data-catalog-filter="all"]')?.click();
    window.dispatchEvent(new CustomEvent('shelf-reveal-project', { detail: { projectId: project.id } }));
    requestHighlight(project);
  }
  function notify(project, message) {
    document.querySelector('.shelf-arrival-notice')?.remove();
    var notice = document.createElement('div'); notice.className = 'shelf-arrival-notice'; notice.setAttribute('role', 'status');
    notice.append(document.createTextNode(message));
    var link = document.createElement('a'); link.href = '#library'; link.textContent = '去书架查看';
    link.addEventListener('click', function () { notice.remove(); reveal(project); });
    notice.append(link); document.body.append(notice);
  }
  function highlight() {
    var pending = pendingHighlight;
    if (!pending) return;
    requestAnimationFrame(function () {
      if (pendingHighlight !== pending || pending.epoch !== epoch) return;
      if (location.hash !== '#library' || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) { cancelHighlight(); return; }
      var card = Array.from(document.querySelectorAll('[data-shelf-focus]')).find(function (n) { return n.getAttribute('data-shelf-focus') === 'book:' + pending.project.id; });
      // The import response can arrive before loadProjects has rendered the new
      // book. Wait for shelf-projects-loaded instead of guessing a network delay.
      if (!card) return;
      pendingHighlight = null;
      card.closest('.shelf-book-item')?.classList.add('is-new-book');
      card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
      card.focus({ preventScroll: true });
    });
  }
  window.addEventListener('shelf-projects-loaded', highlight);
  window.addEventListener('pagehide', cancelHighlight);
  window.addEventListener('pointerdown', cancelHighlight);
  window.addEventListener('keydown', cancelHighlight);
  window.addEventListener('shelf-view-changed', function (event) { if (event.detail.view !== 'library') cancelHighlight(); });
  window.addEventListener('hashchange', function () { if (location.hash !== '#library') cancelHighlight(); });
  form.addEventListener('submit', cancelHighlight);
  function resetFeedback() {
    cancelHighlight();
    if (activeKey) retired.add(activeKey);
    activeKey = null; taskButton.hidden = true; form.dataset.launcherState = 'idle';
    workspace.dataset.phase = 'idle';
    delete form.dataset.generationStage;
  }
  form.addEventListener('reset', resetFeedback);
  window.addEventListener('shelf-import-reset', resetFeedback);
  document.querySelectorAll('[data-import-open]').forEach(function (button) { button.addEventListener('click', cancelHighlight); });
  window.addEventListener('shelf-generation-state', function (event) {
    var detail = event.detail, state = detail.state, generation = detail.generation;
    var deliveryKey = key(detail.project.id, generation.generationId);
    if (retired.has(deliveryKey)) return;
    if (previousReady.has(deliveryKey) && state !== 'ready') return;
    if (activeKey && activeKey !== deliveryKey) { retired.add(activeKey); cancelHighlight(); }
    activeKey = deliveryKey;
    form.dataset.launcherState = state;
    workspace.dataset.phase = state;
    var visualStage = state === 'ready' ? 'ready' : (state === 'generating' || state === 'failed') && ['reading', 'writing', 'compiling'].includes(generation.stage) ? generation.stage : null;
    if (visualStage) form.dataset.generationStage = visualStage;
    else delete form.dataset.generationStage;
    taskButton.hidden = state === 'ready';
    taskButton.textContent = state === 'generating' ? '正在成书 · 查看进度' : state === 'failed' ? '生成未完成 · 重试' : '项目已保存 · 继续';
    var active = state === 'ready' ? 3 : ['reading', 'writing', 'compiling'].indexOf(generation.stage);
    form.querySelectorAll('[data-generation-step]').forEach(function (step, index) {
      step.classList.toggle('is-current', index === active);
      step.classList.toggle('is-complete', index < active || state === 'ready');
      if (index === active) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
    if (state === 'generating' && document.body.dataset.pageView === 'upload') window.ShelfLanding?.showGeneration();
    if (state !== 'ready' || previousReady.has(deliveryKey)) return;
    previousReady.add(deliveryKey);
    // 恢复后首次见 ready 也可承接；已经离开生成页则只通知。
    if ((document.body.dataset.pageView === 'generate' || document.body.dataset.pageView === 'upload') && document.visibilityState === 'visible' && !document.querySelector('.shelf-opening[open]')) {
      reveal(detail.project);
    } else notify(detail.project, '“' + detail.project.name + '”已成书。');
  });
}());
