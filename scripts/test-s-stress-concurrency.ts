/**
 * Стресс-тест: Race Conditions под нагрузкой
 *
 * S1: 5 параллельных accept_bid_atomic на один заказ — ровно 1 должен победить.
 * S2: 10 параллельных POST /api/tender/bid от одного водителя — upsert гарантирует
 *     ровно 1 запись в БД (PostgreSQL unique constraint + onConflict).
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
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

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

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function api(urlPath: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: unknown;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

// ─── ID пула для cleanup ──────────────────────────────────────────────────────

const cleanup_orders: string[]  = [];
const cleanup_drivers: number[] = [];

async function cleanup() {
  for (const oid of cleanup_orders) {
    await sb.from('tender_bids').delete().eq('order_id', oid);
    await sb.from('tender_orders').delete().eq('id', oid);
  }
  if (cleanup_drivers.length) {
    await sb.from('tender_drivers').update({ active_order_id: null }).in('telegram_id', cleanup_drivers);
    await sb.from('tender_drivers').delete().in('telegram_id', cleanup_drivers);
  }
  info(`Cleanup: ${cleanup_orders.length} заказов, ${cleanup_drivers.length} водителей удалено`);
}

// ─── Хелпер: создать водителя ────────────────────────────────────────────────

async function createDriver(tgId: number, name: string): Promise<string> {
  const { data, error } = await sb.from('tender_drivers').upsert(
    { telegram_id: tgId, name, phone: `+9955990${tgId % 10000}`, status: 'active',
      driver_language: 'ru', rating_sum: 0, rating_count: 0, rating: 0 },
    { onConflict: 'telegram_id' }
  ).select('id').single();
  if (error || !data) throw new Error(`Не удалось создать водителя ${name}: ${error?.message}`);
  cleanup_drivers.push(tgId);
  return data.id;
}

// ─── Хелпер: создать заказ ───────────────────────────────────────────────────

async function createOrder(label: string): Promise<{ id: string; token: string }> {
  const { data, error } = await sb.from('tender_orders').insert({
    token: `stress-${label}-${Date.now()}`,
    address_from: 'Стресс 1',
    address_to: 'Стресс 2',
    cargo_description: `Стресс-тест ${label}`,
    client_name: 'Стресс Клиент',
    client_phone: '+995599000099',
    status: 'bidding',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id, token').single();
  if (error || !data) throw new Error(`Не удалось создать заказ: ${error?.message}`);
  cleanup_orders.push(data.id);
  return data;
}

// ─── S1: 5 параллельных accept_bid_atomic ────────────────────────────────────

async function testS1_ConcurrentAccept() {
  section('S1 — Конкурентный accept: 5 параллельных RPC → ровно 1 победитель');

  // Создаём заказ
  const order = await createOrder('s1');
  info(`Заказ: ${order.id.slice(0, 8)} (token: ${order.token.slice(0, 14)})`);

  // 5 водителей
  const DRIVERS = 5;
  const tgBase = 9100001;
  const driverIds: string[] = [];
  for (let i = 0; i < DRIVERS; i++) {
    const id = await createDriver(tgBase + i, `S1-Водитель-${i + 1}`);
    driverIds.push(id);
  }
  ok(`S1: создано ${DRIVERS} водителей`);

  // 5 ставок
  const bidIds: string[] = [];
  for (let i = 0; i < DRIVERS; i++) {
    const { data, error } = await sb.from('tender_bids').insert({
      order_id: order.id,
      driver_id: driverIds[i],
      amount: 100 + i * 10,
      status: 'pending',
      bot_state: 'idle',
      bot_state_updated_at: new Date().toISOString(),
    }).select('id').single();
    if (error || !data) { fail(`S1: ставка ${i + 1}`, error?.message); return; }
    bidIds.push(data.id);
  }
  ok(`S1: создано ${DRIVERS} ставок`);

  info('S1: запускаем 5 параллельных RPC accept_bid_atomic...');
  const start = Date.now();

  // Все 5 вызовов одновременно через Promise.all напрямую через Supabase RPC
  const results = await Promise.all(
    bidIds.map(bidId =>
      sb.rpc('accept_bid_atomic', { p_order_id: order.id, p_bid_id: bidId })
        .then(r => ({ bidId, result: r.data as boolean, error: r.error }))
    )
  );

  const elapsed = Date.now() - start;
  info(`S1: все 5 RPC завершились за ${elapsed}мс`);

  // Анализ результатов
  const winners  = results.filter(r => r.result === true  && !r.error);
  const losers   = results.filter(r => r.result === false && !r.error);
  const errors   = results.filter(r => r.error);

  info(`S1: winners=${winners.length}, blocked=${losers.length}, errors=${errors.length}`);

  for (const r of results) {
    const icon = r.result === true ? `${GREEN}✓ true ${RESET}` : `${YELLOW}✗ false${RESET}`;
    console.log(`    ${icon} bid ${r.bidId.slice(0, 8)} ${r.error ? `(err: ${r.error.message})` : ''}`);
  }

  winners.length === 1
    ? ok('S1: ровно 1 RPC вернул true (победитель)')
    : fail('S1: ровно 1 победитель', `получили ${winners.length}`);

  losers.length === DRIVERS - 1
    ? ok(`S1: ${losers.length} RPC заблокированы (false) — race condition удержан`)
    : fail(`S1: ${DRIVERS - 1} заблокированы`, `получили ${losers.length} (errors=${errors.length})`);

  errors.length === 0
    ? ok('S1: ни один RPC не упал с ошибкой БД')
    : fail('S1: ошибок БД нет', `${errors.length} ошибок: ${errors.map(e => e.error?.message).join(', ')}`);

  // Проверяем БД: строго 1 winner, остальные lost
  const { data: bids } = await sb.from('tender_bids')
    .select('id, status').eq('order_id', order.id);

  const winnerBids = (bids ?? []).filter(b => b.status === 'winner');
  const lostBids   = (bids ?? []).filter(b => b.status === 'lost');

  winnerBids.length === 1
    ? ok('S1: в БД ровно 1 bid со статусом winner', `bid ${winnerBids[0]?.id?.slice(0, 8)}`)
    : fail('S1: в БД 1 winner', `${winnerBids.length}`);

  lostBids.length === DRIVERS - 1
    ? ok(`S1: в БД ${lostBids.length} bids со статусом lost`)
    : fail(`S1: в БД ${DRIVERS - 1} lost`, `${lostBids.length}`);

  // Заказ в статусе selected, executor_id заполнен
  const { data: orderRow } = await sb.from('tender_orders')
    .select('status, executor_id, winning_bid_id').eq('id', order.id).single();

  orderRow?.status === 'selected'
    ? ok('S1: заказ → selected')
    : fail('S1: заказ status=selected', orderRow?.status);

  !!orderRow?.executor_id
    ? ok('S1: executor_id заполнен', orderRow.executor_id.slice(0, 8))
    : fail('S1: executor_id заполнен');

  !!orderRow?.winning_bid_id
    ? ok('S1: winning_bid_id заполнен', orderRow.winning_bid_id.slice(0, 8))
    : fail('S1: winning_bid_id заполнен');

  // Консистентность: winning_bid_id совпадает с единственным winner в bids
  orderRow?.winning_bid_id === winnerBids[0]?.id
    ? ok('S1: winning_bid_id == единственный winner в bids ✓')
    : fail('S1: winning_bid_id консистентен', `${orderRow?.winning_bid_id?.slice(0, 8)} vs ${winnerBids[0]?.id?.slice(0, 8)}`);
}

// ─── S2: 10 параллельных POST /bid от одного водителя ────────────────────────

async function testS2_ConcurrentBidSpam() {
  section('S2 — Параллельный спам ставками: 10 запросов → 1 запись в БД');

  const order = await createOrder('s2');
  info(`Заказ: ${order.id.slice(0, 8)}`);

  // Один водитель
  const tgId = 9100099;
  const driverId = await createDriver(tgId, 'S2-Спам-Водитель');
  ok('S2: водитель создан');

  const CONCURRENCY = 10;
  info(`S2: запускаем ${CONCURRENCY} параллельных POST /api/tender/bid...`);
  const start = Date.now();

  // 10 одновременных запросов
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      api('/api/tender/bid', {
        order_id: order.id,
        driver_id: driverId,
        amount: 150 + i,  // разные суммы — upsert обновит на последнюю
      }).then(r => ({ idx: i, ...r }))
    )
  );

  const elapsed = Date.now() - start;
  info(`S2: все ${CONCURRENCY} запросов завершились за ${elapsed}мс`);

  const ok200  = results.filter(r => r.status === 200);
  const errors = results.filter(r => r.status >= 500);
  const other  = results.filter(r => r.status !== 200 && r.status < 500);

  info(`S2: 200=${ok200.length}, 5xx=${errors.length}, other=${other.length}`);
  for (const r of results) {
    const color = r.status === 200 ? GREEN : (r.status >= 500 ? RED : YELLOW);
    console.log(`    ${color}HTTP ${r.status}${RESET} — запрос #${r.idx + 1}`);
  }

  // Все должны вернуть 200 (upsert идемпотентен — не блокирует, а обновляет)
  ok200.length === CONCURRENCY
    ? ok(`S2: все ${CONCURRENCY} запросов вернули 200 (upsert idempotent)`)
    : fail(`S2: все → 200`, `получили: 200=${ok200.length}, err=${errors.length}, other=${other.length}`);

  errors.length === 0
    ? ok('S2: ни одного 5xx (БД выдержала нагрузку)')
    : fail('S2: нет 5xx', `${errors.length} ошибок`);

  // В БД должна быть ровно 1 запись (unique constraint order_id + driver_id)
  const { count } = await sb.from('tender_bids')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', order.id)
    .eq('driver_id', driverId);

  count === 1
    ? ok('S2: в БД ровно 1 bid (PostgreSQL unique constraint сработал ✓)')
    : fail('S2: в БД 1 bid', `${count} записей`);

  // Сумма в БД — последняя выигравшая в race (непредсказуема, но должна быть в диапазоне)
  const { data: bid } = await sb.from('tender_bids')
    .select('amount, status').eq('order_id', order.id).eq('driver_id', driverId).single();

  bid?.amount >= 150 && bid?.amount <= 150 + CONCURRENCY - 1
    ? ok(`S2: сумма ставки в диапазоне 150-${150 + CONCURRENCY - 1}₾`, `${bid?.amount}₾`)
    : fail('S2: сумма ставки в диапазоне', `${bid?.amount}`);

  bid?.status === 'pending'
    ? ok('S2: статус ставки = pending')
    : fail('S2: status=pending', bid?.status);
}

// ─── S3: 3 параллельных accept через HTTP (реальный Telegram-флоу) ────────────

async function testS3_ConcurrentAcceptHTTP() {
  section('S3 — Конкурентный accept через HTTP API: 3 параллельных → 1 победитель');

  const order = await createOrder('s3');
  const token = order.token;
  info(`Заказ: ${order.id.slice(0, 8)} / token: ${token.slice(0, 14)}`);

  // 3 водителя и ставки
  const tgBase = 9100010;
  const bidIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const dId = await createDriver(tgBase + i, `S3-Водитель-${i + 1}`);
    const { data: bid } = await sb.from('tender_bids').insert({
      order_id: order.id, driver_id: dId,
      amount: 200 + i * 20, status: 'pending',
      bot_state: 'idle', bot_state_updated_at: new Date().toISOString(),
    }).select('id').single();
    if (bid) bidIds.push(bid.id);
  }
  ok(`S3: создано 3 водителя и 3 ставки`);

  info('S3: 3 параллельных POST /api/tender/accept-bid...');
  const start = Date.now();

  const results = await Promise.all(
    bidIds.map(bidId =>
      api('/api/tender/accept-bid', { order_token: token, bid_id: bidId })
        .then(r => ({ bidId, ...r }))
    )
  );

  const elapsed = Date.now() - start;
  info(`S3: завершились за ${elapsed}мс`);

  const success = results.filter(r => r.status === 200);
  const blocked = results.filter(r => r.status === 409 || r.status === 400);

  for (const r of results) {
    const color = r.status === 200 ? GREEN : YELLOW;
    const d = r.data as Record<string, unknown>;
    console.log(`    ${color}HTTP ${r.status}${RESET} bid=${r.bidId.slice(0, 8)} ${d?.ok ? '✓' : (d?.error ?? '')}`);
  }

  success.length === 1
    ? ok('S3: ровно 1 HTTP-запрос вернул 200')
    : fail('S3: 1 победитель через HTTP', `${success.length} успехов`);

  blocked.length === 2
    ? ok('S3: 2 HTTP-запроса заблокированы (409/400)')
    : fail('S3: 2 заблокированы', `${blocked.length}`);

  // Проверяем БД
  const { data: orderRow } = await sb.from('tender_orders')
    .select('status, winning_bid_id').eq('id', order.id).single();
  orderRow?.status === 'selected'
    ? ok('S3: заказ → selected')
    : fail('S3: status=selected', orderRow?.status);

  const { data: winnerBids } = await sb.from('tender_bids')
    .select('id').eq('order_id', order.id).eq('status', 'winner');
  (winnerBids ?? []).length === 1
    ? ok('S3: в БД ровно 1 winner bid')
    : fail('S3: 1 winner в БД', `${(winnerBids ?? []).length}`);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Стресс-тест: Race Conditions & Concurrency${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);
  info(`API base: ${BASE_URL}`);

  try {
    await testS1_ConcurrentAccept();
    await testS2_ConcurrentBidSpam();
    await testS3_ConcurrentAcceptHTTP();
  } finally {
    await cleanup();
  }

  const total = passed + failed;
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}  PASSED ${passed}/${total} тестов ✓  — система устойчива к race conditions${RESET}`);
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
