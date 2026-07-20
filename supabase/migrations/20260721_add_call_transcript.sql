-- Add transcript column to order_call_attempts
-- Stores the full dialogue of a voice call for business/QA review of the AI's "script".
-- Format: jsonb array of { role: "ai" | "user" | "system", text: "...", timestamp: "..." }

ALTER TABLE order_call_attempts
ADD COLUMN IF NOT EXISTS transcript jsonb;

COMMENT ON COLUMN order_call_attempts.transcript IS
  'Array of { role: ai|user|system, text, timestamp } — full dialogue transcript of the voice call, populated by voice_bridge.py from OpenAI Realtime transcription events.';
