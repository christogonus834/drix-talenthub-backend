-- Drix TalentHub — Phase 5 migration (Multi-country). Run ONCE in Supabase SQL editor. Safe to re-run.
-- Existing fellows are backfilled to 'Nigeria' since that's who the platform has served so far.

ALTER TABLE fellows ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'Nigeria';
UPDATE fellows SET country = 'Nigeria' WHERE country IS NULL;
CREATE INDEX IF NOT EXISTS idx_fellows_country ON fellows(country);
