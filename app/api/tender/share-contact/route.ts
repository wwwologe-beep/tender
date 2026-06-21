import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { bot } from '@/lib/telegram/bot';

// POST /api/tender/share-contact
// Клиент нажал "Поделиться номером" — отправляем телефон победителю в Telegram
export async function POST(req: NextRequest) {
  try {
    const { order_token } = await req.json();
    if (!order_token) return NextResponse.json({ error: 'order_token обязателен' }, { status: 400 });

    const { data: order } = await supabaseAdmin
      .from('tender_orders')
      .select('id, client_phone, client_name, status, winning_bid_id')
      .eq('token', order_token)
      .single();

    if (!order) return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    if (order.status !== 'selected') return NextResponse.json({ error: 'Исполнитель не выбран' }, { status: 400 });
    if (!order.winning_bid_id) return NextResponse.json({ error: 'Нет победителя' }, { status: 400 });

    const { data: winBid } = await supabaseAdmin
      .from('tender_bids')
      .select('driver_id, contact_shared')
      .eq('id', order.winning_bid_id)
      .single();

    if (!winBid) return NextResponse.json({ error: 'Ставка не найдена' }, { status: 404 });

    const { data: driver } = await supabaseAdmin
      .from('tender_drivers')
      .select('telegram_id, driver_language')
      .eq('id', winBid.driver_id)
      .single();

    if (!driver?.telegram_id) return NextResponse.json({ error: 'Исполнитель не найден' }, { status: 404 });

    // Отмечаем что контакт передан
    await supabaseAdmin
      .from('tender_bids')
      .update({ contact_shared: true })
      .eq('id', order.winning_bid_id);

    const lang = (driver.driver_language ?? 'ru') as string;
    const name = order.client_name ?? 'Клиент';
    const phone = order.client_phone ?? '';

    const msgs: Record<string, string> = {
      ru: `📞 Клиент поделился контактом!\n\n👤 Имя: ${name}\n📱 Телефон: ${phone}\n\nСвяжитесь напрямую для уточнения деталей.`,
      ka: `📞 კლიენტმა გაგიზიარათ კონტაქტი!\n\n👤 სახელი: ${name}\n📱 ტელეფონი: ${phone}\n\nდაუკავშირდით პირდაპირ დეტალების გასარკვევად.`,
      en: `📞 Client shared their contact!\n\n👤 Name: ${name}\n📱 Phone: ${phone}\n\nContact them directly to clarify the details.`,
    };

    await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[share-contact]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
