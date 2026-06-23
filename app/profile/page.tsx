'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { useI18n } from '@/lib/i18n';
import { supabaseBrowser } from '@/lib/supabase-browser';
import { Navbar } from '@/components/Navbar';

// ─── Types ────────────────────────────────────────────────────────────────────

type OrderStatus = 'bidding' | 'selected' | 'in_progress' | 'completed' | 'cancelled';

interface TenderOrder {
  id:                string;
  token:             string;
  status:            OrderStatus;
  cargo_description: string | null;
  category:          string | null;
  created_at:        string;
  bid_count?:        number;
}

type Tab = 'active' | 'archive';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ACTIVE_STATUSES:  OrderStatus[] = ['bidding', 'selected', 'in_progress'];
const ARCHIVE_STATUSES: OrderStatus[] = ['completed', 'cancelled'];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day:   'numeric',
    month: 'long',
    year:  'numeric',
  });
}

function truncate(text: string | null, n = 80) {
  if (!text) return '—';
  return text.length > n ? text.slice(0, n) + '…' : text;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProfilePage() {
  const router        = useRouter();
  const { session, loading: authLoading } = useAuth();
  const { t }         = useI18n();

  const [orders,   setOrders]   = useState<TenderOrder[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [tab,      setTab]      = useState<Tab>('active');

  // ── Guard: redirect if not authed ───────────────────────────────────────────

  useEffect(() => {
    if (!authLoading && !session) {
      router.replace('/');
    }
  }, [authLoading, session, router]);

  // ── Load orders ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!session) return;
    (async () => {
      setLoading(true);
      const { data } = await supabaseBrowser
        .from('tender_orders')
        .select('id, token, status, cargo_description, category, created_at')
        .eq('client_phone', session.phone)
        .order('created_at', { ascending: false });

      if (!data) { setLoading(false); return; }

      // Fetch bid counts for each order
      const ids = data.map(o => o.id);
      const { data: bids } = await supabaseBrowser
        .from('tender_bids')
        .select('order_id')
        .in('order_id', ids)
        .not('status', 'eq', 'withdrawn');

      const countMap: Record<string, number> = {};
      for (const b of bids ?? []) {
        countMap[b.order_id] = (countMap[b.order_id] ?? 0) + 1;
      }

      setOrders(data.map(o => ({ ...o, bid_count: countMap[o.id] ?? 0 })) as TenderOrder[]);
      setLoading(false);
    })();
  }, [session]);

  // ── Derived lists ────────────────────────────────────────────────────────────

  const activeOrders  = orders.filter(o => ACTIVE_STATUSES.includes(o.status));
  const archiveOrders = orders.filter(o => ARCHIVE_STATUSES.includes(o.status));
  const shown         = tab === 'active' ? activeOrders : archiveOrders;

  // ── Status label ────────────────────────────────────────────────────────────

  function statusLabel(status: OrderStatus) {
    const map: Record<OrderStatus, string> = {
      bidding:     t.statusBidding,
      selected:    t.statusSelected,
      in_progress: t.statusSelected,
      completed:   t.statusCompleted,
      cancelled:   t.statusCancelled,
    };
    return map[status] ?? status;
  }

  function statusColor(status: OrderStatus) {
    if (status === 'bidding' || status === 'in_progress') return 'bg-amber-100 text-amber-700';
    if (status === 'selected') return 'bg-green-100 text-green-700';
    if (status === 'completed') return 'bg-gray-100 text-gray-600';
    return 'bg-red-100 text-red-600';
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (authLoading || (!session && !authLoading)) {
    return (
      <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F6F6F6] flex flex-col">
      <Navbar />

      <main className="max-w-2xl mx-auto w-full px-5 py-8 flex-1 space-y-5">

        {/* Header row */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-[#1D1D1F]">{t.profileTitle}</h1>
            <p className="text-sm text-gray-400 mt-0.5">{session!.phone}</p>
          </div>
          <Link
            href="/"
            className="bg-[#1D1D1F] text-white text-sm font-semibold px-4 py-2.5 rounded-xl hover:bg-[#333] active:scale-95 transition-all"
          >
            {t.newOrder}
          </Link>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 bg-white rounded-2xl p-1 shadow-sm">
          {([['active', t.tabActive, activeOrders.length], ['archive', t.tabArchive, archiveOrders.length]] as const).map(
            ([key, label, count]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={[
                  'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all',
                  tab === key
                    ? 'bg-[#1D1D1F] text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-700',
                ].join(' ')}
              >
                {label}
                {count > 0 && (
                  <span className={[
                    'text-xs font-semibold px-1.5 py-0.5 rounded-full',
                    tab === key ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600',
                  ].join(' ')}>
                    {count}
                  </span>
                )}
              </button>
            )
          )}
        </div>

        {/* Order list */}
        {loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800 rounded-full animate-spin" />
          </div>
        ) : shown.length === 0 ? (
          <div className="bg-white rounded-3xl p-12 text-center shadow-sm">
            <div className="text-4xl mb-3">{tab === 'active' ? '📋' : '📂'}</div>
            <p className="text-gray-400 text-sm">
              {tab === 'active' ? t.emptyActive : t.emptyArchive}
            </p>
            {tab === 'active' && (
              <Link
                href="/"
                className="mt-4 inline-block text-sm font-semibold text-[#1D1D1F] underline underline-offset-2"
              >
                {t.newOrder}
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {shown.map(order => (
              <div key={order.id} className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
                {/* Top row */}
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-gray-500">{formatDate(order.created_at)}</p>
                  <span className={`text-xs font-semibold px-2.5 py-1 rounded-full shrink-0 ${statusColor(order.status)}`}>
                    {statusLabel(order.status)}
                  </span>
                </div>

                {/* Description */}
                <p className="text-[#1D1D1F] font-medium leading-snug">
                  {truncate(order.cargo_description)}
                </p>

                {/* Meta row */}
                <div className="flex items-center justify-between gap-3">
                  {(order.bid_count ?? 0) > 0 && (
                    <span className="text-xs text-gray-400">
                      💬 {order.bid_count} {pluralBids(order.bid_count ?? 0)}
                    </span>
                  )}

                  <Link
                    href={`/feed/${order.token}`}
                    className="ml-auto text-sm font-semibold text-[#1D1D1F] hover:text-gray-600 transition-colors flex items-center gap-1"
                  >
                    {t.goToFeed}
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pluralBids(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return 'предложение';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'предложения';
  return 'предложений';
}
