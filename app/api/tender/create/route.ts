import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';
import { sendTenderToDrivers } from '@/lib/telegram/bot';
import { analyzeOrder } from '@/lib/ai';

interface CreateOrderBody {
  // Универсальное описание задачи (маркетплейс)
  cargo_description?: string;
  // Адреса — опциональны для не-транспортных заказов
  address_from?: string;
  address_to?: string;
  // Детали
  workers_needed?: number;
  vehicles_needed?: number;
  scheduled_at?: string;
  // Клиент
  client_name: string;
  client_phone: string;
  notes?: string;
  created_by?: string;
  // Медиа
  media_urls?: string[];
  // Категория и AI-поля (готово к AI-классификации)
  category?: string;
  ai_summary?: string;
  client_budget?: number | null;
}

export async function POST(req: NextRequest) {
  try {
    const body: CreateOrderBody = await req.json();

    if (!body.client_phone) {
      return NextResponse.json({ error: 'client_phone обязателен' }, { status: 400 });
    }

    if (!body.cargo_description && !body.address_from) {
      return NextResponse.json(
        { error: 'Укажите описание задачи или адрес отправления' },
        { status: 400 }
      );
    }

    const { data, error } = await supabaseAdmin
      .from('tender_orders')
      .insert({
        token: randomUUID(),
        address_from: body.address_from ?? '-',
        address_to: body.address_to ?? '-',
        cargo_description: body.cargo_description ?? null,
        workers_needed: body.workers_needed ?? 0,
        vehicles_needed: body.vehicles_needed ?? 1,
        scheduled_at: body.scheduled_at ?? null,
        client_name: body.client_name ?? 'Клиент',
        client_phone: body.client_phone,
        notes: body.notes ?? null,
        media_urls: body.media_urls ?? null,
        category: body.category ?? 'general',
        ai_summary: body.ai_summary ?? null,
        client_budget: body.client_budget ?? null,
        status: 'bidding',
        bidding_started_at: new Date().toISOString(),
      })
      .select('id, token, status, created_at')
      .single();

    if (error) {
      console.error('[tender/create] supabase error:', JSON.stringify(error));
      return NextResponse.json(
        { error: 'Ошибка базы данных', detail: error.message, code: error.code },
        { status: 500 }
      );
    }

    // AI-анализ сначала, потом рассылка — чтобы исполнители видели переведённое описание
    const rawText = [
      body.cargo_description,
      body.address_from && body.address_to
        ? `Откуда: ${body.address_from}, Куда: ${body.address_to}`
        : null,
      body.notes,
    ].filter(Boolean).join('. ');

    // AI-анализ выполняем синхронно — Vercel убивает фоновые задачи после ответа
    if (process.env.OPENROUTER_API_KEY) {
      try {
        const analysis = await analyzeOrder(rawText);
        if (analysis) {
          await supabaseAdmin.from('tender_orders').update({
            category: analysis.category,
            ai_summary: analysis.ai_summary,
            localized_description: analysis.localized_description,
          }).eq('id', data.id);
        }
      } catch (err) {
        console.error('[ai.analyzeOrder]', err);
      }
    }

    // Рассылаем уведомления синхронно — без await Vercel убивает задачу
    try {
      await sendTenderToDrivers(data.id);
    } catch (e) {
      console.error('[sendTenderToDrivers]', e);
    }

    const clientUrl = `https://mushebi.ge/feed/${data.token}`;

    // Onboarding: отправляем клиенту ссылку на заявку через WhatsApp
    const wappiToken = process.env.WAPPI_TOKEN;
    const wappiProfile = process.env.WAPPI_PROFILE_ID;
    if (wappiToken && wappiProfile && body.client_phone) {
      const onboardingText =
        `✅ Ваша заявка принята на mushebi.ge!\n\n` +
        `Исполнители уже видят заказ и скоро пришлют предложения.\n\n` +
        `📋 Следите за статусом и выбирайте лучшее предложение здесь:\n${clientUrl}\n\n` +
        `⏱ Первые предложения обычно за 10–15 минут.`;
      await fetch(`https://wappi.pro/api/sync/message/send?profile_id=${wappiProfile}`, {
        method: 'POST',
        headers: { Authorization: wappiToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: onboardingText, recipient: body.client_phone.replace('+', '') }),
      }).catch(err => console.error('[onboarding whatsapp]', err));
    }

    return NextResponse.json({ order: data, client_url: clientUrl }, { status: 201 });
  } catch (err) {
    console.error('[tender/create] unexpected:', err);
    return NextResponse.json({ error: 'Неверный формат запроса' }, { status: 400 });
  }
}
