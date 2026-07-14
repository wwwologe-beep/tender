-- Block O: Order Call Orchestrator
-- Запустить в Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Схема описана в ARCHITECTURE.md §9 (AI-телефония) и в плане
-- C:\Users\pc\.claude\plans\resilient-wishing-dragonfly-agent-acea4dd29b955a3da.md

-- ─── 1. cold_contacts — "ещё не исполнитель" половина унифицированной абстракции ───

CREATE TABLE IF NOT EXISTS cold_contacts (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                 text        NOT NULL UNIQUE,
  name                  text,
  specialization        text,
  source                text        NOT NULL DEFAULT 'manual',
  notes                 text,
  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'do_not_call', 'converted')),
  converted_driver_id   uuid        REFERENCES tender_drivers(id) ON DELETE SET NULL,
  last_call_outcome     text,
  last_called_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cold_contacts_status_spec
  ON cold_contacts (status, specialization);

ALTER TABLE cold_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON cold_contacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 2. call_candidates — унифицированная абстракция, одна строка на (заказ, кандидат) ───

CREATE TABLE IF NOT EXISTS call_candidates (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid        NOT NULL REFERENCES tender_orders(id) ON DELETE CASCADE,
  candidate_type    text        NOT NULL CHECK (candidate_type IN ('driver', 'cold_contact')),
  driver_id         uuid        REFERENCES tender_drivers(id) ON DELETE CASCADE,
  cold_contact_id   uuid        REFERENCES cold_contacts(id) ON DELETE CASCADE,
  phone             text        NOT NULL,
  display_name      text,
  preferred_lang    text        NOT NULL DEFAULT 'ru',
  match_score       numeric     NOT NULL DEFAULT 0,
  rank              int,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT call_candidates_one_ref CHECK (
    (candidate_type = 'driver' AND driver_id IS NOT NULL AND cold_contact_id IS NULL) OR
    (candidate_type = 'cold_contact' AND cold_contact_id IS NOT NULL AND driver_id IS NULL)
  ),
  CONSTRAINT call_candidates_order_driver_unique UNIQUE (order_id, driver_id),
  CONSTRAINT call_candidates_order_contact_unique UNIQUE (order_id, cold_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_call_candidates_order_rank
  ON call_candidates (order_id, rank);

ALTER TABLE call_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON call_candidates
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 3. order_call_sequences — одна активная state machine на заказ ───

CREATE TABLE IF NOT EXISTS order_call_sequences (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                uuid        NOT NULL REFERENCES tender_orders(id) ON DELETE CASCADE,
  status                  text        NOT NULL DEFAULT 'queued'
                                      CHECK (status IN (
                                        'queued', 'calling', 'waiting_commitment',
                                        'advancing', 'succeeded', 'exhausted', 'cancelled'
                                      )),
  current_position        int         NOT NULL DEFAULT 0,
  candidate_count         int         NOT NULL DEFAULT 0,
  succeeded_candidate_id  uuid        REFERENCES call_candidates(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT order_call_sequences_one_active_per_order UNIQUE (order_id)
);

ALTER TABLE order_call_sequences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON order_call_sequences
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 4. order_call_attempts — одна строка на реальный исходящий звонок ───

CREATE TABLE IF NOT EXISTS order_call_attempts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id         uuid        NOT NULL REFERENCES order_call_sequences(id) ON DELETE CASCADE,
  order_id            uuid        NOT NULL REFERENCES tender_orders(id) ON DELETE CASCADE,
  candidate_id        uuid        NOT NULL REFERENCES call_candidates(id) ON DELETE CASCADE,
  position             int        NOT NULL,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN (
                                    'pending', 'originating', 'in_progress',
                                    'completed', 'failed_to_originate', 'timed_out'
                                  )),
  outcome             text        CHECK (outcome IN (
                                    'agreed', 'declined', 'no_answer', 'busy', 'voicemail',
                                    'needs_follow_up', 'error', 'abandoned'
                                  )),
  outcome_data        jsonb,
  asterisk_channel_id text,
  originated_at       timestamptz,
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Индекс для concurrency gate (lib/orchestrator/concurrency.ts) — читается на каждом cron tick
CREATE INDEX IF NOT EXISTS idx_call_attempts_inflight
  ON order_call_attempts (status)
  WHERE status IN ('originating', 'in_progress');

CREATE INDEX IF NOT EXISTS idx_call_attempts_order_status
  ON order_call_attempts (order_id, status);

ALTER TABLE order_call_attempts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON order_call_attempts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─── 5. Breadcrumb на tender_orders для "обзвон исчерпан, нужны глаза человека" ───

ALTER TABLE tender_orders
  ADD COLUMN IF NOT EXISTS orchestrator_flagged_at timestamptz;
