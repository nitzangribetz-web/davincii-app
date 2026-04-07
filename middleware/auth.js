const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  // Prefer HttpOnly cookie; fall back to Authorization header for backward compat
  let token = req.cookies && req.cookies.dv_token;
  if (!token) {
    const authHeader = req.headers['authorization'];
    token = authHeader && authHeader.split(' ')[1]; // Bearer <token>
  }

  if (!token || token === 'null' || token === 'undefined') {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.artist = decoded;
    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;
