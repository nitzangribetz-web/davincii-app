/* Tax-form collection API.
 *
 * Provider-agnostic by design: the platform owns W-9 / W-8BEN collection so
 * artists can pick any payout rail (Stripe, PayPal, manual) without re-doing
 * tax info. Today the only provider is "manual" — a placeholder that lets the
 * UI flip a row to pending → completed end-to-end. Tomorrow we'll plug in
 * Anvil (or DocuSign / Dropbox Sign) by adding a single startAnvilFlow()
 * function and a webhook handler — no schema change required.
 *
 * Endpoints
 *   GET  /api/tax/status            Current active tax form for the caller
 *   POST /api/tax/start             Begin a new tax form (returns redirect URL when a real provider exists; today returns { provider: 'manual' })
 *   POST /api/tax/manual-complete   Dev-only: marks the active form completed
 *   POST /api/tax/webhook/:provider Provider-specific webhook (stub)
 */

const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { Resend } = require('resend');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'info@davincii.co';

// W-8BEN expires three years after the end of the calendar year in which it
// was signed. We approximate as +3 years from completed_at; the year-end
// adjustment can be added later if it ever matters.
const W8BEN_VALID_YEARS = 3;

function defaultFormType(country) {
  // Default US persons to W-9; everyone else to W-8BEN. The artist can
  // override this when starting the flow.
  if (!country) return 'w9';
  const c = String(country).trim().toUpperCase();
  return (c === 'US' || c === 'USA' || c === 'UNITED STATES') ? 'w9' : 'w8ben';
}

function summarize(row) {
  if (!row) return { status: 'not_started', form_type: null };
  return {
    id: row.id,
    form_type: row.form_type,
    status: row.status,
    provider: row.provider,
    country: row.country,
    legal_name: row.legal_name,
    tin_last4: row.tin_last4,
    submitted_at: row.submitted_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    signed_pdf_url: row.signed_pdf_url,
  };
}

async function getActiveTaxForm(artistId) {
  const { rows } = await pool.query(
    `SELECT * FROM tax_forms
       WHERE artist_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
    [artistId]
  );
  return rows[0] || null;
}

// ── GET /api/tax/status ─────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const row = await getActiveTaxForm(req.artist.id);
    // Check expiry — W-8BENs that have aged out should report 'expired'.
    if (row && row.status === 'completed' && row.expires_at && new Date(row.expires_at) < new Date()) {
      await pool.query(
        `UPDATE tax_forms SET status = 'expired', updated_at = NOW() WHERE id = $1`,
        [row.id]
      );
      row.status = 'expired';
    }
    res.json(summarize(row));
  } catch (err) {
    console.error('[tax/status]', err);
    res.status(500).json({ error: 'Unable to load tax-form status.' });
  }
});

// ── POST /api/tax/start ─────────────────────────────────────────────────────
// Begin (or resume) a tax-form flow. Body:
//   { form_type?: 'w9'|'w8ben', country?: string }
// Today this just creates a row in 'pending' and returns a placeholder
// provider="manual". When a real provider is wired up, this is where we'd
// call e.g. anvil.fillPDF(...) and return { url: ... } for the artist to open.
router.post('/start', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const { rows: artistRows } = await pool.query(
      'SELECT address_country, name, stage_name FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = artistRows[0] || {};
    const country = (body.country || artist.address_country || '').trim() || null;
    const formType = body.form_type || defaultFormType(country);
    if (formType !== 'w9' && formType !== 'w8ben') {
      return res.status(400).json({ error: 'Unsupported form_type.' });
    }
    const legalName = (body.legal_name || artist.name || artist.stage_name || '').trim() || null;

    const existing = await getActiveTaxForm(req.artist.id);
    let row;
    if (existing && (existing.status === 'not_started' || existing.status === 'pending')) {
      // Resume existing draft.
      const { rows } = await pool.query(
        `UPDATE tax_forms
            SET form_type = $2,
                country = $3,
                legal_name = COALESCE($4, legal_name),
                status = 'pending',
                provider = COALESCE(provider, 'manual'),
                submitted_at = COALESCE(submitted_at, NOW()),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [existing.id, formType, country, legalName]
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO tax_forms
           (artist_id, form_type, status, provider, country, legal_name, submitted_at)
         VALUES ($1, $2, 'pending', 'manual', $3, $4, NOW())
         RETURNING *`,
        [req.artist.id, formType, country, legalName]
      );
      row = rows[0];
    }

    // No real provider yet — return a stub the frontend can branch on.
    res.json({
      ...summarize(row),
      provider: 'manual',
      url: null,
      message: 'Provider not yet configured. The form is in pending state; complete it via /api/tax/manual-complete or wire up Anvil.',
    });
  } catch (err) {
    console.error('[tax/start]', err);
    res.status(500).json({ error: 'Unable to start tax form.' });
  }
});

// ── POST /api/tax/manual-complete ───────────────────────────────────────────
// Marks the most-recent pending form as completed. This is the seam a future
// provider webhook will replace; for now it lets the dashboard be tested
// end-to-end without an external service. Body (all optional):
//   { tin_last4, legal_name, signed_pdf_url }
router.post('/manual-complete', auth, async (req, res) => {
  try {
    const { tin_last4, legal_name, signed_pdf_url } = req.body || {};
    const existing = await getActiveTaxForm(req.artist.id);
    if (!existing || (existing.status !== 'pending' && existing.status !== 'not_started')) {
      return res.status(400).json({ error: 'No pending tax form to complete.' });
    }
    const expiresAt = existing.form_type === 'w8ben'
      ? new Date(Date.now() + W8BEN_VALID_YEARS * 365 * 24 * 60 * 60 * 1000)
      : null;
    const { rows } = await pool.query(
      `UPDATE tax_forms
          SET status = 'completed',
              tin_last4 = COALESCE($2, tin_last4),
              legal_name = COALESCE($3, legal_name),
              signed_pdf_url = COALESCE($4, signed_pdf_url),
              completed_at = NOW(),
              expires_at = $5,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [existing.id, tin_last4 || null, legal_name || null, signed_pdf_url || null, expiresAt]
    );
    notifyAdminTaxCompleted(req.artist.id, rows[0]).catch(() => {});
    res.json(summarize(rows[0]));
  } catch (err) {
    console.error('[tax/manual-complete]', err);
    res.status(500).json({ error: 'Unable to complete tax form.' });
  }
});

// ── POST /api/tax/webhook/:provider ─────────────────────────────────────────
// Real providers will hit this. Stubbed today.
router.post('/webhook/:provider', express.json(), async (req, res) => {
  console.log('[tax/webhook] received', req.params.provider, '— stub, ignoring.');
  res.json({ received: true });
});

// ── Admin notification ──────────────────────────────────────────────────────
async function notifyAdminTaxCompleted(artistId, formRow) {
  try {
    if (!process.env.RESEND_API_KEY) return;
    const { rows } = await pool.query(
      'SELECT name, email, stage_name FROM artists WHERE id = $1',
      [artistId]
    );
    const artist = rows[0] || {};
    const displayName = artist.stage_name || artist.name || artist.email || ('Artist #' + artistId);
    const formLabel = formRow.form_type === 'w8ben' ? 'W-8BEN' : 'W-9';
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'Davincii <info@davincii.co>',
      to: ADMIN_NOTIFY_EMAIL,
      subject: `${formLabel} completed — ${displayName}`,
      html:
        '<div style="font-family:DM Sans,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.55">' +
          '<p><strong>' + displayName + '</strong> just completed their ' + formLabel + '.</p>' +
          (formRow.signed_pdf_url
            ? '<p>Signed PDF: <a href="' + formRow.signed_pdf_url + '" style="color:#3B82F6">' + formRow.signed_pdf_url + '</a></p>'
            : '<p>Provider: ' + (formRow.provider || 'manual') + ' — open the artist record in the admin panel to view details.</p>'
          ) +
          '<p style="color:#6B7280;font-size:12px;margin-top:24px">Artist ID: ' + artistId + '<br>Form ID: ' + formRow.id + '</p>' +
        '</div>'
    });
  } catch (err) {
    console.error('[tax] admin notify failed:', err.message);
  }
}

module.exports = router;
