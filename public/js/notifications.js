/* Davincii shared notifications store.
   Exposed as window.Dv.notifications. Depends on Dv.format. */
(function () {
  var Dv = window.Dv = window.Dv || {};
  var KEY = 'dv_notifs';
  var MAX = 50;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; }
    catch (_) { return []; }
  }

  function save(arr) {
    try { localStorage.setItem(KEY, JSON.stringify((arr || []).slice(0, MAX))); }
    catch (_) {}
  }

  function add(title, body, icon) {
    var list = load();
    list.unshift({
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      title: title || '',
      body: body || '',
      icon: icon || 'bell',
      ts: Date.now(),
      read: false
    });
    save(list);
    return list;
  }

  function markAllRead() {
    var list = load().map(function (n) { n.read = true; return n; });
    save(list);
    return list;
  }

  function unreadCount() {
    return load().filter(function (n) { return !n.read; }).length;
  }

  // Sync every bell badge across desktop + mobile, landing + dashboard.
  // Shows the unread count; hides the badge entirely when zero (industry standard).
  function syncBadges() {
    var n = unreadCount();
    var selectors = ['.nav-bell-dot', '#notif-badge', '.m-ln-bell-dot', '.d-bell-dot'];
    selectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (n > 0) {
          el.textContent = n > 99 ? '99+' : String(n);
          el.style.display = '';
        } else {
          el.style.display = 'none';
        }
      });
    });
  }

  function render(container) {
    if (!container) return;
    var list = load();
    var fmt = (Dv.format || {});
    var esc = fmt.escapeHtml || function (s) { return String(s || ''); };
    var ago = fmt.timeAgo || function () { return ''; };
    if (!list.length) {
      container.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }
    container.innerHTML = list.map(function (n) {
      return '<div class="notif-item' + (n.read ? '' : ' unread') + '">' +
        '<div class="notif-title">' + esc(n.title) + '</div>' +
        (n.body ? '<div class="notif-body">' + esc(n.body) + '</div>' : '') +
        '<div class="notif-ts">' + esc(ago(n.ts)) + '</div>' +
      '</div>';
    }).join('');
  }

  Dv.notifications = {
    load: load,
    save: save,
    add: add,
    markAllRead: markAllRead,
    unreadCount: unreadCount,
    syncBadges: syncBadges,
    render: render
  };
})();
