const pool = require('./pool');

const baseTables = `
  CREATE TABLE IF NOT EXISTS artists (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
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

const passkeyTable = `
  CREATE TABLE IF NOT EXISTS passkeys (
    id              TEXT PRIMARY KEY,
    artist_id       INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    public_key      BYTEA NOT NULL,
    counter         BIGINT NOT NULL DEFAULT 0,
    device_type     VARCHAR(32),
    backed_up       BOOLEAN DEFAULT FALSE,
    transports      TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW()
  );
`;

// Additive column migrations (idempotent)
const columnMigrations = [
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS stripe_account_id VARCHAR(255)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS stripe_onboarded  BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE payouts ADD COLUMN IF NOT EXISTS stripe_transfer_id VARCHAR(255)`,
  // Artist profile / onboarding details
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS stage_name    VARCHAR(255)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS pro           VARCHAR(50)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS pro_role      VARCHAR(50)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS ipi           VARCHAR(20)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS dob           DATE`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_street VARCHAR(255)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_city   VARCHAR(100)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_state  VARCHAR(100)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS onboarded     BOOLEAN DEFAULT FALSE`,
  // Email verification — columns first, then backfill
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS email_verified          BOOLEAN DEFAULT FALSE`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS verification_code       VARCHAR(6)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS verification_code_expires TIMESTAMPTZ`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS verification_attempts   INTEGER DEFAULT 0`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS verification_last_sent  TIMESTAMPTZ`,
  // Mark all existing accounts as verified (they signed up before email verification was added)
  `UPDATE artists SET email_verified = TRUE WHERE verification_code IS NULL AND (email_verified IS NULL OR email_verified = FALSE)`,
  // Admin flag
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`,
  // Widen pro column for "Other" PRO names
  `ALTER TABLE artists ALTER COLUMN pro TYPE VARCHAR(255)`,
];

async function migrate() {
  try {
    await pool.query(baseTables);
    await pool.query(passkeyTable);
    for (const stmt of columnMigrations) {
      try {
        await pool.query(stmt);
      } catch (err) {
        console.error('[migrate] Statement failed (continuing):', err.message);
      }
    }
    console.log('[migrate] Schema ready');
  } catch (err) {
    console.error('[migrate] Error:', err.message);
  }
}

module.exports = migrate;
