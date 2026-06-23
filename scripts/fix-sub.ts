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
  // Give 30 days to all real drivers (status=active, no subscription)
  const { data, error } = await db
    .from('tender_drivers')
    .update({
      subscription_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq('status', 'active')
    .is('subscription_expires_at', null)
    .select('name, telegram_id');

  if (error) { console.error('Error:', error.message); return; }
  console.log(`✅ Выдана подписка на 30 дней:`);
  for (const d of data ?? []) console.log(`  → ${d.name} (tg: ${d.telegram_id})`);
}

main().catch(console.error);
