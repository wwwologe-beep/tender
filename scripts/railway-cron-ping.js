// Отдельный лёгкий cron-сервис для Railway: раз в интервал стучится на /api/cron/tick.
// Не часть Next.js-приложения — отдельный маленький процесс, деплоится как второй сервис
// в том же Railway-проекте с Custom Start Command: node scripts/railway-cron-ping.js
const APP_URL = process.env.TICK_TARGET_URL || 'https://tender-production-26c5.up.railway.app';
const CRON_SECRET = process.env.CRON_SECRET;
const INTERVAL_MS = Number(process.env.TICK_INTERVAL_MS || 60_000); // раз в минуту по умолчанию

async function ping() {
  try {
    const res = await fetch(`${APP_URL}/api/cron/tick`, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
    });
    console.log(`[${new Date().toISOString()}] tick -> HTTP ${res.status}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] tick failed:`, err.message);
  }
}

console.log(`Starting cron ping loop: ${APP_URL}/api/cron/tick every ${INTERVAL_MS}ms`);
ping();
setInterval(ping, INTERVAL_MS);
