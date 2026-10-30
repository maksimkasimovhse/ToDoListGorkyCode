// Разбор фраз правилами — заглушка вместо LLM-модуля (contracts.md, раздел 3).
// Покрывает фразы из ФТ и критериев приёмки, а не русский язык целиком.
import { NOW, addDays, addMinutes, lastDayOfMonth, mondayOf, nowTime, today, toIso, wall, weekday } from './clock.js';

const NUMBER_WORDS = {
  один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30,
  сорок: 40, пятьдесят: 50,
};
const NUMBER_WORDS_RE = Object.keys(NUMBER_WORDS).join('|');
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_RE = MONTHS.join('|');
const WEEKDAY_FORMS = ['понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу', 'воскресенье'];
const pad = (n) => String(n).padStart(2, '0');

export const YES = /^(да|ок|окей|ok|давай|угу|ага|конечно|верно|подтверждаю)( \S+)?$/;
export const NO = /^(нет|не надо|отмена|не|неа)$/;

/** Нижний регистр, ё → е, без знаков препинания, числа словами → цифры */
export function normalize(raw) {
  const words = raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[!?,;«»"„“”()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (NUMBER_WORDS[word] != null ? String(NUMBER_WORDS[word]) : word));
  return words
    .join(' ')
    .replace(/(\d)0 ([1-9])(?!\d)/g, (_, tens, unit) => String(Number(`${tens}0`) + Number(unit)))
    .replace(/\.$/, '');
}

// ---------- Время ----------

function toHour(hour, qualifier) {
  if (qualifier === 'дня' || qualifier === 'вечера') return hour < 12 ? hour + 12 : hour;
  if (qualifier === 'утра' || qualifier === 'ночи') return hour === 12 ? 0 : hour;
  return hour >= 1 && hour <= 7 ? hour + 12 : hour; // «в 3» — 15:00 [ФТ 5]
}

/** { time: 'HH:MM', end_time? } или null */
export function parseTime(t) {
  let m = /(?:^|\s)с (\d{1,2})(?:[:.](\d{2}))? до (\d{1,2})(?:[:.](\d{2}))?/.exec(t);
  if (m) return { time: `${pad(toHour(+m[1]))}:${m[2] || '00'}`, end_time: `${pad(toHour(+m[3]))}:${m[4] || '00'}` };
  if (/(?:^|\s)в полдень/.test(t)) return { time: '12:00' };
  if (/(?:^|\s)в полночь/.test(t)) return { time: '00:00' };
  m = /(?:^|\s)в (\d{1,2})(?:[:.](\d{2})| (\d{2})(?= |$))?(?: час\S*)?(?: (утра|дня|вечера|ночи))?(?=\s|$)/.exec(t);
  if (m && +m[1] < 24) return { time: `${pad(toHour(+m[1], m[4]))}:${m[2] || m[3] || '00'}` };
  // «на 16:33» — только с минутами: «на 2 часа» — это длительность, а не время
  m = /(?:^|\s)на (\d{1,2})[:.](\d{2})(?=\s|$)/.exec(t);
  if (m && +m[1] < 24) return { time: `${pad(+m[1])}:${m[2]}` };
  if (/(?:^|\s)утром/.test(t)) return { time: '09:00' };
  if (/(?:^|\s)днем/.test(t)) return { time: '13:00' };
  if (/(?:^|\s)вечером/.test(t)) return { time: '19:00' };
  return null;
}

/** Ответ одним временем: «17», «в 17», «17:30» */
export function parseBareTime(t) {
  const m = /^(?:в |на )?(\d{1,2})(?:[:.](\d{2}))?(?: час\S*)?(?: (утра|дня|вечера|ночи))?$/.exec(t);
  return m && +m[1] < 24 ? { time: `${pad(toHour(+m[1], m[3]))}:${m[2] || '00'}` } : null;
}

/** «на 16» в командах изменения: «перенеси на 16» */
export function parseOnTime(t) {
  const m = new RegExp(`(?:^|\\s)на (\\d{1,2})(?:[:.](\\d{2}))?(?=\\s|$)(?! (?:час|минут|${MONTHS_RE}))`).exec(t);
  return m && +m[1] < 24 ? { time: `${pad(toHour(+m[1]))}:${m[2] || '00'}` } : null;
}

// ---------- Даты ----------

/** { date, time?, sameWeekday?, relative? } или null */
export function parseDate(t) {
  const base = today();
  if (/послезавтра/.test(t)) return { date: addDays(base, 2) };
  if (/завтра/.test(t)) return { date: addDays(base, 1) };
  if (/сегодня/.test(t)) return { date: base };

  let m = /через (?:(\d+) )?(полчаса|час|часа|часов|минуту|минуты|минут)(?=\s|$)/.exec(t);
  if (m) {
    const n = Number(m[1] || 1);
    const minutes = m[2] === 'полчаса' ? 30 : m[2].startsWith('час') ? n * 60 : n;
    const at = wall(addMinutes(NOW, minutes));
    return { date: at.date, time: at.time, relative: true };
  }
  m = /через (?:(\d+) )?(день|дня|дней|неделю|недели|недель)(?=\s|$)/.exec(t);
  if (m) return { date: addDays(base, Number(m[1] || 1) * (m[2].startsWith('недел') ? 7 : 1)) };

  m = new RegExp(`(?:^|\\s)(?:в|во|на|до) (следующ\\S* )?(${WEEKDAY_FORMS.join('|')})(?=\\s|$)`).exec(t);
  if (m) {
    const index = WEEKDAY_FORMS.indexOf(m[2]);
    if (m[1]) return { date: addDays(mondayOf(base), 7 + index) };
    const diff = (index - weekday(base) + 7) % 7;
    // «в четверг», когда сегодня четверг, — решаем после того, как известно время [ФТ 5]
    return { date: addDays(base, diff), sameWeekday: diff === 0 };
  }

  m = new RegExp(`(?:^|\\s)(\\d{1,2}) (${MONTHS_RE})`).exec(t) || /(?:^|\s)(\d{1,2})\.(\d{1,2})(?:\.\d{4})?(?=\s|$)/.exec(t);
  if (m) {
    const month = MONTHS.includes(m[2]) ? MONTHS.indexOf(m[2]) + 1 : Number(m[2]);
    let date = `${base.slice(0, 4)}-${pad(month)}-${pad(Number(m[1]))}`;
    if (date < base) date = `${Number(base.slice(0, 4)) + 1}${date.slice(4)}`; // год никогда не прошедший
    return { date };
  }
  return null;
}

/** Итоговые дата и время с правилами [ФТ 5]; past — дата названа явно, а момент уже прошёл */
export function resolveWhen({ date, time, sameWeekday, relative }) {
  if (date && sameWeekday && time && time <= nowTime()) return { date: addDays(date, 7), time, past: false };
  if (!date && time) return { date: time <= nowTime() ? addDays(today(), 1) : today(), time, past: false };
  const past = Boolean(date && time && !relative && (date < today() || (date === today() && time <= nowTime())));
  return { date, time, past };
}

// ---------- Периоды ----------

export function parsePeriod(t) {
  if (/до конца недели|на этой неделе|на эту неделю|эту неделю|на неделю|этой недели/.test(t)) return 'this_week';
  if (/на следующей неделе|следующую неделю|следующей недели/.test(t)) return 'next_week';
  if (/до конца месяца|в этом месяце|этот месяц/.test(t)) return 'month';
  if (/на прошлой неделе|прошлую неделю/.test(t)) return 'last_week';
  if (/в прошлом месяце/.test(t)) return 'last_month';
  return null;
}

/** Срок-период задачи [ФТ 5]: [period_start, period_end] */
export function taskPeriod(period) {
  const base = today();
  const monday = mondayOf(base);
  if (period === 'this_week') return [NOW, toIso(addDays(monday, 6), '23:59')];
  if (period === 'next_week') return [toIso(addDays(monday, 7)), toIso(addDays(monday, 13), '23:59')];
  if (period === 'month') return [NOW, toIso(lastDayOfMonth(base), '23:59')];
  return null;
}

/** Период запроса списка [ФТ 5]: [from, to), to не включается */
export function listRange(period) {
  const base = today();
  const monday = mondayOf(base);
  switch (period) {
    case 'this_week': return [NOW, toIso(addDays(monday, 7))];
    case 'next_week': return [toIso(addDays(monday, 7)), toIso(addDays(monday, 14))];
    case 'month': return [NOW, toIso(addDays(lastDayOfMonth(base), 1))];
    case 'last_week': return [toIso(addDays(monday, -7)), toIso(monday)];
    case 'last_month': {
      const first = `${base.slice(0, 8)}01`;
      return [toIso(`${addDays(first, -1).slice(0, 8)}01`), toIso(first)];
    }
    default: return null;
  }
}

export function parseDuration(t) {
  if (/на полчаса/.test(t)) return 30;
  let m = /на (\d+) минут/.exec(t);
  if (m) return Number(m[1]);
  m = /на (?:(\d+) )?час(?:ов|а)?(?![а-я])(?! позже| раньше)/.exec(t);
  return m ? Number(m[1] || 1) * 60 : null;
}

/** «на час позже» → 60, «на 30 минут раньше» → -30 */
export function parseShift(t) {
  const m = /(?:на )?(полчаса|час|(\d+) (час\S*|минут\S*)) (позже|раньше)/.exec(t);
  if (!m) return null;
  let minutes = 60;
  if (m[1] === 'полчаса') minutes = 30;
  else if (m[2]) minutes = Number(m[2]) * (m[3].startsWith('час') ? 60 : 1);
  return m[4] === 'раньше' ? -minutes : minutes;
}

export function parseOrdinal(t, { bare = false } = {}) {
  let m = /(?:^|\s)(?:номер|№)\s*(\d+)/.exec(t) || (bare ? /^(\d+)$/.exec(t) : null);
  if (m) return Number(m[1]);
  m = /(?:^|\s)(перв|втор|трет|четверт|пят)(?:ую|ой|ый|ое|ая|ья|ий|ью|ье)(?=\s|$)/.exec(t);
  if (m) return ['перв', 'втор', 'трет', 'четверт', 'пят'].indexOf(m[1]) + 1;
  return /(?:^|\s)последн\S*/.test(t) ? -1 : null;
}

// ---------- Намерение ----------

const MEETING_RE = /встреч|созвон|совещани|собрани|планерк|обед с|прием у|запись к/;

export function detectIntent(t) {
  if (/^(отмена|отмени|не надо|забудь|стоп|хватит)$/.test(t)) return 'cancel';
  if (/верни как было|отмени последнее|отмени это действие/.test(t)) return 'undo';
  if (/что ты умеешь|что ты можешь|^привет|^здравствуй|^помощь/.test(t)) return 'help';
  if (/^что (в|у) (ней|нем|этой|этом)/.test(t)) return 'show_focus';
  if (/верни в работу/.test(t)) return 'reopen';
  if (/(?:^|\s)(удали|удалить|отмени)(?:\s|$)/.test(t)) return 'delete';
  if (/перенеси|перенести|сдвинь|подвинь|переименуй|поменяй|измени|убери срок|добавь \S+ на встречу|сделай (ее|его|это|встречу)? ?на /.test(t)) return 'update';
  if (/^(а )?(я )?(уже )?(позвонил|написал|отправил|сделал|купил|сдал|проверил|оплатил|подготовил|выполнил)|отметь .*(сделан|выполнен)|^(готово|сделано)$/.test(t)) return 'complete';
  if (/найди|поищи|когда (у меня )?(была|был|было|будет)|ставил/.test(t)) return 'search';
  if (/что у меня|какие (у меня )?планы|планы на|запланировано|^покажи|какие (у меня )?(задачи|встречи|напоминания|дела)|есть ли у меня|свобод|следующая встреча|когда следующ|все задачи|задачи без срока/.test(t)) return 'list';
  if (/напомни|не дай .*забыть|напоминание/.test(t)) return 'create_reminder';
  if (MEETING_RE.test(t)) return 'create_meeting';
  if (/нужно|надо|поставь задачу|добавь задачу|создай задачу|^задача|купить|позвонить|написать|отправить|сдать|оплатить/.test(t)) return 'create_task';
  return 'unknown';
}

/** Типы из слов запроса [ФТ 8]: «встречи» — встречи, «задачи», «дела» — задачи и напоминания */
export function listTypes(t) {
  if (/встреч|созвон/.test(t)) return ['meeting'];
  if (/напоминани/.test(t)) return ['reminder'];
  if (/задач|дела/.test(t)) return ['task', 'reminder'];
  return null;
}

function strictTypes(t) {
  if (/встреч|созвон/.test(t)) return ['meeting'];
  if (/напоминани/.test(t)) return ['reminder'];
  if (/задач/.test(t)) return ['task'];
  return null;
}

// ---------- Суть и участники ----------

/** «Иваном» → «Иван», «командой» → «команда» */
export function nominative(word) {
  if (/ом$/i.test(word)) return word.slice(0, -2);
  if (/ем$/i.test(word)) return `${word.slice(0, -2)}й`;
  if (/ой$/i.test(word)) return `${word.slice(0, -2)}а`;
  if (/ей$/i.test(word)) return `${word.slice(0, -2)}я`;
  if (/ью$/i.test(word)) return `${word.slice(0, -2)}ь`;
  return word;
}

/** «Олю» → «Оля» */
function fromAccusative(word) {
  if (/ю$/i.test(word)) return `${word.slice(0, -1)}я`;
  if (/у$/i.test(word)) return `${word.slice(0, -1)}а`;
  return word;
}

const MEETING_KINDS = [
  [/встреч/i, 'Встреча'], [/созвон/i, 'Созвон'], [/совещани/i, 'Совещание'], [/собрани/i, 'Собрание'],
  [/планерк|планёрк/i, 'Планёрка'], [/обед/i, 'Обед'], [/при[её]м у врача/i, 'Приём у врача'],
];
const NOT_NAMES = new Set(['утра', 'вечера', 'обеда', 'понедельника', 'завтра', 'сегодня']);

/** Название встречи [ФТ 2]: «Встреча с командой», участники в именительном: ['команда'] */
export function meetingTitle(raw) {
  const kind = (MEETING_KINDS.find(([re]) => re.test(raw)) || [null, 'Встреча'])[1];
  const who = /(?:^|\s)со? ([А-ЯЁа-яё-]{3,})/i.exec(raw);
  if (who && !NOT_NAMES.has(who[1].toLowerCase())) {
    return { title: `${kind} с ${who[1]}`, participants: [nominative(who[1])] };
  }
  return { title: kind, participants: [] };
}

const TIME_WORD = `(?:\\d{1,2}(?:[:.]\\d{2})?|${NUMBER_WORDS_RE})`;
const TITLE_NOISE = [
  /напомни(?:те)?(?:\s+мне)?/gi,
  /не\s+дай(?:те)?\s+(?:мне\s+)?забыть(?:\s+про)?/gi,
  /(?:поставь|добавь|создай)(?:те)?\s+(?:мне\s+)?задачу/gi,
  /(?:поставь|добавь|создай|сделай|установи)(?:те)?\s+(?:мне\s+)?напоминани[ея](?:\s+(?:о|об|про|чтобы))?/gi,
  /(?:^|\s)(?:мне\s+)?(?:нужно|надо|необходимо)(?:\s+бы)?(?=\s|$)/gi,
  /(?:^|\s)(?:сегодня|завтра|послезавтра)(?=\s|$)/gi,
  new RegExp(`(?:^|\\s)(?:в|во|на|до)\\s+(?:следующ\\S*\\s+)?(?:${WEEKDAY_FORMS.join('|')})(?=\\s|$)`, 'gi'),
  /(?:^|\s)через\s+(?:\S+\s+)?(?:полчаса|час|часа|часов|минуту|минуты|минут|день|дня|дней|неделю|недели)(?=\s|$)/gi,
  /(?:^|\s)(?:до\s+конца\s+(?:недели|месяца)|на\s+(?:этой|следующей)\s+неделе|в\s+этом\s+месяце)(?=\s|$)/gi,
  new RegExp(`(?:^|\\s)с\\s+${TIME_WORD}\\s+до\\s+${TIME_WORD}(?=\\s|$)`, 'gi'),
  new RegExp(`(?:^|\\s)в\\s+${TIME_WORD}(?:\\s+${TIME_WORD})?(?:\\s+час\\S*)?(?:\\s+(?:утра|дня|вечера|ночи))?(?=\\s|$)`, 'gi'),
  /(?:^|\s)(?:утром|дн[её]м|вечером|в\s+полдень|в\s+полночь)(?=\s|$)/gi,
  /(?:^|\s)(?:на\s+)+\d{1,2}[:.]\d{2}(?=\s|$)/gi,
  new RegExp(`(?:^|\\s)\\d{1,2}\\s+(?:${MONTHS_RE})(?=\\s|$)`, 'gi'),
  /(?:^|\s)(?:мне|пожалуйста)(?=\s|$)/gi,
];

/** Суть задачи или напоминания [ФТ 2]: без даты, времени и служебных слов */
export function cleanTitle(raw) {
  let title = raw.replace(/[.!?]+$/, '');
  for (const pattern of TITLE_NOISE) title = title.replace(pattern, ' ');
  title = title.replace(/\s+/g, ' ').trim().replace(/^(?:про|о|об|что)\s+/i, '').replace(/^[,:\s-]+|[,:\s-]+$/g, '');
  if (title.length > 120) title = `${title.slice(0, 117)}…`;
  return title ? title[0].toLowerCase() + title.slice(1) : '';
}

// ---------- Поиск и цель команды ----------

const STOP_WORDS = new Set([
  'найди', 'найти', 'поищи', 'покажи', 'когда', 'у', 'меня', 'мне', 'я', 'ставил', 'ставила', 'создавал', 'была', 'был',
  'было', 'были', 'будет', 'будут', 'про', 'по', 'о', 'об', 'обо', 'то', 'что', 'нибудь', 'когда-то', 'какую', 'какой',
  'какое', 'ее', 'его', 'эту', 'этот', 'это', 'ту', 'той', 'запись', 'записи', 'там', 'ли', 'в', 'во', 'на', 'с', 'со',
  'и', 'а', 'ну', 'мой', 'мою', 'мои', 'прошлом', 'прошлой', 'месяце', 'неделе', 'этой', 'этом', 'следующей',
  'удали', 'удалить', 'отмени', 'отменить', 'перенеси', 'перенести', 'сдвинь', 'подвинь', 'переименуй', 'измени',
  'поменяй', 'сделай', 'отметь', 'верни', 'работу', 'сделанной', 'сделанным', 'выполненной', 'выполненным', 'уже',
  'все', 'пожалуйста', 'невыполненные',
]);
const TYPE_WORD_RE = /^(встреч|созвон|совещан|задач|напоминани|дела$|дело$)/;
const DATE_WORD_RE = new RegExp(`^(сегодня|завтра|послезавтра|${WEEKDAY_FORMS.join('|')}|${MONTHS_RE}|утра|вечера|часа?|часов|минут\\S*)$`);

function participantIn(text) {
  const m = /(?:^|\s)со? ([а-я-]{3,})(?=\s|$)/.exec(text);
  return m && !STOP_WORDS.has(m[1]) && !DATE_WORD_RE.test(m[1]) ? m[1] : null;
}

function contentWords(text, exclude) {
  return text
    .split(' ')
    .filter((w) => w && w !== exclude && !STOP_WORDS.has(w) && !TYPE_WORD_RE.test(w) && !DATE_WORD_RE.test(w) && !/^\d/.test(w));
}

/** Параметры поиска [ФТ 9]: тема, участник, тип, направление во времени */
export function searchTerms(t) {
  const participantRaw = participantIn(t);
  let direction = 'any';
  if (/(?:^|\s)(была|был|было|были|прошл\S*)(?=\s|$)/.test(t)) direction = 'past';
  else if (/(?:^|\s)(будет|будут|предстоящ\S*)(?=\s|$)/.test(t)) direction = 'future';
  return {
    words: contentWords(t, participantRaw).filter((w) => !/^(найд|ставил)/.test(w)),
    participant: participantRaw ? nominative(participantRaw) : null,
    participantRaw,
    types: strictTypes(t),
    direction,
  };
}

/** Какую запись имеет в виду команда изменения, удаления или выполнения [ФТ 10] */
export function targetTerms(t, intent) {
  let scope = t.replace(/^(а|и|ну) /, '');
  if (intent === 'update') scope = scope.split(/ (?:на|в|во|до) /)[0];
  const participantRaw = participantIn(scope);
  return {
    pronoun: /(?:^|\s)(ее|его|эту|этот|это|ту|той|нее|него|ней|нем)(?=\s|$)/.test(scope) || /^(готово|сделано)$/.test(t),
    participant: participantRaw ? nominative(participantRaw) : null,
    participantRaw,
    types: strictTypes(scope),
    words: contentWords(scope, participantRaw),
    all: /(?:^|\s)все(?=\s|$)/.test(t),
  };
}

/** changes для update [ФТ 10] */
export function parseChanges(t, raw) {
  const changes = {};
  const rename = /переименуй\S*(?:\s.*?)?\sв\s+(.+)$/i.exec(raw);
  if (rename) {
    changes.title = rename[1].replace(/[«»„“”"]/g, '').replace(/[.!?]+$/, '').trim();
    return changes;
  }
  if (/убери срок/.test(t)) changes.clear_due = true;
  const add = /добавь\s+(\S+)\s+на\s+встречу/i.exec(raw);
  if (add) changes.participants_add = [fromAccusative(add[1])];

  const shift = parseShift(t);
  if (shift) changes.shift_min = shift;
  else {
    if (/сделай|продли|длительн/.test(t)) {
      const duration = parseDuration(t);
      if (duration) changes.duration_min = duration;
    }
    const date = parseDate(t);
    if (date) {
      changes.date = date.date;
      if (date.time) changes.time = date.time;
    }
    const time = parseTime(t) || (changes.duration_min ? null : parseOnTime(t));
    if (time) changes.time = time.time;
  }
  return changes;
}
