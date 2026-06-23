/**
 * Тест-скрипт: Блок I — Создание заказа (Order Creation Flow)
 * Эндпоинт: POST /api/tender/create
 * Body: { cargo_description?, address_from?, address_to?, client_name?, client_phone, category?, structured? }
 * Ответ: { order: { id, token, status, created_at }, client_url } — статус 201
 *
 * Все тесты используют structured:true чтобы не звать Gemini API.
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

// ─── Созданные заказы (для cleanup) ──────────────────────────────────────────

const createdOrderIds: string[] = [];

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
  if (createdOrderIds.length === 0) return;
  await sb.from('tender_orders').delete().in('id', createdOrderIds);
  info(`Удалено ${createdOrderIds.length} тестовых заказов`);
}

// ─── I1: Успешное создание заказа ────────────────────────────────────────────

async function testI1_SuccessfulCreate() {
  section('I1 — Успешное создание заказа (201, id + token в ответе)');

  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'Перевозка дивана и шкафа',
    address_from: 'Руставели 1, Тбилиси',
    address_to: 'Вакэ 10, Тбилиси',
    client_name: 'I-Тест Клиент',
    client_phone: '+995599000011',
    category: 'moving',
    structured: true,
  });

  const d = data as Record<string, unknown>;
  const order = d?.order as Record<string, unknown> | undefined;

  status === 201
    ? ok('I1: POST /create → 201')
    : fail('I1: → 201', `статус ${status} — ${JSON.stringify(d)}`);

  if (!order?.id) { fail('I1: order.id в ответе'); return; }
  createdOrderIds.push(order.id as string);
  ok('I1: order.id получен', (order.id as string).slice(0, 8));

  typeof order?.token === 'string' && (order.token as string).length > 0
    ? ok('I1: order.token получен', (order.token as string).slice(0, 8))
    : fail('I1: order.token в ответе', String(order?.token));

  order?.status === 'bidding'
    ? ok('I1: статус = bidding')
    : fail('I1: status=bidding', String(order?.status));

  typeof d?.client_url === 'string' && (d.client_url as string).includes('/feed/')
    ? ok('I1: client_url содержит /feed/', d.client_url as string)
    : fail('I1: client_url', String(d?.client_url));
}

// ─── I2: Проверка записи в БД ────────────────────────────────────────────────

async function testI2_DatabaseRecord() {
  section('I2 — Запись в БД: все поля корректны');

  const orderId = createdOrderIds[0];
  if (!orderId) { fail('I2: нет orderId из I1 — пропускаем'); return; }

  const { data: row } = await sb.from('tender_orders')
    .select('status, address_from, address_to, cargo_description, client_phone, category, bidding_started_at, token, client_name')
    .eq('id', orderId).single();

  row?.status === 'bidding'
    ? ok('I2: статус в БД = bidding')
    : fail('I2: status=bidding', row?.status);

  row?.address_from === 'Руставели 1, Тбилиси'
    ? ok('I2: address_from совпадает')
    : fail('I2: address_from', row?.address_from);

  row?.address_to === 'Вакэ 10, Тбилиси'
    ? ok('I2: address_to совпадает')
    : fail('I2: address_to', row?.address_to);

  row?.cargo_description === 'Перевозка дивана и шкафа'
    ? ok('I2: cargo_description совпадает')
    : fail('I2: cargo_description', row?.cargo_description);

  row?.client_phone === '+995599000011'
    ? ok('I2: client_phone совпадает')
    : fail('I2: client_phone', row?.client_phone);

  row?.category === 'moving'
    ? ok('I2: category = moving')
    : fail('I2: category=moving', row?.category);

  !!row?.bidding_started_at
    ? ok('I2: bidding_started_at заполнен')
    : fail('I2: bidding_started_at заполнен');

  // bidding_started_at не старше 60 секунд
  const age = Date.now() - new Date(row?.bidding_started_at).getTime();
  age < 60_000
    ? ok('I2: bidding_started_at свежий', `${Math.round(age / 1000)}с назад`)
    : fail('I2: bidding_started_at свежий', `${Math.round(age / 1000)}с назад`);

  typeof row?.token === 'string' && row.token.length > 0
    ? ok('I2: token заполнен в БД')
    : fail('I2: token в БД', String(row?.token));
}

// ─── I3: Два заказа имеют разные токены ──────────────────────────────────────

async function testI3_UniqueTokens() {
  section('I3 — Каждый заказ получает уникальный UUID-токен');

  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'Второй тестовый заказ для проверки токена',
    address_from: 'Дидубе 1',
    address_to: 'Исани 5',
    client_name: 'I-Тест Клиент 2',
    client_phone: '+995599000012',
    category: 'moving',
    structured: true,
  });

  const d = data as Record<string, unknown>;
  const order2 = d?.order as Record<string, unknown> | undefined;

  status === 201 ? ok('I3: второй заказ создан') : fail('I3: второй заказ', `${status}`);
  if (!order2?.id) { fail('I3: order2.id'); return; }
  createdOrderIds.push(order2.id as string);

  const token1 = (await sb.from('tender_orders').select('token').eq('id', createdOrderIds[0]).single()).data?.token;
  const token2 = order2.token as string;

  token1 !== token2
    ? ok('I3: токены уникальны', `${String(token1).slice(0, 8)} ≠ ${token2.slice(0, 8)}`)
    : fail('I3: токены должны различаться');

  // UUID-формат: 8-4-4-4-12
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  uuidRegex.test(token2)
    ? ok('I3: токен имеет формат UUID')
    : fail('I3: UUID-формат', token2);
}

// ─── I4: Обязательные поля → 400 ─────────────────────────────────────────────

async function testI4_RequiredFields() {
  section('I4 — Обязательные поля: без client_phone или описания → 400');

  // Без client_phone
  const { status: s1, data: d1 } = await api('POST', '/api/tender/create', {
    cargo_description: 'Без телефона',
    address_from: 'Адрес 1',
    structured: true,
  });
  s1 === 400
    ? ok('I4: без client_phone → 400')
    : fail('I4: без client_phone → 400', `статус ${s1}`);
  ((d1 as Record<string, unknown>)?.error as string)?.includes('client_phone')
    ? ok('I4: сообщение содержит "client_phone"')
    : fail('I4: текст ошибки без phone', JSON.stringify(d1));

  // Без cargo_description и address_from одновременно
  const { status: s2, data: d2 } = await api('POST', '/api/tender/create', {
    client_phone: '+995599000013',
    address_to: 'Куда 1',
    // нет cargo_description, нет address_from
    structured: true,
  });
  s2 === 400
    ? ok('I4: без описания и адреса → 400')
    : fail('I4: без описания/адреса → 400', `статус ${s2}`);
  typeof (d2 as Record<string, unknown>)?.error === 'string'
    ? ok('I4: тело содержит error', (d2 as Record<string, unknown>).error as string)
    : fail('I4: error в теле', JSON.stringify(d2));
}

// ─── I5: Минимально допустимый запрос — только phone + cargo_description ──────

async function testI5_MinimalRequest() {
  section('I5 — Минимальный запрос (phone + cargo_description) → 201');

  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'Переезд квартиры',
    client_phone: '+995599000014',
    structured: true,
  });

  const d = data as Record<string, unknown>;
  const order = d?.order as Record<string, unknown> | undefined;

  status === 201
    ? ok('I5: минимальный запрос → 201')
    : fail('I5: → 201', `статус ${status} — ${JSON.stringify(d)}`);

  if (order?.id) {
    createdOrderIds.push(order.id as string);
    ok('I5: заказ создан', (order.id as string).slice(0, 8));

    // address_from и address_to должны получить дефолт '-'
    const { data: row } = await sb.from('tender_orders')
      .select('address_from, address_to, category')
      .eq('id', order.id as string).single();
    row?.address_from === '-'
      ? ok('I5: address_from по умолчанию = "-"')
      : fail('I5: address_from default', row?.address_from);
    row?.address_to === '-'
      ? ok('I5: address_to по умолчанию = "-"')
      : fail('I5: address_to default', row?.address_to);
    // category может быть обновлена AI-анализом сразу после создания — принимаем любое непустое значение
    typeof row?.category === 'string' && row.category.length > 0
      ? ok('I5: category заполнена', row.category)
      : fail('I5: category не пустая', String(row?.category));
  } else {
    fail('I5: order.id в ответе');
  }
}

// ─── I6: Минимально допустимый — только phone + address_from ─────────────────

async function testI6_AddressOnlyRequest() {
  section('I6 — Запрос только с address_from (без cargo_description) → 201');

  const { status, data } = await api('POST', '/api/tender/create', {
    address_from: 'Марджанишвили 5',
    address_to: 'Сабуртало 12',
    client_phone: '+995599000015',
    structured: true,
  });

  const d = data as Record<string, unknown>;
  const order = d?.order as Record<string, unknown> | undefined;

  status === 201
    ? ok('I6: запрос с address_from → 201')
    : fail('I6: → 201', `статус ${status} — ${JSON.stringify(d)}`);

  if (order?.id) {
    createdOrderIds.push(order.id as string);
    ok('I6: заказ создан', (order.id as string).slice(0, 8));
  } else {
    fail('I6: order.id в ответе');
  }
}

// ─── I7: Полный запрос с необязательными полями ───────────────────────────────

async function testI7_FullRequest() {
  section('I7 — Полный запрос с необязательными полями (workers_needed, notes, client_budget)');

  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'Офисный переезд 50 коробок + мебель',
    address_from: 'Авлабари 3',
    address_to: 'Дидубе 7',
    client_name: 'ООО Ромб',
    client_phone: '+995599000016',
    category: 'moving',
    workers_needed: 4,
    vehicles_needed: 2,
    notes: 'Нужен грузовой лифт',
    client_budget: 800,
    structured: true,
  });

  const d = data as Record<string, unknown>;
  const order = d?.order as Record<string, unknown> | undefined;

  status === 201
    ? ok('I7: полный запрос → 201')
    : fail('I7: → 201', `статус ${status} — ${JSON.stringify(d)}`);

  if (!order?.id) { fail('I7: order.id'); return; }
  createdOrderIds.push(order.id as string);

  const { data: row } = await sb.from('tender_orders')
    .select('workers_needed, vehicles_needed, notes, client_budget, client_name')
    .eq('id', order.id as string).single();

  row?.workers_needed === 4
    ? ok('I7: workers_needed = 4')
    : fail('I7: workers_needed', String(row?.workers_needed));
  row?.vehicles_needed === 2
    ? ok('I7: vehicles_needed = 2')
    : fail('I7: vehicles_needed', String(row?.vehicles_needed));
  row?.notes === 'Нужен грузовой лифт'
    ? ok('I7: notes сохранён')
    : fail('I7: notes', row?.notes);
  row?.client_budget === 800
    ? ok('I7: client_budget = 800')
    : fail('I7: client_budget', String(row?.client_budget));
  row?.client_name === 'ООО Ромб'
    ? ok('I7: client_name сохранён')
    : fail('I7: client_name', row?.client_name);
}

// ─── I8: AI-гейткипер обходится при structured:true ──────────────────────────

async function testI8_StructuredBypassesAI() {
  section('I8 — structured:true пропускает AI-гейткипер (даже для пустого описания)');

  // Без structured — Gemini мог бы заблокировать это как incomplete
  // С structured — должен создать без вопросов
  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'x',  // экстремально короткое описание
    address_from: 'A',
    address_to: 'B',
    client_phone: '+995599000017',
    category: 'general',
    structured: true,        // флаг обхода AI
  });

  const d = data as Record<string, unknown>;
  const order = d?.order as Record<string, unknown> | undefined;

  status === 201
    ? ok('I8: structured:true пропускает AI → 201')
    : fail('I8: → 201', `статус ${status} — ${JSON.stringify(d)}`);

  if (order?.id) {
    createdOrderIds.push(order.id as string);
    ok('I8: заказ создан с коротким описанием', (order.id as string).slice(0, 8));
  }
}

// ─── I9: Пустое тело → 400 ───────────────────────────────────────────────────

async function testI9_EmptyBody() {
  section('I9 — Пустое тело запроса → 400');

  const { status } = await api('POST', '/api/tender/create', {});
  status === 400
    ? ok('I9: пустое тело → 400')
    : fail('I9: → 400', `статус ${status}`);
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок I — Создание заказа${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);

  info(`API base: ${BASE_URL}`);

  await testI1_SuccessfulCreate();
  await testI2_DatabaseRecord();
  await testI3_UniqueTokens();
  await testI4_RequiredFields();
  await testI5_MinimalRequest();
  await testI6_AddressOnlyRequest();
  await testI7_FullRequest();
  await testI8_StructuredBypassesAI();
  await testI9_EmptyBody();

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
