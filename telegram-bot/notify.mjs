// Уведомления в Telegram за 15 минут до встречи или напоминания и в момент начала.
// Правила общие с уведомлениями браузера: web/js/schedule.js.
import { LATE_MS, describe, dueNotice } from '../web/js/schedule.js';
import { now } from '../web/js/time.js';
import { escape } from './render.mjs';

const LOOKAHEAD_MS = 2 * 60 * 60 * 1000;

export function createNotifier({ tg, backend, store, log }) {
  async function checkChat(chat) {
    if (!(await store.notifyEnabled(chat))) return;
    const token = await store.token(chat);
    const current = now().getTime();
    const result = await backend.items(token, {
      from: new Date(current - LATE_MS).toISOString(),
      to: new Date(current + LOOKAHEAD_MS).toISOString(),
      types: 'meeting,reminder',
    });
    for (const item of (result && result.items) || []) {
      const notice = dueNotice(item, current);
      // Отметка ставится до отправки: при сбое лучше пропустить уведомление, чем прислать два
      if (!notice || !(await store.markFired(chat, notice.key))) continue;
      const text = describe(item, notice.kind, notice.at, current);
      const buttons = item.type === 'reminder' && notice.kind === 'now'
        ? { inline_keyboard: [[{ text: 'Сделано', callback_data: `d:${item.id}` }, { text: 'Через 15 минут', callback_data: `s:${item.id}` }]] }
        : undefined;
      await tg.send(chat, { text: `🔔 <b>${escape(text.title)}</b>\n${escape(text.body)}`, reply_markup: buttons });
    }
  }

  /** Один проход по всем чатам. Ошибка одного чата не мешает остальным */
  async function check() {
    for (const chat of await store.chats()) {
      try {
        await checkChat(chat);
      } catch (error) {
        log('notify failed', { chat, error: error.message });
      }
    }
  }

  return {
    check,
    /** Запускает проверку каждые intervalMs; возвращает функцию остановки */
    start(intervalMs = 30 * 1000) {
      let stopped = false;
      let timer = null;
      const loop = async () => {
        try {
          await check();
        } catch (error) {
          // Например, Redis на мгновение недоступен: пропускаем проход, а не роняем процесс
          log('notify loop failed', { error: error.message });
        }
        if (!stopped) timer = setTimeout(loop, intervalMs);
      };
      loop();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  };
}
