import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { token, subscription } = await req.json();
  if (!token || !subscription) return NextResponse.json({ error: 'missing' }, { status: 400 });

  await supabaseAdmin
    .from('tender_orders')
    .update({ push_subscription: subscription })
    .eq('token', token);

  return NextResponse.json({ ok: true });
}
