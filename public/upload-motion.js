/* A paper surface connects the landing book to the full-page workspace. */
(function () {
  'use strict';
  var running = [], layers = [], epoch = 0, deadline;
  function reduced() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  function cancel() {
    epoch++;
    clearTimeout(deadline);
    running.forEach(function (animation) { animation.cancel(); }); running = [];
    layers.forEach(function (node) { node.remove(); }); layers = [];
    delete document.body.dataset.workspaceMotion;
  }
  function play(node, frames, options) {
    if (!node || !node.animate) return null;
    var animation = node.animate(frames, Object.assign({ fill: 'both', easing: 'cubic-bezier(.22,1,.36,1)' }, options));
    running.push(animation); return animation;
  }
  function capture(from, trigger) {
    var hero = document.querySelector('.landing-hero-book'), rect = hero && hero.getBoundingClientRect();
    var visibleHero = from && from.matches('[data-landing]') && rect && rect.top >= 0 && rect.bottom <= window.innerHeight;
    var origin = visibleHero ? rect : trigger && trigger.getBoundingClientRect();
    var copy = from && from.cloneNode(true);
    if (copy) {
      var bounds = from.getBoundingClientRect();
      copy.hidden = false; copy.inert = true; copy.setAttribute('aria-hidden', 'true');
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
      copy.querySelectorAll('input,button,a,select').forEach(function (node) { node.setAttribute('tabindex', '-1'); });
      Object.assign(copy.style, { position: 'fixed', top: bounds.top + 'px', left: bounds.left + 'px', width: bounds.width + 'px', margin: '0', zIndex: '19', pointerEvents: 'none' });
    }
    return { copy: copy, origin: origin && { left: origin.left, top: origin.top, width: origin.width, height: origin.height }, isBook: visibleHero };
  }
  function run(mode, snapshot, target, done) {
    cancel();
    var token = epoch, duration = reduced() ? 140 : mode === 'enter' ? 950 : 350;
    document.body.dataset.workspaceMotion = mode;
    var sentinel;
    if (reduced()) {
      sentinel = play(target, [{ opacity: 0 }, { opacity: 1 }], { duration: duration });
    } else {
      if (snapshot && snapshot.copy) {
        layers.push(snapshot.copy); document.body.appendChild(snapshot.copy);
        play(snapshot.copy, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(' + (mode === 'enter' ? '-30' : '18') + 'px)' }], { duration: mode === 'enter' ? 250 : 200 });
      }
      var paper = document.createElement('div'); paper.className = 'upload-page-turn';
      paper.setAttribute('aria-hidden', 'true'); paper.inert = true;
      layers.push(paper); document.body.appendChild(paper);
      var origin = snapshot && snapshot.origin || { left: window.innerWidth / 2, top: 120, width: 220, height: 96 };
      var small = 'translate(' + origin.left + 'px,' + origin.top + 'px) rotate(' + (snapshot && snapshot.isBook ? '6' : '-3') + 'deg) scale(' + Math.max(.04, origin.width / window.innerWidth) + ',' + Math.max(.06, origin.height / window.innerHeight) + ')';
      var large = 'translate(0,0) rotate(0deg) scale(1,1)';
      sentinel = play(paper, mode === 'enter' ? [
        { transform: small, opacity: 1, offset: 0 },
        { transform: large, opacity: 1, offset: .48 },
        { transform: large, opacity: 0, offset: .72 },
        { transform: large, opacity: 0, offset: 1 },
      ] : [{ transform: large, opacity: .7 }, { transform: small, opacity: 0 }], { duration: duration, easing: 'cubic-bezier(.65,0,.2,1)' });
      if (mode === 'enter') {
        var groups = Array.from(target.querySelectorAll('[data-workspace-reveal]')).filter(function (node) { return !node.closest('[hidden]'); });
        var storyIndex = 0, fieldIndex = 0;
        groups.forEach(function (node) {
          var delay = node.closest('.upload-story') ? 300 + storyIndex++ * 70 : 370 + Math.min(fieldIndex++, 4) * 70;
          var base = window.getComputedStyle(node).transform;
          base = base === 'none' ? '' : ' ' + base;
          play(node, [{ opacity: 0, transform: 'translateY(24px)' + base }, { opacity: 1, transform: 'translateY(0)' + base }], { duration: 300, delay: delay });
        });
      } else play(target, [{ opacity: .1, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, delay: 50 });
    }
    function finish() {
      if (token !== epoch) return;
      cancel(); if (done) done();
    }
    if (sentinel) {
      sentinel.finished.then(finish, function () {});
      // A suspended compositor must not leave the working page transparent.
      deadline = setTimeout(finish, duration + 80);
    }
    else finish();
  }
  window.addEventListener('pagehide', cancel);
  window.ShelfUploadMotion = { capture: capture, run: run, cancel: cancel };
}());
