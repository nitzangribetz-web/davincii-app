const express = require('express');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const migrate = require('./db/migrate');
const authRoutes = require('./routes/auth');
const songRoutes = require('./routes/songs');
const royaltyRoutes = require('./routes/royalties');
const payoutRoutes = require('./routes/payouts');
const stripeRoutes = require('./routes/stripe');
const paypalRoutes = require('./routes/paypal');
const passkeyRoutes = require('./routes/passkeys');

const app = express();

// Security headers (allow inline scripts/styles for SPA, allow Google Fonts + CDN)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com", "https://cdnjs.cloudflare.com", "https://cdn.tailwindcss.com", "https://accounts.google.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdn.tailwindcss.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "https://davincii.co", "data:"],
      connectSrc: ["'self'", "https://www.googleapis.com", "https://accounts.google.com"],
      frameSrc: ["https://accounts.google.com", "https://demo.docusign.net", "https://na4.docusign.net"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
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
app.use('/api/auth/verify-email', authLimiter);
app.use('/api/auth/resend-verification', authLimiter);
app.use('/api/passkeys/login', authLimiter);

// Stripe webhook MUST receive raw body — register before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
// Anvil tax webhook — raw body for HMAC signature verification
app.use('/api/tax/webhook', express.raw({ type: '*/*' }));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
const publicDir = path.resolve(__dirname, 'public');

// Mobile detection — must run BEFORE express.static so it intercepts '/' requests
// express.static would otherwise serve index.html directly, bypassing the catch-all
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (!isMobile) return next();
  // On mobile: serve mobile.html for root and SPA routes, let static files through
  if (req.path === '/' || req.path === '/index.html') {
    return res.sendFile('mobile.html', { root: publicDir });
  }
  // For SPA routes (no extension, not /api/), serve mobile.html
  if (!req.path.startsWith('/api/') && !path.extname(req.path)) {
    return res.sendFile('mobile.html', { root: publicDir });
  }
  next();
});

app.use(express.static(publicDir));

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
app.use('/api/paypal', paypalRoutes);
app.use('/api/tax', require('./routes/tax'));
app.use('/api/payout-methods', require('./routes/payout-methods'));
app.use('/api/passkeys', passkeyRoutes);
app.use('/api/admin', require('./routes/admin'));

// Serve standalone auth pages for clean URLs
// Mobile gets SPA (mobile.html), desktop gets standalone pages (Safari credential autofill)
app.get('/login', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  res.sendFile(isMobile ? 'mobile.html' : 'login.html', { root: publicDir });
});
app.get('/signup', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  res.sendFile(isMobile ? 'mobile.html' : 'signup.html', { root: publicDir });
});
app.get('/verify-email', (req, res) => res.sendFile('verify-email.html', { root: publicDir }));

// Serve SPA for all non-API, non-static routes (catch-all)
// Detect mobile user-agents and serve mobile.html
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  const ua = req.headers['user-agent'] || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  res.sendFile(isMobile ? 'mobile.html' : 'index.html', { root: publicDir });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Davincii server running on port ${PORT}`);
  await migrate();
});
