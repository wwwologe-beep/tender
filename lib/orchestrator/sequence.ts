/**
 * Call-sequence state machine for the order call orchestrator.
 *
 * One `order_call_sequences` row per order tracks progress through the ranked
 * `call_candidates` list built by matching.ts. See ARCHITECTURE.md §9 and the
 * orchestrator plan for the full design.
 */

import { supabaseAdmin } from '@/lib/supabase';

export interface CreateSequenceResult {
  sequenceId: string | null;
}

/**
 * Creates the sequence row for an order if it doesn't already have one and has at least
 * one candidate. No-op (returns null) if either condition isn't met — relies on the
 * `UNIQUE(order_id)` constraint plus onConflict to make repeated calls safe.
 */
export async function createCallSequence(orderId: string): Promise<CreateSequenceResult> {
  const { count } = await supabaseAdmin
    .from('call_candidates')
    .select('id', { count: 'exact', head: true })
    .eq('order_id', orderId);

  if (!count || count === 0) return { sequenceId: null };

  const { data, error } = await supabaseAdmin
    .from('order_call_sequences')
    .upsert(
      { order_id: orderId, status: 'queued', current_position: 0, candidate_count: count },
      { onConflict: 'order_id', ignoreDuplicates: true }
    )
    .select('id')
    .maybeSingle();

  if (error) {
    console.error('[createCallSequence]', error.message);
    return { sequenceId: null };
  }

  if (data?.id) return { sequenceId: data.id };

  // ignoreDuplicates:true means an existing row returns no data — fetch its id instead.
  const { data: existing } = await supabaseAdmin
    .from('order_call_sequences')
    .select('id')
    .eq('order_id', orderId)
    .maybeSingle();

  return { sequenceId: existing?.id ?? null };
}

/**
 * Moves a sequence to the next candidate position and marks it 'advancing' so the next
 * cron/tick run picks it up. Shared by both the call-result webhook (non-agreed outcome)
 * and the cron-side stale-attempt timeout path, so the increment logic isn't duplicated.
 */
export async function advanceToNextCandidate(sequenceId: string): Promise<void> {
  const { data: seq } = await supabaseAdmin
    .from('order_call_sequences')
    .select('current_position')
    .eq('id', sequenceId)
    .single();

  if (!seq) return;

  await supabaseAdmin
    .from('order_call_sequences')
    .update({
      current_position: seq.current_position + 1,
      status: 'advancing',
      updated_at: new Date().toISOString(),
    })
    .eq('id', sequenceId);
}

/**
 * Marks a sequence as exhausted when it runs out of candidates with no success.
 * Deliberately minimal fallback: order stays in 'bidding' (already broadcast via the
 * pre-existing Telegram/notification-queue path, unconditionally, at order creation),
 * and orchestrator_flagged_at is set as a queryable breadcrumb for future human review —
 * no auto-retry, no widened candidate pool, no admin notification (out of scope, see plan §9).
 */
export async function exhaustSequence(sequenceId: string, orderId: string): Promise<void> {
  await supabaseAdmin
    .from('order_call_sequences')
    .update({ status: 'exhausted', updated_at: new Date().toISOString() })
    .eq('id', sequenceId);

  await supabaseAdmin
    .from('tender_orders')
    .update({ orchestrator_flagged_at: new Date().toISOString() })
    .eq('id', orderId);
}

/**
 * Marks a sequence succeeded once a candidate agrees, so advanceCallSequences() no longer
 * touches it (filtered out by its `status IN ('queued','advancing')` query).
 */
export async function succeedSequence(sequenceId: string, candidateId: string): Promise<void> {
  await supabaseAdmin
    .from('order_call_sequences')
    .update({
      status: 'succeeded',
      succeeded_candidate_id: candidateId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', sequenceId);
}

/**
 * Marks a sequence cancelled — used when the order leaves 'bidding' (e.g. a Telegram bid
 * was accepted first) before the call sequence finished, so continuing to call more
 * candidates would be pointless.
 */
export async function cancelSequence(sequenceId: string): Promise<void> {
  await supabaseAdmin
    .from('order_call_sequences')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('id', sequenceId);
}
