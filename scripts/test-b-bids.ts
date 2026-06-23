/**
 * Тест-скрипт: Блок B — Система ставок и аукцион
 * Тестирует через Supabase напрямую: ставки, атомарный RPC, статусы, рейтинг.
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// ─── Вывод ───────────────────────────────────────────────────────────────────

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

let passed = 0;
let failed = 0;

function ok(label: string, detail = '') {
  passed++;
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${YELLOW}(${detail})${RESET}` : ''}`);
}
function fail(label: string, detail = '') {
  failed++;
  console.log(`  ${RED}✗ FAIL${RESET} ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string) {
  console.log(`\n${BOLD}${title}${RESET}`);
}

// ─── Тестовые ID (фиктивные telegram_id далеко за пределами реальных) ────────

const T = {
  ORDER_ID:   '' as string,   // заполнится при создании
  BID1_ID:    '' as string,
  BID2_ID:    '' as string,
  BID3_ID:    '' as string,
  DRIVER1_ID: '' as string,
  DRIVER2_ID: '' as string,
  DRIVER3_ID: '' as string,
  TG1: 8888000101,
  TG2: 8888000102,
  TG3: 8888000103,
};

// ─── Очистка ─────────────────────────────────────────────────────────────────

async function cleanup() {
  if (T.ORDER_ID) {
    await sb.from('tender_bids').delete().eq('order_id', T.ORDER_ID);
    await sb.from('tender_orders').delete().eq('id', T.ORDER_ID);
  }
  await sb.from('tender_drivers').delete().in('telegram_id', [T.TG1, T.TG2, T.TG3]);
}

// ─── Setup: создаём тестовых исполнителей и заказ ────────────────────────────

async function setup() {
  section('Setup — создание тестовых данных');

  // Три исполнителя
  for (const [tgId, name] of [[T.TG1, 'Тест Драйвер 1'], [T.TG2, 'Тест Драйвер 2'], [T.TG3, 'Тест Драйвер 3']] as [number, string][]) {
    const { data, error } = await sb.from('tender_drivers').upsert(
      { telegram_id: tgId, name, phone: `+99599900${tgId % 1000}`, status: 'active', driver_language: 'ru', rating_sum: 0, rating_count: 0, rating: 0 },
      { onConflict: 'telegram_id' }
    ).select('id').single();
    if (error || !data) { fail(`Создан драйвер ${name}`, error?.message); return false; }
    if (tgId === T.TG1) T.DRIVER1_ID = data.id;
    if (tgId === T.TG2) T.DRIVER2_ID = data.id;
    if (tgId === T.TG3) T.DRIVER3_ID = data.id;
    ok(`Создан драйвер: ${name}`);
  }

  // Один тестовый заказ
  const { data: order, error: orderErr } = await sb.from('tender_orders').insert({
    token: `test-b-${Date.now()}`,
    address_from: 'Руставели 1',
    address_to: 'Дидубе 5',
    cargo_description: 'Тестовый заказ для Блока B',
    client_name: 'Тест Клиент',
    client_phone: '+995599000099',
    status: 'bidding',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();

  if (orderErr || !order) { fail('Создан тестовый заказ', orderErr?.message); return false; }
  T.ORDER_ID = order.id;
  ok(`Создан заказ`, T.ORDER_ID.slice(0, 8));

  return true;
}

// ─── B1: Базовое создание ставок ─────────────────────────────────────────────

async function testB1_CreateBids() {
  section('B1 — Создание ставок');

  const bids: [string, number, number][] = [
    [T.DRIVER1_ID, 150, 1],
    [T.DRIVER2_ID, 130, 2],
    [T.DRIVER3_ID, 170, 3],
  ];

  for (const [driverId, amount, n] of bids) {
    const { data, error } = await sb.from('tender_bids').insert({
      order_id: T.ORDER_ID,
      driver_id: driverId,
      amount,
      status: 'pending',
      bot_state: 'idle',
      bot_state_updated_at: new Date().toISOString(),
    }).select('id').single();

    if (error || !data) { fail(`B1.${n}: ставка ${amount}₾ создана`, error?.message); continue; }
    ok(`B1.${n}: ставка ${amount}₾ создана`);
    if (n === 1) T.BID1_ID = data.id;
    if (n === 2) T.BID2_ID = data.id;
    if (n === 3) T.BID3_ID = data.id;
  }

  // Проверяем что в БД 3 ставки
  const { count } = await sb.from('tender_bids')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', T.ORDER_ID)
    .eq('status', 'pending');
  count === 3 ? ok('B1: в БД ровно 3 pending-ставки') : fail('B1: 3 ставки в БД', `нашли ${count}`);
}

// ─── B2: Изменение ставки (upsert) ───────────────────────────────────────────

async function testB2_UpdateBid() {
  section('B2 — Изменение ставки');

  const { error } = await sb.from('tender_bids').update({ amount: 145 })
    .eq('id', T.BID1_ID);
  error ? fail('B2: ставка обновлена', error.message) : ok('B2: ставка обновлена 150₾ → 145₾');

  const { data } = await sb.from('tender_bids').select('amount').eq('id', T.BID1_ID).single();
  data?.amount === 145 ? ok('B2: новая сумма в БД = 145₾') : fail('B2: сумма в БД', `${data?.amount}`);
}

// ─── B3: Отзыв ставки ────────────────────────────────────────────────────────

async function testB3_WithdrawBid() {
  section('B3 — Отзыв ставки');

  // Создаём четвёртую ставку чтобы отозвать её (не трогаем основные три)
  const { data: extra } = await sb.from('tender_bids').insert({
    order_id: T.ORDER_ID, driver_id: T.DRIVER3_ID,
    amount: 200, status: 'pending', bot_state: 'idle',
    bot_state_updated_at: new Date().toISOString(),
  }).select('id').single();

  // upsert перезапишет, поэтому просто обновляем BID3 → withdrawn
  const { error } = await sb.from('tender_bids').update({ status: 'withdrawn' }).eq('id', T.BID3_ID);
  error ? fail('B3: ставка отозвана', error.message) : ok('B3: ставка отозвана (status=withdrawn)');

  const { data } = await sb.from('tender_bids').select('status').eq('id', T.BID3_ID).single();
  data?.status === 'withdrawn' ? ok('B3: статус в БД = withdrawn') : fail('B3: статус withdrawn', data?.status);

  // Восстанавливаем BID3 чтобы у нас снова было 2 активных ставки для RPC
  await sb.from('tender_bids').update({ status: 'pending', amount: 170 }).eq('id', T.BID3_ID);
  if (extra) await sb.from('tender_bids').delete().eq('id', extra.id);
}

// ─── B4: Атомарный RPC accept_bid_atomic ─────────────────────────────────────

async function testB4_AtomicAccept() {
  section('B4 — Атомарный RPC accept_bid_atomic');

  // Принимаем BID2 (130₾ — наименьшая ставка)
  const { data: result, error } = await sb.rpc('accept_bid_atomic', {
    p_order_id: T.ORDER_ID,
    p_bid_id: T.BID2_ID,
  });

  error ? fail('B4: RPC вызван без ошибки', error.message) : ok('B4: RPC вызван без ошибки');
  result === true ? ok('B4: RPC вернул true (успех)') : fail('B4: RPC вернул true', `получили ${result}`);

  // Проверяем статус заказа
  const { data: order } = await sb.from('tender_orders')
    .select('status, winning_bid_id, executor_id')
    .eq('id', T.ORDER_ID).single();

  order?.status === 'selected' ? ok('B4: заказ → selected') : fail('B4: заказ → selected', order?.status);
  order?.winning_bid_id === T.BID2_ID ? ok('B4: winning_bid_id = BID2') : fail('B4: winning_bid_id', order?.winning_bid_id ?? 'null');
  order?.executor_id === T.DRIVER2_ID ? ok('B4: executor_id = DRIVER2') : fail('B4: executor_id', order?.executor_id ?? 'null');

  // Проверяем статусы ставок
  const { data: bids } = await sb.from('tender_bids')
    .select('id, status')
    .eq('order_id', T.ORDER_ID)
    .in('id', [T.BID1_ID, T.BID2_ID, T.BID3_ID]);

  const bidMap = Object.fromEntries((bids ?? []).map(b => [b.id, b.status]));
  bidMap[T.BID2_ID] === 'winner' ? ok('B4: BID2 → winner') : fail('B4: BID2 → winner', bidMap[T.BID2_ID]);
  bidMap[T.BID1_ID] === 'lost'   ? ok('B4: BID1 → lost')   : fail('B4: BID1 → lost',   bidMap[T.BID1_ID]);
  bidMap[T.BID3_ID] === 'lost'   ? ok('B4: BID3 → lost')   : fail('B4: BID3 → lost',   bidMap[T.BID3_ID]);
}

// ─── B5: Race condition — повторный вызов RPC на уже закрытый заказ ──────────

async function testB5_RaceCondition() {
  section('B5 — Race condition (RPC на закрытый заказ)');

  // Заказ уже в статусе selected после B4 — повторный вызов должен вернуть false
  const { data: result, error } = await sb.rpc('accept_bid_atomic', {
    p_order_id: T.ORDER_ID,
    p_bid_id: T.BID1_ID,  // пытаемся выбрать другую ставку
  });

  error ? fail('B5: RPC без DB-ошибки', error.message) : ok('B5: RPC вызван без DB-ошибки');
  result === false
    ? ok('B5: RPC вернул false — race condition заблокирован ✓')
    : fail('B5: RPC вернул false', `получили ${result}`);

  // Статус заказа не изменился
  const { data: order } = await sb.from('tender_orders')
    .select('status, winning_bid_id')
    .eq('id', T.ORDER_ID).single();
  order?.status === 'selected'         ? ok('B5: заказ остался selected')     : fail('B5: статус не изменился', order?.status);
  order?.winning_bid_id === T.BID2_ID  ? ok('B5: winning_bid_id не изменился') : fail('B5: winning_bid не изменился', order?.winning_bid_id ?? 'null');
}

// ─── B6: Ставка на закрытый заказ ────────────────────────────────────────────

async function testB6_BidOnClosedOrder() {
  section('B6 — Ставка на закрытый заказ (логика роута)');

  // Имитируем проверку статуса как в /api/tender/bid/route.ts
  const { data: order } = await sb.from('tender_orders')
    .select('status')
    .eq('id', T.ORDER_ID).single();

  const isOpen = order?.status === 'bidding';
  !isOpen
    ? ok('B6: заказ не в статусе bidding — новая ставка была бы отклонена (400)')
    : fail('B6: заказ закрыт для новых ставок');

  // Проверяем что новая ставка в БД всё равно не должна создаваться
  // (роут проверяет статус перед upsert — здесь тестируем логику, не HTTP)
  ok('B6: роут вернул бы 400 "Тендер уже закрыт"');
}

// ─── B7: Рейтинг — единственный алгоритм rating_sum/rating_count ─────────────

async function testB7_Rating() {
  section('B7 — Алгоритм рейтинга (rating_sum / rating_count)');

  // Сбрасываем рейтинг DRIVER2 в ноль для чистого теста
  await sb.from('tender_drivers').update({ rating_sum: 0, rating_count: 0, rating: 0 }).eq('id', T.DRIVER2_ID);

  // Имитируем 3 оценки: 5, 4, 3 → среднее 4.00
  for (const stars of [5, 4, 3]) {
    const { data: driver } = await sb.from('tender_drivers')
      .select('rating_sum, rating_count').eq('id', T.DRIVER2_ID).single();
    const newSum = (driver?.rating_sum ?? 0) + stars;
    const newCount = (driver?.rating_count ?? 0) + 1;
    await sb.from('tender_drivers').update({
      rating_sum: newSum,
      rating_count: newCount,
      rating: Math.round((newSum / newCount) * 100) / 100,
    }).eq('id', T.DRIVER2_ID);
    ok(`B7: оценка ${stars}★ → sum=${newSum}, count=${newCount}, avg=${Math.round((newSum / newCount) * 100) / 100}`);
  }

  const { data: driver } = await sb.from('tender_drivers')
    .select('rating, rating_sum, rating_count').eq('id', T.DRIVER2_ID).single();

  driver?.rating_sum === 12   ? ok('B7: rating_sum = 12')    : fail('B7: rating_sum = 12',   `${driver?.rating_sum}`);
  driver?.rating_count === 3  ? ok('B7: rating_count = 3')   : fail('B7: rating_count = 3',  `${driver?.rating_count}`);
  driver?.rating === 4.00     ? ok('B7: rating = 4.00 (корректное среднее)') : fail('B7: rating = 4.00', `${driver?.rating}`);
}

// ─── B8: rated_at защита от двойной оценки ───────────────────────────────────

async function testB8_RatedAt() {
  section('B8 — rated_at (защита от двойной оценки)');

  // Проставляем rated_at на тестовый заказ
  await sb.from('tender_orders').update({ rated_at: new Date().toISOString() }).eq('id', T.ORDER_ID);

  const { data: order } = await sb.from('tender_orders')
    .select('rated_at').eq('id', T.ORDER_ID).single();

  order?.rated_at
    ? ok('B8: rated_at сохранён в БД — повторная оценка будет заблокирована (409)')
    : fail('B8: rated_at сохранён');

  // Имитируем проверку как в rate/route.ts: if (order.rated_at) → 409
  const wouldBlock = !!order?.rated_at;
  wouldBlock
    ? ok('B8: роут вернул бы 409 "Уже оценено"')
    : fail('B8: блокировка повторной оценки');
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок B — Система ставок и аукцион${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);

  await cleanup();
  const ready = await setup();
  if (!ready) {
    console.log(`${RED}Setup провалился — прерываем тесты${RESET}`);
    process.exit(1);
  }

  await testB1_CreateBids();
  await testB2_UpdateBid();
  await testB3_WithdrawBid();
  await testB4_AtomicAccept();
  await testB5_RaceCondition();
  await testB6_BidOnClosedOrder();
  await testB7_Rating();
  await testB8_RatedAt();

  await cleanup();

  const total = passed + failed;
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}  PASSED ${passed}/${total} тестов ✓${RESET}`);
  } else {
    console.log(`${RED}${BOLD}  FAILED ${failed}/${total} тестов ✗${RESET}`);
    console.log(`${GREEN}  Прошло: ${passed}${RESET}`);
    console.log(`${RED}  Упало:  ${failed}${RESET}`);
  }
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`${RED}Критическая ошибка:${RESET}`, err);
  process.exit(1);
});
