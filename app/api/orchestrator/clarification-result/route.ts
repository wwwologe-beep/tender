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
    .select('id, status, missing_info')
    .eq('id', body.order_id)
    .single();

  if (!order) {
    return NextResponse.json({ error: 'order not found' }, { status: 404 });
  }

  if (body.reached === true && body.answer?.trim()) {
    // Record the voice answer on the same order_questions row the driver's ask_client_question
    // created — resolveClarificationAndRequeue reads answer_original from there to know what
    // to relay back to the driver, same as a website/Telegram answer would.
    const { data: question } = await supabaseAdmin
      .from('order_questions')
      .select('id')
      .eq('order_id', order.id)
      .eq('question_original', order.missing_info ?? '')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (question) {
      await supabaseAdmin
        .from('order_questions')
        .update({
          answer_original: body.answer.trim(),
          answered_by: 'client',
          status: 'answered',
          answered_at: new Date().toISOString(),
        })
        .eq('id', question.id);
    }

    await resolveClarificationAndRequeue(order.id, question?.id, body.answer.trim());
  } else {
    console.log('Clarification attempt failed for order', order.id);
  }

  return NextResponse.json({ ok: true });
}
