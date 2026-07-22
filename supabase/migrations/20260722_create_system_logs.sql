-- Единая точка сбора логов со всех источников (текстовые AI-агенты на Vercel, голосовой
-- оркестратор на VPS, API-роуты) для последующего анализа — раньше логи были только
-- console.log/console.error, видны в реальном времени в Vercel/VPS логах и пропадают
-- после ротации, нет способа посмотреть их после факта одним запросом.
CREATE TABLE system_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,   -- 'ai-agent' | 'voice-call' | 'api' | 'webhook'
  tag         text NOT NULL,   -- напр. 'ai.analyzeOrder', 'orchestrator.confirmation-call', 'wappi-webhook'
  level       text NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
  order_id    uuid REFERENCES tender_orders(id) ON DELETE SET NULL,
  message     text NOT NULL,
  data        jsonb  -- произвольный контекст: request/response, transcript, args и т.д.
);

CREATE INDEX system_logs_created_at_idx ON system_logs (created_at DESC);
CREATE INDEX system_logs_order_id_idx ON system_logs (order_id);
CREATE INDEX system_logs_source_idx ON system_logs (source);

-- Только service role пишет/читает — это внутренний диагностический канал, не
-- клиентские данные, anon-доступ не нужен (в отличие от tender_orders/tender_bids).
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;
