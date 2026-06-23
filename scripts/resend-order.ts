/**
 * Повторно рассылает заказ исполнителям.
 * Использование: npx ts-node ... scripts/resend-order.ts <order_token>
 * Если токен не указан — берёт последний bidding-заказ.
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

// Динамический импорт бота (избегаем проблем с Bot инициализацией)
async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const tokenArg = process.argv[2];
  let orderId: string;

  if (tokenArg) {
    const { data } = await db.from('tender_orders').select('id, cargo_description').eq('token', tokenArg).single();
    if (!data) { console.error('Заказ не найден:', tokenArg); process.exit(1); }
    orderId = data.id;
    console.log(`\n📦 Заказ: ${data.cargo_description?.slice(0, 80)}`);
  } else {
    const { data } = await db
      .from('tender_orders').select('id, cargo_description, token')
      .eq('status', 'bidding').order('created_at', { ascending: false }).limit(1).single();
    if (!data) { console.error('Нет активных заказов'); process.exit(1); }
    orderId = data.id;
    console.log(`\n📦 Последний заказ: ${data.cargo_description?.slice(0, 80)}`);
    console.log(`   token: ${data.token}`);
  }

  console.log('\n🔄 Рассылаем...');
  const { sendTenderToDrivers } = await import('../lib/telegram/bot');
  await sendTenderToDrivers(orderId);
  console.log('✅ Готово\n');
}

main().catch(console.error);
