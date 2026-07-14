"""
Asterisk ARI + externalMedia <-> OpenAI Realtime API bridge, with orchestrator integration.

Flow:
1. Next.js orchestrator (lib/orchestrator/tick.ts) POSTs to /originate on this process with an
   attempt_id + phone number, which originates an outbound call via ARI into the `ai-dial`
   dialplan context (see ARCHITECTURE.md §9), tagged with attempt_id as the channel var
   ORCH_ATTEMPT_ID so we can find it again at StasisStart.
2. On StasisStart (real PSTN channel, not externalMedia's own child channel): answer, create an
   externalMedia channel (ulaw, RTP) on a fresh OS-assigned local UDP port (supports multiple
   concurrent calls), bridge it with the PSTN channel via an ARI mixing bridge.
3. Fetch call-specific instructions from Next.js (GET /api/orchestrator/call-context/:attemptId),
   open an OpenAI Realtime WebSocket session (model gpt-realtime) with those instructions and a
   report_outcome tool the model is instructed to call before ending the conversation.
4. Bridge RTP audio <-> Realtime audio in both directions; handle tool-call events to capture
   structured outcome (agreed/declined/needs_follow_up/voicemail + price/date/notes).
5. On call hangup (StasisEnd): tear down the Realtime session and RTP socket, POST the outcome
   (from the tool call if available, else derived from call duration) to Next.js
   (POST /api/orchestrator/call-result).

Deploy: this file lives on the Asterisk server at /root/voice_bridge.py (79.108.163.50).
Run with:
    export ARI_PASS=<ari password, see memory/asterisk-telephony.md>
    export OPENAI_API_KEY=$(cat /root/.openai_key)
    export ORCHESTRATOR_BRIDGE_SECRET=<shared secret, also set in Vercel env>
    export NEXTJS_APP_URL=https://mushebi.ge
    nohup python3 -u /root/voice_bridge.py > /root/voice_bridge.log 2>&1 &

Dependencies: pip install aiohttp websockets (websockets already required by the pre-orchestrator
version of this file; aiohttp is new, needed for the /originate HTTP server — chosen over a
blocking stdlib http.server thread since this whole file is asyncio-based end to end and mixing
a blocking thread with the asyncio ARI/RTP loop caused prior debugging pain, see ARCHITECTURE.md).
"""
import asyncio
import json
import base64
import struct
import socket
import os
import sys
import time
import urllib.request
import urllib.error
import websockets
from aiohttp import web

ARI_HOST = "127.0.0.1:8088"
ARI_USER = "aiuser"
ARI_PASS = os.environ.get("ARI_PASS")
if not ARI_PASS:
    print("ERROR: set ARI_PASS env var before running this script", file=sys.stderr)
    sys.exit(1)
APP = "ai-telephony"

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("ERROR: set OPENAI_API_KEY env var before running this script", file=sys.stderr)
    sys.exit(1)
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"

ORCHESTRATOR_BRIDGE_SECRET = os.environ.get("ORCHESTRATOR_BRIDGE_SECRET")
if not ORCHESTRATOR_BRIDGE_SECRET:
    print("ERROR: set ORCHESTRATOR_BRIDGE_SECRET env var before running this script", file=sys.stderr)
    sys.exit(1)
NEXTJS_APP_URL = os.environ.get("NEXTJS_APP_URL", "https://mushebi.ge")

RTP_LOCAL_HOST = "127.0.0.1"
ORIGINATE_HTTP_PORT = int(os.environ.get("ORCHESTRATOR_BRIDGE_PORT", "8090"))

seen_channels = set()
# Maps ARI channel_id -> attempt_id, populated at /originate time, read at StasisStart and
# StasisEnd. Safe to keep in-process: this bridge runs as a persistent nohup process on the
# VPS, not a stateless Vercel function (unlike everything on the Next.js side, which must keep
# state in Supabase — see lib/orchestrator/concurrency.ts).
channel_to_attempt = {}


def ari_request(method, path):
    url = f"http://{ARI_HOST}/ari{path}"
    req = urllib.request.Request(url, method=method)
    auth = base64.b64encode(f"{ARI_USER}:{ARI_PASS}".encode()).decode()
    req.add_header("Authorization", f"Basic {auth}")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def nextjs_get(path):
    url = f"{NEXTJS_APP_URL}{path}"
    req = urllib.request.Request(url, method="GET")
    req.add_header("Authorization", f"Bearer {ORCHESTRATOR_BRIDGE_SECRET}")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        print(f"nextjs_get({path}) failed: {e}")
        return 0, {}


def nextjs_post(path, payload):
    url = f"{NEXTJS_APP_URL}{path}"
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Authorization", f"Bearer {ORCHESTRATOR_BRIDGE_SECRET}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        print(f"nextjs_post({path}) HTTP {e.code}: {e.read()}")
        return e.code
    except Exception as e:
        print(f"nextjs_post({path}) failed: {e}")
        return 0


FRAME_BYTES = 160  # 20ms of 8kHz u-law
FRAME_SECONDS = 0.02

REPORT_OUTCOME_TOOL = {
    "type": "function",
    "name": "report_outcome",
    "description": (
        "Call this once you have a clear answer from the person, or if they refuse/are "
        "unavailable to talk. Always call this before ending the conversation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "outcome": {
                "type": "string",
                "enum": ["agreed", "declined", "needs_follow_up", "voicemail"],
            },
            "agreed_price": {
                "type": "number",
                "description": "Price in GEL if discussed, else omit",
            },
            "available_date": {
                "type": "string",
                "description": "ISO date/time if discussed, else omit",
            },
            "notes": {
                "type": "string",
                "description": "Short free-text summary of anything else relevant",
            },
        },
        "required": ["outcome"],
    },
}


class RTPBridge:
    """Handles one call's RTP <-> OpenAI Realtime audio bridging."""

    def __init__(self, chan_id):
        self.chan_id = chan_id
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Bind to an OS-assigned free port so multiple calls can run concurrently
        # without colliding on a shared fixed port.
        self.sock.bind((RTP_LOCAL_HOST, 0))
        self.local_port = self.sock.getsockname()[1]
        self.sock.setblocking(False)
        self.remote_addr = None
        self.seq = 0
        self.timestamp = 0
        self.ssrc = 0x1234ABCD
        self.running = True
        self.oa_ws = None
        self.out_buffer = bytearray()  # raw ulaw bytes pending transmission, paced by sender_loop
        self.tool_result = None  # populated by report_outcome tool call, if the model calls it
        self.call_started_at = time.monotonic()

    async def rtp_recv_loop(self, loop):
        """Read RTP packets from Asterisk, forward payload (ulaw) to OpenAI."""
        while self.running:
            try:
                data, addr = await loop.sock_recvfrom(self.sock, 2048)
            except Exception:
                await asyncio.sleep(0.01)
                continue
            if self.remote_addr is None:
                self.remote_addr = addr
                print(f"[{self.chan_id}] RTP peer learned: {addr}")
            if len(data) < 12:
                continue
            payload = data[12:]  # skip 12-byte RTP header
            if self.oa_ws is not None:
                try:
                    await self.oa_ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(payload).decode(),
                    }))
                except Exception as e:
                    print(f"[{self.chan_id}] error sending to OpenAI: {e}")

    def enqueue_audio(self, ulaw_bytes):
        """Called when OpenAI sends an audio delta; just buffer it, pacing happens in sender_loop."""
        self.out_buffer.extend(ulaw_bytes)

    async def sender_loop(self):
        """Send exactly one 20ms ulaw frame every 20ms, using a running clock to avoid drift.
        Do not collapse this into a tight send loop — unpaced sends produce garbled audio."""
        next_send = asyncio.get_event_loop().time()
        while self.running:
            if self.remote_addr is not None and len(self.out_buffer) >= FRAME_BYTES:
                frame = bytes(self.out_buffer[:FRAME_BYTES])
                del self.out_buffer[:FRAME_BYTES]
                self._send_rtp_frame(frame)
            next_send += FRAME_SECONDS
            delay = next_send - asyncio.get_event_loop().time()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                next_send = asyncio.get_event_loop().time()

    def _send_rtp_frame(self, ulaw_bytes):
        header = bytes([0x80, 0x00]) + struct.pack(
            "!HII",
            self.seq & 0xFFFF,
            self.timestamp & 0xFFFFFFFF,
            self.ssrc,
        )
        packet = header + ulaw_bytes
        try:
            self.sock.sendto(packet, self.remote_addr)
        except Exception as e:
            print(f"[{self.chan_id}] error sending RTP: {e}")
        self.seq += 1
        self.timestamp += FRAME_BYTES

    async def openai_session(self, instructions):
        headers = {
            "Authorization": f"Bearer {OPENAI_API_KEY}",
        }
        print(f"[{self.chan_id}] connecting to OpenAI Realtime...")
        async with websockets.connect(
            OPENAI_REALTIME_URL,
            additional_headers=headers,
            max_size=2**23,
        ) as ws:
            self.oa_ws = ws
            await ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "model": "gpt-realtime",
                    "output_modalities": ["audio"],
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcmu"},
                            "turn_detection": {
                                "type": "server_vad",
                                "threshold": 0.5,
                                "prefix_padding_ms": 300,
                                "silence_duration_ms": 500,
                                "create_response": True,
                                "interrupt_response": True,
                            },
                        },
                        "output": {"format": {"type": "audio/pcmu"}, "voice": "cedar"},
                    },
                    "instructions": instructions,
                    "tools": [REPORT_OUTCOME_TOOL],
                },
            }))
            print(f"[{self.chan_id}] OpenAI session configured, waiting for events...")
            async for message in ws:
                event = json.loads(message)
                etype = event.get("type")
                if etype == "session.created":
                    print(f"[{self.chan_id}] OpenAI session created -> triggering greeting")
                    await ws.send(json.dumps({
                        "type": "response.create",
                    }))
                elif etype == "response.output_audio.delta":
                    audio_b64 = event.get("delta")
                    if audio_b64:
                        pcmu = base64.b64decode(audio_b64)
                        self.enqueue_audio(pcmu)
                elif etype == "response.done":
                    print(f"[{self.chan_id}] response.done")
                    self._extract_tool_result(event)
                elif etype == "input_audio_buffer.speech_started":
                    print(f"[{self.chan_id}] speech_started -> interrupting AI (barge-in)")
                    self.out_buffer.clear()
                elif etype == "error":
                    print(f"[{self.chan_id}] OpenAI error: {event}")
                if not self.running:
                    break

    def _extract_tool_result(self, response_done_event):
        """Scan a response.done event's output items for a completed report_outcome function
        call and parse its arguments. NOTE: verify this exact event/field shape against current
        OpenAI Realtime docs at deploy time — nothing in this codebase used tool-calling before
        this feature, so this is the first use and the surface is less stable than the plain
        audio events already validated in this file."""
        try:
            output = response_done_event.get("response", {}).get("output", [])
            for item in output:
                if item.get("type") == "function_call" and item.get("name") == "report_outcome":
                    args = json.loads(item.get("arguments", "{}"))
                    self.tool_result = args
                    print(f"[{self.chan_id}] report_outcome tool result: {args}")
        except Exception as e:
            print(f"[{self.chan_id}] error extracting tool result: {e}")

    def stop(self):
        self.running = False
        try:
            self.sock.close()
        except Exception:
            pass


async def fetch_call_context(attempt_id):
    """GET /api/orchestrator/call-context/:attemptId from Next.js. Returns the instructions
    string, or a generic fallback if the fetch fails (e.g. Next.js unreachable) — a call
    should still proceed with SOME reasonable behavior rather than crash outright."""
    status, body = nextjs_get(f"/api/orchestrator/call-context/{attempt_id}")
    if status == 200 and body.get("instructions"):
        return body["instructions"]
    print(f"fetch_call_context({attempt_id}) failed (status={status}), using fallback instructions")
    return (
        "You are mushebi.ge's voice assistant. Greet the person, ask if they're available "
        "to discuss a job opportunity, and call the report_outcome tool with 'needs_follow_up' "
        "before ending the call, since call context could not be loaded."
    )


async def report_call_result(attempt_id, channel_id, bridge):
    """POST /api/orchestrator/call-result to Next.js on StasisEnd. This webhook call is the
    authoritative outcome trigger (not the tool call, which is best-effort enrichment) — if
    the model never called report_outcome, Next.js derives a fallback outcome from call
    duration so the orchestrator sequence can still advance rather than stall."""
    duration = time.monotonic() - bridge.call_started_at
    payload = {
        "attempt_id": attempt_id,
        "channel_id": channel_id,
        "call_duration_seconds": round(duration, 1),
        "hangup_cause": "NORMAL_CLEARING",
        "tool_result": bridge.tool_result,
    }
    status = nextjs_post("/api/orchestrator/call-result", payload)
    print(f"[{channel_id}] reported call result -> Next.js status={status}")


async def handle_call(chan_id, attempt_id=None):
    print(f"[{chan_id}] handling new call (attempt_id={attempt_id})")
    status, body = ari_request("POST", f"/channels/{chan_id}/answer")
    print(f"[{chan_id}] answer -> {status}")

    # Create the RTP socket first so we know which OS-assigned local port to
    # tell Asterisk to send audio to (required for concurrent calls, see R5
    # in memory/asterisk-telephony.md — a fixed shared port breaks the 2nd call).
    bridge = RTPBridge(chan_id)

    extmedia_id = f"extmedia-{chan_id}"
    status, body = ari_request(
        "POST",
        f"/channels/externalMedia?app={APP}&external_host={RTP_LOCAL_HOST}:{bridge.local_port}"
        f"&format=ulaw&channelId={extmedia_id}",
    )
    print(f"[{chan_id}] externalMedia -> {status} {body.decode()} (local_port={bridge.local_port})")

    # Critical: externalMedia alone does not flow audio. It must be explicitly
    # bridged with the PSTN channel via an ARI mixing bridge.
    bridge_id = f"bridge-{chan_id}"
    status, body = ari_request(
        "POST", f"/bridges?type=mixing&bridgeId={bridge_id}"
    )
    print(f"[{chan_id}] create bridge -> {status} {body.decode()[:200]}")

    status, body = ari_request(
        "POST", f"/bridges/{bridge_id}/addChannel?channel={chan_id}"
    )
    print(f"[{chan_id}] add PSTN channel to bridge -> {status} {body.decode()[:200]}")

    status, body = ari_request(
        "POST", f"/bridges/{bridge_id}/addChannel?channel={extmedia_id}"
    )
    print(f"[{chan_id}] add externalMedia channel to bridge -> {status} {body.decode()[:200]}")

    bridge.ari_bridge_id = bridge_id
    bridge.extmedia_id = extmedia_id
    bridge.attempt_id = attempt_id

    if attempt_id:
        instructions = await fetch_call_context(attempt_id)
    else:
        # Manual/inbound test call with no orchestrator attempt attached — keep the
        # original generic behavior so ad-hoc testing (per ARCHITECTURE.md §9) still works.
        instructions = (
            "You are mushebi.ge's voice assistant. Speak Russian. Greet the caller "
            "naturally and ask how you can help."
        )

    loop = asyncio.get_event_loop()
    recv_task = asyncio.create_task(bridge.rtp_recv_loop(loop))
    send_task = asyncio.create_task(bridge.sender_loop())
    oa_task = asyncio.create_task(bridge.openai_session(instructions))
    return bridge, recv_task, send_task, oa_task


async def handle_originate(request):
    """POST /originate — called by lib/orchestrator/bridge-client.ts to start a
    context-specific outbound call. Separate port (not ARI's own 8088), bearer-secret
    authenticated."""
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {ORCHESTRATOR_BRIDGE_SECRET}":
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    attempt_id = body.get("attempt_id")
    phone = body.get("phone")
    caller_id = body.get("caller_id", "")

    if not attempt_id or not phone:
        return web.json_response({"ok": False, "error": "attempt_id and phone required"}, status=400)

    digits = phone.lstrip("+")
    status, resp_body = ari_request(
        "POST",
        f"/channels?endpoint=PJSIP/{digits}@citynet-endpoint"
        f"&extension=s&context=ai-dial&priority=1&app={APP}&callerId={caller_id}",
    )

    if status not in (200, 201):
        return web.json_response(
            {"ok": False, "error": f"ARI originate failed: {status} {resp_body.decode()[:200]}"},
            status=502,
        )

    try:
        parsed = json.loads(resp_body)
        chan_id = parsed["id"]
    except Exception:
        return web.json_response({"ok": False, "error": "could not parse ARI response"}, status=502)

    channel_to_attempt[chan_id] = attempt_id
    print(f"[{chan_id}] originate -> attempt_id={attempt_id}, phone={phone}")
    return web.json_response({"ok": True, "channel_id": chan_id})


async def run_http_server():
    app = web.Application()
    app.router.add_post("/originate", handle_originate)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", ORIGINATE_HTTP_PORT)
    await site.start()
    print(f"HTTP /originate server listening on :{ORIGINATE_HTTP_PORT}")


async def main():
    await run_http_server()

    auth = base64.b64encode(f"{ARI_USER}:{ARI_PASS}".encode()).decode()
    ws_url = f"ws://{ARI_HOST}/ari/events?app={APP}&subscribeAll=true"
    print(f"Connecting to {ws_url}")
    active = {}
    async with websockets.connect(ws_url, additional_headers={"Authorization": f"Basic {auth}"}) as ws:
        print("Connected. Waiting for calls...")
        async for message in ws:
            event = json.loads(message)
            etype = event.get("type")
            if etype == "StasisStart":
                channel = event["channel"]
                chan_id = channel["id"]
                chan_name = channel.get("name", "")
                # externalMedia's own child channel also fires StasisStart in this app -
                # ignore it here, it's handled as part of handle_call() for the parent call.
                if chan_name.startswith("UnicastRTP"):
                    continue
                if chan_id in seen_channels:
                    continue
                seen_channels.add(chan_id)
                attempt_id = channel_to_attempt.get(chan_id)
                bridge, recv_task, send_task, oa_task = await handle_call(chan_id, attempt_id)
                active[chan_id] = (bridge, recv_task, send_task, oa_task)
            elif etype == "StasisEnd":
                chan_id = event["channel"]["id"]
                if chan_id in active:
                    print(f"[{chan_id}] StasisEnd, tearing down bridge")
                    bridge, recv_task, send_task, oa_task = active.pop(chan_id)
                    bridge.stop()
                    recv_task.cancel()
                    send_task.cancel()
                    oa_task.cancel()
                    ari_request("DELETE", f"/bridges/{bridge.ari_bridge_id}")
                    ari_request("DELETE", f"/channels/{bridge.extmedia_id}")

                    attempt_id = channel_to_attempt.pop(chan_id, None)
                    if attempt_id:
                        asyncio.create_task(report_call_result(attempt_id, chan_id, bridge))


asyncio.run(main())
