import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { advanceToNextCandidate, succeedSequence } from '@/lib/orchestrator/sequence';

type ToolOutcome = 'agreed' | 'declined' | 'needs_follow_up' | 'voicemail';

interface CallResultBody {
  attempt_id: string;
  channel_id?: string;
  call_duration_seconds?: number;
  hangup_cause?: string;
  tool_result: {
    outcome: ToolOutcome;
    agreed_price?: number;
    available_date?: string;
    notes?: string;
  } | null;
}

/**
 * Fired from asterisk/voice_bridge.py's StasisEnd handler once a call ends. Call end is the
 * authoritative outcome trigger — the OpenAI Realtime tool call (report_outcome) is best-effort
 * enrichment, not the sole recorder. If the model never calls the tool (no answer, voicemail,
 * dead air), a best-effort outcome is derived from call_duration_seconds/hangup_cause so the
 * sequence can still advance — this is what guarantees every attempt terminates with SOME
 * outcome rather than stalling forever.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: CallResultBody = await req.json();
  if (!body.attempt_id) {
    return NextResponse.json({ error: 'attempt_id required' }, { status: 400 });
  }

  const { data: attempt } = await supabaseAdmin
    .from('order_call_attempts')
    .select('id, sequence_id, order_id, candidate_id')
    .eq('id', body.attempt_id)
    .single();

  if (!attempt) {
    return NextResponse.json({ error: 'attempt not found' }, { status: 404 });
  }

  const outcome = deriveOutcome(body);

  await supabaseAdmin
    .from('order_call_attempts')
    .update({
      status: 'completed',
      outcome,
      outcome_data: body.tool_result ?? null,
      ended_at: new Date().toISOString(),
    })
    .eq('id', attempt.id);

  if (outcome === 'agreed') {
    await handleAgreedOutcome(attempt, body.tool_result);
    await succeedSequence(attempt.sequence_id, attempt.candidate_id);
  } else {
    await advanceToNextCandidate(attempt.sequence_id);
  }

  return NextResponse.json({ ok: true, outcome });
}

function deriveOutcome(body: CallResultBody): string {
  if (body.tool_result?.outcome) return body.tool_result.outcome;

  const duration = body.call_duration_seconds ?? 0;
  if (duration < 3) return 'no_answer';
  return 'abandoned';
}

async function handleAgreedOutcome(
  attempt: { order_id: string; candidate_id: string },
  toolResult: CallResultBody['tool_result']
): Promise<void> {
  const { data: candidate } = await supabaseAdmin
    .from('call_candidates')
    .select('candidate_type, driver_id, cold_contact_id, phone, display_name')
    .eq('id', attempt.candidate_id)
    .single();

  if (!candidate) return;

  if (candidate.candidate_type === 'driver' && candidate.driver_id) {
    // Mirrors what a normal bid does, minimally — the call's outcome becomes visible through
    // the EXISTING client-facing accept flow (app/api/tender/accept-bid/route.ts) rather than
    // inventing a parallel "auto-accept via phone" path. Does NOT auto-call accept_bid_atomic
    // itself — final client confirmation is out of scope for this orchestrator.
    await supabaseAdmin.from('tender_bids').upsert(
      {
        order_id: attempt.order_id,
        driver_id: candidate.driver_id,
        amount: toolResult?.agreed_price ?? 0,
        status: 'pending',
        comment: toolResult?.notes ?? null,
      },
      { onConflict: 'order_id,driver_id' }
    );
    return;
  }

  if (candidate.candidate_type === 'cold_contact' && candidate.cold_contact_id) {
    // Capture/convert moment: a cold contact who agreed on a call becomes a real
    // tender_drivers row (status:'pending', mirrors how Telegram-bot-registered drivers
    // start). Does NOT auto-activate — no subscription paid, no telegram_id yet. How a
    // phone-only driver receives future orders/bids without Telegram is an open gap,
    // see ARCHITECTURE.md §9.
    const { data: newDriver } = await supabaseAdmin
      .from('tender_drivers')
      .insert({
        name: candidate.display_name,
        phone: candidate.phone,
        status: 'pending',
      })
      .select('id')
      .single();

    if (newDriver) {
      await supabaseAdmin
        .from('cold_contacts')
        .update({
          status: 'converted',
          converted_driver_id: newDriver.id,
          last_call_outcome: 'agreed',
          last_called_at: new Date().toISOString(),
        })
        .eq('id', candidate.cold_contact_id);

      await supabaseAdmin.from('tender_bids').upsert(
        {
          order_id: attempt.order_id,
          driver_id: newDriver.id,
          amount: toolResult?.agreed_price ?? 0,
          status: 'pending',
          comment: toolResult?.notes ?? null,
        },
        { onConflict: 'order_id,driver_id' }
      );
    }
  }
}
