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
    console.log('[OAuth callback] code present:', !!code, 'query keys:', Object.keys(req.query).join(','));
    if (!code) {
      console.error('[OAuth callback] No code in query params. Full query:', JSON.stringify(req.query));
      return res.redirect('/?error=no_code');
    }

    // Exchange the code for a session
    console.log('[OAuth callback] Exchanging code for session...');
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    if (sessionError) {
      console.error('[OAuth callback] exchangeCodeForSession error:', sessionError.message, sessionError);
      throw sessionError;
    }
    console.log('[OAuth callback] Session exchanged. User:', sessionData.user?.email);

    const supaUser = sessionData.user;
    const email = supaUser.email;
    const name = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || email.split('@')[0];

    // Find or create the artist in our database
    let artist;
    let isNewSignup = false;
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      artist = existing.rows[0];
      console.log('[OAuth callback] Existing artist id:', artist.id);
    } else {
      isNewSignup = true;
      const randomHash = await bcrypt.hash(Math.random().toString(36), 10);
      const result = await pool.query(
        'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
        [name, email, randomHash]
      );
      artist = result.rows[0];
      console.log('[OAuth callback] New artist created id:', artist.id);
    }

    // Generate JWT
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Redirect to frontend with token
    const artistPayload = encodeURIComponent(JSON.stringify({ id: artist.id, name: artist.name, email: artist.email }));
    const signupFlag = isNewSignup ? '&signup=1' : '';
    console.log('[OAuth callback] Redirecting to auth-complete. isNewSignup:', isNewSignup);
    res.redirect(`/auth-complete.html?token=${token}&artist=${artistPayload}${signupFlag}`);
  } catch (err) {
    console.error('[OAuth callback] FAILED:', err.message, err.stack);
    res.redirect('/?error=callback_failed');
  }
});

// Helper: generate JWT and build redirect URL for successful auth
function authSuccessRedirect(artist, isSignup) {
  const token = jwt.sign(
    { id: artist.id, email: artist.email, name: artist.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const artistPayload = encodeURIComponent(JSON.stringify({
    id: artist.id, name: artist.name, email: artist.email
  }));
  const signupFlag = isSignup ? '&signup=1' : '';
  return `/auth-complete.html?token=${token}&artist=${artistPayload}${signupFlag}`;
}

// POST /api/auth/signup
// Form POST → 302 redirect (Safari saves credentials on real navigation)
// JSON POST → JSON response (for passkey/API use)
router.post('/signup', async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  // Support both "name" (legacy/JSON) and "first_name"+"last_name" (new form)
  const first = req.body.first_name;
  const last = req.body.last_name;
  const name = (first && last) ? `${first.trim()} ${last.trim()}` : req.body.name;
  const email = req.body.email;
  const password = req.body.password;
  const confirmPassword = req.body.confirm_password;

  if (!name || !email || !password) {
    if (isFormSubmit) return res.redirect('/signup.html?error=' + encodeURIComponent('Name, email, and password are required'));
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (isFormSubmit && confirmPassword && password !== confirmPassword) {
    return res.redirect('/signup.html?error=' + encodeURIComponent('Passwords do not match'));
  }
  try {
    const existing = await pool.query('SELECT id FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      if (isFormSubmit) return res.redirect('/signup.html?error=' + encodeURIComponent('An account with this email already exists'));
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [name, email, password_hash]
    );
    const artist = result.rows[0];

    if (isFormSubmit) {
      // 302 redirect → Safari detects successful form submission + navigation → saves credentials
      return res.redirect(authSuccessRedirect(artist, true));
    }
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.status(201).json({ token, artist });
  } catch (err) {
    console.error('Signup error:', err.message);
    if (isFormSubmit) return res.redirect('/signup.html?error=' + encodeURIComponent('Failed to create account'));
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// POST /api/auth/login
// Form POST → 302 redirect (Safari saves credentials on real navigation)
// JSON POST → JSON response (for passkey/API use)
router.post('/login', async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  const { email, password } = req.body;

  if (!email || !password) {
    if (isFormSubmit) return res.redirect('/login.html?error=' + encodeURIComponent('Email and password are required'));
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    const artist = result.rows[0];
    if (!artist) {
      if (isFormSubmit) return res.redirect('/login.html?error=' + encodeURIComponent('Invalid email or password'));
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const validPassword = await bcrypt.compare(password, artist.password_hash);
    if (!validPassword) {
      if (isFormSubmit) return res.redirect('/login.html?error=' + encodeURIComponent('Invalid email or password'));
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (isFormSubmit) {
      // 302 redirect → Safari detects successful form submission + navigation → saves credentials
      return res.redirect(authSuccessRedirect(artist, false));
    }
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, artist: { id: artist.id, name: artist.name, email: artist.email, created_at: artist.created_at } });
  } catch (err) {
    console.error('Login error:', err.message);
    if (isFormSubmit) return res.redirect('/login.html?error=' + encodeURIComponent('Login failed'));
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

// POST /api/auth/profile — save artist onboarding details (Step 2)
router.post('/profile', require('../middleware/auth'), async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  const { stage_name, pro, pro_role, ipi, dob, address_street, address_city, address_state } = req.body;

  if (!stage_name) {
    if (isFormSubmit) return res.redirect('/details.html?error=' + encodeURIComponent('Artist / professional name is required'));
    return res.status(400).json({ error: 'Artist / professional name is required' });
  }

  try {
    await pool.query(
      `UPDATE artists SET stage_name=$1, pro=$2, pro_role=$3, ipi=$4, dob=$5,
       address_street=$6, address_city=$7, address_state=$8, onboarded=TRUE
       WHERE id=$9`,
      [stage_name, pro || null, pro_role || null, ipi || null, dob || null,
       address_street || null, address_city || null, address_state || null, req.artist.id]
    );

    if (isFormSubmit) {
      // Redirect to main app — token is already in localStorage from auth-complete.html
      return res.redirect('/');
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Profile update error:', err.message);
    if (isFormSubmit) return res.redirect('/details.html?error=' + encodeURIComponent('Failed to save details'));
    res.status(500).json({ error: 'Failed to save details' });
  }
});

module.exports = router;
