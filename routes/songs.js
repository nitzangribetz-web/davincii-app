const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM songs WHERE artist_id = $1 ORDER BY created_at DESC', [req.artist.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
});

router.post('/', auth, async (req, res) => {
  const { title, isrc, release_date } = req.body;
  if (!title) return res.status(400).json({ error: 'Song title is required' });
  try {
    const result = await pool.query(
      'INSERT INTO songs (artist_id, title, isrc, release_date, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.artist.id, title, isrc || null, release_date || null, 'pending']
    );
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
