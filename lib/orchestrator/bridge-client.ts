/**
 * Thin HTTP client for the small originate endpoint added to asterisk/voice_bridge.py
 * (POST /originate on the Asterisk VPS, separate from ARI's own port 8088).
 */

const ASTERISK_BRIDGE_URL = process.env.ASTERISK_BRIDGE_URL; // e.g. http://79.108.163.50:8090
const ORCHESTRATOR_BRIDGE_SECRET = process.env.ORCHESTRATOR_BRIDGE_SECRET;

export interface OriginateResult {
  ok: boolean;
  channelId?: string;
  error?: string;
}

export async function originateCall(params: {
  attemptId: string;
  phone: string;
  callerId: string;
}): Promise<OriginateResult> {
  if (!ASTERISK_BRIDGE_URL || !ORCHESTRATOR_BRIDGE_SECRET) {
    return { ok: false, error: 'ASTERISK_BRIDGE_URL/ORCHESTRATOR_BRIDGE_SECRET not configured' };
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
        phone: params.phone,
        caller_id: params.callerId,
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
