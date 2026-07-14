/**
 * Global concurrency gate for outbound orchestrator calls.
 *
 * State lives in Supabase (`order_call_attempts.status`), not in any Vercel process —
 * function instances aren't persistent, the same reason `agent_sessions` exists for chat
 * history and the same reason the in-process setTimeout nudge in lib/telegram/bot.ts is
 * unreliable. A single row-count SELECT before each batch of originate calls is sufficient
 * at this scale (single-digit concurrent calls, cron runs every ~10 min).
 *
 * Known race (not solved here, see ARCHITECTURE.md/plan): two overlapping cron invocations
 * could both read the same in-flight count and both originate calls, exceeding the cap by a
 * small margin. Low-probability/low-severity given the cap is "around 4-5", not a hard limit
 * that errors past exactly N. If it becomes a real problem, the fix is a claim-pattern
 * `UPDATE ... WHERE status='pending' RETURNING id` rather than a separate lock table.
 */

import { supabaseAdmin } from '@/lib/supabase';

export const MAX_CONCURRENT_CALLS = Number(process.env.ORCHESTRATOR_MAX_CONCURRENT_CALLS ?? 4);

export async function countInFlightCalls(): Promise<number> {
  const { count } = await supabaseAdmin
    .from('order_call_attempts')
    .select('id', { count: 'exact', head: true })
    .in('status', ['originating', 'in_progress']);
  return count ?? 0;
}
