import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { InlineKeyboard } from 'grammy';
import { bot } from '@/lib/telegram/bot';
import { buildCard, type CardOrder, type CardDriver, type CardBid } from '@/lib/telegram/card';

export async function POST(req: NextRequest) {
  try {
    const { order_id, order_token, bid_id } = await req.json();
    if ((!order_id && !order_token) || !bid_id) {
      return NextResponse.json({ error: 'order_id (или order_token) и bid_id обязательны' }, { status: 400 });
    }

    const orderQuery = supabaseAdmin
      .from('tender_orders')
      .select('id, order_number, token, status, client_name, client_phone, cargo_description, localized_description, scheduled_at, notes, media_urls, client_budget');
    const { data: order, error: orderError } = await (
      order_id ? orderQuery.eq('id', order_id) : orderQuery.eq('token', order_token)
    ).single();

    if (orderError || !order) {
      return NextResponse.json({ error: 'Заказ не найден' }, { status: 404 });
    }

    // Идемпотентность: если эта же ставка уже победила — вернуть ok
    if (order.status === 'selected') {
      const { data: existingWin } = await supabaseAdmin
        .from('tender_bids').select('id').eq('id', bid_id).eq('status', 'winner').single();
      if (existingWin) return NextResponse.json({ ok: true });
      return NextResponse.json({ error: 'Исполнитель уже выбран' }, { status: 409 });
    }
    if (order.status !== 'bidding') {
      return NextResponse.json({ error: 'Тендер закрыт' }, { status: 400 });
    }

    const { data: winBid } = await supabaseAdmin
      .from('tender_bids')
      .select('driver_id, amount')
      .eq('id', bid_id)
      .single();

    if (!winBid) {
      return NextResponse.json({ error: 'Ставка не найдена' }, { status: 404 });
    }

    const resolvedOrderId = order.id;

    // Атомарное закрытие тендера через RPC — защита от race condition
    const { data: accepted, error: rpcError } = await supabaseAdmin
      .rpc('accept_bid_atomic', { p_order_id: resolvedOrderId, p_bid_id: bid_id });

    if (rpcError) {
      console.error('[accept-bid] rpc error:', rpcError);
      return NextResponse.json({ error: 'Ошибка базы данных' }, { status: 500 });
    }
    if (!accepted) {
      // RPC вернул false — другой запрос успел раньше (race condition)
      return NextResponse.json(
        { error: 'Исполнитель уже был выбран другим запросом', code: 'race_condition' },
        { status: 409 }
      );
    }

    // Запоминаем активный заказ у победителя
    await supabaseAdmin.from('tender_drivers')
      .update({ active_order_id: resolvedOrderId })
      .eq('id', winBid.driver_id);

    // Берём все ставки с данными исполнителей
    const { data: allBids } = await supabaseAdmin
      .from('tender_bids')
      .select('id, status, bot_state, amount, card_type, telegram_message_id, driver_id, tender_drivers(id, telegram_id, name, driver_language)')
      .eq('order_id', resolvedOrderId);

    if (!allBids) return NextResponse.json({ ok: true });

    // Обновляем карточки всех исполнителей через buildCard()
    await Promise.allSettled(
      allBids.map(async (bid) => {
        const driver = (bid.tender_drivers as unknown as { id: string; telegram_id: number; name: string; driver_language: string } | null);
        if (!driver?.telegram_id || !bid.telegram_message_id) return;

        const isWinner = bid.id === bid_id;
        const cardBid: CardBid = {
          amount: bid.amount ?? 0,
          status: bid.status,
          bot_state: isWinner ? 'winner' : 'closed',
        };

        const { text, keyboard } = buildCard(
          order as CardOrder,
          driver as CardDriver,
          cardBid,
          [],
          [],
        );

        const isPhoto = (bid as Record<string, unknown>).card_type === 'photo';
        if (isPhoto) {
          await bot.api.editMessageCaption(
            Number(driver.telegram_id),
            Number(bid.telegram_message_id),
            { caption: text.slice(0, 1024), reply_markup: keyboard },
          ).catch(() => {});
        } else {
          await bot.api.editMessageText(
            Number(driver.telegram_id),
            Number(bid.telegram_message_id),
            text,
            { reply_markup: keyboard },
          ).catch(() => {});
        }

        // Проигравшим — короткое уведомление
        if (!isWinner) {
          const lang = (driver.driver_language ?? 'ru') as string;
          const loseMsgs: Record<string, string> = {
            ru: '😔 На этот раз выбрали другого исполнителя. Не расстраивайтесь — новые заказы уже скоро!',
            ka: '😔 ამჯერად სხვა შემსრულებელი აირჩიეს. ნუ დარდობთ — ახალი შეკვეთები მალე იქნება!',
            en: '😔 Another executor was selected this time. Don\'t worry — new orders are coming soon!',
          };
          await bot.api.sendMessage(Number(driver.telegram_id), loseMsgs[lang] ?? loseMsgs.ru).catch(() => {});
        }

        // Победителю — дополнительные кнопки управления заказом
        if (isWinner) {
          const lang = (driver.driver_language ?? 'ru') as string;
          const btnLabels: Record<string, Record<string, string>> = {
            ru: { chat: '💬 Написать клиенту', complete: '✅ Работа завершена', sos: '⚠️ Форс-мажор' },
            ka: { chat: '💬 კლიენტს დაწერა', complete: '✅ სამუშაო დასრულდა', sos: '⚠️ ფორს-მაჟორი' },
            en: { chat: '💬 Message client', complete: '✅ Work done', sos: '⚠️ Force majeure' },
          };
          const btn = btnLabels[lang] ?? btnLabels.ru;

          const contactLabel: Record<string, string> = {
            ru: '📞 Запросить номер клиента',
            ka: '📞 კლიენტის ნომრის მოთხოვნა',
            en: '📞 Request client number',
          };
          const meetingLabel: Record<string, string> = {
            ru: '📅 Указать время встречи',
            ka: '📅 შეხვედრის დრო',
            en: '📅 Set meeting time',
          };
          const askLabel: Record<string, string> = {
            ru: '❓ Задать вопрос клиенту',
            ka: '❓ კითხვა კლიენტს',
            en: '❓ Ask client a question',
          };
          const actionKeyboard = new InlineKeyboard()
            .text(meetingLabel[lang] ?? meetingLabel.ru, `set_meeting:${resolvedOrderId}`)
            .row()
            .text(btn.chat, `msg_client:${resolvedOrderId}`)
            .row()
            .text(askLabel[lang] ?? askLabel.ru, `ask_question:${resolvedOrderId}`)
            .row()
            .text(contactLabel[lang] ?? contactLabel.ru, `request_contact:${resolvedOrderId}`)
            .row()
            .text(btn.complete, `complete_order:${resolvedOrderId}`)
            .text(btn.sos, `sos_order:${resolvedOrderId}`);

          // Отправляем кнопки управления новым сообщением (карточка остаётся как read-only)
          await bot.api.sendMessage(
            Number(driver.telegram_id),
            lang === 'ka' ? `🎉 თქვენ აირჩიეს! თანხა: ${winBid.amount} ₾`
              : lang === 'en' ? `🎉 You're selected! Price: ${winBid.amount} ₾`
              : `🎉 Вас выбрали! Сумма: ${winBid.amount} ₾`,
            { reply_markup: actionKeyboard }
          ).catch(() => {});
        }
      })
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[accept-bid]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка сервера' }, { status: 500 });
  }
}
