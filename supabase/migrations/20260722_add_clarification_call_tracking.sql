-- Tracks the Client Assistant clarification pause: when it started, and when the automated
-- voice callback (client_bridge.py) was last attempted — tender_orders.updated_at isn't
-- reliable for this (no auto-update trigger exists on this table), so a dedicated timestamp is
-- needed to know how long an order has been waiting on a client answer.

ALTER TABLE tender_orders
ADD COLUMN IF NOT EXISTS clarification_started_at timestamptz;

ALTER TABLE tender_orders
ADD COLUMN IF NOT EXISTS clarification_call_attempted_at timestamptz;

COMMENT ON COLUMN tender_orders.clarification_started_at IS
  'Set when clarification_status becomes clarifying (a driver''s ask_client_question). Cleared back to null once resolved. Used by the cron tick to know how long the order has been paused.';

COMMENT ON COLUMN tender_orders.clarification_call_attempted_at IS
  'Last time the cron tick auto-originated a client_bridge.py call for this order''s missing_info. Cleared back to null once resolved.';
