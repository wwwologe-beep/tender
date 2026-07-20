import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { resolveClarificationAndRequeue } from '@/lib/orchestrator/clarification';

interface TranscriptEntry {
  role: 'ai' | 'user' | 'system';
  text: string;
  timestamp: string;
}

interface ClarificationResultBody {
  order_id: string;
  reached: boolean;
  answer?: string;
  transcript?: TranscriptEntry[];
}

/**
 * Fired from asterisk/client_bridge.py's StasisEnd handler once a Client Assistant
 * clarification call ends (see PROJECT.md's Client Assistant / clarification_status state
 * machine). Marks the order 'ready' — the missing detail has been collected — and re-enters it
 * into the driver call queue so the original blocked candidate sequence can resume.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: ClarificationResultBody = await req.json();
  if (!body.order_id) {
    return NextResponse.json({ error: 'order_id required' }, { status: 400 });
  }

  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, status')
    .eq('id', body.order_id)
    .single();

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }

  if (body.reached === true && body.answer?.trim()) {
    await resolveClarificationAndRequeue(order.id);
  } else {
    console.log('Clarification attempt failed for order', order.id);
  }

  return NextResponse.json({ ok: true });
}
