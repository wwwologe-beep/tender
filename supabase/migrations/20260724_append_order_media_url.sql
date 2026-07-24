-- Атомарное добавление media URL к заказу.
-- Два почти одновременных входящих WhatsApp-сообщения с фото (обычный случай — Wappi может
-- прислать несколько фото за секунды) раньше делали read-modify-write из Node-кода: оба
-- запроса читали одно и то же старое значение media_urls, и второй Update перезаписывал
-- результат первого, теряя одно фото. Делая append внутри одного UPDATE на стороне Postgres,
-- конкурентные вызовы больше не могут друг друга затереть.
--
-- Confirmed via a direct RPC test call against a real row (2026-07-24): media_urls is
-- text[], not jsonb — the first jsonb version of this function always errored
-- ("COALESCE types text[] and jsonb cannot be matched"), silently dropping every photo
-- after it was deployed, not just concurrent ones. This version matches the real type.
CREATE OR REPLACE FUNCTION append_order_media_url(
  p_order_id uuid,
  p_media_url text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE tender_orders
     SET media_urls = array_append(COALESCE(media_urls, ARRAY[]::text[]), p_media_url)
   WHERE id = p_order_id;
END;
$$;
