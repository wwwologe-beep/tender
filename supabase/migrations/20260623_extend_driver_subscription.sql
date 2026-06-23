-- Атомарное продление подписки водителя.
-- GREATEST гарантирует: если подписка ещё активна — дни прибавляются сверху,
-- а не от NOW() (водитель не теряет оставшиеся дни).
-- COALESCE обрабатывает NULL (новый водитель без подписки).
CREATE OR REPLACE FUNCTION extend_driver_subscription(
  p_driver_id uuid,
  p_days      int
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE tender_drivers
     SET subscription_expires_at =
           GREATEST(COALESCE(subscription_expires_at, NOW()), NOW())
           + (p_days || ' days')::interval
   WHERE id = p_driver_id;
END;
$$;
