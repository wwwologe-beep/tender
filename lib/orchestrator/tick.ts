/**
 * Core orchestrator loop, called from app/api/cron/tick/route.ts on every external cron ping
 * (~10 min cadence, same as the rest of the jobs in that route). This is the single serialized
 * driver of all outbound orchestrator calling — see ARCHITECTURE.md §9 and the orchestrator plan.
 */

import { supabaseAdmin } from '@/lib/supabase';
import { buildCallCandidates } from './matching';
import { createCallSequence, advanceToNextCandidate, exhaustSequence, cancelSequence } from './sequence';
import { MAX_CONCURRENT_CALLS, countInFlightCalls } from './concurrency';
import { originateCall } from './bridge-client';

const ATTEMPT_TIMEOUT_MINUTES = Number(process.env.ORCHESTRATOR_ATTEMPT_TIMEOUT_MINUTES ?? 6);
const TRUNK_CALLER_ID = process.env.ORCHESTRATOR_CALLER_ID ?? '';

export async function advanceCallSequences(): Promise<string> {
  const timedOut = await timeoutStaleAttempts();

  const inFlight = await countInFlightCalls();
  let freeSlots = Math.max(0, MAX_CONCURRENT_CALLS - inFlight);
  if (freeSlots === 0) {
    return `orchestrator: 0 free slots (${inFlight} in flight), ${timedOut} timed out`;
  }

  const backfilled = await backfillMissingSequences();

  const { data: sequences } = await supabaseAdmin
    .from('order_call_sequences')
    .select('id, order_id, current_position, candidate_count, status')
    .in('status', ['queued', 'advancing'])
    .order('created_at', { ascending: true })
    .limit(freeSlots * 3);

  let started = 0;
  for (const seq of sequences ?? []) {
    if (freeSlots <= 0) break;
    const ok = await originateNextAttempt(seq);
    if (ok) {
      started++;
      freeSlots--;
    }
  }

  return `orchestrator: ${started} started, ${timedOut} timed out, ${backfilled} backfilled, ${inFlight} were in flight`;
}

/**
 * Finds attempts stuck in 'originating'/'in_progress' past the timeout window — the bridge
 * never called back /call-result (crashed, network partition, ARI failure). Without this,
 * a crashed bridge process would permanently stall a sequence and silently eat concurrency
 * budget forever.
 */
async function timeoutStaleAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - ATTEMPT_TIMEOUT_MINUTES * 60 * 1000).toISOString();

  const { data: stale } = await supabaseAdmin
    .from('order_call_attempts')
    .select('id, sequence_id')
    .in('status', ['originating', 'in_progress'])
    .lt('originated_at', cutoff);

  if (!stale?.length) return 0;

  for (const attempt of stale) {
    await supabaseAdmin
      .from('order_call_attempts')
      .update({ status: 'timed_out', outcome: 'no_answer', ended_at: new Date().toISOString() })
      .eq('id', attempt.id);

    await advanceToNextCandidate(attempt.sequence_id);
  }

  return stale.length;
}

export interface SequenceRow {
  id: string;
  order_id: string;
  current_position: number;
  candidate_count: number;
  status: string;
}

/**
 * Originates the next call for a sequence. Re-checks the order is still 'bidding' (otherwise
 * the sequence is cancelled — order was already closed via another channel, e.g. a Telegram
 * bid was accepted first, so calling more people is pointless).
 */
export async function originateNextAttempt(seq: SequenceRow): Promise<boolean> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('status')
    .eq('id', seq.order_id)
    .single();

  if (!order || order.status !== 'bidding') {
    await cancelSequence(seq.id);
    return false;
  }

  const { data: candidate } = await supabaseAdmin
    .from('call_candidates')
    .select('id, phone, preferred_lang')
    .eq('order_id', seq.order_id)
    .eq('rank', seq.current_position)
    .maybeSingle();

  if (!candidate) {
    await exhaustSequence(seq.id, seq.order_id);
    return false;
  }

  const { data: attempt, error } = await supabaseAdmin
    .from('order_call_attempts')
    .insert({
      sequence_id: seq.id,
      order_id: seq.order_id,
      candidate_id: candidate.id,
      position: seq.current_position,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !attempt) {
    console.error('[originateNextAttempt] insert attempt', error?.message);
    return false;
  }

  const result = await originateCall({
    attemptId: attempt.id,
    phone: candidate.phone,
    callerId: TRUNK_CALLER_ID,
  });

  if (!result.ok) {
    // Failed origination doesn't burn a multi-minute wait — advance immediately in this tick.
    await supabaseAdmin
      .from('order_call_attempts')
      .update({ status: 'failed_to_originate', outcome: 'error', ended_at: new Date().toISOString() })
      .eq('id', attempt.id);
    await advanceToNextCandidate(seq.id);
    return false;
  }

  await supabaseAdmin
    .from('order_call_attempts')
    .update({
      status: 'originating',
      asterisk_channel_id: result.channelId,
      originated_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);

  await supabaseAdmin
    .from('order_call_sequences')
    .update({ status: 'calling', updated_at: new Date().toISOString() })
    .eq('id', seq.id);

  return true;
}

/**
 * Safety net for orders whose synchronous candidate-build (in tender/create) failed or was
 * skipped (e.g. a transient Supabase error) — rarely fires, since section 7 builds sequences
 * synchronously at order creation. Bounded to the last 48h to avoid ever retrying ancient orders.
 */
async function backfillMissingSequences(): Promise<number> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const [{ data: orders }, { data: sequences }] = await Promise.all([
    supabaseAdmin
      .from('tender_orders')
      .select('id')
      .eq('status', 'bidding')
      .gte('created_at', cutoff),
    supabaseAdmin.from('order_call_sequences').select('order_id'),
  ]);

  const sequencedOrderIds = new Set((sequences ?? []).map(s => s.order_id));
  const missing = (orders ?? []).filter(o => !sequencedOrderIds.has(o.id));

  let backfilled = 0;
  for (const order of missing) {
    try {
      const { built } = await buildCallCandidates(order.id);
      if (built > 0) {
        const { sequenceId } = await createCallSequence(order.id);
        if (sequenceId) backfilled++;
      }
    } catch (e) {
      console.error('[backfillMissingSequences]', e);
    }
  }

  return backfilled;
}
