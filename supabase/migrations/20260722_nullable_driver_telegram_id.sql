-- Позволяет создавать tender_drivers-записи для исполнителей без Telegram (phone-only
-- cold_contacts, конвертированные после того как согласились на цену по голосовому звонку —
-- см. handleAgreedOutcome в app/api/orchestrator/call-result/route.ts). Ранее telegram_id
-- был NOT NULL, из-за чего этот insert тихо падал (ошибка проглатывалась без .throwOnError())
-- и вся конверсия cold_contact -> driver никогда не сохранялась. Telegram-регистрация
-- по-прежнему всегда передаёт telegram_id явно — здесь только снимается ограничение схемы.
ALTER TABLE tender_drivers ALTER COLUMN telegram_id DROP NOT NULL;
