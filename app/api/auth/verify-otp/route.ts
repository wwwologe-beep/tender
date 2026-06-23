import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  const { phone, code } = await req.json() as { phone?: string; code?: string };
  if (!phone || !code) return NextResponse.json({ error: 'phone and code required' }, { status: 400 });

  const normalized = phone.replace(/\s+/g, '');

  const { data, error } = await supabaseAdmin
    .from('client_otp_codes')
    .select('code, expires_at')
    .eq('phone', normalized)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Код не найден. Запросите новый.' }, { status: 404 });
  }

  if (data.code !== code.trim()) {
    return NextResponse.json({ error: 'Неверный код.' }, { status: 401 });
  }

  if (new Date(data.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Код истёк. Запросите новый.' }, { status: 410 });
  }

  // Delete used code
  await supabaseAdmin.from('client_otp_codes').delete().eq('phone', normalized);

  // Issue a session token
  const token = randomUUID();

  // Upsert client record (for profile / orders lookup)
  await supabaseAdmin
    .from('tender_clients')
    .upsert({ phone: normalized, session_token: token, last_login: new Date().toISOString() }, { onConflict: 'phone' });

  return NextResponse.json({ ok: true, token, phone: normalized });
}
