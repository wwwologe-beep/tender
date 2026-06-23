/**
 * Тест-скрипт: Блок E — Завершение заказа и рейтинг (Completion & Rating Flow)
 *
 * Эндпоинты:
 *   POST /api/tender/complete  { order_id, client_phone, rating?: 1-5, review?: string }
 *   POST /api/tender/rate      { order_token, driver_id, stars: 1-5 }
 *
 * Порядок флоу:
 *   setup (bidding) → accept-bid (selected) → complete (completed) → rate (rated_at)
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

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';

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
function info(msg: string) {
  console.log(`  ${CYAN}→${RESET} ${msg}`);
}

// ─── Тестовые данные ─────────────────────────────────────────────────────────

const T = {
  ORDER_ID:    '' as string,
  ORDER_TOKEN: `test-e-${Date.now()}`,
  DRIVER_ID:   '' as string,
  BID_ID:      '' as string,
  TG1: 5555000401,
  CLIENT_PHONE: '+995599000055',
  BID_AMOUNT: 250,
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const url = `${BASE_URL}${urlPath}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// ─── Очистка ─────────────────────────────────────────────────────────────────

async function cleanup() {
  if (T.ORDER_ID) {
    await sb.from('market_snapshots').delete().eq('order_id', T.ORDER_ID);
    await sb.from('tender_bids').delete().eq('order_id', T.ORDER_ID);
    await sb.from('tender_orders').delete().eq('id', T.ORDER_ID);
  }
  await sb.from('tender_drivers')
    .update({ active_order_id: null })
    .eq('telegram_id', T.TG1);
  await sb.from('tender_drivers').delete().eq('telegram_id', T.TG1);
}

// ─── Setup: bidding → selected ───────────────────────────────────────────────

async function setup(): Promise<boolean> {
  section('Setup — создание данных и переход в selected');

  // Водитель с чистым рейтингом
  const { data: driver, error: de } = await sb.from('tender_drivers').upsert(
    {
      telegram_id: T.TG1,
      name: 'E-Тест Водитель',
      phone: '+99559900401',
      status: 'active',
      driver_language: 'ru',
      rating_sum: 0,
      rating_count: 0,
      rating: 0,
      completed_orders: 0,
      total_earned: 0,
    },
    { onConflict: 'telegram_id' }
  ).select('id').single();
  if (de || !driver) { fail('Создан водитель', de?.message); return false; }
  T.DRIVER_ID = driver.id;
  ok('Создан водитель (rating_sum=0, rating_count=0)');

  // Заказ в bidding
  const { data: order, error: oe } = await sb.from('tender_orders').insert({
    token: T.ORDER_TOKEN,
    address_from: 'Авлабари 1',
    address_to: 'Нуцубидзе 5',
    cargo_description: 'Переезд квартиры — 3 комнаты',
    client_name: 'E-Тест Клиент',
    client_phone: T.CLIENT_PHONE,
    status: 'bidding',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();
  if (oe || !order) { fail('Создан заказ', oe?.message); return false; }
  T.ORDER_ID = order.id;
  ok(`Создан заказ`, T.ORDER_ID.slice(0, 8));

  // Ставка
  const { data: bid, error: be } = await sb.from('tender_bids').insert({
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER_ID,
    amount: T.BID_AMOUNT,
    status: 'pending',
    bot_state: 'idle',
    bot_state_updated_at: new Date().toISOString(),
  }).select('id').single();
  if (be || !bid) { fail('Создана ставка', be?.message); return false; }
  T.BID_ID = bid.id;
  ok(`Создана ставка ${T.BID_AMOUNT}₾`);

  // Accept через RPC → selected
  const { data: accepted, error: rpcErr } = await sb.rpc('accept_bid_atomic', {
    p_order_id: T.ORDER_ID,
    p_bid_id: T.BID_ID,
  });
  if (rpcErr || !accepted) { fail('RPC accept_bid_atomic', rpcErr?.message ?? 'вернул false'); return false; }
  ok('RPC accept_bid_atomic → заказ в selected');

  // active_order_id у водителя
  await sb.from('tender_drivers')
    .update({ active_order_id: T.ORDER_ID })
    .eq('id', T.DRIVER_ID);
  ok('active_order_id водителя установлен');

  info(`ORDER_TOKEN: ${T.ORDER_TOKEN}`);
  info(`DRIVER_ID:   ${T.DRIVER_ID.slice(0, 8)}`);
  info(`BID_ID:      ${T.BID_ID.slice(0, 8)}`);
  return true;
}

// ─── E1: Успешное завершение с рейтингом ─────────────────────────────────────

async function testE1_SuccessfulCompletion() {
  section('E1 — Успешное завершение заказа с рейтингом 5');

  const { status, data } = await api('POST', '/api/tender/complete', {
    order_id: T.ORDER_ID,
    client_phone: T.CLIENT_PHONE,
    rating: 5,
    review: 'Отличная работа, всё вовремя!',
  });

  const d = data as Record<string, unknown>;
  status === 200
    ? ok('E1: POST /complete → 200')
    : fail('E1: → 200', `статус ${status} — ${JSON.stringify(d)}`);
  d?.ok === true
    ? ok('E1: ответ содержит ok=true')
    : fail('E1: ok=true', JSON.stringify(d));

  // Проверяем заказ в БД
  const { data: order } = await sb.from('tender_orders')
    .select('status, completed_at, client_rating, client_review')
    .eq('id', T.ORDER_ID).single();

  order?.status === 'completed'
    ? ok('E1: заказ → completed')
    : fail('E1: status=completed', order?.status);
  !!order?.completed_at
    ? ok('E1: completed_at заполнен')
    : fail('E1: completed_at заполнен');
  order?.client_rating === 5
    ? ok('E1: client_rating = 5 в заказе')
    : fail('E1: client_rating=5', String(order?.client_rating));
  order?.client_review === 'Отличная работа, всё вовремя!'
    ? ok('E1: client_review сохранён')
    : fail('E1: client_review', order?.client_review);
}

// ─── E2: Пересчёт агрегатов рейтинга водителя ────────────────────────────────

async function testE2_RatingAggregates() {
  section('E2 — Пересчёт рейтинга водителя (rating_sum, rating_count, rating, completed_orders)');

  const { data: driver } = await sb.from('tender_drivers')
    .select('rating_sum, rating_count, rating, completed_orders, total_earned')
    .eq('id', T.DRIVER_ID).single();

  driver?.rating_sum === 5
    ? ok('E2: rating_sum = 5 (0 + 5)')
    : fail('E2: rating_sum=5', String(driver?.rating_sum));
  driver?.rating_count === 1
    ? ok('E2: rating_count = 1')
    : fail('E2: rating_count=1', String(driver?.rating_count));
  driver?.rating === 5.00
    ? ok('E2: rating = 5.00 (5/1)')
    : fail('E2: rating=5.00', String(driver?.rating));
  driver?.completed_orders === 1
    ? ok('E2: completed_orders = 1')
    : fail('E2: completed_orders=1', String(driver?.completed_orders));
  driver?.total_earned === T.BID_AMOUNT
    ? ok(`E2: total_earned = ${T.BID_AMOUNT}₾`)
    : fail(`E2: total_earned=${T.BID_AMOUNT}`, String(driver?.total_earned));
}

// ─── E3: Повторное завершение → 400 (заказ уже completed) ────────────────────

async function testE3_RepeatCompletion() {
  section('E3 — Повторное завершение → 400 (заказ уже completed)');

  const { status, data } = await api('POST', '/api/tender/complete', {
    order_id: T.ORDER_ID,
    client_phone: T.CLIENT_PHONE,
    rating: 4,
  });

  const d = data as Record<string, unknown>;
  status === 400
    ? ok('E3: повторное завершение → 400')
    : fail('E3: → 400', `статус ${status} — ${JSON.stringify(d)}`);
  (d?.error as string)?.includes('selected')
    ? ok('E3: сообщение "Заказ не в статусе selected"', d.error as string)
    : fail('E3: текст ошибки', JSON.stringify(d));

  // Убеждаемся что рейтинг водителя не изменился
  const { data: driver } = await sb.from('tender_drivers')
    .select('rating_sum, rating_count').eq('id', T.DRIVER_ID).single();
  driver?.rating_sum === 5
    ? ok('E3: rating_sum не изменился (остался 5)')
    : fail('E3: rating_sum не изменился', String(driver?.rating_sum));
}

// ─── E4: Отдельная оценка через /rate (после completed) ──────────────────────

async function testE4_SeparateRating() {
  section('E4 — POST /rate: оценка после complete (rated_at защита)');

  // Первая оценка через /rate должна работать (complete уже записал rated_at через client_rating)
  // НО: /rate смотрит на поле rated_at в tender_orders — complete его НЕ заполняет.
  // complete записывает client_rating напрямую. rated_at заполняет только /rate.
  // Значит первый /rate вызов должен пройти.

  const { status, data } = await api('POST', '/api/tender/rate', {
    order_token: T.ORDER_TOKEN,
    driver_id: T.DRIVER_ID,
    stars: 4,
  });

  const d = data as Record<string, unknown>;
  status === 200
    ? ok('E4: POST /rate → 200 (первая оценка через /rate)')
    : fail('E4: → 200', `статус ${status} — ${JSON.stringify(d)}`);
  d?.ok === true
    ? ok('E4: ok=true')
    : fail('E4: ok=true', JSON.stringify(d));

  // rated_at теперь должен быть заполнен
  const { data: order } = await sb.from('tender_orders')
    .select('rated_at').eq('id', T.ORDER_ID).single();
  !!order?.rated_at
    ? ok('E4: rated_at заполнен → защита от повторной оценки активна')
    : fail('E4: rated_at заполнен');

  // Рейтинг обновился (было 5 от complete + 4 от /rate → sum=9, count=2, avg=4.5)
  const { data: driver } = await sb.from('tender_drivers')
    .select('rating_sum, rating_count, rating').eq('id', T.DRIVER_ID).single();
  driver?.rating_sum === 9
    ? ok('E4: rating_sum = 9 (5 + 4)')
    : fail('E4: rating_sum=9', String(driver?.rating_sum));
  driver?.rating_count === 2
    ? ok('E4: rating_count = 2')
    : fail('E4: rating_count=2', String(driver?.rating_count));
  driver?.rating === 4.5
    ? ok('E4: rating = 4.50 (9/2)')
    : fail('E4: rating=4.50', String(driver?.rating));
}

// ─── E5: Повторная оценка через /rate → 409 (rated_at заполнен) ──────────────

async function testE5_DoubleRating() {
  section('E5 — Повторная оценка через /rate → 409 (rated_at защита)');

  const { status, data } = await api('POST', '/api/tender/rate', {
    order_token: T.ORDER_TOKEN,
    driver_id: T.DRIVER_ID,
    stars: 1,
  });

  const d = data as Record<string, unknown>;
  status === 409
    ? ok('E5: повторная оценка → 409')
    : fail('E5: → 409', `статус ${status} — ${JSON.stringify(d)}`);
  (d?.error as string)?.includes('Уже')
    ? ok('E5: сообщение "Уже оценено"', d.error as string)
    : fail('E5: текст ошибки', JSON.stringify(d));

  // Рейтинг НЕ изменился
  const { data: driver } = await sb.from('tender_drivers')
    .select('rating_sum, rating_count').eq('id', T.DRIVER_ID).single();
  driver?.rating_sum === 9
    ? ok('E5: rating_sum не изменился (9)')
    : fail('E5: rating_sum не изменился', String(driver?.rating_sum));
}

// ─── E6: Неверный client_phone при complete → 403 ────────────────────────────

async function testE6_WrongPhone() {
  section('E6 — Неверный client_phone → 403');

  // Создаём новый свежий заказ в selected для этого теста
  const token2 = `test-e2-${Date.now()}`;
  const { data: order2 } = await sb.from('tender_orders').insert({
    token: token2,
    address_from: 'Тест 1',
    address_to: 'Тест 2',
    cargo_description: 'Тест E6',
    client_name: 'E6 Клиент',
    client_phone: T.CLIENT_PHONE,
    status: 'selected',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();

  if (!order2) { fail('E6: setup order2'); return; }

  const { status } = await api('POST', '/api/tender/complete', {
    order_id: order2.id,
    client_phone: '+995500000000',  // чужой телефон
    rating: 5,
  });

  status === 403
    ? ok('E6: чужой client_phone → 403')
    : fail('E6: → 403', `статус ${status}`);

  await sb.from('tender_orders').delete().eq('id', order2.id);
}

// ─── E7: Валидация рейтинга — границы 0 и 6 → 400 ───────────────────────────

async function testE7_RatingBounds() {
  section('E7 — Валидация рейтинга: 0 и 6 → 400');

  // Создаём ещё один selected-заказ для теста валидации
  const token3 = `test-e3-${Date.now()}`;
  const { data: order3 } = await sb.from('tender_orders').insert({
    token: token3,
    address_from: 'Тест 1',
    address_to: 'Тест 2',
    cargo_description: 'Тест E7',
    client_name: 'E7 Клиент',
    client_phone: T.CLIENT_PHONE,
    status: 'selected',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();

  if (!order3) { fail('E7: setup order3'); return; }

  for (const [label, stars] of [['0 баллов', 0], ['6 баллов', 6]] as [string, number][]) {
    const { status, data } = await api('POST', '/api/tender/complete', {
      order_id: order3.id,
      client_phone: T.CLIENT_PHONE,
      rating: stars,
    });
    status === 400
      ? ok(`E7: rating=${stars} (${label}) → 400`)
      : fail(`E7: rating=${stars} → 400`, `статус ${status} — ${JSON.stringify(data)}`);
  }

  // То же самое для /rate
  for (const [label, stars] of [['0', 0], ['6', 6]] as [string, number][]) {
    const { status } = await api('POST', '/api/tender/rate', {
      order_token: token3,
      driver_id: T.DRIVER_ID,
      stars,
    });
    status === 400
      ? ok(`E7: /rate stars=${stars} (${label}) → 400`)
      : fail(`E7: /rate stars=${stars} → 400`, `статус ${status}`);
  }

  await sb.from('tender_orders').delete().eq('id', order3.id);
}

// ─── E8: complete без обязательных полей → 400 ───────────────────────────────

async function testE8_MissingFields() {
  section('E8 — Обязательные поля complete: без order_id или client_phone → 400');

  const { status: s1 } = await api('POST', '/api/tender/complete', {
    client_phone: T.CLIENT_PHONE,
    // нет order_id
  });
  s1 === 400 ? ok('E8: без order_id → 400') : fail('E8: без order_id → 400', `${s1}`);

  const { status: s2 } = await api('POST', '/api/tender/complete', {
    order_id: T.ORDER_ID,
    // нет client_phone
  });
  s2 === 400 ? ok('E8: без client_phone → 400') : fail('E8: без client_phone → 400', `${s2}`);

  const { status: s3 } = await api('POST', '/api/tender/rate', {
    driver_id: T.DRIVER_ID,
    stars: 5,
    // нет order_token
  });
  s3 === 400 ? ok('E8: /rate без order_token → 400') : fail('E8: /rate без order_token → 400', `${s3}`);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок E — Завершение и рейтинг${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);

  await cleanup();
  const ready = await setup();
  if (!ready) {
    console.log(`${RED}Setup провалился — прерываем тесты${RESET}`);
    process.exit(1);
  }

  await testE1_SuccessfulCompletion();
  await testE2_RatingAggregates();
  await testE3_RepeatCompletion();
  await testE4_SeparateRating();
  await testE5_DoubleRating();
  await testE6_WrongPhone();
  await testE7_RatingBounds();
  await testE8_MissingFields();

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
