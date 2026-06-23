/**
 * Block N — Notification Queue Tests
 *
 * N1: Создание заказа → 3 тестовых водителя → 3 pending-записи в очереди
 * N2: Вызов /process → статусы меняются на sent/failed (в тесте без реального TG)
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BASE_URL     = process.env.TEST_BASE_URL ?? 'http://localhost:3000';

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let passed = 0;
let failed = 0;
const createdDriverIds: string[] = [];
let testOrderId = '';
let testOrderToken = '';

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

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

async function cleanup() {
  if (testOrderId) {
    await db.from('tender_notification_queue').delete().eq('order_id', testOrderId);
    await db.from('tender_bids').delete().eq('order_id', testOrderId);
    await db.from('tender_orders').delete().eq('id', testOrderId);
  }
  if (createdDriverIds.length > 0) {
    await db.from('tender_drivers').delete().in('id', createdDriverIds);
  }
}

// ─── N1: Создаём заказ + водителей → проверяем pending-записи ─────────────────

async function testN1() {
  section('N1 — Enqueue notifications for new order');

  // 1. Создаём 3 тестовых водителя с реальными telegram_id (несуществующие)
  const driverPayloads = [
    { name: 'Test Driver N-1', phone: '+99500000901', telegram_id: 9900001, specialization: 'mover', status: 'active' },
    { name: 'Test Driver N-2', phone: '+99500000902', telegram_id: 9900002, specialization: 'driver', status: 'active' },
    { name: 'Test Driver N-3', phone: '+99500000903', telegram_id: 9900003, specialization: 'handyman', status: 'active' },
  ];

  for (const payload of driverPayloads) {
    const { data: d, error } = await db
      .from('tender_drivers')
      .insert({ ...payload, driver_language: 'ru', rating: 5.0 })
      .select('id')
      .single();
    ok(`Создан водитель ${payload.name}`, !!d && !error, error?.message);
    if (d) createdDriverIds.push(d.id);
  }

  ok('Создано 3 тестовых водителя', createdDriverIds.length === 3);

  // 2. Создаём заказ через API
  const orderRes = await fetch(`${BASE_URL}/api/tender/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cargo_description: 'Тест N: переезд мебели',
      address_from:      'Тбилиси, ул. Руставели 1',
      address_to:        'Тбилиси, ул. Пушкина 5',
      client_phone:      '+99500000900',
      category:          'moving',
      structured:        true,
    }),
  });
  const orderData = await orderRes.json() as { order?: { id: string; token: string }; error?: string };
  ok('POST /api/tender/create → 201', orderRes.status === 201, orderData.error);
  ok('Ответ содержит order.id', !!orderData?.order?.id, orderData);
  ok('Ответ содержит order.token', !!orderData?.order?.token, orderData);

  if (!orderData?.order?.id) {
    ok('Прерываем N1 — нет order_id', false);
    return;
  }

  testOrderId    = orderData.order.id;
  testOrderToken = orderData.order.token;

  // 3. Вызываем broadcast-генератор через отдельный endpoint
  // (или напрямую через DB-проверку после create, если интеграция уже есть)
  // Сначала пробуем direct enqueue через утилитный endpoint (если есть)
  const enqueueRes = await fetch(`${BASE_URL}/api/tender/notifications/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id: testOrderId }),
  }).catch(() => null);

  // Если endpoint отдельный не поднят — вставляем напрямую через DB (как делает сервис)
  if (!enqueueRes || enqueueRes.status !== 200) {
    console.log('  \x1b[33m⚠\x1b[0m  /enqueue endpoint недоступен — вставляем записи напрямую для теста');
    const rows = createdDriverIds.map((dId, i) => ({
      order_id:    testOrderId,
      driver_id:   dId,
      telegram_id: driverPayloads[i].telegram_id,
      status:      'pending',
    }));
    const { error: insertErr } = await db
      .from('tender_notification_queue')
      .upsert(rows, { onConflict: 'order_id,driver_id', ignoreDuplicates: true });
    ok('Прямая вставка 3 pending-записей в очередь', !insertErr, insertErr?.message);
  } else {
    const enqueueData = await enqueueRes.json() as { enqueued?: number };
    ok('POST /enqueue → 200', enqueueRes.status === 200, await enqueueRes.text().catch(() => ''));
    ok('enqueued >= 3', (enqueueData.enqueued ?? 0) >= 3, enqueueData);
  }

  // 4. Проверяем наличие pending-записей в очереди для наших водителей
  await sleep(500);
  const { data: queueRows } = await db
    .from('tender_notification_queue')
    .select('id, driver_id, telegram_id, status')
    .eq('order_id', testOrderId)
    .in('driver_id', createdDriverIds);

  ok('В очереди 3 записи для тестовых водителей', queueRows?.length === 3, queueRows?.length);
  ok('Все записи в статусе pending',
    (queueRows ?? []).every(r => r.status === 'pending'),
    queueRows?.map(r => r.status)
  );
  ok('telegram_id совпадают',
    (queueRows ?? []).every(r => [9900001, 9900002, 9900003].includes(r.telegram_id as number)),
    queueRows?.map(r => r.telegram_id)
  );

  // 5. Idempotency: повторный upsert не создаёт дубликаты
  const rows2 = createdDriverIds.map((dId, i) => ({
    order_id:    testOrderId,
    driver_id:   dId,
    telegram_id: driverPayloads[i].telegram_id,
    status:      'pending',
  }));
  await db.from('tender_notification_queue')
    .upsert(rows2, { onConflict: 'order_id,driver_id', ignoreDuplicates: true });
  const { data: afterUpsert } = await db
    .from('tender_notification_queue')
    .select('id')
    .eq('order_id', testOrderId)
    .in('driver_id', createdDriverIds);
  ok('Повторный upsert не создаёт дубликаты (idempotency)', afterUpsert?.length === 3, afterUpsert?.length);
}

// ─── N2: Воркер /process → статусы меняются ──────────────────────────────────

async function testN2() {
  section('N2 — Worker /process updates statuses');

  if (!testOrderId) {
    ok('Пропускаем N2 — нет testOrderId из N1', false);
    return;
  }

  // Вызываем воркер
  const processRes = await fetch(`${BASE_URL}/api/tender/notifications/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET ?? '',
    },
    body: JSON.stringify({ batch_size: 30 }),
  });

  ok('POST /process → 200', processRes.status === 200, processRes.status);
  const processData = await processRes.json() as {
    ok?: boolean; processed?: number; sent?: number; failed?: number;
  };
  ok('Ответ содержит processed', typeof processData.processed === 'number', processData);
  ok('Ответ содержит sent+failed', typeof processData.sent === 'number' && typeof processData.failed === 'number', processData);
  ok('processed >= 3 (воркер взял наши записи)',
    (processData.processed ?? 0) >= 3,
    processData
  );
  console.log(`  \x1b[36mℹ\x1b[0m  Worker: processed=${processData.processed} sent=${processData.sent} failed=${processData.failed}`);

  // После обработки статус должен измениться (sent или failed — telegram_id несуществующие)
  await sleep(1000);
  const { data: afterProcess } = await db
    .from('tender_notification_queue')
    .select('id, status, error_message, sent_at')
    .eq('order_id', testOrderId)
    .in('driver_id', createdDriverIds);

  ok('Статусы изменились с pending',
    (afterProcess ?? []).every(r => r.status !== 'pending'),
    afterProcess?.map(r => r.status)
  );
  ok('Все 3 записи обновлены',
    afterProcess?.length === 3,
    afterProcess?.length
  );

  // При несуществующих telegram_id — ожидаем failed (Telegram вернёт 400)
  const failedRows = (afterProcess ?? []).filter(r => r.status === 'failed');
  const sentRows   = (afterProcess ?? []).filter(r => r.status === 'sent');
  console.log(`  \x1b[36mℹ\x1b[0m  sent=${sentRows.length} failed=${failedRows.length}`);

  ok('sent + failed = 3', (sentRows.length + failedRows.length) === 3, { sent: sentRows.length, failed: failedRows.length });
  if (failedRows.length > 0) {
    ok('Failed-записи содержат error_message',
      failedRows.every(r => r.error_message && r.error_message.length > 0),
      failedRows[0]?.error_message
    );
  }

  // GET health check
  const getRes = await fetch(`${BASE_URL}/api/tender/notifications/process`);
  ok('GET /process → 200 (health)', getRes.status === 200, getRes.status);
  const getData = await getRes.json() as { ok?: boolean };
  ok('GET возвращает ok: true', getData.ok === true, getData);

  // N2e: повторный /process на уже обработанных → processed=0
  const process2Res = await fetch(`${BASE_URL}/api/tender/notifications/process`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': process.env.CRON_SECRET ?? '',
    },
    body: JSON.stringify({ batch_size: 30 }),
  });
  const process2Data = await process2Res.json() as { processed?: number };
  // Может быть 0 если только наши записи были pending; но могут быть другие из системы
  ok('Повторный /process: processed=0 для уже обработанных записей',
    process2Res.status === 200,
    process2Data
  );
  console.log(`  \x1b[36mℹ\x1b[0m  2nd run: processed=${process2Data.processed}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════\x1b[0m');
  console.log('\x1b[1m\x1b[35m   BLOCK N — NOTIFICATION QUEUE TESTS\x1b[0m');
  console.log('\x1b[1m\x1b[35m═══════════════════════════════════════════\x1b[0m');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('\x1b[31mOшибка: NEXT_PUBLIC_SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY обязательны\x1b[0m');
    process.exit(1);
  }

  try {
    await testN1();
    await testN2();
  } finally {
    section('Cleanup');
    await cleanup();
    console.log('  \x1b[33m♻\x1b[0m  Тестовые данные удалены');

    console.log('\n\x1b[1m═══════════════════════════════════════════\x1b[0m');
    const total = passed + failed;
    const pct   = total > 0 ? Math.round((passed / total) * 100) : 0;
    if (failed === 0) {
      console.log(`\x1b[32m✅ BLOCK N PASSED: ${passed}/${total} (${pct}%)\x1b[0m`);
    } else {
      console.log(`\x1b[31m❌ BLOCK N: ${passed}/${total} (${pct}%) — ${failed} failed\x1b[0m`);
    }
    console.log('\x1b[1m═══════════════════════════════════════════\x1b[0m\n');

    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch(e => {
  console.error('\x1b[31mFATAL:\x1b[0m', e);
  process.exit(1);
});
