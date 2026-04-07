const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// ── PayPal Payouts API integration ──────────────────────────────────────────
// PayPal is offered as an additive payout destination alongside Stripe Connect.
// Stripe Connect remains the source of tax identity / W-9 (details_submitted),
// so a PayPal artist must still complete Stripe onboarding before withdrawing.

const PAYPAL_MODE = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const PAYPAL_BASE = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Cache the OAuth access token between requests. PayPal tokens typically live
// ~9h; we refresh a minute early to avoid boundary failures.
let _tokenCache = { token: null, expiresAt: 0 };

async function getPayPalAccessToken() {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 60_000) {
    return _tokenCache.token;
  }
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('PayPal is not configured on the server (missing client id/secret).');
  }
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PayPal OAuth failed: ${res.status} ${text}`);
  }
  const data = await res.json();
  _tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
  return _tokenCache.token;
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// ── POST /api/paypal/connect ────────────────────────────────────────────────
// Stores the artist's PayPal email as their payout destination. We don't run
// an OAuth handshake — Payouts API sends money to any valid PayPal email
// server-to-server using platform credentials.
router.post('/connect', auth, async (req, res) => {
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid PayPal email address.' });
  }
  try {
    await pool.query(
      'UPDATE artists SET paypal_email = $1 WHERE id = $2',
      [email, req.artist.id]
    );
    res.json({ connected: true, email });
  } catch (err) {
    console.error('[paypal/connect]', err);
    res.status(500).json({ error: 'Unable to save PayPal email. Please try again.' });
  }
});

// ── GET /api/paypal/status ──────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT paypal_email FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const email = rows[0]?.paypal_email || null;
    res.json({ connected: !!email, email });
  } catch (err) {
    console.error('[paypal/status]', err);
    res.status(500).json({ error: 'Unable to load PayPal status. Please try again.' });
  }
});

// ── DELETE /api/paypal/connect ──────────────────────────────────────────────
router.delete('/connect', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE artists SET paypal_email = NULL WHERE id = $1',
      [req.artist.id]
    );
    res.json({ disconnected: true });
  } catch (err) {
    console.error('[paypal/disconnect]', err);
    res.status(500).json({ error: 'Unable to disconnect PayPal. Please try again.' });
  }
});

// ── POST /api/paypal/payout ─────────────────────────────────────────────────
// Creates a single-item payout batch to the artist's saved PayPal email.
// W-9 gate: requires Stripe Connect details_submitted (tax identity on file).
router.post('/payout', auth, async (req, res) => {
  const amountFloat = parseFloat(req.body && req.body.amount);
  if (!amountFloat || amountFloat < 10) {
    return res.status(400).json({ error: 'Minimum payout is $10.00' });
  }

  try {
    const { rows } = await pool.query(
      'SELECT paypal_email, stripe_onboarded FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = rows[0];
    if (!artist?.paypal_email) {
      return res.status(400).json({ error: 'No PayPal account connected. Please connect PayPal first.' });
    }
    if (!artist.stripe_onboarded) {
      return res.status(400).json({ error: 'Please complete your W-9 / tax identity via Stripe before withdrawing.' });
    }

    // Balance check (same accounting source as Stripe payouts)
    const [royResult, payResult] = await Promise.all([
      pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM royalties WHERE artist_id = $1',
        [req.artist.id]
      ),
      pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE artist_id = $1 AND status = 'completed'",
        [req.artist.id]
      ),
    ]);
    const available = parseFloat(royResult.rows[0].total) - parseFloat(payResult.rows[0].total);
    if (amountFloat > available) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${Math.max(0, available).toFixed(2)}`,
      });
    }

    const token = await getPayPalAccessToken();

    // sender_batch_id must be unique per batch — include artist, amount, day
    // so double-click retries collapse into one payout.
    const senderBatchId =
      `dv-${req.artist.id}-${Math.round(amountFloat * 100)}-${new Date().toISOString().slice(0, 10)}`;

    const body = {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: 'You have a royalty payout from Davincii',
        email_message: 'Your Davincii royalties have been sent to your PayPal account.',
      },
      items: [
        {
          recipient_type: 'EMAIL',
          amount: { value: amountFloat.toFixed(2), currency: 'USD' },
          receiver: artist.paypal_email,
          note: 'Davincii royalty payout',
          sender_item_id: `artist-${req.artist.id}-${Date.now()}`,
        },
      ],
    };

    const ppRes = await fetch(`${PAYPAL_BASE}/v1/payments/payouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': senderBatchId, // idempotency
      },
      body: JSON.stringify(body),
    });
    const ppData = await ppRes.json().catch(() => ({}));

    if (!ppRes.ok) {
      console.error('[paypal/payout] PayPal API error', ppRes.status, ppData);
      const msg = (ppData && (ppData.message || ppData.name)) || 'PayPal rejected the payout.';
      return res.status(502).json({ error: `PayPal: ${msg}` });
    }

    const batchId =
      ppData.batch_header?.payout_batch_id ||
      ppData.batch_header?.sender_batch_id ||
      null;
    // Payouts are created asynchronously — initial state is PENDING/PROCESSING.
    // The webhook updates status to completed/failed once PayPal finishes.
    const { rows: payoutRows } = await pool.query(
      `INSERT INTO payouts (artist_id, amount, method, status, paypal_batch_id)
       VALUES ($1, $2, 'paypal', 'pending', $3) RETURNING *`,
      [req.artist.id, amountFloat, batchId]
    );

    res.json({ payout: payoutRows[0], batch_id: batchId });
  } catch (err) {
    console.error('[paypal/payout]', err);
    res.status(500).json({ error: (err && err.message) || 'Unable to process PayPal payout. Please try again.' });
  }
});

// ── POST /api/paypal/webhook ────────────────────────────────────────────────
// Updates payout status when PayPal finishes processing a payout item.
// NOTE: signature verification requires PAYPAL_WEBHOOK_ID — if not set, we
// accept unverified events only in sandbox mode and log a warning.
router.post('/webhook', express.json({ type: '*/*' }), async (req, res) => {
  const event = req.body || {};
  const eventType = event.event_type || '';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;

  // Verify webhook signature when configured. We skip in sandbox if not set
  // so local/dev installs don't break, but log loudly.
  if (webhookId) {
    try {
      const token = await getPayPalAccessToken();
      const verifyRes = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          auth_algo: req.headers['paypal-auth-algo'],
          cert_url: req.headers['paypal-cert-url'],
          transmission_id: req.headers['paypal-transmission-id'],
          transmission_sig: req.headers['paypal-transmission-sig'],
          transmission_time: req.headers['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: event,
        }),
      });
      const verifyData = await verifyRes.json().catch(() => ({}));
      if (verifyData.verification_status !== 'SUCCESS') {
        console.error('[paypal/webhook] signature verification failed', verifyData);
        return res.status(400).send('invalid signature');
      }
    } catch (e) {
      console.error('[paypal/webhook] verify error', e.message);
      return res.status(400).send('verify error');
    }
  } else {
    console.warn('[paypal/webhook] PAYPAL_WEBHOOK_ID not set — accepting unverified event');
  }

  try {
    const resource = event.resource || {};
    const batchId =
      resource.payout_batch_id ||
      resource.payout_item?.payout_batch_id ||
      resource.batch_header?.payout_batch_id ||
      null;

    const statusMap = {
      'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'completed',
      'PAYMENT.PAYOUTSBATCH.SUCCESS':    'completed',
      'PAYMENT.PAYOUTSBATCH.PROCESSING': 'pending',
      'PAYMENT.PAYOUTS-ITEM.FAILED':     'failed',
      'PAYMENT.PAYOUTS-ITEM.DENIED':     'failed',
      'PAYMENT.PAYOUTS-ITEM.BLOCKED':    'failed',
      'PAYMENT.PAYOUTS-ITEM.REFUNDED':   'reversed',
      'PAYMENT.PAYOUTS-ITEM.RETURNED':   'reversed',
      'PAYMENT.PAYOUTS-ITEM.CANCELED':   'failed',
      'PAYMENT.PAYOUTSBATCH.DENIED':     'failed',
    };
    const newStatus = statusMap[eventType];
    if (newStatus && batchId) {
      await pool.query(
        `UPDATE payouts SET status = $1 WHERE paypal_batch_id = $2`,
        [newStatus, batchId]
      );
      console.log(`[paypal/webhook] ${eventType} batch=${batchId} -> ${newStatus}`);
    } else {
      console.log(`[paypal/webhook] unhandled event: ${eventType}`);
    }
  } catch (err) {
    console.error('[paypal/webhook] handler error:', err.message);
  }

  res.json({ received: true });
});

module.exports = router;
