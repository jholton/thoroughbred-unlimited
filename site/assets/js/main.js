/* Thoroughbred Unlimited — site behavior */
(function () {
  'use strict';

  /* Mobile navigation */
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('primary-nav');

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      nav.setAttribute('data-open', String(!open));
    });

    // Close the menu when a link is chosen or the viewport grows past the breakpoint.
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        toggle.setAttribute('aria-expanded', 'false');
        nav.setAttribute('data-open', 'false');
      }
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 1100) {
        toggle.setAttribute('aria-expanded', 'false');
        nav.setAttribute('data-open', 'false');
      }
    });
  }

  /* Reveal sections as they enter the viewport */
  var targets = document.querySelectorAll('.reveal');
  if (!('IntersectionObserver' in window)) {
    targets.forEach(function (el) { el.classList.add('is-visible'); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  targets.forEach(function (el, i) {
    el.style.transitionDelay = (Math.min(i % 4, 3) * 80) + 'ms';
    io.observe(el);
  });
})();
