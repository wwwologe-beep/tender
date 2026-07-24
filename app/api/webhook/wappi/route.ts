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
      const isMedia = msg.type === 'image' || msg.type === 'video';

      logSystemEvent({
        source: 'webhook',
        tag: 'wappi-webhook.incoming',
        message: isMedia
          ? `Incoming WhatsApp ${msg.type} from ${sender} (${text.length} bytes base64)`
          : `Incoming WhatsApp message from ${sender}: "${text.slice(0, 200)}"`,
        // Never log the raw base64 body — a single photo is hundreds of KB and would bloat
        // system_logs on every send; text.length is enough to confirm data actually arrived.
        data: { sender, textLength: text.length, type: msg.type, isReply: msg.isReply ?? false, quotedText: msg.reply_message?.body },
      });

      // Wappi sends media two different ways depending on the message: sometimes as a
      // downloadable URL (s3Info.url), other times as the raw file inline, base64-encoded,
      // directly in `body` (confirmed via live test — the documented s3Info shape did not
      // show up at all for a real photo reply). Handle both rather than assuming one.
      const s3Url = Array.isArray(msg.s3Info) ? msg.s3Info[0]?.url : msg.s3Info?.url;
      if (isMedia && s3Url) {
        await handleIncomingMedia({ kind: 'url', value: s3Url }, sender, msg.type!);
        continue;
      }
      if (isMedia && text) {
        await handleIncomingMedia({ kind: 'base64', value: text }, sender, msg.type!);
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

type IncomingMedia = { kind: 'url'; value: string } | { kind: 'base64'; value: string };

// Real bucket name in Supabase Storage is "tender-media" (hyphen) — note app/page.tsx's
// own BUCKET constant says "tender_media" (underscore), which doesn't match any real
// bucket; that's a pre-existing mismatch in the form's upload path, left alone here since
// fixing it is out of scope for this webhook change.
const MEDIA_BUCKET = 'tender-media';

/**
 * Клиент прислал фото/видео текущего состояния (в ответ на запрос из tender/create,
 * см. needsMediaCategories) — находим его активный заказ по номеру и дописываем
 * media_urls, чтобы исполнители увидели материал в карточке/фиде.
 */
async function handleIncomingMedia(media: IncomingMedia, sender: string, msgType: string) {
  const senderClean = sender.replace(/^0+/, '');
  if (senderClean.length < 9) return;

  const { data: candidates } = await supabaseAdmin
    .from('tender_orders')
    .select('id, media_urls, client_phone, created_at')
    .not('client_phone', 'is', null)
    .in('status', ['bidding', 'selected'])
    .order('created_at', { ascending: false });

  const matches = (candidates ?? []).filter(o => {
    const phoneClean = (o.client_phone ?? '').replace(/^\+/, '').replace(/^0+/, '');
    return phoneClean.length >= 9 && senderClean.endsWith(phoneClean.slice(-9));
  });
  if (matches.length === 0) return;

  // A client can have several active orders at once — prefer the one still missing media
  // (the most likely target of "please send photos"), most recent first. Only fall back to
  // "most recent order overall" if every match already has media, so a second unrelated
  // photo doesn't silently attach to an already-illustrated order.
  const order = matches.find(o => !Array.isArray(o.media_urls) || o.media_urls.length === 0)
    ?? matches[0];

  let mediaUrl: string;
  if (media.kind === 'url') {
    mediaUrl = media.value;
  } else {
    // Wappi sent the file inline as base64 (no downloadable URL) — upload it to the same
    // Storage bucket the web form uses, so media_urls stays a plain list of https URLs
    // everywhere it's rendered (feed, Telegram card), instead of mixing in raw base64.
    const ext = msgType === 'video' ? 'mp4' : 'jpg';
    const path = `whatsapp/${order.id}-${randomUUID()}.${ext}`;
    const bytes = Buffer.from(media.value, 'base64');
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(MEDIA_BUCKET)
      .upload(path, bytes, { contentType: msgType === 'video' ? 'video/mp4' : 'image/jpeg', upsert: false });
    if (uploadErr) {
      console.error('[wappi webhook] media upload failed:', uploadErr);
      return;
    }
    mediaUrl = supabaseAdmin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
  }

  // Atomic append via RPC (see 20260724_append_order_media_url.sql) — two WhatsApp photos
  // arriving milliseconds apart both used to read the same stale media_urls here and race
  // each other on the UPDATE, silently dropping one (confirmed by a live test: two photos
  // sent, only one ended up saved). A plain read-modify-write in JS can't fix that; the
  // append has to happen inside a single UPDATE on the DB side.
  const { error: appendErr } = await supabaseAdmin.rpc('append_order_media_url', {
    p_order_id: order.id,
    p_media_url: mediaUrl,
  });
  if (appendErr) {
    console.error('[wappi webhook] append_order_media_url failed:', appendErr);
    return;
  }

  await refreshAllCards(order.id).catch(console.error);

  console.log(`[wappi webhook] ✅ Медиа от клиента сохранено к заказу ${order.id}: ${mediaUrl}`);
}

interface WappiWebhook {
  messages?: WappiMessage[];
  message?:  WappiMessage;
}
