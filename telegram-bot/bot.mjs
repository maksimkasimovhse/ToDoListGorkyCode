// Telegram-бот ассистента: второй клиент того же API, что и сайт. Сообщения забираются long polling,
// поэтому публичный адрес не нужен. Архитектура и запуск — README.md.
import { createClient } from 'redis';
import { configureClock } from '../web/js/time.js';
import { createAuth } from './auth.mjs';
import { createBackend } from './backend.mjs';
import { COMMANDS, createDialog } from './dialog.mjs';
import { createNotifier } from './notify.mjs';
import { createRedisStore } from './store.mjs';
import { createTelegram } from './telegram.mjs';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:8080').replace(/\/$/, '');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';
const ALLOWED = new Set((process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map((id) => Number(id.trim())).filter(Boolean));

const log = (message, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

if (!TOKEN) {
  log('TELEGRAM_BOT_TOKEN is required');
  process.exit(1);
}

// Даты и «сегодня» — в поясе пользователя, как на сайте. В контейнере системный пояс UTC
configureClock({ timezone: TIMEZONE });

const redis = createClient({ url: REDIS_URL });
redis.on('error', (error) => log('redis error', { error: error.message }));
await redis.connect();

const store = createRedisStore(redis);
const tg = createTelegram({ token: TOKEN });
const backend = createBackend({ baseUrl: BACKEND_URL, timezone: TIMEZONE });
const auth = createAuth({ tg, backend, store, log });
const dialog = createDialog({ tg, backend, store, auth, log, allowed: ALLOWED });
const notifier = createNotifier({ tg, backend, store, log });

const me = await tg.call('getMe');
await tg.call('setMyCommands', { commands: COMMANDS });
log('telegram bot started', { bot: me.username, backend: BACKEND_URL, allowed: ALLOWED.size || 'all' });

const stopNotifier = notifier.start();
const controller = new AbortController();
let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    running = false;
    controller.abort();
  });
}

// offset хранится в Redis: после перезапуска бот не обрабатывает старые апдейты заново
let offset = await store.offset();
while (running) {
  let updates;
  try {
    updates = await tg.call('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] }, { signal: controller.signal });
  } catch (error) {
    if (!running) break;
    log('getUpdates failed', { error: error.message });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
  }
  for (const update of updates) {
    // Чаты обрабатываются параллельно, сообщения внутри чата — по очереди (dialog.mjs)
    dialog.handleUpdate(update);
    offset = update.update_id + 1;
  }
  if (updates.length) await store.setOffset(offset);
}

stopNotifier();
await redis.quit();
log('telegram bot stopped');
