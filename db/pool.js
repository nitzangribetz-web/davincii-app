const { Pool } = require('pg');

const dbUrl = process.env.DATABASE_URL;
console.log('[pool] DATABASE_URL set:', !!dbUrl);
if (dbUrl) {
  const masked = dbUrl.substring(0, 50) + '...' + dbUrl.substring(dbUrl.length - 20);
  console.log('[pool] URL preview:', masked);
}

let poolConfig;
if (dbUrl) {
  try {
    const url = new URL(dbUrl);
    poolConfig = {
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.replace('/', ''),
      ssl: { rejectUnauthorized: false }
    };
    console.log('[pool] user:', poolConfig.user, 'host:', poolConfig.host, 'port:', poolConfig.port, 'db:', poolConfig.database);
  } catch (e) {
    console.error('[pool] URL parse error:', e.message);
    poolConfig = { connectionString: dbUrl, ssl: { rejectUnauthorized: false } };
  }
} else {
  console.error('[pool] DATABASE_URL is not set!');
  poolConfig = {};
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[pool] Unexpected pool error:', err.message);
});

module.exports = pool;
