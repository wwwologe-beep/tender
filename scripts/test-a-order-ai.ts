/**
 * Тест-скрипт: Блок A — AI-фильтр полноты заказа
 *
 * Часть B: реальные вызовы AI (validateOrderCompleteness)
 * Часть C: мок-тесты логики роута (без AI, без HTTP)
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

// ─── Цвета ───────────────────────────────────────────────────────────────────

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

// ─── Импорт функции напрямую (Вариант B) ─────────────────────────────────────

// Патчим path alias @/ для ts-node
import * as tsconfig from 'tsconfig-paths';
tsconfig.register({
  baseUrl: path.resolve(__dirname, '..'),
  paths: { '@/*': ['./*'] },
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateOrderCompleteness } = require('../lib/ai') as typeof import('../lib/ai');

// ─── ЧАСТЬ B: Реальные AI-вызовы ─────────────────────────────────────────────

async function testB_RealAI() {
  section('Часть B — Реальный AI (validateOrderCompleteness)');
  console.log(`  ${CYAN}ℹ Делаем 2 вызова к OpenRouter/Gemini — займёт ~5-10 сек${RESET}`);

  // B1: Пустой заказ — должен вернуть incomplete
  {
    console.log(`\n  ${CYAN}→ B1: "контейнер" (неполный заказ)${RESET}`);
    const result = await validateOrderCompleteness('контейнер');

    result.status === 'incomplete'
      ? ok('B1: статус incomplete')
      : fail('B1: статус incomplete', `получили ${result.status}`);

    result.missing.length > 0
      ? ok(`B1: есть missing поля`, result.missing.join(', '))
      : fail('B1: есть missing поля', 'массив пуст');

    result.questions.length > 0
      ? ok(`B1: есть вопросы для клиента (${result.questions.length} шт.)`)
      : fail('B1: есть вопросы для клиента');

    result.questions.length > 0 &&
      console.log(`     ${YELLOW}Вопросы: ${result.questions.map(q => `"${q}"`).join(' | ')}${RESET}`);
  }

  // B2: Полный заказ — должен вернуть ok
  {
    console.log(`\n  ${CYAN}→ B2: Полный заказ (перевозка квартиры с адресами)${RESET}`);
    const fullOrder = 'Нужно перевезти содержимое 2-комнатной квартиры. Откуда: ул. Руставели 15, Тбилиси. Куда: пр. Агмашенебели 44, Тбилиси. 3 этаж, лифт есть. Нужны 2 грузчика.';
    const result = await validateOrderCompleteness(fullOrder);

    result.status === 'ok'
      ? ok('B2: статус ok — полный заказ принят')
      : fail('B2: статус ok', `получили "${result.status}", missing: ${result.missing.join(', ')}`);

    result.missing.length === 0
      ? ok('B2: missing пуст')
      : fail('B2: missing пуст', result.missing.join(', '));
  }

  // B3: Короткий но понятный заказ — "один диван с Вакэ на Сабуртало"
  {
    console.log(`\n  ${CYAN}→ B3: Краткий, но достаточный заказ ("один диван")${RESET}`);
    const shortOrder = 'Перевезти один диван с Вакэ на Сабуртало';
    const result = await validateOrderCompleteness(shortOrder);

    result.status === 'ok'
      ? ok('B3: статус ok — масштаб понятен из контекста ("один диван")')
      : fail('B3: статус ok', `получили "${result.status}", missing: ${result.missing.join(', ')}`);
  }

  // B4: Сервисный заказ без маршрута — "почистить квартиру"
  {
    console.log(`\n  ${CYAN}→ B4: Неполный сервисный заказ ("почистить квартиру" без адреса)${RESET}`);
    const result = await validateOrderCompleteness('почистить квартиру');

    result.status === 'incomplete'
      ? ok('B4: статус incomplete — адрес не указан')
      : fail('B4: статус incomplete', `получили ${result.status}`);
  }

  // B5: Грузинский язык
  {
    console.log(`\n  ${CYAN}→ B5: Грузинский текст (неполный)${RESET}`);
    const result = await validateOrderCompleteness('კონტეინერი');

    result.status === 'incomplete'
      ? ok('B5: грузинский язык — incomplete')
      : fail('B5: грузинский язык — incomplete', `получили ${result.status}`);

    result.detected_lang === 'ka'
      ? ok(`B5: язык определён как ka`)
      : fail(`B5: язык ka`, `получили ${result.detected_lang}`);
  }
}

// ─── ЧАСТЬ C: Мок-тесты логики роута ────────────────────────────────────────
// Тестируем ЛОГИКУ без реального AI и без HTTP

async function testC_MockLogic() {
  section('Часть C — Мок-тесты логики роута (без AI, без HTTP)');

  type CheckResult = { status: 'ok' | 'incomplete'; detected_lang: 'ru' | 'ka' | 'en'; missing: string[]; questions: string[] };

  // Имитируем поведение роута
  function simulateRoute(body: Record<string, unknown>, aiResult: CheckResult): { status: number; body: Record<string, unknown> } {
    // Валидация обязательных полей
    if (!body.client_phone) return { status: 400, body: { error: 'client_phone обязателен' } };
    if (!body.cargo_description && !body.address_from) return { status: 400, body: { error: 'Укажите описание' } };

    // AI-гейткипер (пропускаем если structured:true)
    if (!body.structured) {
      if (aiResult.status === 'incomplete') {
        return {
          status: 422,
          body: {
            error: 'incomplete_order',
            message: 'Для создания заказа нужно уточнить несколько деталей',
            missing: aiResult.missing,
            questions: aiResult.questions,
          },
        };
      }
    }

    // INSERT (мок)
    return { status: 201, body: { order: { id: 'mock-id', token: 'mock-token' }, client_url: 'https://mushebi.ge/feed/mock-token' } };
  }

  const incompleteAI: CheckResult = { status: 'incomplete', detected_lang: 'ru', missing: ['destination', 'scale'], questions: ['Куда везём?', 'Какой объём?'] };
  const completeAI: CheckResult = { status: 'ok', detected_lang: 'ru', missing: [], questions: [] };

  // C1: Нет client_phone → 400
  {
    const res = simulateRoute({ cargo_description: 'перевезти вещи' }, completeAI);
    res.status === 400
      ? ok('C1: нет client_phone → 400')
      : fail('C1: нет client_phone → 400', `получили ${res.status}`);
  }

  // C2: Нет описания и адреса → 400
  {
    const res = simulateRoute({ client_phone: '+995599000001' }, completeAI);
    res.status === 400
      ? ok('C2: нет описания → 400')
      : fail('C2: нет описания → 400', `получили ${res.status}`);
  }

  // C3: AI вернул incomplete → 422 с вопросами
  {
    const res = simulateRoute({ client_phone: '+995599000001', cargo_description: 'контейнер' }, incompleteAI);
    res.status === 422
      ? ok('C3: неполный заказ → 422')
      : fail('C3: неполный заказ → 422', `получили ${res.status}`);

    (res.body as Record<string, unknown>).error === 'incomplete_order'
      ? ok('C3: error = incomplete_order')
      : fail('C3: error = incomplete_order');

    const q = (res.body as Record<string, string[]>).questions;
    Array.isArray(q) && q.length > 0
      ? ok(`C3: questions в ответе (${q.length} шт.)`)
      : fail('C3: questions в ответе');

    const m = (res.body as Record<string, string[]>).missing;
    Array.isArray(m) && m.length > 0
      ? ok(`C3: missing в ответе (${m.join(', ')})`)
      : fail('C3: missing в ответе');
  }

  // C4: AI вернул ok → 201
  {
    const res = simulateRoute({ client_phone: '+995599000001', cargo_description: 'полный заказ с адресами' }, completeAI);
    res.status === 201
      ? ok('C4: полный заказ → 201')
      : fail('C4: полный заказ → 201', `получили ${res.status}`);

    (res.body as Record<string, unknown>).order
      ? ok('C4: в ответе есть order')
      : fail('C4: в ответе есть order');
  }

  // C5: structured:true → пропускаем AI даже если он вернул incomplete → 201
  {
    const res = simulateRoute(
      { client_phone: '+995599000001', cargo_description: 'контейнер', structured: true },
      incompleteAI // AI сказал бы incomplete, но мы его пропускаем
    );
    res.status === 201
      ? ok('C5: structured:true — AI-фильтр пропущен → 201')
      : fail('C5: structured:true — AI-фильтр пропущен → 201', `получили ${res.status}`);
  }

  // C6: Проверяем структуру 422 ответа — есть все нужные поля
  {
    const res = simulateRoute({ client_phone: '+995599000001', cargo_description: 'контейнер' }, incompleteAI);
    const b = res.body as Record<string, unknown>;
    const hasAll = 'error' in b && 'message' in b && 'missing' in b && 'questions' in b;
    hasAll
      ? ok('C6: 422 содержит error, message, missing, questions')
      : fail('C6: 422 содержит все поля', `есть: ${Object.keys(b).join(', ')}`);
  }

  // C7: Заказ с address_from но без cargo_description — проходит базовую валидацию
  {
    const res = simulateRoute({ client_phone: '+995599000001', address_from: 'Руставели 15' }, completeAI);
    res.status === 201
      ? ok('C7: только address_from без cargo_description — базовая валидация ok')
      : fail('C7: только address_from', `получили ${res.status}`);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\n${BOLD}═══════════════════════════════════════════════${RESET}`);
  console.log(`${BOLD}  Тест-suite: Блок A — AI-фильтр полноты заказа${RESET}`);
  console.log(`${BOLD}═══════════════════════════════════════════════${RESET}`);

  await testC_MockLogic();  // сначала моки — быстро
  await testB_RealAI();     // потом реальный AI

  const total = passed + failed;
  console.log(`\n${BOLD}═══════════════════════════════════════════════${RESET}`);
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}  PASSED ${passed}/${total} тестов ✓${RESET}`);
  } else {
    console.log(`${RED}${BOLD}  FAILED ${failed}/${total} тестов ✗${RESET}`);
    console.log(`${GREEN}  Прошло: ${passed}${RESET}`);
    console.log(`${RED}  Упало:  ${failed}${RESET}`);
  }
  console.log(`${BOLD}═══════════════════════════════════════════════${RESET}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error(`${RED}Критическая ошибка:${RESET}`, err);
  process.exit(1);
});
