import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { buildCallCandidates } from '@/lib/orchestrator/matching';
import { createCallSequence } from '@/lib/orchestrator/sequence';
import { originateNextAttempt } from '@/lib/orchestrator/tick';
import { countInFlightCalls, MAX_CONCURRENT_CALLS } from '@/lib/orchestrator/concurrency';

interface TranscriptEntry {
  role: 'ai' | 'user' | 'system';
  text: string;
  timestamp: string;
}

interface ClarificationResultBody {
  order_id: string;
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

  await supabaseAdmin
    .from('tender_orders')
    .update({ clarification_status: 'ready', missing_info: null })
    .eq('id', order.id);

  await requeueForDriverCalls(order.id);

  return NextResponse.json({ ok: true });
}

/**
 * Re-enters the order into the driver call queue now that the blocking detail is resolved.
 * Mirrors the auto-start logic in app/api/tender/create/route.ts: build/refresh candidates
 * (safe to re-run, upserts), create the sequence if missing, and kick off the next attempt
 * immediately rather than waiting for the next cron/tick — same reasoning as at order creation,
 * a client who just answered a clarifying question shouldn't then wait ~10 minutes for the
 * driver to be called back. If a sequence already exists and is still queued/advancing (the
 * common case — the driver's own attempt already returned 'needs_follow_up' and advanced the
 * sequence), buildCallCandidates/createCallSequence are no-ops and this just opportunistically
 * tries to originate the next attempt now instead of waiting for the tick.
 */
async function requeueForDriverCalls(orderId: string): Promise<void> {
  try {
    await buildCallCandidates(orderId);
    const { sequenceId } = await createCallSequence(orderId);
    if (!sequenceId) return;

    const { data: seq } = await supabaseAdmin
      .from('order_call_sequences')
      .select('id, order_id, current_position, candidate_count, status')
      .eq('id', sequenceId)
      .single();

    if (!seq || !['queued', 'advancing'].includes(seq.status)) return;

    const inFlight = await countInFlightCalls();
    if (inFlight < MAX_CONCURRENT_CALLS) {
      await originateNextAttempt(seq);
    }
  } catch (e) {
    console.error('[clarification-result/requeueForDriverCalls]', e, { orderId });
  }
}
