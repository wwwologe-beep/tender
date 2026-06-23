import { NextRequest, NextResponse } from 'next/server';
import { webhookCallback } from 'grammy';
import { bot } from '@/lib/telegram/bot';

const handler = webhookCallback(bot, 'std/http');

// Поддерживаем оба имени — исходное и стандартное из документации Telegram
const EXPECTED_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET ?? process.env.TELEGRAM_SECRET_TOKEN;

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (EXPECTED_SECRET && secret !== EXPECTED_SECRET) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    return await handler(req);
  } catch (err) {
    // grammy бросает если Telegram API недоступен или callback_query_id невалиден.
    // Telegram требует 200 OK в любом случае, иначе будет ретраить запрос.
    console.error('[webhook] grammy error:', err);
    return new NextResponse('OK', { status: 200 });
  }
}
