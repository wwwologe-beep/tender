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
import { callBackWithAnswer } from './answer-callback';

/**
 * Marks an order 'ready' (clears missing_info), calls back whoever asked the resolved question
 * with the client's answer, and re-enters the order into the driver call queue. Safe to call
 * even if the order isn't actually 'clarifying' — a no-op update in that case, callers are
 * expected to check clarification_status themselves first when it matters (e.g.
 * questions/answer/route.ts only calls this for the specific question that was blocking).
 *
 * questionId is optional because not every caller has it up front (client_bridge.py's
 * clarification-result callback only knows order_id) — when omitted, this looks up the most
 * recent pending question on the order, which is the one that set missing_info in the first
 * place (see ask-question/route.ts).
 */
export async function resolveClarificationAndRequeue(
  orderId: string,
  questionId?: string,
  answer?: string
): Promise<void> {
  await supabaseAdmin
    .from('tender_orders')
    .update({
      clarification_status: 'ready',
      missing_info: null,
      clarification_started_at: null,
      clarification_call_attempted_at: null,
    })
    .eq('id', orderId);

  await callBackDriverWithAnswer(orderId, questionId, answer);
  await requeueForDriverCalls(orderId);
}

async function callBackDriverWithAnswer(
  orderId: string,
  questionId?: string,
  answerOverride?: string
): Promise<void> {
  try {
    const { data: question } = questionId
      ? await supabaseAdmin
          .from('order_questions')
          .select('id, question_original, answer_original')
          .eq('id', questionId)
          .single()
      : await supabaseAdmin
          .from('order_questions')
          .select('id, question_original, answer_original')
          .eq('order_id', orderId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

    const answer = answerOverride ?? question?.answer_original;
    if (!question || !answer?.trim()) return;

    await callBackWithAnswer({
      questionId: question.id,
      question: question.question_original,
      answer,
    });
  } catch (e) {
    console.error('[clarification/callBackDriverWithAnswer]', e, { orderId });
  }
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
