const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const supabase = require('../db/supabase');

// GET /api/auth/google - Initiate Google OAuth via Supabase
router.get('/google', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${appUrl}/api/auth/callback`,
      }
    });
    if (error) throw error;
    res.redirect(data.url);
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// GET /api/auth/apple - Initiate Apple OAuth via Supabase
router.get('/apple', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo: `${appUrl}/api/auth/callback`,
      }
    });
    if (error) throw error;
    res.redirect(data.url);
  } catch (err) {
    console.error('Apple OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// GET /api/auth/callback - Handle OAuth callback from Supabase
router.get('/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.redirect('/?error=no_code');
    }

    // Exchange the code for a session
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    if (sessionError) throw sessionError;

    const supaUser = sessionData.user;
    const email = supaUser.email;
    const name = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || email.split('@')[0];

    // Find or create the artist in our database
    let artist;
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      artist = existing.rows[0];
    } else {
      // Create new artist (no password needed for OAuth users)
      const randomHash = await bcrypt.hash(Math.random().toString(36), 10);
      const result = await pool.query(
        'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
        [name, email, randomHash]
      );
      artist = result.rows[0];
    }

    // Generate JWT
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to frontend with token
    const artistPayload = encodeURIComponent(JSON.stringify({ id: artist.id, name: artist.name, email: artist.email }));
    res.redirect(`/auth-success?token=${token}&artist=${artistPayload}`);
  } catch (err) {
    console.error('OAuth callback error:', err.message);
    res.redirect('/?error=callback_failed');
  }
});

// POST /api/auth/signup
router.post('/signup', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  try {
    const existing = await pool.query('SELECT id FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [name, email, password_hash]
    );
    const artist = result.rows[0];
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({ token, artist });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    const artist = result.rows[0];
    if (!artist) {
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
    res.json({ token, artist: { id: artist.id, name: artist.name, email: artist.email, created_at: artist.created_at } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, created_at FROM artists WHERE id = $1', [req.artist.id]);
    const artist = result.rows[0];
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    res.json(artist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

module.exports = router;
