import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { translateFaqEntry } from '@/lib/ai';
import { sendPush } from '@/lib/push';

// POST /api/questions/ask
// Body: { order_id, driver_id, question, lang }
export async function POST(req: NextRequest) {
  try {
    const { order_id, driver_id, question, lang = 'ru' } = await req.json();

    if (!order_id || !driver_id || !question?.trim()) {
      return NextResponse.json({ error: 'order_id, driver_id, question обязательны' }, { status: 400 });
    }

    // Проверяем что заказ существует и в статусе bidding
    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, status, cargo_description, live_brief_ai, client_phone, push_subscription, token')
      .eq('id', order_id)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (!['bidding', 'selected'].includes(order.status)) {
      return NextResponse.json({ error: 'Заказ закрыт' }, { status: 400 });
    }

    // Проверяем нет ли уже точно такого вопроса от этого исполнителя
    const { data: existing } = await supabaseAdmin
      .from('order_questions')
      .select('id')
      .eq('order_id', order_id)
      .eq('driver_id', driver_id)
      .eq('question_original', question.trim())
      .single();

    if (existing) {
      return NextResponse.json({ error: 'Вы уже задали этот вопрос' }, { status: 409 });
    }

    // Сохраняем вопрос сразу (без перевода) чтобы не блокировать ответ
    const { data: questionRow, error: insertError } = await supabaseAdmin
      .from('order_questions')
      .insert({
        order_id,
        driver_id,
        question_original: question.trim(),
        question_lang: lang,
        status: 'pending',
        answered_by: 'pending',
      })
      .select('id')
      .single();

    if (insertError || !questionRow) {
      return NextResponse.json({ error: 'Ошибка сохранения вопроса' }, { status: 500 });
    }

    // await — Vercel убивает фоновые задачи после отправки ответа
    await processQuestion(questionRow.id, order_id, driver_id, question.trim(), lang as 'ru' | 'ka' | 'en', order).catch(
      (err) => console.error('[questions/ask] processQuestion error:', err)
    );

    return NextResponse.json({ ok: true, question_id: questionRow.id }, { status: 201 });
  } catch (err) {
    console.error('[questions/ask]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}

async function processQuestion(
  questionId: string,
  orderId: string,
  driverId: string,
  question: string,
  lang: 'ru' | 'ka' | 'en',
  order: { cargo_description: string | null; live_brief_ai: string | null; client_phone: string | null; push_subscription?: unknown; token?: string }
) {
  const context = order.live_brief_ai ?? order.cargo_description ?? '';

  // 1. Переводим вопрос на все языки
  const translated = await translateFaqEntry(question, lang, context);

  // 2. Проверяем дедупликацию — похожий вопрос уже отвечен?
  const { data: answeredQuestions } = await supabaseAdmin
    .from('order_questions')
    .select('id, question_translated, answer_original, answer_translated, answer_lang')
    .eq('order_id', orderId)
    .eq('status', 'answered')
    .neq('driver_id', driverId);

  let autoAnswer: { original: string; translated: Record<string, string>; lang: string } | null = null;

  if (answeredQuestions && answeredQuestions.length > 0 && translated) {
    // Простая дедупликация: если вопрос на том же языке совпадает по смыслу
    // используем AI для проверки или простое сравнение ключевых слов
    for (const aq of answeredQuestions) {
      if (!aq.answer_original) continue;
      const existingQ = (aq.question_translated as Record<string, string> | null)?.[lang] ?? '';
      const similarity = computeSimilarity(question.toLowerCase(), existingQ.toLowerCase());
      if (similarity > 0.6) {
        autoAnswer = {
          original: aq.answer_original,
          translated: (aq.answer_translated as Record<string, string>) ?? {},
          lang: aq.answer_lang ?? 'ru',
        };
        break;
      }
    }
  }

  if (autoAnswer) {
    // Дедупликация сработала — отвечаем автоматически
    await supabaseAdmin
      .from('order_questions')
      .update({
        question_translated: translated,
        answer_original: autoAnswer.original,
        answer_lang: autoAnswer.lang,
        answer_translated: autoAnswer.translated,
        answered_by: 'ai',
        status: 'answered',
        answered_at: new Date().toISOString(),
      })
      .eq('id', questionId);

    console.log(`[questions/ask] Auto-answered question ${questionId} via dedup`);
    return;
  }

  // Нет автоответа — обновляем перевод и уведомляем клиента
  await supabaseAdmin
    .from('order_questions')
    .update({ question_translated: translated })
    .eq('id', questionId);

  // Push уведомление клиенту в браузер
  if (order.push_subscription && order.token) {
    const questionRu = translated?.ru ?? question;
    await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
      title: '❓ Новый вопрос по заявке',
      body: questionRu.length > 80 ? questionRu.slice(0, 80) + '...' : questionRu,
      url: `/feed/${order.token}`,
    });
  }

  // Уведомление клиенту в WhatsApp
  if (order.client_phone) {
    await notifyClientWhatsApp(order.client_phone, question, translated?.ru ?? question, orderId);
  }
}

// Простое косинусное подобие на уровне слов
function computeSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let common = 0;
  wordsA.forEach(w => { if (wordsB.has(w)) common++; });
  return common / Math.max(wordsA.size, wordsB.size);
}

async function notifyClientWhatsApp(phone: string, questionOriginal: string, questionRu: string, orderId: string) {
  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('token')
    .eq('id', orderId)
    .single();

  const url = order ? `https://mushebi.ge/feed/${order.token}` : 'https://mushebi.ge/feed';
  const text = `❓ Исполнитель задал вопрос по вашей заявке:\n\n"${questionRu}"\n\nОтветьте здесь: ${url}`;

  await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
    method: 'POST',
    headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: text, recipient: phone.replace('+', '') }),
  }).catch(err => console.error('[notifyClientWhatsApp]', err));
}
