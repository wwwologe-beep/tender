-- Block N: Notification Queue
-- Запустить в Supabase SQL Editor (Dashboard → SQL Editor → New query)

CREATE TABLE IF NOT EXISTS tender_notification_queue (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid        NOT NULL REFERENCES tender_orders(id) ON DELETE CASCADE,
  driver_id       uuid        NOT NULL REFERENCES tender_drivers(id) ON DELETE CASCADE,
  telegram_id     bigint      NOT NULL,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'sent', 'failed')),
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,

  CONSTRAINT tender_notification_queue_order_driver_unique
    UNIQUE (order_id, driver_id)
);

-- Индексы для эффективной работы воркера
CREATE INDEX IF NOT EXISTS idx_notif_queue_status_created
  ON tender_notification_queue (status, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_notif_queue_order_id
  ON tender_notification_queue (order_id);

-- RLS: только service_role имеет доступ (Next.js использует service key)
ALTER TABLE tender_notification_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON tender_notification_queue
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
