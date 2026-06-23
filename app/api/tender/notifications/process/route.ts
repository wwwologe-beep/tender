import { NextRequest, NextResponse } from 'next/server';
import { processNotificationBatch } from '@/lib/notification-queue';

// POST /api/tender/notifications/process
// Body: { batch_size?: number, secret?: string }
// Можно вызывать из cron (Vercel Cron Job) или вручную.
export async function POST(req: NextRequest) {
  try {
    // Простая защита от случайного вызова извне
    const secret = req.headers.get('x-cron-secret');
    const expectedSecret = process.env.CRON_SECRET;
    if (expectedSecret && secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    let batchSize = 25;
    try {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      if (typeof body.batch_size === 'number' && body.batch_size > 0) {
        batchSize = Math.min(body.batch_size as number, 50);
      }
    } catch {
      // пустое тело — использует дефолт
    }

    const result = await processNotificationBatch(batchSize);

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (err) {
    console.error('[notifications/process]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Внутренняя ошибка' },
      { status: 500 }
    );
  }
}

// GET — для проверки состояния (health check)
export async function GET() {
  return NextResponse.json({ ok: true, endpoint: 'notifications/process' });
}
