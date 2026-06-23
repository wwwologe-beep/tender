'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Image from 'next/image';
import { supabaseBrowser as supabase } from '@/lib/supabase-browser';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Order {
  id: string;
  token: string;
  status: 'bidding' | 'selected' | 'completed' | 'cancelled';
  cargo_description: string | null;
  address_from: string | null;
  address_to: string | null;
  client_budget: number | null;
  category: string | null;
  live_brief_ai: string | null;
  winning_bid_id: string | null;
  created_at: string;
  client_phone: string | null;
  notes: string | null;
  workers_needed: number | null;
  vehicles_needed: number | null;
}

interface Driver {
  id: string;
  name: string;
  phone: string;
  rating: number;
  completed_orders: number;
}

interface Bid {
  id: string;
  order_id: string;
  driver_id: string;
  amount: number;
  status: 'pending' | 'winner' | 'lost' | 'withdrawn';
  comment: string | null;
  created_at: string;
  tender_drivers: Driver | null;
}

interface Question {
  id: string;
  order_id: string;
  question_original: string;
  question_translated: Record<string, string> | null;
  answer_original: string | null;
  answer_translated: Record<string, string> | null;
  status: 'pending' | 'answered';
  created_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StarRating({ rating }: { rating: number }) {
  const full = Math.floor(rating);
  const frac = rating - full;
  return (
    <span className="inline-flex items-center gap-0.5 text-amber-400 text-sm">
      {Array.from({ length: 5 }, (_, i) => {
        if (i < full) return <span key={i}>★</span>;
        if (i === full && frac >= 0.5) return <span key={i} className="opacity-50">★</span>;
        return <span key={i} className="text-gray-300">★</span>;
      })}
      <span className="ml-1 text-gray-600 font-medium">{rating.toFixed(1)}</span>
    </span>
  );
}

function CategoryBadge({ category }: { category: string | null }) {
  const labels: Record<string, string> = {
    moving: '📦 Переезд', transport: '🚐 Перевозка', cleaning: '🧹 Уборка',
    repair: '🔧 Ремонт', electricity: '⚡ Электрика', plumbing: '🔩 Сантехника',
    general: '🛠 Разное',
  };
  return (
    <span className="inline-block bg-blue-50 text-blue-700 text-xs font-semibold px-2.5 py-1 rounded-full">
      {labels[category ?? ''] ?? category ?? 'Услуга'}
    </span>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function FeedPage() {
  const params      = useParams();
  const searchParams = useSearchParams();
  const token       = params.token as string;
  const driverIdParam = searchParams.get('driver_id');

  const [order, setOrder]         = useState<Order | null>(null);
  const [bids, setBids]           = useState<Bid[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [accepting, setAccepting]   = useState<string | null>(null); // bid_id in progress
  const [accepted, setAccepted]     = useState(false);
  const [answers, setAnswers]       = useState<Record<string, string>>({}); // question_id → text
  const [answering, setAnswering]   = useState<string | null>(null); // question_id submitting
  const [cancelling, setCancelling] = useState(false);

  // ─── Initial load ──────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    const { data: orderData, error: orderErr } = await supabase
      .from('tender_orders')
      .select('id, token, status, cargo_description, address_from, address_to, client_budget, category, live_brief_ai, winning_bid_id, created_at, client_phone, notes, workers_needed, vehicles_needed')
      .eq('token', token)
      .single();

    if (orderErr || !orderData) {
      setError('Заказ не найден или ссылка недействительна.');
      setLoading(false);
      return;
    }
    setOrder(orderData as Order);

    const { data: bidsData } = await supabase
      .from('tender_bids')
      .select('id, order_id, driver_id, amount, status, comment, created_at, tender_drivers(id, name, phone, rating, completed_orders)')
      .eq('order_id', orderData.id)
      .not('status', 'eq', 'withdrawn')
      .gt('amount', 0)
      .order('amount', { ascending: true });

    // Supabase JOIN возвращает tender_drivers как массив — берём первый элемент
    const normalized = (bidsData ?? []).map(b => ({
      ...b,
      tender_drivers: Array.isArray(b.tender_drivers) ? (b.tender_drivers[0] ?? null) : b.tender_drivers,
    })) as Bid[];
    setBids(normalized);

    // Вопросы от исполнителей
    const { data: qData } = await supabase
      .from('order_questions')
      .select('id, order_id, question_original, question_translated, answer_original, answer_translated, status, created_at')
      .eq('order_id', orderData.id)
      .order('created_at', { ascending: true });
    setQuestions((qData ?? []) as Question[]);

    setLoading(false);
  }, [token]);

  useEffect(() => { loadData(); }, [loadData]);

  // ─── Realtime ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!order?.id) return;

    const channel = supabase
      .channel(`feed:${order.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'tender_bids',
        filter: `order_id=eq.${order.id}`,
      }, () => { loadData(); })
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'tender_orders',
        filter: `id=eq.${order.id}`,
      }, (payload) => {
        setOrder(prev => prev ? { ...prev, ...(payload.new as Partial<Order>) } : prev);
      })
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'order_questions',
        filter: `order_id=eq.${order.id}`,
      }, () => { loadData(); })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [order?.id, loadData]);

  // ─── Cancel selection (reopen order) ──────────────────────────────────────

  async function handleCancelSelection() {
    if (!order || !confirm('Отменить выбор исполнителя и вернуть заказ в режим приёма ставок?')) return;
    setCancelling(true);
    try {
      const res = await fetch('/api/tender/cancel-selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: order.id }),
      });
      if (res.ok) {
        await loadData();
        setAccepted(false);
      } else {
        const data = await res.json();
        alert(data.error ?? 'Ошибка при отмене');
      }
    } finally {
      setCancelling(false);
    }
  }

  // ─── Accept bid ────────────────────────────────────────────────────────────

  async function handleAccept(bid: Bid) {
    if (!order) return;
    setAccepting(bid.id);
    try {
      const res = await fetch('/api/tender/accept-bid', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_token: order.token, bid_id: bid.id }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        setAccepted(true);
        await loadData();
      } else {
        alert(data.error ?? 'Ошибка. Попробуйте ещё раз.');
      }
    } catch {
      alert('Нет соединения. Проверьте интернет и попробуйте снова.');
    } finally {
      setAccepting(null);
    }
  }

  // ─── Answer question ───────────────────────────────────────────────────────

  async function handleAnswer(questionId: string) {
    const text = answers[questionId]?.trim();
    if (!text || !order) return;
    setAnswering(questionId);
    try {
      const res = await fetch('/api/questions/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question_id:  questionId,
          answer:       text,
          lang:         'ru',
          client_phone: order.client_phone,
        }),
      });
      if (res.ok) {
        setAnswers(prev => { const n = { ...prev }; delete n[questionId]; return n; });
        await loadData();
      }
    } finally {
      setAnswering(null);
    }
  }

  // ─── Render states ─────────────────────────────────────────────────────────

  if (loading) return <LoadingScreen />;
  if (error || !order) return <ErrorScreen message={error ?? 'Что-то пошло не так'} />;

  const isBidding  = order.status === 'bidding';
  const isSelected = order.status === 'selected' || order.status === 'completed';
  const winnerBid  = bids.find(b => b.id === order.winning_bid_id);
  const visibleBids = isSelected ? (winnerBid ? [winnerBid] : bids.filter(b => b.status === 'winner')) : bids;
  const pendingQCount = questions.filter(q => q.status === 'pending').length;

  return (
    <div className="min-h-screen bg-[#F6F6F6] font-sans">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-gray-100">
        <div className="max-w-xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <Image src="/logo.svg" alt="Mushebi.ge" width={140} height={40} className="h-8 w-auto" priority />
          <div className="flex items-center gap-2">
            {pendingQCount > 0 && (
              <span className="flex items-center gap-1 bg-red-100 text-red-600 text-xs font-bold px-2.5 py-1 rounded-full animate-pulse">
                ❓ {pendingQCount} вопрос{pendingQCount > 1 ? 'а' : ''}
              </span>
            )}
            <StatusPill status={order.status} />
          </div>
        </div>
      </header>

      <main className="max-w-xl mx-auto px-4 py-6 space-y-4">

        {/* ── Order Card ───────────────────────────────────────────────────── */}
        <section className="bg-white rounded-2xl p-5 shadow-sm space-y-4">
          <div className="flex items-start justify-between gap-3">
            <h1 className="text-lg font-semibold text-gray-900 leading-snug flex-1 whitespace-pre-line">
              {order.cargo_description ?? 'Заказ услуги'}
            </h1>
            <CategoryBadge category={order.category} />
          </div>

          {(order.address_from || order.address_to) && (
            <div className="space-y-1.5">
              {order.address_from && (
                <div className="flex items-start gap-2 text-sm text-gray-600">
                  <span className="mt-0.5 shrink-0">📍</span>
                  <span><span className="text-gray-400 mr-1">Откуда:</span>{order.address_from}</span>
                </div>
              )}
              {order.address_to && (
                <div className="flex items-start gap-2 text-sm text-gray-600">
                  <span className="mt-0.5 shrink-0">🏁</span>
                  <span><span className="text-gray-400 mr-1">Куда:</span>{order.address_to}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {order.client_budget && (
              <Chip icon="💰" label={`Бюджет: ${order.client_budget} ₾`} />
            )}
            {order.workers_needed != null && order.workers_needed > 0 && (
              <Chip icon="👷" label={`${order.workers_needed} грузчик${order.workers_needed > 1 ? 'а' : ''}`} />
            )}
            {order.vehicles_needed != null && order.vehicles_needed > 0 && (
              <Chip icon="🚐" label={`${order.vehicles_needed} авто`} />
            )}
          </div>

          {order.notes && (
            <p className="text-sm text-gray-500 border-t border-gray-50 pt-3">{order.notes}</p>
          )}

          {order.live_brief_ai && order.live_brief_ai !== order.cargo_description && (
            <div className="bg-blue-50 rounded-xl p-3 text-sm text-blue-800 leading-relaxed whitespace-pre-line border border-blue-100">
              {order.live_brief_ai}
            </div>
          )}
        </section>

        {/* ── Questions from executors ─────────────────────────────────────── */}
        {questions.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide px-1">
              ❓ Вопросы исполнителей · {questions.filter(q => q.status === 'pending').length > 0 && (
                <span className="text-red-500">
                  {questions.filter(q => q.status === 'pending').length} без ответа
                </span>
              )}
            </h2>

            {questions.map(q => (
              <div
                key={q.id}
                className={[
                  'bg-white rounded-2xl p-5 shadow-sm space-y-3',
                  q.status === 'pending' ? 'ring-2 ring-amber-300' : '',
                ].join(' ')}
              >
                {/* Question */}
                <div className="flex items-start gap-2">
                  <span className="text-lg shrink-0">❓</span>
                  <p className="text-[#1D1D1F] font-medium leading-snug">
                    {q.question_translated?.['ru'] ?? q.question_original}
                  </p>
                </div>

                {/* Answer */}
                {q.status === 'answered' ? (
                  <div className="flex items-start gap-2 bg-green-50 rounded-xl px-3 py-2.5">
                    <span className="text-base shrink-0">💬</span>
                    <p className="text-sm text-green-800 leading-relaxed">
                      {q.answer_original}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      rows={2}
                      placeholder="Ваш ответ..."
                      value={answers[q.id] ?? ''}
                      onChange={e => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                      className="w-full px-3 py-2.5 rounded-xl border border-gray-200 bg-gray-50 text-sm text-[#1D1D1F] placeholder-gray-400 resize-none focus:outline-none focus:ring-2 focus:ring-[#1D1D1F]/20 focus:border-gray-400 transition-all"
                    />
                    <button
                      onClick={() => handleAnswer(q.id)}
                      disabled={!answers[q.id]?.trim() || answering === q.id}
                      className={[
                        'w-full py-2.5 rounded-xl text-sm font-semibold transition-all',
                        !answers[q.id]?.trim() || answering === q.id
                          ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                          : 'bg-[#1D1D1F] hover:bg-[#333] active:scale-95 text-white',
                      ].join(' ')}
                    >
                      {answering === q.id ? '⏳ Отправляем...' : 'Ответить →'}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </section>
        )}

        {/* ── Success banner ───────────────────────────────────────────────── */}
        {accepted && (
          <div className="bg-green-50 border border-green-200 rounded-2xl p-4 text-center text-green-700 font-medium text-sm">
            ✅ Исполнитель выбран! Контакты открыты ниже.
          </div>
        )}

        {/* ── Bids section ─────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
              {isSelected ? 'Выбранный исполнитель' : `Предложения · ${bids.length}`}
            </h2>
            {isBidding && bids.length > 0 && (
              <span className="text-xs text-gray-400">
                {Math.min(...bids.map(b => b.amount))}–{Math.max(...bids.map(b => b.amount))} ₾
              </span>
            )}
          </div>

          {visibleBids.length === 0 && (
            <div className="bg-white rounded-2xl p-8 text-center text-gray-400 shadow-sm">
              <div className="text-3xl mb-2">⏳</div>
              <p className="text-sm">Ожидаем предложения исполнителей</p>
            </div>
          )}

          {visibleBids.map((bid, idx) => {
            const driver      = bid.tender_drivers;
            const isWinner    = isSelected && bid.id === order.winning_bid_id;
            const isMyBid     = driverIdParam && bid.driver_id === driverIdParam;
            const showContacts = isWinner; // reveal only after selection
            const displayName  = showContacts
              ? (driver?.name ?? 'Исполнитель')
              : `Исполнитель #${idx + 1}`;

            return (
              <div
                key={bid.id}
                className={[
                  'bg-white rounded-2xl p-5 shadow-sm space-y-3 transition-all',
                  isWinner ? 'ring-2 ring-green-400 bg-green-50/30' : '',
                  isMyBid ? 'ring-2 ring-blue-400' : '',
                ].join(' ')}
              >
                {/* My-bid banner */}
                {isMyBid && !isWinner && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl px-3 py-2 text-blue-700 text-xs font-medium flex items-center gap-2">
                    <span>🔵</span>
                    <span>Это ваша ставка. Ожидайте решения клиента.</span>
                  </div>
                )}

                {/* Winner banner */}
                {isWinner && (
                  <div className="bg-green-100 border border-green-200 rounded-xl px-3 py-2 text-green-700 text-xs font-semibold flex items-center gap-2">
                    <span>✅</span>
                    <span>Выбранный исполнитель</span>
                  </div>
                )}

                {/* Driver info row */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    {/* Avatar */}
                    <div className={[
                      'w-10 h-10 rounded-full flex items-center justify-center text-base font-bold shrink-0',
                      isWinner ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500',
                    ].join(' ')}>
                      {showContacts && driver?.name
                        ? driver.name.charAt(0).toUpperCase()
                        : (idx + 1).toString()}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{displayName}</p>
                      {driver && (
                        <StarRating rating={driver.rating} />
                      )}
                    </div>
                  </div>
                  {/* Price */}
                  <div className="text-right">
                    <p className="text-xl font-bold text-gray-900">{bid.amount} ₾</p>
                    {driver && (
                      <p className="text-xs text-gray-400">{driver.completed_orders} заказов</p>
                    )}
                  </div>
                </div>

                {/* Comment */}
                {bid.comment && (
                  <p className="text-sm text-gray-600 bg-gray-50 rounded-xl px-3 py-2.5 leading-relaxed">
                    "{bid.comment}"
                  </p>
                )}

                {/* Revealed contacts */}
                {showContacts && driver?.phone && (
                  <div className="space-y-2">
                    <a
                      href={`tel:${driver.phone}`}
                      className="flex items-center justify-center gap-2 w-full bg-green-500 hover:bg-green-600 active:bg-green-700 text-white font-semibold py-3 rounded-xl text-sm transition-colors"
                    >
                      📞 Позвонить: {driver.phone}
                    </a>
                    <a
                      href={`https://wa.me/${driver.phone.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-center gap-2 w-full bg-[#25D366] hover:bg-[#1ebe5d] active:bg-[#17a84f] text-white font-semibold py-3 rounded-xl text-sm transition-colors"
                    >
                      💬 Написать в WhatsApp
                    </a>
                  </div>
                )}

                {/* Accept button */}
                {isBidding && !isMyBid && (
                  <button
                    onClick={() => handleAccept(bid)}
                    disabled={accepting !== null}
                    className={[
                      'w-full py-3 rounded-xl text-sm font-semibold transition-all',
                      accepting === bid.id
                        ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        : 'bg-gray-900 hover:bg-gray-700 active:scale-95 text-white',
                    ].join(' ')}
                  >
                    {accepting === bid.id ? (
                      <span className="flex items-center justify-center gap-2">
                        <Spinner /> Оформляем...
                      </span>
                    ) : 'Выбрать этого исполнителя'}
                  </button>
                )}
              </div>
            );
          })}
        </section>

        {/* ── Actions for selected order ────────────────────────────────── */}
        {isSelected && order.status === 'selected' && (
          <section className="space-y-2">
            <button
              onClick={handleCancelSelection}
              disabled={cancelling}
              className="w-full py-3 rounded-xl text-sm font-semibold border border-gray-200 text-gray-600 hover:bg-gray-50 active:scale-95 transition-all"
            >
              {cancelling ? '⏳ Отменяем...' : '🔄 Сменить исполнителя'}
            </button>
          </section>
        )}

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <footer className="text-center text-xs text-gray-400 pb-8 pt-2">
          <p>mushebi.ge — тендерная площадка услуг</p>
          <p className="mt-1">Заказ обновляется в реальном времени</p>
        </footer>
      </main>
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatusPill({ status }: { status: Order['status'] }) {
  const map: Record<Order['status'], { label: string; classes: string }> = {
    bidding:   { label: '⏳ Приём ставок',    classes: 'bg-amber-100 text-amber-700' },
    selected:  { label: '✅ Исполнитель выбран', classes: 'bg-green-100 text-green-700' },
    completed: { label: '🏁 Завершён',         classes: 'bg-gray-100 text-gray-600' },
    cancelled: { label: '❌ Отменён',           classes: 'bg-red-100 text-red-600' },
  };
  const s = map[status] ?? map.bidding;
  return (
    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${s.classes}`}>
      {s.label}
    </span>
  );
}

function Chip({ icon, label }: { icon: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 bg-gray-50 border border-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full">
      {icon} {label}
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-10 h-10 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin mx-auto" />
        <p className="text-sm text-gray-500">Загружаем заказ...</p>
      </div>
    </div>
  );
}

function ErrorScreen({ message }: { message: string }) {
  return (
    <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl p-8 text-center shadow-sm max-w-sm w-full space-y-3">
        <div className="text-4xl">🔍</div>
        <h2 className="font-semibold text-gray-900">Заказ не найден</h2>
        <p className="text-sm text-gray-500">{message}</p>
      </div>
    </div>
  );
}
