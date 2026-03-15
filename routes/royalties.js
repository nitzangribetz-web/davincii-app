const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');

// GET /api/royalties — get all royalties for the logged-in artist
router.get('/', auth, async (req, res) => {
  try {
    const { data: royalties, error } = await supabase
      .from('royalties')
      .select('*, songs(title)')
      .eq('artist_id', req.artist.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(royalties);
  } catch (err) {
    console.error('Get royalties error:', err.message);
    res.status(500).json({ error: 'Failed to fetch royalties' });
  }
});

// GET /api/royalties/summary — total earnings breakdown
router.get('/summary', auth, async (req, res) => {
  try {
    const { data: royalties, error } = await supabase
      .from('royalties')
      .select('amount, platform, royalty_type, period')
      .eq('artist_id', req.artist.id);

    if (error) throw error;

    const total = royalties.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

    const byPlatform = royalties.reduce((acc, r) => {
      acc[r.platform] = (acc[r.platform] || 0) + parseFloat(r.amount || 0);
      return acc;
    }, {});

    const byType = royalties.reduce((acc, r) => {
      if (r.royalty_type) {
        acc[r.royalty_type] = (acc[r.royalty_type] || 0) + parseFloat(r.amount || 0);
      }
      return acc;
    }, {});

    res.json({
      total: total.toFixed(2),
      byPlatform,
      byType,
      count: royalties.length
    });
  } catch (err) {
    console.error('Royalty summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch royalty summary' });
  }
});

// POST /api/royalties — record a royalty payment
router.post('/', auth, async (req, res) => {
  const { song_id, platform, amount, royalty_type, period } = req.body;

  if (!platform || !amount) {
    return res.status(400).json({ error: 'Platform and amount are required' });
  }

  try {
    const { data: royalty, error } = await supabase
      .from('royalties')
      .insert([{
        artist_id: req.artist.id,
        song_id: song_id || null,
        platform,
        amount,
        royalty_type: royalty_type || null,
        period: period || null
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(royalty);
  } catch (err) {
    console.error('Add royalty error:', err.message);
    res.status(500).json({ error: 'Failed to record royalty' });
  }
});

module.exports = router;
