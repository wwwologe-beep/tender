-- Add preferred_lang column to cold_contacts
-- Used by Hermes to determine voice call language (ru/ka/en)

ALTER TABLE cold_contacts 
ADD COLUMN IF NOT EXISTS preferred_lang text DEFAULT 'ru';

COMMENT ON COLUMN cold_contacts.preferred_lang IS 
  'Primary language for voice calls: ru, ka, en. Default: ru. Set by Hermes from WhatsApp analysis.';

-- Also add last_call_outcome update helper
CREATE INDEX IF NOT EXISTS idx_cold_contacts_lang_spec 
  ON cold_contacts (preferred_lang, specialization);
