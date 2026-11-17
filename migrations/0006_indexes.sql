-- Voter List: two indexes for the small clean-up (the sessions and codes indexes already exist from 0004) that runs now and then (round 11 audit). Nothing else changes.
CREATE INDEX IF NOT EXISTS idx_voters_removed ON voters(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_rate_hits_ts ON rate_hits(ts);
