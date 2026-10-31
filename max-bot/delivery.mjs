// Доставка уведомлений: бэкенд кладёт их в Redis Stream planner:notify:max, бот читает поток
// своей группой, отправляет сообщение в MAX и подтверждает доставку бэкенду.
// Гарантия «хотя бы один раз»: строка потока подтверждается (XACK) только после отправки,
// повтор той же доставки отсекается отметкой max:sent:<id>.
import { digest, notification } from './render.mjs';
import { MaxError } from './max.mjs';

export const STREAM = 'planner:notify:max';
export const GROUP = 'max-bot';

/** Одна доставка. Возвращает true, если строку потока можно подтвердить */
export function createDeliverer({ max, backend, store, log = () => {}, now = () => Date.now() }) {
  async function ack(id, body) {
    try {
      await backend.ack(id, body);
    } catch (error) {
      // Бэкенд вернёт уведомление в очередь через NOTIFY_ACK_TIMEOUT; повтор отсечётся отметкой
      log('ack failed', { id, error: error.message });
    }
  }

  return async function deliver(delivery) {
    if (!delivery || delivery.version !== 1 || !delivery.id || !delivery.external_id) {
      log('malformed delivery dropped', { delivery });
      return true;
    }
    if (await store.isSent(delivery.id)) {
      await ack(delivery.id, { status: 'sent', external_id: delivery.external_id });
      return true;
    }
    const message = delivery.kind === 'digest' ? digest(delivery) : notification(delivery, now());
    try {
      await max.send(delivery.external_id, message);
    } catch (error) {
      if (error instanceof MaxError && error.unreachable) {
        log('user unreachable, channel disabled', { id: delivery.id, user: delivery.external_id, status: error.status });
        await ack(delivery.id, { status: 'failed', error: error.message, external_id: delivery.external_id, disable_channel: true });
        return true;
      }
      // Сеть, 429, 5xx: строку не подтверждаем, повторим позже
      log('delivery failed, will retry', { id: delivery.id, error: error.message });
      return false;
    }
    await store.markSent(delivery.id);
    await ack(delivery.id, { status: 'sent', external_id: delivery.external_id });
    return true;
  };
}

/** Цикл чтения потока. Возвращает функцию остановки */
export function startConsumer({ redis, deliver, consumer = 'max-bot-1', log = () => {}, retryMs = 30000 }) {
  let running = true;
  let lastRetry = 0;

  async function ensureGroup() {
    try {
      await redis.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true });
    } catch (error) {
      if (!String(error.message).includes('BUSYGROUP')) throw error;
    }
  }

  async function handle(entries) {
    for (const entry of entries) {
      let payload = null;
      try {
        payload = JSON.parse(entry.message.payload);
      } catch {
        payload = null;
      }
      const done = await deliver(payload);
      if (done) await redis.xAck(STREAM, GROUP, entry.id);
    }
  }

  /** Свои неподтверждённые строки (после сбоя или перезапуска) */
  async function retryPending() {
    const result = await redis.xReadGroup(GROUP, consumer, { key: STREAM, id: '0' }, { COUNT: 50 });
    const entries = (result && result[0] && result[0].messages) || [];
    await handle(entries.filter((entry) => entry.message));
  }

  const loop = (async () => {
    await ensureGroup();
    while (running) {
      try {
        if (Date.now() - lastRetry >= retryMs) {
          lastRetry = Date.now();
          await retryPending();
        }
        const result = await redis.xReadGroup(GROUP, consumer, { key: STREAM, id: '>' }, { COUNT: 20, BLOCK: 5000 });
        if (result && result[0]) await handle(result[0].messages);
      } catch (error) {
        if (!running) break;
        log('notify stream error', { error: error.message });
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  })();

  return async () => {
    running = false;
    await loop.catch(() => {});
  };
}
