const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const APP_URL = process.env.APP_URL || 'https://davincii-app-production-89cc.up.railway.app';

// ── POST /api/stripe/connect ──────────────────────────────────────────────────
// Creates (or re-fetches) a Stripe Connect Express account and returns the
// hosted onboarding URL. The artist is redirected to Stripe to add their bank.
router.post('/connect', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.artist.id]);
    const artist = rows[0];
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    let accountId = artist.stripe_account_id;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: artist.email,
        capabilities: { transfers: { requested: true } },
        business_type: 'individual',
        metadata: { artist_id: String(req.artist.id) },
      });
      accountId = account.id;
      await pool.query(
        'UPDATE artists SET stripe_account_id = $1 WHERE id = $2',
        [accountId, req.artist.id]
      );
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}/api/stripe/connect/refresh`,
      return_url: `${APP_URL}/?stripe_connected=true`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    console.error('[stripe/connect]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stripe/connect/refresh ──────────────────────────────────────────
// Stripe calls this if the onboarding link expires. Re-generate and redirect.
router.get('/connect/refresh', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_account_id FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const accountId = rows[0]?.stripe_account_id;
    if (!accountId) return res.redirect(`${APP_URL}/?stripe_error=no_account`);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${APP_URL}/api/stripe/connect/refresh`,
      return_url: `${APP_URL}/?stripe_connected=true`,
      type: 'account_onboarding',
    });
    res.redirect(accountLink.url);
  } catch (err) {
    console.error('[stripe/refresh]', err.message);
    res.redirect(`${APP_URL}/?stripe_error=refresh_failed`);
  }
});

// ── GET /api/stripe/connect/status ───────────────────────────────────────────
// Returns current Stripe Connect state for the authenticated artist.
router.get('/connect/status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT stripe_account_id, stripe_onboarded FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = rows[0];

    if (!artist?.stripe_account_id) {
      return res.json({ connected: false, onboarded: false });
    }

    // Always refresh from Stripe for accuracy
    const account = await stripe.accounts.retrieve(artist.stripe_account_id);
    const onboarded = !!(account.details_submitted && account.charges_enabled);

    if (onboarded !== artist.stripe_onboarded) {
      await pool.query(
        'UPDATE artists SET stripe_onboarded = $1 WHERE id = $2',
        [onboarded, req.artist.id]
      );
    }

    res.json({
      connected: true,
      onboarded,
      account_id: artist.stripe_account_id,
      email: account.email,
      country: account.country,
      payouts_enabled: account.payouts_enabled,
    });
  } catch (err) {
    console.error('[stripe/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/payout ───────────────────────────────────────────────────
// Initiates an immediate Stripe transfer to the artist's connected account.
router.post('/payout', auth, async (req, res) => {
  const { amount } = req.body;
  const amountFloat = parseFloat(amount);
  if (!amountFloat || amountFloat < 10) {
    return res.status(400).json({ error: 'Minimum payout is $10.00' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT stripe_account_id, stripe_onboarded FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = rows[0];

    if (!artist?.stripe_account_id) {
      return res.status(400).json({ error: 'No Stripe account connected. Please connect your bank account first.' });
    }
    if (!artist.stripe_onboarded) {
      return res.status(400).json({ error: 'Stripe onboarding not complete. Please finish connecting your account.' });
    }

    const amountCents = Math.round(amountFloat * 100);

    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: artist.stripe_account_id,
      description: `Davincii royalty payout`,
      metadata: { artist_id: String(req.artist.id) },
    });

    const { rows: payoutRows } = await pool.query(
      `INSERT INTO payouts (artist_id, amount, method, status, stripe_transfer_id)
       VALUES ($1, $2, 'stripe', 'completed', $3) RETURNING *`,
      [req.artist.id, amountFloat, transfer.id]
    );

    res.json({ payout: payoutRows[0], transfer_id: transfer.id });
  } catch (err) {
    console.error('[stripe/payout]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/stripe/webhook ──────────────────────────────────────────────────
// Body is raw Buffer (registered before express.json() in server.js).
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('[stripe/webhook] sig verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'account.updated': {
        const account = event.data.object;
        const artistId = account.metadata?.artist_id;
        if (artistId) {
          const onboarded = !!(account.details_submitted && account.charges_enabled);
          await pool.query(
            'UPDATE artists SET stripe_onboarded = $1 WHERE id = $2',
            [onboarded, artistId]
          );
          console.log(`[stripe/webhook] account.updated artist=${artistId} onboarded=${onboarded}`);
        }
        break;
      }

      case 'transfer.created': {
        const transfer = event.data.object;
        await pool.query(
          `UPDATE payouts SET status = 'completed' WHERE stripe_transfer_id = $1`,
          [transfer.id]
        );
        console.log(`[stripe/webhook] transfer.created id=${transfer.id} amount=${transfer.amount}`);
        break;
      }

      case 'transfer.failed': {
        const transfer = event.data.object;
        await pool.query(
          `UPDATE payouts SET status = 'failed' WHERE stripe_transfer_id = $1`,
          [transfer.id]
        );
        console.log(`[stripe/webhook] transfer.failed id=${transfer.id}`);
        break;
      }

      default:
        console.log(`[stripe/webhook] unhandled event: ${event.type}`);
    }
  } catch (err) {
    console.error('[stripe/webhook] handler error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
