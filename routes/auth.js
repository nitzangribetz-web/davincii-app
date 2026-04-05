const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const supabase = require('../db/supabase');
const { Resend } = require('resend');

// Send signup notification email to admin
async function sendSignupNotification({ name, email, method }) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

    const html = `
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A">
        <div style="background:linear-gradient(135deg,#0E2A78 0%,#060E28 100%);padding:28px 36px;text-align:center">
          <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:26px">
        </div>
        <div style="padding:36px;background:#ffffff;border:1px solid #E2E8F0;border-top:none">
          <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 6px;color:#0A0A0A">New Artist Signup</h2>
          <div style="width:28px;height:2px;background:#2260CC;margin-bottom:20px"></div>
          <p style="font-size:13px;color:#64748B;margin:0 0 28px;line-height:1.6">A new artist has registered on the Davincii platform.</p>

          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8;width:120px">Name</td>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:15px;font-weight:600;color:#0A0A0A">${name}</td>
            </tr>
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Email</td>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">
                <a href="mailto:${email}" style="color:#2563EB;text-decoration:none">${email}</a>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Method</td>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${method}</td>
            </tr>
            <tr>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Date</td>
              <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${dateStr}</td>
            </tr>
            <tr>
              <td style="padding:12px 0;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Time</td>
              <td style="padding:12px 0;font-size:14px;color:#0A0A0A">${timeStr}</td>
            </tr>
          </table>

          <div style="background:#F8FAFC;border:1px solid #E2E8F0;padding:14px 18px;font-size:12px;color:#475569;line-height:1.7;border-radius:6px">
            <strong style="color:#0A0A0A">Next steps:</strong> Artist needs to complete onboarding (artist details, PRO affiliation, IPI number).
          </div>
        </div>
        <div style="padding:18px 36px;text-align:center;font-size:11px;color:#94A3B8">
          Davincii Publishing Administration &middot; davincii.co
        </div>
      </div>`;

    await resend.emails.send({
      from: 'Davincii <onboarding@resend.dev>',
      to: 'info@davincii.co',
      subject: `New Signup: ${name} (${email})`,
      html
    });
    console.log(`[Signup notification] Email sent for: ${email}`);
  } catch (err) {
    console.error('[Signup notification] Failed:', err.message);
    // Don't throw — email failure shouldn't block signup
  }
}

// GET /api/auth/google - Initiate Google OAuth (direct or via Supabase fallback)
router.get('/google', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const googleClientId = process.env.GOOGLE_CLIENT_ID;

    // Direct Google OAuth (bypasses Supabase so consent screen shows our app name)
    if (googleClientId) {
      const params = new URLSearchParams({
        client_id: googleClientId,
        redirect_uri: `${appUrl}/oauth-callback.html`,
        response_type: 'token',
        scope: 'openid email profile',
        prompt: 'select_account',
      });
      return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
    }

    // Fallback: Supabase OAuth (if GOOGLE_CLIENT_ID not configured)
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${appUrl}/oauth-callback.html`,
      }
    });
    if (error) throw error;
    res.redirect(data.url);
  } catch (err) {
    console.error('Google OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// GET /api/auth/apple - Initiate Apple OAuth via Supabase (implicit flow)
router.get('/apple', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'apple',
      options: {
        redirectTo: `${appUrl}/oauth-callback.html`,
      }
    });
    if (error) throw error;
    res.redirect(data.url);
  } catch (err) {
    console.error('Apple OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// POST /api/auth/oauth-exchange - Exchange access token for our JWT
// Supports both direct Google tokens and Supabase tokens (fallback)
router.post('/oauth-exchange', async (req, res) => {
  try {
    const { access_token } = req.body;
    if (!access_token) {
      return res.status(400).json({ error: 'Missing access_token' });
    }

    let email, name;
    const googleClientId = process.env.GOOGLE_CLIENT_ID;

    if (googleClientId) {
      // Direct Google: verify token by calling Google userinfo endpoint
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!userinfoRes.ok) {
        const errText = await userinfoRes.text();
        console.error('[OAuth exchange] Google userinfo error:', userinfoRes.status, errText);
        return res.status(401).json({ error: 'Invalid access token' });
      }
      const profile = await userinfoRes.json();
      if (!profile.email) {
        console.error('[OAuth exchange] Google profile missing email:', profile);
        return res.status(401).json({ error: 'Could not retrieve email from Google' });
      }
      email = profile.email;
      name = profile.name || profile.email.split('@')[0];
      console.log('[OAuth exchange] Google verified user:', email);
    } else {
      // Fallback: Supabase token verification
      const { data: userData, error: userError } = await supabase.auth.getUser(access_token);
      if (userError || !userData?.user) {
        console.error('[OAuth exchange] getUser error:', userError?.message);
        return res.status(401).json({ error: 'Invalid access token' });
      }
      const supaUser = userData.user;
      email = supaUser.email;
      name = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || email.split('@')[0];
      console.log('[OAuth exchange] Supabase verified user:', email);
    }

    // Find or create the artist in our database
    let artist;
    let isNewSignup = false;
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      artist = existing.rows[0];
    } else {
      isNewSignup = true;
      const randomHash = await bcrypt.hash(Math.random().toString(36), 10);
      const result = await pool.query(
        'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
        [name, email, randomHash]
      );
      artist = result.rows[0];
      console.log('[OAuth exchange] New artist created id:', artist.id);
      // Send signup notification email (non-blocking)
      sendSignupNotification({ name, email, method: 'Google OAuth' });
    }

    // Generate our JWT
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      artist: { id: artist.id, name: artist.name, email: artist.email },
      isNewSignup
    });
  } catch (err) {
    console.error('[OAuth exchange] FAILED:', err.message);
    res.status(500).json({ error: 'OAuth exchange failed' });
  }
});

// GET /api/auth/callback - Legacy callback (kept for backward compatibility)
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/?error=no_code');
  }
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code);
    if (sessionError) throw sessionError;

    const supaUser = sessionData.user;
    const email = supaUser.email;
    const name = supaUser.user_metadata?.full_name || supaUser.user_metadata?.name || email.split('@')[0];

    let artist;
    let isNewSignup = false;
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      artist = existing.rows[0];
    } else {
      isNewSignup = true;
      const randomHash = await bcrypt.hash(Math.random().toString(36), 10);
      const result = await pool.query(
        'INSERT INTO artists (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
        [name, email, randomHash]
      );
      artist = result.rows[0];
      // Send signup notification email (non-blocking)
      sendSignupNotification({ name, email, method: 'Google OAuth (Supabase)' });
    }

    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const artistPayload = encodeURIComponent(JSON.stringify({ id: artist.id, name: artist.name, email: artist.email }));
    const signupFlag = isNewSignup ? '&signup=1' : '';
    res.redirect(`/auth-complete.html?token=${token}&artist=${artistPayload}${signupFlag}`);
  } catch (err) {
    console.error('[OAuth callback] FAILED:', err.message);
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

    // Send signup notification email (non-blocking)
    sendSignupNotification({ name, email, method: 'Email / Password' });

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
