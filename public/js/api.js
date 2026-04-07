/* Davincii shared API fetch wrapper.
   Exposed as window.Dv.api. Depends on nothing.

   Auth lives in an HttpOnly cookie (`dv_token`). We always send
   `credentials: 'include'` and never read tokens from localStorage. */
(function () {
  var Dv = window.Dv = window.Dv || {};

  function buildHeaders(userHeaders, hasBody) {
    var h = {};
    if (hasBody) h['Content-Type'] = 'application/json';
    if (userHeaders) {
      for (var k in userHeaders) if (Object.prototype.hasOwnProperty.call(userHeaders, k)) h[k] = userHeaders[k];
    }
    return h;
  }

  /**
   * apiFetch(path, opts)
   * - path: '/api/...' or 'api/...' or bare '/stripe/balance' (auto-prefixed with /api)
   * - opts: { method, body (object|string), headers, raw (bool), skipAuthRedirect (bool) }
   * Returns parsed JSON (or raw Response when opts.raw). Throws Error with server message on non-2xx.
   */
  function apiFetch(path, opts) {
    opts = opts || {};
    var url = path;
    if (url.charAt(0) !== '/') url = '/' + url;
    if (url.indexOf('/api/') !== 0 && url.indexOf('/api') !== 0) url = '/api' + url;

    var body = opts.body;
    var hasBody = body != null && typeof body !== 'string' && !(body instanceof FormData);
    var init = {
      method: opts.method || (body ? 'POST' : 'GET'),
      credentials: 'include',
      headers: buildHeaders(opts.headers, hasBody)
    };
    if (body != null) init.body = hasBody ? JSON.stringify(body) : body;

    return fetch(url, init).then(function (res) {
      if (opts.raw) return res;
      var isJson = (res.headers.get('content-type') || '').indexOf('application/json') !== -1;
      return (isJson ? res.json() : res.text()).then(function (data) {
        if (!res.ok) {
          // Global 401 handling — only redirect for truly unauthenticated sessions,
          // and never for auth endpoints themselves (which legitimately return 401).
          if (res.status === 401 && !opts.skipAuthRedirect && url.indexOf('/api/auth/') !== 0) {
            try { localStorage.removeItem('dv_artist'); } catch (_) {}
            if (location.pathname !== '/login' && location.pathname !== '/login.html') {
              location.replace('/login');
            }
          }
          var msg = (data && data.error) || (typeof data === 'string' && data) || ('HTTP ' + res.status);
          var err = new Error(msg);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  Dv.api = { fetch: apiFetch };
})();
