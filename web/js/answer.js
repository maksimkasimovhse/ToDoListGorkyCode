// Ответ на вопрос ассистента словами → поля формы бэкенда (backend/docs/dialogue-flow.md).
// Бэкенд принимает не текст, а { date, time, title, duration_min } или { confirmed }, поэтому
// «в 17» и «завтра» голосом или текстом превращаем в поля здесь.
import { addDays, todayKey } from './time.js';

const pad = (n) => String(n).padStart(2, '0');
const YES = /^(да|ок|окей|ok|давай|угу|ага|конечно|верно|подтверждаю)(\s\S+)?$/;
const NO = /^(нет|не надо|не|неа)$/;
const CANCEL = /^(отмена|отмени|забудь|стоп|хватит)$/;

function clean(text) {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/[!?,;«»"]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
}

/** 'да' → true, 'нет' → false, иначе null */
export function parseConfirmation(text) {
  const t = clean(text);
  if (YES.test(t)) return true;
  if (NO.test(t) || CANCEL.test(t)) return false;
  return null;
}

export const isCancel = (text) => CANCEL.test(clean(text));

function hour(value, qualifier) {
  if (qualifier === 'дня' || qualifier === 'вечера') return value < 12 ? value + 12 : value;
  if (qualifier === 'утра' || qualifier === 'ночи') return value === 12 ? 0 : value;
  return value >= 1 && value <= 7 ? value + 12 : value; // «в 3» — 15:00 [ФТ 5]
}

/** «в 17», «17:30», «в 5 вечера», «в полдень» → 'HH:MM' или null */
export function parseTime(text) {
  const t = clean(text);
  if (/(^|\s)в полдень/.test(t)) return '12:00';
  if (/(^|\s)в полночь/.test(t)) return '00:00';
  const m = /(?:^|\s)(?:в\s+)?(\d{1,2})(?:[:.\s](\d{2}))?(?:\s*час\S*)?(?:\s+(утра|дня|вечера|ночи))?(?=\s|$)/.exec(t);
  if (m && Number(m[1]) < 24 && (!m[2] || Number(m[2]) < 60)) return `${pad(hour(Number(m[1]), m[3]))}:${m[2] || '00'}`;
  if (/(^|\s)утром/.test(t)) return '09:00';
  if (/(^|\s)днем/.test(t)) return '13:00';
  if (/(^|\s)вечером/.test(t)) return '19:00';
  return null;
}

/** «сегодня», «завтра», «послезавтра» или '2026-11-05' → 'YYYY-MM-DD' или null */
export function parseDate(text) {
  const t = clean(text);
  const today = todayKey();
  if (/послезавтра/.test(t)) return addDays(today, 2);
  if (/завтра/.test(t)) return addDays(today, 1);
  if (/сегодня/.test(t)) return today;
  const iso = /(\d{4}-\d{2}-\d{2})/.exec(t);
  return iso ? iso[1] : null;
}

function parseDuration(text) {
  const t = clean(text);
  if (/на полчаса/.test(t)) return 30;
  const m = /на (\d+) минут/.exec(t);
  if (m) return Number(m[1]);
  const h = /на (?:(\d+) )?час(?:а|ов)?(?:\s|$)/.exec(t);
  return h ? Number(h[1] || 1) * 60 : null;
}

/** Поля ответа на вопрос expects: time | date | datetime | title. null — не удалось разобрать */
export function parseAnswer(expects, text) {
  const fields = {};
  if (expects === 'title') {
    const title = text.trim();
    return title ? { title } : null;
  }
  if (expects === 'time' || expects === 'datetime') {
    const time = parseTime(text);
    if (time) fields.time = time;
  }
  if (expects === 'date' || expects === 'datetime') {
    const date = parseDate(text);
    if (date) fields.date = date;
  }
  const duration = parseDuration(text);
  if (duration && Object.keys(fields).length) fields.duration_min = duration;
  const required = expects === 'datetime' ? ['date', 'time'] : [expects];
  return required.every((name) => fields[name]) ? fields : null;
}
