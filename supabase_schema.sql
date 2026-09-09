-- ============================================
-- DRIX TECH TALENT PROGRAMME - SUPABASE SCHEMA
-- Run this entire file in your Supabase SQL Editor
-- ============================================

-- SETTINGS TABLE (admin-controlled global settings)
CREATE TABLE IF NOT EXISTS settings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value) VALUES
  ('payment_enabled', 'false'),
  ('adsense_enabled', 'false'),
  ('adsense_client_id', ''),
  ('adsense_slot_id', ''),
  ('site_name', 'Drix Tech Talent Programme'),
  ('registration_open', 'true')
ON CONFLICT (key) DO NOTHING;

-- TRACKS TABLE
CREATE TABLE IF NOT EXISTS tracks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  icon TEXT DEFAULT '💻',
  duration_weeks INTEGER DEFAULT 12,
  level TEXT DEFAULT 'Beginner',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO tracks (name, slug, description, icon, duration_weeks, level) VALUES
  ('Cybersecurity', 'cybersecurity', 'Learn to protect systems, networks and data from digital attacks.', '🔐', 16, 'Intermediate'),
  ('Ethical Hacking', 'ethical-hacking', 'Master penetration testing and ethical hacking techniques.', '🕵️', 16, 'Advanced'),
  ('Mobile App Development', 'mobile-app-development', 'Build iOS and Android applications from scratch.', '📱', 14, 'Beginner'),
  ('QA Testing', 'qa-testing', 'Learn software quality assurance and testing methodologies.', '🧪', 10, 'Beginner'),
  ('Software Engineering', 'software-engineering', 'Master the fundamentals of software design and development.', '⚙️', 20, 'Intermediate'),
  ('Python', 'python', 'Learn Python programming from basics to advanced applications.', '🐍', 12, 'Beginner'),
  ('JavaScript', 'javascript', 'Master JavaScript for web, server, and application development.', '🟨', 12, 'Beginner'),
  ('UI/UX Design', 'ui-ux', 'Design beautiful and user-friendly digital experiences.', '🎨', 10, 'Beginner'),
  ('Data Science', 'data-science', 'Analyse and interpret complex data to drive decisions.', '📊', 16, 'Intermediate'),
  ('Data Analysis', 'data-analysis', 'Learn tools and techniques for analysing datasets.', '📈', 12, 'Beginner'),
  ('DevOps', 'devops', 'Master CI/CD, cloud infrastructure, and DevOps practices.', '🔧', 14, 'Intermediate'),
  ('Graphics Design', 'graphics-design', 'Create stunning visual content for digital and print media.', '🖌️', 10, 'Beginner'),
  ('Product Management', 'product-management', 'Learn to lead product strategy, roadmaps, and teams.', '📋', 12, 'Intermediate')
ON CONFLICT (slug) DO NOTHING;

-- COHORTS TABLE
CREATE TABLE IF NOT EXISTS cohorts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  start_date DATE,
  end_date DATE,
  max_fellows INTEGER DEFAULT 1000,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO cohorts (name, description, start_date, end_date, max_fellows) VALUES
  ('Cohort 1', 'Pioneer cohort of Drix Tech Talent Programme', '2025-01-01', '2025-06-30', 500);

-- FELLOWS TABLE
CREATE TABLE IF NOT EXISTS fellows (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  state TEXT,
  gender TEXT,
  date_of_birth DATE,
  epayybillz_user_id TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  track_id UUID REFERENCES tracks(id),
  cohort_id UUID REFERENCES cohorts(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
  fellow_id TEXT UNIQUE,
  profile_photo TEXT,
  bio TEXT,
  linkedin_url TEXT,
  github_url TEXT,
  points INTEGER DEFAULT 0,
  payment_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ADMINS TABLE
CREATE TABLE IF NOT EXISTS admins (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin' CHECK (role IN ('super_admin', 'admin', 'moderator')),
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- COURSES TABLE
CREATE TABLE IF NOT EXISTS courses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  content_url TEXT,
  resource_type TEXT DEFAULT 'video' CHECK (resource_type IN ('video', 'article', 'pdf', 'quiz', 'project')),
  order_index INTEGER DEFAULT 0,
  duration_minutes INTEGER DEFAULT 60,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- FELLOW PROGRESS TABLE
CREATE TABLE IF NOT EXISTS fellow_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE CASCADE,
  completed BOOLEAN DEFAULT false,
  score INTEGER,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fellow_id, course_id)
);

-- ASSESSMENTS TABLE
CREATE TABLE IF NOT EXISTS assessments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id),
  title TEXT NOT NULL,
  description TEXT,
  questions JSONB DEFAULT '[]',
  passing_score INTEGER DEFAULT 70,
  duration_minutes INTEGER DEFAULT 30,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ASSESSMENT RESULTS TABLE
CREATE TABLE IF NOT EXISTS assessment_results (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  assessment_id UUID REFERENCES assessments(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  passed BOOLEAN NOT NULL,
  answers JSONB DEFAULT '{}',
  taken_at TIMESTAMPTZ DEFAULT NOW()
);

-- COMMUNITY POSTS TABLE
CREATE TABLE IF NOT EXISTS community_posts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  likes INTEGER DEFAULT 0,
  is_pinned BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- NOTIFICATIONS TABLE
CREATE TABLE IF NOT EXISTS notifications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info' CHECK (type IN ('info', 'success', 'warning', 'alert')),
  is_read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AUTO-GENERATE FELLOW ID FUNCTION
CREATE OR REPLACE FUNCTION generate_fellow_id()
RETURNS TRIGGER AS $$
DECLARE
  new_id TEXT;
  counter INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO counter FROM fellows;
  new_id := 'DRIX-' || LPAD(counter::TEXT, 5, '0');
  NEW.fellow_id := new_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_fellow_id
  BEFORE INSERT ON fellows
  FOR EACH ROW
  WHEN (NEW.fellow_id IS NULL)
  EXECUTE FUNCTION generate_fellow_id();

-- UPDATE TIMESTAMP FUNCTION
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fellows_updated_at
  BEFORE UPDATE ON fellows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS (Row Level Security) - disable for server-side access
ALTER TABLE fellows DISABLE ROW LEVEL SECURITY;
ALTER TABLE admins DISABLE ROW LEVEL SECURITY;
ALTER TABLE tracks DISABLE ROW LEVEL SECURITY;
ALTER TABLE cohorts DISABLE ROW LEVEL SECURITY;
ALTER TABLE courses DISABLE ROW LEVEL SECURITY;
ALTER TABLE settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE fellow_progress DISABLE ROW LEVEL SECURITY;
ALTER TABLE assessments DISABLE ROW LEVEL SECURITY;
ALTER TABLE assessment_results DISABLE ROW LEVEL SECURITY;
ALTER TABLE community_posts DISABLE ROW LEVEL SECURITY;
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;

-- ============================================
-- DEFAULT SUPER ADMIN (password: Admin@Drix2025)
-- Change password immediately after first login!
-- ============================================
INSERT INTO admins (full_name, email, password_hash, role)
VALUES (
  'Super Admin',
  'admin@drixtechtalent.com',
  '$2a$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.',
  'super_admin'
) ON CONFLICT (email) DO UPDATE SET password_hash = '$2a$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.';

-- ============================================
-- CERTIFICATES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS certificates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  certificate_id TEXT UNIQUE NOT NULL,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id),
  title TEXT NOT NULL DEFAULT 'Certificate of Completion',
  grade TEXT DEFAULT 'Pass',
  score INTEGER,
  issued_manually BOOLEAN DEFAULT false,
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE certificates DISABLE ROW LEVEL SECURITY;

-- Index for fast cert lookup
CREATE INDEX IF NOT EXISTS idx_certificates_cert_id ON certificates(certificate_id);
CREATE INDEX IF NOT EXISTS idx_certificates_fellow_id ON certificates(fellow_id);

-- ============================================
-- ADDITIONAL COLUMNS (run if upgrading)
-- ============================================
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS profile_photo TEXT;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS fellow_photo TEXT;

-- Fix admin password (run this to reset to Admin@Drix2025)
UPDATE admins SET password_hash = '$2a$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'
WHERE email = 'admin@drixtechtalent.com';


-- ============================================================
-- FIX #5 — NEW TABLES (run these if upgrading from old schema)
-- ============================================================

-- Payment log table
CREATE TABLE IF NOT EXISTS payments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reference TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  email TEXT,
  amount NUMERIC,
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;

-- Certificate requests (fellow requests, admin approves/rejects)
CREATE TABLE IF NOT EXISTS certificate_requests (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES admins(id),
  reject_reason TEXT
);
ALTER TABLE certificate_requests DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_cert_requests_fellow ON certificate_requests(fellow_id);

-- Track history (for multi-track re-enrolment)
CREATE TABLE IF NOT EXISTS fellow_track_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  track_id UUID REFERENCES tracks(id),
  cohort_id UUID REFERENCES cohorts(id),
  enrolled_at TIMESTAMPTZ DEFAULT NOW(),
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ
);
ALTER TABLE fellow_track_history DISABLE ROW LEVEL SECURITY;

-- New settings keys
INSERT INTO settings (key, value) VALUES
  ('registration_fee',       '0'),
  ('payment_currency',       'NGN'),
  ('payment_provider',       'flutterwave'),
  ('flutterwave_public_key', ''),
  ('flutterwave_secret_key', ''),
  ('paystack_public_key',    ''),
  ('paystack_secret_key',    ''),
  ('site_logo',              ''),
  ('site_favicon',           ''),
  ('slide_1',  'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=1600&q=80'),
  ('slide_2',  'https://images.unsplash.com/photo-1531482615713-2afd69097998?w=1600&q=80'),
  ('slide_3',  'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=1600&q=80'),
  ('slide_4',  'https://images.unsplash.com/photo-1504384308090-c894fdcc538d?w=1600&q=80'),
  ('sig1_name', 'Drix Tech Foundation Management'),
  ('sig1_logo', ''),
  ('sig2_name', 'ePayBillz Management'),
  ('sig2_logo', '')
ON CONFLICT (key) DO NOTHING;

-- Add payment columns to fellows table (for tracking who paid)
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS payment_reference TEXT;
ALTER TABLE fellows ADD COLUMN IF NOT EXISTS payment_provider  TEXT;

-- Add issued_manually to certificates if missing
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS issued_manually BOOLEAN DEFAULT FALSE;

-- Fix admin password (Admin@Drix2025) — run if needed
-- UPDATE admins SET password_hash = '$2a$12$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.'
-- WHERE email = 'admin@drixtechtalent.com';


-- ============================================================
-- V2 SCHEMA — Run this block in Supabase SQL Editor
-- ============================================================

-- MODULES (groups of lessons within a track)
CREATE TABLE IF NOT EXISTS modules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  order_index INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE modules DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_modules_track ON modules(track_id);

-- LESSONS (content within a module)
CREATE TABLE IF NOT EXISTS lessons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'video' CHECK (type IN ('video','pdf','document','article','audio','quiz')),
  content_url TEXT,
  content_text TEXT,
  duration_minutes INTEGER DEFAULT 0,
  points_reward INTEGER DEFAULT 10,
  order_index INTEGER DEFAULT 0,
  is_free_preview BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE lessons DISABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lessons_module ON lessons(module_id);

-- FELLOW LESSON PROGRESS
CREATE TABLE IF NOT EXISTS fellow_lesson_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES lessons(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ,
  completed BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMPTZ,
  UNIQUE(fellow_id, lesson_id)
);
ALTER TABLE fellow_lesson_progress DISABLE ROW LEVEL SECURITY;

-- ASSIGNMENTS
CREATE TABLE IF NOT EXISTS assignments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  module_id UUID REFERENCES modules(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  due_days INTEGER DEFAULT 7,
  max_score INTEGER DEFAULT 100,
  points_reward INTEGER DEFAULT 20,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE assignments DISABLE ROW LEVEL SECURITY;

-- ASSIGNMENT SUBMISSIONS
CREATE TABLE IF NOT EXISTS assignment_submissions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  assignment_id UUID REFERENCES assignments(id) ON DELETE CASCADE,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  content TEXT,
  file_url TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'submitted' CHECK (status IN ('submitted','graded','returned')),
  grade INTEGER,
  feedback TEXT,
  graded_at TIMESTAMPTZ,
  UNIQUE(assignment_id, fellow_id)
);
ALTER TABLE assignment_submissions DISABLE ROW LEVEL SECURITY;

-- EXAMS
CREATE TABLE IF NOT EXISTS exams (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  track_id UUID REFERENCES tracks(id) ON DELETE CASCADE UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  instructions TEXT,
  duration_minutes INTEGER DEFAULT 60,
  pass_score INTEGER DEFAULT 70,
  points_reward INTEGER DEFAULT 50,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE exams DISABLE ROW LEVEL SECURITY;

-- EXAM QUESTIONS
CREATE TABLE IF NOT EXISTS exam_questions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options JSONB, -- ["Option A", "Option B", "Option C", "Option D"]
  correct_answer TEXT NOT NULL,
  points INTEGER DEFAULT 1,
  order_index INTEGER DEFAULT 0
);
ALTER TABLE exam_questions DISABLE ROW LEVEL SECURITY;

-- EXAM ATTEMPTS
CREATE TABLE IF NOT EXISTS exam_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  answers JSONB,
  score INTEGER,
  passed BOOLEAN DEFAULT FALSE,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
ALTER TABLE exam_attempts DISABLE ROW LEVEL SECURITY;

-- MESSAGES (fellow to admin)
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fellow_id UUID REFERENCES fellows(id) ON DELETE CASCADE,
  subject TEXT DEFAULT 'General Enquiry',
  message TEXT NOT NULL,
  status TEXT DEFAULT 'unread' CHECK (status IN ('unread','read','replied')),
  sent_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;

-- MESSAGE REPLIES (admin to fellow)
CREATE TABLE IF NOT EXISTS message_replies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  admin_id UUID REFERENCES admins(id),
  reply TEXT NOT NULL,
  replied_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE message_replies DISABLE ROW LEVEL SECURITY;

-- FUNCTION: Safely increment fellow points
CREATE OR REPLACE FUNCTION increment_points(fellow_id UUID, amount INTEGER)
RETURNS void AS $$
BEGIN
  UPDATE fellows SET points = points + amount WHERE id = fellow_id;
END;
$$ LANGUAGE plpgsql;
