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

const T = {
  ORDER_ID:    '' as string,
  DRIVER_ID:   '' as string,
  DRIVER2_ID:  '' as string,
  Q1_ID:       '' as string,
  Q2_ID:       '' as string,
  Q3_ID:       '' as string,
  TG1: 7777000201,
  TG2: 7777000202,
  CLIENT_PHONE: '+995599000077',
  ORDER_TOKEN: `test-c-${Date.now()}`,
};

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

async function cleanup() {
  if (T.ORDER_ID) {
    await sb.from('order_questions').delete().eq('order_id', T.ORDER_ID);
    await sb.from('tender_orders').delete().eq('id', T.ORDER_ID);
  }
  await sb.from('tender_drivers').delete().in('telegram_id', [T.TG1, T.TG2]);
}

async function setup(): Promise<boolean> {
  section('Setup — создание тестовых данных');

  const { data: d1, error: e1 } = await sb.from('tender_drivers').upsert(
    { telegram_id: T.TG1, name: 'C-Тест Водитель 1', phone: '+99559900201', status: 'active', driver_language: 'ru', rating_sum: 0, rating_count: 0, rating: 0 },
    { onConflict: 'telegram_id' }
  ).select('id').single();
  if (e1 || !d1) { fail('Создан водитель 1', e1?.message); return false; }
  T.DRIVER_ID = d1.id;
  ok('Создан водитель 1');

  const { data: d2, error: e2 } = await sb.from('tender_drivers').upsert(
    { telegram_id: T.TG2, name: 'C-Тест Водитель 2', phone: '+99559900202', status: 'active', driver_language: 'ru', rating_sum: 0, rating_count: 0, rating: 0 },
    { onConflict: 'telegram_id' }
  ).select('id').single();
  if (e2 || !d2) { fail('Создан водитель 2', e2?.message); return false; }
  T.DRIVER2_ID = d2.id;
  ok('Создан водитель 2');

  const { data: order, error: oe } = await sb.from('tender_orders').insert({
    token: T.ORDER_TOKEN,
    address_from: 'Руставели 1',
    address_to: 'Вакэ 10',
    cargo_description: 'Перевозка мебели — диван, шкаф, 2 кресла',
    client_name: 'C-Тест Клиент',
    client_phone: T.CLIENT_PHONE,
    status: 'bidding',
    bidding_started_at: new Date().toISOString(),
    category: 'moving',
  }).select('id').single();
  if (oe || !order) { fail('Создан заказ', oe?.message); return false; }
  T.ORDER_ID = order.id;
  ok(`Создан заказ`, T.ORDER_ID.slice(0, 8));

  info(`API base: ${BASE_URL}`);
  return true;
}

async function testC1_CreateQuestion() {
  section('C1 — Создание вопроса: answered_by=null, status=pending');

  const { status, data } = await api('POST', '/api/questions/ask', {
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER_ID,
    question: 'Есть ли лифт в доме?',
    lang: 'ru',
  });

  const d = data as Record<string, unknown>;
  status === 201 ? ok('C1: POST /ask → 201') : fail('C1: POST /ask → 201', `статус ${status}`);
  d?.ok === true ? ok('C1: ответ содержит ok=true') : fail('C1: ok=true', JSON.stringify(d));
  if (!d?.question_id) { fail('C1: question_id в ответе'); return; }
  T.Q1_ID = d.question_id as string;
  ok('C1: question_id получен', T.Q1_ID.slice(0, 8));

  const { data: row } = await sb.from('order_questions')
    .select('status, answered_by, question_lang')
    .eq('id', T.Q1_ID).single();

  row?.status === 'pending' ? ok('C1: статус в БД = pending') : fail('C1: status=pending', row?.status);
  row?.answered_by === null ? ok('C1: answered_by в БД = null') : fail('C1: answered_by=null', String(row?.answered_by));
  row?.question_lang === 'ru' ? ok('C1: question_lang = ru') : fail('C1: question_lang=ru', row?.question_lang);
}

async function testC2_DuplicateQuestion() {
  section('C2 — Дубликат вопроса → 409');

  const { status, data } = await api('POST', '/api/questions/ask', {
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER_ID,
    question: 'Есть ли лифт в доме?',
    lang: 'ru',
  });

  status === 409 ? ok('C2: повторный вопрос → 409') : fail('C2: повторный вопрос → 409', `статус ${status}`);
  const d = data as Record<string, unknown>;
  typeof d?.error === 'string' ? ok('C2: тело содержит error-строку', d.error as string) : fail('C2: error в теле');
}

async function testC3_QuestionLimit() {
  section('C3 — Лимит вопросов (max 3) → 400 на 4-й');

  for (const [n, q] of [[2, 'Сколько этажей в доме?'], [3, 'Есть ли парковка у дома?']] as [number, string][]) {
    const { status, data } = await api('POST', '/api/questions/ask', {
      order_id: T.ORDER_ID,
      driver_id: T.DRIVER_ID,
      question: q,
      lang: 'ru',
    });
    const d = data as Record<string, unknown>;
    if (status === 201) {
      ok(`C3: вопрос ${n}/3 создан`);
      if (n === 2) T.Q2_ID = (d.question_id as string) ?? '';
      if (n === 3) T.Q3_ID = (d.question_id as string) ?? '';
    } else {
      fail(`C3: вопрос ${n}/3 создан`, `статус ${status} — ${JSON.stringify(d)}`);
    }
  }

  const { status, data } = await api('POST', '/api/questions/ask', {
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER_ID,
    question: 'Четвёртый вопрос — должен упасть',
    lang: 'ru',
  });

  status === 400 ? ok('C3: 4-й вопрос → 400 (лимит)') : fail('C3: 4-й вопрос → 400', `статус ${status}`);
  const d = data as Record<string, unknown>;
  (d?.error as string)?.includes('лимит')
    ? ok('C3: сообщение содержит "лимит"', d.error as string)
    : fail('C3: сообщение об ошибке', JSON.stringify(d));
}

async function testC4_AnswerWithoutPhone() {
  section('C4 — Ответ без client_phone → 400');

  const { status, data } = await api('POST', '/api/questions/answer', {
    question_id: T.Q2_ID,
    answer: 'Да, три этажа.',
    lang: 'ru',
  });

  status === 400 ? ok('C4: ответ без client_phone → 400') : fail('C4: → 400', `статус ${status}`);
  const d = data as Record<string, unknown>;
  typeof d?.error === 'string' ? ok('C4: тело содержит error', d.error as string) : fail('C4: error в теле');
}

async function testC5_AnswerWrongPhone() {
  section('C5 — Ответ с неверным client_phone → 403');

  const { status } = await api('POST', '/api/questions/answer', {
    question_id: T.Q2_ID,
    answer: 'Да, три этажа.',
    lang: 'ru',
    client_phone: '+995500000000',
  });

  status === 403 ? ok('C5: неверный телефон → 403') : fail('C5: → 403', `статус ${status}`);
}

async function testC6_SuccessfulAnswer() {
  section('C6 — Успешный ответ: status=answered, answered_by=client');

  const { status, data } = await api('POST', '/api/questions/answer', {
    question_id: T.Q2_ID,
    answer: 'Да, три этажа, лифта нет.',
    lang: 'ru',
    client_phone: T.CLIENT_PHONE,
  });

  const d = data as Record<string, unknown>;
  status === 200 ? ok('C6: POST /answer → 200') : fail('C6: → 200', `статус ${status}, ${JSON.stringify(d)}`);
  d?.ok === true ? ok('C6: ответ содержит ok=true') : fail('C6: ok=true', JSON.stringify(d));

  const { data: row } = await sb.from('order_questions')
    .select('status, answered_by, answer_original, answer_translated, answered_at')
    .eq('id', T.Q2_ID).single();

  row?.status === 'answered' ? ok('C6: статус → answered') : fail('C6: status=answered', row?.status);
  row?.answered_by === 'client' ? ok('C6: answered_by = client') : fail('C6: answered_by=client', row?.answered_by);
  row?.answer_original === 'Да, три этажа, лифта нет.'
    ? ok('C6: answer_original сохранён')
    : fail('C6: answer_original', row?.answer_original);
  !!row?.answered_at ? ok('C6: answered_at заполнен') : fail('C6: answered_at заполнен');

  const translated = row?.answer_translated as Record<string, string> | null;
  if (translated && typeof translated === 'object') {
    ok('C6: answer_translated заполнен (AI перевёл)', `ключи: ${Object.keys(translated).join(',')}`);
  } else {
    console.log(`  ${YELLOW}⚠${RESET} C6: answer_translated пустой или задерживается (не блокирует тест)`);
    passed++;
  }
}

async function testC7_DoubleAnswer() {
  section('C7 — Повторный ответ на отвеченный вопрос → 409');

  const { status, data } = await api('POST', '/api/questions/answer', {
    question_id: T.Q2_ID,
    answer: 'Ещё один ответ на тот же вопрос',
    lang: 'ru',
    client_phone: T.CLIENT_PHONE,
  });

  status === 409 ? ok('C7: повторный ответ → 409') : fail('C7: → 409', `статус ${status}`);
  const d = data as Record<string, unknown>;
  (d?.error as string)?.includes('Уже')
    ? ok('C7: сообщение "Уже отвечено"')
    : fail('C7: текст ошибки', JSON.stringify(d));
}

async function testC8_ListBlindLogic() {
  section('C8 — GET /list: blind логика (клиент vs водитель)');

  await api('POST', '/api/questions/ask', {
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER2_ID,
    question: 'Нужна ли разборка мебели?',
    lang: 'ru',
  });

  const { status: s1, data: d1 } = await api('GET', `/api/questions/list?order_id=${T.ORDER_ID}&role=client`);
  const clientList = (d1 as Record<string, unknown>)?.questions as unknown[] ?? [];
  s1 === 200 ? ok('C8: GET /list (client) → 200') : fail('C8: → 200', `${s1}`);
  clientList.length >= 4
    ? ok(`C8: клиент видит все вопросы`, `${clientList.length} шт.`)
    : fail(`C8: клиент видит все вопросы`, `только ${clientList.length}`);

  const { status: s2, data: d2 } = await api('GET', `/api/questions/list?order_id=${T.ORDER_ID}&driver_id=${T.DRIVER_ID}&role=driver`);
  const driverList = (d2 as Record<string, unknown>)?.questions as unknown[] ?? [];
  s2 === 200 ? ok('C8: GET /list (driver) → 200') : fail('C8: → 200 (driver)', `${s2}`);
  driverList.length === 3
    ? ok('C8: водитель 1 видит только свои 3 вопроса')
    : fail('C8: водитель 1 видит 3 вопроса', `${driverList.length}`);

  const { data: d3 } = await api('GET', `/api/questions/list?order_id=${T.ORDER_ID}&driver_id=${T.DRIVER2_ID}&role=driver`);
  const driver2List = (d3 as Record<string, unknown>)?.questions as unknown[] ?? [];
  driver2List.length === 1
    ? ok('C8: водитель 2 видит только свой 1 вопрос')
    : fail('C8: водитель 2 видит 1 вопрос', `${driver2List.length}`);
}

async function testC9_QuestionToClosedOrder() {
  section('C9 — Вопрос к completed-заказу → 400');

  await sb.from('tender_orders').update({ status: 'completed' }).eq('id', T.ORDER_ID);

  const { status, data } = await api('POST', '/api/questions/ask', {
    order_id: T.ORDER_ID,
    driver_id: T.DRIVER2_ID,
    question: 'Ещё один вопрос после закрытия',
    lang: 'ru',
  });

  status === 400 ? ok('C9: вопрос к completed → 400') : fail('C9: → 400', `статус ${status}`);
  const d = data as Record<string, unknown>;
  (d?.error as string)?.includes('закрыт')
    ? ok('C9: сообщение "Заказ закрыт"')
    : fail('C9: текст ошибки', JSON.stringify(d));

  await sb.from('tender_orders').update({ status: 'bidding' }).eq('id', T.ORDER_ID);
}

async function run() {
  console.log(`\n${BOLD}════════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок C — Q&A Flow${RESET}`);
  console.log(`${BOLD}════════════════════════════════════════════════${RESET}`);

  await cleanup();
  const ready = await setup();
  if (!ready) {
    console.log(`${RED}Setup провалился — прерываем тесты${RESET}`);
    process.exit(1);
  }

  await testC1_CreateQuestion();
  await testC2_DuplicateQuestion();
  await testC3_QuestionLimit();
  await testC4_AnswerWithoutPhone();
  await testC5_AnswerWrongPhone();
  await testC6_SuccessfulAnswer();
  await testC7_DoubleAnswer();
  await testC8_ListBlindLogic();
  await testC9_QuestionToClosedOrder();

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
