import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { analyzeOrder, type LocalizedDescription } from '@/lib/ai';
import { sendTenderToDrivers } from '@/lib/telegram/bot';
import { buildCallCandidates } from '@/lib/orchestrator/matching';
import { createCallSequence } from '@/lib/orchestrator/sequence';
import { originateNextAttempt } from '@/lib/orchestrator/tick';
import { countInFlightCalls, MAX_CONCURRENT_CALLS } from '@/lib/orchestrator/concurrency';
import { logSystemEvent } from '@/lib/system-log';

/**
 * Fired from asterisk/voice_bridge.py mid-inbound-call when the AI's create_order tool is
 * invoked — closes the biggest gap noted in PROJECT.md §5: an inbound call to 2115325 could
 * have a full conversation with the AI and nothing was ever saved, a total lead loss. This is
 * the voice equivalent of POST /api/tender/create, using the caller's phone number (from the
 * ARI channel, not typed by the client) and the AI's spoken summary of the job as the
 * free-text description. Reuses analyzeOrder() + the same downstream fan-out (Telegram push,
 * voice-orchestrator candidate queue) as the web form — not a parallel, thinner path.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.ORCHESTRATOR_BRIDGE_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { caller_phone, description, address, scheduled_at } = await req.json();
  if (!caller_phone || !description?.trim()) {
    return NextResponse.json({ error: 'caller_phone and description required' }, { status: 400 });
  }

  console.log(`🔧 [voice-call] create_order(caller_phone=${caller_phone}, description=${JSON.stringify(description)})`);

  // Link the call to the same client profile the web OTP flow uses (tender_clients, unique
  // on phone) — without this, every inbound call was treated as a brand-new anonymous
  // caller even if the same person had ordered before, on any channel. Check for an existing
  // row first (to log/know whether this is a repeat caller), then upsert (not just insert)
  // so an existing row's session_token/created_at is preserved, only last_login is refreshed.
  const { data: existingClient } = await supabaseAdmin
    .from('tender_clients')
    .select('id')
    .eq('phone', caller_phone)
    .maybeSingle();
  const isReturningClient = !!existingClient;

  await supabaseAdmin
    .from('tender_clients')
    .upsert(
      { phone: caller_phone, last_login: new Date().toISOString() },
      { onConflict: 'phone' }
    );
  console.log(`🔧 [voice-call] create_order: ${isReturningClient ? 'returning' : 'new'} client (phone=${caller_phone})`);

  let category = 'general';
  let aiSummary: string | null = null;
  let localizedDescription: LocalizedDescription | null = null;

  if (process.env.OPENROUTER_API_KEY) {
    try {
      const analysis = await analyzeOrder(description.trim());
      if (analysis) {
        category = analysis.category;
        aiSummary = analysis.ai_summary;
        localizedDescription = analysis.localized_description;
      }
    } catch (err) {
      console.error('[create-order-from-call] analyzeOrder', err);
    }
  }

  const { data: order, error } = await supabaseAdmin
    .from('tender_orders')
    .insert({
      token: randomUUID(),
      address_from: address ?? '-',
      address_to: '-',
      cargo_description: description.trim(),
      client_name: 'Клиент (звонок)',
      client_phone: caller_phone,
      scheduled_at: scheduled_at ?? null,
      category,
      ai_summary: aiSummary,
      localized_description: localizedDescription,
      status: 'bidding',
      bidding_started_at: new Date().toISOString(),
    })
    .select('id, token, order_number')
    .single();

  if (error || !order) {
    console.error('[create-order-from-call] insert error:', error?.message);
    return NextResponse.json({ error: 'Ошибка базы данных' }, { status: 500 });
  }

  // Same fan-out as POST /api/tender/create: Telegram push to subscribed drivers, plus the
  // voice-orchestrator candidate queue for cold contacts — this order deserves the exact same
  // outreach a web-submitted order gets, not a degraded version.
  try {
    await sendTenderToDrivers(order.id);
  } catch (e) {
    console.error('[create-order-from-call] sendTenderToDrivers', e);
  }

  try {
    const { built } = await buildCallCandidates(order.id);
    if (built > 0) {
      const { sequenceId } = await createCallSequence(order.id);
      if (sequenceId) {
        const inFlight = await countInFlightCalls();
        if (inFlight < MAX_CONCURRENT_CALLS) {
          await originateNextAttempt({
            id: sequenceId,
            order_id: order.id,
            current_position: 0,
            candidate_count: built,
            status: 'queued',
          });
        }
      }
    }
  } catch (e) {
    console.error('[create-order-from-call] buildCallCandidates', e);
  }

  logSystemEvent({
    source: 'voice-call',
    tag: 'orchestrator.create-order-from-call',
    orderId: order.id,
    message: `Order #${order.order_number} created from inbound call (${isReturningClient ? 'returning' : 'new'} client, phone=${caller_phone})`,
    data: { caller_phone, description, address, category, isReturningClient },
  });

  return NextResponse.json({ ok: true, order_id: order.id, order_number: order.order_number, token: order.token });
}
