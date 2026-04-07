/* Davincii shared auth/session helpers.
   Exposed as window.Dv.auth. Depends on Dv.api. */
(function () {
  var Dv = window.Dv = window.Dv || {};
  var ARTIST_KEY = 'dv_artist';
  // Auth token lives in an HttpOnly cookie; we never read/write it from JS.

  function getStoredArtist() {
    try { return JSON.parse(localStorage.getItem(ARTIST_KEY) || 'null'); }
    catch (_) { return null; }
  }

  // Wipe all per-user UI state (Get Started completion flags, etc.) so a
  // new account signing in on the same browser doesn't inherit the previous
  // user's "already done" markers.
  function clearPerUserState() {
    try {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('dv_setup_') === 0 || k === 'dv_just_signed_up')) {
          toRemove.push(k);
        }
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
    } catch (_) {}
  }

  function setStoredArtist(artist) {
    try {
      var prev = null;
      try { prev = JSON.parse(localStorage.getItem(ARTIST_KEY) || 'null'); } catch (_) {}
      if (artist && artist.id && (!prev || !prev.id || prev.id !== artist.id)) {
        clearPerUserState();
      }
      localStorage.setItem(ARTIST_KEY, JSON.stringify(artist || {}));
    } catch (_) {}
  }

  function clearStoredArtist() {
    try { localStorage.removeItem(ARTIST_KEY); } catch (_) {}
    clearPerUserState();
  }

  /** Fetch current artist from /api/auth/me. Resolves null on failure. */
  function loadCurrentArtist() {
    if (!Dv.api) return Promise.resolve(null);
    return Dv.api.fetch('/auth/me', { skipAuthRedirect: true })
      .then(function (data) {
        var artist = (data && data.artist) || data;
        if (artist && artist.id) {
          setStoredArtist(artist);
          return artist;
        }
        return null;
      })
      .catch(function () { return null; });
  }

  function logout() {
    var done = function () {
      clearStoredArtist();
      location.replace('/login');
    };
    if (Dv.api) {
      Dv.api.fetch('/auth/logout', { method: 'POST', skipAuthRedirect: true })
        .then(done, done);
    } else {
      done();
    }
  }

  /** Populate every element in the page that declares a shared artist binding. */
  function applyArtistToDOM(artist) {
    if (!artist) return;
    var name = artist.artist_name || artist.name || artist.email || '';
    var email = artist.email || '';
    var pro = artist.pro || '';
    var initials = (name || email).trim().charAt(0).toUpperCase() || '•';

    var set = function (sel, val) {
      var nodes = document.querySelectorAll(sel);
      for (var i = 0; i < nodes.length; i++) nodes[i].textContent = val;
    };
    set('.artist-display-name', name);
    set('.artist-email', email);
    set('.artist-pro', pro || '—');
    set('.artist-initials', initials);
  }

  Dv.auth = {
    getStoredArtist: getStoredArtist,
    setStoredArtist: setStoredArtist,
    clearStoredArtist: clearStoredArtist,
    loadCurrentArtist: loadCurrentArtist,
    logout: logout,
    applyArtistToDOM: applyArtistToDOM
  };
})();
