/**
 * Full E2E cycle test — без UI, только API + DB
 * Тестирует: создание заказа → рассылка → вопрос → ответ → ставка → выбор победителя
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const BASE = 'http://localhost:3000';

const serviceDb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

const anonDb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  { auth: { persistSession: false } }
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors: string[] = [];

function ok(msg: string) {
  console.log(`  ✅  ${msg}`);
  passed++;
}

function fail(msg: string, detail?: unknown) {
  console.error(`  ❌  ${msg}`, detail ?? '');
  failed++;
  errors.push(msg);
}

function section(title: string) {
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(55));
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Test State ───────────────────────────────────────────────────────────────

let orderToken = '';
let orderId    = '';
let driverId   = '';
let bidId      = '';
let questionId = '';
const TEST_PHONE = '+99599111222333';

// ─── Step 1: Create order ─────────────────────────────────────────────────────

async function step1_createOrder() {
  section('ШАГ 1: Создание заказа');

  const { status, data } = await api('POST', '/api/tender/create', {
    cargo_description: 'Тест E2E: нужно перенести диван с 3 этажа (лифт есть), район Ваке. Срочно сегодня.',
    client_phone:      TEST_PHONE,
    structured:        true,
  });

  if (status === 201 && data.order?.token) {
    ok(`Заказ создан: token=${data.order.token}`);
    orderToken = data.order.token;
    orderId    = data.order.id;
  } else {
    fail('Заказ не создан', { status, data });
    return false;
  }

  // Проверяем что запись в БД есть
  const { data: dbOrder } = await serviceDb
    .from('tender_orders').select('id, status, cargo_description').eq('token', orderToken).single();
  if (dbOrder?.status === 'bidding') {
    ok(`Статус в БД: bidding`);
  } else {
    fail('Статус в БД не bidding', dbOrder);
  }

  // Anon может прочитать заказ (для фида)
  const { data: anonOrder, error: aErr } = await anonDb
    .from('tender_orders').select('id, status').eq('token', orderToken).single();
  if (anonOrder && !aErr) {
    ok('Anon читает заказ (RLS OK)');
    orderId = anonOrder.id; // подтверждаем id
  } else {
    fail('Anon не может читать заказ', aErr?.message);
  }

  return true;
}

// ─── Step 2: Check driver eligibility ─────────────────────────────────────────

async function step2_checkDrivers() {
  section('ШАГ 2: Проверка исполнителей');

  const { data: drivers } = await serviceDb
    .from('tender_drivers')
    .select('id, name, status, subscription_expires_at, telegram_id, specialization')
    .eq('status', 'active')
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());

  if ((drivers?.length ?? 0) > 0) {
    ok(`Активных исполнителей с подпиской: ${drivers!.length}`);
    drivers!.forEach(d => console.log(`     → ${d.name} [${d.specialization}] sub до ${new Date(d.subscription_expires_at).toLocaleDateString()}`));
    driverId = drivers![0].id;
  } else {
    fail('Нет активных исполнителей с подпиской');
    return false;
  }

  // Проверяем что bids созданы после sendTenderToDrivers
  await sleep(2000); // дать время async операциям
  const { data: bids } = await serviceDb
    .from('tender_bids').select('id, amount, status, driver_id').eq('order_id', orderId);

  if ((bids?.length ?? 0) > 0) {
    ok(`Placeholder-бидов создано: ${bids!.length} (sendTenderToDrivers сработал)`);
    bidId = bids!.find(b => b.driver_id === driverId)?.id ?? bids![0].id;
    driverId = bids![0].driver_id;
  } else {
    fail('sendTenderToDrivers не создал bids — уведомления не ушли');
  }

  return true;
}

// ─── Step 3: Driver asks question ────────────────────────────────────────────

async function step3_askQuestion() {
  section('ШАГ 3: Исполнитель задаёт вопрос');

  const { status, data } = await api('POST', '/api/questions/ask', {
    order_id:  orderId,
    driver_id: driverId,
    question:  'Есть ли парковка у дома?',
  });

  if (status === 200 || status === 201) {
    ok('Вопрос задан через API');
  } else {
    fail('Ошибка при создании вопроса', { status, data });
    return false;
  }

  // Проверяем запись в БД через service
  const { data: q } = await serviceDb
    .from('order_questions').select('id, question_original, status, question_translated')
    .eq('order_id', orderId).single();

  if (q?.id) {
    ok(`Вопрос в БД: "${q.question_original}" [${q.status}]`);
    questionId = q.id;
    if (q.question_translated) {
      const t = q.question_translated as Record<string, string>;
      ok(`Переводы: EN="${t.en ?? '?'}", KA="${t.ka ?? '?'}"`);
    } else {
      fail('Перевод вопроса не создан (translateFaqEntry не сработал)');
    }
  } else {
    fail('Вопрос не найден в БД', q);
    return false;
  }

  // Проверяем что ANON тоже может читать вопрос (для фида клиента)
  const { data: anonQ, error: aErr } = await anonDb
    .from('order_questions').select('id, question_original').eq('order_id', orderId);
  if ((anonQ?.length ?? 0) > 0) {
    ok('Anon читает вопросы (RLS OK) — фид клиента работает');
  } else {
    fail('Anon НЕ читает order_questions — RLS БЛОКИРУЕТ. Нужно: CREATE POLICY "anon read" ON order_questions FOR SELECT USING (true)', aErr?.message);
  }

  return true;
}

// ─── Step 4: Client answers ───────────────────────────────────────────────────

async function step4_clientAnswer() {
  section('ШАГ 4: Заказчик отвечает на вопрос');

  if (!questionId) { fail('Нет questionId — пропускаем'); return false; }

  const { status, data } = await api('POST', '/api/questions/answer', {
    question_id:  questionId,
    answer:       'Да, есть парковка прямо у подъезда.',
    lang:         'ru',
    client_phone: TEST_PHONE,
  });

  if (status === 200 && data.ok) {
    ok('Ответ принят API');
  } else {
    fail('Ошибка при ответе', { status, data });
    return false;
  }

  await sleep(3000); // ждём translateFaqAnswer + rebuildOrderFaq

  // Проверяем статус вопроса
  const { data: q } = await serviceDb
    .from('order_questions').select('status, answer_original, answer_translated').eq('id', questionId).single();

  if (q?.status === 'answered') {
    ok(`Статус вопроса: answered`);
    ok(`Ответ: "${q.answer_original}"`);
    if (q.answer_translated) {
      const t = q.answer_translated as Record<string, string>;
      ok(`Перевод ответа: EN="${t.en ?? '?'}", KA="${t.ka ?? '?'}"`);
    } else {
      fail('Перевод ответа не создан (translateFaqAnswer не сработал)');
    }
  } else {
    fail('Вопрос не помечен answered', q);
  }

  // Проверяем что live_brief_ai обновился (rebuildOrderFaq)
  const { data: order } = await serviceDb
    .from('tender_orders').select('live_brief_ai, faq_summary').eq('id', orderId).single();
  if (order?.live_brief_ai) {
    ok(`live_brief_ai обновлён (${order.live_brief_ai.length} chars)`);
  } else {
    fail('live_brief_ai не обновлён — rebuildOrderFaq не сработал');
  }

  return true;
}

// ─── Step 5: Driver places bid ────────────────────────────────────────────────

async function step5_placeBid() {
  section('ШАГ 5: Исполнитель делает ставку');

  // Симулируем через прямую запись в БД (как делает бот)
  const { error } = await serviceDb
    .from('tender_bids')
    .update({ amount: 120, comment: 'Готов приехать через час, опыт 5 лет.', bot_state: 'bidding' })
    .eq('order_id', orderId)
    .eq('driver_id', driverId);

  if (!error) {
    ok('Ставка 120₾ выставлена');
  } else {
    fail('Ошибка ставки', error.message);
    return false;
  }

  // Anon видит ставку (для фида)
  const { data: anonBids, error: bErr } = await anonDb
    .from('tender_bids').select('id, amount, status, driver_id').eq('order_id', orderId).gt('amount', 0);
  if ((anonBids?.length ?? 0) > 0) {
    ok(`Anon видит ${anonBids!.length} ставку(и) (RLS OK) — фид работает`);
    bidId = anonBids![0].id;
  } else {
    fail('Anon не видит ставки', bErr?.message);
  }

  return true;
}

// ─── Step 6: Client accepts bid ───────────────────────────────────────────────

async function step6_acceptBid() {
  section('ШАГ 6: Заказчик выбирает исполнителя');

  if (!bidId) { fail('Нет bidId'); return false; }

  const { status, data } = await api('POST', '/api/tender/accept-bid', {
    order_token: orderToken,
    bid_id:      bidId,
  });

  if (status === 200 && data.ok) {
    ok('Исполнитель выбран через API');
  } else {
    fail('Ошибка accept-bid', { status, data });
    return false;
  }

  // Проверяем статусы в БД
  const { data: order } = await serviceDb
    .from('tender_orders').select('status, winning_bid_id').eq('id', orderId).single();
  if (order?.status === 'selected' && order.winning_bid_id === bidId) {
    ok(`Заказ: status=selected, winning_bid_id корректен`);
  } else {
    fail('Статус заказа не обновился', order);
  }

  const { data: winnerBid } = await serviceDb
    .from('tender_bids').select('status').eq('id', bidId).single();
  if (winnerBid?.status === 'winner') {
    ok('Ставка-победитель: status=winner');
  } else {
    fail('Ставка-победитель не помечена winner', winnerBid);
  }

  // Остальные ставки должны стать lost
  const { data: loserBids } = await serviceDb
    .from('tender_bids').select('status').eq('order_id', orderId).neq('id', bidId).neq('status', 'withdrawn');
  const notLost = loserBids?.filter(b => b.status !== 'lost' && b.status !== 'pending') ?? [];
  if (notLost.length === 0) {
    ok('Остальные ставки: статусы корректны');
  } else {
    fail('Некоторые ставки не помечены lost', notLost);
  }

  return true;
}

// ─── Step 7: Feed page data check ─────────────────────────────────────────────

async function step7_feedDataCheck() {
  section('ШАГ 7: Проверка данных фида (как видит браузер)');

  // Заказ
  const { data: order, error: oErr } = await anonDb
    .from('tender_orders')
    .select('id, status, cargo_description, winning_bid_id, live_brief_ai')
    .eq('token', orderToken).single();

  if (order && !oErr) {
    ok(`Фид: заказ загружается (status=${order.status})`);
  } else {
    fail('Фид: заказ не загружается', oErr?.message);
  }

  // Ставки
  const { data: bids } = await anonDb
    .from('tender_bids')
    .select('id, amount, status, comment')
    .eq('order_id', orderId).gt('amount', 0);
  if ((bids?.length ?? 0) > 0) {
    ok(`Фид: ${bids!.length} ставка(и) видна`);
  } else {
    fail('Фид: ставки не видны');
  }

  // Вопросы
  const { data: questions } = await anonDb
    .from('order_questions').select('id, question_original, status, answer_original').eq('order_id', orderId);
  if ((questions?.length ?? 0) > 0) {
    ok(`Фид: ${questions!.length} вопрос(ов) виден`);
    questions!.forEach(q => console.log(`     ❓ "${q.question_original}" → ${q.status === 'answered' ? `"${q.answer_original}"` : 'без ответа'}`));
  } else {
    fail('Фид: вопросы НЕ видны через anon (RLS проблема)', 'Выполни: CREATE POLICY "anon read questions" ON order_questions FOR SELECT USING (true)');
  }

  // Победитель с контактами (только для winner bid)
  const { data: winner } = await anonDb
    .from('tender_bids')
    .select('id, amount, status, tender_drivers(id, name, phone, rating)')
    .eq('order_id', orderId).eq('status', 'winner').single();
  if (winner) {
    const driver = Array.isArray(winner.tender_drivers) ? winner.tender_drivers[0] : winner.tender_drivers;
    ok(`Победитель виден: ${(driver as {name?:string})?.name ?? '?'}, ${winner.amount}₾`);
  } else {
    fail('Победитель не виден через anon');
  }
}

// ─── Step 8: Cleanup ──────────────────────────────────────────────────────────

async function step8_cleanup() {
  section('ШАГ 8: Очистка тестовых данных');

  await serviceDb.from('order_questions').delete().eq('order_id', orderId);
  await serviceDb.from('tender_bids').delete().eq('order_id', orderId);
  await serviceDb.from('tender_orders').delete().eq('id', orderId);
  ok('Тестовые данные удалены');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '═'.repeat(55));
  console.log('  🧪  FULL CYCLE E2E TEST — mushebi.ge');
  console.log('═'.repeat(55));

  const steps = [
    step1_createOrder,
    step2_checkDrivers,
    step3_askQuestion,
    step4_clientAnswer,
    step5_placeBid,
    step6_acceptBid,
    step7_feedDataCheck,
    step8_cleanup,
  ];

  for (const step of steps) {
    const result = await step().catch(err => {
      fail(`Необработанная ошибка в шаге`, err?.message ?? err);
      return false;
    });
    if (result === false) {
      console.log('\n  ⚠️  Шаг вернул ошибку — продолжаем следующий шаг...');
    }
  }

  // ── Final report ───────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log('  📊  ИТОГ');
  console.log('═'.repeat(55));
  console.log(`  ✅  Прошло:  ${passed}`);
  console.log(`  ❌  Упало:   ${failed}`);

  if (errors.length > 0) {
    console.log('\n  Проблемы:');
    errors.forEach(e => console.log(`    • ${e}`));
  } else {
    console.log('\n  🎉  Все тесты прошли успешно!');
  }
  console.log('═'.repeat(55) + '\n');
}

main().catch(console.error);
