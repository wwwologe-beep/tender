import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env.local') });
const anonDb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

async function main() {
  const tables = ['tender_orders', 'tender_bids', 'order_questions', 'tender_drivers'];
  for (const t of tables) {
    const { data, error } = await anonDb.from(t).select('*').limit(1);
    const rls = error ? `❌ ${error.message}` : data?.length === 0 ? '⚠️  RLS блокирует (0 строк)' : `✅ читает (${data?.length} строка)`;
    console.log(`${t}: ${rls}`);
  }
}
main().catch(console.error);
