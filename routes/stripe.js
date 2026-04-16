const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey && stripeKey.startsWith('sk_') ? require('stripe')(stripeKey) : null;
const { Resend } = require('resend');
const APP_URL = process.env.APP_URL || 'https://davincii-app.onrender.com';
const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'info@davincii.co';

// Fire-and-forget admin email when an artist completes Stripe Connect
// onboarding (which includes the W-9 / tax identity collection). We
// intentionally do NOT include any tax details — the email only links to the
// Stripe dashboard where the connected account can be inspected.
async function notifyAdminW9Completed({ artistId, accountId }) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const { rows } = await pool.query(
      'SELECT name, email, stage_name FROM artists WHERE id = $1',
      [artistId]
    );
    const artist = rows[0] || {};
    const displayName = artist.stage_name || artist.name || artist.email || ('Artist #' + artistId);
    const isLive = String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live_');
    const dashUrl = 'https://dashboard.stripe.com/' + (isLive ? '' : 'test/') + 'connect/accounts/' + accountId;
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Davincii <info@davincii.co>',
      to: ADMIN_NOTIFY_EMAIL,
      subject: 'W-9 completed — ' + displayName,
      html:
        '<div style="font-family:DM Sans,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.55">' +
          '<p><strong>' + displayName + '</strong> just completed their W-9 / tax identity through Stripe Connect.</p>' +
          '<p>View the connected account in Stripe to extract the W-9 information:</p>' +
          '<p><a href="' + dashUrl + '" style="color:#3B82F6">' + dashUrl + '</a></p>' +
          '<p style="color:#6B7280;font-size:12px;margin-top:24px">Artist ID: ' + artistId + '<br>Stripe account: ' + accountId + '</p>' +
        '</div>'
    });
    console.log('[stripe/webhook] admin W-9 notification sent for artist=' + artistId);
  } catch (err) {
    console.error('[stripe/webhook] admin W-9 notify failed:', err.message);
  }
}

// ── Stripe refresh token helpers ──────────────────────────────────────────────
// The Stripe onboarding refresh_url is opened by Stripe as a top-level browser
// navigation that may not carry our auth cookie (different browser, expired
// session, SameSite restrictions on some flows). To avoid relying on the
// user's session at that moment, we embed a short signed token in the
// refresh URL that binds it to a specific Stripe account id.
function signStripeRefreshToken(stripeAccountId, artistId) {
  return jwt.sign(
    { purpose: 'stripe_refresh', sa: stripeAccountId, aid: artistId },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );
}
function verifyStripeRefreshToken(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.purpose !== 'stripe_refresh' || !decoded.sa || !decoded.aid) return null;
    return { stripeAccountId: decoded.sa, artistId: decoded.aid };
  } catch (e) {
    return null;
  }
}
function buildRefreshUrl(stripeAccountId, artistId) {
  const sid = signStripeRefreshToken(stripeAccountId, artistId);
  return `${APP_URL}/api/stripe/connect/refresh?sid=${encodeURIComponent(sid)}`;
}

// ── POST /api/stripe/connect ──────────────────────────────────────────────────
// Creates (or re-fetches) a Stripe Connect Express account and returns the
// hosted onboarding URL. The artist is redirected to Stripe to add their bank.
async function createStripeAccountForArtist(artist) {
  return stripe.accounts.create({
    type: 'express',
    email: artist.email,
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
    business_type: 'individual',
    metadata: { artist_id: String(artist.id) },
  });
}

router.post('/connect', auth, async (req, res) => {
  // Fast-fail if the platform isn't configured. Without this, Stripe SDK
  // throws a generic "Invalid API Key" 401 that the catch block masks.
  if (!process.env.STRIPE_SECRET_KEY) {
    console.error('[stripe/connect] STRIPE_SECRET_KEY is not set on the server');
    return res.status(500).json({
      error: 'Stripe is not configured on the server. Please contact support.',
      code: 'stripe_not_configured',
    });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM artists WHERE id = $1', [req.artist.id]);
    const artist = rows[0];
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    let accountId = artist.stripe_account_id;

    // If we don't have an account on file, create one.
    if (!accountId) {
      const account = await createStripeAccountForArtist(artist);
      accountId = account.id;
      await pool.query(
        'UPDATE artists SET stripe_account_id = $1 WHERE id = $2',
        [accountId, req.artist.id]
      );
    }

    // Try to create the onboarding link. If the stored stripe_account_id is
    // stale (deleted account, mode mismatch between test/live keys, etc.),
    // Stripe returns `resource_missing`. Recover by clearing the stale id,
    // creating a fresh account, and retrying once.
    let accountLink;
    try {
      accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: buildRefreshUrl(accountId, req.artist.id),
        return_url: `${APP_URL}/?stripe_connected=true`,
        type: 'account_onboarding',
        // Ask Stripe to collect ALL eventually-required fields during the first
        // onboarding pass — this includes US tax identity (SSN/EIN/legal name)
        // so Davincii never has to handle W-9 data itself.
        collection_options: { fields: 'eventually_due' },
      });
    } catch (linkErr) {
      const isStale = linkErr && (linkErr.code === 'resource_missing' || linkErr.type === 'StripeInvalidRequestError');
      if (!isStale) throw linkErr;
      console.warn('[stripe/connect] stale stripe_account_id, recreating:', accountId, linkErr.message);
      const fresh = await createStripeAccountForArtist(artist);
      accountId = fresh.id;
      await pool.query(
        'UPDATE artists SET stripe_account_id = $1 WHERE id = $2',
        [accountId, req.artist.id]
      );
      accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: buildRefreshUrl(accountId, req.artist.id),
        return_url: `${APP_URL}/?stripe_connected=true`,
        type: 'account_onboarding',
        collection_options: { fields: 'eventually_due' },
      });
    }

    res.json({ url: accountLink.url, account_id: accountId });
  } catch (err) {
    // Log the full Stripe error server-side and surface a sanitized version
    // (type/code/message — never the secret) so the client can show something
    // actionable instead of a generic "try again".
    console.error('[stripe/connect] FAILED', {
      type: err && err.type,
      code: err && err.code,
      message: err && err.message,
      requestId: err && err.requestId,
      statusCode: err && err.statusCode,
    });
    res.status(500).json({
      error: (err && err.message) || 'Unable to start Stripe onboarding. Please try again.',
      code: (err && err.code) || 'stripe_unknown',
      type: (err && err.type) || null,
      requestId: (err && err.requestId) || null,
    });
  }
});

// ── GET /api/stripe/connect/refresh ──────────────────────────────────────────
// Stripe opens this URL as a top-level browser navigation if the onboarding
// link expires. It does NOT go through the auth middleware, because the user
// may not have a valid session cookie at that moment (different browser,
// cookie cleared, SameSite redirect, etc.). Instead the URL carries a signed
// `sid` token that binds it to a specific Stripe account id; we verify the
// signature and then re-issue an account link.
router.get('/connect/refresh', async (req, res) => {
  try {
    // Primary path: verify the signed sid token embedded in the URL.
    let stripeAccountId = null;
    let artistId = null;
    if (req.query.sid) {
      const decoded = verifyStripeRefreshToken(String(req.query.sid));
      if (decoded) {
        stripeAccountId = decoded.stripeAccountId;
        artistId = decoded.artistId;
      }
    }

    // Fallback path: if no (or invalid) sid, try to resolve the artist from
    // their current session cookie / Bearer header. This keeps older links
    // working for logged-in users.
    if (!stripeAccountId) {
      const fallbackToken =
        (req.cookies && req.cookies.dv_token) ||
        (req.headers['authorization'] || '').split(' ')[1];
      if (fallbackToken && fallbackToken !== 'null' && fallbackToken !== 'undefined') {
        try {
          const decoded = jwt.verify(fallbackToken, process.env.JWT_SECRET);
          if (decoded && decoded.id) {
            const { rows } = await pool.query(
              'SELECT stripe_account_id FROM artists WHERE id = $1',
              [decoded.id]
            );
            if (rows[0]?.stripe_account_id) {
              stripeAccountId = rows[0].stripe_account_id;
              artistId = decoded.id;
            }
          }
        } catch (_) { /* invalid token — fall through */ }
      }
    }

    if (!stripeAccountId || !artistId) {
      // No way to identify the artist — send them to the payouts page so
      // they can re-initiate the Connect flow from a logged-in context.
      return res.redirect(`${APP_URL}/dashboard/payouts?stripe_error=refresh_unauthorized`);
    }

    // Defense in depth: confirm the DB row matches BOTH the stripe account id
    // AND the artist id claimed in the token. This prevents a stolen/leaked
    // sid from being reused if the Stripe account was since disconnected or
    // re-assigned.
    const { rows } = await pool.query(
      'SELECT id FROM artists WHERE id = $1 AND stripe_account_id = $2',
      [artistId, stripeAccountId]
    );
    if (rows.length === 0) {
      return res.redirect(`${APP_URL}/dashboard/payouts?stripe_error=no_account`);
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: buildRefreshUrl(stripeAccountId, artistId),
      return_url: `${APP_URL}/?stripe_connected=true`,
      type: 'account_onboarding',
      // Ask Stripe to collect ALL eventually-required fields during the first
      // onboarding pass — this includes US tax identity (SSN/EIN/legal name)
      // so Davincii never has to handle W-9 data itself.
      collection_options: { fields: 'eventually_due' },
    });
    res.redirect(accountLink.url);
  } catch (err) {
    console.error('[stripe/refresh]', err);
    res.redirect(`${APP_URL}/dashboard/payouts?stripe_error=refresh_failed`);
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
      details_submitted: account.details_submitted,
      charges_enabled: account.charges_enabled,
      requirements_due: (account.requirements && account.requirements.currently_due) || [],
    });
  } catch (err) {
    console.error('[stripe/status]', err);
    res.status(500).json({ error: 'Unable to load Stripe status. Please try again.' });
  }
});

// ── GET /api/stripe/balance ───────────────────────────────────────────────────
// Returns the artist's available balance: total royalties minus completed payouts.
router.get('/balance', auth, async (req, res) => {
  try {
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
    const totalRoyalties = parseFloat(royResult.rows[0].total);
    const totalPaid = parseFloat(payResult.rows[0].total);
    const available = Math.max(0, totalRoyalties - totalPaid);
    res.json({
      total_royalties: totalRoyalties.toFixed(2),
      total_paid: totalPaid.toFixed(2),
      available: available.toFixed(2),
    });
  } catch (err) {
    console.error('[stripe/balance]', err);
    res.status(500).json({ error: 'Unable to load balance. Please try again.' });
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

    // ── Balance check ──────────────────────────────────────────────────────────
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

    const amountCents = Math.round(amountFloat * 100);

    // Idempotency key: artist + amount + date (UTC day) ensures one payout
    // per artist per amount per day; prevents duplicate transfers on retry
    const idempotencyKey = `payout-${req.artist.id}-${amountCents}-${new Date().toISOString().slice(0, 10)}`;

    const transfer = await stripe.transfers.create(
      {
        amount: amountCents,
        currency: 'usd',
        destination: artist.stripe_account_id,
        description: `Davincii royalty payout`,
        metadata: { artist_id: String(req.artist.id) },
      },
      { idempotencyKey }
    );

    const { rows: payoutRows } = await pool.query(
      `INSERT INTO payouts (artist_id, amount, method, status, stripe_transfer_id)
       VALUES ($1, $2, 'stripe', 'completed', $3) RETURNING *`,
      [req.artist.id, amountFloat, transfer.id]
    );

    res.json({ payout: payoutRows[0], transfer_id: transfer.id });
  } catch (err) {
    console.error('[stripe/payout]', err);
    res.status(500).json({ error: 'Unable to process payout. Please try again.' });
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
          // Detect false→true transition so the admin email only fires once.
          const prev = await pool.query(
            'SELECT stripe_onboarded FROM artists WHERE id = $1',
            [artistId]
          );
          const wasOnboarded = !!(prev.rows[0] && prev.rows[0].stripe_onboarded);
          await pool.query(
            'UPDATE artists SET stripe_onboarded = $1 WHERE id = $2',
            [onboarded, artistId]
          );
          console.log(`[stripe/webhook] account.updated artist=${artistId} onboarded=${onboarded}`);
          // Tax identity is collected during details_submitted; notify admin
          // the first time this flips on, regardless of charges_enabled.
          if (account.details_submitted && !wasOnboarded) {
            notifyAdminW9Completed({ artistId, accountId: account.id });
          }
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

      case 'transfer.reversed': {
        const transfer = event.data.object;
        await pool.query(
          `UPDATE payouts SET status = 'reversed' WHERE stripe_transfer_id = $1`,
          [transfer.id]
        );
        console.log(`[stripe/webhook] transfer.reversed id=${transfer.id}`);
        break;
      }

      case 'account.application.deauthorized': {
        // Artist revoked Stripe access — clear their account link in our DB
        const account = event.data.object;
        await pool.query(
          'UPDATE artists SET stripe_account_id = NULL, stripe_onboarded = FALSE WHERE stripe_account_id = $1',
          [account.id]
        );
        console.log(`[stripe/webhook] account.application.deauthorized account=${account.id}`);
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

// ── DELETE /api/stripe/connect ────────────────────────────────────────────────
// Removes the artist's Stripe account link from Davincii (does not delete the
// Stripe account itself — the artist retains their Stripe Express account).
router.delete('/connect', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE artists SET stripe_account_id = NULL, stripe_onboarded = FALSE WHERE id = $1',
      [req.artist.id]
    );
    res.json({ disconnected: true });
  } catch (err) {
    console.error('[stripe/disconnect]', err);
    res.status(500).json({ error: 'Unable to disconnect Stripe account. Please try again.' });
  }
});

module.exports = router;
