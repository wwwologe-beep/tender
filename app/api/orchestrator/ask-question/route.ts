import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { translateFaqEntry } from '@/lib/ai';
import { sendPush } from '@/lib/push';

/**
 * Fired from asterisk/voice_bridge.py mid-call when the AI's ask_client_question tool is
 * invoked — the voice equivalent of POST /api/questions/ask. Reuses the same downstream
 * pipeline (translation, dedup-free client notification) so a question asked over the phone
 * shows up in /feed/[token] identically to one asked through the Telegram bot.
 *
 * driver_id is nullable on order_questions (migration 20260720_nullable_question_driver_id.sql)
 * specifically so cold_contact candidates — who have no tender_drivers row yet — can still have
 * their voice question show up in /feed/[token]'s Q&A thread, not just as a push/WhatsApp
 * notification. The feed UI doesn't require driver identity to render a question (see
 * app/feed/[token]/page.tsx's questions section), so this needed no UI changes.
 *
 * Two ways to identify the order: the original `attempt_id` path (candidate-outreach calls,
 * has a real order_call_attempts row) or the newer `order_id` + `driver_id` path (a driver
 * calling in directly about their already-active order — see inbound-caller-context/route.ts
 * — there's no attempt/candidate row for this, they're not being called, they called us).
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { attempt_id, order_id, driver_id, question } = await req.json();
  if ((!attempt_id && !order_id) || !question?.trim()) {
    return NextResponse.json({ error: 'attempt_id (or order_id) and question required' }, { status: 400 });
  }

  console.log(`🔧 [voice-call] ask_client_question(attempt_id=${attempt_id ?? 'n/a'}, order_id=${order_id ?? 'n/a'}, question=${JSON.stringify(question)})`);

  let resolvedOrderId: string;
  let resolvedDriverId: string | null;
  let candidateId: string | null = null;
  let preferredLang: string | null = null;

  if (attempt_id) {
    const { data: attempt } = await supabaseAdmin
      .from('order_call_attempts')
      .select('order_id, candidate_id')
      .eq('id', attempt_id)
      .single();
    if (!attempt) {
      return NextResponse.json({ error: 'attempt not found' }, { status: 404 });
    }
    const { data: candidate } = await supabaseAdmin
      .from('call_candidates')
      .select('driver_id, preferred_lang')
      .eq('id', attempt.candidate_id)
      .single();
    if (!candidate) {
      return NextResponse.json({ error: 'candidate not found' }, { status: 404 });
    }
    resolvedOrderId = attempt.order_id;
    resolvedDriverId = candidate.driver_id;
    candidateId = attempt.candidate_id;
    preferredLang = candidate.preferred_lang;
  } else {
    // Driver calling in directly about their active order — driver_language stands in for
    // call_candidates.preferred_lang, since there's no candidate row for this path.
    const { data: driver } = await supabaseAdmin
      .from('tender_drivers')
      .select('driver_language')
      .eq('id', driver_id)
      .single();
    resolvedOrderId = order_id;
    resolvedDriverId = driver_id ?? null;
    preferredLang = driver?.driver_language ?? null;
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, status, cargo_description, live_brief_ai, client_phone, push_subscription, token')
    .eq('id', resolvedOrderId)
    .single();

  // Client Assistant state machine (see PROJECT.md): a driver's ask_client_question puts the
  // order "on pause" for clarification — client_bridge.py reads missing_info later to know what
  // to ask the client. Independent of the tender_orders.status bidding/selected/completed
  // lifecycle, so this write can't collide with it.

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }
  if (!['bidding', 'selected'].includes(order.status)) {
    return NextResponse.json({ error: 'order closed' }, { status: 400 });
  }

  const lang = (preferredLang as 'ru' | 'ka' | 'en') || 'ru';
  const trimmedQuestion = question.trim();
  const context = order.live_brief_ai ?? order.cargo_description ?? '';
  const translated = await translateFaqEntry(trimmedQuestion, lang, context);
  const questionRu = translated?.ru ?? trimmedQuestion;

  console.log(`🗄️  [voice-call] Supabase INSERT -> order_questions (order_id=${order.id}, driver_id=${resolvedDriverId ?? 'null'})`);
  await supabaseAdmin.from('order_questions').insert({
    order_id: order.id,
    driver_id: resolvedDriverId, // null for cold_contact callers — allowed since 20260720
    candidate_id: candidateId, // so we know who to call back once the client answers (attempt_id path only)
    question_original: trimmedQuestion,
    question_lang: lang,
    question_translated: translated,
    status: 'pending',
    answered_by: null,
  });

  await supabaseAdmin
    .from('tender_orders')
    .update({
      clarification_status: 'clarifying',
      missing_info: trimmedQuestion,
      clarification_started_at: new Date().toISOString(),
      clarification_call_attempted_at: null,
    })
    .eq('id', order.id);

  if (order.push_subscription && order.token) {
    await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
      title: '❓ Вопрос по звонку от исполнителя',
      body: questionRu.length > 80 ? questionRu.slice(0, 80) + '...' : questionRu,
      url: `/feed/${order.token}`,
    });
  }

  if (order.client_phone) {
    await notifyClientWhatsApp(order.client_phone, questionRu, order.token ?? '');
  }

  return NextResponse.json({ ok: true });
}

async function notifyClientWhatsApp(phone: string, questionRu: string, token: string) {
  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return;

  // mushebi.ge domain isn't connected yet (see PROJECT.md §4) — using the real prod URL.
  // TODO: same hardcoding exists in several older routes (cron/tick, questions/ask,
  // tender/create, messages/send) — worth a single env-var-based fix across all of them later.
  const base = process.env.NEXT_PUBLIC_APP_URL ?? 'https://tender-navy.vercel.app';
  const url = token ? `${base}/feed/${token}` : `${base}/feed`;
  const text = `📞 Исполнитель задал вопрос по звонку по вашей заявке:\n\n"${questionRu}"\n\nОтветьте здесь: ${url}`;

  await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
    method: 'POST',
    headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: text, recipient: phone.replace('+', '') }),
  }).catch(err => console.error('[orchestrator/ask-question] whatsapp notify', err));
}
