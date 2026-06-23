# 🧬 MUSHEBI.GE — SYSTEM DNA v4
# Обновлено: 24.06.2026 — после сессии локальной разработки с ngrok

## 1. VISION & PHILOSOPHY

- **Mission:** Широкопрофильная тендерная платформа для ЛЮБЫХ физических услуг в Грузии — не только транспорт.
- **Сервисы:** Грузчики, вывоз строительного мусора, переезды, клининг, мастера, разнорабочие, сборка мебели, перенос пианино.
- **North Star:** Economic Outcome для всех участников.
  - Исполнитель: зарабатывает честно и растёт
  - Заказчик: получает ценность, а не просто дешевизну
  - Платформа: здоровый рынок = долгосрочный рост
- **Business Model:** SaaS-подписка исполнителей 30₾/нед. Стоимость AI на 1 заказ ~0.55₾ — маржа комфортная.

## 2. AI EXECUTION PROTOCOL (Strict & Mandatory)

- **Architectural Role:** ИИ — "Партнер-Архитектор и Экономический Советник".
- **Read & Match:** Перед любой задачей сверяйся с этим манифестом И с `memory/MEMORY.md`.
- **Push Back:** Если задача нарушает ДНК (лишние клики, фичи ради фич, оверинжиниринг) — предложи упрощение.
- **Minimalism:** Минимально возможный код. Без неиспользуемых импортов.
- **Диагностика системы:**
  ```bash
  npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/diag.ts
  npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/test-full-cycle.ts
  ```

## 3. INFRASTRUCTURE & ENVIRONMENT

- **Frontend:** Next.js 15 (App Router), TypeScript, Tailwind CSS — деплой на **Vercel**
- **Database:** Supabase (PostgreSQL + Realtime)
- **AI:** OpenRouter API → `google/gemini-2.5-flash` (основная модель)
- **Telegram Bot:** grammy framework — регистрация исполнителей + уведомления
- **WhatsApp OTP:** Wappi.pro API — авторизация клиентов через WhatsApp (префикс `msb_`)
- **Scripts:** `ts-node -r tsconfig-paths/register --project scripts/tsconfig.json`

## 4. DATA STORAGE GRID (The Absolute Truth)

| Сущность | Таблица Supabase | Ключевые поля |
| :--- | :--- | :--- |
| **Заказы** | `tender_orders` | `token`, `cargo_description`, `live_brief_ai`, `status`, `category`, `client_phone`, `faq_summary`, `media_urls`, `order_number` |
| **Исполнители** | `tender_drivers` | `telegram_id`, `driver_language`, `rating`, `completed_orders`, `total_earned`, `status`, `subscription_expires_at`, `specialization` |
| **Ставки** | `tender_bids` | `order_id`, `driver_id`, `amount`, `status` (pending/winner/lost/withdrawn), `bot_state`, `comment` |
| **Вопросы** | `order_questions` | `question_original`, `answer_original`, `question_translated`, `answer_translated`, `status`, `answered_by` |
| **Агент-сессии** | `agent_sessions` | `role`, `user_id`, `order_id`, `messages` (last 20), `updated_at` |
| **Рынок** | `market_snapshots` | `order_id`, `category`, `final_price`, `avg_bid`, `min_bid`, `max_bid`, `bid_count` |
| **OTP коды** | `client_otp_codes` | `phone`, `code`, `expires_at` (10 мин) |
| **Клиенты** | `tender_clients` | `phone`, `session_token`, `last_login` |

## 5. MULTI-AGENT ECOSYSTEM (THE SOUL)

8 продакшн-агентов. Все через OpenRouter `google/gemini-2.5-flash`.

| # | Агент | Файл | Триггер | Токены |
|---|---|---|---|---|
| 1 | **Order Analyzer** | `lib/ai.ts:analyzeOrder()` | Создание заказа | ~800 |
| 2 | **FAQ Translator** | `lib/ai.ts:translateFaqEntry()` | Новый вопрос от исполнителя | ~400 |
| 3 | **Answer Translator** | `lib/ai.ts:translateFaqAnswer()` | Ответ клиента на вопрос | ~300 |
| 4 | **WhatsApp Greeter** | `lib/ai.ts:generateWhatsAppGreeting()` | Исполнитель выбран | ~200 |
| 5 | **Driver Advisor** | `lib/ai-advisor.ts:chatWithAdvisor(role=driver)` | Сообщение исполнителя боту | ~1,200 |
| 6 | **Client Advisor** | `lib/ai-advisor.ts:chatWithAdvisor(role=client)` | Сообщение заказчика на /feed | ~1,200 |
| 7 | **FAQ Rebuilder** | `lib/ai-advisor.ts:rebuildOrderFaq()` | После каждого ответа клиента | ~600 |
| 8 | **Q&A Auto-Answer** | `app/api/questions/ask/route.ts` | Похожий вопрос (Jaccard ≥0.6) | ~500 |

**Расход токенов на 1 заказ (полный цикл) ≈ 29,100 ≈ $0.006 ≈ 0.55₾**

## 6. FRONTEND PAGES & COMPONENTS

| Путь | Назначение |
|---|---|
| `app/page.tsx` | Главная — свободная форма создания заявки, drag&drop медиа |
| `app/feed/[token]/page.tsx` | Фид заказа — Realtime ставки, вопросы Q&A, выбор победителя |
| `app/profile/page.tsx` | Личный кабинет клиента — история заказов, 2 вкладки |
| `components/Navbar.tsx` | Общий хедер — переключатель языков RU/EN/KA, вход/профиль |
| `components/AuthModal.tsx` | Модалка входа — телефон → OTP 4 цифры → сессия |
| `lib/i18n.tsx` | i18n контекст — переводы RU/EN/KA для всего UI |
| `lib/auth-context.tsx` | Auth контекст — сессия клиента в localStorage |

## 7. API ROUTES

| Метод | Путь | Назначение |
|---|---|---|
| POST | `/api/tender/create` | Создание заказа (`structured:true` = без AI-гейткипера) |
| POST | `/api/tender/accept-bid` | Выбор победителя (atomic RPC) |
| POST | `/api/questions/ask` | Вопрос от исполнителя |
| POST | `/api/questions/answer` | Ответ заказчика |
| GET  | `/api/questions/list` | Список вопросов по заказу |
| POST | `/api/auth/send-otp` | Отправка OTP через WhatsApp (Wappi) |
| POST | `/api/auth/verify-otp` | Проверка OTP, выдача session token |

## 8. CORE PRODUCT LOGIC

- **Blind Bidding:** Клиент видит "Исполнитель #N" до выбора. После выбора — имя + телефон + WhatsApp.
- **Placeholder bids:** `sendTenderToDrivers()` создаёт bid с `amount=0` для каждого исполнителя. Фид фильтрует `.gt('amount', 0)`.
- **Soft Delete:** `status: bidding → selected → completed`. Физически не удаляется.
- **Live-Brief AI:** `cargo_description` неизменен. `live_brief_ai` обновляется после каждого Q&A через `rebuildOrderFaq()` (fire-and-forget).
- **Anti-Churn:** Если 10 мин без ставки → push всем через `checkAndNudgeDrivers()`.
- **Localization:** Исполнитель видит всё на своём языке (ka/ru/en). Карточка строится через `buildCard()` — единственный источник правды.
- **Subscription Gate:** `.gt('subscription_expires_at', now)` на уровне DB запроса. Без подписки — исполнитель не получает заказы.
- **7-дней триал:** При одобрении через `approve_with_trial` callback → RPC `extend_driver_subscription(p_days=7)`.

## 9. AUTHENTICATION

- **Исполнители:** Telegram бот → FSM (lang → name → phone → spec → pending) → одобрение администратором
- **Заказчики (Web):** Телефон → OTP через WhatsApp → session token в localStorage → `/profile`
- **Feed доступ:** `/feed/[token]` — публичный. `?driver_id=X` — показывает "Это ваша ставка".

## 10. RLS ПОЛИТИКИ (критично!)

Anon-клиент (браузер) должен иметь READ доступ к:
- `tender_orders` ✅
- `tender_bids` ✅
- `tender_drivers` ✅
- `order_questions` ✅ (добавлено 23.06.2026: `CREATE POLICY "anon can read questions" ON order_questions FOR SELECT USING (true)`)
- `client_otp_codes` ✅ (ALL для OTP flow)
- `tender_clients` ✅ (ALL для upsert)

## 11. KNOWN ISSUES & STATUS

| Проблема | Решение | Статус |
|---|---|---|
| `order_questions` RLS блокировала anon | Добавлена SELECT политика | ✅ Исправлено 23.06.2026 |
| Placeholder bids (amount=0) видны клиенту | Фильтр `.gt('amount', 0)` на фиде | ✅ Исправлено |
| Реальный исполнитель без подписки | `scripts/fix-sub.ts` — выдать подписку | ✅ Исправлено |
| Supabase JOIN возвращает array | `normalizeBids()` в feed/page.tsx | ✅ Исправлено |
| `gemini-flash-1.5` → 404 | Заменено на `google/gemini-2.5-flash` | ✅ Исправлено |
| Jaccard dedup кросс-языковой | Двухуровневый dedup: Jaccard + AI | ⚠️ В планах |
| `rebuildOrderFaq` fire-and-forget | На Vercel норма, локально — race | ⚠️ Принято |

## 12. SCRIPTS

| Скрипт | Назначение |
|---|---|
| `scripts/diag.ts` | Быстрая диагностика: исполнители, подписки, последние заказы |
| `scripts/test-full-cycle.ts` | E2E тест 25 шагов: создание → вопрос → ответ → ставка → выбор |
| `scripts/resend-simple.ts` | Повторная рассылка заказа исполнителям |
| `scripts/seed-demo.ts` | Сид демо-данных для локального тестирования |
| `scripts/fix-sub.ts` | Выдать 30-дневную подписку исполнителям без подписки |

## 13. EVOLUTION PROTOCOL

- **Перед каждой сессией:** прочитай `memory/MEMORY.md` + запусти `scripts/diag.ts`
- **После важных решений:** обнови `CLAUDE.md` + соответствующий файл в `memory/`
- **E2E тест:** `scripts/test-full-cycle.ts` — должен всегда быть 25/25
- **Метрики роста:** conversion rate (заказ → сделка), avg deal price, driver retention
- **Красные флаги:** конверсия < 40%, avg rating < 4.2, заказы без ставок > 15 мин
