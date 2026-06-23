import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// POST /api/tender/rate
// Body: { order_token, driver_id, stars (1-5) }
export async function POST(req: NextRequest) {
  try {
    const { order_token, driver_id, stars } = await req.json();
    if (!order_token || !driver_id || !stars || stars < 1 || stars > 5) {
      return NextResponse.json({ error: 'order_token, driver_id, stars (1-5) обязательны' }, { status: 400 });
    }

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, status, rated_at, client_rating')
      .eq('token', order_token)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (order.status !== 'completed') return NextResponse.json({ error: 'Заказ не завершён' }, { status: 400 });
    if (order.rated_at) return NextResponse.json({ error: 'Уже оценено' }, { status: 409 });

    // Сохраняем оценку и ставим rated_at — защита от повторного голосования
    await supabaseAdmin
      .from('tender_orders')
      .update({ rated_at: new Date().toISOString(), client_rating: stars })
      .eq('id', order.id);

    // Обновляем рейтинг исполнителя через rating_sum/rating_count
    const { data: driver } = await supabaseAdmin
      .from('tender_drivers')
      .select('rating_sum, rating_count')
      .eq('id', driver_id)
      .single();

    if (driver) {
      const newSum = (driver.rating_sum ?? 0) + stars;
      const newCount = (driver.rating_count ?? 0) + 1;
      await supabaseAdmin
        .from('tender_drivers')
        .update({
          rating_sum: newSum,
          rating_count: newCount,
          rating: Math.round((newSum / newCount) * 100) / 100,
        })
        .eq('id', driver_id);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[rate]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
