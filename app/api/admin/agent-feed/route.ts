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

  function baseQuery() {
    return supabaseAdmin
      .from('system_logs')
      .select('id, created_at, source, tag, level, order_id, message, data')
      .in('source', ['ai-agent', 'voice-call'])
      // simulate-voice-call.ts writes source:'voice-call' with the exact same tags as real
      // calls (it calls buildVoiceCallInstructions() directly to test the real prompt) — the
      // tag alone can't tell a test run apart from production. It always passes this fixed
      // placeholder name, though, so filter on that instead of the tag.
      .not('message', 'ilike', '%Симулированный исполнитель%')
      .neq('tag', 'simulate-voice-call');
  }

  const { data, error } = since
    ? await baseQuery().gt('created_at', since).order('created_at', { ascending: true }).limit(50)
    : await baseQuery().order('created_at', { ascending: false }).limit(20);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Initial load (no `since`) fetches newest-first for a fast first paint, then needs
  // re-sorting to chronological order so the feed reads top-to-bottom like a log.
  const rows = since ? (data ?? []) : (data ?? []).slice().reverse();

  return NextResponse.json({ rows, serverTime: new Date().toISOString() });
}
