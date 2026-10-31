// Тексты сообщений бота: HTML (format: "html") и кнопки MAX.
// Подписи записей и группировка по дням — общие с сайтом (web/js/items.js).
import { describeChanges, dueNote, groupByDay, statusLabel, timeLabel } from '../web/js/items.js';
import { dayKey, dayTitle, formatDay, formatTime } from '../web/js/time.js';
import { plural } from '../web/js/dom.js';
import { TEXT_LIMIT } from './max.mjs';
import { button, MENU_BUTTONS, rows } from './ui.mjs';

export const escape = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ICONS = { meeting: '👥', reminder: '⏰', task: '✅' };
const MINUTES = ['минуту', 'минуты', 'минут'];

/** «<b>15:00–16:00</b> — 👥 Встреча с командой · Онлайн» */
export function itemLine(item) {
  const time = timeLabel(item);
  const notes = [dueNote(item), statusLabel(item)].filter(Boolean).join(', ');
  const place = item.location ? ` · ${escape(item.location)}` : '';
  const who = item.participants && item.participants.length && !item.title.includes(item.participants[0]) ? ` (${escape(item.participants.join(', '))})` : '';
  return `${time ? `<b>${escape(time)}</b> — ` : ''}${ICONS[item.type] || ''} ${escape(item.title)}${who}${place}${notes ? ` · <i>${escape(notes)}</i>` : ''}`;
}

function clip(text) {
  if (text.length <= TEXT_LIMIT) return text;
  // Обрезаем по строке: внутри строки HTML-теги парные
  return `${text.slice(0, Math.max(text.lastIndexOf('\n', TEXT_LIMIT - 2), 0))}\n…`;
}

export const plain = (text, buttons) => ({ text: escape(text), buttons });
export const menu = (text = 'Что сделать?') => ({ text: escape(text), buttons: MENU_BUTTONS });
export const backToMenu = [[button('☰ Меню', 'm:menu')]];

/** Список записей по дням: для «Сегодня», «Завтра», «Неделя» */
export function agenda(title, items, fromKey, toKey) {
  if (!items.length) return { text: `<b>${escape(title)}</b>\n\nНичего не запланировано.`, buttons: MENU_BUTTONS };
  const days = groupByDay(items, fromKey, toKey)
    .map(({ key, items: day }) => [`<b>${escape(key ? dayTitle(key) : 'Без даты')}</b>`, ...day.map(itemLine)].join('\n'))
    .join('\n\n');
  return { text: clip(`<b>${escape(title)}</b>\n\n${days}`), buttons: MENU_BUTTONS };
}

// ---------- Ответы ассистента (contracts.md, 2.1–2.2) ----------

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
    return '';
  }
  return items.map(itemLine).join('\n');
}

export function renderReply(reply) {
  const text = clip([escape(reply.reply || 'Готово.'), itemsBlock(reply)].filter(Boolean).join('\n\n'));
  const buttons = (reply.options || []).map((option) => button(option.label, `o:${option.id}`));
  if (reply.undo_token) buttons.push(button('↩️ Отменить', `u:${reply.undo_token}`));
  // Подсказки ассистента — кнопкой, нажатие отправляет текст подсказки как сообщение
  for (const suggestion of (reply.suggestions || []).slice(0, 4)) buttons.push(button(suggestion, `t:${suggestion}`));
  return { text, buttons: buttons.length ? rows(buttons, 2) : undefined };
}

// ---------- Уведомления ----------

function details(item) {
  const parts = [];
  if (item.type === 'meeting') parts.push(item.end_at ? `${formatTime(item.start_at)}–${formatTime(item.end_at)}` : formatTime(item.start_at));
  if (item.location) parts.push(item.location);
  if (item.participants && item.participants.length) parts.push(item.participants.join(', '));
  return escape(parts.join(' · '));
}

function minutesText(count) {
  return `${count} ${plural(count, MINUTES)}`;
}

/** Уведомление «скоро» или «началось». nowMs — момент отправки: опоздание видно в тексте */
export function notification(delivery, nowMs = Date.now()) {
  const item = delivery.item;
  const at = Date.parse(delivery.event_at);
  const time = formatTime(new Date(at));
  const title = `<b>${escape(item.title)}</b>`;
  const info = details(item);
  const lateMin = Math.floor((nowMs - at) / 60000);
  const late = lateMin >= 2;
  const lines = [];
  if (delivery.kind === 'soon') {
    const left = Math.max(1, Math.round((at - nowMs) / 60000));
    lines.push(`⏳ Через ${minutesText(left)}: ${title}`);
    lines.push(item.type === 'meeting' ? `Встреча в ${info}` : `Напоминание на ${time}`);
  } else if (item.type === 'meeting') {
    lines.push(late ? `▶️ Встреча началась в ${time}: ${title}` : `▶️ Начинается встреча: ${title}`);
    if (info) lines.push(info);
  } else {
    lines.push(late ? `🔔 Напоминание на ${time}: ${title}` : `🔔 Напоминаю: ${title}`);
  }
  if (delivery.held) lines.push('<i>Пришло после тихих часов.</i>');
  else if (late && delivery.kind === 'now') lines.push(`<i>Доставлено с опозданием на ${minutesText(lateMin)}.</i>`);

  let buttons;
  if (item.type === 'reminder') {
    buttons = delivery.kind === 'now'
      ? [[button('✅ Сделано', `n:done:${item.id}`), button('⏰ Через 15 мин', `n:snooze15:${item.id}`), button('Через 1 ч', `n:snooze60:${item.id}`)]]
      : [[button('✅ Уже сделано', `n:done:${item.id}`)]];
  } else if (delivery.kind === 'soon') {
    buttons = [[button('❌ Отменить встречу', `n:cancel:${item.id}`)]];
  }
  return { text: lines.join('\n'), buttons };
}

/** Утренняя сводка: встречи и напоминания на день */
export function digest(delivery) {
  const items = delivery.items || [];
  const head = `☀️ Доброе утро! План на ${escape(formatDay(delivery.day))}:`;
  if (!items.length) return { text: `${head}\n\nВстреч и напоминаний нет.`, buttons: MENU_BUTTONS };
  const meetings = items.filter((i) => i.type === 'meeting').length;
  const reminders = items.length - meetings;
  const summary = [meetings && `${meetings} ${plural(meetings, ['встреча', 'встречи', 'встреч'])}`, reminders && `${reminders} ${plural(reminders, ['напоминание', 'напоминания', 'напоминаний'])}`].filter(Boolean).join(' и ');
  const list = [...items].sort((a, b) => Date.parse(a.start_at || a.remind_at) - Date.parse(b.start_at || b.remind_at)).map(itemLine).join('\n');
  return { text: clip(`${head} ${summary}.\n\n${list}`), buttons: MENU_BUTTONS };
}

/** Когда придут уведомления о новой записи: «Уведомлю в 14:45 и в 15:00» */
export function notifyNote(item, nowMs = Date.now()) {
  const at = item.type === 'meeting' ? (item.all_day ? null : item.start_at) : item.type === 'reminder' ? item.remind_at : null;
  if (!at) return item.type === 'task' ? '' : 'О встречах на весь день расскажу в утренней сводке.';
  const moment = Date.parse(at);
  const soon = moment - 15 * 60000;
  const withSoon = item.type === 'meeting' ? moment - nowMs > 60000 : moment - nowMs >= 15 * 60000;
  if (!withSoon) return `🔔 Уведомлю в ${formatTime(new Date(moment))}.`;
  return `🔔 Уведомлю в ${formatTime(new Date(Math.max(soon, nowMs)))} и в ${formatTime(new Date(moment))}.`;
}
