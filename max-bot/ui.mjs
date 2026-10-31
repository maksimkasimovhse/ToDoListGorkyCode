// Кнопки MAX: до 7 в ряду, до 30 рядов, payload до 1024 символов, текст до 128.
// Формат payload: «префикс:действие:значение». Префиксы:
//   m — главное меню, w — шаг мастера, s — настройки, n — кнопки уведомления,
//   o — вариант ответа ассистента, u — отмена действия, x — пустая кнопка (ничего не делает).
import { addDays, todayKey, weekdayIndex } from '../web/js/time.js';

export const button = (text, payload) => ({ type: 'callback', text: String(text).slice(0, 128), payload: String(payload).slice(0, 1024) });
export const noop = (text) => button(text, 'x');

/** Раскладывает кнопки по рядам по n штук */
export function rows(buttons, n) {
  const out = [];
  for (let i = 0; i < buttons.length; i += n) out.push(buttons.slice(i, i + n));
  return out;
}

export const MENU_BUTTONS = [
  [button('➕ Задача', 'm:new:task'), button('⏰ Напоминание', 'm:new:reminder'), button('👥 Встреча', 'm:new:meeting')],
  [button('📅 Сегодня', 'm:day:0'), button('📆 Завтра', 'm:day:1'), button('🗓 Неделя', 'm:week')],
  [button('⚙️ Уведомления', 'm:settings'), button('❓ Помощь', 'm:help')],
];

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

function monthShift(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}

/**
 * Календарь месяца month ('YYYY-MM'). prefix — начало payload, к которому добавляется значение:
 * `${prefix}:2026-11-05` для дня и `${prefix}:month:2026-12` для листания. Прошедшие дни недоступны.
 */
export function calendar(prefix, month = todayKey().slice(0, 7)) {
  const today = todayKey();
  const first = `${month}-01`;
  const current = today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const result = [[
    month > current ? button('‹', `${prefix}:month:${monthShift(month, -1)}`) : noop(' '),
    noop(`${MONTHS[m - 1]} ${y}`),
    button('›', `${prefix}:month:${monthShift(month, 1)}`),
  ]];
  result.push(WEEKDAYS.map((day) => noop(day)));
  let row = Array.from({ length: weekdayIndex(first) }, () => noop(' '));
  for (let key = first; key.slice(0, 7) === month; key = addDays(key, 1)) {
    const day = String(Number(key.slice(8)));
    if (key < today) row.push(noop('·'));
    else row.push(button(key === today ? `[${day}]` : day, `${prefix}:${key}`));
    if (row.length === 7) {
      result.push(row);
      row = [];
    }
  }
  if (row.length) result.push([...row, ...Array.from({ length: 7 - row.length }, () => noop(' '))]);
  return result;
}

/** Часы 00–23 сеткой 6×4; значения «07», «15» */
export function hours(prefix, { from = 0 } = {}) {
  const list = [];
  for (let h = from; h < 24; h++) list.push(button(`${String(h).padStart(2, '0')}:…`, `${prefix}:${String(h).padStart(2, '0')}`));
  return rows(list, 4);
}

/** Минуты для выбранного часа: шаг 5 минут (или 15 для настроек) */
export function minutes(prefix, hour, { step = 5 } = {}) {
  const list = [];
  for (let m = 0; m < 60; m += step) {
    const value = `${hour}:${String(m).padStart(2, '0')}`;
    list.push(button(value, `${prefix}:${value}`));
  }
  return rows(list, 4);
}
