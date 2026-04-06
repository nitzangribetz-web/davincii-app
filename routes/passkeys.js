const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const rpName = 'Davincii';
const rpID = process.env.RP_ID || 'davincii.co';
const origin = process.env.APP_URL || 'https://davincii.co';

// In-memory challenge store (short-lived, per-session)
const challengeStore = new Map();

// POST /api/passkeys/register/options - Get registration options (authenticated)
router.post('/register/options', authMiddleware, async (req, res) => {
  try {
    const artist = req.artist;

    // Get existing passkeys for this user
    const existing = await pool.query('SELECT id, transports FROM passkeys WHERE artist_id = $1', [artist.id]);
    const excludeCredentials = existing.rows.map(row => ({
      id: row.id,
      type: 'public-key',
      transports: row.transports || [],
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: artist.email,
      userDisplayName: artist.name,
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    });

    // Store challenge temporarily
    challengeStore.set(`reg_${artist.id}`, options.challenge);
    setTimeout(() => challengeStore.delete(`reg_${artist.id}`), 120000);

    res.json(options);
  } catch (err) {
    console.error('Passkey register options error:', err.message);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// POST /api/passkeys/register/verify - Verify registration (authenticated)
router.post('/register/verify', authMiddleware, async (req, res) => {
  try {
    const artist = req.artist;
    const expectedChallenge = challengeStore.get(`reg_${artist.id}`);
    if (!expectedChallenge) {
      return res.status(400).json({ error: 'Registration challenge expired' });
    }

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Passkey verification failed' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    await pool.query(
      `INSERT INTO passkeys (id, artist_id, public_key, counter, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        credential.id,
        artist.id,
        Buffer.from(credential.publicKey),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        credential.transports || [],
      ]
    );

    challengeStore.delete(`reg_${artist.id}`);
    res.json({ verified: true });
  } catch (err) {
    console.error('Passkey register verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify passkey registration' });
  }
});

// POST /api/passkeys/login/options - Get authentication options (public)
router.post('/login/options', async (req, res) => {
  try {
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
    });

    // Store challenge by the challenge value itself
    challengeStore.set(`auth_${options.challenge}`, true);
    setTimeout(() => challengeStore.delete(`auth_${options.challenge}`), 120000);

    res.json(options);
  } catch (err) {
    console.error('Passkey login options error:', err.message);
    res.status(500).json({ error: 'Failed to generate authentication options' });
  }
});

// POST /api/passkeys/login/verify - Verify authentication (public)
router.post('/login/verify', async (req, res) => {
  try {
    const { id } = req.body;

    // Look up the credential
    const credResult = await pool.query('SELECT * FROM passkeys WHERE id = $1', [id]);
    if (credResult.rows.length === 0) {
      return res.status(400).json({ error: 'Passkey not found' });
    }
    const passkey = credResult.rows[0];

    // Get the challenge from the response
    const clientDataJSON = JSON.parse(Buffer.from(req.body.response.clientDataJSON, 'base64url').toString());
    const expectedChallenge = clientDataJSON.challenge;

    if (!challengeStore.get(`auth_${expectedChallenge}`)) {
      return res.status(400).json({ error: 'Authentication challenge expired' });
    }

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.id,
        publicKey: passkey.public_key,
        counter: passkey.counter,
        transports: passkey.transports || [],
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Passkey authentication failed' });
    }

    // Update counter
    await pool.query('UPDATE passkeys SET counter = $1 WHERE id = $2', [
      verification.authenticationInfo.newCounter,
      passkey.id,
    ]);

    challengeStore.delete(`auth_${expectedChallenge}`);

    // Get the artist and generate JWT
    const artistResult = await pool.query(
      'SELECT id, name, email, created_at FROM artists WHERE id = $1',
      [passkey.artist_id]
    );
    const artist = artistResult.rows[0];
    if (!artist) {
      return res.status(400).json({ error: 'Artist not found' });
    }

    const token = jwt.sign(
      { id: artist.id, email: artist.email, name: artist.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({ verified: true, token, artist });
  } catch (err) {
    console.error('Passkey login verify error:', err.message);
    res.status(500).json({ error: 'Failed to verify passkey authentication' });
  }
});

// GET /api/passkeys/list - List passkeys for authenticated user
router.get('/list', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, device_type, backed_up, transports, created_at FROM passkeys WHERE artist_id = $1 ORDER BY created_at DESC',
      [req.artist.id]
    );
    res.json({ passkeys: result.rows });
  } catch (err) {
    console.error('List passkeys error:', err.message);
    res.status(500).json({ error: 'Failed to list passkeys' });
  }
});

// DELETE /api/passkeys/:id - Delete a passkey
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM passkeys WHERE id = $1 AND artist_id = $2 RETURNING id',
      [req.params.id, req.artist.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Passkey not found' });
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('Delete passkey error:', err.message);
    res.status(500).json({ error: 'Failed to delete passkey' });
  }
});

module.exports = router;
