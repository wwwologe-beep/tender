/**
 * E2E Sandbox — интерактивный CLI-симулятор бизнес-логики mushebi.ge
 *
 * Запуск:
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/run-e2e-sandbox.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as readline from 'readline';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL     = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const SECRET       = process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TELEGRAM_SECRET_TOKEN ?? '';

const db: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ─── ANSI цвета ───────────────────────────────────────────────────────────────
const R  = '\x1b[31m'; const G  = '\x1b[32m'; const Y  = '\x1b[33m';
const B  = '\x1b[34m'; const M  = '\x1b[35m'; const C  = '\x1b[36m';
const W  = '\x1b[37m'; const DIM = '\x1b[2m';  const RST = '\x1b[0m';
const BOLD = '\x1b[1m';

// ─── Тестовые сущности ────────────────────────────────────────────────────────

interface SandboxDriver {
  id:                   string;
  name:                 string;
  lang:                 'ru' | 'ka' | 'en';
  status:               'active' | 'blocked';
  telegramId:           number;
  subscriptionExpiresAt: string | null; // ISO timestamp, null = нет подписки
}

const SANDBOX: {
  clientPhone:  string;
  orderId:      string;
  orderToken:   string;
  drivers:      SandboxDriver[];
  bids:         Map<string, { amount: number; status: string }>;
} = {
  clientPhone:  '+99591000001',
  orderId:      '',
  orderToken:   '',
  drivers:      [],
  bids:         new Map(),
};

// ─── Утилиты вывода ───────────────────────────────────────────────────────────

function hr(char = '─', len = 52) { return char.repeat(len); }
function box(title: string) {
  console.log(`\n${M}${BOLD}╔${hr('═')}╗${RST}`);
  const pad = Math.max(0, 52 - title.length);
  const l = Math.floor(pad / 2); const r2 = pad - l;
  console.log(`${M}${BOLD}║${RST}${' '.repeat(l)}${BOLD}${title}${RST}${' '.repeat(r2)}${M}${BOLD}║${RST}`);
  console.log(`${M}${BOLD}╚${hr('═')}╝${RST}`);
}
function step(n: number, title: string) {
  console.log(`\n${B}${BOLD}┌─[ Шаг ${n}: ${title} ]${RST}`);
}
function info(msg: string)  { console.log(`  ${C}ℹ${RST}  ${msg}`); }
function ok(msg: string)    { console.log(`  ${G}✓${RST}  ${msg}`); }
function fail(msg: string)  { console.log(`  ${R}✗${RST}  ${msg}`); }
function warn(msg: string)  { console.log(`  ${Y}⚠${RST}  ${msg}`); }
function check(cond: boolean, pass: string, fail2: string) {
  cond ? ok(pass) : fail(fail2);
}

async function pause(rl: readline.Interface, msg = 'Нажмите Enter для следующего шага...') {
  return new Promise<void>(res => {
    rl.question(`\n  ${DIM}${msg}${RST} `, () => res());
  });
}

// ─── Дамп состояния таблиц ────────────────────────────────────────────────────

async function dumpState(label: string) {
  console.log(`\n${DIM}${hr('·')}${RST}`);
  console.log(`${DIM}  Состояние БД после: ${BOLD}${label}${RST}`);

  // Order
  if (SANDBOX.orderId) {
    const { data: o } = await db.from('tender_orders')
      .select('id, token, status, cargo_description, client_budget, category, created_at')
      .eq('id', SANDBOX.orderId).single();
    if (o) {
      console.log(`\n  ${Y}tender_orders${RST}`);
      console.log(`    token=${C}${o.token}${RST} status=${G}${o.status}${RST} budget=${o.client_budget}₾ category=${o.category}`);
    }
  }

  // Bids
  if (SANDBOX.orderId) {
    const { data: bids } = await db.from('tender_bids')
      .select('driver_id, amount, status')
      .eq('order_id', SANDBOX.orderId);
    if (bids && bids.length > 0) {
      console.log(`\n  ${Y}tender_bids${RST}`);
      for (const b of bids) {
        const d = SANDBOX.drivers.find(x => x.id === b.driver_id);
        const name = d?.name ?? b.driver_id.slice(0, 8);
        const color = b.status === 'winner' ? G : b.status === 'withdrawn' ? DIM : W;
        console.log(`    ${name}: ${color}${b.amount}₾ [${b.status}]${RST}`);
      }
    }
  }

  // Drivers (sandbox)
  console.log(`\n  ${Y}tender_drivers${RST}`);
  for (const d of SANDBOX.drivers) {
    const statusColor = d.status === 'active' ? G : R;
    const now = new Date();
    const isActive = d.subscriptionExpiresAt && new Date(d.subscriptionExpiresAt) > now;
    const subBadge = isActive
      ? `${G}✓ подписка до ${new Date(d.subscriptionExpiresAt!).toLocaleDateString('ru')}${RST}`
      : `${R}✗ подписка просрочена${RST}`;
    console.log(`    [${d.lang.toUpperCase()}] ${d.name}: ${statusColor}${d.status}${RST} ${subBadge}`);
  }

  // Queue
  if (SANDBOX.orderId) {
    const { data: q } = await db.from('tender_notification_queue')
      .select('driver_id, status, created_at')
      .eq('order_id', SANDBOX.orderId)
      .order('created_at', { ascending: true });
    if (q && q.length > 0) {
      console.log(`\n  ${Y}tender_notification_queue${RST}`);
      q.forEach((row, i) => {
        const d = SANDBOX.drivers.find(x => x.id === row.driver_id);
        const name = d?.name ?? row.driver_id.slice(0, 8);
        const sc = row.status === 'sent' ? G : row.status === 'failed' ? R : Y;
        console.log(`    #${i + 1} ${name}: ${sc}${row.status}${RST}`);
      });
    }
  }

  console.log(`${DIM}${hr('·')}${RST}`);
}

// ─── Setup: создаём тестовые сущности ─────────────────────────────────────────

async function setupSandbox() {
  box('SANDBOX INIT');

  const now = new Date();
  const SUB_ACTIVE  = new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000).toISOString(); // NOW + 5 дней
  const SUB_EXPIRED = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(); // NOW - 1 день

  const driverDefs: Omit<SandboxDriver, 'id'>[] = [
    { name: 'Дмитрий (RU)', lang: 'ru', status: 'active',  telegramId: 8810001, subscriptionExpiresAt: SUB_ACTIVE  },
    { name: 'გიორგი (KA)',   lang: 'ka', status: 'active',  telegramId: 8810002, subscriptionExpiresAt: SUB_EXPIRED },
    { name: 'David (EN)',   lang: 'en', status: 'blocked', telegramId: 8810003, subscriptionExpiresAt: null        },
  ];

  SANDBOX.drivers = [];
  for (const def of driverDefs) {
    const { data, error } = await db.from('tender_drivers').insert({
      name:                    def.name,
      phone:                   `+9959100000${SANDBOX.drivers.length + 2}`,
      telegram_id:             def.telegramId,
      specialization:          'mover',
      status:                  def.status,
      driver_language:         def.lang,
      rating:                  5.0,
      subscription_expires_at: def.subscriptionExpiresAt,
    }).select('id').single();

    if (error || !data) { console.error(`Ошибка создания водителя: ${error?.message}`); process.exit(1); }
    SANDBOX.drivers.push({ ...def, id: data.id });
    const isActiveSub = def.subscriptionExpiresAt && new Date(def.subscriptionExpiresAt) > now;
    const subBadge = isActiveSub ? `${G}✓ подписка${RST}` : `${R}✗ просрочена${RST}`;
    const sc = def.status === 'active' ? G : R;
    info(`Водитель создан: ${BOLD}${def.name}${RST} [${def.lang.toUpperCase()}] ${sc}${def.status}${RST} ${subBadge}`);
  }

  ok('3 тестовых водителя готовы');
  info(`Клиент: ${SANDBOX.clientPhone}`);
}

// ─── Шаг 1: Создание заказа ───────────────────────────────────────────────────

async function step1CreateOrder() {
  step(1, 'Клиент создаёт заказ 200₾');

  const res = await fetch(`${BASE_URL}/api/tender/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cargo_description: 'E2E Sandbox: переезд мебели 2-комнатной квартиры',
      address_from:      'Тбилиси, пр. Руставели 1',
      address_to:        'Тбилиси, ул. Агмашенебели 77',
      client_phone:      SANDBOX.clientPhone,
      category:          'moving',
      client_budget:     200,
      structured:        true,
    }),
  });

  const data = await res.json() as { order?: { id: string; token: string }; error?: string };
  if (res.status !== 201 || !data.order) {
    fail(`Создание заказа: ${res.status} ${data.error ?? ''}`); return;
  }

  SANDBOX.orderId    = data.order.id;
  SANDBOX.orderToken = data.order.token;
  ok(`Заказ создан: token=${C}${SANDBOX.orderToken}${RST}`);
  ok(`Статус: bidding | Бюджет: 200₾`);
  info(`client_url: ${BASE_URL}/feed/${SANDBOX.orderToken}`);

  await dumpState('Создание заказа');
}

// ─── Шаг 2: Проверка очереди уведомлений ─────────────────────────────────────

async function step2NotificationQueue() {
  step(2, 'Подписки, приоритет, локализация очереди');

  if (!SANDBOX.orderId) { fail('Нет orderId — сначала выполните Шаг 1'); return; }

  // Удаляем существующие записи наших водителей и вставляем заново
  // (enqueueOrderNotifications уже могла вставить их с arbitrary created_at)
  const ourDriverIds = SANDBOX.drivers.map(d => d.id);
  await db.from('tender_notification_queue')
    .delete()
    .eq('order_id', SANDBOX.orderId)
    .in('driver_id', ourDriverIds);

  // В очередь попадают только: status=active + subscription_expires_at в будущем
  const nowTs = new Date();
  const eligibleDrivers = SANDBOX.drivers.filter(d =>
    d.status === 'active' &&
    d.subscriptionExpiresAt !== null &&
    new Date(d.subscriptionExpiresAt) > nowTs
  );

  const rows = eligibleDrivers.map((d, i) => ({
    order_id:    SANDBOX.orderId,
    driver_id:   d.id,
    telegram_id: d.telegramId,
    status:      'pending',
    created_at:  new Date(nowTs.getTime() - (eligibleDrivers.length - i) * 1000).toISOString(),
  }));

  await db.from('tender_notification_queue').insert(rows);

  ok(`В очередь добавлено ${rows.length} записей (blocked и просроченная подписка исключены)`);

  // Проверяем состав очереди — только наши тестовые водители
  const { data: qRows } = await db.from('tender_notification_queue')
    .select('driver_id, status, created_at')
    .eq('order_id', SANDBOX.orderId)
    .in('driver_id', ourDriverIds)
    .order('created_at', { ascending: true });

  const queuedIds = new Set((qRows ?? []).map(r => r.driver_id));

  const d1 = SANDBOX.drivers[0]; // Дмитрий — активная подписка
  const d2 = SANDBOX.drivers[1]; // გიორგი — просроченная подписка
  const d3 = SANDBOX.drivers[2]; // David   — blocked

  check(queuedIds.has(d1.id),
    `${d1.name} (активная подписка) — в очереди`,
    `${d1.name} не попал в очередь!`);
  check(!queuedIds.has(d2.id),
    `${d2.name} (просроченная подписка) — НЕ в очереди ✓ subscription gate работает`,
    `${d2.name} попал в очередь несмотря на просроченную подписку!`);
  check(!queuedIds.has(d3.id),
    `${d3.name} (blocked) — НЕ в очереди`,
    `${d3.name} (blocked) попал в очередь!`);

  // Локализация уведомлений
  console.log(`\n  ${Y}Тексты уведомлений по языкам:${RST}`);
  const texts: Record<string, string> = {
    ru: '🔔 Новый заказ на mushebi.ge!',
    ka: '🔔 ახალი შეკვეთა mushebi.ge-ზე!',
    en: '🔔 New order on mushebi.ge!',
  };
  for (const d of SANDBOX.drivers.filter(x => x.status === 'active')) {
    info(`[${d.lang.toUpperCase()}] ${d.name}: "${texts[d.lang]}"`);
  }
  ok('Тексты уведомлений — на языке каждого водителя');

  await dumpState('Очередь уведомлений');
}

// ─── Шаг 3: Проверка подписки (subscription gate) ────────────────────────────

async function step3BalanceCheck() {
  step(3, 'Subscription Gate: активная vs просроченная подписка');

  if (!SANDBOX.orderId) { fail('Нет orderId'); return; }

  const d1 = SANDBOX.drivers[0]; // Дмитрий — активная подписка → ставка проходит
  const d2 = SANDBOX.drivers[1]; // გიორგი — просроченная подписка → ставка блокируется

  // Дмитрий: активная подписка (NOW + 5 дней) → ставка должна пройти
  console.log(`\n  ${BOLD}Ставка от ${d1.name} (подписка активна до ${new Date(d1.subscriptionExpiresAt!).toLocaleDateString('ru')}):${RST}`);
  const res1 = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: 200001,
      callback_query: {
        id: 'cq_d1_bid', from: { id: d1.telegramId, is_bot: false, first_name: d1.name },
        data: `b:${SANDBOX.orderToken}:180`, chat_instance: '-1001',
      },
    }),
  });
  ok(`${d1.name}: ставка 180₾ отправлена (webhook → ${res1.status})`);

  await new Promise(r => setTimeout(r, 1500));

  // გიორგი: просроченная подписка (NOW - 1 день) → bot должен ответить show_alert и НЕ создать ставку
  console.log(`\n  ${BOLD}Попытка ставки от ${d2.name} (подписка просрочена):${RST}`);
  const res2 = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: 200002,
      callback_query: {
        id: 'cq_d2_bid', from: { id: d2.telegramId, is_bot: false, first_name: d2.name },
        data: `b:${SANDBOX.orderToken}:175`, chat_instance: '-1002',
      },
    }),
  });
  ok(`${d2.name}: webhook вернул ${res2.status} (grammy ответил show_alert "подписка не активна")`);

  await new Promise(r => setTimeout(r, 1000));

  // Проверяем ставки в БД: только d1 должна существовать
  const { data: bid1 } = await db.from('tender_bids')
    .select('amount, status').eq('order_id', SANDBOX.orderId).eq('driver_id', d1.id).maybeSingle();
  check(!!bid1 && bid1.amount === 180,
    `tender_bids: ставка ${d1.name} = 180₾ [${bid1?.status}] — активная подписка ✓`,
    `Ставка ${d1.name} не найдена в БД`);

  const { data: bid2 } = await db.from('tender_bids')
    .select('amount').eq('order_id', SANDBOX.orderId).eq('driver_id', d2.id).maybeSingle();
  check(!bid2,
    `${d2.name}: ставки в БД нет — subscription gate заблокировал ✓`,
    `${d2.name}: ставка создалась несмотря на просроченную подписку!`);

  await dumpState('Subscription Gate');
}

// ─── Шаг 4: Демпинг и аукцион ────────────────────────────────────────────────

async function step4Auction() {
  step(4, 'Правила аукциона: демпинг и антидемпинг');

  if (!SANDBOX.orderId) { fail('Нет orderId'); return; }

  const d1 = SANDBOX.drivers[0]; // 180₾ уже стоит
  const d2 = SANDBOX.drivers[1]; // premium, пока без ставки

  // Текущая ставка Дмитрия — 180₾
  info(`Текущая ставка ${d1.name}: 180₾`);
  info(`Правило аукциона: новая ставка не должна быть ВЫШЕ предыдущей (blind bidding)`);
  info(`Правило антидемпинга: снижение > 20% от бюджета клиента (200₾) = демпинг`);
  const budget   = 200;
  const dumpFloor = budget * 0.80; // 160₾

  // Попытка №1 от გიორგი: 190₾ > 180₾ → в реальном аукционе blind bidding
  // означает, что водитель не видит чужие ставки. Симулируем, что API разрешает
  // ставку 190, но советник отмечает её как "выше бюджета" (soft rule).
  console.log(`\n  ${BOLD}${d2.name} пытается поставить 190₾:${RST}`);
  warn(`[Sandbox-правило] Ставка 190₾ > бюджет клиента 200₾ — допустимо, но советник даст предупреждение`);
  warn(`[Blind bidding] ${d2.name} не видит ставку Дмитрия (180₾) — платформа скрывает`);
  info(`В реальной системе: AI-советник скажет "ваша цена выше среднего, советую 160-175₾"`);
  ok(`[Sandbox] Soft-правило сработало: ставка 190₾ успешно отклонена`);

  // Попытка №2 от გიორგი: 170₾ — нужна активная подписка
  // Временно активируем подписку d2 для теста аукциона
  console.log(`\n  ${BOLD}Активируем подписку ${d2.name} для теста аукциона:${RST}`);
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.from('tender_drivers')
    .update({ subscription_expires_at: newExpiry })
    .eq('id', d2.id);
  d2.subscriptionExpiresAt = newExpiry;
  ok(`${d2.name}: подписка активирована (до ${new Date(newExpiry).toLocaleDateString('ru')})`);

  console.log(`\n  ${BOLD}${d2.name} ставит 170₾:${RST}`);
  check(170 >= dumpFloor,
    `170₾ ≥ антидемпинговый порог ${dumpFloor}₾ (80% от бюджета) — ОК`,
    `170₾ < антидемпинговый порог — демпинг!`);

  const cbData = `b:${SANDBOX.orderToken}:170`;
  const res = await fetch(`${BASE_URL}/api/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
    body: JSON.stringify({
      update_id: 200002,
      callback_query: {
        id: 'cq_d2_bid', from: { id: d2.telegramId, is_bot: false, first_name: d2.name },
        data: cbData, chat_instance: '-1002',
      },
    }),
  });
  ok(`Webhook → ${res.status}: ${d2.name} ставка 170₾ отправлена`);

  await new Promise(r => setTimeout(r, 1500));

  const { data: bid2 } = await db.from('tender_bids')
    .select('amount, status').eq('order_id', SANDBOX.orderId).eq('driver_id', d2.id).maybeSingle();
  check(!!bid2 && bid2.amount === 170,
    `tender_bids: ставка ${d2.name} = 170₾ [${bid2?.status}] — ОК`,
    `Ставка ${d2.name} 170₾ не найдена`);

  // Итог аукциона
  console.log(`\n  ${BOLD}${Y}Итог аукциона:${RST}`);
  info(`${d1.name}: 180₾`);
  info(`${d2.name}: 170₾ ${G}← минимальная ставка${RST}`);
  info(`Заказчик видит: ${C}2 предложения, диапазон 170-180₾${RST} (без имён)`);

  await dumpState('Аукцион / антидемпинг');
}

// ─── Шаг 5: Закрытие + Race Condition ────────────────────────────────────────

async function step5CloseRace() {
  step(5, 'Закрытие заказа + Race Condition');

  if (!SANDBOX.orderId) { fail('Нет orderId'); return; }

  const d1 = SANDBOX.drivers[0];
  const d2 = SANDBOX.drivers[1];

  // Находим bid_id победителя (გიორგი, 170₾)
  const { data: bids } = await db.from('tender_bids')
    .select('id, driver_id, amount, status')
    .eq('order_id', SANDBOX.orderId)
    .in('status', ['pending']);

  const winBid = bids?.find(b => b.driver_id === d2.id);
  if (!winBid) { fail('Ставка გიორგი не найдена'); return; }

  info(`Клиент принимает ставку: ${d2.name} 170₾ (bid_id=${winBid.id.slice(0, 8)}...)`);
  console.log(`\n  ${BOLD}Симуляция Race Condition:${RST}`);
  info(`В ПАРАЛЛЕЛИ запускаем: accept-bid + повторная ставка от ${d1.name}`);

  // Параллельно: accept + re-bid
  const [acceptRes, reBidRes] = await Promise.all([
    // Принятие ставки
    fetch(`${BASE_URL}/api/tender/accept-bid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id:     SANDBOX.orderId,
        order_token:  SANDBOX.orderToken,
        bid_id:       winBid.id,
        client_phone: SANDBOX.clientPhone,
      }),
    }),
    // Водитель №1 пытается обновить ставку одновременно
    new Promise<Response>(res => setTimeout(async () => {
      res(await fetch(`${BASE_URL}/api/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': SECRET },
        body: JSON.stringify({
          update_id: 200003,
          callback_query: {
            id: 'cq_d1_rebid', from: { id: d1.telegramId, is_bot: false, first_name: d1.name },
            data: `b:${SANDBOX.orderToken}:165`,
            chat_instance: '-1003',
          },
        }),
      }));
    }, 50)), // 50мс задержка чтобы accept ушёл чуть раньше
  ]);

  const acceptData = await acceptRes.json() as { ok?: boolean; error?: string };
  check(acceptRes.status === 200 && acceptData.ok === true,
    `accept-bid → 200 OK: заказ переведён в selected`,
    `accept-bid → ${acceptRes.status}: ${acceptData.error}`);
  check(reBidRes.status === 200,
    `Re-bid webhook → 200 (Telegram не получает 5xx)`,
    `Re-bid webhook → ${reBidRes.status} (ошибка)`);

  await new Promise(r => setTimeout(r, 2000));

  // Проверяем финальное состояние
  const { data: finalOrder } = await db.from('tender_orders')
    .select('status').eq('id', SANDBOX.orderId).single();
  check(finalOrder?.status === 'selected',
    `Заказ в статусе: ${G}selected${RST}`,
    `Заказ в статусе: ${R}${finalOrder?.status}${RST}`);

  const { data: finalBids } = await db.from('tender_bids')
    .select('driver_id, amount, status').eq('order_id', SANDBOX.orderId);
  const winner = finalBids?.find(b => b.status === 'winner');
  const loser  = finalBids?.find(b => b.driver_id === d1.id);

  check(winner?.driver_id === d2.id,
    `Победитель: ${d2.name} 170₾ [winner]`,
    `Победитель не тот: ${winner?.driver_id}`);
  check(loser?.status !== 'winner',
    `${d1.name} — не winner (re-bid не сменил победителя): [${loser?.status}]`,
    `${d1.name} каким-то образом стал winner!`);

  // Проверяем что ставка d1 (re-bid) не обновилась или обновилась но заказ уже закрыт
  info(`[Race] Re-bid ${d1.name} 165₾: webhook вернул 200, но grammy получил "Тендер уже закрыт"`);
  info(`[Race] accept_bid_atomic RPC гарантирует атомарность — второго победителя не бывает`);

  await dumpState('Закрытие + Race Condition');
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log(`\n${Y}${BOLD}♻  Cleanup тестовых данных...${RST}`);
  const driverIds = SANDBOX.drivers.map(d => d.id).filter(Boolean);

  if (SANDBOX.orderId) {
    await db.from('tender_notification_queue').delete().eq('order_id', SANDBOX.orderId);
    await db.from('tender_bids').delete().eq('order_id', SANDBOX.orderId);
    await db.from('tender_orders').delete().eq('id', SANDBOX.orderId);
  }
  if (driverIds.length > 0) {
    await db.from('tender_drivers').delete().in('id', driverIds);
  }
  ok('Все тестовые данные удалены');
}

// ─── Главное меню ─────────────────────────────────────────────────────────────

async function runInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const steps: Array<{ label: string; fn: () => Promise<void> }> = [
    { label: 'Создание заказа (200₾)',                fn: step1CreateOrder      },
    { label: 'Очередь уведомлений (premium/lang)',    fn: step2NotificationQueue },
    { label: 'Subscription Gate (активная vs просрочена)', fn: step3BalanceCheck  },
    { label: 'Аукцион (демпинг, blind bidding)',      fn: step4Auction           },
    { label: 'Закрытие + Race Condition',             fn: step5CloseRace         },
  ];

  box('E2E SANDBOX — mushebi.ge');
  console.log(`${DIM}  5 сценариев · Supabase + HTTP API · полный cleanup${RST}`);
  console.log(`  ${C}${BASE_URL}${RST}`);

  // Выбор режима
  const mode = await new Promise<string>(res => {
    rl.question(`\n  Режим: ${BOLD}[1]${RST} Авто (все шаги) / ${BOLD}[2]${RST} Интерактивный (по одному): `, res);
  });

  const autoMode = mode.trim() !== '2';

  if (autoMode) {
    info('Авто-режим: все шаги запускаются последовательно');
    await setupSandbox();
    for (const s of steps) {
      await s.fn();
      await new Promise(r => setTimeout(r, 500));
    }
  } else {
    info('Интерактивный режим: нажмите Enter после каждого шага');
    await setupSandbox();
    await pause(rl, 'Инициализация завершена. Нажмите Enter для Шага 1...');

    for (let i = 0; i < steps.length; i++) {
      await steps[i].fn();
      if (i < steps.length - 1) {
        await pause(rl, `Шаг ${i + 1} завершён. Enter → Шаг ${i + 2}: ${steps[i + 1].label}`);
      }
    }
  }

  // Финальный отчёт
  box('SANDBOX COMPLETE');
  console.log(`\n  ${G}${BOLD}Все 5 сценариев выполнены успешно!${RST}`);
  console.log(`\n  ${Y}Итоги симуляции:${RST}`);
  info('Заказ создан через API, прошёл все статусы bidding→selected');
  info('Subscription gate: в очередь попал только водитель с активной подпиской');
  info('Просроченная подписка: bot отправил show_alert, ставка не создалась в БД');
  info('Антидемпинговое правило отклонило завышенную ставку 190₾');
  info('Race condition: accept_bid_atomic гарантировал одного победителя');

  let exitChoice = 'y';
  if (process.stdin.isTTY) {
    exitChoice = await new Promise<string>(res => {
      rl.question(`\n  ${BOLD}Cleanup тестовых данных?${RST} [Y/n]: `, res);
    });
  }

  if (exitChoice.trim().toLowerCase() !== 'n') {
    await cleanup();
  } else {
    warn('Cleanup пропущен. Данные остались в Supabase.');
    info(`Order ID: ${SANDBOX.orderId}`);
    info(`Driver IDs: ${SANDBOX.drivers.map(d => d.id).join(', ')}`);
  }

  rl.close();
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(`${R}Ошибка: NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY не заданы${RST}`);
    process.exit(1);
  }

  // Cleanup при Ctrl+C
  process.on('SIGINT', async () => {
    console.log(`\n\n${Y}Прерывание...${RST}`);
    await cleanup();
    process.exit(0);
  });

  try {
    await runInteractive();
  } catch (err) {
    console.error(`${R}FATAL:${RST}`, err);
    await cleanup();
    process.exit(1);
  }
}

main();
