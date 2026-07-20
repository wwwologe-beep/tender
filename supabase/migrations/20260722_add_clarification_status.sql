-- Client Assistant clarification state machine for tender_orders.
-- Separate from the existing `status` column (bidding/selected/completed/... — the tender
-- lifecycle) since this tracks a different concern: whether the order description has enough
-- detail for drivers to quote confidently.

ALTER TABLE tender_orders
ADD COLUMN IF NOT EXISTS clarification_status text NOT NULL DEFAULT 'new'
  CHECK (clarification_status IN ('new', 'clarifying', 'ready', 'in_progress'));

ALTER TABLE tender_orders
ADD COLUMN IF NOT EXISTS missing_info text;

COMMENT ON COLUMN tender_orders.clarification_status IS
  'Client Assistant state machine: new (just created) -> clarifying (a driver flagged missing details via ask_client_question, client_bridge.py needs to call and ask) -> ready (details collected) -> in_progress (order proceeding). Independent of tender_orders.status.';

COMMENT ON COLUMN tender_orders.missing_info IS
  'Free-text description of what detail is missing, set when clarification_status becomes clarifying (e.g. the driver''s ask_client_question text). Read by client_bridge.py to know what to ask the client.';
