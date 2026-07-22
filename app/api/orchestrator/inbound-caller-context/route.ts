import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { buildOrderContext } from '@/lib/ai-advisor';

/**
 * Fired from asterisk/voice_bridge.py at the very start of an inbound call to 2115325 —
 * before deciding which system prompt/tool set to use, we need to know whether this is a
 * known driver (possibly with an active order they might have a question about) or an
 * unknown caller who should be treated as a potential client placing a new order. Without
 * this, every inbound call was treated as client intake regardless of who was actually
 * calling — a driver calling to ask about their active job would just be asked "what job do
 * you need done?", which makes no sense.
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const phone = req.nextUrl.searchParams.get('phone');
  if (!phone) {
    return NextResponse.json({ error: 'phone required' }, { status: 400 });
  }

  const { data: driver } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, name, driver_language, active_order_id')
    .eq('phone', phone)
    .maybeSingle();

  if (!driver) {
    return NextResponse.json({ role: 'unknown' });
  }

  if (!driver.active_order_id) {
    return NextResponse.json({
      role: 'driver',
      driver_name: driver.name,
      driver_language: driver.driver_language,
      has_active_order: false,
    });
  }

  const orderContext = await buildOrderContext(driver.active_order_id, 'driver', driver.driver_language ?? 'ru');

  return NextResponse.json({
    role: 'driver',
    driver_id: driver.id,
    driver_name: driver.name,
    driver_language: driver.driver_language,
    has_active_order: true,
    active_order_id: driver.active_order_id,
    order_context: orderContext,
  });
}
