/**
 * Тест-скрипт: Блок D — Выбор победителя (Accept Bid Flow)
 * Эндпоинт: POST /api/tender/accept-bid
 * Body: { order_token, bid_id }  (токен заказа = авторизация клиента)
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
  ORDER_TOKEN: `test-d-${Date.now()}`,
  DRIVER1_ID:  '' as string,
  DRIVER2_ID:  '' as string,
  BID1_ID:     '' as string,   // ставка победителя
  BID2_ID:     '' as string,   // ставка проигравшего
  TG1: 6666000301,
  TG2: 6666000302,
  CLIENT_PHONE: '+995599000066',
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
    await sb.from('tender_bids').delete().eq('order_id', T.ORDER_ID);
    await sb.from('tender_orders').delete().eq('id', T.ORDER_ID);
  }
  await sb.from('tender_drivers')
    .update({ active_order_id: null })
    .in('telegram_id', [T.TG1, T.TG2]);
  await sb.from('tender_drivers').delete().in('telegram_id', [T.TG1, T.TG2]);
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup(): Promise<boolean> {
  section('Setup — создание тестовых данных');

  // Два водителя
  for (const [tg, name, phone, key] of [
    [T.TG1, 'D-Тест Водитель 1', '+99559900301', 'DRIVER1_ID'],
    [T.TG2, 'D-Тест Водитель 2', '+99559900302', 'DRIVER2_ID'],
  ] as [number, string, string, 'DRIVER1_ID' | 'DRIVER2_ID'][]) {
    const { data, error } = await sb.from('tender_drivers').upsert(
      { telegram_id: tg, name, phone, status: 'active', driver_language: 'ru', rating_sum: 0, rating_count: 0, rating: 0 },
      { onConflict: 'telegram_id' }
    ).select('id').single();
    if (error || !data) { fail(`Создан ${name}`, error?.message); return false; }
    T[key] = data.id;
    ok(`Создан ${name}`);
  }

  // Заказ в статусе bidding
  const { data: order, error: oe } = await sb.from('tender_orders').insert({
    token: T.ORDER_TOKEN,
    address_from: 'Марджанишвили 3',
    address_to: 'Глдани 7',
    cargo_description: 'Переезд офиса — 20 коробок',
    client_name: 'D-Тест Клиент',
    client_phone: T.CLIENT_PHONE,
    status: 'bidding',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();
  if (oe || !order) { fail('Создан заказ', oe?.message); return false; }
  T.ORDER_ID = order.id;
  ok(`Создан заказ`, `token=${T.ORDER_TOKEN.slice(0, 14)}`);

  // Две ставки
  for (const [driverId, amount, key] of [
    [T.DRIVER1_ID, 200, 'BID1_ID'],
    [T.DRIVER2_ID, 180, 'BID2_ID'],
  ] as [string, number, 'BID1_ID' | 'BID2_ID'][]) {
    const { data: bid, error: be } = await sb.from('tender_bids').insert({
      order_id: T.ORDER_ID,
      driver_id: driverId,
      amount,
      status: 'pending',
      bot_state: 'idle',
      bot_state_updated_at: new Date().toISOString(),
    }).select('id').single();
    if (be || !bid) { fail(`Создана ставка ${amount}₾`, be?.message); return false; }
    T[key] = bid.id;
    ok(`Создана ставка ${amount}₾`);
  }

  info(`API base: ${BASE_URL}`);
  info(`ORDER_TOKEN: ${T.ORDER_TOKEN}`);
  info(`BID1 (200₾, Водитель 1): ${T.BID1_ID.slice(0, 8)}`);
  info(`BID2 (180₾, Водитель 2): ${T.BID2_ID.slice(0, 8)}`);
  return true;
}

// ─── D1: Успешный accept — принимаем BID2 (180₾) ────────────────────────────

async function testD1_SuccessfulAccept() {
  section('D1 — Успешный accept: заказ → selected, BID2 → winner, BID1 → lost');

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    bid_id: T.BID2_ID,
  });

  const d = data as Record<string, unknown>;
  status === 200 ? ok('D1: POST /accept-bid → 200') : fail('D1: → 200', `статус ${status} — ${JSON.stringify(d)}`);
  d?.ok === true ? ok('D1: ответ содержит ok=true') : fail('D1: ok=true', JSON.stringify(d));

  // Проверяем заказ в БД
  const { data: order } = await sb.from('tender_orders')
    .select('status, winning_bid_id, executor_id')
    .eq('id', T.ORDER_ID).single();

  order?.status === 'selected'
    ? ok('D1: заказ → selected')
    : fail('D1: заказ → selected', order?.status);
  order?.winning_bid_id === T.BID2_ID
    ? ok('D1: winning_bid_id = BID2')
    : fail('D1: winning_bid_id = BID2', order?.winning_bid_id ?? 'null');
  order?.executor_id === T.DRIVER2_ID
    ? ok('D1: executor_id = DRIVER2')
    : fail('D1: executor_id = DRIVER2', order?.executor_id ?? 'null');

  // Проверяем статусы ставок
  const { data: bids } = await sb.from('tender_bids')
    .select('id, status')
    .eq('order_id', T.ORDER_ID);

  const bidMap = Object.fromEntries((bids ?? []).map(b => [b.id, b.status]));
  bidMap[T.BID2_ID] === 'winner'
    ? ok('D1: BID2 → winner')
    : fail('D1: BID2 → winner', bidMap[T.BID2_ID]);
  bidMap[T.BID1_ID] === 'lost'
    ? ok('D1: BID1 → lost')
    : fail('D1: BID1 → lost', bidMap[T.BID1_ID]);

  // active_order_id у победителя
  const { data: driver } = await sb.from('tender_drivers')
    .select('active_order_id')
    .eq('id', T.DRIVER2_ID).single();
  driver?.active_order_id === T.ORDER_ID
    ? ok('D1: active_order_id у DRIVER2 = ORDER_ID')
    : fail('D1: active_order_id DRIVER2', driver?.active_order_id ?? 'null');
}

// ─── D2: Неверный токен заказа → 404 ─────────────────────────────────────────

async function testD2_WrongToken() {
  section('D2 — Неверный order_token → 404');

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: 'несуществующий-токен-xyz-12345',
    bid_id: T.BID1_ID,
  });

  status === 404
    ? ok('D2: неверный order_token → 404')
    : fail('D2: → 404', `статус ${status} — ${JSON.stringify(data)}`);
}

// ─── D3: Race condition / повторный accept другой ставки → 409 ───────────────

async function testD3_RaceCondition() {
  section('D3 — Race condition: accept BID1 для заказа, уже закрытого на BID2 → 409');

  // Заказ уже в статусе selected (после D1) — попытка выбрать другую ставку
  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    bid_id: T.BID1_ID,
  });

  const d = data as Record<string, unknown>;
  status === 409
    ? ok('D3: повторный accept другой ставки → 409')
    : fail('D3: → 409', `статус ${status} — ${JSON.stringify(d)}`);
  (d?.error as string)?.length > 0
    ? ok('D3: тело содержит error-сообщение', d.error as string)
    : fail('D3: error в теле');
}

// ─── D4: Идемпотентность — accept той же ставки → 200 (ok) ──────────────────

async function testD4_Idempotency() {
  section('D4 — Идемпотентность: повторный accept той же winning-ставки → 200');

  // BID2 уже winner — повторный запрос должен вернуть ok=true (идемпотентность)
  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    bid_id: T.BID2_ID,
  });

  const d = data as Record<string, unknown>;
  status === 200
    ? ok('D4: повторный accept winner → 200 (idempotent)')
    : fail('D4: → 200', `статус ${status} — ${JSON.stringify(d)}`);
  d?.ok === true
    ? ok('D4: ok=true (idempotency confirmed)')
    : fail('D4: ok=true', JSON.stringify(d));

  // Статус заказа не изменился
  const { data: order } = await sb.from('tender_orders')
    .select('status, winning_bid_id').eq('id', T.ORDER_ID).single();
  order?.status === 'selected'
    ? ok('D4: статус заказа остался selected')
    : fail('D4: статус не изменился', order?.status);
  order?.winning_bid_id === T.BID2_ID
    ? ok('D4: winning_bid_id не изменился')
    : fail('D4: winning_bid_id', order?.winning_bid_id ?? 'null');
}

// ─── D5: Accept на completed-заказе → 400 ───────────────────────────────────

async function testD5_CompletedOrder() {
  section('D5 — Accept на completed-заказе → 400');

  // Переводим заказ в completed напрямую
  await sb.from('tender_orders').update({ status: 'completed' }).eq('id', T.ORDER_ID);

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    bid_id: T.BID1_ID,
  });

  const d = data as Record<string, unknown>;
  status === 400
    ? ok('D5: accept на completed → 400')
    : fail('D5: → 400', `статус ${status} — ${JSON.stringify(d)}`);
  (d?.error as string)?.includes('закрыт') || (d?.error as string)?.includes('выбран')
    ? ok('D5: сообщение об ошибке корректное', d.error as string)
    : fail('D5: текст ошибки', JSON.stringify(d));

  // Восстанавливаем для следующих тестов
  await sb.from('tender_orders').update({ status: 'selected' }).eq('id', T.ORDER_ID);
}

// ─── D6: Несуществующая ставка → 404 ────────────────────────────────────────

async function testD6_FakeBidId() {
  section('D6 — Несуществующий bid_id → 404');

  // Сначала сбрасываем заказ в bidding чтобы пройти guard на статус
  await sb.from('tender_orders').update({ status: 'bidding' }).eq('id', T.ORDER_ID);

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    bid_id: '00000000-0000-0000-0000-000000000000',
  });

  const d = data as Record<string, unknown>;
  status === 404
    ? ok('D6: несуществующий bid_id → 404')
    : fail('D6: → 404', `статус ${status} — ${JSON.stringify(d)}`);
  (d?.error as string)?.includes('не найдена') || (d?.error as string)?.includes('not found')
    ? ok('D6: сообщение "не найдена"', d.error as string)
    : fail('D6: текст ошибки', JSON.stringify(d));
}

// ─── D7: Обязательные поля — ни order_id ни order_token → 400 ────────────────

async function testD7_MissingFields() {
  section('D7 — Обязательные поля: без order_id/token → 400');

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    bid_id: T.BID1_ID,
    // нет order_id и order_token
  });

  status === 400
    ? ok('D7: без order → 400')
    : fail('D7: → 400', `статус ${status} — ${JSON.stringify(data)}`);

  const { status: s2, data: d2 } = await api('POST', '/api/tender/accept-bid', {
    order_token: T.ORDER_TOKEN,
    // нет bid_id
  });

  s2 === 400
    ? ok('D7: без bid_id → 400')
    : fail('D7: без bid_id → 400', `статус ${s2} — ${JSON.stringify(d2)}`);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок D — Выбор победителя (Accept Bid)${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);

  await cleanup();
  const ready = await setup();
  if (!ready) {
    console.log(`${RED}Setup провалился — прерываем тесты${RESET}`);
    process.exit(1);
  }

  await testD1_SuccessfulAccept();
  await testD2_WrongToken();
  await testD3_RaceCondition();
  await testD4_Idempotency();
  await testD5_CompletedOrder();
  await testD6_FakeBidId();
  await testD7_MissingFields();

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
