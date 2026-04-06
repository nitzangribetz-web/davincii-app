const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { Resend } = require('resend');

router.get('/summary', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT amount, status FROM payouts WHERE artist_id = $1', [req.artist.id]);
    const payouts = result.rows;
    const totalPaid = payouts.filter(p => p.status === 'completed').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const totalPending = payouts.filter(p => p.status === 'pending').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    res.json({ totalPaid: totalPaid.toFixed(2), totalPending: totalPending.toFixed(2), payoutCount: payouts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payouts WHERE artist_id = $1 ORDER BY created_at DESC', [req.artist.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

router.post('/request', auth, async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || !method) return res.status(400).json({ error: 'Amount and payment method are required' });
  const amountFloat = parseFloat(amount);
  if (amountFloat < 10) return res.status(400).json({ error: 'Minimum payout amount is $10.00' });
  const validMethods = ['bank_transfer', 'paypal', 'stripe', 'check'];
  if (!validMethods.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
  try {
    // Balance check — prevent requesting more than available
    const [royResult, payResult] = await Promise.all([
      pool.query(
        'SELECT COALESCE(SUM(amount), 0) AS total FROM royalties WHERE artist_id = $1',
        [req.artist.id]
      ),
      pool.query(
        "SELECT COALESCE(SUM(amount), 0) AS total FROM payouts WHERE artist_id = $1 AND status IN ('completed', 'pending')",
        [req.artist.id]
      ),
    ]);
    const available = parseFloat(royResult.rows[0].total) - parseFloat(payResult.rows[0].total);
    if (amountFloat > available) {
      return res.status(400).json({
        error: `Insufficient balance. Available: $${Math.max(0, available).toFixed(2)}`,
      });
    }

    const result = await pool.query(
      'INSERT INTO payouts (artist_id, amount, method, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.artist.id, amountFloat, method, 'pending']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to request payout' });
  }
});

// POST /api/payouts/w9 — Submit W-9 tax form and notify admin
router.post('/w9', auth, async (req, res) => {
  const { legal_name, business_name, classification, llc_type, tin_type, tin, address, city, state, zip, signature, date } = req.body;

  if (!legal_name || !classification || !tin_type || !tin || !address || !city || !state || !zip || !signature || !date) {
    return res.status(400).json({ error: 'All required fields must be completed' });
  }

  try {
    const artist = (await pool.query('SELECT name, email, stage_name FROM artists WHERE id = $1', [req.artist.id])).rows[0];

    const classLabel = classification === 'llc' && llc_type
      ? 'LLC — ' + llc_type
      : classification;

    const resend = new Resend(process.env.RESEND_API_KEY);
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

    // Send email notification (non-blocking — don't let email failure block submission)
    resend.emails.send({
      from: 'Davincii <notifications@davincii.co>',
      to: 'info@davincii.co',
      subject: `W-9 Submitted: ${artist.stage_name || artist.name} (${artist.email})`,
      html: `
        <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A">
          <div style="background:linear-gradient(135deg,#0E2A78 0%,#060E28 100%);padding:28px 36px;text-align:center">
            <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:26px">
          </div>
          <div style="padding:36px;background:#ffffff;border:1px solid #E2E8F0;border-top:none">
            <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 6px;color:#0A0A0A">W-9 Tax Form Submitted</h2>
            <div style="width:28px;height:2px;background:#2260CC;margin-bottom:20px"></div>
            <p style="font-size:13px;color:#64748B;margin:0 0 28px;line-height:1.6">An artist has submitted their W-9 tax information.</p>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8;width:130px">Artist</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:15px;font-weight:600;color:#0A0A0A">${artist.stage_name || artist.name}</td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Email</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A"><a href="mailto:${artist.email}" style="color:#2563EB;text-decoration:none">${artist.email}</a></td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Legal Name</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${legal_name}</td></tr>
              ${business_name ? `<tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Business / DBA</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${business_name}</td></tr>` : ''}
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Classification</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${classLabel}</td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">TIN Type</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${tin_type.toUpperCase()}</td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">TIN</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;font-family:monospace;color:#0A0A0A">${tin}</td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Address</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${address}, ${city}, ${state} ${zip}</td></tr>
              <tr><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Signature</td><td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;font-style:italic;color:#0A0A0A">${signature}</td></tr>
              <tr><td style="padding:12px 0;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Date Signed</td><td style="padding:12px 0;font-size:14px;color:#0A0A0A">${date}</td></tr>
            </table>
            <div style="background:#F8FAFC;border:1px solid #E2E8F0;padding:14px 18px;font-size:12px;color:#475569;line-height:1.7;border-radius:6px">
              <strong style="color:#0A0A0A">Certification:</strong> The artist certified under penalties of perjury that the TIN is correct, they are not subject to backup withholding, and they are a U.S. person.
            </div>
          </div>
          <div style="padding:18px 36px;text-align:center;font-size:11px;color:#94A3B8">
            Davincii Publishing Administration &middot; davincii.co<br>
            Submitted: ${dateStr} at ${timeStr}
          </div>
        </div>`
    }).then(() => {
      console.log(`[W-9 notification] Email sent for: ${artist.email}`);
    }).catch(emailErr => {
      console.error('[W-9 notification] Email failed (non-blocking):', emailErr.message);
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[W-9 submission] Failed:', err.message);
    res.status(500).json({ error: 'Failed to submit W-9' });
  }
});

module.exports = router;
