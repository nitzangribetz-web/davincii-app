const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

// Admin guard — must come after auth middleware
function adminOnly(req, res, next) {
  if (!req.artist || !req.artist.is_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// GET /api/admin/signups
router.get('/signups', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, email, stage_name, email_verified, onboarded, created_at
       FROM artists ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[admin] Failed to fetch signups:', err.message);
    res.status(500).json({ error: 'Failed to fetch signups' });
  }
});

module.exports = router;
