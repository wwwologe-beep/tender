/**
 * Thin HTTP client for the small originate endpoint added to asterisk/voice_bridge.py
 * (POST /originate on the Asterisk VPS, separate from ARI's own port 8088).
 */

const ASTERISK_BRIDGE_URL = process.env.ASTERISK_BRIDGE_URL; // e.g. http://79.108.163.50:8090
const ORCHESTRATOR_BRIDGE_SECRET = process.env.ORCHESTRATOR_BRIDGE_SECRET;
const TEST_PHONE = process.env.ORCHESTRATOR_TEST_PHONE;

export interface OriginateResult {
  ok: boolean;
  channelId?: string;
  error?: string;
}

export async function originateCall(params: {
  attemptId: string;
  phone: string;
  callerId: string;
  /** Skips the bridge's call-context fetch and speaks these instructions directly — used for
   *  one-way notification calls (e.g. winner confirmation) that aren't part of the candidate
   *  call-sequence state machine and have no order_call_attempts row. */
  instructions?: string;
}): Promise<OriginateResult> {
  if (!ASTERISK_BRIDGE_URL || !ORCHESTRATOR_BRIDGE_SECRET) {
    return { ok: false, error: 'ASTERISK_BRIDGE_URL/ORCHESTRATOR_BRIDGE_SECRET not configured' };
  }

  let phone = params.phone;
  if (TEST_PHONE) {
    console.log(`[TEST MODE] Target phone overridden to ${TEST_PHONE}`);
    phone = TEST_PHONE;
  }

  try {
    const res = await fetch(`${ASTERISK_BRIDGE_URL}/originate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ORCHESTRATOR_BRIDGE_SECRET}`,
      },
      body: JSON.stringify({
        attempt_id: params.attemptId,
        phone,
        caller_id: params.callerId,
        instructions: params.instructions,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const body = (await res.json().catch(() => ({}))) as { channel_id?: string; error?: string };

    if (!res.ok || !body.channel_id) {
      return { ok: false, error: body.error ?? `HTTP ${res.status}` };
    }

    return { ok: true, channelId: body.channel_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
