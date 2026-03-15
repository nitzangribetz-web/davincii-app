const express = require('express');
const router = express.Router();
const supabase = require('../db/supabase');
const auth = require('../middleware/auth');

// GET /api/payouts — get all payouts for the logged-in artist
router.get('/', auth, async (req, res) => {
  try {
    const { data: payouts, error } = await supabase
      .from('payouts')
      .select('*')
      .eq('artist_id', req.artist.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(payouts);
  } catch (err) {
    console.error('Get payouts error:', err.message);
    res.status(500).json({ error: 'Failed to fetch payouts' });
  }
});

// POST /api/payouts/request — request a payout
router.post('/request', auth, async (req, res) => {
  const { amount, method } = req.body;

  if (!amount || !method) {
    return res.status(400).json({ error: 'Amount and payment method are required' });
  }

  if (parseFloat(amount) < 10) {
    return res.status(400).json({ error: 'Minimum payout amount is $10.00' });
  }

  const validMethods = ['bank_transfer', 'paypal', 'stripe', 'check'];
  if (!validMethods.includes(method)) {
    return res.status(400).json({
      error: `Invalid payment method. Must be one of: ${validMethods.join(', ')}`
    });
  }

  try {
    const { data: payout, error } = await supabase
      .from('payouts')
      .insert([{
        artist_id: req.artist.id,
        amount,
        method,
        status: 'pending'
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(payout);
  } catch (err) {
    console.error('Request payout error:', err.message);
    res.status(500).json({ error: 'Failed to request payout' });
  }
});

// GET /api/payouts/summary — total paid out vs pending
router.get('/summary', auth, async (req, res) => {
  try {
    const { data: payouts, error } = await supabase
      .from('payouts')
      .select('amount, status')
      .eq('artist_id', req.artist.id);

    if (error) throw error;

    const totalPaid = payouts
      .filter(p => p.status === 'completed')
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    const totalPending = payouts
      .filter(p => p.status === 'pending')
      .reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);

    res.json({
      totalPaid: totalPaid.toFixed(2),
      totalPending: totalPending.toFixed(2),
      payoutCount: payouts.length
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payout summary' });
  }
});

module.exports = router;
