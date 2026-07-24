-- Атомарное добавление media URL к заказу.
-- Два почти одновременных входящих WhatsApp-сообщения с фото (обычный случай — Wappi может
-- прислать несколько фото за секунды) раньше делали read-modify-write из Node-кода: оба
-- запроса читали одно и то же старое значение media_urls, и второй Update перезаписывал
-- результат первого, теряя одно фото. Делая append внутри одного UPDATE на стороне Postgres,
-- конкурентные вызовы больше не могут друг друга затереть.
--
-- media_urls's actual column type (text[] vs jsonb) wasn't found in a migration file in this
-- repo (created directly in the Supabase dashboard earlier) — this version handles jsonb,
-- since that's what a "select media_urls" returning a plain JS array through supabase-js
-- most commonly means for a column added via the dashboard's "array" helper. If this errors
-- with a type mismatch when applied, the column is text[] instead — swap the SET line for:
--   SET media_urls = to_jsonb(array_append(COALESCE(ARRAY(SELECT jsonb_array_elements_text(media_urls)), ARRAY[]::text[]), p_media_url))
-- or, if truly text[]:
--   SET media_urls = array_append(COALESCE(media_urls, ARRAY[]::text[]), p_media_url)
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
     SET media_urls = COALESCE(media_urls, '[]'::jsonb) || to_jsonb(p_media_url)
   WHERE id = p_order_id;
END;
$$;
