/* Davincii shared tax-form state.
   Exposed as window.Dv.tax. Depends on Dv.api.

   One source of truth for the W-9 / W-8BEN step. Fully decoupled from the
   payout method (Stripe / PayPal) — the artist completes their tax form
   once with the platform and then picks any payout rail. */
(function () {
  var Dv = window.Dv = window.Dv || {};

  /* ── Canonical UI states ─────────────────────────────────────────────
     not_started — no row, or status='not_started'
     pending     — row exists, awaiting provider completion
     completed   — signed and on file
     expired     — W-8BEN aged out (rare, only after 3 years)
  */
  var STATES = {
    NOT_STARTED: 'not_started',
    PENDING: 'pending',
    COMPLETED: 'completed',
    EXPIRED: 'expired'
  };

  function deriveState(d) {
    if (!d || !d.status) return STATES.NOT_STARTED;
    if (d.status === STATES.COMPLETED) return STATES.COMPLETED;
    if (d.status === STATES.EXPIRED) return STATES.EXPIRED;
    if (d.status === STATES.PENDING) return STATES.PENDING;
    return STATES.NOT_STARTED;
  }

  function describeState(d) {
    var state = deriveState(d);
    var formType = (d && d.form_type) || null;
    var formLabel = formType === 'w8ben' ? 'W-8BEN' : 'W-9';
    var vm = {
      state: state,
      formType: formType,
      formLabel: formLabel,
      isComplete: state === STATES.COMPLETED,
      badgeTone: 'pending',
      label: '',
      sub: '',
      desc: '',
      actionText: 'Complete tax form',
      raw: d || null
    };
    switch (state) {
      case STATES.NOT_STARTED:
        vm.badgeTone = 'error';
        vm.label = 'Not Started';
        vm.sub = 'Required so we can pay you and issue a 1099 at year-end.';
        vm.desc = 'U.S. persons complete a W-9. Non-U.S. persons complete a W-8BEN. Takes about a minute.';
        break;
      case STATES.PENDING:
        vm.badgeTone = 'pending';
        vm.label = 'In Progress';
        vm.sub = 'Finish your ' + formLabel + ' to unlock payouts.';
        vm.desc = 'Your tax form is partially filled out. Resume to finish signing.';
        vm.actionText = 'Resume tax form';
        break;
      case STATES.EXPIRED:
        vm.badgeTone = 'error';
        vm.label = 'Expired';
        vm.sub = 'Your ' + formLabel + ' has expired and must be renewed.';
        vm.desc = 'W-8BEN forms expire three years after they\u2019re signed. Please complete a new one.';
        vm.actionText = 'Renew tax form';
        break;
      case STATES.COMPLETED:
      default:
        vm.badgeTone = 'success';
        vm.label = 'Completed';
        vm.sub = 'Your tax information is complete.';
        vm.desc = 'We have your ' + formLabel + ' on file. You can update it at any time.';
        vm.actionText = 'Update tax form';
        break;
    }
    return vm;
  }

  function fetchStatus() {
    if (!Dv.api) return Promise.resolve({ status: 'not_started' });
    return Dv.api.fetch('/tax/status', { skipAuthRedirect: true })
      .catch(function () { return { status: 'not_started' }; });
  }

  function start(opts) {
    return Dv.api.fetch('/tax/start', {
      method: 'POST',
      body: JSON.stringify(opts || {}),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function manualComplete(payload) {
    return Dv.api.fetch('/tax/manual-complete', {
      method: 'POST',
      body: JSON.stringify(payload || {}),
      headers: { 'Content-Type': 'application/json' }
    });
  }

  Dv.tax = {
    STATES: STATES,
    deriveState: deriveState,
    describeState: describeState,
    fetchStatus: fetchStatus,
    start: start,
    manualComplete: manualComplete
  };
})();
