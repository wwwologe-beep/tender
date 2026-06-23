import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { phone } = await req.json() as { phone?: string };
  if (!phone) return NextResponse.json({ error: 'phone required' }, { status: 400 });

  const normalized = phone.replace(/\s+/g, '');

  // Генерируем уникальный код вида msb_A3X7K
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const suffix = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const code = `msb_${suffix}`;
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 мин

  const { error } = await supabaseAdmin
    .from('client_otp_codes')
    .upsert({ phone: normalized, code, expires_at: expires }, { onConflict: 'phone' });

  if (error) {
    console.error('[send-otp]', error.message);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  // Dev fallback
  console.log(`[WA AUTH] ${normalized} → ${code}`);

  // Возвращаем код фронту — он сформирует wa.me ссылку
  return NextResponse.json({ ok: true, code });
}
