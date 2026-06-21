import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { translateChatMessage } from '@/lib/ai';

// POST /api/messages/send
// Body: { order_id, sender_role: 'client'|'driver', sender_id, text, lang? }
export async function POST(req: NextRequest) {
  try {
    const { order_id, sender_role, sender_id, text, lang = 'ru' } = await req.json();

    if (!order_id || !sender_role || !sender_id || !text?.trim()) {
      return NextResponse.json({ error: 'order_id, sender_role, sender_id, text обязательны' }, { status: 400 });
    }
    if (!['client', 'driver'].includes(sender_role)) {
      return NextResponse.json({ error: 'sender_role должен быть client или driver' }, { status: 400 });
    }

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, token, status, executor_id, client_phone')
      .eq('id', order_id)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });

    const senderLang = (lang as 'ru' | 'ka' | 'en') ?? 'ru';

    // Переводим перед сохранением
    let translatedText: string = text.trim();
    let recipientLang: 'ru' | 'ka' | 'en' = 'ru';

    if (sender_role === 'client') {
      recipientLang = await getDriverLang(order.executor_id);
      translatedText = await translateChatMessage(text.trim(), senderLang, recipientLang);
    } else {
      // Исполнитель → клиент всегда на русском
      recipientLang = 'ru';
      translatedText = await translateChatMessage(text.trim(), senderLang, 'ru');
    }

    const { data: msg, error } = await supabaseAdmin
      .from('order_messages')
      .insert({
        order_id,
        sender_role,
        sender_id,
        text: text.trim(),
        translated_text: translatedText,
        sender_lang: senderLang,
      })
      .select('id, created_at')
      .single();

    if (error) {
      console.error('[messages/send]', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Уведомляем получателя с переводом
    if (sender_role === 'client') {
      await notifyDriver(order.executor_id, translatedText, text.trim(), order.token, order_id).catch(console.error);
    } else {
      await notifyClient(order.client_phone, translatedText, text.trim(), order.token).catch(console.error);
    }

    return NextResponse.json({ ok: true, message_id: msg!.id });
  } catch (err) {
    console.error('[messages/send]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}

async function getDriverLang(executorId: string | null): Promise<'ru' | 'ka' | 'en'> {
  if (!executorId) return 'ru';
  const { data } = await supabaseAdmin
    .from('tender_drivers')
    .select('driver_language')
    .eq('id', executorId)
    .single();
  return (data?.driver_language as 'ru' | 'ka' | 'en') ?? 'ru';
}

async function notifyDriver(executorId: string | null, translatedText: string, originalText: string, orderToken: string, orderId?: string) {
  if (!executorId) return;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('telegram_chat_id, driver_language')
    .eq('id', executorId)
    .single();

  if (!driver?.telegram_chat_id) return;

  const url = `https://mushebi.ge/feed/${orderToken}`;
  const lang = driver.driver_language ?? 'ru';
  const prefix: Record<string, string> = {
    ru: '💬 Заказчик написал вам',
    ka: '💬 კლიენტი მოგწერათ',
    en: '💬 Client sent you a message',
  };

  const showOriginal = translatedText !== originalText;
  const text =
    `${prefix[lang] ?? prefix.ru}:\n\n` +
    `"${translatedText}"` +
    (showOriginal ? `\n_(ориг: "${originalText}")_` : '');

  const replyBtn = lang === 'ka' ? '✏️ უპასუხე' : lang === 'en' ? '✏️ Reply' : '✏️ Ответить';
  const keyboard = orderId
    ? { inline_keyboard: [[{ text: replyBtn, callback_data: `msg_client:${orderId}` }]] }
    : undefined;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: driver.telegram_chat_id, text, parse_mode: 'Markdown', reply_markup: keyboard }),
  });
}

async function notifyClient(clientPhone: string | null, translatedText: string, originalText: string, orderToken: string) {
  if (!clientPhone) return;
  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return;

  const url = `https://mushebi.ge/tender/order/${orderToken}`;
  const showOriginal = translatedText !== originalText;
  const msg =
    `💬 Исполнитель написал вам:\n\n"${translatedText}"` +
    (showOriginal ? `\n(ориг: "${originalText}")` : '') +
    `\n\nОткройте заказ: ${url}`;

  await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
    method: 'POST',
    headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: msg, recipient: clientPhone.replace('+', '') }),
  });
}
