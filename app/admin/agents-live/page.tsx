'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

// /admin/agents-live?secret=<ADMIN_LIVE_SECRET>
// Живая архитектурная схема (не лог) — узлы графа подсвечиваются в момент, когда
// соответствующий агент реально сработал на проде. Polls /api/admin/agent-feed
// (service-role read of system_logs) every few seconds.

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

const POLL_MS = 3000;
const FLASH_MS = 5000; // как долго узел остаётся "горячим" после срабатывания

// ── Граф узлов, привязанный к тем же 4 этапам, что в предыдущей статичной схеме ──
interface NodeDef { id: string; label: string; kind: 'actor' | 'text' | 'voice' | 'db'; tags: string[] }
interface StageDef { title: string; nodes: NodeDef[] }

const STAGES: StageDef[] = [
  {
    title: 'Этап 1 — заявка появляется',
    nodes: [
      { id: 'n-analyzer', label: 'Order Analyzer', kind: 'text', tags: ['ai.analyzeOrder'] },
      { id: 'n-gatekeeper', label: 'Completeness Gatekeeper', kind: 'text', tags: ['ai.validateOrderCompleteness'] },
      { id: 'n-order-db', label: 'tender_orders создан', kind: 'db', tags: [] },
    ],
  },
  {
    title: 'Этап 2 — исполнители узнают и торгуются',
    nodes: [
      { id: 'n-v1', label: 'Звонок-предложение', kind: 'voice', tags: ['orchestrator.buildVoiceCallInstructions'] },
      { id: 'n-callresult', label: 'Итог звонка', kind: 'db', tags: ['orchestrator.call-result'] },
    ],
  },
  {
    title: 'Этап 3 — уточнение деталей',
    nodes: [
      { id: 'n-faqtr', label: 'FAQ Translator', kind: 'text', tags: ['ai.translateFaqEntry'] },
      { id: 'n-anstr', label: 'Answer Translator', kind: 'text', tags: ['ai.translateFaqAnswer'] },
      { id: 'n-rebuild', label: 'FAQ Rebuilder', kind: 'text', tags: ['ai-advisor.rebuildOrderFaq'] },
      { id: 'n-chattr', label: 'Chat Translator', kind: 'text', tags: ['ai.translateChatMessage'] },
      { id: 'n-advisor', label: 'Driver / Client Advisor', kind: 'text', tags: ['ai-advisor.chatWithAdvisor(role=driver)', 'ai-advisor.chatWithAdvisor(role=client)'] },
      { id: 'n-v4v5', label: 'Входящий звонок', kind: 'voice', tags: ['orchestrator.create-order-from-call'] },
    ],
  },
  {
    title: 'Этап 4 — выбор победителя',
    nodes: [
      { id: 'n-greeter', label: 'WhatsApp Greeter', kind: 'text', tags: ['ai.generateWhatsAppGreeting'] },
      { id: 'n-v3', label: 'Звонок-подтверждение', kind: 'voice', tags: [] },
    ],
  },
];

const ALL_NODES = STAGES.flatMap(s => s.nodes);

function nodeForTag(tag: string): NodeDef | null {
  return ALL_NODES.find(n => n.tags.includes(tag)) ?? null;
}

const AGENT_NAMES: Record<string, string> = {
  'ai.analyzeOrder': 'Order Analyzer',
  'ai.translateFaqEntry': 'FAQ Translator',
  'ai.translateFaqAnswer': 'Answer Translator',
  'ai.translateChatMessage': 'Chat Translator',
  'ai.validateOrderCompleteness': 'Completeness Gatekeeper',
  'ai.generateWhatsAppGreeting': 'WhatsApp Greeter',
  'ai-advisor.chatWithAdvisor(role=driver)': 'Advisor (исполнителю)',
  'ai-advisor.chatWithAdvisor(role=client)': 'Advisor (клиенту)',
  'ai-advisor.rebuildOrderFaq': 'FAQ Rebuilder',
  'orchestrator.buildVoiceCallInstructions': 'Звонок-предложение — готовит промпт',
  'orchestrator.call-result': 'Звонок завершён',
  'orchestrator.create-order-from-call': 'Входящий звонок создал заказ',
};

function agentLabel(tag: string): string {
  return AGENT_NAMES[tag] ?? tag;
}

type ParsedEvent =
  | { kind: 'text-call'; prompt: string; response: string | null }
  | { kind: 'voice-prompt'; prompt: string; candidate: string | null }
  | { kind: 'voice-result'; outcome: string | null; transcript: Array<{ role: string; text: string }> | null }
  | { kind: 'order-from-call'; description: string | null; phone: string | null; category: string | null }
  | { kind: 'raw'; data: unknown };

function parseEvent(row: FeedRow): ParsedEvent {
  const d = row.data as Record<string, unknown> | null;
  if (!d) return { kind: 'raw', data: null };

  if (row.tag === 'orchestrator.call-result') {
    const transcript = Array.isArray(d.transcript) ? (d.transcript as Array<{ role: string; text: string }>) : null;
    return { kind: 'voice-result', outcome: typeof d.outcome === 'string' ? d.outcome : null, transcript };
  }
  if (row.tag === 'orchestrator.create-order-from-call') {
    return {
      kind: 'order-from-call',
      description: typeof d.description === 'string' ? d.description : null,
      phone: typeof d.caller_phone === 'string' ? d.caller_phone : null,
      category: typeof d.category === 'string' ? d.category : null,
    };
  }
  if (typeof d.systemPrompt === 'string') {
    return { kind: 'voice-prompt', prompt: d.systemPrompt, candidate: typeof d.candidateName === 'string' ? d.candidateName : null };
  }
  if (Array.isArray(d.messages)) {
    const msgs = d.messages as Array<{ role: string; content: string }>;
    const sys = msgs.find(m => m.role === 'system');
    const rest = msgs.filter(m => m.role !== 'system');
    const prompt = [sys?.content, ...rest.map(m => `[${m.role}] ${m.content}`)].filter(Boolean).join('\n\n');
    return { kind: 'text-call', prompt, response: typeof d.response === 'string' ? d.response : null };
  }
  return { kind: 'raw', data: d };
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const ROLE_LABEL: Record<string, string> = { ai: 'AI', user: 'Собеседник', system: 'Система' };

function EventDetail({ row }: { row: FeedRow }) {
  const parsed = parseEvent(row);
  if (parsed.kind === 'text-call') {
    return (
      <>
        <div>
          <div style={styles.label}>Отправлено модели</div>
          <pre style={styles.pre}>{parsed.prompt}</pre>
        </div>
        {parsed.response && (
          <div>
            <div style={styles.label}>Получено от модели</div>
            <pre style={styles.pre}>{parsed.response}</pre>
          </div>
        )}
      </>
    );
  }
  if (parsed.kind === 'voice-prompt') {
    return (
      <div>
        <div style={styles.label}>Инструкция AI{parsed.candidate ? ` — звонок для «${parsed.candidate}»` : ''}</div>
        <pre style={styles.pre}>{parsed.prompt}</pre>
      </div>
    );
  }
  if (parsed.kind === 'voice-result') {
    return (
      <>
        {parsed.outcome && (
          <div>
            <div style={styles.label}>Итог звонка</div>
            <div style={{ fontSize: 13, color: '#e8ecf3' }}>{parsed.outcome}</div>
          </div>
        )}
        {parsed.transcript && parsed.transcript.length > 0 && (
          <div>
            <div style={styles.label}>Разговор</div>
            <div style={styles.transcript}>
              {parsed.transcript.map((t, i) => (
                <div key={i} style={styles.transcriptLine}>
                  <span style={{ ...styles.transcriptRole, color: t.role === 'ai' ? '#5ec8ff' : '#f0a960' }}>{ROLE_LABEL[t.role] ?? t.role}</span>
                  <span style={styles.transcriptText}>{t.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </>
    );
  }
  if (parsed.kind === 'order-from-call') {
    return (
      <div>
        <div style={styles.label}>Что создано из звонка</div>
        <div style={{ fontSize: 13, color: '#e8ecf3', lineHeight: 1.6 }}>
          {parsed.category && <div>Категория: {parsed.category}</div>}
          {parsed.phone && <div>Телефон: {parsed.phone}</div>}
          {parsed.description && <div>Описание: {parsed.description}</div>}
        </div>
      </div>
    );
  }
  return <pre style={styles.pre}>{JSON.stringify(parsed.data, null, 2)}</pre>;
}

// ── Иконка узла по типу ───────────────────────────────────────────────────
function nodeGlyph(kind: NodeDef['kind']): string {
  if (kind === 'text') return 'T';
  if (kind === 'voice') return '☎';
  if (kind === 'db') return 'DB';
  return '•';
}
function nodeColor(kind: NodeDef['kind']): string {
  if (kind === 'text') return '#5ec8ff';
  if (kind === 'voice') return '#f0a960';
  if (kind === 'db') return '#6fcf97';
  return '#97a3b8';
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
  const [status, setStatus] = useState<'loading' | 'live' | 'error' | 'unauthorized'>('loading');
  const [hotNodes, setHotNodes] = useState<Record<string, number>>({}); // nodeId -> timestamp last fired
  const [selected, setSelected] = useState<FeedRow | null>(null);
  const [recent, setRecent] = useState<FeedRow[]>([]);
  const lastSeenRef = useRef<string | null>(null);
  const [, forceTick] = useState(0);

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

        const { rows } = await res.json() as { rows: FeedRow[] };
        if (cancelled) return;

        if (rows.length > 0) {
          lastSeenRef.current = rows[rows.length - 1].created_at;
          const now = Date.now();
          setHotNodes(prev => {
            const next = { ...prev };
            for (const row of rows) {
              const node = nodeForTag(row.tag);
              if (node) next[node.id] = now;
            }
            return next;
          });
          setRecent(prev => [...rows, ...prev].slice(0, 30));
          setSelected(rows[rows.length - 1]);
        }
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('error');
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [secret]);

  // Repaint every 500ms so "hot" nodes fade out on schedule without waiting for the next poll.
  useEffect(() => {
    const t = setInterval(() => forceTick(x => x + 1), 500);
    return () => clearInterval(t);
  }, []);

  if (status === 'unauthorized') {
    return <div style={styles.centerScreen}><p style={{ color: '#97a3b8', fontFamily: MONO }}>Нужен ?secret=... в адресе страницы.</p></div>;
  }

  const now = Date.now();
  function isHot(id: string) {
    const t = hotNodes[id];
    return !!t && now - t < FLASH_MS;
  }

  return (
    <div style={styles.page}>
      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>mushebi.ge · admin</div>
          <h1 style={styles.h1}>Живая схема агентов</h1>
        </div>
        <div style={styles.headerRight}>
          <span style={{ ...styles.statusDot, background: status === 'live' ? '#6fcf97' : status === 'error' ? '#d9647a' : '#5c6884' }} />
          <span style={styles.statusText}>{status === 'live' ? 'слушаю прод' : status === 'error' ? 'ошибка соединения' : 'загрузка…'}</span>
        </div>
      </header>

      <div style={styles.body}>
        <div style={styles.graphPane}>
          {STAGES.map((stage, si) => (
            <div key={stage.title} style={styles.stageBlock}>
              <div style={styles.stageTitle}>{stage.title}</div>
              <div style={styles.nodeRow}>
                {stage.nodes.map(node => {
                  const hot = isHot(node.id);
                  const color = nodeColor(node.kind);
                  return (
                    <div
                      key={node.id}
                      style={{
                        ...styles.node,
                        borderColor: hot ? color : '#262e3d',
                        boxShadow: hot ? `0 0 0 1px ${color}, 0 0 18px ${color}66` : 'none',
                        background: hot ? `${color}1a` : '#171d28',
                      }}
                    >
                      <span style={{ ...styles.nodeGlyph, color, borderColor: color }}>{nodeGlyph(node.kind)}</span>
                      <span style={styles.nodeLabel}>{node.label}</span>
                    </div>
                  );
                })}
              </div>
              {si < STAGES.length - 1 && <div style={styles.stageArrow}>↓</div>}
            </div>
          ))}
          <div style={styles.legend}>
            <span style={styles.legendItem}><span style={{ ...styles.dot, background: '#5ec8ff' }} />текстовый агент</span>
            <span style={styles.legendItem}><span style={{ ...styles.dot, background: '#f0a960' }} />голосовой агент</span>
            <span style={styles.legendItem}><span style={{ ...styles.dot, background: '#6fcf97' }} />база данных</span>
            <span style={styles.legendItem}>узел светится ~5 сек после реального срабатывания</span>
          </div>
        </div>

        <div style={styles.sidePane}>
          <div style={styles.sideHead}>Что произошло только что</div>
          {selected ? (
            <div style={styles.selectedCard}>
              <div style={styles.selectedTime}>{timeLabel(selected.created_at)}</div>
              <div style={{ ...styles.selectedTag, color: selected.source === 'voice-call' ? '#f0a960' : '#5ec8ff' }}>
                {agentLabel(selected.tag)}
              </div>
              <div style={styles.selectedBody}>
                <EventDetail row={selected} />
              </div>
            </div>
          ) : (
            <p style={{ color: '#5c6884', fontFamily: MONO, fontSize: 12.5 }}>Ждём первое событие…</p>
          )}

          {recent.length > 1 && (
            <>
              <div style={{ ...styles.sideHead, marginTop: 22 }}>История (последние {recent.length - 1})</div>
              <div style={styles.historyList}>
                {recent.slice(1).map(row => (
                  <div key={row.id} style={styles.historyRow} onClick={() => setSelected(row)}>
                    <span style={styles.historyTime}>{timeLabel(row.created_at)}</span>
                    <span style={{ ...styles.historyTag, color: row.source === 'voice-call' ? '#f0a960' : '#5ec8ff' }}>
                      {agentLabel(row.tag)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const MONO = "'SF Mono', 'JetBrains Mono', Consolas, monospace";

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#0e1117', color: '#e8ecf3', fontFamily: '-apple-system, sans-serif', display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid #1d2431', flexShrink: 0 },
  eyebrow: { fontFamily: MONO, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 4 },
  h1: { fontSize: 18, fontWeight: 650, margin: 0 },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: '50%' },
  statusText: { fontFamily: MONO, fontSize: 11.5, color: '#97a3b8' },

  body: { flex: 1, display: 'flex', minHeight: 0 },
  graphPane: { flex: '1 1 60%', overflowY: 'auto', padding: '22px 24px', borderRight: '1px solid #1d2431' },
  sidePane: { flex: '1 1 40%', maxWidth: 460, overflowY: 'auto', padding: '22px 20px' },

  stageBlock: { marginBottom: 4 },
  stageTitle: { fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 10 },
  nodeRow: { display: 'flex', flexWrap: 'wrap', gap: 10 },
  node: { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 13px', borderRadius: 9, border: '1px solid #262e3d', background: '#171d28', transition: 'all 0.4s ease' },
  nodeGlyph: { fontFamily: MONO, fontSize: 10, fontWeight: 700, width: 22, height: 22, borderRadius: 6, border: '1px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  nodeLabel: { fontSize: 12.5, fontWeight: 500, color: '#e8ecf3' },
  stageArrow: { textAlign: 'center', color: '#5c6884', fontSize: 16, margin: '14px 0' },

  legend: { display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 26, paddingTop: 16, borderTop: '1px solid #1d2431', fontSize: 11.5, color: '#97a3b8' },
  legendItem: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: '50%' },

  sideHead: { fontFamily: MONO, fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 10 },
  selectedCard: { background: '#171d28', border: '1px solid #262e3d', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 },
  selectedTime: { fontFamily: MONO, fontSize: 11, color: '#5c6884' },
  selectedTag: { fontSize: 14, fontWeight: 650 },
  selectedBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#5c6884', marginBottom: 5 },
  pre: { fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: '#c3cbdb', background: '#10141c', border: '1px solid #1d2431', borderRadius: 7, padding: '10px 12px', whiteSpace: 'pre-wrap', margin: 0, maxHeight: 260, overflowY: 'auto' },
  transcript: { background: '#10141c', border: '1px solid #1d2431', borderRadius: 7, padding: '10px 12px', maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 },
  transcriptLine: { fontSize: 12.5, lineHeight: 1.5 },
  transcriptRole: { fontFamily: MONO, fontSize: 10, fontWeight: 700, marginRight: 8 },
  transcriptText: { color: '#e8ecf3' },

  historyList: { display: 'flex', flexDirection: 'column', gap: 4 },
  historyRow: { display: 'flex', gap: 10, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 12 },
  historyTime: { fontFamily: MONO, fontSize: 10.5, color: '#5c6884', flexShrink: 0 },
  historyTag: { fontSize: 12 },

  centerScreen: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0e1117' },
};
