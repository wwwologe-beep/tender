/**
 * Thin HTTP client for asterisk/client_bridge.py's /originate endpoint — mirrors
 * bridge-client.ts (which talks to voice_bridge.py's /originate on port 8090), but targets
 * client_bridge.py's own port (CLIENT_BRIDGE_PORT, default 8091) and its call shape
 * (order_id + client_phone + missing_info, not attempt_id + candidate phone).
 */

const CLIENT_BRIDGE_URL = process.env.CLIENT_BRIDGE_URL; // e.g. http://79.108.163.50:8091
const ORCHESTRATOR_BRIDGE_SECRET = process.env.ORCHESTRATOR_BRIDGE_SECRET;

export interface ClientOriginateResult {
  ok: boolean;
  channelId?: string;
  error?: string;
}

export async function originateClarificationCall(params: {
  orderId: string;
  clientPhone: string;
  missingInfo: string;
  callerId: string;
}): Promise<ClientOriginateResult> {
  if (!CLIENT_BRIDGE_URL || !ORCHESTRATOR_BRIDGE_SECRET) {
    return { ok: false, error: 'CLIENT_BRIDGE_URL/ORCHESTRATOR_BRIDGE_SECRET not configured' };
  }

  try {
    const res = await fetch(`${CLIENT_BRIDGE_URL}/originate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ORCHESTRATOR_BRIDGE_SECRET}`,
      },
      body: JSON.stringify({
        order_id: params.orderId,
        client_phone: params.clientPhone,
        missing_info: params.missingInfo,
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
