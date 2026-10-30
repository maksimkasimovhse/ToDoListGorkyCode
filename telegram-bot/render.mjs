// Ответ ассистента (contracts.md, 2.1–2.2) → сообщение Telegram: HTML-текст и клавиатура.
// Подписи записей и группировка по дням — общие с сайтом (web/js/items.js).
import { describeChanges, dueNote, groupByDay, statusLabel, timeLabel } from '../web/js/items.js';
import { dayKey, dayTitle } from '../web/js/time.js';

const LIMIT = 4000;

export const escape = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** «<b>15:00–16:00</b> — Встреча с командой · просрочена» */
export function itemLine(item) {
  const time = timeLabel(item);
  const notes = [dueNote(item), statusLabel(item)].filter(Boolean).join(', ');
  const who = item.participants && item.participants.length && !item.title.includes(item.participants[0]) ? ` (${item.participants.join(', ')})` : '';
  return `${time ? `<b>${escape(time)}</b> — ` : ''}${escape(item.title)}${escape(who)}${notes ? ` · <i>${escape(notes)}</i>` : ''}`;
}

function itemsBlock(reply) {
  const items = reply.items || [];
  if (!items.length) return '';
  const data = reply.data || {};
  if (reply.type === 'results' && data.kind !== 'search') {
    const fromKey = data.from ? dayKey(data.from) : null;
    const toKey = data.to ? dayKey(data.to) : null;
    return groupByDay(items, fromKey, toKey)
      .map(({ key, items: day }) => [`<b>${escape(key ? dayTitle(key) : 'Без даты')}</b>`, ...day.map(itemLine)].join('\n'))
      .join('\n\n');
  }
  if (reply.type === 'results' || reply.type === 'choose') {
    return items.map((item, index) => `${item.number || index + 1}. ${itemLine(item)}`).join('\n');
  }
  if (reply.type === 'done') {
    const changes = (data.actions || []).flatMap((action) => describeChanges(action.before, action.after));
    if (changes.length) return changes.map((row) => `${escape(row.label)}: ${escape(row.from)} → <b>${escape(row.to)}</b>`).join('\n');
    // Подтверждение «Добавил…» уже описывает запись, карточку не дублируем
    return '';
  }
  return items.map(itemLine).join('\n');
}

function keyboard(reply) {
  const buttons = (reply.options || []).map((option) => ({ text: option.label, callback_data: `o:${option.id}`.slice(0, 64) }));
  if (reply.undo_token && reply.undo_token.length <= 62) buttons.push({ text: 'Отменить', callback_data: `u:${reply.undo_token}` });
  if (buttons.length) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    return { inline_keyboard: rows };
  }
  // Подсказки — обычная клавиатура: нажатие отправляет текст, как если бы его набрали
  if (reply.suggestions && reply.suggestions.length) {
    return { keyboard: reply.suggestions.map((text) => [{ text }]), resize_keyboard: true, one_time_keyboard: true };
  }
  return undefined;
}

export function renderReply(reply) {
  const parts = [escape(reply.reply || 'Готово.'), itemsBlock(reply)].filter(Boolean);
  let text = parts.join('\n\n');
  // Обрезаем по строке: внутри строки HTML-теги парные, а Telegram не примет оборванный тег
  if (text.length > LIMIT) text = `${text.slice(0, Math.max(text.lastIndexOf('\n', LIMIT), 0))}\n…`;
  return { text, reply_markup: keyboard(reply) };
}

export const plain = (text, reply_markup) => ({ text: escape(text), reply_markup });
