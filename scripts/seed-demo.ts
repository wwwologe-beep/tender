/**
 * Seed demo data for local visual testing.
 * Run: npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/seed-demo.ts
 *
 * Idempotent: upserts by fixed IDs, safe to re-run.
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

// ─── Фиксированные ID для идемпотентности ────────────────────────────────────

const ORDER_ID    = 'aaaaaaaa-0000-0000-0000-000000000001';
const ORDER_TOKEN = '77777777-7777-7777-7777-777777777777';
const DRIVER_GEO  = 'bbbbbbbb-0000-0000-0000-000000000001'; // გიორგი
const DRIVER_RU   = 'bbbbbbbb-0000-0000-0000-000000000002'; // Дмитрий
const BID_GEO     = 'cccccccc-0000-0000-0000-000000000001';
const BID_RU      = 'cccccccc-0000-0000-0000-000000000002';

const SUB_ACTIVE  = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(); // +14 дней

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(msg: string)   { console.log(`  ✅  ${msg}`); }
function fail(msg: string) { console.error(`  ❌  ${msg}`); process.exit(1); }

async function upsert(table: string, data: Record<string, unknown>, conflict: string) {
  const { error } = await db.from(table).upsert(data, { onConflict: conflict });
  if (error) fail(`${table}: ${error.message}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🌱  Seed demo data → mushebi.ge\n');

  // 1. Водители
  await upsert('tender_drivers', {
    id:                      DRIVER_GEO,
    name:                    'გიორგი მამალაძე',
    phone:                   '+995599000101',
    telegram_id:             9900001,
    status:                  'active',
    driver_language:         'ka',
    specialization:          'mover',
    rating:                  4.9,
    rating_sum:              490,
    rating_count:            100,
    completed_orders:        100,
    total_earned:            18400,
    subscription_expires_at: SUB_ACTIVE,
    reg_state:               null,
  }, 'id');
  ok('Водитель გიორგი (KA, rating 4.9)');

  await upsert('tender_drivers', {
    id:                      DRIVER_RU,
    name:                    'Дмитрий Иванов',
    phone:                   '+995599000102',
    telegram_id:             9900002,
    status:                  'active',
    driver_language:         'ru',
    specialization:          'mover',
    rating:                  4.8,
    rating_sum:              384,
    rating_count:            80,
    completed_orders:        80,
    total_earned:            14200,
    subscription_expires_at: SUB_ACTIVE,
    reg_state:               null,
  }, 'id');
  ok('Водитель Дмитрий (RU, rating 4.8)');

  // 2. Заказ
  await upsert('tender_orders', {
    id:                ORDER_ID,
    token:             ORDER_TOKEN,
    status:            'bidding',
    cargo_description: 'Переезд 1-комнатной квартиры с Сабуртало на Ваке. Нужен Форд Транзит и два аккуратных грузчика. Вещи упакованы.',
    address_from:      'Тбилиси, Сабуртало, ул. Важа-Пшавела 45',
    address_to:        'Тбилиси, Ваке, ул. Чавчавадзе 12',
    client_phone:      '+99591000099',
    client_budget:     200,
    category:          'moving',
    live_brief_ai:     '🏠 **Переезд квартиры** · Сабуртало → Ваке\n\n📦 Объём: 1-комнатная квартира, вещи упакованы\n🚐 Требуется: Ford Transit + 2 грузчика\n💰 Бюджет клиента: 200 ₾\n\n*Вещи готовы к транспортировке, нужна аккуратная переноска.*',
    ai_summary:        'Переезд 1-комнатной квартиры. Маршрут: Сабуртало → Ваке. Нужен Ford Transit + 2 грузчика. Вещи упакованы.',
    faq_summary:       null,
    workers_needed:    2,
    vehicles_needed:   1,
    notes:             'Вещи упакованы, нужна аккуратная переноска.',
    client_name:       'Тестовый Клиент',
  }, 'id');
  ok(`Заказ token=${ORDER_TOKEN} (bidding, 200₾, moving)`);

  // 3. Ставки
  await upsert('tender_bids', {
    id:         BID_GEO,
    order_id:   ORDER_ID,
    driver_id:  DRIVER_GEO,
    amount:     170,
    status:     'pending',
    comment:    'მზად ვართ 30 წუთში მოვიდეთ. გვაქვს ქამრები და დამცავი ფირი.',
    bot_state:  'idle',
  }, 'id');
  ok('Ставка გიორგი: 170₾ — "მზად ვართ 30 წუთში..."');

  await upsert('tender_bids', {
    id:         BID_RU,
    order_id:   ORDER_ID,
    driver_id:  DRIVER_RU,
    amount:     180,
    status:     'pending',
    comment:    'Приедем на чистом минивэне, поможем всё упаковать и перенести. Опыт 3 года.',
    bot_state:  'idle',
  }, 'id');
  ok('Ставка Дмитрий: 180₾ — "Приедем на чистом минивэне..."');

  // 4. Итог
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('🔗  Страница заказа (клиент):');
  console.log(`    http://localhost:3000/feed/${ORDER_TOKEN}\n`);
  console.log('🔗  Страница заказа (водитель გიორგი):');
  console.log(`    http://localhost:3000/feed/${ORDER_TOKEN}?driver_id=${DRIVER_GEO}\n`);
  console.log('🔗  Страница заказа (водитель Дмитрий):');
  console.log(`    http://localhost:3000/feed/${ORDER_TOKEN}?driver_id=${DRIVER_RU}\n`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log('Для очистки тестовых данных запусти:');
  console.log('  npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/seed-demo.ts --clean\n');
}

// ─── Cleanup mode ─────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('\n🧹  Cleanup demo data...\n');
  await db.from('tender_bids').delete().in('id', [BID_GEO, BID_RU]);
  await db.from('tender_orders').delete().eq('id', ORDER_ID);
  await db.from('tender_drivers').delete().in('id', [DRIVER_GEO, DRIVER_RU]);
  console.log('  ✅  Тестовые данные удалены\n');
}

if (process.argv.includes('--clean')) {
  cleanup().catch(console.error);
} else {
  main().catch(console.error);
}
