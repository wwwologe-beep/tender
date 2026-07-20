"""
Client Assistant voice bridge — calls the CLIENT (not the driver) to collect a missing detail
flagged by a driver via voice_bridge.py's ask_client_question tool (see PROJECT.md's Client
Assistant / clarification_status state machine).

This is a skeleton, built alongside voice_bridge.py and reusing its ARI/externalMedia/OpenAI
Realtime plumbing (see that file's docstring for the full call-audio architecture — answer,
externalMedia, mixing bridge, RTP<->Realtime audio pump, barge-in). Runs as its OWN Stasis app
("ai-telephony-client", vs. voice_bridge.py's "ai-telephony") so the two processes' ARI
WebSocket subscriptions don't see each other's StasisStart/StasisEnd events — each dialplan
context routes to exactly one app (see /etc/asterisk/extensions.conf's [ai-dial-client]).
What's DIFFERENT here:
- Calls tender_orders.client_phone, not a driver/cold_contact number.
- Reads tender_orders.missing_info (set by app/api/orchestrator/ask-question/route.ts when a
  driver asks a question mid-call) to know what to ask instead of fetching call-context.
- Smaller tool set: just report_clarification_result to record the client's answer and end the
  call. No report_outcome/ask_client_question/pricing — this agent doesn't negotiate or sell,
  per its system prompt.
- No orchestrator sequence/candidate machinery (order_call_sequences, call_candidates) — this is
  a single one-shot call per order, triggered manually for now (see run_http_server below).

NOT YET WIRED to any automatic trigger (e.g. a cron tick watching clarification_status=
'clarifying') — that's the next step once this skeleton is confirmed to work end-to-end, per the
plan's "we're preparing infrastructure first" framing.

Deploy: alongside voice_bridge.py on the Asterisk server (79.108.163.50), same env vars
(ARI_PASS, OPENAI_API_KEY, ORCHESTRATOR_BRIDGE_SECRET, NEXTJS_APP_URL), plus its own HTTP port
(CLIENT_BRIDGE_PORT, default 8091, separate from voice_bridge.py's 8090 so both can run at once).
    nohup python3 -u /root/client_bridge.py > /root/client_bridge.log 2>&1 &
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
from datetime import datetime, timezone
import websockets
from aiohttp import web

ARI_HOST = "127.0.0.1:8088"
ARI_USER = "aiuser"
ARI_PASS = os.environ.get("ARI_PASS")
if not ARI_PASS:
    print("ERROR: set ARI_PASS env var before running this script", file=sys.stderr)
    sys.exit(1)
APP = "ai-telephony-client"

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    print("ERROR: set OPENAI_API_KEY env var before running this script", file=sys.stderr)
    sys.exit(1)
OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?model=gpt-realtime"

ORCHESTRATOR_BRIDGE_SECRET = os.environ.get("ORCHESTRATOR_BRIDGE_SECRET")
if not ORCHESTRATOR_BRIDGE_SECRET:
    print("ERROR: set ORCHESTRATOR_BRIDGE_SECRET env var before running this script", file=sys.stderr)
    sys.exit(1)
NEXTJS_APP_URL = os.environ.get("NEXTJS_APP_URL", "https://tender-navy.vercel.app")
ORCHESTRATOR_TEST_PHONE = os.environ.get("ORCHESTRATOR_TEST_PHONE", "")

RTP_LOCAL_HOST = "127.0.0.1"
CLIENT_BRIDGE_PORT = int(os.environ.get("CLIENT_BRIDGE_PORT", "8091"))

FRAME_BYTES = 160  # 20ms of 8kHz u-law
FRAME_SECONDS = 0.02

CLIENT_ASSISTANT_SYSTEM_PROMPT = (
    "Ты — помощник сервиса Mushebi.ge. Твоя задача — собрать уточняющие детали по заказу "
    "(указано ниже в разделе 'Что нужно уточнить'), чтобы исполнитель мог дать точную цену. "
    "Будь вежлив, деловит и краток. Ты администратор заказа. Представься, уточни деталь, "
    "запиши ответ и заверши разговор. Не пытайся продать услугу — заказ уже есть.\n\n"
    "Что нужно уточнить: {missing_info}"
)

REPORT_CLARIFICATION_RESULT_TOOL = {
    "type": "function",
    "name": "report_clarification_result",
    "description": (
        "Call this once you have the client's answer to the missing detail (or if they refuse/"
        "are unavailable). Always call this before ending the conversation."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "answer": {
                "type": "string",
                "description": "The client's answer, in their own words, or empty if unobtainable",
            },
            "reached": {
                "type": "boolean",
                "description": "false if the client never actually answered/picked up meaningfully",
            },
        },
        "required": ["reached"],
    },
}


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


def fetch_order_for_clarification(order_id):
    """Reads client_phone + missing_info directly from Supabase via a small Next.js endpoint
    (GET /api/orchestrator/clarification-context/:orderId — not yet built, see TODO below).
    Placeholder for now: this skeleton assumes the caller of /originate already knows the phone
    and missing_info (passed directly in the request body) rather than fetching them itself,
    since the context-fetch endpoint doesn't exist yet. Kept as a separate function so wiring in
    a real fetch later is a one-line change at the call site in handle_originate."""
    raise NotImplementedError(
        "clarification-context endpoint not built yet — /originate must be called with "
        "client_phone and missing_info already in the body for this skeleton"
    )


class RTPBridge:
    """Same RTP<->Realtime audio bridging as voice_bridge.py's RTPBridge — see that file for
    the detailed reasoning behind pacing/bridging/barge-in. Kept as a near-duplicate rather than
    a shared import for now, since the two scripts are deployed and run independently on the
    VPS; extracting a shared module is a reasonable follow-up once both are stable."""

    def __init__(self, chan_id):
        self.chan_id = chan_id
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((RTP_LOCAL_HOST, 0))
        self.local_port = self.sock.getsockname()[1]
        self.sock.setblocking(False)
        self.remote_addr = None
        self.seq = 0
        self.timestamp = 0
        self.ssrc = 0x5678CDEF
        self.running = True
        self.oa_ws = None
        self.out_buffer = bytearray()
        self.tool_result = None  # populated by report_clarification_result
        self.call_started_at = time.monotonic()
        self.order_id = None
        self.transcript = []

    async def rtp_recv_loop(self, loop):
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
            payload = data[12:]
            if self.oa_ws is not None:
                try:
                    await self.oa_ws.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(payload).decode(),
                    }))
                except Exception as e:
                    print(f"[{self.chan_id}] error sending to OpenAI: {e}")

    def enqueue_audio(self, ulaw_bytes):
        self.out_buffer.extend(ulaw_bytes)

    async def sender_loop(self):
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
            "!HII", self.seq & 0xFFFF, self.timestamp & 0xFFFFFFFF, self.ssrc,
        )
        packet = header + ulaw_bytes
        try:
            self.sock.sendto(packet, self.remote_addr)
        except Exception as e:
            print(f"[{self.chan_id}] error sending RTP: {e}")
        self.seq += 1
        self.timestamp += FRAME_BYTES

    async def openai_session(self, instructions, tools):
        headers = {"Authorization": f"Bearer {OPENAI_API_KEY}"}
        print(f"[{self.chan_id}] connecting to OpenAI Realtime...")
        async with websockets.connect(
            OPENAI_REALTIME_URL, additional_headers=headers, max_size=2**23,
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
                            "transcription": {"model": "whisper-1"},
                        },
                        "output": {"format": {"type": "audio/pcmu"}, "voice": "cedar"},
                    },
                    "instructions": instructions,
                    "tools": tools,
                },
            }))
            print(f"[{self.chan_id}] OpenAI session configured, waiting for events...")
            async for message in ws:
                event = json.loads(message)
                etype = event.get("type")
                if etype == "session.created":
                    print(f"[{self.chan_id}] OpenAI session created -> triggering greeting")
                    await ws.send(json.dumps({"type": "response.create"}))
                elif etype == "response.output_audio.delta":
                    audio_b64 = event.get("delta")
                    if audio_b64:
                        self.enqueue_audio(base64.b64decode(audio_b64))
                elif etype == "response.done":
                    print(f"[{self.chan_id}] response.done")
                    self._extract_tool_result(event)
                elif etype == "response.output_audio_transcript.done":
                    self._record_transcript("ai", event.get("transcript", ""))
                elif etype == "conversation.item.input_audio_transcription.completed":
                    self._record_transcript("user", event.get("transcript", ""))
                elif etype == "input_audio_buffer.speech_started":
                    print(f"[{self.chan_id}] speech_started -> interrupting AI (barge-in)")
                    self.out_buffer.clear()
                elif etype == "error":
                    print(f"[{self.chan_id}] OpenAI error: {event}")
                if not self.running:
                    break

    def _record_transcript(self, role, text):
        text = (text or "").strip()
        if not text:
            return
        self.transcript.append({
            "role": role, "text": text,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    def _extract_tool_result(self, response_done_event):
        try:
            output = response_done_event.get("response", {}).get("output", [])
            for item in output:
                if item.get("type") != "function_call":
                    continue
                if item.get("name") != "report_clarification_result":
                    continue
                args = json.loads(item.get("arguments", "{}"))
                self.tool_result = args
                print(f"[{self.chan_id}] report_clarification_result: {args}")
        except Exception as e:
            print(f"[{self.chan_id}] error extracting tool result: {e}")

    def stop(self):
        self.running = False
        try:
            self.sock.close()
        except Exception:
            pass


async def report_clarification_result(order_id, bridge):
    """POST clarification result back to Next.js. Endpoint not built yet — see TODO in
    handle_originate; this call is a placeholder describing the intended contract so wiring the
    real endpoint later is a one-line addition, not a redesign."""
    payload = {
        "order_id": order_id,
        "answer": (bridge.tool_result or {}).get("answer"),
        "reached": (bridge.tool_result or {}).get("reached", False),
        "transcript": bridge.transcript,
    }
    status = nextjs_post("/api/orchestrator/clarification-result", payload)
    print(f"[{order_id}] reported clarification result -> Next.js status={status}")


async def handle_call(chan_id, order_id, missing_info):
    print(f"[{chan_id}] handling clarification call (order_id={order_id})")
    status, body = ari_request("POST", f"/channels/{chan_id}/answer")
    print(f"[{chan_id}] answer -> {status}")

    bridge = RTPBridge(chan_id)
    bridge.order_id = order_id

    extmedia_id = f"extmedia-{chan_id}"
    status, body = ari_request(
        "POST",
        f"/channels/externalMedia?app={APP}&external_host={RTP_LOCAL_HOST}:{bridge.local_port}"
        f"&format=ulaw&channelId={extmedia_id}",
    )
    print(f"[{chan_id}] externalMedia -> {status} (local_port={bridge.local_port})")

    bridge_id = f"bridge-{chan_id}"
    ari_request("POST", f"/bridges?type=mixing&bridgeId={bridge_id}")
    ari_request("POST", f"/bridges/{bridge_id}/addChannel?channel={chan_id}")
    ari_request("POST", f"/bridges/{bridge_id}/addChannel?channel={extmedia_id}")
    bridge.ari_bridge_id = bridge_id
    bridge.extmedia_id = extmedia_id

    instructions = CLIENT_ASSISTANT_SYSTEM_PROMPT.format(missing_info=missing_info)
    tools = [REPORT_CLARIFICATION_RESULT_TOOL]

    loop = asyncio.get_event_loop()
    recv_task = asyncio.create_task(bridge.rtp_recv_loop(loop))
    send_task = asyncio.create_task(bridge.sender_loop())
    oa_task = asyncio.create_task(bridge.openai_session(instructions, tools))
    return bridge, recv_task, send_task, oa_task


channel_to_order = {}
channel_to_missing_info = {}
seen_channels = set()


async def handle_originate(request):
    """POST /originate — starts a clarification call to a client.

    TODO: this currently requires the caller to already know client_phone and missing_info
    (e.g. read them from tender_orders itself before calling this endpoint), since
    fetch_order_for_clarification()/GET call-context aren't built yet — see that function's
    docstring. Once clarification_status='clarifying' has an automatic trigger (a cron tick,
    mirroring lib/orchestrator/tick.ts), this endpoint should instead accept just order_id and
    fetch phone/missing_info itself, the way voice_bridge.py's /originate + call-context works
    today for driver calls."""
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {ORCHESTRATOR_BRIDGE_SECRET}":
        return web.json_response({"ok": False, "error": "unauthorized"}, status=401)

    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid json"}, status=400)

    order_id = body.get("order_id")
    phone = body.get("client_phone")
    missing_info = body.get("missing_info", "")
    caller_id = body.get("caller_id", "")

    if not order_id or not phone:
        return web.json_response({"ok": False, "error": "order_id and client_phone required"}, status=400)

    if ORCHESTRATOR_TEST_PHONE:
        print(f"[TEST MODE] Target phone overridden to {ORCHESTRATOR_TEST_PHONE}")
        phone = ORCHESTRATOR_TEST_PHONE

    digits = phone.lstrip("+")
    status, resp_body = ari_request(
        "POST",
        f"/channels?endpoint=PJSIP/{digits}@citynet-endpoint"
        f"&extension=s&context=ai-dial-client&priority=1&app={APP}&callerId={caller_id}",
    )

    if status not in (200, 201):
        return web.json_response(
            {"ok": False, "error": f"ARI originate failed: {status} {resp_body.decode()[:200]}"},
            status=502,
        )

    try:
        chan_id = json.loads(resp_body)["id"]
    except Exception:
        return web.json_response({"ok": False, "error": "could not parse ARI response"}, status=502)

    channel_to_order[chan_id] = order_id
    channel_to_missing_info[chan_id] = missing_info
    print(f"[{chan_id}] originate -> order_id={order_id}, phone={phone}")
    return web.json_response({"ok": True, "channel_id": chan_id})


async def run_http_server():
    app = web.Application()
    app.router.add_post("/originate", handle_originate)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", CLIENT_BRIDGE_PORT)
    await site.start()
    print(f"HTTP /originate server listening on :{CLIENT_BRIDGE_PORT}")


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
                if chan_name.startswith("UnicastRTP"):
                    continue
                if chan_id in seen_channels:
                    continue
                seen_channels.add(chan_id)
                order_id = channel_to_order.get(chan_id)
                missing_info = channel_to_missing_info.pop(chan_id, "")
                if not order_id:
                    continue  # not a call we originated (unexpected on this app, but be safe)
                bridge, recv_task, send_task, oa_task = await handle_call(chan_id, order_id, missing_info)
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

                    order_id = channel_to_order.pop(chan_id, None)
                    if order_id:
                        asyncio.create_task(report_clarification_result(order_id, bridge))


asyncio.run(main())
