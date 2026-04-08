/* Payout-method API.
 *
 * One row per (artist_id, method_type). The artist can configure multiple
 * rails (Stripe, PayPal) and pick which one is primary. The actual rail
 * setup still lives in routes/stripe.js and routes/paypal.js — this module
 * is the thin source of truth for "which methods exist for this artist".
 *
 * On read we also reconcile from the legacy artists.stripe_account_id /
 * artists.paypal_email columns so existing accounts show up without a manual
 * backfill.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

const SUPPORTED = new Set(['stripe', 'paypal']);

async function reconcileLegacy(artistId) {
  // Pull legacy columns and ensure they're represented in payout_methods.
  const { rows } = await pool.query(
    'SELECT stripe_account_id, stripe_onboarded, paypal_email FROM artists WHERE id = $1',
    [artistId]
  );
  const a = rows[0];
  if (!a) return;
  if (a.stripe_account_id) {
    await pool.query(
      `INSERT INTO payout_methods (artist_id, method_type, status, external_id)
       VALUES ($1, 'stripe', $2, $3)
       ON CONFLICT (artist_id, method_type)
       DO UPDATE SET status = EXCLUDED.status, external_id = EXCLUDED.external_id, updated_at = NOW()`,
      [artistId, a.stripe_onboarded ? 'connected' : 'pending', a.stripe_account_id]
    );
  }
  if (a.paypal_email) {
    await pool.query(
      `INSERT INTO payout_methods (artist_id, method_type, status, external_email)
       VALUES ($1, 'paypal', 'connected', $2)
       ON CONFLICT (artist_id, method_type)
       DO UPDATE SET external_email = EXCLUDED.external_email, status = 'connected', updated_at = NOW()`,
      [artistId, a.paypal_email]
    );
  }
}

// ── GET /api/payout-methods ─────────────────────────────────────────────────
router.get('/', auth, async (req, res) => {
  try {
    await reconcileLegacy(req.artist.id);
    const { rows } = await pool.query(
      `SELECT id, method_type, is_primary, status, external_id, external_email, metadata, created_at, updated_at
         FROM payout_methods
        WHERE artist_id = $1
        ORDER BY is_primary DESC, created_at ASC`,
      [req.artist.id]
    );
    res.json({ methods: rows });
  } catch (err) {
    console.error('[payout-methods/list]', err);
    res.status(500).json({ error: 'Unable to load payout methods.' });
  }
});

// ── POST /api/payout-methods/primary ────────────────────────────────────────
// Body: { method_type: 'stripe' | 'paypal' }
router.post('/primary', auth, async (req, res) => {
  const methodType = (req.body && req.body.method_type) || '';
  if (!SUPPORTED.has(methodType)) {
    return res.status(400).json({ error: 'Unsupported method_type.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE payout_methods SET is_primary = FALSE, updated_at = NOW() WHERE artist_id = $1',
      [req.artist.id]
    );
    const upd = await client.query(
      `UPDATE payout_methods
          SET is_primary = TRUE, updated_at = NOW()
        WHERE artist_id = $1 AND method_type = $2
        RETURNING id`,
      [req.artist.id, methodType]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'That method is not connected yet.' });
    }
    await client.query('COMMIT');
    res.json({ ok: true, primary: methodType });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[payout-methods/primary]', err);
    res.status(500).json({ error: 'Unable to set primary method.' });
  } finally {
    client.release();
  }
});

// ── DELETE /api/payout-methods/:method_type ─────────────────────────────────
router.delete('/:method_type', auth, async (req, res) => {
  const methodType = req.params.method_type;
  if (!SUPPORTED.has(methodType)) {
    return res.status(400).json({ error: 'Unsupported method_type.' });
  }
  try {
    await pool.query(
      'DELETE FROM payout_methods WHERE artist_id = $1 AND method_type = $2',
      [req.artist.id, methodType]
    );
    // Also clear the legacy columns so the frontend status reflects removal.
    if (methodType === 'stripe') {
      await pool.query(
        'UPDATE artists SET stripe_account_id = NULL, stripe_onboarded = FALSE WHERE id = $1',
        [req.artist.id]
      );
    } else if (methodType === 'paypal') {
      await pool.query(
        'UPDATE artists SET paypal_email = NULL WHERE id = $1',
        [req.artist.id]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[payout-methods/delete]', err);
    res.status(500).json({ error: 'Unable to remove payout method.' });
  }
});

module.exports = router;
