// Когда и что сообщать о встречах и напоминаниях. Без window и document: модуль общий
// для уведомлений браузера (notifications.js) и Telegram-бота (telegram-bot/notify.mjs).
import { plural } from './dom.js';
import { formatTime } from './time.js';

export const SOON_MS = 15 * 60 * 1000;
// Момент начала ещё сообщаем, если проверка опоздала не больше чем на две минуты
export const LATE_MS = 2 * 60 * 1000;
const MINUTES = ['минуту', 'минуты', 'минут'];

/** Момент события в мс: время напоминания или начало встречи. Встречи на весь день не уведомляют */
export function momentOf(item) {
  if (item.type === 'reminder' && item.status === 'open' && item.remind_at) return Date.parse(item.remind_at);
  if (item.type === 'meeting' && item.status === 'scheduled' && item.start_at && !item.all_day) return Date.parse(item.start_at);
  return null;
}

/**
 * Что сообщить о записи в момент nowMs: 'soon' — за 15 минут, 'now' — в момент начала, иначе null.
 * key одинаков для одного и того же срабатывания: по нему отсеиваются повторы.
 */
export function dueNotice(item, nowMs) {
  const at = momentOf(item);
  if (at == null) return null;
  const left = at - nowMs;
  let kind = null;
  // Меньше минуты до начала — «скоро» уже не нужно, сработает момент начала
  if (left > 60 * 1000 && left <= SOON_MS) kind = 'soon';
  else if (left <= 0 && left > -LATE_MS) kind = 'now';
  return kind ? { kind, at, key: `${item.id}:${kind}:${at}` } : null;
}

/** Заголовок и текст уведомления */
export function describe(item, kind, at, nowMs) {
  const time = formatTime(new Date(at));
  const range = item.type === 'meeting' && item.end_at ? `${time}–${formatTime(item.end_at)}` : time;
  const place = item.location ? ` · ${item.location}` : '';
  if (kind === 'soon') {
    const minutes = Math.max(1, Math.round((at - nowMs) / 60000));
    const what = item.type === 'meeting' ? 'Встреча' : 'Напоминание';
    return { title: `Через ${minutes} ${plural(minutes, MINUTES)}: ${item.title}`, body: `${what} в ${range}${place}` };
  }
  if (item.type === 'meeting') return { title: `Начинается встреча: ${item.title}`, body: `${range}${place}` };
  return { title: `Напоминаю: ${item.title}`, body: `Напоминание на ${time}` };
}
