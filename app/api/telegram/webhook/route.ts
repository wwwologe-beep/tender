import { NextRequest, NextResponse } from 'next/server';
import { webhookCallback } from 'grammy';
import { bot } from '@/lib/telegram/bot';

const handler = webhookCallback(bot, 'std/http');

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== process.env.TELEGRAM_SECRET_TOKEN) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  return handler(req);
}
