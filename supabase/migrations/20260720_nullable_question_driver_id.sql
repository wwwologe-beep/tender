-- Позволяет вопросам из голосового orchestrator'а (cold_contact без tender_drivers-записи)
-- сохраняться в order_questions и отображаться в фиде, не требуя привязки к конкретному
-- исполнителю. driver_id остаётся обязательным для вопросов из Telegram-бота (тот путь
-- по-прежнему всегда передаёт driver_id явно) — здесь только снимается ограничение схемы.
ALTER TABLE order_questions ALTER COLUMN driver_id DROP NOT NULL;
