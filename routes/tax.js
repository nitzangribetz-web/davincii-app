/* Tax-form collection API.
 *
 * Provider-agnostic by design: the platform owns W-9 / W-8BEN collection so
 * artists can pick any payout rail (Stripe, PayPal, manual) without re-doing
 * tax info. Today the active provider is Anvil (https://www.useanvil.com) —
 * we create an Etch e-sign packet from a pre-mapped template and return an
 * embedded signing URL the frontend iframes / redirects to. Webhook callbacks
 * flip the row to completed and store the signed PDF URL.
 *
 * Endpoints
 *   GET  /api/tax/status            Current active tax form for the caller
 *   POST /api/tax/start             Create Anvil Etch packet, return embed URL
 *   POST /api/tax/manual-complete   Dev-only: marks the active form completed
 *   POST /api/tax/webhook/:provider Anvil webhook → mark completed
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { Resend } = require('resend');

const ADMIN_NOTIFY_EMAIL = process.env.ADMIN_NOTIFY_EMAIL || 'info@davincii.co';
const ANVIL_GRAPHQL_URL = 'https://graphql.useanvil.com';

// W-8BEN expires three years after the end of the calendar year in which it
// was signed. We approximate as +3 years from completed_at.
const W8BEN_VALID_YEARS = 3;

function defaultFormType(country) {
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

// ── Anvil GraphQL helper ────────────────────────────────────────────────────
async function anvilGraphQL(query, variables) {
  if (!process.env.ANVIL_API_KEY) {
    throw new Error('ANVIL_API_KEY not set');
  }
  const authHeader = 'Basic ' + Buffer.from(process.env.ANVIL_API_KEY + ':').toString('base64');
  const resp = await fetch(ANVIL_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) {
    throw new Error('Anvil GraphQL: ' + JSON.stringify(json.errors));
  }
  return json.data;
}

// Create an Etch e-sign packet for the given tax form and return the signer's
// embedded signing URL. Returns null if Anvil isn't configured so the caller
// can fall back to manual mode.
async function createAnvilPacket({ formType, artist, legalName }) {
  const templateEid = formType === 'w8ben'
    ? process.env.ANVIL_W8BEN_TEMPLATE_ID
    : process.env.ANVIL_W9_TEMPLATE_ID;
  if (!process.env.ANVIL_API_KEY || !templateEid) return null;

  const formLabel = formType === 'w8ben' ? 'W-8BEN' : 'W-9';
  const signerName = legalName || artist.name || artist.stage_name || artist.email || 'Artist';
  const signerEmail = artist.email;

  const mutation = `
    mutation CreateEtchPacket($data: CreateEtchPacketInput!) {
      createEtchPacket(data: $data) {
        eid
        detailsURL
        documentGroup { eid }
        signers { eid signActionURL routingOrder }
      }
    }
  `;
  const variables = {
    data: {
      name: formLabel + ' — ' + signerName,
      isDraft: false,
      isTest: process.env.NODE_ENV !== 'production',
      signatureEmailSubject: formLabel + ' for Davincii',
      signatureEmailBody: 'Please sign your ' + formLabel + ' to complete Davincii payout setup.',
      files: [{ id: 'taxForm', castEid: templateEid }],
      signers: [{
        id: 'artist',
        name: signerName,
        email: signerEmail,
        signerType: 'embedded',
        routingOrder: 1,
        fields: [],
      }],
    },
  };
  const data = await anvilGraphQL(mutation, variables);
  const packet = data.createEtchPacket;
  const signer = (packet.signers || [])[0];
  return {
    eid: packet.eid,
    signUrl: signer && signer.signActionURL,
    detailsUrl: packet.detailsURL,
  };
}

// ── GET /api/tax/status ─────────────────────────────────────────────────────
router.get('/status', auth, async (req, res) => {
  try {
    const row = await getActiveTaxForm(req.artist.id);
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
router.post('/start', auth, async (req, res) => {
  let stage = 'init';
  try {
    const body = req.body || {};
    if (!req.artist || !req.artist.id) {
      console.error('[tax/start] no req.artist.id');
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    stage = 'fetch-artist';
    const { rows: artistRows } = await pool.query(
      'SELECT id, email, address_country, name, stage_name FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = artistRows[0] || {};
    const country = (body.country || artist.address_country || '').trim() || null;
    const formType = body.form_type || defaultFormType(country);
    if (formType !== 'w9' && formType !== 'w8ben') {
      return res.status(400).json({ error: 'Unsupported form_type.' });
    }
    const legalName = (body.legal_name || artist.name || artist.stage_name || '').trim() || null;

    // Try Anvil. If it fails (or isn't configured), fall back to manual stub
    // so the site keeps working while we debug.
    stage = 'anvil';
    let anvil = null;
    let anvilError = null;
    try {
      anvil = await createAnvilPacket({ formType, artist, legalName });
    } catch (err) {
      anvilError = err.message;
      console.error('[tax/start] Anvil error:', err && err.stack || err);
    }

    const provider = anvil ? 'anvil' : 'manual';
    const providerFormId = anvil ? anvil.eid : null;

    stage = 'db-read';
    const existing = await getActiveTaxForm(req.artist.id);
    stage = 'db-write';
    let row;
    if (existing && (existing.status === 'not_started' || existing.status === 'pending')) {
      const { rows } = await pool.query(
        `UPDATE tax_forms
            SET form_type = $2,
                country = $3,
                legal_name = COALESCE($4, legal_name),
                status = 'pending',
                provider = $5,
                provider_form_id = COALESCE($6, provider_form_id),
                submitted_at = COALESCE(submitted_at, NOW()),
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [existing.id, formType, country, legalName, provider, providerFormId]
      );
      row = rows[0];
    } else {
      const { rows } = await pool.query(
        `INSERT INTO tax_forms
           (artist_id, form_type, status, provider, provider_form_id, country, legal_name, submitted_at)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6, NOW())
         RETURNING *`,
        [req.artist.id, formType, provider, providerFormId, country, legalName]
      );
      row = rows[0];
    }

    res.json({
      ...summarize(row),
      provider,
      url: anvil ? anvil.signUrl : null,
      error: anvilError || undefined,
    });
  } catch (err) {
    console.error('[tax/start] stage=' + stage, err && err.stack || err);
    res.status(500).json({ error: 'Unable to start tax form.', stage, detail: err && err.message });
  }
});

// ── POST /api/tax/manual-complete ───────────────────────────────────────────
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
// Anvil webhook. server.js mounts express.raw for this path, so req.body is a
// Buffer we can use for HMAC verification. Anvil signs the body with the token
// configured in the Webhooks settings page.
router.post('/webhook/:provider', async (req, res) => {
  const provider = req.params.provider;
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

    // Signature verification (Anvil format: "t=<ts>,v1=<hex>")
    const secret = process.env.ANVIL_WEBHOOK_SECRET;
    const sigHeader = req.headers['x-anvil-signature'];
    if (secret && sigHeader) {
      try {
        const parts = String(sigHeader).split(',').reduce((acc, p) => {
          const [k, v] = p.split('=');
          if (k && v) acc[k.trim()] = v.trim();
          return acc;
        }, {});
        const signedPayload = (parts.t || '') + '.' + rawBody.toString('utf8');
        const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
        if (!parts.v1 || !crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'))) {
          console.warn('[tax/webhook] bad signature');
          return res.status(400).json({ error: 'bad signature' });
        }
      } catch (e) {
        console.warn('[tax/webhook] signature check failed:', e.message);
        return res.status(400).json({ error: 'bad signature' });
      }
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8') || '{}');
    } catch (_) {
      payload = {};
    }
    console.log('[tax/webhook]', provider, 'action=', payload.action);

    const action = payload.action || payload.type;
    const packet = payload.data && (payload.data.etchPacket || payload.data.object || payload.data);
    const packetEid = packet && (packet.eid || packet.id);

    // Only react to completion events.
    const isComplete = /complete/i.test(String(action || ''));
    if (!isComplete || !packetEid) {
      return res.json({ received: true });
    }

    // Find the tax form by provider_form_id.
    const { rows } = await pool.query(
      `SELECT * FROM tax_forms WHERE provider_form_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [packetEid]
    );
    const row = rows[0];
    if (!row) {
      console.warn('[tax/webhook] no tax_form for packet', packetEid);
      return res.json({ received: true });
    }
    if (row.status === 'completed') {
      return res.json({ received: true, already: true });
    }

    // Fetch packet details to grab the signed PDF URL.
    let signedPdfUrl = null;
    try {
      const data = await anvilGraphQL(
        `query($eid: String!) {
           etchPacket(eid: $eid) {
             eid
             status
             documentGroup { eid downloadZipURL files { downloadURL } }
           }
         }`,
        { eid: packetEid }
      );
      const dg = data.etchPacket && data.etchPacket.documentGroup;
      if (dg) {
        const files = dg.files || [];
        signedPdfUrl = (files[0] && files[0].downloadURL) || dg.downloadZipURL || null;
      }
    } catch (err) {
      console.warn('[tax/webhook] fetch packet details failed:', err.message);
    }

    const expiresAt = row.form_type === 'w8ben'
      ? new Date(Date.now() + W8BEN_VALID_YEARS * 365 * 24 * 60 * 60 * 1000)
      : null;
    const { rows: updated } = await pool.query(
      `UPDATE tax_forms
          SET status = 'completed',
              signed_pdf_url = COALESCE($2, signed_pdf_url),
              completed_at = NOW(),
              expires_at = $3,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [row.id, signedPdfUrl, expiresAt]
    );
    notifyAdminTaxCompleted(row.artist_id, updated[0]).catch(() => {});
    res.json({ received: true, completed: true });
  } catch (err) {
    console.error('[tax/webhook]', err);
    res.status(500).json({ error: 'webhook handler failed' });
  }
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
