import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { bot } from '@/lib/telegram/bot';

// POST /api/tender/meeting-response
// Body: { order_token, action: 'confirm' | 'decline' }
export async function POST(req: NextRequest) {
  try {
    const { order_token, action } = await req.json();
    if (!order_token || !['confirm', 'decline'].includes(action)) {
      return NextResponse.json({ error: 'order_token и action (confirm|decline) обязательны' }, { status: 400 });
    }

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, status, executor_id, meeting_time, order_number, winning_bid_id')
      .eq('token', order_token)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (order.status !== 'selected') return NextResponse.json({ error: 'Заказ не в статусе selected' }, { status: 400 });
    if (!order.meeting_time) return NextResponse.json({ error: 'Время встречи не назначено' }, { status: 400 });

    const { data: driver } = order.executor_id
      ? await supabaseAdmin.from('tender_drivers')
          .select('telegram_id, driver_language, name')
          .eq('id', order.executor_id).single()
      : { data: null };

    if (action === 'confirm') {
      await supabaseAdmin
        .from('tender_orders')
        .update({ meeting_confirmed: true })
        .eq('id', order.id);

      if (driver?.telegram_id) {
        const lang = (driver.driver_language ?? 'ru') as string;
        const time = new Date(order.meeting_time).toLocaleString(
          lang === 'ka' ? 'ka-GE' : lang === 'en' ? 'en-US' : 'ru-RU',
          { timeZone: 'Asia/Tbilisi', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }
        );
        const msgs: Record<string, string> = {
          ru: `✅ Клиент подтвердил встречу!\n\n📅 Время: ${time}\n\nУдачи на заказе #${order.order_number}! 💪`,
          ka: `✅ კლიენტმა შეხვედრა დაადასტურა!\n\n📅 დრო: ${time}\n\nწარმატება შეკვეთა #${order.order_number}-ზე! 💪`,
          en: `✅ Client confirmed the meeting!\n\n📅 Time: ${time}\n\nGood luck on order #${order.order_number}! 💪`,
        };
        await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
      }

      return NextResponse.json({ ok: true });
    }

    // action === 'decline' — возвращаем в bidding
    await supabaseAdmin
      .from('tender_orders')
      .update({ status: 'bidding', winning_bid_id: null, executor_id: null, meeting_time: null, meeting_confirmed: false })
      .eq('id', order.id);

    if (order.winning_bid_id) {
      await supabaseAdmin.from('tender_bids')
        .update({ status: 'lost', bot_state: 'closed' })
        .eq('id', order.winning_bid_id);
    }

    if (driver?.telegram_id) {
      const lang = (driver.driver_language ?? 'ru') as string;
      const msgs: Record<string, string> = {
        ru: `😔 Клиент не сможет принять вас в назначенное время по заказу #${order.order_number}.\n\nЗаказ возвращён в торги — возможно другие исполнители смогут.`,
        ka: `😔 კლიენტი ვერ მიიღებს თქვენ დანიშნულ დროს შეკვეთა #${order.order_number}-ზე.\n\nშეკვეთა ხელახლა გამოვიდა.`,
        en: `😔 Client cannot meet you at the scheduled time for order #${order.order_number}.\n\nOrder returned to bidding.`,
      };
      await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
    }

    // Уведомляем следующего по цене исполнителя
    const { data: nextBid } = await supabaseAdmin
      .from('tender_bids')
      .select('id, driver_id, amount, tender_drivers(telegram_id, driver_language)')
      .eq('order_id', order.id)
      .eq('status', 'pending')
      .gt('amount', 0)
      .order('amount', { ascending: true })
      .limit(1)
      .single();

    if (nextBid) {
      const nd = nextBid.tender_drivers as unknown as { telegram_id: number; driver_language: string } | null;
      if (nd?.telegram_id) {
        const lang = (nd.driver_language ?? 'ru') as string;
        const msgs: Record<string, string> = {
          ru: `🔔 Клиент снова выбирает исполнителя! Ваша ставка ${nextBid.amount} ₾ снова в игре.`,
          ka: `🔔 კლიენტი კვლავ ირჩევს შემსრულებელს! თქვენი შეთავაზება ${nextBid.amount} ₾ ისევ განიხილება.`,
          en: `🔔 Client is choosing again! Your bid of ${nextBid.amount} ₾ is back in play.`,
        };
        await bot.api.sendMessage(Number(nd.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[meeting-response]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
