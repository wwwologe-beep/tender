import { supabaseAdmin } from '@/lib/supabase';

export type LogSource = 'ai-agent' | 'voice-call' | 'api' | 'webhook';
export type LogLevel = 'info' | 'warn' | 'error';

interface LogEntryParams {
  source: LogSource;
  tag: string;
  level?: LogLevel;
  orderId?: string | null;
  message: string;
  data?: unknown;
}

/**
 * Persists a log entry to system_logs (Supabase) in addition to the existing
 * console.log/console.error — console output only survives as long as the current
 * Vercel/VPS log retention window, this table is the queryable, permanent record used
 * for after-the-fact analysis (see scripts/pull-logs.ts to export it locally).
 *
 * Never throws — a logging failure must not break the actual request/agent call it's
 * logging. Fire-and-forget by design (callers don't await unless they specifically need
 * the write to complete before continuing).
 */
export async function logSystemEvent(params: LogEntryParams): Promise<void> {
  try {
    await supabaseAdmin.from('system_logs').insert({
      source: params.source,
      tag: params.tag,
      level: params.level ?? 'info',
      order_id: params.orderId ?? null,
      message: params.message,
      data: params.data ?? null,
    });
  } catch (err) {
    console.error('[system-log] failed to persist log entry', err);
  }
}
