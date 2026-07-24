-- Отслеживание для debounced "спасибо за фото/видео" сообщения клиенту.
-- last_media_received_at обновляется на КАЖДОЕ входящее фото/видео (см.
-- append_order_media_url), media_thanks_sent_at ставится один раз, когда cron/tick замечает,
-- что прошло достаточно времени с последнего медиа и подтверждение ещё не отправлено —
-- так клиент, приславший подряд 10 фото, получает одно сообщение, а не по одному на каждое.
ALTER TABLE tender_orders
  ADD COLUMN IF NOT EXISTS last_media_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS media_thanks_sent_at timestamptz;
