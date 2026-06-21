import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/questions/list?order_id=&driver_id=&role=client|driver
// Blind логика: driver видит только свои вопросы, client видит все
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const order_id = searchParams.get('order_id');
  const driver_id = searchParams.get('driver_id');
  const role = searchParams.get('role') ?? 'client';

  if (!order_id) return NextResponse.json({ error: 'order_id обязателен' }, { status: 400 });

  let query = supabaseAdmin
    .from('order_questions')
    .select(`
      id, question_original, question_lang, question_translated,
      answer_original, answer_lang, answer_translated,
      answered_by, status, created_at, answered_at,
      driver_id,
      tender_drivers(name, driver_language)
    `)
    .eq('order_id', order_id)
    .order('created_at', { ascending: true });

  // Blind логика — исполнитель видит только свои вопросы
  if (role === 'driver' && driver_id) {
    query = query.eq('driver_id', driver_id);
  }

  const { data, error } = await query;

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ questions: data ?? [] });
}
