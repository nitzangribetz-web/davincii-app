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
  // PayPal Payouts
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS paypal_email VARCHAR(255)`,
  `ALTER TABLE payouts ADD COLUMN IF NOT EXISTS paypal_batch_id VARCHAR(255)`,
  `ALTER TABLE payouts ADD COLUMN IF NOT EXISTS paypal_item_id  VARCHAR(255)`,
  // Artist profile / onboarding details
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS stage_name    VARCHAR(255)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS pro           VARCHAR(50)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS pro_role      VARCHAR(50)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS ipi           VARCHAR(20)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS dob           DATE`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_street  VARCHAR(255)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_city    VARCHAR(100)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_state   VARCHAR(100)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_postal  VARCHAR(20)`,
  `ALTER TABLE artists ADD COLUMN IF NOT EXISTS address_country VARCHAR(100)`,
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

  // ── Tax forms (W-9 / W-8BEN) ────────────────────────────────────────────
  // Decoupled from any single payout provider. The platform owns tax-form
  // collection so artists can choose any payout rail (Stripe, PayPal, …)
  // without re-doing tax info. One row per artist + form_type combination;
  // the most recent row is the active one (older rows are kept for audit).
  // NOTE: artists.id is UUID in prod (despite the baseTables declaration
  // above saying SERIAL — schema drift we haven't reconciled). Keep artist_id
  // as UUID here to match prod. routes/tax.js also self-heals.
  `CREATE TABLE IF NOT EXISTS tax_forms (
    id                SERIAL PRIMARY KEY,
    artist_id         UUID NOT NULL,
    form_type         VARCHAR(16) NOT NULL,
    status            VARCHAR(20) NOT NULL DEFAULT 'not_started',
    provider          VARCHAR(32),
    provider_form_id  VARCHAR(255),
    signed_pdf_url    TEXT,
    country           VARCHAR(8),
    tin_last4         VARCHAR(8),
    legal_name        VARCHAR(255),
    submitted_at      TIMESTAMPTZ,
    completed_at      TIMESTAMPTZ,
    expires_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tax_forms_artist ON tax_forms(artist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tax_forms_status ON tax_forms(status)`,

  // ── Payout methods ──────────────────────────────────────────────────────
  // Multiple payout rails per artist. The legacy artists.stripe_account_id
  // and artists.paypal_email columns remain populated for backwards compat,
  // but new code should read/write through this table.
  `CREATE TABLE IF NOT EXISTS payout_methods (
    id            SERIAL PRIMARY KEY,
    artist_id     INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    method_type   VARCHAR(32) NOT NULL,
    is_primary    BOOLEAN DEFAULT FALSE,
    status        VARCHAR(32) NOT NULL DEFAULT 'pending',
    external_id   VARCHAR(255),
    external_email VARCHAR(255),
    metadata      JSONB DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (artist_id, method_type)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_payout_methods_artist ON payout_methods(artist_id)`,
];

async function migrate() {
  try {
    await pool.query(baseTables);
  } catch (err) {
    console.error('[migrate] baseTables failed (continuing):', err.message);
  }
  try {
    await pool.query(passkeyTable);
  } catch (err) {
    console.error('[migrate] passkeyTable failed (continuing):', err.message);
  }
  for (const stmt of columnMigrations) {
    try {
      await pool.query(stmt);
    } catch (err) {
      console.error('[migrate] Statement failed (continuing):', err.message);
    }
  }
  console.log('[migrate] Schema ready');
}

module.exports = migrate;
