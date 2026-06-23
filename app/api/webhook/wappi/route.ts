import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';

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

      // Ищем код вида msb_XXXXX
      const match = text.match(/msb_[A-Z0-9]{5}/i);
      if (!match) continue;

      const code = match[0].toUpperCase().replace('MSB_', 'msb_');

      // Ищем в БД
      const { data: otpRow } = await supabaseAdmin
        .from('client_otp_codes')
        .select('phone, code, expires_at')
        .eq('code', code)
        .single();

      if (!otpRow) continue;
      if (new Date(otpRow.expires_at) < new Date()) continue;

      // Проверяем что номер отправителя совпадает с номером в заявке
      // Sender из Wappi: "995599001234@c.us" или "995599001234"
      const senderClean   = sender.replace(/^0+/, '');
      const phoneClean    = otpRow.phone.replace(/^\+/, '').replace(/^0+/, '');

      if (!senderClean.endsWith(phoneClean.slice(-9))) {
        console.warn(`[wappi webhook] phone mismatch: sender=${senderClean} code_phone=${phoneClean}`);
        continue;
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

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[wappi webhook]', err);
    return NextResponse.json({ ok: true }); // всегда 200 чтобы Wappi не ретраил
  }
}

interface WappiMessage {
  body?: string;
  author?: string;
  from?: string;
}

interface WappiWebhook {
  messages?: WappiMessage[];
  message?:  WappiMessage;
}
