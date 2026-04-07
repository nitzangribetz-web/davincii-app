const express = require('express');
const router = express.Router();
const crypto = require('crypto');
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
      from: 'Davincii <info@davincii.co>',
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

// Generate a 6-digit verification code and store it for the artist
async function generateVerificationCode(artistId) {
  const code = crypto.randomInt(100000, 999999).toString();
  await pool.query(
    `UPDATE artists SET verification_code=$1, verification_code_expires=NOW()+INTERVAL '10 minutes',
     verification_attempts=0, verification_last_sent=NOW() WHERE id=$2`,
    [code, artistId]
  );
  return code;
}

// Send verification code email
async function sendVerificationEmail({ email, name, code }) {
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const html = `
      <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A">
        <div style="background:linear-gradient(135deg,#0E2A78 0%,#060E28 100%);padding:28px 36px;text-align:center">
          <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:26px">
        </div>
        <div style="padding:36px;background:#ffffff;border:1px solid #E2E8F0;border-top:none">
          <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 6px;color:#0A0A0A">Verify your email</h2>
          <div style="width:28px;height:2px;background:#2260CC;margin-bottom:20px"></div>
          <p style="font-size:13px;color:#64748B;margin:0 0 28px;line-height:1.6">Enter this code to verify your email address and complete your registration.</p>
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px">
            <div style="font-family:'Inter',monospace;font-size:36px;font-weight:600;letter-spacing:0.3em;color:#0A0A0A">${code}</div>
          </div>
          <p style="font-size:12px;color:#94A3B8;margin:0 0 20px;line-height:1.6">This code expires in 10 minutes.</p>
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;padding:14px 18px;font-size:12px;color:#475569;line-height:1.7;border-radius:6px">
            If you didn't create a Davincii account, you can safely ignore this email.
          </div>
        </div>
        <div style="padding:18px 36px;text-align:center;font-size:11px;color:#94A3B8">
          Davincii Publishing Administration &middot; davincii.co
        </div>
      </div>`;
    await resend.emails.send({
      from: 'Davincii <info@davincii.co>',
      to: email,
      subject: `Your Davincii verification code: ${code}`,
      html
    });
    console.log(`[Verification] Code sent to: ${email}`);
  } catch (err) {
    console.error('[Verification] Email failed:', err.message);
  }
}

// GET /api/auth/google - Initiate Google OAuth (authorization code flow)
router.get('/google', async (req, res) => {
  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const googleClientId = process.env.GOOGLE_CLIENT_ID;

    if (!googleClientId || googleClientId === 'your_google_client_id_here') {
      console.error('[Google OAuth] GOOGLE_CLIENT_ID is missing or placeholder');
      return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is not configured. Please contact support.'));
    }

    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: `${appUrl}/api/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      access_type: 'offline',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  } catch (err) {
    console.error('[Google OAuth] initiation error:', err.message);
    res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed. Please try again.'));
  }
});

// GET /api/auth/google/callback - Handle Google authorization code
router.get('/google/callback', async (req, res) => {
  const { code, error: googleError } = req.query;

  if (googleError) {
    console.error('[Google callback] Google returned error:', googleError);
    return res.redirect('/login?error=' + encodeURIComponent('Google sign-in was cancelled or failed.'));
  }
  if (!code) {
    console.error('[Google callback] No authorization code received');
    return res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed — no authorization code received.'));
  }

  try {
    const appUrl = process.env.APP_URL || 'https://davincii.co';
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!googleClientSecret) {
      console.error('[Google callback] GOOGLE_CLIENT_SECRET is not set');
      return res.redirect('/login?error=' + encodeURIComponent('Google sign-in is misconfigured. Please contact support.'));
    }

    // Exchange authorization code for tokens
    console.log('[Google callback] Exchanging code for tokens...');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        redirect_uri: `${appUrl}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || !tokenData.access_token) {
      console.error('[Google callback] Token exchange failed:', JSON.stringify(tokenData));
      return res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed during token exchange.'));
    }
    console.log('[Google callback] Token exchange successful');

    // Get user info from Google
    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await userinfoRes.json();

    if (!userinfoRes.ok || !profile.email) {
      console.error('[Google callback] Failed to get user info:', JSON.stringify(profile));
      return res.redirect('/login?error=' + encodeURIComponent('Could not retrieve your Google profile.'));
    }
    console.log('[Google callback] Got user profile:', profile.email);

    const email = profile.email;
    const name = profile.name || email.split('@')[0];

    // Find or create the artist
    let artist;
    let isNewSignup = false;
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      artist = existing.rows[0];
      console.log('[Google callback] Existing artist found, id:', artist.id);
    } else {
      isNewSignup = true;
      const randomHash = await bcrypt.hash(Math.random().toString(36), 10);
      const result = await pool.query(
        'INSERT INTO artists (name, email, password_hash, email_verified) VALUES ($1, $2, $3, TRUE) RETURNING *',
        [name, email, randomHash]
      );
      artist = result.rows[0];
      console.log('[Google callback] New artist created, id:', artist.id);
      sendSignupNotification({ name, email, method: 'Google OAuth' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name, is_admin: !!artist.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const artistPayload = encodeURIComponent(JSON.stringify({
      id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name || null, is_admin: !!artist.is_admin
    }));

    // Redirect based on profile completeness
    if (!artist.stage_name) {
      console.log('[Google callback] Profile incomplete, redirecting to complete-profile');
      res.redirect(`/?token=${token}&artist=${artistPayload}&google_signup=1`);
    } else {
      console.log('[Google callback] Profile complete, redirecting to dashboard');
      res.redirect(`/?token=${token}&artist=${artistPayload}`);
    }
  } catch (err) {
    console.error('[Google callback] FAILED:', err.message, err.stack);
    res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed. Please try again.'));
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
    res.redirect('/login?error=' + encodeURIComponent('Google sign-in failed. Please try again.'));
  }
});

// POST /api/auth/oauth-exchange - Legacy endpoint (kept for backward compatibility with oauth-callback.html)
router.post('/oauth-exchange', async (req, res) => {
  // This endpoint is no longer the primary flow — Google OAuth now uses authorization code flow
  // handled entirely by GET /api/auth/google/callback. This remains for any edge cases.
  res.status(410).json({ error: 'This endpoint has been replaced. Please use the Google sign-in button to try again.' });
});

// GET /api/auth/callback - Legacy callback (kept for backward compatibility)
router.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.redirect('/login?error=' + encodeURIComponent('Sign-in failed — no authorization code received.'));
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
        'INSERT INTO artists (name, email, password_hash, email_verified) VALUES ($1, $2, $3, TRUE) RETURNING id, name, email, created_at',
        [name, email, randomHash]
      );
      artist = result.rows[0];
      // Send signup notification email (non-blocking)
      sendSignupNotification({ name, email, method: 'Google OAuth (Supabase)' });
    }

    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name, is_admin: !!artist.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    const artistPayload = encodeURIComponent(JSON.stringify({ id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name || null }));
    if (!artist.stage_name) {
      res.redirect(`/auth-complete.html?token=${token}&artist=${artistPayload}&google_signup=1`);
    } else {
      res.redirect(`/auth-complete.html?token=${token}&artist=${artistPayload}`);
    }
  } catch (err) {
    console.error('[OAuth callback] FAILED:', err.message);
    res.redirect('/login?error=' + encodeURIComponent('Sign-in failed. Please try again.'));
  }
});

// Helper: generate JWT and build redirect URL for successful auth
// Redirects directly to / (not auth-complete.html) so Safari can anchor
// the "Save Password?" prompt on the destination page without an intermediate
// JavaScript redirect killing it.
function authSuccessRedirect(artist, isSignup) {
  const token = jwt.sign(
    { id: artist.id, email: artist.email, name: artist.name },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const artistPayload = encodeURIComponent(JSON.stringify({
    id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name || null, is_admin: !!artist.is_admin
  }));
  const signupFlag = isSignup ? '&signup=1' : '';
  // Redirect through auth-complete.html so Safari detects the
  // POST → 302 → new-page cycle and offers to save credentials
  return `/auth-complete.html?token=${token}&artist=${artistPayload}${signupFlag}`;
}

// POST /api/auth/signup
// Creates account (unverified), sends verification code, redirects to verify page
router.post('/signup', async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  const first = req.body.first_name;
  const last = req.body.last_name;
  const name = (first && last) ? `${first.trim()} ${last.trim()}` : req.body.name;
  const email = req.body.email;
  const password = req.body.password;
  const confirmPassword = req.body.confirm_password;
  const artistName = req.body.artist_name ? req.body.artist_name.trim() : null;

  if (!name || !email || !password) {
    if (isFormSubmit) return res.redirect('/signup?error=' + encodeURIComponent('Name, email, and password are required'));
    return res.status(400).json({ error: 'Name, email, and password are required' });
  }
  if (isFormSubmit && confirmPassword && password !== confirmPassword) {
    return res.redirect('/signup?error=' + encodeURIComponent('Passwords do not match'));
  }
  try {
    const existing = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      const existingArtist = existing.rows[0];
      if (existingArtist.email_verified === false) {
        // Unverified account exists — update password and resend code
        const newHash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE artists SET password_hash=$1, name=$2, stage_name=COALESCE($3, stage_name) WHERE id=$4',
          [newHash, name, artistName, existingArtist.id]);
        try {
          const code = await generateVerificationCode(existingArtist.id);
          sendVerificationEmail({ email, name: name || email, code });
        } catch (verifyErr) {
          console.error('Signup verification code error (continuing):', verifyErr.message);
        }
        if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email));
        return res.json({ requiresVerification: true, email });
      }
      if (isFormSubmit) return res.redirect('/signup?error=' + encodeURIComponent('An account with this email already exists'));
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO artists (name, email, password_hash, stage_name, email_verified) VALUES ($1, $2, $3, $4, FALSE) RETURNING id, name, email, stage_name',
      [name, email, password_hash, artistName]
    );
    const artist = result.rows[0];

    // Generate verification code and send email
    try {
      const code = await generateVerificationCode(artist.id);
      sendVerificationEmail({ email, name, code });
    } catch (verifyErr) {
      console.error('Signup verification code error (continuing):', verifyErr.message);
    }

    // Send signup notification to admin (non-blocking)
    sendSignupNotification({ name, email, method: 'Email / Password' });

    if (isFormSubmit) {
      return res.redirect('/verify-email.html?email=' + encodeURIComponent(email));
    }
    res.status(201).json({ requiresVerification: true, email });
  } catch (err) {
    console.error('Signup error:', err.message);
    if (isFormSubmit) return res.redirect('/signup?error=' + encodeURIComponent('Failed to create account'));
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
    if (isFormSubmit) return res.redirect('/login?error=' + encodeURIComponent('Email and password are required'));
    return res.status(400).json({ error: 'Email and password are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    const artist = result.rows[0];
    if (!artist) {
      if (isFormSubmit) return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password'));
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const validPassword = await bcrypt.compare(password, artist.password_hash);
    if (!validPassword) {
      if (isFormSubmit) return res.redirect('/login?error=' + encodeURIComponent('Invalid email or password'));
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // If email not verified, send a new code and redirect to verification
    if (artist.email_verified === false) {
      try {
        const code = await generateVerificationCode(artist.id);
        sendVerificationEmail({ email, name: artist.name, code });
      } catch (verifyErr) {
        console.error('Login verification code error (continuing):', verifyErr.message);
      }
      if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email));
      return res.json({ requiresVerification: true, email });
    }

    if (isFormSubmit) {
      return res.redirect(authSuccessRedirect(artist, false));
    }
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name, is_admin: !!artist.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, artist: { id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name || null, is_admin: !!artist.is_admin, created_at: artist.created_at } });
  } catch (err) {
    console.error('Login error:', err.message);
    if (isFormSubmit) return res.redirect('/login?error=' + encodeURIComponent('Login failed'));
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', require('../middleware/auth'), async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, stage_name, email_verified, is_admin, created_at FROM artists WHERE id = $1', [req.artist.id]);
    const artist = result.rows[0];
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    res.json(artist);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// POST /api/auth/profile — save artist profile from dashboard
router.post('/profile', require('../middleware/auth'), async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  const { stage_name, pro, pro_other, ipi, dob, country, address1, address2, city, postal, state } = req.body;

  if (!stage_name) {
    if (isFormSubmit) return res.redirect('/details.html?error=' + encodeURIComponent('Artist / professional name is required'));
    return res.status(400).json({ error: 'Artist / professional name is required' });
  }

  const proValue = pro === 'Other' && pro_other ? pro_other : (pro || null);
  const addressStreet = [address1, address2].filter(Boolean).join(', ');

  // Convert MM/DD/YYYY → YYYY-MM-DD for PostgreSQL DATE column
  let dobValue = null;
  if (dob) {
    const parts = dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (parts) {
      dobValue = `${parts[3]}-${parts[1]}-${parts[2]}`;
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      dobValue = dob; // Already in ISO format
    }
  }

  try {
    await pool.query(
      `UPDATE artists SET stage_name=$1, pro=$2, ipi=$3, dob=$4,
       address_street=$5, address_city=$6, address_state=$7, address_postal=$8, address_country=$9, onboarded=TRUE
       WHERE id=$10`,
      [stage_name, proValue, ipi || null, dobValue,
       addressStreet || null, city || null, state || null, postal || null, country || null, req.artist.id]
    );

    // Send profile update notification to admin
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const artist = (await pool.query('SELECT name, email FROM artists WHERE id = $1', [req.artist.id])).rows[0];
      await resend.emails.send({
        from: 'Davincii <info@davincii.co>',
        to: 'info@davincii.co',
        subject: `Profile Updated: ${stage_name} (${artist.email})`,
        html: `
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A">
            <div style="background:linear-gradient(135deg,#0E2A78 0%,#060E28 100%);padding:28px 36px;text-align:center">
              <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:26px">
            </div>
            <div style="padding:36px;background:#ffffff;border:1px solid #E2E8F0;border-top:none">
              <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 6px;color:#0A0A0A">Artist Profile Updated</h2>
              <div style="width:28px;height:2px;background:#2260CC;margin-bottom:20px"></div>
              <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
                <tr><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8;width:130px">Artist Name</td><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${stage_name}</td></tr>
                <tr><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Email</td><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${artist.email}</td></tr>
                <tr><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">PRO</td><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${proValue || '—'}</td></tr>
                <tr><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">IPI</td><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${ipi || '—'}</td></tr>
                <tr><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">DOB</td><td style="padding:10px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">${dob || '—'}</td></tr>
                <tr><td style="padding:10px 0;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Address</td><td style="padding:10px 0;font-size:14px;color:#0A0A0A">${[address1, address2, city, state, postal, country].filter(Boolean).join(', ') || '—'}</td></tr>
              </table>
            </div>
            <div style="padding:18px 36px;text-align:center;font-size:11px;color:#94A3B8">Davincii Publishing Administration &middot; davincii.co</div>
          </div>`
      });
    } catch (emailErr) {
      console.error('[Profile notification] Failed:', emailErr.message);
    }

    if (isFormSubmit) return res.redirect('/');
    res.json({ success: true });
  } catch (err) {
    console.error('Profile update error:', err.message, err.stack);
    if (isFormSubmit) return res.redirect('/details.html?error=' + encodeURIComponent('Failed to save details'));
    res.status(500).json({ error: 'Failed to save details: ' + err.message });
  }
});

// POST /api/auth/complete-google-signup — finish Google OAuth signup with name + artist details
router.post('/complete-google-signup', require('../middleware/auth'), async (req, res) => {
  const { first_name, last_name, stage_name } = req.body;

  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First and last name are required' });
  }
  if (!stage_name) {
    return res.status(400).json({ error: 'Artist / stage name is required' });
  }

  const fullName = `${first_name.trim()} ${last_name.trim()}`;

  try {
    await pool.query(
      'UPDATE artists SET name=$1, stage_name=$2, onboarded=TRUE WHERE id=$3',
      [fullName, stage_name.trim(), req.artist.id]
    );

    // Get updated artist
    const result = await pool.query(
      'SELECT id, name, email, stage_name, created_at FROM artists WHERE id = $1',
      [req.artist.id]
    );
    const artist = result.rows[0];

    // Re-issue JWT with updated name
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name, is_admin: !!artist.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Send signup notification to admin with full details
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

      await resend.emails.send({
        from: 'Davincii <info@davincii.co>',
        to: 'info@davincii.co',
        subject: `New Google Signup: ${artist.stage_name} — ${artist.name} (${artist.email})`,
        html: `
          <div style="font-family:'Inter',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#0A0A0A">
            <div style="background:linear-gradient(135deg,#0E2A78 0%,#060E28 100%);padding:28px 36px;text-align:center">
              <img src="https://davincii.co/logo-white-sm.png" alt="Davincii" style="height:26px">
            </div>
            <div style="padding:36px;background:#ffffff;border:1px solid #E2E8F0;border-top:none">
              <h2 style="font-family:Georgia,serif;font-size:22px;font-weight:400;margin:0 0 6px;color:#0A0A0A">New Google Signup Complete</h2>
              <div style="width:28px;height:2px;background:#2260CC;margin-bottom:20px"></div>
              <p style="font-size:13px;color:#64748B;margin:0 0 28px;line-height:1.6">A new artist signed up via Google and completed their profile.</p>
              <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8;width:120px">Email</td>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">
                    <a href="mailto:${artist.email}" style="color:#2563EB;text-decoration:none">${artist.email}</a>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">First Name</td>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:15px;font-weight:600;color:#0A0A0A">${first_name.trim()}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Last Name</td>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:15px;font-weight:600;color:#0A0A0A">${last_name.trim()}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Artist / Stage Name</td>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:15px;font-weight:600;color:#0A0A0A">${artist.stage_name}</td>
                </tr>
                <tr>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:#94A3B8">Method</td>
                  <td style="padding:12px 0;border-bottom:1px solid #F1F5F9;font-size:14px;color:#0A0A0A">Google OAuth</td>
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
            </div>
            <div style="padding:18px 36px;text-align:center;font-size:11px;color:#94A3B8">
              Davincii Publishing Administration &middot; davincii.co
            </div>
          </div>`
      });
      console.log(`[Google signup notification] Email sent for: ${artist.email}`);
    } catch (emailErr) {
      console.error('[Google signup notification] Failed:', emailErr.message);
    }

    res.json({
      token,
      artist: { id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name, is_admin: !!artist.is_admin }
    });
  } catch (err) {
    console.error('Complete Google signup error:', err.message);
    res.status(500).json({ error: 'Failed to complete signup' });
  }
});

// POST /api/auth/verify-email — validate 6-digit code and activate account
router.post('/verify-email', async (req, res) => {
  const isFormSubmit = req.is('application/x-www-form-urlencoded');
  const { email, code } = req.body;

  if (!email || !code) {
    if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email || '') + '&error=' + encodeURIComponent('Please enter your verification code'));
    return res.status(400).json({ error: 'Email and code are required' });
  }
  try {
    const result = await pool.query('SELECT * FROM artists WHERE email = $1', [email]);
    const artist = result.rows[0];
    if (!artist || artist.email_verified) {
      if (isFormSubmit) return res.redirect('/login');
      return res.status(400).json({ error: 'Invalid request' });
    }

    // Check max attempts
    if (artist.verification_attempts >= 5) {
      if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email) + '&error=' + encodeURIComponent('Too many attempts. Please request a new code.'));
      return res.status(429).json({ error: 'Too many attempts. Please request a new code.' });
    }

    // Check expiry
    if (!artist.verification_code_expires || new Date(artist.verification_code_expires) < new Date()) {
      if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email) + '&error=' + encodeURIComponent('Code expired. Please request a new one.'));
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }

    // Check code
    if (artist.verification_code !== code.trim()) {
      await pool.query('UPDATE artists SET verification_attempts = verification_attempts + 1 WHERE id = $1', [artist.id]);
      if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email) + '&error=' + encodeURIComponent('Incorrect code. Please try again.'));
      return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    }

    // Code correct — verify the account
    await pool.query(
      'UPDATE artists SET email_verified=TRUE, verification_code=NULL, verification_code_expires=NULL, verification_attempts=0 WHERE id=$1',
      [artist.id]
    );

    // Issue JWT and redirect to dashboard
    if (isFormSubmit) {
      return res.redirect(authSuccessRedirect(artist, true));
    }
    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name, is_admin: !!artist.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, artist: { id: artist.id, name: artist.name, email: artist.email, stage_name: artist.stage_name || null, is_admin: !!artist.is_admin } });
  } catch (err) {
    console.error('Verify email error:', err.message);
    if (isFormSubmit) return res.redirect('/verify-email.html?email=' + encodeURIComponent(email) + '&error=' + encodeURIComponent('Verification failed'));
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/resend-verification — send a new code (60s cooldown)
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const result = await pool.query('SELECT id, name, email_verified, verification_last_sent FROM artists WHERE email = $1', [email]);
    const artist = result.rows[0];

    // Generic response to prevent email enumeration
    if (!artist || artist.email_verified) {
      return res.json({ success: true });
    }

    // 60-second cooldown
    if (artist.verification_last_sent) {
      const elapsed = Date.now() - new Date(artist.verification_last_sent).getTime();
      if (elapsed < 60000) {
        const wait = Math.ceil((60000 - elapsed) / 1000);
        return res.status(429).json({ error: `Please wait ${wait} seconds before requesting another code` });
      }
    }

    const code = await generateVerificationCode(artist.id);
    await sendVerificationEmail({ email, name: artist.name, code });
    res.json({ success: true });
  } catch (err) {
    console.error('Resend verification error:', err.message);
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// POST /api/auth/change-password
router.post('/change-password', require('../middleware/auth'), async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  try {
    const result = await pool.query('SELECT password_hash FROM artists WHERE id = $1', [req.artist.id]);
    const artist = result.rows[0];
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const valid = await bcrypt.compare(current_password, artist.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE artists SET password_hash = $1 WHERE id = $2', [newHash, req.artist.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Password change error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

module.exports = router;
