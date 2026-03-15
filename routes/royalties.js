const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

router.get('/summary', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT amount, platform, royalty_type, period FROM royalties WHERE artist_id = $1', [req.artist.id]);
    const royalties = result.rows;
    const total = royalties.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);
    const byPlatform = royalties.reduce((acc, r) => { acc[r.platform] = (acc[r.platform] || 0) + parseFloat(r.amount || 0); return acc; }, {});
    const byType = royalties.reduce((acc, r) => { if (r.royalty_type) { acc[r.royalty_type] = (acc[r.royalty_type] || 0) + parseFloat(r.amount || 0); } return acc; }, {});
    res.json({ total: total.toFixed(2), byPlatform, byType, count: royalties.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch royalty summary' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT r.*, s.title as song_title FROM royalties r LEFT JOIN songs s ON r.song_id = s.id WHERE r.artist_id = $1 ORDER BY r.created_at DESC',
      [req.artist.id]
    );
    const rows = result.rows.map(r => ({ ...r, songs: r.song_title ? { title: r.song_title } : null }));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch royalties' });
  }
});

router.post('/', auth, async (req, res) => {
  const { song_id, platform, amount, royalty_type, period } = req.body;
  if (!platform || !amount) return res.status(400).json({ error: 'Platform and amount are required' });
  try {
    const result = await pool.query(
      'INSERT INTO royalties (artist_id, song_id, platform, amount, royalty_type, period) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [req.artist.id, song_id || null, platform, amount, royalty_type || null, period || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to record royalty' });
  }
});

module.exports = router;
