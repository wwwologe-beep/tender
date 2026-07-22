/**
 * Скачивает записи из system_logs (Supabase) в локальную папку logs/ для анализа.
 *
 * Использование:
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --hours=2
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --order=<order_id>
 *   npx ts-node -r tsconfig-paths/register --project scripts/tsconfig.json scripts/pull-logs.ts --source=voice-call
 *
 * По умолчанию — последние 24 часа. Пишет один .jsonl (по записи на строку, полные данные)
 * и один читаемый .txt (для быстрого просмотра глазами) в logs/, с именем по временной метке.
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
  return {
    hours: Number(get('hours') ?? 24),
    orderId: get('order'),
    source: get('source'),
  };
}

async function main() {
  const { hours, orderId, source } = parseArgs();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  let query = db
    .from('system_logs')
    .select('*')
    .gte('created_at', since)
    .order('created_at', { ascending: true });

  if (orderId) query = query.eq('order_id', orderId);
  if (source) query = query.eq('source', source);

  const { data, error } = await query;
  if (error) {
    console.error('Ошибка запроса к system_logs:', error.message);
    process.exit(1);
  }

  const rows = data ?? [];
  console.log(`Найдено ${rows.length} записей (за последние ${hours}ч${orderId ? `, order=${orderId}` : ''}${source ? `, source=${source}` : ''})`);

  if (rows.length === 0) {
    console.log('Нечего сохранять.');
    return;
  }

  const logsDir = path.resolve(__dirname, '../logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const jsonlPath = path.join(logsDir, `logs_${stamp}.jsonl`);
  const txtPath = path.join(logsDir, `logs_${stamp}.txt`);

  fs.writeFileSync(jsonlPath, rows.map(r => JSON.stringify(r)).join('\n'));

  const txtLines = rows.map(r => {
    const dataStr = r.data ? JSON.stringify(r.data, null, 2) : '';
    return `[${r.created_at}] [${r.source}] [${r.tag}] [${r.level}]${r.order_id ? ` order=${r.order_id}` : ''}\n${r.message}\n${dataStr ? dataStr + '\n' : ''}`;
  });
  fs.writeFileSync(txtPath, txtLines.join('\n' + '-'.repeat(80) + '\n\n'));

  console.log(`Сохранено:\n  ${jsonlPath} (полные данные, по записи в строке)\n  ${txtPath} (читаемый формат)`);
}

main();
