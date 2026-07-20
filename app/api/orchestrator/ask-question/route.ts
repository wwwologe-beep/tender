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
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { attempt_id, question } = await req.json();
  if (!attempt_id || !question?.trim()) {
    return NextResponse.json({ error: 'attempt_id and question required' }, { status: 400 });
  }

  const { data: attempt } = await supabaseAdmin
    .from('order_call_attempts')
    .select('order_id, candidate_id')
    .eq('id', attempt_id)
    .single();

  if (!attempt) {
    return NextResponse.json({ error: 'attempt not found' }, { status: 404 });
  }

  const [{ data: order }, { data: candidate }] = await Promise.all([
    supabaseAdmin
      .from('tender_orders')
      .select('id, status, cargo_description, live_brief_ai, client_phone, push_subscription, token')
      .eq('id', attempt.order_id)
      .single(),
    supabaseAdmin
      .from('call_candidates')
      .select('driver_id, preferred_lang')
      .eq('id', attempt.candidate_id)
      .single(),
  ]);

  // Client Assistant state machine (see PROJECT.md): a driver's ask_client_question puts the
  // order "on pause" for clarification — client_bridge.py reads missing_info later to know what
  // to ask the client. Independent of the tender_orders.status bidding/selected/completed
  // lifecycle, so this write can't collide with it.

  if (!order || !candidate) {
    return NextResponse.json({ error: 'order or candidate not found' }, { status: 404 });
  }
  if (!['bidding', 'selected'].includes(order.status)) {
    return NextResponse.json({ error: 'order closed' }, { status: 400 });
  }

  const lang = (candidate.preferred_lang as 'ru' | 'ka' | 'en') || 'ru';
  const trimmedQuestion = question.trim();
  const context = order.live_brief_ai ?? order.cargo_description ?? '';
  const translated = await translateFaqEntry(trimmedQuestion, lang, context);
  const questionRu = translated?.ru ?? trimmedQuestion;

  await supabaseAdmin.from('order_questions').insert({
    order_id: order.id,
    driver_id: candidate.driver_id, // null for cold_contact callers — allowed since 20260720
    question_original: trimmedQuestion,
    question_lang: lang,
    question_translated: translated,
    status: 'pending',
    answered_by: null,
  });

  await supabaseAdmin
    .from('tender_orders')
    .update({ clarification_status: 'clarifying', missing_info: trimmedQuestion })
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
