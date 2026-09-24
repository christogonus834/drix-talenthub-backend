-- Drix TalentHub — Phase 4 migration (Forgot Password, OTP-based). Run ONCE in Supabase SQL editor.
-- Safe to re-run. reset_token_hash stores the hashed 6-digit OTP (not a link token).

ALTER TABLE fellows ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS reset_otp_attempts SMALLINT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_fellows_reset_token ON fellows(reset_token_hash) WHERE reset_token_hash IS NOT NULL;

ALTER TABLE mentors ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE mentors ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE mentors ADD COLUMN IF NOT EXISTS reset_otp_attempts SMALLINT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_mentors_reset_token ON mentors(reset_token_hash) WHERE reset_token_hash IS NOT NULL;

ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_hash TEXT;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_otp_attempts SMALLINT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_admins_reset_token ON admins(reset_token_hash) WHERE reset_token_hash IS NOT NULL;
