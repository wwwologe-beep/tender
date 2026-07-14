/**
 * Candidate matching for the order call orchestrator.
 *
 * Builds a ranked list of who to call for a given order — unioning already-registered
 * `tender_drivers` (matched the same way sendTenderToDrivers()/enqueueOrderNotifications()
 * already do) with `cold_contacts` (not-yet-registered external contacts), both projected
 * into the unified `call_candidates` table.
 *
 * See ARCHITECTURE.md §9 and the orchestrator plan for the full design.
 */

import { supabaseAdmin } from '@/lib/supabase';
import { CATEGORY_TO_SPECS } from '@/lib/notification-queue';

const MAX_CANDIDATES_PER_ORDER = 10;

export interface BuildCandidatesResult {
  built: number;
}

interface DriverRow {
  id: string;
  telegram_id: number | null;
  specialization: string | null;
  driver_language: string | null;
  rating: number | null;
  subscription_expires_at: string | null;
  name: string | null;
  phone: string | null;
}

interface ColdContactRow {
  id: string;
  phone: string;
  name: string | null;
  specialization: string | null;
}

/**
 * Builds (or refreshes) the ranked call_candidates list for an order. Safe to call more than
 * once for the same order — upserts on the (order_id, driver_id) / (order_id, cold_contact_id)
 * unique constraints, so re-running (e.g. once a cold-contact list grows later) only adds new
 * candidates rather than duplicating existing ones.
 */
export async function buildCallCandidates(orderId: string): Promise<BuildCandidatesResult> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, category')
    .eq('id', orderId)
    .single();

  if (!order) return { built: 0 };

  const category = (order.category as string) ?? 'general';
  const allowedSpecs = CATEGORY_TO_SPECS[category] ?? CATEGORY_TO_SPECS['general'];

  const [driversRes, contactsRes] = await Promise.all([
    supabaseAdmin
      .from('tender_drivers')
      .select('id, telegram_id, specialization, driver_language, rating, subscription_expires_at, name, phone')
      .eq('status', 'active')
      .not('telegram_id', 'is', null)
      .gt('subscription_expires_at', new Date().toISOString()),

    supabaseAdmin
      .from('cold_contacts')
      .select('id, phone, name, specialization')
      .eq('status', 'active'),
  ]);

  const drivers = ((driversRes.data ?? []) as DriverRow[]).filter(
    d => !d.specialization || allowedSpecs.includes(d.specialization)
  );
  const coldContacts = ((contactsRes.data ?? []) as ColdContactRow[]).filter(
    c => !c.specialization || allowedSpecs.includes(c.specialization)
  );

  if (drivers.length === 0 && coldContacts.length === 0) return { built: 0 };

  type CandidateRow = {
    order_id: string;
    candidate_type: 'driver' | 'cold_contact';
    driver_id: string | null;
    cold_contact_id: string | null;
    phone: string;
    display_name: string | null;
    preferred_lang: string;
    match_score: number;
  };

  const driverRows: CandidateRow[] = drivers
    .filter(d => !!d.phone)
    .map(d => ({
      order_id: orderId,
      candidate_type: 'driver' as const,
      driver_id: d.id,
      cold_contact_id: null,
      phone: d.phone as string,
      display_name: d.name,
      preferred_lang: d.driver_language ?? 'ru',
      match_score: scoreDriver(d, allowedSpecs),
    }));

  const contactRows: CandidateRow[] = coldContacts.map(c => ({
    order_id: orderId,
    candidate_type: 'cold_contact' as const,
    driver_id: null,
    cold_contact_id: c.id,
    phone: c.phone,
    display_name: c.name,
    preferred_lang: 'ru',
    match_score: scoreColdContact(c, allowedSpecs),
  }));

  const allRows = [...driverRows, ...contactRows]
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, MAX_CANDIDATES_PER_ORDER)
    .map((row, idx) => ({ ...row, rank: idx }));

  if (allRows.length === 0) return { built: 0 };

  // Two separate upserts since driver_id/cold_contact_id unique constraints are independent
  // partial constraints (NULL-safe), can't target both with one onConflict clause.
  const driverUpserts = allRows.filter(r => r.candidate_type === 'driver');
  const contactUpserts = allRows.filter(r => r.candidate_type === 'cold_contact');

  let built = 0;

  if (driverUpserts.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('call_candidates')
      .upsert(driverUpserts, { onConflict: 'order_id,driver_id', ignoreDuplicates: false })
      .select('id');
    if (error) console.error('[buildCallCandidates] driver upsert', error.message);
    built += data?.length ?? 0;
  }

  if (contactUpserts.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('call_candidates')
      .upsert(contactUpserts, { onConflict: 'order_id,cold_contact_id', ignoreDuplicates: false })
      .select('id');
    if (error) console.error('[buildCallCandidates] cold_contact upsert', error.message);
    built += data?.length ?? 0;
  }

  return { built };
}

function scoreDriver(d: DriverRow, allowedSpecs: string[]): number {
  let score = 3; // base: registered/subscribed drivers are prioritized over cold contacts

  if (d.specialization && allowedSpecs[0] === d.specialization) score += 2;
  else if (d.specialization) score += 1;

  if (typeof d.rating === 'number') score += Math.min(1, d.rating / 5);

  if (d.subscription_expires_at) {
    const daysLeft = (new Date(d.subscription_expires_at).getTime() - Date.now()) / 86_400_000;
    score += Math.max(0, Math.min(0.5, daysLeft / 30));
  }

  return score;
}

function scoreColdContact(c: ColdContactRow, allowedSpecs: string[]): number {
  let score = 1; // flat lower base than drivers — overflow/fallback pool

  if (c.specialization && allowedSpecs[0] === c.specialization) score += 1;
  else if (c.specialization) score += 0.5;

  return score;
}
