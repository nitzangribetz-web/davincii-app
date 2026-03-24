const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const migrate = require('./db/migrate');
const authRoutes = require('./routes/auth');
const songRoutes = require('./routes/songs');
const royaltyRoutes = require('./routes/royalties');
const payoutRoutes = require('./routes/payouts');
const stripeRoutes = require('./routes/stripe');
const passkeyRoutes = require('./routes/passkeys');

const app = express();

app.use(cors());

// Stripe webhook MUST receive raw body — register before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// DB health check
const pool = require('./db/pool');
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/songs', songRoutes);
app.use('/api/royalties', royaltyRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/passkeys', passkeyRoutes);

// Serve frontend for all non-API routes
app.get('{*path}', (req, res) => {
  if (req.path.startsWith('/mobile.html')) {
    res.sendFile('mobile.html', { root: path.join(__dirname, 'public') });
  } else {
    res.sendFile('index.html', { root: path.join(__dirname, 'public') });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Davincii server running on port ${PORT}`);
  await migrate();
});
