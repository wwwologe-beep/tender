-- Migration: недельная подписка вместо поштучных комиссий
-- Запустить в Supabase SQL Editor

-- Убираем колонки из предыдущей миграции (если уже накатили)
ALTER TABLE tender_drivers
  DROP COLUMN IF EXISTS balance,
  DROP COLUMN IF EXISTS is_premium;

DROP INDEX IF EXISTS idx_drivers_premium;
DROP FUNCTION IF EXISTS deduct_driver_commission(uuid, numeric);

-- Добавляем подписку
ALTER TABLE tender_drivers
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz DEFAULT NULL;

-- Индекс для быстрой фильтрации активных подписчиков
CREATE INDEX IF NOT EXISTS idx_drivers_subscription
  ON tender_drivers (subscription_expires_at)
  WHERE subscription_expires_at IS NOT NULL;
