-- Tracks which call_candidates row asked a question, so the answer can be called back to the
-- exact same candidate (driver OR cold_contact — driver_id alone isn't enough since
-- cold_contact candidates have no tender_drivers row yet).

ALTER TABLE order_questions
ADD COLUMN IF NOT EXISTS candidate_id uuid REFERENCES call_candidates(id);

COMMENT ON COLUMN order_questions.candidate_id IS
  'call_candidates row that asked this question over a voice call (null for Telegram-only questions with no orchestrator attempt). Used to call the candidate back with the client''s answer once clarification_status becomes ready.';
