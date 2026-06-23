/**
 * Тест-скрипт: Блок H — Регистрация исполнителя
 * Тестирует логику валидации и состояний напрямую через Supabase.
 * Не требует запущенного бота.
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// ─── Цвета для вывода ────────────────────────────────────────────────────────

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';

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

// ─── Логика валидации (скопирована из bot.ts) ────────────────────────────────

function validateName(text: string): boolean {
  return /^[\p{L}\s]{2,50}$/u.test(text);
}

function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '');
  const withPlus = digits.startsWith('+') ? digits : `+${digits}`;
  return /^\+\d{9,15}$/.test(withPlus) ? withPlus : null;
}

// ─── Тестовые данные ─────────────────────────────────────────────────────────

const TEST_TELEGRAM_ID_1 = 9999000001; // чистый новый пользователь
const TEST_TELEGRAM_ID_2 = 9999000002; // для теста дубликата телефона
const TEST_PHONE = '+995599000001';
const TEST_NAME_VALID = 'Георгий Тест';
const TEST_NAME_INVALID_DIGITS = '12345';
const TEST_NAME_INVALID_SYMBOLS = '!!!@@@';
const TEST_NAME_TOO_SHORT = 'А';
const TEST_NAME_TOO_LONG = 'А'.repeat(51);

// ─── Очистка тестовых данных ─────────────────────────────────────────────────

async function cleanup() {
  await supabase.from('tender_drivers')
    .delete()
    .in('telegram_id', [TEST_TELEGRAM_ID_1, TEST_TELEGRAM_ID_2]);
}

// ─── H2: Валидация имени ─────────────────────────────────────────────────────

async function testH2NameValidation() {
  section('H2 — Валидация имени');

  const cases: [string, string, boolean][] = [
    [TEST_NAME_INVALID_DIGITS,  'цифры "12345"',         false],
    [TEST_NAME_INVALID_SYMBOLS, 'символы "!!!@@@"',      false],
    [TEST_NAME_TOO_SHORT,       'слишком короткое "А"',  false],
    [TEST_NAME_TOO_LONG,        '51 символ',             false],
    ['123 Abc',                 'начинается с цифры',    false],
    [TEST_NAME_VALID,           'нормальное имя (ru)',    true],
    ['გიორგი',                  'грузинское имя',        true],
    ['John Smith',              'английское имя',        true],
    ['Ги Ги',                   'два слога с пробелом',  true],
  ];

  for (const [input, label, expected] of cases) {
    const result = validateName(input);
    if (result === expected) {
      ok(`${label}`, `validateName → ${result}`);
    } else {
      fail(`${label}`, `ожидали ${expected}, получили ${result}`);
    }
  }
}

// ─── H3: Валидация телефона ──────────────────────────────────────────────────

async function testH3PhoneValidation() {
  section('H3 — Валидация телефона');

  const cases: [string, string, boolean][] = [
    ['+995591234567', 'грузинский +995',       true],
    ['995591234567',  'без плюса',             true],
    ['+7 999 123 45 67', 'российский с пробелами', true],
    ['+1234',         'слишком короткий',       false],
    ['abc',           'буквы',                 false],
    ['',              'пустая строка',          false],
    ['+' + '9'.repeat(16), '16 цифр — слишком длинный', false],
    ['+995 59 123 45 67', 'с пробелами грузинский', true],
  ];

  for (const [input, label, expected] of cases) {
    const result = normalizePhone(input) !== null;
    if (result === expected) {
      ok(`${label}`, `normalizePhone → ${normalizePhone(input) ?? 'null'}`);
    } else {
      fail(`${label}`, `ожидали ${expected}, получили ${result}`);
    }
  }
}

// ─── H1: Цепочка шагов в Supabase ───────────────────────────────────────────

async function testH1RegistrationFlow() {
  section('H1 — Цепочка регистрации (Supabase)');

  // Создаём временную запись как это делает /start
  const { error: upsertErr } = await supabase.from('tender_drivers').upsert(
    {
      telegram_id: TEST_TELEGRAM_ID_1,
      reg_state: { step: 'name' },
      status: 'registering',
      name: '',
      phone: '',
    },
    { onConflict: 'telegram_id' }
  );

  if (upsertErr) { fail('Создание записи /start', upsertErr.message); return; }
  ok('Создание записи /start');

  // Проверяем что запись создана с шагом name
  const { data: afterStart } = await supabase
    .from('tender_drivers')
    .select('reg_state, status')
    .eq('telegram_id', TEST_TELEGRAM_ID_1)
    .single();

  const step1 = (afterStart?.reg_state as Record<string, string>)?.step;
  step1 === 'name' ? ok('Шаг: name') : fail('Шаг: name', `получили ${step1}`);
  afterStart?.status === 'registering' ? ok('Статус: registering') : fail('Статус: registering');

  // Переходим на шаг phone (имитируем ввод имени)
  const { data: driver } = await supabase.from('tender_drivers').select('id').eq('telegram_id', TEST_TELEGRAM_ID_1).single();
  await supabase.from('tender_drivers').update({
    reg_state: { step: 'phone', name: TEST_NAME_VALID },
    name: TEST_NAME_VALID,
  }).eq('id', driver!.id);

  const { data: afterName } = await supabase.from('tender_drivers').select('reg_state, name').eq('telegram_id', TEST_TELEGRAM_ID_1).single();
  const step2 = (afterName?.reg_state as Record<string, string>)?.step;
  step2 === 'phone' ? ok('Шаг: phone') : fail('Шаг: phone', `получили ${step2}`);
  afterName?.name === TEST_NAME_VALID ? ok(`Имя сохранено: "${afterName.name}"`) : fail('Имя сохранено');

  // Переходим на шаг lang (имитируем ввод телефона)
  await supabase.from('tender_drivers').update({
    reg_state: { step: 'lang', name: TEST_NAME_VALID, phone: TEST_PHONE },
    phone: TEST_PHONE,
  }).eq('id', driver!.id);

  const { data: afterPhone } = await supabase.from('tender_drivers').select('reg_state, phone').eq('telegram_id', TEST_TELEGRAM_ID_1).single();
  const step3 = (afterPhone?.reg_state as Record<string, string>)?.step;
  step3 === 'lang' ? ok('Шаг: lang') : fail('Шаг: lang', `получили ${step3}`);
  afterPhone?.phone === TEST_PHONE ? ok(`Телефон сохранён: ${afterPhone.phone}`) : fail('Телефон сохранён');

  // Переходим на шаг spec (имитируем выбор языка)
  await supabase.from('tender_drivers').update({
    reg_state: { step: 'spec', name: TEST_NAME_VALID, phone: TEST_PHONE, lang: 'ru' },
    driver_language: 'ru',
  }).eq('id', driver!.id);

  const { data: afterLang } = await supabase.from('tender_drivers').select('reg_state, driver_language').eq('telegram_id', TEST_TELEGRAM_ID_1).single();
  const step4 = (afterLang?.reg_state as Record<string, string>)?.step;
  step4 === 'spec' ? ok('Шаг: spec') : fail('Шаг: spec', `получили ${step4}`);

  // Завершаем регистрацию (имитируем выбор специализации)
  await supabase.from('tender_drivers').update({
    name: TEST_NAME_VALID,
    phone: TEST_PHONE,
    driver_language: 'ru',
    specialization: 'mover',
    status: 'pending',
    reg_state: null,
  }).eq('id', driver!.id);

  const { data: afterSpec } = await supabase.from('tender_drivers').select('status, reg_state, specialization').eq('telegram_id', TEST_TELEGRAM_ID_1).single();
  afterSpec?.status === 'pending' ? ok('Статус после регистрации: pending') : fail('Статус: pending');
  afterSpec?.reg_state === null ? ok('reg_state очищен') : fail('reg_state очищен', `${JSON.stringify(afterSpec?.reg_state)}`);
  afterSpec?.specialization === 'mover' ? ok('Специализация: mover') : fail('Специализация: mover');
}

// ─── H4: Дубликат телефона — запись удаляется ────────────────────────────────

async function testH4DuplicatePhone() {
  section('H4 — Дубликат телефона (фикс: удаление из лимбо)');

  // Создаём второго пользователя в процессе регистрации
  await supabase.from('tender_drivers').upsert(
    {
      telegram_id: TEST_TELEGRAM_ID_2,
      reg_state: { step: 'phone', name: 'Дубль Тест' },
      status: 'registering',
      name: 'Дубль Тест',
      phone: '',
    },
    { onConflict: 'telegram_id' }
  );

  const { data: before } = await supabase.from('tender_drivers').select('id').eq('telegram_id', TEST_TELEGRAM_ID_2).single();
  before ? ok('Запись registering создана') : fail('Запись registering создана');

  // Проверяем: TEST_PHONE уже занят первым пользователем (H1 тест)
  const { data: byPhone } = await supabase
    .from('tender_drivers')
    .select('id')
    .eq('phone', TEST_PHONE)
    .neq('id', before!.id)
    .single();

  byPhone ? ok(`Телефон ${TEST_PHONE} уже занят другим пользователем`) : fail('Телефон занят', 'не нашли занятый номер — убедитесь что H1 отработал');

  if (byPhone) {
    // Имитируем фикс: удаляем временную запись
    const { error: delErr } = await supabase
      .from('tender_drivers')
      .delete()
      .eq('id', before!.id)
      .eq('status', 'registering');

    delErr ? fail('Удаление registering-записи', delErr.message) : ok('Запись registering удалена');

    // Проверяем что запись действительно исчезла
    const { data: afterDelete } = await supabase
      .from('tender_drivers')
      .select('id')
      .eq('telegram_id', TEST_TELEGRAM_ID_2)
      .single();

    !afterDelete ? ok('Запись не существует — лимбо устранён') : fail('Лимбо устранён', 'запись всё ещё существует');

    // Проверяем что /start создаст новую запись без проблем (upsert)
    const { error: restartErr } = await supabase.from('tender_drivers').upsert(
      {
        telegram_id: TEST_TELEGRAM_ID_2,
        reg_state: { step: 'name' },
        status: 'registering',
        name: '',
        phone: '',
      },
      { onConflict: 'telegram_id' }
    );
    restartErr ? fail('/start после дубликата работает') : ok('/start после дубликата работает — новая запись создана');
  }
}

// ─── H7: Повторный /start у активного пользователя ───────────────────────────

async function testH7RepeatedStart() {
  section('H7 — Повторный /start (уже зарегистрированный)');

  // Первый пользователь из H1 теперь в статусе pending
  const { data: driver } = await supabase
    .from('tender_drivers')
    .select('status, reg_state')
    .eq('telegram_id', TEST_TELEGRAM_ID_1)
    .single();

  if (!driver) { fail('Пользователь найден'); return; }
  ok('Пользователь найден в БД');

  // Логика /start: если reg_state = null → показываем статус (не сбрасываем)
  const hasRegState = driver.reg_state !== null;
  !hasRegState ? ok('reg_state = null → /start покажет статус, не сбросит') : fail('reg_state должен быть null', `получили ${JSON.stringify(driver.reg_state)}`);
  driver.status === 'pending' ? ok(`Статус: ${driver.status}`) : fail('Статус pending', `получили ${driver.status}`);
}

// ─── Запуск всех тестов ───────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}═══════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок H — Регистрация исполнителя${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}`);

  await cleanup();

  await testH2NameValidation();
  await testH3PhoneValidation();
  await testH1RegistrationFlow();
  await testH4DuplicatePhone();
  await testH7RepeatedStart();

  await cleanup();

  const total = passed + failed;
  console.log(`\n${BOLD}═══════════════════════════════════════════${RESET}`);
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}  PASSED ${passed}/${total} тестов ✓${RESET}`);
  } else {
    console.log(`${RED}${BOLD}  FAILED ${failed}/${total} тестов ✗${RESET}`);
    console.log(`${GREEN}  Прошло: ${passed}${RESET}`);
    console.log(`${RED}  Упало:  ${failed}${RESET}`);
  }
  console.log(`${BOLD}═══════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`${RED}Критическая ошибка:${RESET}`, err);
  process.exit(1);
});
