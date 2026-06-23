import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

// GET /api/auth/check-whatsapp?phone=+995...
// Фронт поллит каждые 2с — проверяем появилась ли сессия
export async function GET(req: NextRequest) {
  const phone = req.nextUrl.searchParams.get('phone');
  if (!phone) return NextResponse.json({ ready: false });

  const normalized = phone.replace(/\s+/g, '');

  const { data } = await supabaseAdmin
    .from('tender_clients')
    .select('session_token, last_login')
    .eq('phone', normalized)
    .single();

  if (!data?.session_token) return NextResponse.json({ ready: false });

  // Проверяем что сессия свежая (создана в последние 5 минут)
  const loginTime = new Date(data.last_login).getTime();
  const isRecent  = Date.now() - loginTime < 5 * 60 * 1000;

  if (!isRecent) return NextResponse.json({ ready: false });

  return NextResponse.json({ ready: true, token: data.session_token, phone: normalized });
}
