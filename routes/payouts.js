const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const auth = require('../middleware/auth');

router.get('/summary', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT amount, status FROM payouts WHERE artist_id = $1', [req.artist.id]);
    const payouts = result.rows;
    const totalPaid = payouts.filter(p => p.status === 'completed').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    const totalPending = payouts.filter(p => p.status === 'pending').reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
    res.json({ totalPaid: totalPaid.toFixed(2), totalPending: totalPending.toFixed(2), payoutCount: payouts.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM payouts WHERE artist_id = $1 ORDER BY created_at DESC', [req.artist.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

router.post('/request', auth, async (req, res) => {
  const { amount, method } = req.body;
  if (!amount || !method) return res.status(400).json({ error: 'Amount and payment method are required' });
  if (parseFloat(amount) < 10) return res.status(400).json({ error: 'Minimum payout amount is $10.00' });
  const validMethods = ['bank_transfer', 'paypal', 'stripe', 'check'];
  if (!validMethods.includes(method)) return res.status(400).json({ error: 'Invalid payment method' });
  try {
    const result = await pool.query(
      'INSERT INTO payouts (artist_id, amount, method, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.artist.id, amount, method, 'pending']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to request payout' });
  }
});

module.exports = router;
