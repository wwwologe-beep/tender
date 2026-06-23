/**
 * Простой ресенд заказа — не импортирует bot.ts, вызывает Telegram API напрямую.
 * Использование: npx ts-node ... scripts/resend-simple.ts [order_token]
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

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

async function tgSend(chatId: number, text: string) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  const data = await res.json() as { ok: boolean; description?: string };
  if (!data.ok) console.error(`  ⚠️  tg error for ${chatId}: ${data.description}`);
  return data.ok;
}

async function main() {
  const tokenArg = process.argv[2];

  // Найти заказ
  let order: { id: string; token: string; cargo_description: string | null; category: string | null } | null = null;
  if (tokenArg) {
    const { data } = await db.from('tender_orders').select('id, token, cargo_description, category').eq('token', tokenArg).single();
    order = data;
  } else {
    const { data } = await db
      .from('tender_orders').select('id, token, cargo_description, category')
      .eq('status', 'bidding').order('created_at', { ascending: false }).limit(1).single();
    order = data;
  }

  if (!order) { console.error('Заказ не найден'); process.exit(1); }
  console.log(`\n📦 ${order.cargo_description?.slice(0, 80)}`);
  console.log(`   token: ${order.token}\n`);

  // Найти всех активных исполнителей с подпиской
  const { data: drivers } = await db
    .from('tender_drivers')
    .select('id, name, telegram_id, driver_language')
    .eq('status', 'active')
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());

  if (!drivers?.length) {
    console.log('❌ Нет активных исполнителей с подпиской');
    return;
  }

  console.log(`Рассылаем ${drivers.length} исполнителям...\n`);

  const feedUrl = `https://mushebi.ge/feed/${order.token}`;
  const desc    = order.cargo_description ?? 'Новый заказ';

  for (const driver of drivers) {
    const lang = driver.driver_language ?? 'ru';
    const text = lang === 'ka'
      ? `🆕 <b>ახალი შეკვეთა mushebi.ge-ზე</b>\n\n${desc}\n\n<a href="${feedUrl}">👉 გახსენი და შემოთავაზე ფასი</a>`
      : lang === 'en'
      ? `🆕 <b>New order on mushebi.ge</b>\n\n${desc}\n\n<a href="${feedUrl}">👉 Open and make an offer</a>`
      : `🆕 <b>Новый заказ на mushebi.ge</b>\n\n${desc}\n\n<a href="${feedUrl}">👉 Открыть и сделать ставку</a>`;

    const ok = await tgSend(driver.telegram_id as number, text);
    console.log(`  ${ok ? '✅' : '❌'} ${driver.name} (tg: ${driver.telegram_id})`);
  }

  console.log('\n✅ Готово\n');
}

main().catch(console.error);
