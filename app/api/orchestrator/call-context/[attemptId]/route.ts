import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { buildVoiceCallInstructions } from '@/lib/orchestrator/prompts';

/**
 * Fetched by asterisk/voice_bridge.py at StasisStart to get call-specific instructions for
 * a given attempt. Bearer-token authenticated with ORCHESTRATOR_BRIDGE_SECRET (same bar as
 * the existing CRON_SECRET pattern in app/api/cron/tick/route.ts).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ attemptId: string }> }
) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { attemptId } = await params;

  const { data: attempt } = await supabaseAdmin
    .from('order_call_attempts')
    .select('id, order_id, candidate_id, originated_at')
    .eq('id', attemptId)
    .single();

  if (!attempt) {
    return NextResponse.json({ error: 'attempt not found' }, { status: 404 });
  }

  const [{ data: order }, { data: candidate }] = await Promise.all([
    supabaseAdmin
      .from('tender_orders')
      .select('id, order_number, category, cargo_description, live_brief_ai')
      .eq('id', attempt.order_id)
      .single(),
    supabaseAdmin
      .from('call_candidates')
      .select('candidate_type, display_name, phone, preferred_lang')
      .eq('id', attempt.candidate_id)
      .single(),
  ]);

  if (!order || !candidate) {
    return NextResponse.json({ error: 'order or candidate not found' }, { status: 404 });
  }

  const language = candidate.preferred_lang || 'ru';

  const instructions = await buildVoiceCallInstructions({
    orderId: order.id,
    candidateName: candidate.display_name,
    language,
  });

  // Idempotent state transition — the bridge may retry this GET if its own request is slow.
  if (!attempt.originated_at) {
    await supabaseAdmin
      .from('order_call_attempts')
      .update({ status: 'in_progress', originated_at: new Date().toISOString() })
      .eq('id', attemptId)
      .is('originated_at', null);
  } else {
    await supabaseAdmin
      .from('order_call_attempts')
      .update({ status: 'in_progress' })
      .eq('id', attemptId);
  }

  return NextResponse.json({
    instructions,
    language,
    order: {
      id: order.id,
      order_number: order.order_number,
      category: order.category,
      summary: order.live_brief_ai ?? order.cargo_description,
    },
    candidate: {
      name: candidate.display_name,
      type: candidate.candidate_type,
      phone: candidate.phone,
    },
  });
}
