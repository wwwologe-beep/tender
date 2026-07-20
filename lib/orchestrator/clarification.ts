/**
 * Client Assistant clarification state machine helpers (tender_orders.clarification_status /
 * missing_info) — shared by every place a client's answer can arrive:
 * - app/api/orchestrator/clarification-result/route.ts (voice answer via client_bridge.py)
 * - app/api/questions/answer/route.ts (web/Telegram answer to the same question)
 *
 * Both paths must resolve the same pause, regardless of which channel the client used to
 * answer — otherwise an order answered on the website stays stuck in 'clarifying' forever,
 * since only the voice path used to know about this state machine.
 */

import { supabaseAdmin } from '@/lib/supabase';
import { buildCallCandidates } from './matching';
import { createCallSequence } from './sequence';
import { originateNextAttempt } from './tick';
import { countInFlightCalls, MAX_CONCURRENT_CALLS } from './concurrency';

/**
 * Marks an order 'ready' (clears missing_info) and re-enters it into the driver call queue.
 * Safe to call even if the order isn't actually 'clarifying' — a no-op update in that case,
 * callers are expected to check clarification_status themselves first when it matters (e.g.
 * questions/answer/route.ts only calls this for the specific question that was blocking).
 */
export async function resolveClarificationAndRequeue(orderId: string): Promise<void> {
  await supabaseAdmin
    .from('tender_orders')
    .update({ clarification_status: 'ready', missing_info: null })
    .eq('id', orderId);

  await requeueForDriverCalls(orderId);
}

/**
 * Re-enters the order into the driver call queue now that the blocking detail is resolved.
 * Mirrors the auto-start logic in app/api/tender/create/route.ts: build/refresh candidates
 * (safe to re-run, upserts), create the sequence if missing, and kick off the next attempt
 * immediately rather than waiting for the next cron/tick — same reasoning as at order creation,
 * a client who just answered a clarifying question shouldn't then wait ~10 minutes for the
 * driver to be called back. If a sequence already exists and is still queued/advancing (the
 * common case — the driver's own attempt already returned 'needs_follow_up' and advanced the
 * sequence), buildCallCandidates/createCallSequence are no-ops and this just opportunistically
 * tries to originate the next attempt now instead of waiting for the tick.
 */
export async function requeueForDriverCalls(orderId: string): Promise<void> {
  try {
    await buildCallCandidates(orderId);
    const { sequenceId } = await createCallSequence(orderId);
    if (!sequenceId) return;

    const { data: seq } = await supabaseAdmin
      .from('order_call_sequences')
      .select('id, order_id, current_position, candidate_count, status')
      .eq('id', sequenceId)
      .single();

    if (!seq || !['queued', 'advancing'].includes(seq.status)) return;

    const inFlight = await countInFlightCalls();
    if (inFlight < MAX_CONCURRENT_CALLS) {
      await originateNextAttempt(seq);
    }
  } catch (e) {
    console.error('[clarification/requeueForDriverCalls]', e, { orderId });
  }
}
