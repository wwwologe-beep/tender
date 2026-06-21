import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { bot } from '@/lib/telegram/bot';

// POST /api/tender/complete
// Body: { order_id, client_phone, rating: 1-5, review?: string }
export async function POST(req: NextRequest) {
  try {
    const { order_id, client_phone, rating, review } = await req.json();

    if (!order_id || !client_phone) {
      return NextResponse.json({ error: 'order_id и client_phone обязательны' }, { status: 400 });
    }
    if (rating && (rating < 1 || rating > 5)) {
      return NextResponse.json({ error: 'Рейтинг от 1 до 5' }, { status: 400 });
    }

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, token, status, client_phone, cargo_description, category')
      .eq('id', order_id)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (order.client_phone !== client_phone) return NextResponse.json({ error: 'Нет доступа' }, { status: 403 });
    if (order.status !== 'selected') return NextResponse.json({ error: 'Заказ не в статусе selected' }, { status: 400 });

    // Находим победителя
    const { data: winnerBid } = await supabaseAdmin
      .from('tender_bids')
      .select('id, driver_id, amount')
      .eq('order_id', order_id)
      .eq('status', 'winner')
      .single();

    // Завершаем заказ
    await supabaseAdmin
      .from('tender_orders')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        ...(rating ? { client_rating: rating, client_review: review ?? null } : {}),
      })
      .eq('id', order_id);

    // Обновляем рейтинг исполнителя
    if (winnerBid && rating) {
      await updateDriverRating(winnerBid.driver_id, rating, winnerBid.amount, order.category);
    }

    // Learning Agent: сохраняем snapshot рынка по этой категории
    if (winnerBid) {
      await saveMarketSnapshot(order_id, order.category, winnerBid.amount);
    }

    // Уведомляем исполнителя в Telegram
    if (winnerBid) {
      const { data: driver } = await supabaseAdmin
        .from('tender_drivers')
        .select('telegram_id, driver_language, name')
        .eq('id', winnerBid.driver_id)
        .single();

      if (driver?.telegram_id) {
        const msgs: Record<string, string> = {
          ru: `🎉 ${driver.name}, клиент подтвердил завершение!\n\n` +
              `💰 Оплата: ${winnerBid.amount} ₾\n` +
              (rating ? `⭐ Оценка: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)\n` : '') +
              (review ? `💬 "${review}"\n` : '') +
              `\nСпасибо за работу! Ваш рейтинг обновлён.`,
          ka: `🎉 ${driver.name}, კლიენტმა დაადასტურა დასრულება!\n\n💰 ${winnerBid.amount} ₾\n${rating ? `⭐ შეფასება: ${rating}/5\n` : ''}`,
          en: `🎉 ${driver.name}, client confirmed completion!\n\n💰 ${winnerBid.amount} ₾\n${rating ? `⭐ Rating: ${rating}/5\n` : ''}`,
        };
        const lang = driver.driver_language ?? 'ru';
        await bot.api.sendMessage(driver.telegram_id, msgs[lang] ?? msgs.ru).catch(console.error);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[complete]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}

async function updateDriverRating(driverId: string, newRating: number, amount: number, category: string | null) {
  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('rating, completed_orders, total_earned')
    .eq('id', driverId)
    .single();

  if (!driver) return;

  const completed = (driver.completed_orders ?? 0) + 1;
  const prevTotal = (driver.rating ?? 5) * (completed - 1);
  const newAvg = Math.round(((prevTotal + newRating) / completed) * 10) / 10;

  await supabaseAdmin
    .from('tender_drivers')
    .update({
      rating: newAvg,
      completed_orders: completed,
      total_earned: (driver.total_earned ?? 0) + amount,
      last_completed_at: new Date().toISOString(),
    })
    .eq('id', driverId);
}

async function saveMarketSnapshot(orderId: string, category: string | null, finalPrice: number) {
  // Собираем все ставки по этому заказу для анализа
  const { data: allBids } = await supabaseAdmin
    .from('tender_bids')
    .select('amount')
    .eq('order_id', orderId)
    .gt('amount', 0)
    .neq('status', 'withdrawn');

  const amounts = (allBids ?? []).map(b => b.amount);
  if (amounts.length === 0) return;

  const avg = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);

  await supabaseAdmin.from('market_snapshots').insert({
    order_id: orderId,
    category: category ?? 'general',
    final_price: finalPrice,
    avg_bid: avg,
    min_bid: min,
    max_bid: max,
    bid_count: amounts.length,
  });

}
