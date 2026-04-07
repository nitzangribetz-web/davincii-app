const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// Admin guard — must come after auth middleware.
// Verifies is_admin from the DB rather than trusting the JWT claim, so that
// (a) tokens issued by flows that omit is_admin still work, and
// (b) admin revocation takes effect immediately without waiting for token expiry.
async function adminOnly(req, res, next) {
  try {
    if (!req.artist || !req.artist.id) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const result = await pool.query('SELECT is_admin FROM artists WHERE id = $1', [req.artist.id]);
    const row = result.rows[0];
    if (!row || !row.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.artist.is_admin = true;
    next();
  } catch (err) {
    console.error('[admin] adminOnly check failed:', err.message);
    return res.status(500).json({ error: 'Admin check failed' });
  }
}

// GET /api/admin/signups
router.get('/signups', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, stage_name, email_verified, onboarded,
              stripe_account_id, stripe_onboarded, created_at
       FROM artists ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[admin] Failed to fetch signups:', err.message);
    res.status(500).json({ error: 'Failed to fetch signups' });
  }
});

module.exports = router;
