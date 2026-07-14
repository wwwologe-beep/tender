"""
Asterisk ARI + externalMedia <-> OpenAI Realtime API bridge.

Flow:
1. Listen on ARI websocket for StasisStart on a real PSTN channel (not externalMedia child channels).
2. Answer the channel, create an externalMedia channel (ulaw, RTP) pointed at our local UDP port.
3. Open an OpenAI Realtime WebSocket session (model gpt-realtime), configured for g711_ulaw in/out.
4. Bridge RTP audio <-> Realtime audio in both directions.
5. On call hangup (StasisEnd), tear down the Realtime session and RTP socket.

Deploy: this file lives on the Asterisk server at /root/voice_bridge.py (79.108.163.50).
Run with:
    export ARI_PASS=<ari password, see memory/asterisk-telephony.md>
    export OPENAI_API_KEY=$(cat /root/.openai_key)
    nohup python3 -u /root/voice_bridge.py > /root/voice_bridge.log 2>&1 &
"""
import asyncio
import json
import base64
import struct
import socket
import os
import sys
import urllib.request
import urllib.error
import websockets

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

RTP_LOCAL_HOST = "127.0.0.1"
RTP_LOCAL_PORT = 40000

seen_channels = set()


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


FRAME_BYTES = 160  # 20ms of 8kHz u-law
FRAME_SECONDS = 0.02


class RTPBridge:
    """Handles one call's RTP <-> OpenAI Realtime audio bridging."""

    def __init__(self, chan_id):
        self.chan_id = chan_id
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((RTP_LOCAL_HOST, RTP_LOCAL_PORT))
        self.sock.setblocking(False)
        self.remote_addr = None
        self.seq = 0
        self.timestamp = 0
        self.ssrc = 0x1234ABCD
        self.running = True
        self.oa_ws = None
        self.out_buffer = bytearray()  # raw ulaw bytes pending transmission, paced by sender_loop

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

    async def openai_session(self):
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
                    "instructions": (
                        "შენ ხარ mushebi.ge-ს ხმოვანი ასისტენტი — საქართველოში "
                        "საყოფაცხოვრებო მომსახურების შემსრულებლების საძიებო სერვისი. "
                        "ილაპარაკე ქართულად ბუნებრივად და არაფორმალურად, როგორც "
                        "ჩვეულებრივ სატელეფონო საუბარში: მოკლე ფრაზები, ცოცხალი "
                        "ინტონაცია. თუ გკითხავენ, პატიოსნად უპასუხე, რომ ხარ AI "
                        "ასისტენტი. არ ჟღერდე დიქტორივით ან ავტომოპასუხესავით. "
                        "დაიწყე მოკლე მისალმებით და ჰკითხე, ყველაფერი წესრიგშია თუ "
                        "არა შეკვეთასთან დაკავშირებით, შემდეგ მოუსმინე მოსაუბრეს "
                        "პასუხს და აწარმოე ცოცხალი დიალოგი."
                    ),
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
                elif etype == "input_audio_buffer.speech_started":
                    print(f"[{self.chan_id}] speech_started -> interrupting AI (barge-in)")
                    self.out_buffer.clear()
                elif etype == "error":
                    print(f"[{self.chan_id}] OpenAI error: {event}")
                if not self.running:
                    break

    def stop(self):
        self.running = False
        try:
            self.sock.close()
        except Exception:
            pass


async def handle_call(chan_id):
    print(f"[{chan_id}] handling new call")
    status, body = ari_request("POST", f"/channels/{chan_id}/answer")
    print(f"[{chan_id}] answer -> {status}")

    extmedia_id = f"extmedia-{chan_id}"
    status, body = ari_request(
        "POST",
        f"/channels/externalMedia?app={APP}&external_host={RTP_LOCAL_HOST}:{RTP_LOCAL_PORT}"
        f"&format=ulaw&channelId={extmedia_id}",
    )
    print(f"[{chan_id}] externalMedia -> {status} {body.decode()}")

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

    bridge = RTPBridge(chan_id)
    bridge.ari_bridge_id = bridge_id
    bridge.extmedia_id = extmedia_id
    loop = asyncio.get_event_loop()
    recv_task = asyncio.create_task(bridge.rtp_recv_loop(loop))
    send_task = asyncio.create_task(bridge.sender_loop())
    oa_task = asyncio.create_task(bridge.openai_session())
    return bridge, recv_task, send_task, oa_task


async def main():
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
                bridge, recv_task, send_task, oa_task = await handle_call(chan_id)
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


asyncio.run(main())
