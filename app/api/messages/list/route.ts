import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/messages/list?order_id=&viewer_role=client|driver
export async function GET(req: NextRequest) {
  const order_id = req.nextUrl.searchParams.get('order_id');
  const viewer_role = req.nextUrl.searchParams.get('viewer_role') ?? 'client';

  if (!order_id) return NextResponse.json({ error: 'order_id обязателен' }, { status: 400 });

  const { data, error } = await supabaseAdmin
    .from('order_messages')
    .select('id, sender_role, sender_id, text, translated_text, sender_lang, created_at')
    .eq('order_id', order_id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Каждый видит свои сообщения как оригинал, чужие — в переводе
  const messages = (data ?? []).map(m => ({
    id: m.id,
    sender_role: m.sender_role,
    created_at: m.created_at,
    // Если смотрит клиент: его сообщения = оригинал, сообщения исполнителя = перевод (или оригинал если нет)
    // Если смотрит исполнитель: его сообщения = оригинал, сообщения клиента = перевод
    text: m.sender_role === viewer_role
      ? m.text
      : (m.translated_text ?? m.text),
    original_text: m.sender_role !== viewer_role ? m.text : undefined,
  }));

  return NextResponse.json({ messages });
}
