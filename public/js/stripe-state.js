/* Davincii shared Stripe/payout state.
   Exposed as window.Dv.stripe. Depends on Dv.api.

   One source of truth for mapping /api/stripe/connect/status output into
   a small set of UI states. Both desktop and mobile renderers are thin
   wrappers over the view-model returned by describeState(). */
(function () {
  var Dv = window.Dv = window.Dv || {};

  /* ── Canonical UI state labels ───────────────────────────────────────
     not_connected        — no Stripe account on file
     connected_incomplete — account exists, onboarding not finished
     connected_ready      — fully onboarded, charges + payouts enabled
     restricted           — Stripe flagged account / requirements_due present
     payout_disabled      — onboarded + charges enabled, but payouts off
                            (edge case: Stripe disabled payouts only)
  */
  var STATES = {
    NOT_CONNECTED: 'not_connected',
    CONNECTED_INCOMPLETE: 'connected_incomplete',
    CONNECTED_READY: 'connected_ready',
    RESTRICTED: 'restricted',
    PAYOUT_DISABLED: 'payout_disabled'
  };

  /**
   * deriveState(statusPayload)
   * Maps the raw /api/stripe/connect/status response into one canonical state.
   * Accepts null/undefined/error payloads → returns NOT_CONNECTED.
   */
  function deriveState(d) {
    if (!d || !d.connected) return STATES.NOT_CONNECTED;
    if (!d.details_submitted) return STATES.CONNECTED_INCOMPLETE;

    var reqs = Array.isArray(d.requirements_due) ? d.requirements_due : [];
    if (reqs.length > 0) return STATES.RESTRICTED;
    if (!d.charges_enabled) return STATES.RESTRICTED;

    if (!d.payouts_enabled) return STATES.PAYOUT_DISABLED;
    return STATES.CONNECTED_READY;
  }

  /**
   * describeState(statusPayload)
   * Returns a full view-model that UI code can bind to without any
   * conditional logic of its own:
   *   {
   *     state, isConnected, canWithdraw,
   *     badgeTone ('error'|'pending'|'success'),
   *     label, sub, desc,
   *     actionText (string|null), showAction (bool),
   *     requirements (string[])
   *   }
   */
  function describeState(d) {
    var state = deriveState(d);
    var reqs = (d && Array.isArray(d.requirements_due)) ? d.requirements_due.slice(0, 6) : [];

    var vm = {
      state: state,
      isConnected: state !== STATES.NOT_CONNECTED,
      canWithdraw: state === STATES.CONNECTED_READY,
      badgeTone: 'pending',
      label: '',
      sub: '',
      desc: '',
      actionText: null,
      showAction: true,
      requirements: reqs
    };

    switch (state) {
      case STATES.NOT_CONNECTED:
        vm.badgeTone = 'error';
        vm.label = 'Not connected';
        vm.sub = 'Connect Stripe to receive royalty payouts.';
        vm.desc = 'You haven\u2019t connected a payout account yet. Connect Stripe to receive your royalties by direct deposit.';
        vm.actionText = 'Connect payout account';
        break;

      case STATES.CONNECTED_INCOMPLETE:
        vm.badgeTone = 'pending';
        vm.label = 'Setup incomplete';
        vm.sub = 'Finish your Stripe onboarding to enable payouts.';
        vm.desc = 'Your Stripe account was created but onboarding isn\u2019t finished. Complete the remaining steps to unlock payouts.';
        vm.actionText = 'Continue Stripe setup';
        break;

      case STATES.RESTRICTED:
        vm.badgeTone = 'pending';
        vm.label = 'Under review';
        vm.sub = 'Stripe needs more information before payouts can be enabled.';
        vm.desc = 'Stripe is reviewing your account or has requested additional information. Once resolved, payouts will be enabled automatically.';
        vm.actionText = 'Update Stripe details';
        break;

      case STATES.PAYOUT_DISABLED:
        vm.badgeTone = 'pending';
        vm.label = 'Payouts disabled';
        vm.sub = 'Your account is connected, but payouts are currently disabled.';
        vm.desc = 'Stripe has temporarily disabled payouts for your account. Check your Stripe dashboard or update your details to re-enable.';
        vm.actionText = 'Open Stripe details';
        break;

      case STATES.CONNECTED_READY:
      default:
        vm.badgeTone = 'success';
        vm.label = 'Ready for payouts';
        vm.sub = 'Your Stripe account is connected and ready.';
        vm.desc = 'Your payout account is verified and ready to receive royalties. Use the Withdraw button above to initiate a payout.';
        vm.actionText = null;
        vm.showAction = false;
        break;
    }
    return vm;
  }

  /** Fetch current Stripe status. Resolves to a raw payload (or { connected:false } on error). */
  function fetchStatus() {
    if (!Dv.api) return Promise.resolve({ connected: false });
    return Dv.api.fetch('/stripe/connect/status', { skipAuthRedirect: true })
      .catch(function () { return { connected: false }; });
  }

  /** Start Stripe Connect onboarding. Resolves with { url } or throws. */
  function startConnect() {
    return Dv.api.fetch('/stripe/connect', { method: 'POST' });
  }

  /** Fetch available balance. Resolves to { total_royalties, total_paid, available }. */
  function fetchBalance() {
    return Dv.api.fetch('/stripe/balance', { skipAuthRedirect: true })
      .catch(function () { return { total_royalties: '0.00', total_paid: '0.00', available: '0.00' }; });
  }

  Dv.stripe = {
    STATES: STATES,
    deriveState: deriveState,
    describeState: describeState,
    fetchStatus: fetchStatus,
    startConnect: startConnect,
    fetchBalance: fetchBalance
  };
})();
