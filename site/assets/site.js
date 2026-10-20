/* ParkBor site: mobile menu + /b/<booking id> helper. No tracking, no network calls. */
(function (root) {
  'use strict';
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isValidBookingId(s) {
    return typeof s === 'string' && UUID.test(s);
  }

  // Raw (not decoded) pathname: "/b/<uuid>" or "/b/<uuid>/". Anything else -> null.
  function bookingIdFromPath(pathname) {
    var m = /^\/b\/([^/]+)\/?$/.exec(String(pathname));
    return m && isValidBookingId(m[1]) ? m[1].toLowerCase() : null;
  }

  var api = { isValidBookingId: isValidBookingId, bookingIdFromPath: bookingIdFromPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root.document) return;

  var doc = root.document;
  doc.documentElement.classList.add('js');

  var btn = doc.querySelector('[data-menu-toggle]');
  var nav = doc.getElementById('site-nav');
  if (btn && nav) {
    btn.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('a')) {
        nav.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  var link = doc.getElementById('open-booking');
  var bad = doc.getElementById('bad-link');
  var good = doc.getElementById('good-link');
  if (link && bad && good) {
    var id = bookingIdFromPath(root.location.pathname);
    if (id) {
      link.setAttribute('href', 'parkbor://booking/' + id); // built only from the validated id
      good.hidden = false;
    } else {
      bad.hidden = false;
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
