import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { bot } from '@/lib/telegram/bot';
import { advanceCallSequences } from '@/lib/orchestrator/tick';
import { originateClarificationCall } from '@/lib/orchestrator/client-bridge-client';

// Vercel Cron: каждые 10 минут
// Выполняет 3 задачи: nudge, напоминание клиенту, таймаут selected

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: string[] = [];

  await Promise.allSettled([
    nudgeDrivers().then(r => results.push(r)),
    remindClientToChoose().then(r => results.push(r)),
    timeoutSelectedOrders().then(r => results.push(r)),
    resetStuckBotStates().then(r => results.push(r)),
    remindMeeting().then(r => results.push(r)),
    requestRatings().then(r => results.push(r)),
    advanceCallSequences().then(r => results.push(r)),
    callClientsForClarification().then(r => results.push(r)),
    sendMediaThanks().then(r => results.push(r)),
  ]);

  console.log('[cron/tick]', results.join(' | '));
  return NextResponse.json({ ok: true, results });
}

// ─── 1. Nudge: заказ без ставок > 15 минут → пуш всем исполнителям ────────────

async function nudgeDrivers(): Promise<string> {
  const THRESHOLD = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, cargo_description, localized_description, nudge_sent_at')
    .eq('status', 'bidding')
    .lt('bidding_started_at', THRESHOLD);

  if (!orders?.length) return 'nudge: 0 orders';

  const { data: drivers } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, telegram_id, driver_language')
    .eq('status', 'active')
    .not('telegram_id', 'is', null);

  if (!drivers?.length) return 'nudge: no drivers';

  let nudged = 0;

  for (const order of orders) {
    // Не чаще раза в час на один заказ
    if (order.nudge_sent_at) {
      const lastNudge = new Date(order.nudge_sent_at).getTime();
      if (Date.now() - lastNudge < 60 * 60 * 1000) continue;
    }

    // Проверяем что ставок нет вообще
    const { count } = await supabaseAdmin
      .from('tender_bids')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', order.id)
      .gt('amount', 0);

    if ((count ?? 0) > 0) continue;

    const localized = order.localized_description as Record<string, string> | null;

    for (const driver of drivers) {
      const lang = (driver.driver_language ?? 'ru') as string;
      const desc = localized?.[lang] ?? localized?.ru ?? order.cargo_description ?? 'Заказ';
      const msgs: Record<string, string> = {
        ru: `🔔 Заказ #${order.order_number} ещё ждёт предложений!\n\n📋 ${desc.slice(0, 120)}\n\nБудьте первым — сделайте ставку.`,
        ka: `🔔 შეკვეთა #${order.order_number} ჯერ კიდევ ელოდება შეთავაზებებს!\n\n📋 ${desc.slice(0, 120)}\n\nიყავი პირველი — გააკეთე შეთავაზება.`,
        en: `🔔 Order #${order.order_number} still waiting for bids!\n\n📋 ${desc.slice(0, 120)}\n\nBe first — place a bid.`,
      };
      await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
    }

    await supabaseAdmin
      .from('tender_orders')
      .update({ nudge_sent_at: new Date().toISOString() })
      .eq('id', order.id);

    nudged++;
  }

  return `nudge: ${nudged} orders nudged`;
}

// ─── 2. Напоминание клиенту выбрать исполнителя (ставки есть > 1 часа) ────────

async function remindClientToChoose(): Promise<string> {
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, token, client_phone, client_remind_sent_at, push_subscription')
    .eq('status', 'bidding')
    .lt('bidding_started_at', ONE_HOUR_AGO);

  if (!orders?.length) return 'remind: 0 orders';

  let reminded = 0;

  for (const order of orders) {
    // Не чаще раза в 3 часа на заказ
    if (order.client_remind_sent_at) {
      const last = new Date(order.client_remind_sent_at).getTime();
      if (Date.now() - last < 3 * 60 * 60 * 1000) continue;
    }

    // Проверяем что ставки есть
    const { count } = await supabaseAdmin
      .from('tender_bids')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', order.id)
      .eq('status', 'pending')
      .gt('amount', 0);

    if ((count ?? 0) === 0) continue;

    const url = `https://mushebi.ge/feed/${order.token}`;

    // WhatsApp
    const wappiToken = process.env.WAPPI_TOKEN;
    const wappiProfile = process.env.WAPPI_PROFILE_ID;
    if (wappiToken && wappiProfile && order.client_phone) {
      const text = `⏰ По вашей заявке #${order.order_number} уже есть предложения от исполнителей!\n\nВыберите лучшее здесь: ${url}`;
      await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, recipient: (order.client_phone as string).replace('+', '') }),
      }).catch(err => console.error('[cron remind whatsapp]', err));
    }

    // Push
    if (order.push_subscription) {
      const { sendPush } = await import('@/lib/push');
      await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
        title: `⏰ Заявка #${order.order_number} ждёт вашего выбора`,
        body: `Есть ${count} предложений — выберите исполнителя`,
        url: `/feed/${order.token}`,
      }).catch(() => {});
    }

    await supabaseAdmin
      .from('tender_orders')
      .update({ client_remind_sent_at: new Date().toISOString() })
      .eq('id', order.id);

    reminded++;
  }

  return `remind: ${reminded} clients reminded`;
}

// ─── 3. Таймаут selected → bidding если исполнитель не вышел на связь 2 часа ──

async function timeoutSelectedOrders(): Promise<string> {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, winning_bid_id, executor_id, token, client_phone, push_subscription')
    .eq('status', 'selected')
    .lt('updated_at', TWO_HOURS_AGO);

  if (!orders?.length) return 'timeout: 0 orders';

  let timedOut = 0;

  for (const order of orders) {
    // Проверяем — было ли хоть одно сообщение (признак контакта)
    const { count: msgCount } = await supabaseAdmin
      .from('order_messages')
      .select('id', { count: 'exact', head: true })
      .eq('order_id', order.id);

    if ((msgCount ?? 0) > 0) continue; // Контакт был — не трогаем

    // Возвращаем в bidding
    await supabaseAdmin
      .from('tender_orders')
      .update({ status: 'bidding', winning_bid_id: null, executor_id: null })
      .eq('id', order.id);

    // Сбрасываем ставки
    if (order.winning_bid_id) {
      await supabaseAdmin
        .from('tender_bids')
        .update({ status: 'pending', bot_state: 'idle' })
        .eq('id', order.winning_bid_id);
    }

    // Уведомляем клиента
    const url = `https://mushebi.ge/feed/${order.token}`;
    const wappiToken = process.env.WAPPI_TOKEN;
    const wappiProfile = process.env.WAPPI_PROFILE_ID;
    if (wappiToken && wappiProfile && order.client_phone) {
      const text = `⚠️ Исполнитель по заявке #${order.order_number} не вышел на связь в течение 2 часов.\n\nЗаявка снова открыта — вы можете выбрать другого исполнителя: ${url}`;
      await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, recipient: (order.client_phone as string).replace('+', '') }),
      }).catch(() => {});
    }

    if (order.push_subscription) {
      const { sendPush } = await import('@/lib/push');
      await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
        title: `⚠️ Исполнитель не вышел на связь`,
        body: `Заявка #${order.order_number} снова открыта`,
        url: `/feed/${order.token}`,
      }).catch(() => {});
    }

    timedOut++;
  }

  return `timeout: ${timedOut} orders reopened`;
}

// ─── 5. Напоминание за 30 минут до встречи ───────────────────────────────────

async function remindMeeting(): Promise<string> {
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
  const in40 = new Date(now.getTime() + 40 * 60 * 1000).toISOString();

  // Ищем заказы где встреча через 30-40 минут и подтверждена
  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, token, executor_id, client_phone, meeting_time, push_subscription')
    .eq('status', 'selected')
    .eq('meeting_confirmed', true)
    .gte('meeting_time', now.toISOString())
    .lte('meeting_time', in40)
    .gte('meeting_time', in30.replace('40', '20')); // окно 20-40 мин

  if (!orders?.length) return 'meeting-remind: 0';

  let reminded = 0;
  for (const order of orders) {
    const timeStr = new Date(order.meeting_time).toLocaleString('ru-RU', {
      timeZone: 'Asia/Tbilisi', hour: '2-digit', minute: '2-digit',
    });

    // Push клиенту
    if (order.push_subscription && order.token) {
      const { sendPush } = await import('@/lib/push');
      await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
        title: `⏰ Исполнитель едет к вам!`,
        body: `Встреча в ${timeStr} — будьте готовы`,
        url: `/feed/${order.token}`,
      }).catch(() => {});
    }

    // Уведомление исполнителю в Telegram
    if (order.executor_id) {
      const { data: driver } = await supabaseAdmin
        .from('tender_drivers')
        .select('telegram_id, driver_language')
        .eq('id', order.executor_id).single();

      if (driver?.telegram_id) {
        const lang = (driver.driver_language ?? 'ru') as string;
        const msgs: Record<string, string> = {
          ru: `⏰ Напоминание: встреча с клиентом через ~30 минут (в ${timeStr}).\n\nЗаказ #${order.order_number}`,
          ka: `⏰ შეხსენება: კლიენტთან შეხვედრა ~30 წუთში (${timeStr}-ზე).\n\nშეკვეთა #${order.order_number}`,
          en: `⏰ Reminder: meeting with client in ~30 minutes (at ${timeStr}).\n\nOrder #${order.order_number}`,
        };
        await bot.api.sendMessage(Number(driver.telegram_id), msgs[lang] ?? msgs.ru).catch(() => {});
      }
    }
    reminded++;
  }

  return `meeting-remind: ${reminded}`;
}

// ─── 6. Запрос оценки после завершения ───────────────────────────────────────

async function requestRatings(): Promise<string> {
  const ONE_HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, token, client_phone, executor_id, push_subscription, rating_requested_at')
    .eq('status', 'completed')
    .lt('updated_at', ONE_HOUR_AGO)
    .is('rating_requested_at', null);

  if (!orders?.length) return 'ratings: 0';

  let requested = 0;
  for (const order of orders) {
    const url = `https://mushebi.ge/feed/${order.token}`;

    // Push клиенту
    if (order.push_subscription && order.token) {
      const { sendPush } = await import('@/lib/push');
      await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
        title: '⭐ Оцените исполнителя',
        body: 'Это займёт 5 секунд и поможет другим клиентам',
        url: `/feed/${order.token}`,
      }).catch(() => {});
    }

    // WhatsApp клиенту
    const wappiToken = process.env.WAPPI_TOKEN;
    const wappiProfile = process.env.WAPPI_PROFILE_ID;
    if (wappiToken && wappiProfile && order.client_phone) {
      const text = `⭐ Как прошёл заказ #${order.order_number}?\n\nОставьте оценку — это займёт 5 секунд: ${url}`;
      await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text, recipient: (order.client_phone as string).replace('+', '') }),
      }).catch(() => {});
    }

    await supabaseAdmin
      .from('tender_orders')
      .update({ rating_requested_at: new Date().toISOString() })
      .eq('id', order.id);

    requested++;
  }

  return `ratings: ${requested} requested`;
}

// ─── 7. Client Assistant: клиент молчит на сайте > 5 минут → звоним ему голосом ──

const CLARIFICATION_CALLER_ID = process.env.ORCHESTRATOR_CALLER_ID ?? '';

/**
 * If a driver's ask_client_question has left an order in clarification_status='clarifying' for
 * more than 5 minutes with no answer (via any channel — see lib/orchestrator/clarification.ts),
 * the client likely hasn't seen the website/WhatsApp notification. Falls back to an automated
 * voice call via asterisk/client_bridge.py so the order doesn't sit paused indefinitely. Only
 * tries once per 30 minutes per order (clarification_call_attempted_at) — if the client still
 * doesn't answer the phone either, this will keep retrying every ~30 min rather than give up
 * silently, since there's no cheaper fallback channel left to try.
 */
async function callClientsForClarification(): Promise<string> {
  const FIVE_MIN_AGO = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, client_phone, missing_info, clarification_call_attempted_at, clarification_started_at')
    .eq('clarification_status', 'clarifying')
    .not('missing_info', 'is', null)
    .lt('clarification_started_at', FIVE_MIN_AGO);

  if (!orders?.length) return 'clarification-call: 0 orders';

  let called = 0;
  for (const order of orders) {
    if (!order.client_phone || !order.missing_info) continue;

    if (order.clarification_call_attempted_at) {
      const last = new Date(order.clarification_call_attempted_at).getTime();
      if (Date.now() - last < 30 * 60 * 1000) continue;
    }

    const result = await originateClarificationCall({
      orderId: order.id,
      clientPhone: order.client_phone,
      missingInfo: order.missing_info,
      callerId: CLARIFICATION_CALLER_ID,
    });

    if (result.ok) {
      await supabaseAdmin
        .from('tender_orders')
        .update({ clarification_call_attempted_at: new Date().toISOString() })
        .eq('id', order.id);
      called++;
    } else {
      console.error('[cron/callClientsForClarification] originate failed', result.error, { orderId: order.id });
    }
  }

  return `clarification-call: ${called} clients called`;
}

// ─── 8. "Спасибо за фото/видео" — debounced после серии медиа от клиента ─────

/**
 * A client can reply with the media request (see tender/create's mediaRequestText) by
 * sending several photos/videos in a row over a few seconds — each one bumps
 * last_media_received_at (see append_order_media_url). Rather than acknowledge every single
 * one individually (spammy for someone sending 10-20 photos), wait until at least one full
 * tick has passed with no new media, then send ONE "thanks, sending this to masters now"
 * message. This closes the loop the user asked for: client sends media -> gets confirmation
 * -> understands the tender is now running (drivers were already notified at order creation,
 * this just tells the client that happened).
 */
async function sendMediaThanks(): Promise<string> {
  const ONE_MINUTE_AGO = new Date(Date.now() - 60 * 1000).toISOString();

  const { data: orders } = await supabaseAdmin
    .from('tender_orders')
    .select('id, order_number, client_phone')
    .not('last_media_received_at', 'is', null)
    .is('media_thanks_sent_at', null)
    .lt('last_media_received_at', ONE_MINUTE_AGO);

  if (!orders?.length) return 'media-thanks: 0';

  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return 'media-thanks: 0 (no wappi config)';

  let sent = 0;
  for (const order of orders) {
    if (!order.client_phone) continue;

    const text =
      `✅ Спасибо за фото/видео!\n\n` +
      `Мы разошлём вашу заявку #${order.order_number} мастерам и устроим тендер — ` +
      `соберём предложения и покажем вам лучшие. Вы выберете подходящее, и мы сразу оповестим мастера.`;
    await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
      method: 'POST',
      headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, recipient: (order.client_phone as string).replace('+', '') }),
    }).catch(err => console.error('[cron media-thanks]', err));

    await supabaseAdmin
      .from('tender_orders')
      .update({ media_thanks_sent_at: new Date().toISOString() })
      .eq('id', order.id);

    sent++;
  }

  return `media-thanks: ${sent} sent`;
}

// ─── 4. Сброс зависших bot_state > 2 часов ───────────────────────────────────

async function resetStuckBotStates(): Promise<string> {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabaseAdmin
    .from('tender_bids')
    .update({ bot_state: 'idle', bot_state_updated_at: new Date().toISOString() })
    .in('bot_state', ['asking', 'bidding'])
    .lt('bot_state_updated_at', TWO_HOURS_AGO)
    .select('id');

  if (error) return `reset: error ${error.message}`;
  return `reset: ${data?.length ?? 0} stuck states cleared`;
}
