/**
 * Calls a candidate back with the client's answer to a question they asked mid-call (see
 * PROJECT.md's Client Assistant / clarification_status flow).
 *
 * Unlike confirmation-call.ts's synthetic "confirm:<bidId>" attempt id (a pure one-way
 * notification with no report_outcome), this call is a real continuation of the price
 * negotiation — the driver may now agree, decline, or ask another question — so it needs a
 * real order_call_attempts row for app/api/orchestrator/call-result/route.ts to process the
 * outcome the normal way (create a bid on 'agreed', advance the sequence otherwise). It's
 * attached to the SAME sequence the candidate's original attempt belonged to, at that
 * candidate's original position — not the sequence's current position, which may have already
 * advanced past this candidate while we were waiting on the client's answer.
 *
 * Fired from lib/orchestrator/clarification.ts once a clarifying question is resolved
 * (client answered — on the website, via Telegram, or over a client_bridge.py voice call),
 * regardless of which channel the client used to answer.
 */

import { supabaseAdmin } from '@/lib/supabase';
import { originateCall } from './bridge-client';

const TRUNK_CALLER_ID = process.env.ORCHESTRATOR_CALLER_ID ?? '';

const ANSWER_INTRO: Record<string, string> = {
  ka: (
    'შენ ხარ mushebi.ge-ს ხმოვანი ასისტენტი. რეკავ შემსრულებელს, რომელმაც ადრე ' +
    'დაგისვა კითხვა კონკრეტულ შეკვეთაზე. კლიენტმა უპასუხა — გადაეცი პასუხი მოკლედ ' +
    'და ნათლად: "{question}" — "{answer}". თუ ეს ცვლის ფასს ან ვადებს, განაგრძე ' +
    'საუბარი ჩვეულებრივად და მოძებნე შეთანხმება, ისევე როგორც ჩვეულებრივ ' +
    'შეთავაზების ზარზე. საუბრის ბოლოს აუცილებლად გამოიძახე report_outcome.'
  ),
  en: (
    "You are mushebi.ge's voice assistant. You are calling back a service provider who " +
    'earlier asked a question about a specific order. The client has now answered — relay ' +
    'the answer briefly and clearly: "{question}" — "{answer}". If this changes the price ' +
    'or timing, continue the conversation normally and try to reach an agreement, just like ' +
    'a regular outreach call. Always call report_outcome at the end of the conversation.'
  ),
  ru: (
    'Ты голосовой ассистент mushebi.ge. Перезваниваешь исполнителю, который ранее задал ' +
    'вопрос по конкретному заказу. Клиент ответил — передай ответ коротко и понятно: ' +
    '"{question}" — "{answer}". Если это меняет цену или сроки, продолжай разговор как ' +
    'обычно и постарайся договориться, как на обычном звонке-предложении. В конце ' +
    'разговора обязательно вызови report_outcome.'
  ),
};

function buildAnswerInstructions(question: string, answer: string, lang: string): string {
  const template = ANSWER_INTRO[lang] ?? ANSWER_INTRO.ru;
  return template.replace('{question}', question).replace('{answer}', answer);
}

interface CallBackParams {
  questionId: string;
  question: string;
  answer: string;
}

/**
 * Best-effort — never throws. Looks up the candidate who asked the question (via
 * order_questions.candidate_id) and calls them back. No-op if the question has no
 * candidate_id (e.g. a Telegram-only question with no orchestrator attempt behind it), the
 * candidate has no phone on file, or the candidate's original order_call_attempts row (needed
 * to find which sequence/position to attach this new attempt to) can't be found.
 */
export async function callBackWithAnswer(params: CallBackParams): Promise<void> {
  const { data: question } = await supabaseAdmin
    .from('order_questions')
    .select('candidate_id, order_id')
    .eq('id', params.questionId)
    .single();

  if (!question?.candidate_id) return;

  const [{ data: candidate }, { data: priorAttempt }] = await Promise.all([
    supabaseAdmin
      .from('call_candidates')
      .select('phone, preferred_lang')
      .eq('id', question.candidate_id)
      .single(),
    supabaseAdmin
      .from('order_call_attempts')
      .select('sequence_id, position')
      .eq('candidate_id', question.candidate_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (!candidate?.phone || !priorAttempt) return;

  const { data: attempt, error } = await supabaseAdmin
    .from('order_call_attempts')
    .insert({
      sequence_id: priorAttempt.sequence_id,
      order_id: question.order_id,
      candidate_id: question.candidate_id,
      position: priorAttempt.position,
      status: 'pending',
    })
    .select('id')
    .single();

  if (error || !attempt) {
    console.error('[callBackWithAnswer] insert attempt', error?.message);
    return;
  }

  const lang = candidate.preferred_lang || 'ru';
  const instructions = buildAnswerInstructions(params.question, params.answer, lang);

  const result = await originateCall({
    attemptId: attempt.id,
    phone: candidate.phone,
    callerId: TRUNK_CALLER_ID,
    instructions,
  });

  if (!result.ok) {
    await supabaseAdmin
      .from('order_call_attempts')
      .update({ status: 'failed_to_originate', outcome: 'error', ended_at: new Date().toISOString() })
      .eq('id', attempt.id);
    console.error('[callBackWithAnswer] originate failed', result.error);
    return;
  }

  await supabaseAdmin
    .from('order_call_attempts')
    .update({
      status: 'originating',
      asterisk_channel_id: result.channelId,
      originated_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);
}
