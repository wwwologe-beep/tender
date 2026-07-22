# ARCHITECTURE.md — mushebi.ge

> Техническая структура платформы: стек, схема БД, FSM, все агенты, весь голосовой
> оркестратор, известные технические грабли. Актуально на **23 июля 2026**.
> Текущее состояние/гэпы/приоритеты — см. `PROJECT.md`, это разные документы.

---

## 0. Что умеет система целиком (краткое резюме)

**Заявка может прийти из любого канала:**
- Сайт (`app/page.tsx`) — свободный текст + фото, AI сразу разбирает в структуру.
- WhatsApp — свободный текст, AI-гейткипер проверяет полноту перед созданием.
- **Входящий звонок на 2115325** (с 22.07.2026) — голосовой AI ведёт разговор, сам
  собирает детали и создаёт заказ (`create_order` tool), не только клиентская форма.

**Исполнитель узнаёт о заказе и торгуется по любому доступному каналу:**
- Telegram push (для подписанных, зарегистрированных исполнителей).
- Голосовой звонок (для холодных контактов и незарегистрированных — единственный канал,
  не требующий Telegram/интернета у получателя).

**Уточнение деталей — в обе стороны, любым каналом:**
- Исполнитель спрашивает по телефону → вопрос попадает в фид клиента + push + WhatsApp.
- Клиент отвечает на сайте **или прямо в WhatsApp** (с 22.07.2026) — не обязателен возврат
  на сайт.
- Если клиент долго молчит — система сама звонит ему голосом за него.
- Ответ клиента долетает обратно до исполнителя голосовым перезвоном, который теперь
  видит **полный контекст заказа**, а не только сырые вопрос/ответ (с 22.07.2026).

**Система узнаёт, кто звонит, а не считает каждый звонок анонимным:**
- Входящий звонок сверяется с `tender_drivers` по номеру — **известный исполнитель со
  своим активным заказом** получает контекст этого заказа и может задать по нему вопрос
  голосом, вместо того чтобы ему предлагали оставить новую заявку (с 22.07.2026).
- Входящий звонок также связывается с `tender_clients` (той же таблицей, что и веб-OTP)
  по номеру телефона — повторный звонящий узнаётся как тот же клиент на уровне данных
  (с 22.07.2026), хотя разговор пока не использует эту историю активно.

**Победитель узнаёт о выборе и получает контакт клиента, даже без Telegram:**
- Голосовой звонок-подтверждение + номер клиента произносится вслух и дублируется в
  WhatsApp — раньше AI отправлял phone-only исполнителя "на сайт/в бот", которых у него
  нет (исправлено 22.07.2026).

**Вся система логируется и тестируема без реальных звонков:**
- Полный prompt/response каждого из 8 текстовых и всех голосовых AI-агентов пишется в
  постоянную таблицу `system_logs`, скачивается локально для анализа.
- Логику голосового AI (включая нестандартные/каверзные ответы исполнителя) можно
  прогнать текстовым симулятором за секунды, без единого реального звонка.

Полные детали каждого пункта — в разделах ниже.

---

## 1. Обзор и бизнес-модель

**mushebi.ge** — мультиязычный тендерный маркетплейс физических услуг (грузчики,
переезды, клининг, ремонт, разнорабочие) для Тбилиси и Батуми. Клиент оставляет
заявку свободным текстом, AI её разбирает, исполнители делают слепые ставки, клиент
выбирает лучшую. Сделка — напрямую между клиентом и исполнителем, платформа не берёт
комиссию.

**Монетизация:** подписка исполнителей — 30₾/нед, 55₾/2нед, 100₾/мес. Заказчик платит 0₾.

**Категории универсальны с первого дня** — добавление новой (сантехники, отделочники)
это одна строка в `CATEGORY_TO_SPECS` (`lib/notification-queue.ts` — источник правды;
`lib/telegram/bot.ts` содержит устаревшую дублирующую копию, известный техдолг, не
устранён) и одна запись `specialization` у исполнителя. Структурных изменений БД не требует.

---

## 2. Технологический стек

| Слой | Технология |
|---|---|
| **Frontend** | Next.js 15 (App Router), TypeScript, Tailwind CSS |
| **Деплой** | Vercel (`tender-navy.vercel.app` — прод-адрес прямо сейчас, кастомный домен `mushebi.ge` НЕ подключён, см. `PROJECT.md` §4) |
| **База данных** | Supabase (PostgreSQL + Realtime + RLS) |
| **Telegram-бот** | [grammY](https://grammy.dev/) — webhook-режим |
| **WhatsApp** | Wappi.pro API (OTP-префикс `msb_`, входящие сообщения через один webhook) |
| **AI (текст)** | OpenRouter → `google/gemini-2.5-flash` |
| **AI (голос)** | OpenAI Realtime API (`gpt-realtime`) — отдельный ключ, не через OpenRouter |
| **Телефония** | Asterisk 22.5.2 на отдельном VPS (Kamatera, `79.108.163.50`), SIP-транк citynet.ge |
| **Скрипты** | `npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json <файл>` |

---

## 3. Схема базы данных (ключевые таблицы)

| Таблица | Ключевые поля | Назначение |
|---|---|---|
| `tender_orders` | `token`, `cargo_description`, `live_brief_ai`, `status`, `category`, `client_phone`, `scheduled_at`, `faq_summary`, `media_urls`, `order_number`, `clarification_status`, `missing_info` | Заказы |
| `tender_drivers` | `telegram_id` (nullable — см. ниже), `driver_language`, `rating`, `subscription_expires_at`, `specialization`, `status` | Исполнители |
| `tender_bids` | `order_id`, `driver_id`, `amount`, `status` | Ставки |
| `order_questions` | `question_original`, `answer_original`, `status`, `driver_id` (nullable), `candidate_id` | Вопросы Q&A |
| `agent_sessions` | `role`, `user_id`, `order_id`, `messages` (last 20) | История чата с текстовыми AI-советниками |
| `client_otp_codes`, `tender_clients` | `phone`, `code`/`session_token` | WhatsApp OTP-авторизация клиентов |
| `cold_contacts` | `phone`, `specialization`, `status` (`active`/`do_not_call`/`converted`), `converted_driver_id` | Внешние контакты, ещё не `tender_drivers` |
| `call_candidates` | `order_id`, `candidate_type` (`driver`/`cold_contact`), `match_score`, `rank` | Единая абстракция "кому звонить" |
| `order_call_sequences` | `order_id`, `status` (`queued→calling→advancing→succeeded/exhausted`), `current_position` | Очередь обзвона по заказу |
| `order_call_attempts` | `sequence_id`, `candidate_id`, `status`, `outcome`, `outcome_data`, `transcript` | Один реальный исходящий звонок |

**`tender_drivers.telegram_id` — nullable с 22.07.2026** (миграция
`20260722_nullable_driver_telegram_id.sql`). Раньше был `NOT NULL`, из-за чего конверсия
`cold_contact → tender_drivers` после согласия по голосовому звонку тихо падала на insert
(ошибка не проверялась) — вся эта ветка функционала не работала с 14.07 по 22.07,
обнаружено только живым тестом. См. `memory/cold-contact-driver-bug.md`.

**`order_questions.driver_id` — nullable с 20.07.2026** (миграция
`20260720_nullable_question_driver_id.sql`) — по той же причине: вопрос от `cold_contact`
(без `driver_id`) не мог сохраниться, пока constraint не был снят.

**`tender_clients` теперь связывается и с голосовым каналом** (с 22.07.2026) — раньше
только веб-OTP авторизация писала туда (`phone` unique). `create-order-from-call/route.ts`
теперь тоже делает upsert по номеру звонящего перед созданием заказа, так что один и тот
же номер телефона привязывается к одному профилю независимо от канала (сайт/OTP/звонок).

---

## 4. Мультиагентная экосистема

### Текстовые агенты (OpenRouter/Gemini, `lib/ai.ts` + `lib/ai-advisor.ts`)

| # | Агент | Файл | Триггер |
|---|---|---|---|
| 1 | Order Analyzer | `lib/ai.ts:analyzeOrder()` | Создание заказа (свободный текст → структура) |
| 2 | FAQ Translator | `lib/ai.ts:translateFaqEntry()` | Новый вопрос от исполнителя |
| 3 | Answer Translator | `lib/ai.ts:translateFaqAnswer()` | Ответ клиента на вопрос |
| 4 | Chat Translator | `lib/ai.ts:translateChatMessage()` | Сообщение в чате заказ↔исполнитель |
| 5 | Order Completeness Gatekeeper | `lib/ai.ts:validateOrderCompleteness()` | Свободный текст (WhatsApp), не веб-форма |
| 6 | WhatsApp Greeter | `lib/ai.ts:generateWhatsAppGreeting()` | Исполнитель выбран |
| 7 | Driver/Client Advisor | `lib/ai-advisor.ts:chatWithAdvisor()` | Сообщение в чат-советник (роль driver/client) |
| 8 | FAQ Rebuilder | `lib/ai-advisor.ts:rebuildOrderFaq()` | После каждого ответа клиента |

**Логирование (добавлено 22.07.2026):** все 8 функций логируют полный prompt+response в
консоль (`logAgentCall()` в обоих файлах) — видно в Vercel logs при любом реальном вызове.
Раньше логировались только ошибки, не сами запросы к модели. **С этой же даты каждый вызов
также пишется в постоянную таблицу `system_logs`** (см. §11) — консоль-логи Vercel исчезают
после ротации, `system_logs` — нет.

### Голосовые агенты (OpenAI Realtime, `lib/orchestrator/*` + `asterisk/voice_bridge.py`)

Пять разных типов звонка/разговора, разные tool-наборы — маршрутизация решается в
`voice_bridge.py:handle_call()` по наличию `attempt_id`/`preset_instructions` и, для
входящих звонков, по ответу `inbound-caller-context`:

1. **Звонок-предложение** (`prompts.ts:buildVoiceCallInstructions()`) — кандидату,
   tools: `report_outcome`, `ask_client_question`. Получает полный `buildOrderContext()`.
2. **Звонок-перезвон с ответом клиента** (`answer-callback.ts`) — после того как клиент
   ответил на вопрос с предыдущего звонка. **С 22.07.2026 тоже получает полный
   `buildOrderContext()`**, не только сырой текст вопрос/ответ — до этого агент мог
   только дословно повторить ответ клиента, даже если тот был не фактом, а отсылкой
   ("я же указал в заявке"), см. `memory/answer-callback-context-bug.md`.
3. **Звонок-подтверждение** (`confirmation-call.ts:confirmWinnerByCall()`) — победителю,
   если у него нет `telegram_id`. Tool: `report_confirmation_result`. С 22.07.2026 явно
   диктует номер телефона клиента голосом (не отсылает на "сайт/бот", которых у
   phone-only исполнителя нет) + дублирует номер клиента через WhatsApp после
   подтверждения (`confirmation-result/route.ts`).
4. **Входящий звонок — интейк заказа** (добавлено 22.07.2026): кто угодно звонит на
   2115325, номер не опознан как исполнитель с активным заказом — tool: `create_order`
   (`app/api/orchestrator/create-order-from-call/route.ts`). AI сам собирает суть задачи
   и создаёт реальный заказ тем же путём, что и веб-форма (`analyzeOrder()` + полный
   fan-out). Также upsert в `tender_clients` по номеру — повторный звонящий связывается
   с тем же профилем, что и веб-OTP авторизация.
5. **Входящий звонок — исполнитель про свой заказ** (добавлено 22.07.2026): номер
   звонящего найден в `tender_drivers` с непустым `active_order_id` — tool только
   `ask_client_question`, промпт содержит полный `buildOrderContext()` его активного
   заказа (`app/api/orchestrator/inbound-caller-context/route.ts`). Исполнитель без
   активного заказа (или неизвестный номер) падает в сценарий 4, а не получает
   отдельную ветку — он тоже может захотеть оставить заявку как клиент.

Все промпты используют общие блоки: `driverPricingRules()` (`lib/pricing-policy.ts`
— антидемпинг, B2B-наценка, защита от обхода платформы — единая ценовая политика для
текстовых и голосовых агентов, добавлено 20.07.2026) и тон/honesty-инструкции ("честно
скажи, что ты AI").

---

## 5. Order Call Orchestrator — полная механика

### Design

Для каждого заказа синхронно в `POST /api/tender/create` строится ранжированный список
кандидатов (`buildCallCandidates()`, `lib/orchestrator/matching.ts`) — объединяет
`tender_drivers` (активные, с подпиской, без подходящего Telegram-уведомления) и
`cold_contacts` (специализация подходит категории заказа) в единую таблицу
`call_candidates`. Звонок не стартует синхронно — `createCallSequence()` создаёт
`order_call_sequences` строку, а сам звонок инициирует `cron/tick` (внешний пинг раз в
~10 мин, единственный доступный механизм на Vercel Hobby) через `advanceCallSequences()`
(`lib/orchestrator/tick.ts`).

### Concurrency

`lib/orchestrator/concurrency.ts`: `MAX_CONCURRENT_CALLS` (env
`ORCHESTRATOR_MAX_CONCURRENT_CALLS`, default 4) — глобальный лимит по всей платформе
через `SELECT COUNT(*)` в Supabase (не in-process state, Vercel-функции не персистентны).
**Известный нерешённый race:** два overlapping cron-тика могут оба прочитать один и тот
же count и оба запустить звонок, превысив лимит на небольшую величину. Некритично при
текущем масштабе (лимит "около 4-5"), но не защищено claim-паттерном (`UPDATE ... WHERE
status='pending' RETURNING id`).

### Что происходит при согласии (`report_outcome: agreed`)

- **Кандидат — существующий `tender_drivers`**: создаётся обычная `tender_bids`
  (`status:'pending'`) — виден в фиде как любая другая ставка, финальное решение за
  клиентом через уже существующий `accept-bid`.
- **Кандидат — `cold_contact`**: конвертируется в `tender_drivers` (`status:'pending'`,
  `telegram_id: NULL` — работает с 22.07, см. §3) + создаётся ставка, `cold_contacts.status
  → 'converted'`.

### Клиентский Clarification-флоу (пауза заказа на вопрос)

Когда исполнитель на звонке задаёт вопрос без ответа в контексте — `ask_client_question`
tool → `POST /api/orchestrator/ask-question` → `tender_orders.clarification_status:
'clarifying'`, `missing_info` = текст вопроса, вопрос попадает в `order_questions`
(видно в фиде) + клиент получает push и WhatsApp-уведомление.

Клиент может ответить тремя способами, все ведут к одному `resolveClarificationAndRequeue()`
(`lib/orchestrator/clarification.ts`):
1. **На сайте** (`POST /api/questions/answer`).
2. **Прямо в WhatsApp** (добавлено 22.07.2026, `app/api/webhook/wappi/route.ts`) — любое
   входящее сообщение, не являющееся OTP-кодом, проверяется на совпадение номера с
   `tender_orders.client_phone`, ищется его `order_questions.status='pending'`, текст
   трактуется как ответ. Если у клиента несколько заказов с открытыми вопросами —
   используется WhatsApp reply/quote (`reply_message.body` от wappi.pro, содержит точный
   текст исходного вопроса) для точного мэтчинга, иначе фоллбэк на последний pending-вопрос
   этого номера. См. `memory/whatsapp-client-answers.md` — **не протестировано живым
   сообщением**.
3. **Голосом** (`client_bridge.py` звонит клиенту, если тот молчит >5 минут —
   `callClientsForClarification()` в `cron/tick`) → `POST
   /api/orchestrator/clarification-result`.

После снятия паузы — `callBackWithAnswer()` (`answer-callback.ts`) перезванивает
исполнителю с ответом (реальный `order_call_attempts`, не синтетический), И параллельно
`requeueForDriverCalls()` может продолжить обзвон следующих кандидатов — оба могут
происходить одновременно на одном заказе, осознанный трейд-офф (не блокировать весь
пайплайн ради одного разговора).

---

## 6. Голосовая инфраструктура (VPS, отдельно от Vercel)

Асинхронный, изолированный от прод-сайта сервер (Kamatera, `79.108.163.50`) — сознательное
решение не смешивать PBX с деплоем сайта.

| Компонент | Роль |
|---|---|
| Asterisk 22.5.2 | PBX/SIP-шлюз, транк citynet.ge (номер 2115325) |
| ARI (порт 8088) | REST+WebSocket управление звонками |
| `asterisk/voice_bridge.py` | Звонит исполнителям — `/originate` HTTP-сервер на порту 8090, мост Asterisk↔OpenAI Realtime |
| `asterisk/client_bridge.py` | Звонит клиентам (для clarification) — порт 8091, отдельный Stasis app `ai-telephony-client` |

### Архитектура одного звонка

```
Asterisk dialplan → Stasis(ai-telephony) → voice_bridge.py:
  1. Answer channel
  2. Создать externalMedia channel (RTP, µ-law)
  3. Создать ARI mixing bridge, добавить ОБА канала
     (без явного bridge звук не течёт, даже если externalMedia создан успешно)
  4. RTP-аудио ↔ OpenAI Realtime WebSocket (paced-отправка, 160 байт/20мс)
  5. Server-side VAD → естественный диалог + barge-in
```

### Известные технические грабли (не повторять)

1. `OpenAI-Beta: realtime=v1` заголовок ломает GA-подключение (`beta_api_shape_disabled`) — не добавлять.
2. externalMedia без явного ARI bridge не передаёт звук — 200 OK не значит "аудио течёт".
3. RTP нужно слать с точным таймингом (не как можно быстрее) — иначе звук искажён.
4. Формат `audio/pcmu` с обеих сторон — без ресемплинга.
5. `voice_bridge.py`/`client_bridge.py` — НЕ systemd-юниты, голые `nohup`-процессы. Не
   переживают reboot VPS или падение, тихо. Дважды ловили "мёртвую" телефонию из-за этого
   (20.07, 21.07) — известный, не устранённый техдолг.
6. SIP-порт (5060/udp) и `/originate` (8090) открыты всему интернету, без IP-ограничений —
   осознанный риск, `fail2ban` отложен.
7. **`nextjs_get`/`nextjs_post`/`ari_request` в `voice_bridge.py` синхронные (`urllib`, не
   `aiohttp`)** — блокируют весь asyncio event loop на время HTTP-запроса. Обычно
   некритично (запросы быстрые), но если Next.js-роут, вызванный из активного звонка, сам
   пытается инициировать НОВЫЙ звонок на тот же VPS-процесс (`/originate`) — второй запрос
   не может обработаться, пока event loop заблокирован на первом, и вызывающая сторона
   получает timeout, даже если сам первый запрос успешно завершается на сервере.
   Обнаружено живым тестом 22.07.2026 (см. `PROJECT.md` §3a) в `create-order-from-call` —
   исправлено точечно (не звонить синхронно из этого пути), но сама причина (блокирующий
   HTTP-клиент) остаётся в файле — будет повторяться в любом новом пути с такой же
   VPS→Vercel→тот-же-VPS цепочкой, если не отрефакторить на `aiohttp`.

---

## 7. Voice-сценарии — статус по развилкам (живые данные на 22.07.2026)

Полная карта веток диалога и что с ними происходит:

**Звонок-предложение:**
- Согласие сразу / отказ / автоответчик — работает.
- `needs_follow_up` — обрабатывается идентично `declined` (переход к следующему кандидату,
  а не повторный звонок этому же) — известный пробел, теряет хороших кандидатов, которые
  просто попросили перезвонить позже.
- Вопрос → ответ клиента → перезвон — работает, с 22.07 перезвон видит полный контекст заказа.
- Два вопроса за один звонок, обрыв связи посреди разговора — не протестировано целенаправленно.

**Звонок-подтверждение:**
- Подтверждение/отказ — работает, отказ откатывает заказ в `bidding` + push клиенту.
- Не отвечает/сбой — трактуется как `confirmed` (не молча отменяет реальный выбор клиента).
- Победитель задаёт вопрос — **не реализовано**, урезанный tool-набор без `ask_client_question`.
- Победитель называет другую цену на этом звонке — **не обрабатывается**, попадает в `notes`
  как текст, не меняет `tender_bids.amount` — источник потенциальной путаницы.

**Входящий звонок** (кто угодно звонит на 2115325): **с 22.07.2026 больше не пропадает
бесследно.** `handle_call()` сначала определяет роль звонящего через
`fetch_inbound_caller_context()` (`GET /api/orchestrator/inbound-caller-context`, ищет
номер в `tender_drivers`):
- **Известный исполнитель с активным заказом** → tool только `ask_client_question`,
  полный контекст его заказа в промпте — может спросить про свой же заказ голосом.
- **Неизвестный номер, или исполнитель без активного заказа** → tool `create_order` —
  тот же intake-флоу, что описан в §4 (сценарий 4): AI собирает суть задачи, создаёт
  реальный заказ через `create-order-from-call`, upsert в `tender_clients` по номеру.
- Если запрос роли к Next.js падает (сеть, тайм-аут) — fallback на "неизвестный", то есть
  client intake, а не отказ обслуживать звонок — осознанный выбор (ложное "это клиент" для
  реального исполнителя это лёгкое неудобство, а ложное "это исполнитель" для реального
  клиента — потерянный лид).

Номер звонящего берётся из ARI `channel.caller.number` (нормализуется с `+`).
**Ни одна из двух веток не протестирована реальным входящим звонком** — код задеплоен и
на Vercel, и на VPS (`voice_bridge.py` перезапущен дважды в ходе разработки), но живой
проверки ещё не было ни разу.

**Кросс-сценарные:**
- Два кандидата "agreed" почти одновременно — не защищено от гонки на уровне звонков
  (только `accept_bid_atomic` на финальном выборе клиента защищён), некритично.
- Заказ закрывается пока звонок уже идёт — `call-result` не перепроверяет статус заказа
  повторно, может создать ставку на уже закрытый заказ — небольшой пробел.

---

## 8. RLS-матрица

| Таблица | anon SELECT | anon INSERT/UPDATE | Примечание |
|---|---|---|---|
| `tender_orders`, `tender_bids`, `tender_drivers` | ✅ | ❌ | Пишет только service role |
| `order_questions` | ✅ | ❌ | Добавлена 23.06.2026 |
| `client_otp_codes`, `tender_clients` | ✅ | ✅ (ALL) | Нужен upsert для OTP-флоу |
| `system_logs` | ❌ | ❌ | Только service role — внутренний диагностический канал, не клиентские данные |

---

## 9. Переменные окружения

| Переменная | Где | Описание |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Vercel | Supabase |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ID`, `TELEGRAM_ADMIN_CHAT_ID` | Vercel | Бот и модерация |
| `WAPPI_TOKEN`, `WAPPI_PROFILE_ID` | Vercel | WhatsApp |
| `OPENROUTER_API_KEY` | Vercel | Текстовые AI-агенты |
| `NEXT_PUBLIC_APP_URL` | Vercel | Прод-URL для ссылок клиентам (сейчас `tender-navy.vercel.app` — многие места ещё хардкодят `mushebi.ge`, см. `PROJECT.md`) |
| `ORCHESTRATOR_BRIDGE_SECRET` | Vercel + VPS | Общий bearer-секрет Next.js ↔ `voice_bridge.py` |
| `ASTERISK_BRIDGE_URL` | Vercel | `http://<vps>:8090` |
| `CLIENT_BRIDGE_URL` | Vercel | `http://<vps>:8091` |
| `ORCHESTRATOR_MAX_CONCURRENT_CALLS` | Vercel | Опционально, default 4 |
| `ORCHESTRATOR_CALLER_ID` | Vercel | Caller ID исходящих звонков |
| `OPENAI_API_KEY` | VPS | OpenAI Realtime — отдельный ключ, не OpenRouter |
| `ORCHESTRATOR_TEST_PHONE` | VPS `.voice_bridge.env` | Если задан — ЛЮБОЙ голосовой звонок уходит на этот номер вместо реального адресата. Использовать для тестов, снять/сменить перед боевым режимом. |

---

## 10. Диагностика и тестирование

```bash
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/diag.ts
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/test-full-cycle.ts
```

`scripts/diag.ts` — список исполнителей, кто получит уведомления, последние заказы.
`scripts/simulate-voice-call.ts` — симулирует голосовой звонок текстом, без реального
Asterisk/минут: строит настоящий `buildVoiceCallInstructions()`-промпт, прогоняет диалог
между голосовым AI и второй LLM, играющей исполнителя по пресету личности. 12 пресетов:
`reasonable`, `haggler`, `confused`, `vague_answer`, `rude_hangup`, `other_language`,
`silent_then_price`, `dumping_price`, `overpriced_b2b`, `double_question`, `changes_mind`,
`weird_price_format`. Дешёвый первый фильтр для проверки логики диалога (правильные ли
tool-calls, не путается ли AI, не зависает ли разговор без исхода) перед реальным звонком
— не проверяет качество голоса/распознавания речи. Полный транскрипт в `system_logs`
(`tag=simulate-voice-call`). Уже нашёл и помог починить 2 реальных бага в промпте (см.
`memory/voice-call-simulator.md`) — не трогает ценообразование намеренно (см.
`memory/pricing-not-to-touch.md`).
`scripts/test-full-cycle.ts` — E2E 25 шагов текстового цикла (создание → вопрос → ответ →
ставка → выбор). Не покрывает голосовой оркестратор — тот проверяется только живыми звонками.

---

## 11. Персистентное логирование (`system_logs`, добавлено 22.07.2026)

Console.log/console.error видны только в реальном времени и исчезают после ротации логов
Vercel/VPS — не было способа посмотреть конкретный инцидент после факта одним запросом.
Таблица `system_logs` (миграция `20260722_create_system_logs.sql`) — единая точка сбора:

| Поле | Назначение |
|---|---|
| `source` | `ai-agent` \| `voice-call` \| `api` \| `webhook` |
| `tag` | Имя функции/точки (`ai.analyzeOrder`, `orchestrator.call-result`, `wappi-webhook.incoming`) |
| `order_id` | Привязка к заказу, если применимо (nullable) |
| `data` | Произвольный JSON — полный prompt/response, transcript, args входящего запроса |

**Что уже пишет туда (`lib/system-log.ts:logSystemEvent()`):**
- Все 8 текстовых AI-агентов — полный prompt + response (`logAgentCall()` в `lib/ai.ts`/`lib/ai-advisor.ts`).
- Голосовой system-prompt для каждого исходящего звонка (`prompts.ts:buildVoiceCallInstructions()`).
- Результат каждого звонка — исход, транскрипт, `tool_result` (`call-result/route.ts`).
- Каждое входящее WhatsApp-сообщение (`webhook/wappi/route.ts`) — текст, isReply, quoted text.

**Не пишет туда:** `voice_bridge.py`/`client_bridge.py` на VPS — у них нет прямого доступа
к Supabase (секреты намеренно не выносятся на VPS), сама суть разговора уже покрыта через
Next.js callback'и выше. `voice_bridge.log` на VPS остаётся вторичным источником для
низкоуровневой ARI/RTP-диагностики (создание bridge, RTP-порты), не для анализа диалогов.

**Как скачать логи для анализа:**
```bash
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --hours=2
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --order=<order_id>
npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --source=voice-call
```
Сохраняет в `logs/` (gitignored) два файла с временной меткой: `.jsonl` (полные данные,
по записи на строку) и `.txt` (читаемый формат для быстрого просмотра).
