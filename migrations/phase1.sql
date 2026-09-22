-- Drix TalentHub — Phase 1 migration. Run ONCE in the Supabase SQL editor BEFORE deploying the new backend.
-- Safe to re-run (IF NOT EXISTS everywhere).

-- Module locking
ALTER TABLE modules ADD COLUMN IF NOT EXISTS unlock_at TIMESTAMPTZ;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS manual_lock BOOLEAN DEFAULT FALSE;
ALTER TABLE modules ADD COLUMN IF NOT EXISTS unlock_email_sent BOOLEAN DEFAULT FALSE;

-- Announcements
CREATE TABLE IF NOT EXISTS announcements (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  audience TEXT DEFAULT 'all',
  track_id UUID REFERENCES tracks(id),
  cohort_id UUID REFERENCES cohorts(id),
  posted_by UUID,
  posted_by_type TEXT DEFAULT 'admin',
  send_email BOOLEAN DEFAULT TRUE,
  is_active BOOLEAN DEFAULT TRUE,
  emailed_count INTEGER,
  emailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE announcements DISABLE ROW LEVEL SECURITY;

-- Grading attribution + one-time points award
ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS graded_by UUID;
ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS graded_by_type TEXT DEFAULT 'admin';
ALTER TABLE assignment_submissions ADD COLUMN IF NOT EXISTS points_awarded INTEGER DEFAULT 0;

-- Mentor scoping (mentors ship in Phase 2)
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS mentor_id UUID;
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS mentor_assigned_at TIMESTAMPTZ;

-- Email preferences
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN DEFAULT TRUE;

-- Email audit log
CREATE TABLE IF NOT EXISTS email_log (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  recipient_email TEXT,
  fellow_id UUID,
  email_type TEXT,
  subject TEXT,
  status TEXT DEFAULT 'sent',
  error TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE email_log DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_email_log_sent ON email_log(sent_at);

-- Payments: link to the fellow, and make a payment reference single-use
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fellow_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_fellows_payment_reference ON fellows(payment_reference) WHERE payment_reference IS NOT NULL;

-- Notification types the code uses ('alert' replaces the invalid 'error')
CREATE INDEX IF NOT EXISTS idx_submissions_status ON assignment_submissions(status);
