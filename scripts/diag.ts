import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

async function main() {
  console.log('\n── Диагностика mushebi.ge ──────────────────────────\n');

  // Все исполнители
  const { data: drivers } = await db
    .from('tender_drivers')
    .select('id, name, status, driver_language, specialization, subscription_expires_at, telegram_id')
    .order('created_at', { ascending: false });

  console.log(`Всего исполнителей: ${drivers?.length ?? 0}`);
  for (const d of drivers ?? []) {
    const exp   = d.subscription_expires_at;
    const active = exp && new Date(exp) > new Date();
    console.log(`  ${active ? '✅' : '❌'} ${d.name} | status=${d.status} | lang=${d.driver_language} | spec=${d.specialization} | sub=${exp ? new Date(exp).toLocaleDateString() : 'нет'} | tg=${d.telegram_id}`);
  }

  // Активные с подпиской
  const { data: eligible } = await db
    .from('tender_drivers')
    .select('id, name')
    .eq('status', 'active')
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());

  console.log(`\nПолучат уведомления (active + sub + tg_id): ${eligible?.length ?? 0}`);
  for (const d of eligible ?? []) console.log(`  → ${d.name}`);

  // Последние заказы
  const { data: orders } = await db
    .from('tender_orders')
    .select('id, token, status, cargo_description, category, created_at')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log(`\nПоследние заказы:`);
  for (const o of orders ?? []) {
    const { count } = await db
      .from('tender_bids').select('*', { count: 'exact', head: true }).eq('order_id', o.id);
    console.log(`  [${o.status}] ${o.cargo_description?.slice(0, 60)} | bids=${count} | cat=${o.category}`);
  }

  console.log('\n────────────────────────────────────────────────────\n');
}

main().catch(console.error);
