-- Drix TalentHub — Phase 2 migration (Mentors). Run ONCE in the Supabase SQL editor before deploying.
-- Safe to re-run (IF NOT EXISTS everywhere).

-- MENTORS
CREATE TABLE IF NOT EXISTS mentors (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT,
  profile_photo TEXT,
  track_id UUID REFERENCES tracks(id),   -- track this mentor primarily supports (used as the default when admin bulk-assigns by track)
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE mentors DISABLE ROW LEVEL SECURITY;

-- fellows.mentor_id already exists (added in phase1.sql). Give it a real FK now that mentors exists,
-- so PostgREST can embed mentors(...) directly on a fellow row.
DO $$ BEGIN
  ALTER TABLE fellows ADD CONSTRAINT fk_fellows_mentor FOREIGN KEY (mentor_id) REFERENCES mentors(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_fellows_mentor ON fellows(mentor_id);

-- Messages: a fellow can message their mentor, not just admin. mentor_id is denormalized onto the
-- message row (copied from fellows.mentor_id at send time) so a mentor's own query never has to
-- trust anything the fellow sent — it's scoped by mentor_id = their own id.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_type TEXT DEFAULT 'admin' CHECK (recipient_type IN ('admin','mentor'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentor_id UUID REFERENCES mentors(id) ON DELETE SET NULL;
ALTER TABLE message_replies ADD COLUMN IF NOT EXISTS mentor_id UUID REFERENCES mentors(id) ON DELETE SET NULL;
ALTER TABLE message_replies ALTER COLUMN admin_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_mentor ON messages(mentor_id);

-- graded_by / graded_by_type already exist on assignment_submissions (phase1.sql) and are already
-- polymorphic (no hard FK), so a mentor can grade without any further schema change.
