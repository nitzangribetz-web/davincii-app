const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');

// GET /api/songs — get all songs for the logged-in artist
router.get('/', auth, async (req, res) => {
  try {
    const { data: songs, error } = await supabase
      .from('songs')
      .select('*')
      .eq('artist_id', req.artist.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(songs);
  } catch (err) {
    console.error('Get songs error:', err.message);
    res.status(500).json({ error: 'Failed to fetch songs' });
  }
});

// POST /api/songs — add a new song
router.post('/', auth, async (req, res) => {
  const { title, isrc, release_date } = req.body;

  if (!title) {
    return res.status(400).json({ error: 'Song title is required' });
  }

  try {
    const { data: song, error } = await supabase
      .from('songs')
      .insert([{
        artist_id: req.artist.id,
        title,
        isrc: isrc || null,
        release_date: release_date || null,
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(song);
  } catch (err) {
    console.error('Add song error:', err.message);
    res.status(500).json({ error: 'Failed to add song' });
  }
});

// GET /api/songs/:id — get one song by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const { data: song, error } = await supabase
      .from('songs')
      .select('*')
      .eq('id', req.params.id)
      .eq('artist_id', req.artist.id)
      .maybeSingle();

    if (error || !song) {
      return res.status(404).json({ error: 'Song not found' });
    }

    res.json(song);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch song' });
  }
});

// PUT /api/songs/:id — update a song
router.put('/:id', auth, async (req, res) => {
  const { title, isrc, release_date, status } = req.body;

  try {
    const updates = {};
    if (title !== undefined) updates.title = title;
    if (isrc !== undefined) updates.isrc = isrc;
    if (release_date !== undefined) updates.release_date = release_date;
    if (status !== undefined) updates.status = status;

    const { data: song, error } = await supabase
      .from('songs')
      .update(updates)
      .eq('id', req.params.id)
      .eq('artist_id', req.artist.id)
      .select()
      .single();

    if (error) throw error;
    res.json(song);
  } catch (err) {
    console.error('Update song error:', err.message);
    res.status(500).json({ error: 'Failed to update song' });
  }
});

// DELETE /api/songs/:id — delete a song
router.delete('/:id', auth, async (req, res) => {
  try {
    const { error } = await supabase
      .from('songs')
      .delete()
      .eq('id', req.params.id)
      .eq('artist_id', req.artist.id);

    if (error) throw error;
    res.json({ message: 'Song deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete song' });
  }
});

module.exports = router;
