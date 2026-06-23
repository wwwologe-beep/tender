/**
 * Сервис очереди уведомлений для новых заказов.
 *
 * Логика:
 *  1. enqueueOrderNotifications(orderId) — при создании заказа находит
 *     всех подходящих активных водителей и вставляет pending-записи в
 *     tender_notification_queue.
 *  2. processNotificationBatch(batchSize) — выбирает pending-записи,
 *     отправляет уведомления через Telegram Bot API и обновляет статус.
 */

import { supabaseAdmin } from '@/lib/supabase';

// Зеркало из bot.ts — какие специализации подходят под категорию заказа
const CATEGORY_TO_SPECS: Record<string, string[]> = {
  moving:      ['mover', 'driver', 'handyman', 'moving'],
  cleaning:    ['cleaner', 'handyman', 'cleaning'],
  repair:      ['handyman', 'repair', 'builder'],
  electrician: ['electrician', 'handyman', 'electrical'],
  plumber:     ['plumber', 'handyman', 'plumbing'],
  courier:     ['driver', 'courier', 'mover'],
  furniture:   ['mover', 'handyman', 'assembly', 'moving'],
  assembly:    ['handyman', 'assembly', 'repair'],
  appliances_moving: ['mover', 'driver', 'handyman', 'moving'],
  general:     ['mover', 'driver', 'handyman', 'electrician', 'plumber', 'cleaner',
                'moving', 'cleaning', 'electrical', 'plumbing', 'repair'],
};

export interface QueueStats {
  enqueued: number;
  skipped:  number;   // уже были записи (idempotency)
}

// ─── Генерация очереди ────────────────────────────────────────────────────────

export async function enqueueOrderNotifications(orderId: string): Promise<QueueStats> {
  const { data: order } = await supabaseAdmin
    .from('tender_orders')
    .select('id, category, status')
    .eq('id', orderId)
    .single();

  if (!order || order.status !== 'bidding') return { enqueued: 0, skipped: 0 };

  const category  = (order.category as string) ?? 'general';
  const allowedSpecs = CATEGORY_TO_SPECS[category] ?? CATEGORY_TO_SPECS['general'];

  // Активные водители с действующей подпиской и telegram_id
  const { data: drivers } = await supabaseAdmin
    .from('tender_drivers')
    .select('id, telegram_id, specialization')
    .eq('status', 'active')
    .not('telegram_id', 'is', null)
    .gt('subscription_expires_at', new Date().toISOString());

  const eligible = (drivers ?? []).filter(
    d => !d.specialization || allowedSpecs.includes(d.specialization as string)
  );

  if (eligible.length === 0) return { enqueued: 0, skipped: 0 };

  // Upsert с onConflict — безопасно при повторных вызовах
  const rows = eligible.map(d => ({
    order_id:    orderId,
    driver_id:   d.id,
    telegram_id: d.telegram_id as number,
    status:      'pending',
  }));

  const { data: inserted, error } = await supabaseAdmin
    .from('tender_notification_queue')
    .upsert(rows, { onConflict: 'order_id,driver_id', ignoreDuplicates: true })
    .select('id');

  if (error) {
    console.error('[enqueueOrderNotifications]', error.message);
    return { enqueued: 0, skipped: eligible.length };
  }

  const enqueued = (inserted ?? []).length;
  return { enqueued, skipped: eligible.length - enqueued };
}

// ─── Обработка очереди ────────────────────────────────────────────────────────

export interface ProcessResult {
  processed: number;
  sent:      number;
  failed:    number;
}

export async function processNotificationBatch(batchSize = 25): Promise<ProcessResult> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not set');

  // Берём batch pending-записей вместе с данными заказа
  const { data: items } = await supabaseAdmin
    .from('tender_notification_queue')
    .select(`
      id, driver_id, telegram_id,
      tender_orders!order_id (
        id, token, cargo_description, address_from, address_to, category, client_budget
      )
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(batchSize);

  if (!items || items.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const item of items) {
    const order = (item.tender_orders as unknown) as {
      id: string; token: string; cargo_description: string | null;
      address_from: string | null; address_to: string | null;
      category: string | null; client_budget: number | null;
    } | null;

    if (!order) {
      await supabaseAdmin.from('tender_notification_queue')
        .update({ status: 'failed', error_message: 'order not found' })
        .eq('id', item.id);
      failed++;
      continue;
    }

    const text = buildNotificationText(order);
    const keyboard = buildNotificationKeyboard(order.token);

    try {
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id:    item.telegram_id,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
          }),
        }
      );

      if (res.ok) {
        await supabaseAdmin.from('tender_notification_queue')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', item.id);
        sent++;
      } else {
        const body = await res.json().catch(() => ({})) as Record<string, unknown>;
        const errMsg = `TG ${res.status}: ${body.description ?? 'unknown'}`;
        await supabaseAdmin.from('tender_notification_queue')
          .update({ status: 'failed', error_message: errMsg })
          .eq('id', item.id);
        failed++;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await supabaseAdmin.from('tender_notification_queue')
        .update({ status: 'failed', error_message: errMsg })
        .eq('id', item.id);
      failed++;
    }
  }

  return { processed: items.length, sent, failed };
}

// ─── Форматирование уведомления ───────────────────────────────────────────────

function buildNotificationText(order: {
  token: string; cargo_description: string | null;
  address_from: string | null; address_to: string | null;
  category: string | null; client_budget: number | null;
}): string {
  const lines: string[] = ['🔔 <b>Новый заказ на mushebi.ge!</b>'];
  if (order.cargo_description) lines.push(`📦 ${order.cargo_description}`);
  if (order.address_from && order.address_from !== '-')
    lines.push(`📍 Откуда: ${order.address_from}`);
  if (order.address_to && order.address_to !== '-')
    lines.push(`🏁 Куда: ${order.address_to}`);
  if (order.client_budget)
    lines.push(`💰 Бюджет клиента: ${order.client_budget} ₾`);
  lines.push('\n👆 Нажмите кнопку ниже чтобы сделать ставку');
  return lines.join('\n');
}

function buildNotificationKeyboard(token: string): unknown[][] {
  return [[
    { text: '📋 Открыть заказ', url: `https://mushebi.ge/feed/${token}` },
    { text: '🤖 Сделать ставку', url: `https://t.me/mushebi_bot?start=order_${token}` },
  ]];
}
