const pool = require('./pool');

const migrations = `
  CREATE TABLE IF NOT EXISTS artists (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(255) NOT NULL,
    email      VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS songs (
    id           SERIAL PRIMARY KEY,
    artist_id    INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    title        VARCHAR(255) NOT NULL,
    isrc         VARCHAR(20),
    release_date DATE,
    status       VARCHAR(50) DEFAULT 'pending',
    created_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS royalties (
    id           SERIAL PRIMARY KEY,
    artist_id    INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    song_id      INTEGER REFERENCES songs(id) ON DELETE SET NULL,
    platform     VARCHAR(100) NOT NULL,
    amount       NUMERIC(12,2) NOT NULL DEFAULT 0,
    royalty_type VARCHAR(100),
    period       VARCHAR(50),
    created_at   TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS payouts (
    id         SERIAL PRIMARY KEY,
    artist_id  INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    amount     NUMERIC(12,2) NOT NULL,
    method     VARCHAR(50) NOT NULL,
    status     VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`;

async function migrate() {
  try {
    await pool.query(migrations);
    console.log('[migrate] Schema ready');
  } catch (err) {
    console.error('[migrate] Error:', err.message);
  }
}

module.exports = migrate;
