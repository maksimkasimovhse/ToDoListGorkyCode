// Бот MAX: клиент того же API, что и сайт. События забираются long polling (GET /updates),
// уведомления приходят от бэкенда через Redis Stream. Архитектура и запуск — README.md.
import { createClient } from 'redis';
import { configureClock } from '../web/js/time.js';
import { createBackend } from './backend.mjs';
import { createDeliverer, startConsumer } from './delivery.mjs';
import { createDialog } from './dialog.mjs';
import { createMax } from './max.mjs';
import { createRedisStore } from './store.mjs';

const TOKEN = process.env.MAX_BOT_TOKEN;
const BOT_SERVICE_TOKEN = process.env.BOT_SERVICE_TOKEN;
const MAX_API_URL = (process.env.MAX_API_URL || 'https://platform-api2.max.ru').replace(/\/$/, '');
const BACKEND_URL = (process.env.BACKEND_URL || 'http://localhost:8080').replace(/\/$/, '');
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';
const TIMEZONE = process.env.TIMEZONE || 'Europe/Moscow';
const CONSUMER = process.env.MAX_CONSUMER || 'max-bot-1';
const ALLOWED = new Set((process.env.MAX_ALLOWED_USERS || '').split(',').map((id) => Number(id.trim())).filter(Boolean));
const UPDATE_TYPES = ['message_created', 'message_callback', 'bot_started'];

const log = (message, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

for (const [name, value] of [['MAX_BOT_TOKEN', TOKEN], ['BOT_SERVICE_TOKEN', BOT_SERVICE_TOKEN]]) {
  if (!value) {
    log(`${name} is required`);
    process.exit(1);
  }
}

// Даты и «сегодня» — в поясе пользователя, как на сайте. В контейнере системный пояс UTC
configureClock({ timezone: TIMEZONE });

const redis = createClient({ url: REDIS_URL });
redis.on('error', (error) => log('redis error', { error: error.message }));
await redis.connect();
// Чтение потока блокирующее (BLOCK), поэтому у него своё соединение
const streamRedis = redis.duplicate();
streamRedis.on('error', (error) => log('redis stream error', { error: error.message }));
await streamRedis.connect();

const store = createRedisStore(redis);
const max = createMax({ token: TOKEN, baseUrl: MAX_API_URL });
const backend = createBackend({ baseUrl: BACKEND_URL, botToken: BOT_SERVICE_TOKEN, timezone: TIMEZONE });
const dialog = createDialog({ max, backend, store, log, allowed: ALLOWED });
const deliver = createDeliverer({ max, backend, store, log });

const me = await max.me();
log('max bot started', { bot: me.username || me.name, user_id: me.user_id, backend: BACKEND_URL, allowed: ALLOWED.size || 'all' });

const stopConsumer = startConsumer({ redis: streamRedis, deliver, consumer: CONSUMER, log });
const controller = new AbortController();
let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    running = false;
    controller.abort();
  });
}

// marker хранится в Redis: после перезапуска бот продолжает с того же места
let marker = await store.marker();
while (running) {
  let result;
  try {
    result = await max.updates({ marker, timeout: 30, types: UPDATE_TYPES }, { signal: controller.signal });
  } catch (error) {
    if (!running) break;
    log('updates failed', { error: error.message });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    continue;
  }
  for (const update of (result && result.updates) || []) {
    // Пользователи обрабатываются параллельно, события одного пользователя — по очереди
    dialog.handleUpdate(update);
  }
  if (result && result.marker != null && result.marker !== marker) {
    marker = result.marker;
    await store.setMarker(marker);
  }
}

await stopConsumer();
await streamRedis.quit().catch(() => {});
await redis.quit().catch(() => {});
log('max bot stopped');
