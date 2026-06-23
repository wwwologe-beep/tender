import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { order_id } = await req.json();
    if (!order_id) return NextResponse.json({ error: 'order_id required' }, { status: 400 });

    const { data: order, error: orderErr } = await supabaseAdmin
      .from('tender_orders')
      .select('id, status')
      .eq('id', order_id)
      .single();

    if (orderErr || !order) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
    if (order.status !== 'selected') return NextResponse.json({ error: 'Order is not in selected state' }, { status: 400 });

    const { error: updateErr } = await supabaseAdmin
      .from('tender_orders')
      .update({ status: 'bidding', winning_bid_id: null })
      .eq('id', order_id);

    if (updateErr) throw updateErr;

    await supabaseAdmin
      .from('tender_bids')
      .update({ status: 'pending' })
      .eq('order_id', order_id)
      .eq('status', 'winner');

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[cancel-selection]', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
