const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const migrate = require('./db/migrate');
const authRoutes = require('./routes/auth');
const songRoutes = require('./routes/songs');
const royaltyRoutes = require('./routes/royalties');
const payoutRoutes = require('./routes/payouts');
const stripeRoutes = require('./routes/stripe');
const passkeyRoutes = require('./routes/passkeys');

const app = express();

// Security headers (allow inline scripts/styles for SPA, allow Google Fonts + CDN)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://davincii.co", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cors());

// Rate limiting on auth and passkey endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/signup', authLimiter);
app.use('/api/passkeys/login', authLimiter);

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
  if (req.path === '/m' || req.path.startsWith('/m/')) {
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
