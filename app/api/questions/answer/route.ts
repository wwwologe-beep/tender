import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { translateFaqAnswer } from '@/lib/ai';
import { rebuildOrderFaq } from '@/lib/ai-advisor';
import { refreshAllCards } from '@/lib/telegram/card';

// POST /api/questions/answer
// Body: { question_id, answer, lang, client_phone }
export async function POST(req: NextRequest) {
  try {
    const { question_id, answer, lang = 'ru', client_phone } = await req.json();

    if (!question_id || !answer?.trim()) {
      return NextResponse.json({ error: 'question_id и answer обязательны' }, { status: 400 });
    }
    if (!client_phone) {
      return NextResponse.json({ error: 'client_phone обязателен' }, { status: 400 });
    }

    const { data: question } = await supabaseAdmin
      .from('order_questions')
      .select('id, order_id, driver_id, question_original, question_lang, status')
      .eq('id', question_id)
      .single();

    if (!question) return NextResponse.json({ error: 'Вопрос не найден' }, { status: 404 });
    if (question.status === 'answered') return NextResponse.json({ error: 'Уже отвечено' }, { status: 409 });

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, token, client_phone, cargo_description, live_brief_ai')
      .eq('id', question.order_id)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (client_phone && order.client_phone !== client_phone) {
      return NextResponse.json({ error: 'Нет доступа' }, { status: 403 });
    }

    const translated = await translateFaqAnswer(answer.trim(), lang as 'ru' | 'ka' | 'en');

    await supabaseAdmin
      .from('order_questions')
      .update({
        answer_original: answer.trim(),
        answer_lang: lang,
        answer_translated: translated,
        answered_by: 'client',
        status: 'answered',
        answered_at: new Date().toISOString(),
      })
      .eq('id', question_id);

    // Обновляем карточки всех исполнителей параллельно через card.ts
    await refreshAllCards(order.id).catch(console.error);

    // Пересобираем FAQ и live_brief_ai
    await rebuildOrderFaq(order.id).catch(console.error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[questions/answer]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
