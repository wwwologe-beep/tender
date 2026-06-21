import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { order_id, driver_id, amount, comment } = await req.json();

    if (!order_id || !driver_id || !amount) {
      return NextResponse.json({ error: 'order_id, driver_id и amount обязательны' }, { status: 400 });
    }

    const parsed = parseFloat(amount);
    if (!parsed || parsed <= 0) {
      return NextResponse.json({ error: 'Некорректная сумма' }, { status: 400 });
    }

    const { error } = await supabaseAdmin.from('tender_bids').upsert(
      {
        order_id,
        driver_id,
        amount: parsed,
        comment: comment?.trim() || null,
        status: 'pending',
      },
      { onConflict: 'order_id,driver_id' }
    );

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[bid]', err);
    return NextResponse.json({ error: 'Внутренняя ошибка сервера' }, { status: 500 });
  }
}
