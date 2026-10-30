// Логика диалога заглушки: принимает запрос POST /api/message и возвращает ответ из contracts.md, 2.2.
// На настоящем бэкенде эту роль делят LLM-модуль (разбор фразы) и бизнес-логика (всё остальное).
import { plural } from '../dom.js';
import {
  NOW, addDays, addMinutes, dayMonth, dayPhrase, minutesBetween, nowMs, onDay, relativeDay, toIso, today, wall, weekdayName,
} from './clock.js';
import {
  NO, YES, cleanTitle, detectIntent, listRange, listTypes, meetingTitle, normalize, parseBareTime, parseChanges, parseDate,
  parseDuration, parseOrdinal, parsePeriod, parseTime, resolveWhen, searchTerms, targetTerms, taskPeriod,
} from './nlu.js';
import {
  alive, anchor, conflicts, freeSlot, isActive, listItems, overdueItems, present, searchItems, undatedTasks,
} from './queries.js';
import { applyUndo, blankItem, clone, findItem, getDb, nextStamp, persist, remember, session } from './store.js';

const NOUNS = {
  meeting: ['встреча', 'встречи', 'встреч'],
  task: ['задача', 'задачи', 'задач'],
  reminder: ['напоминание', 'напоминания', 'напоминаний'],
};
const RECORDS = ['запись', 'записи', 'записей'];
const HELP = 'Я помогаю с задачами, напоминаниями и встречами. Например: «Напомни завтра в 10 позвонить Ивану», «Что у меня завтра?» или «Найди задачу про презентацию».';
const OUT_OF_SCOPE = 'Я помогаю с задачами, напоминаниями и встречами. Например, скажите: «Что у меня завтра?»';
const NEW_TOPIC = new Set(['list', 'search', 'update', 'delete', 'complete', 'reopen', 'help', 'undo', 'show_focus']);

const count = (n, forms) => `${n} ${plural(n, forms)}`;
const lowerFirst = (s) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** «Встреча с Иваном» → «встречу с Иваном» */
function accusative(title) {
  return lowerFirst(title).replace(/^встреча/, 'встречу').replace(/^планёрка/, 'планёрку');
}

function range(item) {
  return `${wall(item.start_at).time}–${wall(item.end_at).time}`;
}

function respond(type, reply, { items = [], options = [], data = {}, undo = null, suggestions = [] } = {}) {
  return {
    type,
    reply,
    speak: null,
    items: items.map((item) => (item.id ? present(item) : item)),
    options,
    data,
    undo_token: undo,
    suggestions,
  };
}

function resultsData(overrides = {}) {
  return { kind: 'list', from: null, to: null, types: null, total: 0, shown: 0, overdue: [], answer: null, query: null, semantic: true, ...overrides };
}

function notFound(text) {
  return respond('error', text, { data: { code: 'not_found', retryable: false } });
}

// ---------- Вход ----------

export function handleMessage(request) {
  const s = session(request.session_id || 'default');
  const repeated = request.client_message_id && s.processed[request.client_message_id];
  if (repeated) return repeated; // повтор того же сообщения не выполняется второй раз [ФТ 15]

  const selected = request.context && request.context.selected_item_id;
  if (selected && findItem(selected)) s.focus_id = selected;

  const response = route(s, request);
  s.history.push(
    { role: 'user', text: request.text || '', response: null, at: NOW },
    { role: 'assistant', text: response.reply, response, at: NOW },
  );
  if (request.client_message_id) {
    s.processed[request.client_message_id] = response;
    const ids = Object.keys(s.processed);
    if (ids.length > 50) delete s.processed[ids[0]];
  }
  persist();
  return response;
}

export function undoByToken(token) {
  if (!applyUndo(token)) return null;
  persist();
  return respond('done', 'Вернул как было.', { data: { actions: [] } });
}

function route(s, request) {
  if (request.choice && request.choice.option_id) return handleChoice(s, request.choice.option_id);

  const raw = (request.text || '').trim();
  const t = normalize(raw);
  if (!t) return respond('error', 'Не расслышал, повторите, пожалуйста.', { data: { code: 'empty_speech', retryable: false } });

  const intent = detectIntent(t);
  if (intent === 'cancel') return cancel(s);

  if (s.expects === 'yes_no') {
    if (YES.test(t)) return confirmPending(s, true);
    if (NO.test(t)) return confirmPending(s, false);
    dropPending(s); // любая другая фраза — новая команда, а не подтверждение [ФТ 11]
  }
  if (s.expects === 'number') {
    const number = parseOrdinal(t, { bare: true });
    if (number) return pick(s, number);
    dropPending(s);
  }
  if (s.draft) return answerDraft(s, intent, t, raw);
  return dispatch(s, intent, t, raw);
}

function dropPending(s) {
  s.pending = null;
  s.expects = null;
  s.draft = null;
}

function dispatch(s, intent, t = '', raw = '') {
  switch (intent) {
    case 'help':
      return respond('info', HELP, { data: { reason: 'help' }, suggestions: ['Что у меня завтра?', 'Найди задачу про презентацию'] });
    case 'undo':
      return undoLast(s);
    case 'show_focus':
      return showFocus(s);
    case 'create_task':
    case 'create_reminder':
    case 'create_meeting':
      return startCreate(s, intent.replace('create_', ''), t, raw);
    case 'list':
      return list(s, t);
    case 'search':
      return search(s, t);
    case 'update':
    case 'delete':
    case 'complete':
    case 'reopen':
      return withTarget(s, intent, t, raw);
    default: {
      // «А на послезавтра?» после списка — тот же запрос с новым периодом [ФТ 11]
      if (s.last_list && /^а /.test(t) && (parseDate(t) || parsePeriod(t))) return list(s, t, s.last_list.types);
      const time = parseBareTime(t) || parseTime(t);
      if (time && !parseDate(t)) return respond('info', `Что поставить на ${time.time}?`, { data: { reason: 'help' } });
      return respond('info', OUT_OF_SCOPE, { data: { reason: 'out_of_scope' }, suggestions: ['Что у меня завтра?'] });
    }
  }
}

// ---------- Создание [ФТ 6, 7] ----------

function startCreate(s, type, t, raw) {
  const date = parseDate(t);
  const time = parseTime(t);
  const draft = {
    type,
    title: null,
    participants: [],
    location: null,
    date: date ? date.date : null,
    time: (date && date.time) || (time && time.time) || null,
    end_time: time ? time.end_time || null : null,
    duration_min: parseDuration(t),
    period: null,
    sameWeekday: Boolean(date && date.sameWeekday),
    relative: Boolean(date && date.relative),
    source_text: raw,
    attempt: 0,
  };
  if (type === 'meeting') {
    Object.assign(draft, meetingTitle(raw));
  } else {
    draft.title = cleanTitle(raw) || null;
    const period = parsePeriod(t);
    if (type === 'task' && !draft.date && ['this_week', 'next_week', 'month'].includes(period)) draft.period = period;
  }

  // «Напомни через 15 минут» в ответ на сработавшее напоминание — перенос remind_at [ФТ 12]
  const focus = s.focus_id && findItem(s.focus_id);
  if (type === 'reminder' && !draft.title && draft.relative && focus && focus.type === 'reminder') {
    return applyUpdate(s, focus, { remind_at: toIso(draft.date, draft.time), status: 'open', completed_at: null });
  }

  s.draft = draft;
  s.expects = null;
  return proceed(s);
}

function proceed(s) {
  const missing = missingField(s.draft);
  return missing ? ask(s, missing) : create(s);
}

function missingField(draft) {
  if (draft.type !== 'meeting' && !draft.title) return 'title';
  if (draft.type === 'task') return null;
  if (!draft.date && !draft.time) return 'datetime';
  if (!draft.time) return 'time';
  return null;
}

const QUESTIONS = {
  title: { reminder: () => 'О чём напомнить?', task: () => 'Что нужно сделать?' },
  datetime: { reminder: () => 'Когда напомнить?', meeting: (d) => `Когда ${lowerFirst(d.title)}?` },
  time: { reminder: () => 'Во сколько напомнить?', meeting: (d) => `На какое время поставить ${accusative(d.title)}?` },
};
const RETRY = {
  title: 'Не понял. Скажите коротко, что сделать, например: «купить билеты».',
  datetime: 'Не понял дату. Скажите, например: «завтра в 16».',
  time: 'Не понял время. Во сколько? Например: «в 16:00».',
};
const WHAT = { title: 'суть', datetime: 'дату и время', time: 'время' };
const EXAMPLES = { meeting: 'встреча с Иваном завтра в 16', reminder: 'напомни завтра в 10 позвонить Ивану', task: 'купить билеты до пятницы' };

function ask(s, field, { retry = false } = {}) {
  const draft = s.draft;
  s.expects = field;
  return respond('clarify', retry ? RETRY[field] : QUESTIONS[field][draft.type](draft), {
    data: { expects: field, draft: preview(draft), attempt: draft.attempt },
  });
}

function preview(draft) {
  return { type: draft.type, title: draft.title, participants: draft.participants || [], start_at: null, remind_at: null, date_hint: draft.date };
}

function draftName(draft) {
  if (draft.type === 'meeting') return upperFirst(accusative(draft.title));
  return draft.type === 'reminder' ? 'Напоминание' : 'Задачу';
}

/** Ответ на уточняющий вопрос дополняет черновик [ФТ 11] */
function answerDraft(s, intent, t, raw) {
  const draft = s.draft;
  const switchTopic = () => {
    const name = draftName(draft);
    s.draft = null;
    s.expects = null;
    const response = dispatch(s, intent, t, raw);
    response.reply = `${name} не добавил. ${response.reply}`;
    return response;
  };
  if (NEW_TOPIC.has(intent)) return switchTopic();

  let answered = false;
  if (s.expects === 'title') {
    const title = cleanTitle(raw);
    if (title) {
      draft.title = title;
      answered = true;
    }
  } else {
    const date = parseDate(t);
    const time = parseTime(t) || parseBareTime(t);
    if (date) {
      Object.assign(draft, { date: date.date, sameWeekday: Boolean(date.sameWeekday), relative: Boolean(date.relative) });
      if (date.time) draft.time = date.time;
      answered = true;
    }
    if (time) {
      draft.time = time.time;
      if (time.end_time) draft.end_time = time.end_time;
      answered = true;
    }
    const duration = parseDuration(t);
    if (duration) draft.duration_min = duration;
  }

  if (!answered) {
    if (intent.startsWith('create_')) return switchTopic();
    draft.attempt += 1;
    if (draft.attempt >= 2) {
      const what = WHAT[s.expects];
      s.draft = null;
      s.expects = null;
      return respond('info', `Не получилось разобрать ${what}. Скажите полностью, например: «${EXAMPLES[draft.type]}».`, { data: { reason: 'draft_dropped' } });
    }
    return ask(s, s.expects, { retry: true });
  }
  return proceed(s);
}

function buildFields(draft) {
  const base = { type: draft.type, title: draft.title, source_text: draft.source_text, participants: draft.participants || [], location: draft.location };
  if (draft.type === 'meeting') {
    const start = toIso(draft.date, draft.time);
    const end = draft.end_time ? toIso(draft.date, draft.end_time) : addMinutes(start, draft.duration_min || 60);
    return { ...base, start_at: start, end_at: end, all_day: false, status: 'scheduled' };
  }
  if (draft.type === 'reminder') return { ...base, participants: [], remind_at: toIso(draft.date, draft.time), status: 'open' };
  if (draft.period) {
    const [start, end] = taskPeriod(draft.period);
    return { ...base, period_start: start, period_end: end, status: 'open' };
  }
  if (draft.date && draft.time) return { ...base, due_at: toIso(draft.date, draft.time), status: 'open' };
  if (draft.date) return { ...base, due_date: draft.date, status: 'open' };
  return { ...base, status: 'open' };
}

/** skip — уже подтверждённые проверки: 'conflict', 'duplicate' */
function create(s, skip = []) {
  const draft = s.draft;
  if (draft.date || draft.time) {
    const when = resolveWhen(draft);
    Object.assign(draft, { date: when.date, time: when.time, sameWeekday: false });
    if (when.past) {
      draft.date = addDays(today(), 1);
      draft.relative = false;
      s.pending = { intent: 'create', skip };
      s.expects = 'yes_no';
      return respond('confirm', `${when.time} сегодня уже прошло. Поставить на завтра?`, {
        options: [{ id: 'yes', label: 'Да, на завтра' }, { id: 'no', label: 'Нет' }],
        data: { pending_intent: 'create', count: 1 },
      });
    }
  }

  const fields = buildFields(draft);
  if (draft.type === 'meeting' && Date.parse(fields.end_at) <= Date.parse(fields.start_at)) {
    const end = draft.end_time;
    Object.assign(draft, { time: null, end_time: null });
    s.expects = 'time';
    return respond('clarify', `Встреча заканчивается в ${end}, раньше начала. Уточните время.`, {
      data: { expects: 'time', draft: preview(draft), attempt: draft.attempt },
    });
  }

  if (draft.type === 'meeting' && !skip.includes('conflict')) {
    const clash = conflicts(fields.start_at, fields.end_at);
    if (clash.length) {
      const free = freeSlot(fields.start_at, minutesBetween(fields.start_at, fields.end_at));
      s.pending = { intent: 'create', skip: [...skip, 'conflict'], reason: 'conflict', free };
      s.expects = 'yes_no';
      const options = [{ id: 'yes', label: 'Всё равно добавить' }, { id: 'no', label: 'Другое время' }];
      if (free) options.push({ id: 'free_slot', label: `Свободно с ${wall(free).time}` });
      return respond('conflict', `В это время уже есть ${lowerFirst(clash[0].title)}, ${range(clash[0])}. Всё равно добавить?`, {
        items: clash,
        options,
        data: {
          draft: { type: 'meeting', title: draft.title, participants: draft.participants, start_at: fields.start_at, end_at: fields.end_at },
          free_slot: free,
        },
      });
    }
  }

  if (!skip.includes('duplicate')) {
    const twin = duplicateOf(fields);
    if (twin) {
      s.pending = { intent: 'create', skip: [...skip, 'duplicate'] };
      s.expects = 'yes_no';
      return respond('confirm', `У вас уже есть «${twin.title}» ${dueShort(twin)}. Добавить ещё одну?`, {
        items: [twin],
        options: [{ id: 'yes', label: 'Да, добавить' }, { id: 'no', label: 'Нет' }],
        data: { pending_intent: 'create', count: 1 },
      });
    }
  }

  const item = blankItem({ ...fields, created_at: nextStamp() });
  getDb().items.push(item);
  s.draft = null;
  s.expects = null;
  s.pending = null;
  s.focus_id = item.id;
  s.last_undo = remember({ snapshots: [], created: [item.id] });
  return respond('done', createdText(item), {
    items: [item],
    data: { actions: [{ action: 'created', item_id: item.id }] },
    undo: s.last_undo,
  });
}

/** Открытая запись того же типа с той же сутью на тот же день [ФТ 6] */
function duplicateOf(fields) {
  const at = anchor(fields);
  const day = at ? wall(at).date : null;
  return alive().find((item) => {
    if (item.type !== fields.type || !isActive(item) || item.title.toLowerCase() !== fields.title.toLowerCase()) return false;
    const other = anchor(item);
    return (other ? wall(other).date : null) === day;
  }) || null;
}

function dueShort(item) {
  const at = anchor(item);
  if (!at) return 'без срока';
  const { date, time } = wall(at);
  const day = relativeDay(date) || dayMonth(date);
  return item.type === 'task' && !item.due_at ? `на ${day}` : `на ${day} в ${time}`;
}

function dueText(item) {
  if (item.due_at) {
    const { date, time } = wall(item.due_at);
    return `, срок — ${dayPhrase(date)}, ${time}`;
  }
  if (item.due_date) return `, срок — ${dayPhrase(item.due_date)}`;
  if (item.period_end) {
    const start = wall(item.period_start).date;
    const end = wall(item.period_end).date;
    return start > today() ? `, срок — с ${dayMonth(start)} по ${dayMonth(end)}` : `, срок — до ${dayMonth(end)} (${weekdayName(end)})`;
  }
  return ' без срока';
}

/** Подтверждение всегда с днём недели и датой [ФТ 6, 7] */
function createdText(item) {
  if (item.type === 'reminder') {
    const { date, time } = wall(item.remind_at);
    return `Напомню ${dayPhrase(date)}, в ${time}: ${item.title}.`;
  }
  if (item.type === 'meeting') return `Добавил ${accusative(item.title)}: ${dayPhrase(wall(item.start_at).date)}, ${range(item)}.`;
  return `Добавил задачу «${item.title}»${dueText(item)}.`;
}

// ---------- Подтверждения и выбор ----------

function confirmPending(s, yes) {
  const pending = s.pending;
  s.pending = null;
  s.expects = null;
  if (!pending) return dispatch(s, 'unknown');

  if (pending.intent === 'create') {
    if (yes) return create(s, pending.skip);
    if (pending.reason === 'conflict') {
      Object.assign(s.draft, { time: null, end_time: null, attempt: 0 });
      s.expects = 'time';
      return respond('clarify', 'Хорошо. На какое время поставить?', { data: { expects: 'time', draft: preview(s.draft), attempt: 0 } });
    }
    s.draft = null;
    return respond('info', 'Хорошо, не добавляю.', { data: { reason: 'cancelled' } });
  }
  if (pending.intent === 'delete') {
    return yes ? removeItems(s, pending.item_ids) : respond('info', 'Хорошо, не удаляю.', { data: { reason: 'cancelled' } });
  }
  if (pending.intent === 'update') {
    return yes
      ? applyUpdate(s, findItem(pending.item_id), pending.after, { skipConflict: true })
      : respond('info', 'Хорошо, оставил как было.', { data: { reason: 'cancelled' } });
  }
  return dispatch(s, 'unknown');
}

function handleChoice(s, optionId) {
  if (optionId === 'yes' || optionId === 'no') return confirmPending(s, optionId === 'yes');
  const picked = /^pick_(\d+)$/.exec(optionId);
  if (picked) return pick(s, Number(picked[1]));
  if (optionId === 'free_slot' && s.pending && s.pending.free && s.draft) {
    const free = wall(s.pending.free);
    s.pending = null;
    s.expects = null;
    Object.assign(s.draft, { date: free.date, time: free.time, end_time: null });
    return create(s);
  }
  return respond('info', 'Этот вариант уже неактуален. Повторите запрос, пожалуйста.', { data: { reason: 'cancelled' } });
}

function pick(s, number) {
  const list = s.candidates || [];
  const entry = number === -1 ? list[list.length - 1] : list.find((c) => c.number === number);
  const item = entry && findItem(entry.id);
  const pending = s.pending;
  s.pending = null;
  s.expects = null;
  if (!item) return notFound('Не нашёл запись с таким номером.');
  if (!pending) {
    s.focus_id = item.id;
    return describe(item);
  }
  return act(s, pending.intent, [item], pending.t, pending.raw);
}

function cancel(s) {
  const pending = s.pending;
  const hadDraft = Boolean(s.draft);
  s.draft = null;
  s.pending = null;
  s.expects = null;
  if (pending && pending.intent === 'delete') return respond('info', 'Хорошо, не удаляю.', { data: { reason: 'cancelled' } });
  if (pending && pending.intent === 'update') return respond('info', 'Хорошо, оставил как было.', { data: { reason: 'cancelled' } });
  return respond('info', hadDraft ? 'Хорошо, не добавляю.' : 'Хорошо.', { data: { reason: 'cancelled' } });
}

// ---------- Список [ФТ 8] ----------

const PERIOD_LABELS = {
  this_week: 'эту неделю', next_week: 'следующую неделю', month: 'этот месяц', last_week: 'прошлую неделю', last_month: 'прошлый месяц',
};

function summary(items) {
  const parts = ['reminder', 'meeting', 'task']
    .map((type) => [type, items.filter((item) => item.type === type).length])
    .filter(([, n]) => n)
    .map(([type, n]) => count(n, NOUNS[type]));
  return parts.join(', ');
}

function list(s, t, typesOverride) {
  const types = typesOverride !== undefined ? typesOverride : listTypes(t);
  s.last_list = { types };
  s.candidates = null;
  if (/следующ\S* встреч|когда следующ/.test(t)) return nextMeeting(s);
  if (/все задачи|без срока/.test(t)) return undated();

  const date = parseDate(t);
  const period = parsePeriod(t);
  let from;
  let to;
  let label;
  if (date) {
    [from, to] = [toIso(date.date), toIso(addDays(date.date, 1))];
    label = relativeDay(date.date) || dayMonth(date.date);
  } else if (period) {
    [from, to] = listRange(period);
    label = PERIOD_LABELS[period];
  } else {
    [from, to] = [toIso(today()), toIso(addDays(today(), 1))];
    label = 'сегодня';
  }

  const time = parseTime(t);
  if (/свобод/.test(t) && time) return freeCheck(date ? date.date : today(), time.time);

  const all = listItems({ fromMs: Date.parse(from), toMs: Date.parse(to), types });
  const shown = all.slice(0, 10);
  const isToday = from === toIso(today()) && to === toIso(addDays(today(), 1));
  const overdue = isToday && (!types || types.includes('task')) ? overdueItems().filter((item) => !all.includes(item)) : [];
  const head = ['сегодня', 'завтра', 'послезавтра'].includes(label) ? upperFirst(label) : `На ${label}`;
  const meetingsOnly = types && types.length === 1 && types[0] === 'meeting';

  let text;
  let answer = null;
  if (/свобод/.test(t)) {
    const meetings = all.filter((item) => item.type === 'meeting');
    answer = !meetings.length;
    text = answer ? `Да, ${label} встреч нет.` : `Нет, ${label} ${count(meetings.length, NOUNS.meeting)}.`;
  } else if (/^есть ли/.test(t)) {
    answer = all.length > 0;
    text = answer ? `Да, ${count(all.length, meetingsOnly ? NOUNS.meeting : RECORDS)}.` : `Нет, ${label} ${meetingsOnly ? 'встреч' : 'записей'} нет.`;
  } else {
    text = all.length ? `${head}: ${summary(all)}.` : `На ${label} ничего не запланировано.`;
  }
  if (all.length > 10) text += ` Показал первые 10, и ещё ${all.length - 10}. Уточните период или тип.`;
  if (overdue.length) text += ` Плюс ${count(overdue.length, ['просроченная задача', 'просроченные задачи', 'просроченных задач'])}.`;
  if (all.length === 1) s.focus_id = all[0].id;

  let suggestions = [];
  if (label === 'сегодня') suggestions = ['А на завтра?'];
  else if (label === 'завтра') suggestions = ['А на послезавтра?'];

  return respond('results', text, {
    items: shown,
    data: resultsData({ from, to, types, total: all.length, shown: shown.length, overdue: overdue.map(present), answer }),
    suggestions,
  });
}

function nextMeeting(s) {
  const [meeting] = listItems({ fromMs: nowMs(), types: ['meeting'] });
  if (!meeting) return respond('results', 'Предстоящих встреч нет.', { data: resultsData({ kind: 'next' }) });
  s.focus_id = meeting.id;
  const text = `Следующая — ${lowerFirst(meeting.title)}, ${dayPhrase(wall(meeting.start_at).date)}, ${range(meeting)}.`;
  return respond('results', text, { items: [meeting], data: resultsData({ kind: 'next', total: 1, shown: 1 }) });
}

function freeCheck(date, time) {
  const at = Date.parse(toIso(date, time));
  const busy = listItems({ fromMs: at, toMs: at + 1, types: ['meeting'] });
  const day = relativeDay(date) || dayMonth(date);
  const text = busy.length
    ? `Нет, в ${time} у вас ${lowerFirst(busy[0].title)}, ${range(busy[0])}.`
    : `Да, ${day} в ${time} вы свободны.`;
  return respond('results', text, { items: busy, data: resultsData({ kind: 'free_check', total: busy.length, shown: busy.length, answer: !busy.length }) });
}

function undated() {
  const items = undatedTasks();
  const text = items.length ? `Задачи без срока: ${items.length}.` : 'Задач без срока нет.';
  return respond('results', text, { items, data: resultsData({ types: ['task'], total: items.length, shown: items.length }) });
}

// ---------- Поиск [ФТ 9] ----------

/** Одна строка с датой и статусом: «Задача „подписать договор аренды“, выполнена 12 октября» */
function oneLine(item) {
  const name = item.type === 'meeting' ? item.title : `${item.type === 'task' ? 'Задача' : 'Напоминание'} «${item.title}»`;
  if (item.status === 'done') {
    const word = item.type === 'reminder' ? 'выполнено' : 'выполнена';
    return item.completed_at ? `${name}, ${word} ${dayMonth(wall(item.completed_at).date)}` : `${name}, ${word}`;
  }
  if (item.status === 'cancelled') return `${name}, отменена`;
  if (!anchor(item)) return `${name}, без срока`;
  if (item.type === 'task' && !item.due_at) return `${name}${dueText(item)}`;
  const { date, time } = wall(anchor(item));
  return `${name}, ${dayPhrase(date)}, ${item.type === 'meeting' ? range(item) : time}`;
}

function describe(item) {
  return respond('results', `${oneLine(item)}.`, { items: [item], data: resultsData({ kind: 'search', total: 1, shown: 1 }) });
}

function search(s, t) {
  const { words, participant, participantRaw, types, direction } = searchTerms(t);
  if (!words.length && !participant) {
    return respond('info', 'Что найти? Например: «Найди задачу про договор».', { data: { reason: 'help' } });
  }
  const period = parsePeriod(t);
  const bounds = period ? listRange(period) : null;
  const found = searchItems({
    words,
    participant,
    types,
    direction,
    fromMs: bounds ? Date.parse(bounds[0]) : null,
    toMs: bounds ? Date.parse(bounds[1]) : null,
  });
  const about = participant ? `с ${participantRaw}` : `про «${words.join(' ')}»`;
  const data = resultsData({
    kind: 'search',
    from: bounds ? bounds[0] : null,
    to: bounds ? bounds[1] : null,
    types,
    total: found.length,
    shown: Math.min(found.length, 5),
    query: words.join(' ') || participant,
  });

  if (!found.length) {
    s.candidates = null;
    return respond('results', `Не нашёл записей ${about}. Попробуйте сказать по-другому.`, { data });
  }

  // «Когда была встреча с Иваном?» — ответ сразу датой [ФТ 9]
  if (/^когда/.test(t) && anchor(found[0])) {
    const [main, ...rest] = found;
    s.focus_id = main.id;
    s.candidates = null;
    const { date, time } = wall(anchor(main));
    let text = `${main.title} ${direction === 'future' ? 'будет' : 'была'} ${onDay(date)}, в ${time}.`;
    const others = rest.filter((item) => anchor(item)).slice(0, 3).map((item) => dayMonth(wall(anchor(item)).date));
    if (others.length) text += ` Ещё ${direction === 'future' ? 'будут' : 'были'} ${others.join(', ')}.`;
    return respond('results', text, { items: [main], data: { ...data, shown: 1 } });
  }

  if (found.length === 1) {
    s.focus_id = found[0].id;
    s.candidates = null;
    return respond('results', `${oneLine(found[0])}.`, { items: found, data });
  }

  const top = found.slice(0, 5);
  s.candidates = top.map((item, index) => ({ number: index + 1, id: item.id }));
  const text = found.length > 5
    ? `Вот первые 5. Нашёл ещё ${found.length - 5}, уточните тип или период.`
    : `Нашёл ${count(found.length, RECORDS)}. Номер можно назвать дальше: «удали вторую».`;
  return respond('results', text, { items: top.map((item, index) => ({ ...item, number: index + 1 })), data });
}

// ---------- Изменение, удаление, выполнение [ФТ 10] ----------

const TYPE_ACCUSATIVE = { meeting: 'встречу', task: 'задачу', reminder: 'напоминание' };

function resolveTarget(s, intent, t) {
  const number = parseOrdinal(t);
  if (number && s.candidates && s.candidates.length) {
    const list = s.candidates;
    const entry = number === -1 ? list[list.length - 1] : list.find((c) => c.number === number);
    const item = entry && findItem(entry.id);
    if (item) return { items: [item] };
  }

  const terms = targetTerms(t, intent);
  if (terms.pronoun || (!terms.words.length && !terms.participant && !terms.types)) {
    const focus = s.focus_id && findItem(s.focus_id);
    if (focus) return { items: [focus] };
    return { response: respond('info', 'Какую запись вы имеете в виду?', { data: { reason: 'help' } }) };
  }

  const types = terms.types || (intent === 'complete' || intent === 'reopen' ? ['task', 'reminder'] : null);
  let items;
  if (terms.all) {
    const date = parseDate(t);
    const period = parsePeriod(t);
    let bounds = [null, null];
    if (date) bounds = [toIso(date.date), toIso(addDays(date.date, 1))];
    else if (period) bounds = listRange(period);
    items = listItems({
      fromMs: bounds[0] ? Date.parse(bounds[0]) : -Infinity,
      toMs: bounds[1] ? Date.parse(bounds[1]) : Infinity,
      types,
    });
  } else {
    items = searchItems({ words: terms.words, participant: terms.participant, types, status: intent === 'reopen' ? 'done' : null });
    // Переносят и удаляют обычно предстоящее: прошедшие встречи не мешают выбору
    const upcoming = items.filter((item) => !anchor(item) || Date.parse(anchor(item)) >= nowMs());
    if (upcoming.length) items = upcoming;
  }

  if (!items.length) {
    const about = terms.participantRaw ? `с ${terms.participantRaw}` : `про «${terms.words.join(' ')}»`;
    const text = intent === 'complete'
      ? `Не нашёл открытой задачи ${about}.`
      : `Не нашёл ${(types && types.length === 1 && TYPE_ACCUSATIVE[types[0]]) || 'запись'} ${about}.`;
    return { response: notFound(text) };
  }
  return { items, all: terms.all };
}

function withTarget(s, intent, t, raw) {
  const target = resolveTarget(s, intent, t);
  if (target.response) return target.response;
  const { items, all } = target;
  if (items.length > 1 && !all) {
    const top = items.slice(0, 5);
    const sameType = top.every((item) => item.type === top[0].type);
    s.candidates = top.map((item, index) => ({ number: index + 1, id: item.id }));
    s.pending = { intent, t, raw };
    s.expects = 'number';
    return respond('choose', `Нашёл ${count(items.length, sameType ? NOUNS[top[0].type] : RECORDS)}. Какую?`, {
      items: top.map((item, index) => ({ ...item, number: index + 1 })),
      options: top.map((item, index) => ({ id: `pick_${index + 1}`, label: String(index + 1) })),
      data: { pending_intent: intent },
    });
  }
  return act(s, intent, items, t, raw);
}

function act(s, intent, items, t, raw) {
  if (intent === 'delete') return askDelete(s, items);
  if (intent === 'complete') return setDone(s, items[0], true);
  if (intent === 'reopen') return setDone(s, items[0], false);
  return update(s, items[0], t, raw);
}

/** «встречу с командой, завтра, пятница 30 октября, 15:00» */
function cardPhrase(item) {
  const at = anchor(item);
  let when = '';
  if (at) {
    const { date, time } = wall(at);
    when = item.type === 'task' && !item.due_at ? `, ${dayPhrase(date)}` : `, ${dayPhrase(date)}, ${time}`;
  }
  if (item.type === 'meeting') return `${accusative(item.title)}${when}`;
  return `${TYPE_ACCUSATIVE[item.type]} «${item.title}»${when}`;
}

function countByType(items) {
  const sameType = items.every((item) => item.type === items[0].type);
  return count(items.length, sameType ? NOUNS[items[0].type] : RECORDS);
}

function askDelete(s, items) {
  s.pending = { intent: 'delete', item_ids: items.map((item) => item.id) };
  s.expects = 'yes_no';
  if (items.length === 1) s.focus_id = items[0].id;
  const text = items.length === 1 ? `Удалить ${cardPhrase(items[0])}?` : `Удалить ${countByType(items)}?`;
  return respond('confirm', text, {
    items,
    options: [{ id: 'yes', label: 'Да, удалить' }, { id: 'no', label: 'Нет' }],
    data: { pending_intent: 'delete', count: items.length },
  });
}

function removeItems(s, ids) {
  const items = ids.map(findItem).filter(Boolean);
  if (!items.length) return notFound('Не нашёл эту запись — возможно, её уже удалили.');
  const snapshots = items.map(clone);
  const at = nextStamp();
  for (const item of items) Object.assign(item, { deleted_at: at, updated_at: at });
  if (ids.includes(s.focus_id)) s.focus_id = null;
  s.last_undo = remember({ snapshots, created: [] });
  const text = items.length === 1 ? `Удалил ${cardPhrase(snapshots[0])}.` : `Удалил ${countByType(items)}.`;
  return respond('done', text, {
    items,
    data: { actions: items.map((item) => ({ action: 'deleted', item_id: item.id })) },
    undo: s.last_undo,
  });
}

function setDone(s, item, done) {
  s.focus_id = item.id;
  if (item.type === 'meeting') {
    return respond('info', 'Встречи не отмечаются выполненными. Прошедшие встречи сами уходят из планов.', { data: { reason: 'help' } });
  }
  if (done && item.status === 'done') {
    return respond('info', item.type === 'reminder' ? 'Это напоминание уже выполнено.' : 'Эта задача уже выполнена.', { data: { reason: 'already_done' } });
  }
  const snapshot = clone(item);
  const at = nextStamp();
  Object.assign(item, { status: done ? 'done' : 'open', completed_at: done ? at : null, updated_at: at });
  s.last_undo = remember({ snapshots: [snapshot], created: [] });
  const word = item.type === 'reminder' ? 'выполненным' : 'выполненной';
  return respond('done', done ? `Отметил ${word}: ${item.title}.` : `Вернул в работу: ${item.title}.`, {
    items: [item],
    data: { actions: [{ action: done ? 'completed' : 'reopened', item_id: item.id }] },
    undo: s.last_undo,
  });
}

function update(s, item, t, raw) {
  s.focus_id = item.id;
  const changes = parseChanges(t, raw);
  if (!Object.keys(changes).length) {
    return respond('info', 'Что изменить? Например: «перенеси на завтра» или «сдвинь на час позже».', { data: { reason: 'help' } });
  }
  const after = computeChanges(item, changes);
  if (!Object.keys(after).length) return respond('info', 'Здесь нечего менять — всё уже так.', { data: { reason: 'already_done' } });
  return applyUpdate(s, item, after);
}

function computeChanges(item, changes) {
  const after = {};
  const moveKey = { meeting: 'start_at', reminder: 'remind_at' }[item.type] || (item.due_at ? 'due_at' : null);
  if (moveKey) {
    let start = item[moveKey];
    if (changes.date || changes.time) {
      const current = wall(start);
      start = toIso(changes.date || current.date, changes.time || current.time);
    }
    if (changes.shift_min) start = addMinutes(start, changes.shift_min);
    after[moveKey] = start;
    if (item.type === 'meeting') after.end_at = addMinutes(start, changes.duration_min || minutesBetween(item.start_at, item.end_at));
  } else if (item.type === 'task' && (changes.date || changes.time)) {
    const date = changes.date || item.due_date || today();
    Object.assign(after, changes.time ? { due_at: toIso(date, changes.time), due_date: null } : { due_date: date, due_at: null });
    Object.assign(after, { period_start: null, period_end: null });
  }
  if (changes.title) after.title = changes.title;
  if (changes.participants_add) after.participants = [...new Set([...(item.participants || []), ...changes.participants_add])];
  if (changes.clear_due && item.type === 'task') Object.assign(after, { due_date: null, due_at: null, period_start: null, period_end: null });

  for (const key of Object.keys(after)) {
    if (JSON.stringify(after[key]) === JSON.stringify(item[key] ?? null)) delete after[key];
  }
  return after;
}

function subject(item) {
  return item.type === 'meeting' ? accusative(item.title) : `${TYPE_ACCUSATIVE[item.type]} «${item.title}»`;
}

/** Ответ «было → стало» [ФТ 10] */
function updatedText(before, item, after) {
  const key = ['start_at', 'remind_at', 'due_at'].find((k) => k in after);
  if (key && before[key]) {
    const [from, to] = [wall(before[key]), wall(item[key])];
    if (from.date === to.date && from.time === to.time && 'end_at' in after) return `Изменил ${subject(item)}: теперь ${range(item)}.`;
    return `Перенёс ${subject(item)}: с ${dayMonth(from.date)} ${from.time} на ${dayMonth(to.date)} ${to.time}.`;
  }
  if ('end_at' in after) return `Изменил ${subject(item)}: теперь ${range(item)}.`;
  if (item.due_date && 'due_date' in after) return `Перенёс ${subject(item)} на ${dayPhrase(item.due_date)}.`;
  if (item.due_at && 'due_at' in after) return `Перенёс ${subject(item)}: срок — ${dayPhrase(wall(item.due_at).date)}, ${wall(item.due_at).time}.`;
  if ('title' in after) return `Переименовал: «${before.title}» → «${item.title}».`;
  if ('participants' in after) return `Добавил участников: ${item.participants.join(', ')}.`;
  if ('due_date' in after || 'period_end' in after) return `Убрал срок у задачи «${item.title}».`;
  return `Изменил ${subject(item)}.`;
}

function applyUpdate(s, item, after, { skipConflict = false } = {}) {
  if (!item) return notFound('Не нашёл эту запись — возможно, её уже удалили.');
  if (item.type === 'meeting' && !skipConflict && (after.start_at || after.end_at)) {
    const clash = conflicts(after.start_at || item.start_at, after.end_at || item.end_at, item.id);
    if (clash.length) {
      s.pending = { intent: 'update', item_id: item.id, after };
      s.expects = 'yes_no';
      return respond('conflict', `В это время уже есть ${lowerFirst(clash[0].title)}, ${range(clash[0])}. Всё равно перенести?`, {
        items: clash,
        options: [{ id: 'yes', label: 'Всё равно перенести' }, { id: 'no', label: 'Не переносить' }],
        data: { draft: { ...item, ...after }, free_slot: null },
      });
    }
  }
  const snapshot = clone(item);
  const before = Object.fromEntries(Object.keys(after).map((key) => [key, item[key] ?? null]));
  if (item.type === 'meeting' && 'start_at' in after && !('end_at' in before)) before.end_at = item.end_at;
  Object.assign(item, after, { updated_at: nextStamp() });
  s.focus_id = item.id;
  s.last_undo = remember({ snapshots: [snapshot], created: [] });
  const action = 'remind_at' in after && item.type === 'reminder' && !('title' in after) ? 'snoozed' : 'updated';
  return respond('done', updatedText(snapshot, item, after), {
    items: [item],
    data: { actions: [{ action, item_id: item.id, before, after }] },
    undo: s.last_undo,
  });
}

// ---------- Прочее ----------

function undoLast(s) {
  if (!s.last_undo || !applyUndo(s.last_undo)) return respond('info', 'Нечего отменять.', { data: { reason: 'cancelled' } });
  s.last_undo = null;
  return respond('done', 'Вернул как было.', { data: { actions: [] } });
}

function showFocus(s) {
  const item = s.focus_id && findItem(s.focus_id);
  return item ? describe(item) : respond('info', 'Какую запись вы имеете в виду?', { data: { reason: 'help' } });
}
