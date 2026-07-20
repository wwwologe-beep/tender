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
    // 'confirmed' (or any other/missing outcome, per voice_bridge.py's conservative default)
    // requires no action — the order stays 'selected' as accept-bid already left it.
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
