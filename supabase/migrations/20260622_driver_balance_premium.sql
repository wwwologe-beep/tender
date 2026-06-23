-- Migration: добавляем balance и is_premium в tender_drivers
-- Запустить в Supabase SQL Editor

ALTER TABLE tender_drivers
  ADD COLUMN IF NOT EXISTS balance    numeric(10, 2) NOT NULL DEFAULT 0.00,
  ADD COLUMN IF NOT EXISTS is_premium boolean        NOT NULL DEFAULT false;

-- Индекс для быстрой фильтрации premium-водителей (используется в очереди уведомлений)
CREATE INDEX IF NOT EXISTS idx_drivers_premium
  ON tender_drivers (is_premium)
  WHERE is_premium = true;

-- ─── Атомарное списание комиссии ─────────────────────────────────────────────
-- Возвращает TRUE если средств хватило и списание прошло,
-- FALSE если баланс недостаточен (race-safe: FOR UPDATE блокирует строку).
CREATE OR REPLACE FUNCTION deduct_driver_commission(
  p_driver_id uuid,
  p_amount    numeric
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_balance numeric;
BEGIN
  -- Блокируем строку водителя на время транзакции
  SELECT balance INTO v_balance
    FROM tender_drivers
   WHERE id = p_driver_id
     FOR UPDATE;

  IF v_balance < p_amount THEN
    RETURN false;
  END IF;

  UPDATE tender_drivers
     SET balance = balance - p_amount
   WHERE id = p_driver_id;

  RETURN true;
END;
$$;
