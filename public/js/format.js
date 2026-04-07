/* Davincii shared formatting + tiny DOM helpers.
   Exposed as window.Dv.format. No dependencies. */
(function () {
  var Dv = window.Dv = window.Dv || {};

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function timeAgo(ts) {
    var n = Date.now();
    var d = Math.max(0, n - Number(ts || 0));
    var s = Math.floor(d / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var days = Math.floor(h / 24);
    if (days < 7) return days + 'd ago';
    return new Date(Number(ts)).toLocaleDateString();
  }

  function formatMoney(n) {
    var v = Number(n || 0);
    return '$' + v.toFixed(2);
  }

  function formatDate(d) {
    try { return new Date(d).toLocaleDateString(); } catch (e) { return ''; }
  }

  Dv.format = {
    escapeHtml: escapeHtml,
    timeAgo: timeAgo,
    formatMoney: formatMoney,
    formatDate: formatDate
  };
})();
