/**
 * Block W — Telegram Webhook Receiver Tests
 *
 * W1: Security — запросы без / с неверным секретом → 401
 * W2: Valid Bid via b:<token>:<price> — ставка создаётся в tender_bids
 * W3: Valid Accept via a:<token> — ставка = client_budget
 * W4: Unknown driver → 200 OK (Telegram не получает 5xx), ставка не создаётся
 * W5: Closed order → 200 OK, ставка не создаётся
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL     = process.env.TEST_BASE_URL ?? 'http://localhost:3000';
const WEBHOOK_URL  = `${BASE_URL}/api/telegram/webhook`;

// Поддерживаем оба имени (как в роуте)
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TELEGRAM_SECRET_TOKEN ?? '';

const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

let passed = 0;
let failed = 0;

// Тестовые данные — очищаем в конце
let testDriverId   = '';
let testOrderId    = '';
let testOrderToken = '';
const TEST_TELEGRAM_ID = 8800001; // несуществующий, но уникальный

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok(name: string, cond: boolean, info?: unknown) {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passed++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}`, info ?? '');
    failed++;
  }
}

function section(name: string) {
  console.log(`\n\x1b[34m━━━ ${name} ━━━\x1b[0m`);
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Строит Telegram Update с callback_query
function makeTelegramUpdate(telegramId: number, callbackData: string) {
  return {
    update_id: 100000001,
    callback_query: {
      id: 'cq_test_' + Date.now(),
      from: {
        id: telegramId,
        is_bot: false,
        first_name: 'TestDriver',
        username: 'testdriver_w',
        language_code: 'ru',
      },
      data: callbackData,
      chat_instance: '-123456789',
    },
  };
}

async function postWebhook(body: unknown, secret?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== undefined) headers['x-telegram-bot-api-secret-token'] = secret;
  return fetch(WEBHOOK_URL, { method: 'POST', headers, body: JSON.stringify(body) });
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  // Создаём тестового водителя
  const { data: d } = await db
    .from('tender_drivers')
    .insert({
      name:            'Test Driver W',
      phone:           '+99500000801',
      telegram_id:     TEST_TELEGRAM_ID,
      specialization:  'mover',
      status:          'active',
      driver_language: 'ru',
      rating:          5.0,
    })
    .select('id')
    .single();
  testDriverId = d?.id ?? '';

  // Создаём тестовый заказ через API
  const res = await fetch(`${BASE_URL}/api/tender/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cargo_description: 'Тест W: переезд мебели',
      address_from:      'Тбилиси, ул. Руставели 1',
      address_to:        'Тбилиси, ул. Пушкина 5',
      client_phone:      '+99500000800',
      category:          'moving',
      client_budget:     250,
      structured:        true,
    }),
  });
  const data = await res.json() as { order?: { id: string; token: string } };
  testOrderId    = data.order?.id    ?? '';
  testOrderToken = data.order?.token ?? '';
}

// ─── W1: Security ─────────────────────────────────────────────────────────────

async function testW1() {
  section('W1 — Security: invalid token → 401');

  const body = makeTelegramUpdate(TEST_TELEGRAM_ID, `b:${testOrderToken}:100`);

  // Без заголовка
  const r1 = await postWebhook(body);
  ok('Без токена → 401', r1.status === 401, r1.status);

  // С неверным токеном
  const r2 = await postWebhook(body, 'wrong_secret_xyz');
  ok('Неверный токен → 401', r2.status === 401, r2.status);

  // С пустой строкой
  const r3 = await postWebhook(body, '');
  ok('Пустой токен → 401', r3.status === 401, r3.status);

  // С верным токеном → не 401 (200 или другой, но не 401)
  const r4 = await postWebhook(body, SECRET);
  ok('Верный токен → не 401', r4.status !== 401, r4.status);
}

// ─── W2: Valid Bid via b:<token>:<price> ──────────────────────────────────────

async function testW2() {
  section('W2 — Valid bid via b:<token>:<price>');

  if (!testOrderToken || !testDriverId) {
    ok('Setup данные есть', false, { testOrderToken, testDriverId }); return;
  }

  // Убедимся что ставок ещё нет
  await db.from('tender_bids').delete().eq('order_id', testOrderId).eq('driver_id', testDriverId);

  const callbackData = `b:${testOrderToken}:150`;
  ok(`callback_data длина ≤ 64 байт`, Buffer.byteLength(callbackData, 'utf8') <= 64,
    `${Buffer.byteLength(callbackData, 'utf8')} байт`);

  const body = makeTelegramUpdate(TEST_TELEGRAM_ID, callbackData);
  const res  = await postWebhook(body, SECRET);
  ok('POST /webhook → 200', res.status === 200, res.status);

  // Grammy обрабатывает async — ждём
  await sleep(2000);

  const { data: bid } = await db
    .from('tender_bids')
    .select('amount, status, driver_id')
    .eq('order_id', testOrderId)
    .eq('driver_id', testDriverId)
    .maybeSingle();

  ok('Ставка создана в tender_bids', !!bid, bid);
  ok('Сумма ставки = 150', bid?.amount === 150, bid?.amount);
  ok('Статус ставки = pending', bid?.status === 'pending', bid?.status);
  ok('driver_id совпадает', bid?.driver_id === testDriverId, bid?.driver_id);
}

// ─── W3: Accept budget via a:<token> ─────────────────────────────────────────

async function testW3() {
  section('W3 — Accept client budget via a:<token>');

  if (!testOrderToken || !testDriverId) {
    ok('Setup данные есть', false); return;
  }

  // Сбрасываем ставку
  await db.from('tender_bids').delete().eq('order_id', testOrderId).eq('driver_id', testDriverId);

  const callbackData = `a:${testOrderToken}`;
  ok(`callback_data длина ≤ 64 байт`, Buffer.byteLength(callbackData, 'utf8') <= 64,
    `${Buffer.byteLength(callbackData, 'utf8')} байт`);

  const body = makeTelegramUpdate(TEST_TELEGRAM_ID, callbackData);
  const res  = await postWebhook(body, SECRET);
  ok('POST /webhook → 200', res.status === 200, res.status);

  await sleep(2000);

  const { data: bid } = await db
    .from('tender_bids')
    .select('amount, status')
    .eq('order_id', testOrderId)
    .eq('driver_id', testDriverId)
    .maybeSingle();

  ok('Ставка создана', !!bid, bid);
  // client_budget = 250 (задан при создании заказа)
  ok('Сумма = client_budget (250)', bid?.amount === 250, bid?.amount);
  ok('Статус = pending', bid?.status === 'pending', bid?.status);
}

// ─── W4: Unknown driver ───────────────────────────────────────────────────────

async function testW4() {
  section('W4 — Unknown driver → 200 OK, bid not created');

  const FAKE_TG_ID = 9999999998;
  const body = makeTelegramUpdate(FAKE_TG_ID, `b:${testOrderToken}:99`);
  const res  = await postWebhook(body, SECRET);
  // Telegram требует 200 всегда, иначе ретраит
  ok('Вебхук → 200 (Telegram не ретраит)', res.status === 200, res.status);

  await sleep(1500);
  const { data: bid } = await db
    .from('tender_bids')
    .select('id')
    .eq('order_id', testOrderId)
    .eq('driver_id', FAKE_TG_ID.toString())
    .maybeSingle();
  ok('Ставка не создана для несуществующего водителя', !bid, bid);
}

// ─── W5: Non-bidding order ────────────────────────────────────────────────────

async function testW5() {
  section('W5 — Closed order → 200 OK, bid rejected');

  // Переводим заказ в closed
  await db.from('tender_orders').update({ status: 'completed' }).eq('id', testOrderId);
  // Сбрасываем ставку
  await db.from('tender_bids').delete().eq('order_id', testOrderId).eq('driver_id', testDriverId);

  const body = makeTelegramUpdate(TEST_TELEGRAM_ID, `b:${testOrderToken}:77`);
  const res  = await postWebhook(body, SECRET);
  ok('Вебхук → 200', res.status === 200, res.status);

  await sleep(1500);
  const { data: bid } = await db
    .from('tender_bids')
    .select('id')
    .eq('order_id', testOrderId)
    .eq('driver_id', testDriverId)
    .maybeSingle();
  ok('Ставка не создана для закрытого заказа', !bid, bid);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  if (testOrderId) {
    await db.from('tender_notification_queue').delete().eq('order_id', testOrderId);
    await db.from('tender_bids').delete().eq('order_id', testOrderId);
    await db.from('tender_orders').delete().eq('id', testOrderId);
  }
  if (testDriverId) {
    await db.from('tender_drivers').delete().eq('id', testDriverId);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[35m   BLOCK W — TELEGRAM WEBHOOK TESTS\x1b[0m');
  console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════\x1b[0m');
  console.log(`  \x1b[36mℹ\x1b[0m  URL: ${WEBHOOK_URL}`);
  console.log(`  \x1b[36mℹ\x1b[0m  Secret: ${SECRET ? SECRET.slice(0, 8) + '...' : '(не задан)'}`);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\x1b[31mОшибка: переменные окружения не заданы\x1b[0m');
    process.exit(1);
  }

  try {
    section('Setup');
    await setup();
    ok('Тестовый водитель создан', !!testDriverId, testDriverId);
    ok('Тестовый заказ создан',    !!testOrderId,  testOrderId);
    ok('token получен',            !!testOrderToken, testOrderToken);
    console.log(`  \x1b[36mℹ\x1b[0m  token=${testOrderToken}`);

    if (!testOrderId || !testDriverId) {
      console.error('\x1b[31mSetup провалился — прерываем тест\x1b[0m');
      return;
    }

    await testW1();
    await testW2();
    await testW3();
    await testW4();
    await testW5();

  } finally {
    section('Cleanup');
    await cleanup();
    console.log('  \x1b[33m♻\x1b[0m  Тестовые данные удалены');

    const total = passed + failed;
    const pct   = total > 0 ? Math.round((passed / total) * 100) : 0;
    console.log('\n\x1b[1m═══════════════════════════════════════════\x1b[0m');
    if (failed === 0) {
      console.log(`\x1b[32m✅ BLOCK W PASSED: ${passed}/${total} (${pct}%)\x1b[0m`);
    } else {
      console.log(`\x1b[31m❌ BLOCK W: ${passed}/${total} (${pct}%) — ${failed} failed\x1b[0m`);
    }
    console.log('\x1b[1m═══════════════════════════════════════════\x1b[0m\n');
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => {
  console.error('\x1b[31mFATAL:\x1b[0m', e);
  process.exit(1);
});
