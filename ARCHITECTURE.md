# ARCHITECTURE.md — mushebi.ge

> Техническая и бизнес-документация платформы.  
> Актуальна на: **23 июня 2026**. E2E тест: 25/25 ✅. Поддерживать в синхронизации с `CLAUDE.md`.

---

## 1. Обзор проекта и бизнес-логика

### Концепция

**mushebi.ge** — мультиязычный тендерный маркетплейс **любых физических услуг** для Тбилиси и Батуми. Клиент оставляет свободную текстовую заявку (переезд, клининг, ремонт, разнорабочие — что угодно), исполнители делают ставки вслепую, клиент выбирает лучшее предложение. Платформа зарабатывает на еженедельной подписке исполнителей.

**Ключевые участники:**

| Роль | Канал | Язык |
|---|---|---|
| Клиент (заказчик) | Web `/` (форма) → `/feed/[token]` + `/profile` | RU / EN / KA |
| Исполнитель | Telegram-бот `@mushebi_bot` | RU / KA / EN |
| Администратор | Закрытый Telegram-чат (`TELEGRAM_ADMIN_CHAT_ID`) | RU |

### Бизнес-модель

```
Исполнитель платит 30 ₾/неделю (безлимитные отклики)
Стоимость AI-обработки одного заказа ≈ 0.55 ₾
Маржа на подписку: комфортная при любом объёме откликов
```

Комиссия per-bid **отсутствует** — модель подписки снимает трение и мотивирует откликаться активно.

### MVP и стратегия масштабирования

**Старт:** универсальная платформа — любые физические задачи. AI определяет категорию автоматически из свободного текста.

**Архитектура категорий универсальна с первого дня:**

```typescript
const CATEGORY_TO_SPECS: Record<string, string[]> = {
  moving:      ['mover', 'driver', 'moving', 'handyman'],
  transport:   ['driver', 'mover', 'moving'],
  cleaning:    ['handyman', 'cleaner', 'cleaning'],
  repair:      ['handyman', 'electrician', 'plumber', 'repair'],
  electricity: ['electrician', 'handyman', 'electrical'],
  plumbing:    ['plumber', 'handyman', 'plumbing'],
  general:     ['mover', 'driver', 'handyman', 'electrician', 'plumber', ...],
};
```

Добавление новой категории (сантехники, отделочники, спецтехника) — это одна строка в `CATEGORY_TO_SPECS` и одна запись `specialization` в профиле исполнителя. Никаких структурных изменений БД не требуется.

---

## 2. Технологический стек

| Слой | Технология |
|---|---|
| **Frontend** | Next.js 15 (App Router), TypeScript, Tailwind CSS |
| **Деплой** | Vercel (edge functions) |
| **База данных** | Supabase (PostgreSQL 15 + Realtime + RLS) |
| **Telegram-бот** | [grammY](https://grammy.dev/) — webhook-режим |
| **WhatsApp** | Wappi.pro API (prefix `msb_` сессий) |
| **AI** | OpenRouter → `google/gemini-2.5-flash` |
| **Тесты** | `ts-node --esm`, кастомные скрипты `scripts/test-*.ts` |
| **E2E симулятор** | `scripts/run-e2e-sandbox.ts` — CLI с реальной БД |

---

## 3. Архитектура базы данных и биллинга

### Таблица `tender_drivers`

| Поле | Тип | Описание |
|---|---|---|
| `id` | `uuid` | Primary key |
| `telegram_id` | `bigint` | ID пользователя в Telegram; `NULL` до регистрации |
| `name` | `text` | Имя и фамилия исполнителя |
| `phone` | `text` | Номер в формате `+995XXXXXXXXX`; уникален |
| `status` | `enum` | `registering` → `pending` → `active` \| `blocked` \| `rejected` |
| `driver_language` | `text` | `ru` \| `ka` \| `en` — язык интерфейса бота |
| `specialization` | `text` | `mover` \| `driver` \| `handyman` \| ... |
| `subscription_expires_at` | `timestamptz` | `NULL` = нет подписки; дата в прошлом = истекла |
| `rating` | `float4` | Средний балл (1–5) |
| `rating_sum` | `int4` | Сумма всех оценок (для пересчёта) |
| `rating_count` | `int4` | Число оценок |
| `completed_orders` | `int4` | Счётчик завершённых заказов |
| `total_earned` | `numeric` | Суммарный заработок (₾) |
| `reg_state` | `jsonb` | FSM-состояние в процессе регистрации; `NULL` у активных |
| `active_order_id` | `uuid` | Текущий активный заказ (FK → `tender_orders`) |
| `created_at` | `timestamptz` | Дата регистрации |

### Тарифная сетка (`TARIFF_PLANS`)

```typescript
export const TARIFF_PLANS = [
  { id: '1_week',  label: '1 неделя', days: 7,  price: 30  },
  { id: '2_weeks', label: '2 недели', days: 14, price: 55  },
  { id: '1_month', label: '1 месяц',  days: 30, price: 100 },
] as const;

export type TariffPlanId = typeof TARIFF_PLANS[number]['id'];
```

### RPC-функция `extend_driver_subscription`

```sql
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
```

**Математика защиты от race conditions:**

```
COALESCE(subscription_expires_at, NOW())
  → если поле NULL (новый водитель), берём NOW() как базу

GREATEST(..., NOW())
  → если подписка уже истекла (дата в прошлом), берём NOW()
  → если подписка ещё активна, сохраняем будущую дату как базу

+ (p_days || ' days')::interval
  → прибавляем купленные дни поверх базы
```

**Сценарии:**

| Состояние до | `p_days` | Результат |
|---|---|---|
| `NULL` (новый) | 7 | `NOW() + 7 days` |
| Истекла 3 дня назад | 7 | `NOW() + 7 days` (не -3+7=4) |
| Активна, осталось 5 дней | 7 | `expires + 7 days` (= 12 дней суммарно) |

Функция гарантирует: водитель **никогда не теряет** уже оплаченные дни при досрочном продлении.

### Subscription Gate (фильтр на уровне БД)

Все запросы к активным исполнителям содержат условие:

```typescript
.gt('subscription_expires_at', new Date().toISOString())
```

Применяется в трёх местах:
1. `enqueueOrderNotifications()` — отбор получателей уведомлений
2. `sendTenderToDrivers()` — прямая рассылка через бот
3. `handleBidByToken()` — проверка перед созданием ставки

---

## 4. Конечная машина состояний (FSM) регистрации

### Граф состояний

```
/start
  │
  ├── [уже активен] → показать статус подписки (/profile-like)
  │
  └── [новый / сброс] → reg_state = { step: 'lang' }
        │
        ▼
   [inline] Выбор языка: 🇬🇪 KA / 🇷🇺 RU / 🇬🇧 EN
        │  callback: reg_lang:<lang>
        ▼
   reg_state = { step: 'name', lang }
   Запрос имени (text-input, локализован)
        │  message:text → валидация /^[\p{L}\s]{2,50}$/u
        ▼
   reg_state = { step: 'phone', lang, name }
   Запрос телефона через кнопку [📱 Поделиться номером]
        │  message:contact (ТОЛЬКО через Telegram Contact)
        │  message:text → ОТКЛОНЁН ("используйте кнопку")
        ▼
   Дедупликация телефона в БД
   reg_state = { step: 'spec', lang, name, phone }
   [inline] Выбор специализации (локализован)
        │  callback: reg_spec:<spec>
        ▼
   UPDATE status = 'pending', reg_state = NULL
   Уведомление в ADMIN_TELEGRAM_ID
        │
        ▼
   [Водитель ждёт решения оператора]
```

### Почему язык — первый шаг

Все последующие шаги (запросы имени, телефона, специализации, сообщения об ошибках) локализованы на основе `state.lang`. Если язык выбирается **после** имени (как было ранее), первые сообщения бота отображаются на дефолтном RU — грузиноязычный пользователь дезориентирован с первой секунды. Перенос выбора языка на /start устраняет этот UX-дефект.

### Строгая валидация телефона

**Текстовый ввод номера запрещён** на шаге `phone`. Если водитель пишет текст вместо нажатия кнопки, бот отвечает локализованным отказом и повторно показывает кнопку:

```typescript
// message:text handler, step === 'phone'
const errMsgs = {
  ru: '❗ Пожалуйста, используйте кнопку «📱 Поделиться номером»...',
  ka: '❗ გთხოვთ გამოიყენოთ «📱 ნომრის გაზიარება» ღილაკი...',
  en: '❗ Please use the «📱 Share phone number» button...',
};
```

Telegram Contact гарантирует, что номер принадлежит реальному аккаунту и совпадает с номером SIM-карты — исключает фейковые регистрации.

---

## 5. Модуль модерации и маркетинга (Админ-чат)

### Архитектура чата

```
TELEGRAM_ADMIN_CHAT_ID  (приоритет)
  └── группа операторов — любой может нажать кнопку
  
ADMIN_TELEGRAM_ID       (fallback)
  └── личный DM владельца — если чат-группа не настроена
```

### Входящая заявка

При отправке анкеты (`reg_spec` callback) в админ-чат приходит сообщение:

```
🆕 Новый исполнитель ожидает подтверждения

👤 Имя: Гиорги Мамаладзе
📞 Телефон: +995599123456
💼 Специализация: 🚛 Грузчик / переезды
🌐 Язык: ka
```

С тремя инлайн-кнопками:

```
[ ✅ Активировать          ]
[ 🎁 Одобрить + 7 дней триала ]
[ ❌ Отклонить             ]
```

### Три сценария обработки

#### Сценарий 1: Простая активация (`admin_approve:<phone>`)

1. `UPDATE status = 'active'` по телефону
2. `editMessageText` → добавляет `✅ Активирован` (защита от двойного клика)
3. Водителю — два сообщения:
   - Поздравление с активацией (локализовано)
   - Инструкция по оплате: тарифы + IBAN + уникальный код `MUSH-XXXXX`

#### Сценарий 2: Триал (`approve_with_trial:<driver_id>`)

1. `UPDATE status = 'active'` по `driver.id`
2. `rpc('extend_driver_subscription', { p_driver_id, p_days: 7 })`
3. `editMessageText` → `🎁 Одобрен с 7-дневным ТРИАЛОМ оператором [Имя]`
4. Водителю — одно радостное сообщение (без платёжных реквизитов):
   ```
   🎉 Добро пожаловать в команду!
   Вам предоставлено 7 дней БЕСПЛАТНОГО тестового периода! 🚀
   Вы уже можете принимать заказы. /profile
   ```

#### Сценарий 3: Отклонение (`admin_reject:<phone>`)

1. `UPDATE status = 'rejected'`
2. `editMessageText` → добавляет `❌ Отклонён`
3. Водителю — сообщение об отказе с предложением обратиться к менеджеру

### Защита от двойного клика

`editMessageText` изменяет текст исходного сообщения необратимо. Если второй оператор нажмёт ту же кнопку — Supabase вернёт пустой результат (`.eq('status', 'pending')` уже не совпадёт), и бот ответит `answerCallbackQuery({ text: 'Не найден или уже активен', show_alert: true })`. Действие не выполнится дважды.

---

## 6. Монетизация и интерфейс исполнителя

### Команда `/topup`

**Генерация уникального кода платежа:**

```typescript
const code = `MUSH-${driver.id.slice(0, 5).toUpperCase()}`;
// Пример: MUSH-A3F9C
```

UUID водителя в качестве основы гарантирует уникальность без отдельной таблицы кодов. Оператор видит код в скриншоте чека и может мгновенно найти водителя в БД.

**Флоу пополнения:**

```
/topup
  │
  ├── Показывает текущий статус подписки (активна / истекла)
  ├── Тарифную сетку (3 варианта)
  ├── IBAN для перевода
  └── Уникальный код MUSH-XXXXX
  
  Водитель делает перевод → отправляет скриншот в этот чат
  
  message:photo
  │
  ├── Форвардит фото в ADMIN_CHAT_ID с кнопками тарифов:
  │   [ ✅ 1 нед (7д) ] [ ✅ 2 нед (14д) ] [ ✅ 1 мес (30д) ]
  │   [ ❌ Отклонить ]
  │
  └── Оператор нажимает → rpc('extend_driver_subscription', {days})
        → editMessageCaption → уведомление водителю (локализовано)
```

### Команда `/profile`

Личный кабинет без дополнительного логина — показывает актуальные данные из БД:

```
👤 Мой профиль

Тип аккаунта: Безлимитный 🚀
Действует до: 29.06.2026

⭐ Рейтинг: 4.8
✅ Выполнено заказов: 12
💰 Заработано всего: 1 840 ₾
```

Если подписка истекла:
```
Тип аккаунта: Не активен ❌
Для получения заказов продлите подписку: /topup
```

Текст полностью локализован — `driver_language` определяет язык вывода.

---

## 7. Инфраструктура тестирования (Sandbox QA)

### Запуск

```bash
npx ts-node -r tsconfig-paths/register \
  --project scripts/tsconfig.json \
  scripts/run-e2e-sandbox.ts
```

Два режима: **Авто** (все 5 шагов подряд) и **Интерактивный** (Enter между шагами).

### Тестовые персоны

| Персона | Язык | Статус | `subscription_expires_at` | Роль в тестах |
|---|---|---|---|---|
| **Дмитрий (RU)** | `ru` | `active` | `NOW() + 5 дней` | Активный подписчик — делает ставки |
| **გიორგი (KA)** | `ka` | `active` | `NOW() - 1 день` | Просроченная подписка — проверка gate |
| **David (EN)** | `en` | `blocked` | `null` | Заблокированный — не попадает никуда |

Все три записи создаются в реальной Supabase с реальными `subscription_expires_at` значениями, не в памяти скрипта.

### 5 сценариев

#### Шаг 1 — Создание заказа
`POST /api/tender/create` с бюджетом 200₾ → проверяет `status: 201`, сохраняет `orderId` и `orderToken`.

#### Шаг 2 — Subscription Gate в очереди уведомлений
Вручную строит `tender_notification_queue` и проверяет:
- Дмитрий (активная подписка) → **в очереди** ✓
- გიორგი (просроченная) → **НЕ в очереди** ✓
- David (blocked) → **НЕ в очереди** ✓

```typescript
const eligibleDrivers = SANDBOX.drivers.filter(d =>
  d.status === 'active' &&
  d.subscriptionExpiresAt !== null &&
  new Date(d.subscriptionExpiresAt) > nowTs
);
```

#### Шаг 3 — Subscription Gate при ставке
- Дмитрий отправляет ставку 180₾ через webhook → bid появляется в `tender_bids`
- გიორგი отправляет ставку 175₾ → бот отвечает `show_alert` ("подписка не активна"), bid **не создаётся** в БД

#### Шаг 4 — Аукцион и антидемпинг
Перед шагом скрипт **реанимирует подписку გიორგი** напрямую в БД:

```typescript
await db.from('tender_drivers')
  .update({ subscription_expires_at: newExpiry })
  .eq('id', d2.id);
```

Проверяет:
- 190₾ (выше бюджета) → soft-предупреждение советника
- 160₾ < 80% × 200₾ = 160₾ → антидемпинговый порог (floor)
- 170₾ ≥ floor → ставка принята, `tender_bids` обновлён

#### Шаг 5 — Race Condition
`Promise.all` запускает параллельно:
1. `POST /api/tender/accept-bid` — принятие ставки გიორგი 170₾
2. Webhook-ставка Дмитрия 165₾ с задержкой 50мс

RPC `accept_bid_atomic` (`SELECT ... FOR UPDATE`) гарантирует:
- Победитель строго один (გიორგი)
- Ставка Дмитрия отклонена ботом ("тендер закрыт"), webhook возвращает 200 (не 5xx)
- `tender_orders.status = 'selected'`

### Cleanup

После каждого прогона (или по `Ctrl+C`) скрипт удаляет все тестовые записи:

```typescript
await db.from('tender_notification_queue').delete().eq('order_id', SANDBOX.orderId);
await db.from('tender_bids').delete().eq('order_id', SANDBOX.orderId);
await db.from('tender_orders').delete().eq('id', SANDBOX.orderId);
await db.from('tender_drivers').delete().in('id', driverIds);
```

Prod-данные не затрагиваются: тестовые записи используют уникальные `telegramId` (8810001–8810003) и телефоны (`+9959100000X`).

---

---

## 8. Frontend-архитектура (добавлено 23.06.2026)

### Страницы

| Путь | Файл | Описание |
|---|---|---|
| `/` | `app/page.tsx` | Главная — свободная форма, drag-and-drop медиа |
| `/feed/[token]` | `app/feed/[token]/page.tsx` | Фид заказа — Realtime ставки + Q&A |
| `/profile` | `app/profile/page.tsx` | Личный кабинет клиента (защищён) |

### Компоненты

| Файл | Назначение |
|---|---|
| `components/Navbar.tsx` | Хедер: logo, переключатель RU/EN/KA, вход/профиль |
| `components/AuthModal.tsx` | Bottom sheet: телефон → OTP 4 цифры → localStorage сессия |

### Провайдеры (app/layout.tsx)

```tsx
<I18nProvider>
  <AuthProvider>
    {children}
  </AuthProvider>
</I18nProvider>
```

### i18n система (`lib/i18n.tsx`)

- Тип `Lang = 'ru' | 'en' | 'ka'`
- `T: Record<Lang, Record<string, string>>` — все UI-строки
- Chips хранятся как pipe-строка: `'🚛 Переезды|🗑 Вывоз мусора|...'`
- `useI18n()` → `{ lang, setLang, t }`
- Язык сохраняется в `localStorage('msb_lang')`

### Auth контекст (`lib/auth-context.tsx`)

```typescript
interface ClientSession { phone: string; token: string; }
// ключи в localStorage: msb_client_phone, msb_client_token
```

### OTP Auth flow

```
Клиент вводит телефон
  → POST /api/auth/send-otp
      → генерирует 4-цифровой код
      → сохраняет в client_otp_codes (expires 10 мин)
      → отправляет через Wappi WhatsApp
  → Клиент вводит код
  → POST /api/auth/verify-otp
      → проверяет vs client_otp_codes
      → upsert в tender_clients
      → возвращает session_token (UUID)
      → клиент сохраняет в localStorage
```

### Realtime подписки (feed/[token]/page.tsx)

```typescript
// Подписка на два события
supabase.channel('feed-' + token)
  .on('postgres_changes', { table: 'tender_bids', filter: `order_id=eq.${orderId}` }, handler)
  .on('postgres_changes', { table: 'order_questions', filter: `order_id=eq.${orderId}` }, handler)
  .subscribe()
```

### Новые таблицы (миграция 20260623_client_auth.sql)

```sql
CREATE TABLE client_otp_codes (
  phone        text PRIMARY KEY,
  code         text NOT NULL,
  expires_at   timestamptz NOT NULL
);

CREATE TABLE tender_clients (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  phone          text UNIQUE NOT NULL,
  session_token  text,
  last_login     timestamptz DEFAULT now()
);

-- RLS обе таблицы
ALTER TABLE client_otp_codes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "all" ON client_otp_codes FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE tender_clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "all" ON tender_clients FOR ALL USING (true) WITH CHECK (true);
```

---

## 9. RLS-матрица (актуально 23.06.2026)

| Таблица | anon SELECT | anon INSERT | anon UPDATE | Примечание |
|---|---|---|---|---|
| `tender_orders` | ✅ | ❌ | ❌ | API route создаёт через service role |
| `tender_bids` | ✅ | ❌ | ❌ | Через bot/webhook |
| `tender_drivers` | ✅ | ❌ | ❌ | Читается для отображения имени |
| `order_questions` | ✅ | ❌ | ❌ | Добавлена 23.06.2026 (было заблокировано) |
| `client_otp_codes` | ✅ | ✅ | ✅ | Нужен upsert для OTP flow |
| `tender_clients` | ✅ | ✅ | ✅ | Нужен upsert при входе |

> **Важно:** Если `order_questions` для anon вдруг снова перестанет работать — проверить наличие политики:
> ```sql
> SELECT * FROM pg_policies WHERE tablename = 'order_questions';
> ```

---

## Приложение: Переменные окружения

| Переменная | Обязательна | Описание |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | URL проекта Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Service role key (обходит RLS) |
| `TELEGRAM_BOT_TOKEN` | ✅ | Токен `@mushebi_bot` |
| `TELEGRAM_ADMIN_ID` | ✅ | Telegram ID владельца (fallback модерации) |
| `TELEGRAM_ADMIN_CHAT_ID` | ⭕ | ID закрытой группы операторов |
| `TELEGRAM_WEBHOOK_SECRET` | ⭕ | Secret для верификации webhook-запросов |
| `WAPPI_TOKEN` | ⭕ | API-ключ Wappi.pro (WhatsApp auth) |
| `WAPPI_PROFILE_ID` | ⭕ | ID профиля Wappi (prefix `msb_`) |
| `OPENROUTER_API_KEY` | ✅ | Ключ OpenRouter для AI-агентов |
| `NEXT_PUBLIC_APP_URL` | ⭕ | Публичный URL (default: `https://mushebi.ge`) |
| `TEST_BASE_URL` | ⭕ | URL для E2E sandbox (default: `http://localhost:3000`) |
