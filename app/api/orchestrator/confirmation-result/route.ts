import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { sendPush } from '@/lib/push';

/**
 * Fired from asterisk/voice_bridge.py's StasisEnd handler for winner-confirmation calls
 * (see lib/orchestrator/confirmation-call.ts). attempt_id is synthetic: "confirm:<bidId>:
 * <orderId>" — there's no order_call_attempts row for these calls (they're one-way
 * notifications, not part of the candidate call-sequence), so order/bid identity travels in
 * the id itself instead of a DB lookup.
 *
 * On 'declined': reverts the order to 'bidding' and un-marks the winning bid, mirroring
 * exactly what POST /api/tender/cancel-selection already does for the client-initiated
 * "change executor" flow — same end state, different trigger. Also notifies the client via
 * push, since unlike the client-initiated path, they didn't take this action themselves and
 * would otherwise have no idea their order silently reopened.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { attempt_id, outcome } = await req.json();
  if (typeof attempt_id !== 'string' || !attempt_id.startsWith('confirm:')) {
    return NextResponse.json({ error: 'invalid attempt_id' }, { status: 400 });
  }

  const [, bidId, orderId] = attempt_id.split(':');
  if (!bidId || !orderId) {
    return NextResponse.json({ error: 'malformed attempt_id' }, { status: 400 });
  }

  if (outcome !== 'declined') {
    // 'confirmed' (or any other/missing outcome, per voice_bridge.py's conservative default):
    // the order stays 'selected' as accept-bid already left it. Additionally, for winners
    // with no Telegram (cold-contact-derived drivers), send the client's contact via
    // WhatsApp as a durable backup to the spoken number already given during the call
    // (see lib/orchestrator/confirmation-call.ts) — voice is easy to mishear/forget.
    await sendClientContactWhatsApp(bidId, orderId).catch(err =>
      console.error('[confirmation-result] sendClientContactWhatsApp failed', err)
    );
    return NextResponse.json({ ok: true });
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, status, token, push_subscription')
    .eq('id', orderId)
    .single();

  if (!order || order.status !== 'selected') {
    // Already reverted/moved on by some other path — nothing to do.
    return NextResponse.json({ ok: true });
  }

  await supabaseAdmin
    .from('tender_orders')
    .update({ status: 'bidding', winning_bid_id: null })
    .eq('id', orderId);

  // Mirrors cancel-selection/route.ts exactly: back to 'pending' so it re-enters the normal
  // bidding pool rather than introducing a new status value not known to be in the DB's
  // status CHECK constraint (schema for tender_bids lives outside this repo's migrations).
  await supabaseAdmin
    .from('tender_bids')
    .update({ status: 'pending' })
    .eq('id', bidId)
    .eq('status', 'winner');

  if (order.push_subscription && order.token) {
    await sendPush(order.push_subscription as Parameters<typeof sendPush>[0], {
      title: '⚠️ Исполнитель отказался',
      body: 'Выбранный исполнитель не сможет выполнить заказ. Заявка снова открыта для ставок.',
      url: `/feed/${order.token}`,
    });
  }

  return NextResponse.json({ ok: true, reverted: true });
}

async function sendClientContactWhatsApp(bidId: string, orderId: string): Promise<void> {
  const { data: bid } = await supabaseAdmin
    .from('tender_bids')
    .select('driver_id')
    .eq('id', bidId)
    .single();
  if (!bid?.driver_id) return;

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('phone, telegram_id, driver_language')
    .eq('id', bid.driver_id)
    .single();
  // Telegram drivers already have client contact via the bot's "Запросить номер клиента"
  // button — this WhatsApp fallback exists only for phone-only (cold-contact) winners.
  if (!driver?.phone || driver.telegram_id) return;

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('client_phone, order_number')
    .eq('id', orderId)
    .single();
  if (!order?.client_phone) return;

  const wappiToken = process.env.WAPPI_TOKEN;
  const wappiProfile = process.env.WAPPI_PROFILE_ID;
  if (!wappiToken || !wappiProfile) return;

  const lang = driver.driver_language ?? 'ru';
  const msgs: Record<string, string> = {
    ru: `✅ Заказ №${order.order_number ?? ''} подтверждён. Телефон клиента: ${order.client_phone}`,
    ka: `✅ შეკვეთა №${order.order_number ?? ''} დადასტურებულია. კლიენტის ტელეფონი: ${order.client_phone}`,
    en: `✅ Order #${order.order_number ?? ''} confirmed. Client phone: ${order.client_phone}`,
  };

  await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
    method: 'POST',
    headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: msgs[lang] ?? msgs.ru, recipient: driver.phone.replace('+', '') }),
  });
}
