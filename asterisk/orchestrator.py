#!/usr/bin/env python3
"""
orchestrator.py — Persistent event loop for mushebi.ge
Runs on VPS 79.108.163.50 alongside Asterisk + voice_bridge.py

Event-driven: listens to Supabase Realtime for new orders,
coordinates outreach via Telegram → WhatsApp → Voice calls,
monitors active orders, handles completion.

Dependencies: pip install supabase asyncio aiohttp
"""

import os
import sys
import json
import time
import asyncio
import urllib.request
import urllib.error
import datetime
from typing import Dict, Any, Optional

try:
    from supabase import create_client, Client
except ImportError:
    print("ERROR: pip install supabase", file=sys.stderr)
    sys.exit(1)

try:
    import aiohttp
except ImportError:
    print("ERROR: pip install aiohttp", file=sys.stderr)
    sys.exit(1)

# ─── Config ──────────────────────────────────────────────────────────────────

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    print("ERROR: set SUPABASE_URL and SUPABASE_SERVICE_KEY", file=sys.stderr)
    sys.exit(1)

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
WAPPI_TOKEN = os.environ.get("WAPPI_TOKEN", "")
WAPPI_PROFILE = os.environ.get("WAPPI_PROFILE_ID", "")
ASTERISK_BRIDGE_URL = os.environ.get("ASTERISK_BRIDGE_URL", "http://127.0.0.1:8090")
ORCHESTRATOR_BRIDGE_SECRET = os.environ.get("ORCHESTRATOR_BRIDGE_SECRET", "")
CALLER_ID = os.environ.get("ORCHESTRATOR_CALLER_ID", "2115325")
MAX_CONCURRENT_CALLS = int(os.environ.get("ORCHESTRATOR_MAX_CONCURRENT_CALLS", "4"))
ORCHESTRATOR_TEST_PHONE = os.environ.get("ORCHESTRATOR_TEST_PHONE", "")

# SAFETY: when True, all outreach goes ONLY to admin (no real executor messages)
# Set ORCHESTRATOR_TEST_MODE=true in .env to enable test mode
TEST_MODE = os.environ.get("ORCHESTRATOR_TEST_MODE", "true").lower() in ("true", "1", "yes")
TEST_ADMIN_PHONE = os.environ.get("TEST_ADMIN_PHONE", "")  # your phone for test messages

# Category → specializations mapping (mirror of notification-queue.ts)
CATEGORY_TO_SPECS = {
    "moving": ["mover", "driver", "handyman", "moving"],
    "cleaning": ["cleaner", "handyman", "cleaning"],
    "repair": ["handyman", "repair", "builder"],
    "electrician": ["electrician", "handyman", "electrical"],
    "plumber": ["plumber", "handyman", "plumbing"],
    "courier": ["driver", "courier", "mover"],
    "furniture": ["mover", "handyman", "assembly", "moving"],
    "assembly": ["handyman", "assembly", "repair"],
    "general": ["mover", "driver", "handyman", "electrician", "plumber", "cleaner"],
}

# ─── Supabase helpers ────────────────────────────────────────────────────────

sb: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def sb_select(table, columns="*", filters=None, limit=50, order=None):
    q = sb.table(table).select(columns).limit(limit)
    if order:
        col, desc = order
        q = q.order(col, desc=desc)
    if filters:
        for col, val in filters.items():
            q = q.eq(col, val)
    return q.execute().data

def sb_insert(table, data):
    return sb.table(table).insert(data).execute().data

def sb_update(table, data, filters):
    q = sb.table(table).update(data)
    for col, val in filters.items():
        q = q.eq(col, val)
    return q.execute().data

def sb_rpc(fn, params):
    return sb.rpc(fn, params).execute().data

# ─── Telegram ────────────────────────────────────────────────────────────────

async def tg_send(chat_id: int, text: str):
    if not TELEGRAM_BOT_TOKEN:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    print(f"[tg] send failed: {resp.status} {body[:100]}")
    except Exception as e:
        print(f"[tg] error: {e}")

async def tg_notify_admin(text: str):
    admin_id = os.environ.get("TELEGRAM_ADMIN_ID", "")
    if admin_id:
        await tg_send(int(admin_id), f"🔔 <b>Orchestrator</b>\n\n{text}")

# ─── WhatsApp (Wappi.pro) ────────────────────────────────────────────────────

async def wa_send(phone: str, body: str):
    if not WAPPI_TOKEN or not WAPPI_PROFILE:
        return
    recipient = phone.lstrip("+")
    url = f"https://wappi.pro/api/sync/message/send?profile_id={WAPPI_PROFILE}"
    headers = {"Authorization": WAPPI_TOKEN, "Content-Type": "application/json"}
    payload = {"body": body, "recipient": recipient}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=15)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return data.get("status") == "done"
                return False
    except Exception as e:
        print(f"[wa] error: {e}")
        return False

# ─── Voice calls (Asterisk bridge) ───────────────────────────────────────────

async def originate_call(attempt_id: str, phone: str):
    if not ORCHESTRATOR_BRIDGE_SECRET:
        return False
    if ORCHESTRATOR_TEST_PHONE:
        print(f"[TEST MODE] Target phone overridden to {ORCHESTRATOR_TEST_PHONE}")
        phone = ORCHESTRATOR_TEST_PHONE
    url = f"{ASTERISK_BRIDGE_URL}/originate"
    headers = {"Authorization": f"Bearer {ORCHESTRATOR_BRIDGE_SECRET}", "Content-Type": "application/json"}
    payload = {"attempt_id": attempt_id, "phone": phone.lstrip("+"), "caller_id": CALLER_ID}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, headers=headers,
                                    timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return bool(data.get("channel_id"))
                return False
    except Exception as e:
        print(f"[call] error: {e}")
        return False

# ─── Matching ────────────────────────────────────────────────────────────────

def find_candidates(order: dict, limit: int = 10) -> list:
    """Find executors for an order. Returns list of (phone, name, source, score)."""
    category = order.get("category", "general")
    specs = CATEGORY_TO_SPECS.get(category, CATEGORY_TO_SPECS["general"])
    
    candidates = []
    
    # 1. Active drivers in Telegram
    drivers = sb_select("tender_drivers",
        "id,name,phone,specialization,rating,driver_language,telegram_id,subscription_expires_at",
        filters={"status": "active"}, limit=50, order=("rating", True))
    
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for d in drivers:
        sub = d.get("subscription_expires_at", "")
        has_sub = sub and sub > now
        if d.get("specialization") in specs or category == "general":
            score = float(d.get("rating", 5.0))
            if has_sub:
                score += 2
            candidates.append({
                "phone": d.get("phone", ""),
                "name": d.get("name", ""),
                "source": "telegram",
                "score": score,
                "driver_id": d.get("id"),
                "telegram_id": d.get("telegram_id"),
                "language": d.get("driver_language", "ru"),
            })
    
    # 2. Cold contacts (phone only, need to call)
    spec_filter = specs[0] if specs else "mover"
    cold = sb_select("cold_contacts",
        "id,phone,name,specialization",
        filters={"status": "active"}, limit=100)
    
    for c in cold:
        c_spec = c.get("specialization", "")
        if c_spec in specs or category == "general" or c_spec == "mover":
            candidates.append({
                "phone": c.get("phone", ""),
                "name": c.get("name", ""),
                "source": "cold_contact",
                "score": 3.0,  # base score for cold contacts
                "cold_contact_id": c.get("id"),
                "language": "ru",  # default
            })
    
    # Sort by score, dedup by phone, limit
    seen_phones = set()
    unique = []
    for c in sorted(candidates, key=lambda x: x["score"], reverse=True):
        phone = c["phone"]
        if phone and phone not in seen_phones:
            seen_phones.add(phone)
            unique.append(c)
        if len(unique) >= limit:
            break
    
    return unique

# ─── Order processing ────────────────────────────────────────────────────────

async def process_new_order(order_id: str):
    """Called when a new order is detected. Full outreach pipeline.
    Idempotent: uses 'orchestrator_flagged_at' to prevent reprocessing."""
    print(f"\n{'='*60}")
    print(f"[order] Processing {order_id}")
    
    # Mark order as processed IMMEDIATELY (atomic flag to prevent duplicates)
    try:
        sb.table("tender_orders").update({
            "orchestrator_flagged_at": datetime.datetime.now(datetime.timezone.utc).isoformat()
        }).eq("id", order_id).execute()
    except Exception as e:
        print(f"[order] flag error: {e}")
        return
    
    # Fetch order
    orders = sb_select("tender_orders",
        "id,order_number,token,status,category,cargo_description,live_brief_ai,client_phone,client_name",
        filters={"id": order_id}, limit=1)
    if not orders:
        print(f"[order] {order_id} not found")
        return
    
    order = orders[0]
    order_num = order.get("order_number", "?")
    category = order.get("category", "general")
    description = order.get("cargo_description", "") or order.get("live_brief_ai", "")
    client_phone = order.get("client_phone", "")
    token = order.get("token", "")
    
    print(f"[order] #{order_num} | category={category} | client={client_phone}")
    print(f"[order] Description: {description[:100]}")
    
    # Find candidates
    candidates = find_candidates(order, limit=15)
    print(f"[order] Found {len(candidates)} candidates")
    
    if not candidates:
        await tg_notify_admin(f"⚠️ Заказ #{order_num}: нет кандидатов!")
        return
    
    # Phase 1: Telegram push (instant, free)
    tg_candidates = [c for c in candidates if c["source"] == "telegram" and c.get("telegram_id")]
    print(f"[order] Telegram push: {len(tg_candidates)} drivers (test_mode={TEST_MODE})")
    
    if TEST_MODE:
        # In test mode: don't send to real executors, just log what would be sent
        await tg_notify_admin(
            f"🧪 TEST: Заказ #{order_num}\n\n"
            f"📋 {description[:200]}\n\n"
            f"TG recipients ({len(tg_candidates)}): " + 
            ", ".join([c["name"] for c in tg_candidates[:7]])
        )
        print(f"[order] TEST MODE: skipped TG push to {len(tg_candidates)} real drivers")
    else:
        for c in tg_candidates[:7]:
            lang = c.get("language", "ru")
            msg = f"📦 ЗАКАЗ #{order_num} — mushebi.ge\n\n📋 {description[:200]}\n\n💰 Слепые ставки\n\nПодробности: https://mushebi.ge/feed/{token}"
            await tg_send(c["telegram_id"], msg)
    
    # Phase 2: WhatsApp to cold contacts (after 5 min if no bids)
    cold_candidates = [c for c in candidates if c["source"] == "cold_contact"]
    print(f"[order] Cold contacts (WhatsApp in 5 min): {len(cold_candidates)} (test_mode={TEST_MODE})")
    
    # Schedule follow-up
    asyncio.create_task(schedule_followup(order_id, order_num, token, cold_candidates, description))

async def schedule_followup(order_id: str, order_num: int, token: str, cold_candidates: list, description: str):
    """Wait 5 min, check bids, then WhatsApp cold contacts if needed.
    In TEST_MODE: sends only to admin, not to real executors."""
    await asyncio.sleep(300)  # 5 minutes
    
    # Check if any bids exist
    bids = sb_select("tender_bids", "id", filters={"order_id": order_id}, limit=10)
    if len(bids) >= 2:
        print(f"[followup] #{order_num}: {len(bids)} bids already, skip WhatsApp")
        return
    
    print(f"[followup] #{order_num}: only {len(bids)} bids, sending WhatsApp to {len(cold_candidates)} cold contacts (test_mode={TEST_MODE})")
    
    feed_url = f"https://mushebi.ge/feed/{token}"
    msg = f"📦 Новый заказ #{order_num} — mushebi.ge\n\n📋 {description[:200]}\n\nПодробности и ставки: {feed_url}"
    
    if TEST_MODE:
        # In test mode: send summary to admin only, don't touch real contacts
        await tg_notify_admin(
            f"🧪 TEST FOLLOWUP: Заказ #{order_num}\n\n"
            f"Would send WhatsApp to {len(cold_candidates[:20])} cold contacts.\n"
            f"Message preview:\n{msg[:150]}"
        )
        print(f"[followup] TEST MODE: skipped WhatsApp to {len(cold_candidates[:20])} real contacts")
        return
    
    sent = 0
    for c in cold_candidates[:20]:  # Limit to 20
        phone = c["phone"]
        if not phone:
            continue
        ok = await wa_send(phone, msg)
        if ok:
            sent += 1
        await asyncio.sleep(2)  # Rate limit
    
    print(f"[followup] #{order_num}: WhatsApp sent to {sent}/{len(cold_candidates[:20])}")

# ─── Completion cycle ────────────────────────────────────────────────────────

async def completion_loop():
    """Every 5 min: find orders in 'selected' status, ask for rating."""
    while True:
        try:
            # Find selected orders older than 2 hours (work should be done)
            selected = sb_select("tender_orders",
                "id,order_number,client_phone,winning_bid_id,status,created_at",
                filters={"status": "selected"}, limit=20)
            
            now = time.time()
            for order in selected:
                created = order.get("created_at", "")
                # Parse ISO timestamp
                try:
                    created_ts = datetime.datetime.fromisoformat(created.replace("Z", "+00:00")).timestamp()
                except:
                    continue
                
                hours_elapsed = (now - created_ts) / 3600
                
                if hours_elapsed < 2:
                    continue  # Too soon
                
                # Check if we already asked for rating (look for a flag)
                order_id = order["id"]
                order_num = order.get("order_number", "?")
                client_phone = order.get("client_phone", "")
                
                # Check if order_questions already has a rating request
                # (We use a simple approach: check if there's a note in the order)
                
                # Send WhatsApp rating request
                if client_phone:
                    msg = f"✅ Заказ #{order_num} выполнен?\n\nОцените исполнителя 1-5:\nНапишите цифру."
                    
                    if TEST_MODE:
                        # In test mode: don't send to real client, just log
                        print(f"[completion] TEST MODE: #{order_num} would send rating to {client_phone} (skipped)")
                        # Don't auto-complete in test mode
                    else:
                        ok = await wa_send(client_phone, msg)
                        if ok:
                            print(f"[completion] #{order_num}: rating request sent to {client_phone}")
                            # Mark as completed (simplified — in production, wait for response)
                            # For now, auto-complete after sending
                            sb_update("tender_orders", {"status": "completed"}, {"id": order_id})
                            print(f"[completion] #{order_num}: marked as completed")
                
        except Exception as e:
            print(f"[completion] error: {e}")
        
        await asyncio.sleep(300)  # 5 min

# ─── Monitoring loop ─────────────────────────────────────────────────────────

async def monitor_loop():
    """Every 60 sec: check for NEW orders that need processing.
    Only orders created in the last 30 minutes — old orders are NOT reprocessed.
    Uses orchestrator_flagged_at for deduplication (NULL = not processed yet)."""
    
    while True:
        try:
            # Only orders newer than 30 minutes (prevents reprocessing 5 months of history)
            cutoff = (datetime.datetime.now(datetime.timezone.utc) - 
                      datetime.timedelta(minutes=30)).isoformat()
            
            recent = sb.table("tender_orders").select(
                "id,order_number,status,created_at,orchestrator_flagged_at"
            ).eq("status", "bidding").is_(
                "orchestrator_flagged_at", "null"
            ).gt("created_at", cutoff).order(
                "created_at", desc=True
            ).limit(5).execute()
            
            for order in recent.data:
                oid = order["id"]
                # Process in background
                asyncio.create_task(process_new_order(oid))
                
        except Exception as e:
            print(f"[monitor] error: {e}")
        
        await asyncio.sleep(60)  # Check every minute

# ─── Health check ────────────────────────────────────────────────────────────

async def health_loop():
    """Every 5 min: check if voice_bridge is alive."""
    while True:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(f"{ASTERISK_BRIDGE_URL}/health",
                                       timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    if resp.status != 200:
                        await tg_notify_admin("⚠️ voice_bridge не отвечает!")
        except Exception:
            # Bridge might not have /health endpoint, that's ok
            pass
        
        await asyncio.sleep(300)

# ─── Main ────────────────────────────────────────────────────────────────────

async def main():
    print("""
╔══════════════════════════════════════════════════════════╗
║          mushebi.ge ORCHESTRATOR — STARTED               ║
║                                                          ║
║  Event-driven order processing                           ║
║  Telegram → WhatsApp → Voice → Completion                ║
║  VPS 79.108.163.50                                       ║
╚══════════════════════════════════════════════════════════╝
    """)
    
    # Start background loops
    asyncio.create_task(monitor_loop())
    asyncio.create_task(completion_loop())
    asyncio.create_task(health_loop())
    
    # Notify admin
    contacts_count = len(sb_select("cold_contacts", "id", limit=500))
    drivers_count = len(sb_select("tender_drivers", "id", filters={"status": "active"}, limit=50))
    mode_label = "🧪 TEST MODE (no real messages)" if TEST_MODE else "🚀 PRODUCTION (real outreach)"
    await tg_notify_admin(
        f"✅ Orchestrator запущен\n\n"
        f"Mode: {mode_label}\n"
        f"База: {drivers_count} активных в TG, {contacts_count} холодных контактов\n"
        f"Каналы: Telegram + WhatsApp + Voice\n"
        f"Монитор: новые заказы за последние 30 мин (старые не обрабатываются)\n"
        f"Готов принимать заказы."
    )
    
    # Keep running forever
    while True:
        await asyncio.sleep(3600)

if __name__ == "__main__":
    asyncio.run(main())
