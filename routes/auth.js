const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('../db/supabase');

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }

  try {
    // Check if artist already exists
    const { data: existing } = await supabase
      .from('artists')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert new artist
    const { data: artist, error } = await supabase
      .from('artists')
      .insert([{ name, email, password_hash }])
      .select('id, name, email, created_at')
      .single();

    if (error) throw error;

    // Generate JWT token (valid 7 days)
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ token, artist });
  } catch (err) {
    console.error('Signup error full:', err);
    console.error('SUPABASE_URL:', process.env.SUPABASE_URL);
    res.status(500).json({ error: 'Failed to create account: ' + err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('*')
      .eq('email', email)
      .maybeSingle();

    if (error || !artist) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const validPassword = await bcrypt.compare(password, artist.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      artist: {
        id: artist.id,
        name: artist.name,
        email: artist.email,
        created_at: artist.created_at
      }
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me — get current logged-in artist info
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const { data: artist, error } = await supabase
      .from('artists')
      .select('id, name, email, created_at')
      .eq('id', req.artist.id)
      .single();

    if (error || !artist) {
      return res.status(404).json({ error: 'Artist not found' });
    }

    res.json(artist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
