'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

// /admin/agents-live?secret=<ADMIN_LIVE_SECRET>
// Live viewer for what every AI agent (text + voice) actually sent to and got back from
// its model, in the order it happened. Polls /api/admin/agent-feed (service-role read of
// system_logs — see that route for why this isn't a direct Supabase Realtime subscription)
// every few seconds and appends new rows, newest at the bottom, auto-scrolling unless the
// user has scrolled up to read something.

interface FeedRow {
  id: string;
  created_at: string;
  source: 'ai-agent' | 'voice-call';
  tag: string;
  level: string;
  order_id: string | null;
  message: string;
  data: unknown;
}

const POLL_MS = 4000;

function extractPromptResponse(row: FeedRow): { prompt: string | null; response: string | null } {
  const d = row.data as Record<string, unknown> | null;
  if (!d) return { prompt: null, response: null };

  // Text agents (lib/ai.ts, lib/ai-advisor.ts): { messages: [...], response: string }
  if (Array.isArray(d.messages)) {
    const sys = (d.messages as Array<{ role: string; content: string }>).find(m => m.role === 'system');
    const user = (d.messages as Array<{ role: string; content: string }>).filter(m => m.role !== 'system');
    const prompt = [sys?.content, ...user.map(m => `[${m.role}] ${m.content}`)].filter(Boolean).join('\n\n');
    return { prompt, response: typeof d.response === 'string' ? d.response : null };
  }

  // Voice agents (lib/orchestrator/prompts.ts): { systemPrompt: string, candidateName, ... }
  if (typeof d.systemPrompt === 'string') {
    return { prompt: d.systemPrompt, response: null };
  }

  return { prompt: null, response: null };
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function AgentsLivePage() {
  return (
    <Suspense fallback={null}>
      <AgentsLiveInner />
    </Suspense>
  );
}

function AgentsLiveInner() {
  const secret = useSearchParams().get('secret') ?? '';
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'loading' | 'live' | 'error' | 'unauthorized'>('loading');
  const [paused, setPaused] = useState(false);
  const lastSeenRef = useRef<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  useEffect(() => {
    if (!secret) { setStatus('unauthorized'); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const url = new URL('/api/admin/agent-feed', window.location.origin);
        url.searchParams.set('secret', secret);
        if (lastSeenRef.current) url.searchParams.set('since', lastSeenRef.current);

        const res = await fetch(url.toString());
        if (res.status === 401) { setStatus('unauthorized'); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const { rows: newRows } = await res.json() as { rows: FeedRow[] };
        if (cancelled) return;

        if (newRows.length > 0) {
          lastSeenRef.current = newRows[newRows.length - 1].created_at;
          setRows(prev => [...prev, ...newRows].slice(-200));
        }
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('error');
      } finally {
        if (!cancelled && !paused) timer = setTimeout(poll, POLL_MS);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [secret, paused]);

  useEffect(() => {
    if (!userScrolledUpRef.current) {
      listEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [rows]);

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledUpRef.current = !nearBottom;
  }

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  if (status === 'unauthorized') {
    return (
      <div style={styles.centerScreen}>
        <p style={{ color: '#97a3b8', fontFamily: MONO }}>
          Нужен ?secret=... в адресе страницы.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>mushebi.ge · admin</div>
          <h1 style={styles.h1}>Агенты в реальном времени</h1>
        </div>
        <div style={styles.headerRight}>
          <span style={{ ...styles.statusDot, background: status === 'live' ? '#6fcf97' : status === 'error' ? '#d9647a' : '#5c6884' }} />
          <span style={styles.statusText}>
            {status === 'live' ? 'обновляется' : status === 'error' ? 'ошибка соединения' : 'загрузка…'}
          </span>
          <button style={styles.pauseBtn} onClick={() => setPaused(p => !p)}>
            {paused ? '▶ продолжить' : '⏸ пауза'}
          </button>
        </div>
      </header>

      <div style={styles.feed} onScroll={handleScroll}>
        {rows.length === 0 && status === 'live' && (
          <p style={{ color: '#5c6884', fontFamily: MONO, fontSize: 13 }}>
            Пока тихо — ждём, когда сработает любой агент (заказ, вопрос, звонок...).
          </p>
        )}
        {rows.map(row => {
          const { prompt, response } = extractPromptResponse(row);
          const isOpen = expanded.has(row.id);
          const isVoice = row.source === 'voice-call';
          return (
            <div key={row.id} style={{ ...styles.card, borderColor: isVoice ? 'rgba(240,169,96,0.4)' : '#262e3d' }}>
              <div style={styles.cardHead} onClick={() => toggle(row.id)}>
                <span style={styles.time}>{timeLabel(row.created_at)}</span>
                <span style={{ ...styles.tag, color: isVoice ? '#f0a960' : '#5ec8ff' }}>{row.tag}</span>
                <span style={styles.msgPreview}>{row.message.slice(0, 90)}</span>
                <span style={styles.chev}>{isOpen ? '▾' : '▸'}</span>
              </div>
              {isOpen && (
                <div style={styles.cardBody}>
                  {prompt && (
                    <div>
                      <div style={styles.label}>отправлено модели</div>
                      <pre style={styles.pre}>{prompt}</pre>
                    </div>
                  )}
                  {response && (
                    <div>
                      <div style={styles.label}>получено от модели</div>
                      <pre style={styles.pre}>{response}</pre>
                    </div>
                  )}
                  {!prompt && !response && (
                    <pre style={styles.pre}>{JSON.stringify(row.data, null, 2)}</pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <div ref={listEndRef} />
      </div>
    </div>
  );
}

const MONO = "'SF Mono', 'JetBrains Mono', Consolas, monospace";

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0e1117', color: '#e8ecf3', fontFamily: '-apple-system, sans-serif', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #1d2431', flexShrink: 0 },
  eyebrow: { fontFamily: "'SF Mono', monospace", fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 4 },
  h1: { fontSize: 18, fontWeight: 650, margin: 0 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 10 },
  statusDot: { width: 8, height: 8, borderRadius: '50%' },
  statusText: { fontFamily: "'SF Mono', monospace", fontSize: 11.5, color: '#97a3b8' },
  pauseBtn: { fontFamily: "'SF Mono', monospace", fontSize: 11.5, color: '#97a3b8', background: '#171d28', border: '1px solid #262e3d', borderRadius: 6, padding: '5px 10px', cursor: 'pointer', marginLeft: 8 },
  feed: { flex: 1, overflowY: 'auto', padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: '#171d28', border: '1px solid #262e3d', borderRadius: 9, overflow: 'hidden' },
  cardHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '9px 13px', cursor: 'pointer' },
  time: { fontFamily: "'SF Mono', monospace", fontSize: 11, color: '#5c6884', flexShrink: 0 },
  tag: { fontFamily: "'SF Mono', monospace", fontSize: 11.5, fontWeight: 600, flexShrink: 0 },
  msgPreview: { fontSize: 12.5, color: '#97a3b8', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chev: { color: '#5c6884', flexShrink: 0 },
  cardBody: { padding: '0 13px 13px', display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontFamily: "'SF Mono', monospace", fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 5 },
  pre: { fontFamily: "'SF Mono', monospace", fontSize: 11.5, lineHeight: 1.6, color: '#c3cbdb', background: '#10141c', border: '1px solid #1d2431', borderRadius: 7, padding: '10px 12px', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 300, overflowY: 'auto' },
  centerScreen: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0e1117' },
};
