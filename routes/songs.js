const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');
const { Resend } = require('resend');

async function sendSongNotification(songData) {
  const { title, isrc, recordingTitle, primaryWriter, primaryPct, cowriters, artistName, artistEmail } = songData;

  let writersHtml = `
    <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${primaryWriter}</td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${primaryPct}%</td>
    <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888">Primary</td></tr>`;

  if (cowriters && cowriters.length > 0) {
    cowriters.forEach(cw => {
      writersHtml += `
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eee">${cw.name || cw.artistName || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center">${cw.pct}%</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;color:#888">${cw.pro || '—'} ${cw.ipi ? '· IPI: ' + cw.ipi : ''}</td></tr>`;
    });
  }

  const totalPct = (parseFloat(primaryPct) || 0) + (cowriters || []).reduce((sum, cw) => sum + (parseFloat(cw.pct) || 0), 0);

  const html = `
    <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#080808">
      <div style="background:#080808;padding:24px 32px;text-align:center">
        <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:28px">
      </div>
      <div style="padding:32px;background:#ffffff;border:1px solid #eee;border-top:none">
        <h2 style="font-family:Georgia,serif;font-size:24px;font-weight:400;margin:0 0 4px">New Song Submitted</h2>
        <p style="font-size:13px;color:#888;margin:0 0 28px">A new composition has been submitted for registration on Songtrust.</p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888;width:140px">Song Title</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:15px;font-weight:600">${title}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">ISRC Code</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px;font-family:monospace">${isrc || 'Not provided'}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">Recording Title</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px">${recordingTitle || 'Same as song title'}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #eee;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">Artist</td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;font-size:14px">${artistName || '—'} (${artistEmail || '—'})</td></tr>
        </table>

        <h3 style="font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:#888;margin:0 0 12px">Writers &amp; Splits (${totalPct}%)</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:28px;font-size:14px">
          <tr style="background:#f8f8f6">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">Writer</th>
            <th style="padding:8px 12px;text-align:center;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">Share</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#888">Details</th>
          </tr>
          ${writersHtml}
        </table>

        <div style="background:#f8f8f6;padding:16px 20px;font-size:12px;color:#666;line-height:1.7">
          <strong>Action required:</strong> Register this song on Songtrust and all applicable PROs / collection societies.
        </div>
      </div>
      <div style="padding:20px 32px;text-align:center;font-size:11px;color:#aaa">
        Davincii Publishing Administration &middot; davincii.co
      </div>
    </div>`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: 'Davincii <onboarding@resend.dev>',
      to: 'info@davincii.co',
      subject: `New Song Submission: ${title}`,
      html
    });
    console.log(`Email notification sent for song: ${title}`, result);
  } catch (err) {
    console.error('Failed to send email notification:', err.message);
    // Don't throw — email failure shouldn't block song creation
  }
}

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM songs WHERE artist_id = $1 ORDER BY created_at DESC', [req.artist.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
});

router.post('/', auth, async (req, res) => {
  const { title, isrc, release_date, recording_title, primary_writer, primary_pct, cowriters } = req.body;
  if (!title) return res.status(400).json({ error: 'Song title is required' });

  // Validate ownership totals 100%
  let totalPct = parseFloat(primary_pct) || 0;
  if (cowriters && Array.isArray(cowriters)) {
    cowriters.forEach(cw => { totalPct += parseFloat(cw.pct) || 0; });
  }
  if (Math.abs(totalPct - 100) > 0.01) {
    return res.status(400).json({ error: 'Ownership splits must total exactly 100%' });
  }

  try {
    const result = await pool.query(
      'INSERT INTO songs (artist_id, title, isrc, release_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.artist.id, title, isrc || null, release_date || null, 'pending']
    );

    // Get artist info for email
    let artistName = '', artistEmail = '';
    try {
      const artistResult = await pool.query('SELECT name, email FROM artists WHERE id = $1', [req.artist.id]);
      if (artistResult.rows.length > 0) {
        artistName = artistResult.rows[0].name;
        artistEmail = artistResult.rows[0].email;
      }
    } catch (e) { /* non-critical */ }

    // Send email notification (non-blocking)
    sendSongNotification({
      title,
      isrc,
      recordingTitle: recording_title,
      primaryWriter: primary_writer || artistName,
      primaryPct: primary_pct || 100,
      cowriters: cowriters || [],
      artistName,
      artistEmail
    });

    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to add song' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM songs WHERE id = $1 AND artist_id = $2', [req.params.id, req.artist.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Song not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch song' });
  }
});

router.put('/:id', auth, async (req, res) => {
  const { title, isrc, release_date, status } = req.body;
  try {
    const result = await pool.query(
      'UPDATE songs SET title = COALESCE($1, title), isrc = COALESCE($2, isrc), release_date = COALESCE($3, release_date), status = COALESCE($4, status) WHERE id = $5 AND artist_id = $6 RETURNING *',
      [title, isrc, release_date, status, req.params.id, req.artist.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update song' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM songs WHERE id = $1 AND artist_id = $2', [req.params.id, req.artist.id]);
    res.json({ message: 'Song deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete song' });
  }
});

module.exports = router;
