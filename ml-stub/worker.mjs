// ML-заглушка: читает задания бэкенда из Redis Streams и отвечает разбором по правилам (parse.mjs).
// Порядок работы — backend/docs/async-contract.md, раздел «Redis». Настоящий ML-модуль встаёт на это место.
import { createClient } from 'redis';
import { parseRequest } from './parse.mjs';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379/0';
const REQUESTS = process.env.ML_REQUEST_STREAM || 'planner:ml:requests';
const RESULTS = process.env.ML_RESULT_STREAM || 'planner:ml:results';
const GROUP = process.env.ML_REQUEST_GROUP || 'planner-ml';
// Постоянное имя: после перезапуска заглушка дочитает свои неподтверждённые задания
const CONSUMER = process.env.ML_CONSUMER || 'ml-stub';

const log = (message, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...fields }));

const client = createClient({ url: REDIS_URL });
client.on('error', (error) => log('redis error', { error: error.message }));
await client.connect();
// Блокирующее чтение держит соединение, поэтому для записи — отдельный клиент
const reader = client.duplicate();
await reader.connect();

try {
  // С позиции 0, чтобы не потерять задания, накопленные до первого запуска
  await client.xGroupCreate(REQUESTS, GROUP, '0', { MKSTREAM: true });
} catch (error) {
  if (!String(error.message).includes('BUSYGROUP')) throw error;
}
log('ml-stub started', { redis: REDIS_URL.replace(/\/\/[^@]*@/, '//***@'), requests: REQUESTS, results: RESULTS, group: GROUP });

let running = true;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    running = false;
  });
}

/** Результат или ошибка по контракту; null — задание просрочено, отвечать не нужно */
function answer(job) {
  if (Date.parse(job.deadline_at) < Date.now()) return null;
  const envelope = { version: 1, message_id: job.message_id, attempt_id: job.attempt_id };
  try {
    return { ...envelope, result: parseRequest(job.request) };
  } catch (error) {
    log('parse failed', { message_id: job.message_id, error: error.message });
    return { ...envelope, result: null, error: 'llm_unavailable' };
  }
}

async function handle(entry) {
  let job;
  try {
    job = JSON.parse(entry.message.payload);
  } catch {
    log('bad job payload, dropped', { id: entry.id });
    await client.multi().xAck(REQUESTS, GROUP, entry.id).xDel(REQUESTS, entry.id).exec();
    return;
  }

  const envelope = answer(job);
  const transaction = client.multi();
  if (envelope) transaction.xAdd(RESULTS, '*', { payload: JSON.stringify(envelope) });
  // Результат публикуется в той же транзакции, что и подтверждение задания
  await transaction.xAck(REQUESTS, GROUP, entry.id).xDel(REQUESTS, entry.id).exec();

  const result = envelope && envelope.result;
  log(envelope ? 'answered' : 'expired, skipped', {
    message_id: job.message_id,
    text: job.request && job.request.text,
    expects: job.request && job.request.expects,
    status: result ? result.status : envelope && envelope.error,
    intents: result ? result.actions.map((a) => a.intent) : [],
  });
}

// Сначала свои неподтверждённые задания (id 0), затем новые (>)
let position = '0';
while (running) {
  const response = await reader.xReadGroup(GROUP, CONSUMER, { key: REQUESTS, id: position }, { COUNT: 10, BLOCK: 2000 });
  const entries = response && response.length ? response[0].messages : [];
  if (!entries.length) {
    position = '>';
    continue;
  }
  for (const entry of entries) {
    try {
      await handle(entry);
    } catch (error) {
      log('handle failed, will retry after restart', { id: entry.id, error: error.message });
    }
  }
}

await Promise.allSettled([reader.quit(), client.quit()]);
log('ml-stub stopped');
