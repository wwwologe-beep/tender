import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/admin/agent-feed?since=<ISO timestamp>&secret=<ADMIN_LIVE_SECRET>
// Polling feed for the live agent-activity viewer (app/admin/agents-live) — system_logs
// has no anon RLS policy on purpose (see 20260722_create_system_logs.sql, it's an internal
// diagnostic channel), so the browser can't subscribe to it directly via Supabase Realtime.
// This route reads it with the service role and forwards new rows since the client's last
// poll, gated by a dedicated secret (not the Telegram admin id, not the orchestrator bridge
// secret — this is a distinct, single-purpose credential for this one page).
export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.ADMIN_LIVE_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const since = req.nextUrl.searchParams.get('since');

  let query = supabaseAdmin
    .from('system_logs')
    .select('id, created_at, source, tag, level, order_id, message, data')
    .in('source', ['ai-agent', 'voice-call'])
    // simulate-voice-call.ts writes source:'voice-call' too (same tag namespace as real
    // calls, since it exercises the exact same prompt-building code) — exclude it here so
    // this live view only ever shows real production agent activity, not test runs.
    .neq('tag', 'simulate-voice-call')
    .order('created_at', { ascending: true })
    .limit(50);

  query = since ? query.gt('created_at', since) : query.order('created_at', { ascending: false }).limit(20);

  const { data, error } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Initial load (no `since`) fetches newest-first for a fast first paint, then needs
  // re-sorting to chronological order so the feed reads top-to-bottom like a log.
  const rows = since ? (data ?? []) : (data ?? []).slice().reverse();

  return NextResponse.json({ rows, serverTime: new Date().toISOString() });
}
