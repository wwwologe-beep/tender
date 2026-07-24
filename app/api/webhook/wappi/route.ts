import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { translateFaqAnswer } from '@/lib/ai';
import { rebuildOrderFaq } from '@/lib/ai-advisor';
import { refreshAllCards } from '@/lib/telegram/card';
import { resolveClarificationAndRequeue } from '@/lib/orchestrator/clarification';
import { logSystemEvent } from '@/lib/system-log';

// POST /api/webhook/wappi
// Wappi отправляет сюда входящие сообщения WhatsApp
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as WappiWebhook;

    // Wappi присылает массив messages или одно сообщение
    const messages = Array.isArray(body.messages) ? body.messages : (body.message ? [body.message] : []);

    for (const msg of messages) {
      const text   = (msg.body ?? '').trim();
      const sender = (msg.author ?? msg.from ?? '').replace(/[^0-9]/g, '');

      logSystemEvent({
        source: 'webhook',
        tag: 'wappi-webhook.incoming',
        message: `Incoming WhatsApp message from ${sender}: "${text.slice(0, 200)}"`,
        data: { sender, text, type: msg.type, isReply: msg.isReply ?? false, quotedText: msg.reply_message?.body },
      });

      // Фото/видео (mimetype/s3Info присутствуют у медиа-сообщений) — сохраняем к
      // активному заказу этого номера, не трактуя как текстовый ответ на вопрос.
      const mediaUrl = Array.isArray(msg.s3Info) ? msg.s3Info[0]?.url : msg.s3Info?.url;
      if ((msg.type === 'image' || msg.type === 'video') && mediaUrl) {
        await handleIncomingMedia(mediaUrl, sender);
        continue;
      }

      // Ищем код вида msb_XXXXX
      const match = text.match(/msb_[A-Z0-9]{5}/i);
      if (match) {
        await handleOtpCode(match[0], sender);
        continue;
      }

      // Не OTP-код — если у этого номера есть неотвеченный вопрос от исполнителя (клиент был
      // об этом уведомлён этим же каналом, см. notifyClientWhatsApp в questions/ask и
      // orchestrator/ask-question), трактуем текст как прямой ответ на него — так клиенту не
      // обязательно открывать сайт, чтобы ответить. If the client used WhatsApp's native
      // "reply" (swipe-to-quote) on the question message, msg.reply_message.body carries the
      // exact original question text — a precise match, not a guess, even with several
      // active orders at once. Falls back to "this phone's single most recent pending
      // question" only when there's no quoted message (typical for a client with one order).
      await handlePendingQuestionAnswer(text, sender, msg.reply_message?.body);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[wappi webhook]', err);
    return NextResponse.json({ ok: true }); // всегда 200 чтобы Wappi не ретраил
  }
}

async function handleOtpCode(rawCode: string, sender: string) {
  const code = rawCode.toUpperCase().replace('MSB_', 'msb_');

  const { data: otpRow } = await supabaseAdmin
    .from('client_otp_codes')
    .select('phone, code, expires_at')
    .eq('code', code)
    .single();

  if (!otpRow) return;
  if (new Date(otpRow.expires_at) < new Date()) return;

  // Проверяем что номер отправителя совпадает с номером в заявке
  // Sender из Wappi: "995599001234@c.us" или "995599001234"
  const senderClean = sender.replace(/^0+/, '');
  const phoneClean  = otpRow.phone.replace(/^\+/, '').replace(/^0+/, '');

  if (!senderClean.endsWith(phoneClean.slice(-9))) {
    console.warn(`[wappi webhook] phone mismatch: sender=${senderClean} code_phone=${phoneClean}`);
    return;
  }

  // Удаляем использованный код
  await supabaseAdmin.from('client_otp_codes').delete().eq('code', code);

  // Создаём сессию
  const token = randomUUID();
  await supabaseAdmin
    .from('tender_clients')
    .upsert(
      { phone: otpRow.phone, session_token: token, last_login: new Date().toISOString() },
      { onConflict: 'phone' }
    );

  console.log(`[wappi webhook] ✅ Авторизован ${otpRow.phone} → token ${token.slice(0, 8)}...`);
}

/**
 * Matches the incoming sender's phone against tender_orders.client_phone (same suffix-match
 * approach as handleOtpCode, since Wappi's sender format doesn't always include the leading
 * "+") to find that client's pending question, then answers it exactly the same way POST
 * /api/questions/answer does (translation, card refresh, FAQ rebuild, clarification requeue)
 * — this is a second entry point into the same answer path, not a parallel one, so both
 * channels stay consistent.
 *
 * Disambiguation when a client has more than one order with a pending question: if they used
 * WhatsApp's native reply/quote on the question notification, quotedText carries that
 * notification's exact original text (see notifyClientWhatsApp's `"${questionRu}"` line in
 * questions/ask and orchestrator/ask-question) — match against that first. Only fall back to
 * "this phone's single most recent pending question" when there's no quote, which is
 * correct exactly in the common case of one active order.
 */
async function handlePendingQuestionAnswer(text: string, sender: string, quotedText?: string) {
  if (!text) return;
  const senderClean = sender.replace(/^0+/, '');
  if (senderClean.length < 9) return;

  const { data: candidates } = await supabaseAdmin
    .from('tender_orders')
    .select('id, client_phone')
    .not('client_phone', 'is', null);

  const matchingOrderIds = (candidates ?? [])
    .filter(o => {
      const phoneClean = (o.client_phone ?? '').replace(/^\+/, '').replace(/^0+/, '');
      return phoneClean.length >= 9 && senderClean.endsWith(phoneClean.slice(-9));
    })
    .map(o => o.id);
  if (matchingOrderIds.length === 0) return;

  const { data: pendingQuestions } = await supabaseAdmin
    .from('order_questions')
    .select('id, order_id, question_original')
    .in('order_id', matchingOrderIds)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (!pendingQuestions || pendingQuestions.length === 0) return;

  // Precise match via WhatsApp reply-quote: the quoted notification contains the question
  // text wrapped in quotes, so a substring check is enough (no need to parse the template).
  const question = quotedText
    ? pendingQuestions.find(q => quotedText.includes(q.question_original)) ?? pendingQuestions[0]
    : pendingQuestions[0];

  if (!question) return;

  const { data: fullOrder } = await supabaseAdmin
    .from('tender_orders')
    .select('id, clarification_status, missing_info')
    .eq('id', question.order_id)
    .single();

  const translated = await translateFaqAnswer(text, 'ru');

  await supabaseAdmin
    .from('order_questions')
    .update({
      answer_original: text,
      answer_lang: 'ru',
      answer_translated: translated,
      answered_by: 'client',
      status: 'answered',
      answered_at: new Date().toISOString(),
    })
    .eq('id', question.id);

  await refreshAllCards(question.order_id).catch(console.error);
  await rebuildOrderFaq(question.order_id).catch(console.error);

  if (fullOrder?.clarification_status === 'clarifying' && fullOrder.missing_info === question.question_original) {
    await resolveClarificationAndRequeue(question.order_id, question.id, text).catch(console.error);
  }

  console.log(`[wappi webhook] ✅ Ответ на вопрос "${question.question_original}" получен через WhatsApp: "${text}"`);
}

interface WappiMessage {
  body?: string;
  author?: string;
  from?: string;
  isReply?: boolean;
  reply_message?: { body?: string };
  type?: string;
  s3Info?: { url?: string } | { url?: string }[];
}

/**
 * Клиент прислал фото/видео текущего состояния (в ответ на запрос из tender/create,
 * см. needsMediaCategories) — находим его активный заказ по номеру и дописываем
 * media_urls, чтобы исполнители увидели материал в карточке/фиде.
 */
async function handleIncomingMedia(mediaUrl: string, sender: string) {
  const senderClean = sender.replace(/^0+/, '');
  if (senderClean.length < 9) return;

  const { data: candidates } = await supabaseAdmin
    .from('tender_orders')
    .select('id, media_urls, client_phone')
    .not('client_phone', 'is', null)
    .in('status', ['bidding', 'selected']);

  const order = (candidates ?? []).find(o => {
    const phoneClean = (o.client_phone ?? '').replace(/^\+/, '').replace(/^0+/, '');
    return phoneClean.length >= 9 && senderClean.endsWith(phoneClean.slice(-9));
  });
  if (!order) return;

  const existing = Array.isArray(order.media_urls) ? order.media_urls : [];
  await supabaseAdmin
    .from('tender_orders')
    .update({ media_urls: [...existing, mediaUrl] })
    .eq('id', order.id);

  await refreshAllCards(order.id).catch(console.error);

  console.log(`[wappi webhook] ✅ Медиа от клиента сохранено к заказу ${order.id}: ${mediaUrl}`);
}

interface WappiWebhook {
  messages?: WappiMessage[];
  message?:  WappiMessage;
}
