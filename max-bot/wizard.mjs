// Мастер создания задачи, напоминания и встречи кнопками. Состояние — в store (Redis),
// каждое нажатие перерисовывает одно и то же сообщение. Название, участники и место
// вводятся текстом; дату и время можно выбрать кнопками или написать («завтра», «15:30»).
import { parseDate, parseTime } from '../web/js/answer.js';
import { addDays, dayKey, formatDay, formatTime, localIso, now, startOfDayIso, todayKey } from '../web/js/time.js';
import { BackendError } from './backend.mjs';
import { escape, itemLine, notifyNote } from './render.mjs';
import { button, calendar, hours, minutes, rows } from './ui.mjs';

const KINDS = {
  task: { label: 'задачу', title: 'Новая задача', ask: 'Как назвать задачу? Напишите сообщением.', done: 'Задача добавлена' },
  reminder: { label: 'напоминание', title: 'Новое напоминание', ask: 'О чём напомнить? Напишите сообщением.', done: 'Напоминание добавлено' },
  meeting: { label: 'встречу', title: 'Новая встреча', ask: 'Как назвать встречу? Например: «Созвон с Петей».', done: 'Встреча добавлена' },
};

const DURATIONS = [[15, '15 мин'], [30, '30 мин'], [45, '45 мин'], [60, '1 ч'], [90, '1,5 ч'], [120, '2 ч'], [180, '3 ч']];
const RELATIVE = [[15, 'Через 15 мин'], [30, 'Через 30 мин'], [60, 'Через 1 ч'], [180, 'Через 3 ч']];
const SOURCE = 'Создано кнопками в MAX';

const newId = () => Math.random().toString(36).slice(2, 8);

// Payload кнопки мастера: w:<id мастера>:<шаг>:<значение>
const pay = (state, step, value = '') => `w:${state.id}:${step}:${value}`;
const nav = (state) => {
  const row = [];
  if (state.history.length) row.push(button('‹ Назад', pay(state, 'back')));
  row.push(button('✖ Отмена', pay(state, 'cancel')));
  return row;
};

function durationLabel(min) {
  const found = DURATIONS.find(([value]) => value === min);
  if (found) return found[1];
  return min % 60 ? `${Math.floor(min / 60)} ч ${min % 60} мин` : `${min / 60} ч`;
}

/** Время по выбранной дате и «ЧЧ:ММ» */
const momentOf = (data) => (data.date && data.time ? localIso(data.date, data.time) : null);

/** Запись для POST /api/items из собранных данных */
export function buildItem(kind, data) {
  const item = { type: kind, title: data.title, source_text: SOURCE };
  if (kind === 'task') {
    if (data.date && data.time) item.due_at = localIso(data.date, data.time);
    else if (data.date) item.due_date = data.date;
  } else if (kind === 'reminder') {
    item.remind_at = data.at || momentOf(data);
  } else {
    if (data.allDay) {
      item.all_day = true;
      item.start_at = startOfDayIso(data.date);
      item.end_at = startOfDayIso(addDays(data.date, 1));
    } else {
      item.start_at = momentOf(data);
      item.end_at = new Date(Date.parse(item.start_at) + (data.duration || 60) * 60000).toISOString();
    }
    if (data.participants && data.participants.length) item.participants = data.participants;
    if (data.location) item.location = data.location;
  }
  return item;
}

/** Сводка собранного перед сохранением */
function summary(kind, data) {
  const lines = [`<b>${escape(data.title)}</b>`];
  if (kind === 'task') {
    lines.push(data.date ? `📅 ${escape(formatDay(data.date))}${data.time ? `, ${data.time}` : ''}` : '📅 Без срока');
  } else if (kind === 'reminder') {
    const at = data.at || momentOf(data);
    lines.push(`📅 ${escape(formatDay(dayKey(at)))}, ${formatTime(at)}`);
  } else {
    if (data.allDay) lines.push(`📅 ${escape(formatDay(data.date))}, весь день`);
    else {
      const start = momentOf(data);
      const end = new Date(Date.parse(start) + (data.duration || 60) * 60000);
      lines.push(`📅 ${escape(formatDay(data.date))}, ${formatTime(start)}–${formatTime(end)} (${durationLabel(data.duration || 60)})`);
    }
    if (data.participants && data.participants.length) lines.push(`👤 ${escape(data.participants.join(', '))}`);
    if (data.location) lines.push(`📍 ${escape(data.location)}`);
  }
  return lines.join('\n');
}

// ---------- Экраны шагов ----------

const SCREENS = {
  title: (s) => ({ text: `<b>${KINDS[s.kind].title}</b>\n\n${KINDS[s.kind].ask}`, buttons: [nav(s)] }),

  due: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n\nКакой срок?`,
    buttons: [
      [button('Без срока', pay(s, 'due', 'none')), button('Сегодня', pay(s, 'due', '0'))],
      [button('Завтра', pay(s, 'due', '1')), button('Послезавтра', pay(s, 'due', '2'))],
      [button('📅 Выбрать дату', pay(s, 'due', 'cal'))],
      nav(s),
    ],
  }),

  when: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n\nКогда напомнить? Можно написать: «завтра» или «15:30».`,
    buttons: [
      ...rows(RELATIVE.map(([min, label]) => button(label, pay(s, 'when', `+${min}`))), 2),
      [button('Сегодня', pay(s, 'when', '0')), button('Завтра', pay(s, 'when', '1')), button('📅 Дата', pay(s, 'when', 'cal'))],
      nav(s),
    ],
  }),

  date: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n\nВыберите день или напишите его: «завтра», «2026-11-05».`,
    buttons: [
      [button('Сегодня', pay(s, 'date', todayKey())), button('Завтра', pay(s, 'date', addDays(todayKey(), 1)))],
      ...calendar(pay(s, 'date').slice(0, -1), s.month || todayKey().slice(0, 7)),
      nav(s),
    ],
  }),

  tasktime: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n📅 ${escape(formatDay(s.data.date))}\n\nНужно точное время?`,
    buttons: [[button('Без времени', pay(s, 'tasktime', 'none')), button('🕐 Указать время', pay(s, 'tasktime', 'pick'))], nav(s)],
  }),

  hour: (s) => {
    const today = s.data.date === todayKey();
    const from = today ? Number(formatTime(now()).slice(0, 2)) : 0;
    const extra = s.kind === 'meeting' ? [[button('🌅 Весь день', pay(s, 'hour', 'allday'))]] : [];
    return {
      text: `<b>${escape(s.data.title)}</b>\n📅 ${escape(formatDay(s.data.date))}\n\nВо сколько? Выберите час или напишите время: «15:30».`,
      buttons: [...hours(pay(s, 'hour').slice(0, -1), { from }), ...extra, nav(s)],
    };
  },

  minute: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n📅 ${escape(formatDay(s.data.date))}\n\nУточните минуты:`,
    buttons: [...minutes(pay(s, 'minute').slice(0, -1), s.hour), nav(s)],
  }),

  duration: (s) => ({
    text: `<b>${escape(s.data.title)}</b>\n📅 ${escape(formatDay(s.data.date))}, ${s.data.time}\n\nСколько продлится?`,
    buttons: [...rows(DURATIONS.map(([min, label]) => button(label, pay(s, 'duration', min))), 4), nav(s)],
  }),

  participants: (s) => ({
    text: `${summary(s.kind, s.data)}\n\nКто участвует? Напишите имена через запятую или пропустите.`,
    buttons: [[button('Пропустить', pay(s, 'participants', 'skip'))], nav(s)],
  }),

  location: (s) => ({
    text: `${summary(s.kind, s.data)}\n\nГде пройдёт? Напишите место или выберите.`,
    buttons: [[button('Онлайн', pay(s, 'location', 'online')), button('Пропустить', pay(s, 'location', 'skip'))], nav(s)],
  }),

  confirm: (s) => ({
    text: `${summary(s.kind, s.data)}\n${notifyNote(buildItem(s.kind, s.data), now().getTime())}\n\nСохранить ${KINDS[s.kind].label}?`,
    buttons: [
      [button('✅ Сохранить', pay(s, 'save'))],
      [button('✏️ Изменить', pay(s, 'edit')), button('✖ Отмена', pay(s, 'cancel'))],
    ],
  }),

  edit: (s) => {
    const fields = [['title', 'Название'], [s.kind === 'reminder' ? 'when' : s.kind === 'task' ? 'due' : 'date', 'Дату']];
    if (s.kind !== 'task' || s.data.date) fields.push(['hour', 'Время']);
    if (s.kind === 'meeting') fields.push(['duration', 'Длительность'], ['participants', 'Участников'], ['location', 'Место']);
    return {
      text: `${summary(s.kind, s.data)}\n\nЧто изменить?`,
      buttons: [...rows(fields.map(([step, label]) => button(label, pay(s, 'goto', step))), 2), [button('‹ Назад', pay(s, 'goto', 'confirm'))]],
    };
  },

  conflict: (s) => ({
    text: `${summary(s.kind, s.data)}\n\n⚠️ В это время уже есть:\n${(s.conflicts || []).map(itemLine).join('\n')}`,
    buttons: [
      [button('Сохранить всё равно', pay(s, 'save', 'force'))],
      [button('🕐 Другое время', pay(s, 'goto', 'hour')), button('✖ Отмена', pay(s, 'cancel'))],
    ],
  }),
};

/** Следующий шаг после заполнения step. При редактировании — сразу к подтверждению */
function nextStep(s, step) {
  // Час → минуты и дата → время переходят сами (шаги hour и setDate), сюда попадают завершённые шаги
  if (s.editing) return 'confirm';
  const flow = {
    task: { title: 'due', date: 'tasktime', tasktime: 'confirm', minute: 'confirm' },
    reminder: { title: 'when', date: 'hour', minute: 'confirm' },
    meeting: { title: 'date', date: 'hour', minute: s.editing ? 'confirm' : 'duration', duration: 'participants', participants: 'location', location: 'confirm' },
  }[s.kind];
  return flow[step] || 'confirm';
}

export function createWizard({ backend, store, log = () => {} }) {
  function screen(state, notice) {
    const view = SCREENS[state.step](state);
    if (notice) view.text = `${view.text}\n\n<i>${escape(notice)}</i>`;
    return view;
  }

  async function go(user, state, step, notice) {
    if (step !== state.step) {
      state.history.push(state.step);
      state.step = step;
    }
    await store.setWizard(user, state);
    return { screen: screen(state, notice) };
  }

  /** Время проверяется сразу: прошедшее для напоминания и встречи не принимаем */
  function pastNotice(state) {
    if (state.kind === 'task') return null;
    const at = state.kind === 'reminder' ? state.data.at || momentOf(state.data) : state.data.allDay ? null : momentOf(state.data);
    if (at && Date.parse(at) <= now().getTime()) return 'Это время уже прошло. Выберите другое.';
    return null;
  }

  async function setTime(user, state, time) {
    state.data.time = time;
    delete state.data.allDay;
    delete state.data.at;
    const notice = pastNotice(state);
    if (notice) {
      delete state.data.time;
      state.step = 'hour';
      await store.setWizard(user, state);
      return { screen: screen(state, notice) };
    }
    return go(user, state, nextStep(state, 'minute'));
  }

  async function setDate(user, state, date) {
    if (date < todayKey()) return { screen: screen(state, 'Этот день уже прошёл.') };
    state.data.date = date;
    delete state.data.at;
    if (state.editing && state.data.time && pastNotice(state)) {
      return go(user, state, 'hour', 'Это время уже прошло. Выберите другое.');
    }
    if (state.editing && (state.data.time || state.data.allDay || state.kind === 'task')) return go(user, state, 'confirm');
    return go(user, state, nextStep(state, 'date'));
  }

  async function save(user, state, force) {
    const token = await store.token(user);
    const item = buildItem(state.kind, state.data);
    if (force) item.allow_conflicts = true;
    let saved;
    try {
      saved = await backend.createItem(token, item);
    } catch (error) {
      if (error instanceof BackendError && error.code === 'meeting_conflict') {
        state.conflicts = error.details.conflicts || [];
        return go(user, state, 'conflict');
      }
      if (error instanceof BackendError && error.status === 400) return { screen: screen(state, error.message) };
      throw error;
    }
    await store.clearWizard(user);
    const buttons = [[button('☰ Меню', 'm:menu'), button(`➕ Ещё ${KINDS[state.kind].label}`, `m:new:${state.kind}`)]];
    if (saved.undo_token) buttons.unshift([button('↩️ Отменить', `u:${saved.undo_token}`)]);
    const note = notifyNote(saved, now().getTime());
    return { screen: { text: `✅ ${KINDS[state.kind].done}:\n${itemLine(saved)}${note ? `\n${note}` : ''}`, buttons }, done: true };
  }

  return {
    /** Новый мастер; mid сообщения с мастером сохраняет вызывающий */
    async start(user, kind) {
      const state = { id: newId(), kind, step: 'title', data: {}, history: [] };
      await store.setWizard(user, state);
      return { state, screen: screen(state) };
    },

    /** Нажатие кнопки мастера. step и value из payload; устаревшие кнопки отклоняются */
    async press(user, state, step, value) {
      const data = state.data;
      switch (step) {
        case 'cancel':
          await store.clearWizard(user);
          return { screen: { text: 'Отменено. Ничего не сохранил.', buttons: [[button('☰ Меню', 'm:menu')]] }, done: true };
        case 'back': {
          if (!state.history.length) return { screen: screen(state) };
          state.step = state.history.pop();
          await store.setWizard(user, state);
          return { screen: screen(state) };
        }
        case 'goto':
          if (!SCREENS[value]) return { screen: screen(state) };
          if (value !== 'confirm') state.editing = true;
          return go(user, state, value);
        case 'edit':
          return go(user, state, 'edit');
        case 'save':
          if (state.step !== 'confirm' && state.step !== 'conflict') return { stale: true };
          return save(user, state, value === 'force');
      }
      if (step !== state.step) return { stale: true };
      switch (step) {
        case 'due':
          if (value === 'none') {
            delete data.date;
            delete data.time;
            return go(user, state, 'confirm');
          }
          if (value === 'cal') return go(user, state, 'date');
          delete data.time;
          return setDate(user, state, addDays(todayKey(), Number(value)));
        case 'when':
          if (value.startsWith('+')) {
            const at = new Date(now().getTime() + Number(value.slice(1)) * 60000);
            at.setSeconds(0, 0);
            data.at = at.toISOString();
            data.date = dayKey(at);
            data.time = formatTime(at);
            return go(user, state, 'confirm');
          }
          if (value === 'cal') return go(user, state, 'date');
          data.date = addDays(todayKey(), Number(value));
          delete data.at;
          return go(user, state, 'hour');
        case 'date':
          if (value.startsWith('month:')) {
            state.month = value.slice(6);
            await store.setWizard(user, state);
            return { screen: screen(state) };
          }
          return setDate(user, state, value);
        case 'tasktime':
          if (value === 'none') {
            delete data.time;
            return go(user, state, 'confirm');
          }
          return go(user, state, 'hour');
        case 'hour':
          if (value === 'allday') {
            data.allDay = true;
            delete data.time;
            delete data.duration;
            return go(user, state, state.editing ? 'confirm' : 'participants');
          }
          state.hour = value;
          return go(user, state, 'minute');
        case 'minute':
          return setTime(user, state, value);
        case 'duration':
          data.duration = Number(value);
          return go(user, state, nextStep(state, 'duration'));
        case 'participants':
          data.participants = [];
          return go(user, state, nextStep(state, 'participants'));
        case 'location':
          data.location = value === 'online' ? 'Онлайн' : null;
          return go(user, state, 'confirm');
      }
      return { screen: screen(state) };
    },

    /** Текстовое сообщение во время мастера */
    async text(user, state, text) {
      const value = text.trim();
      const data = state.data;
      switch (state.step) {
        case 'title':
          if (!value || value.length > 300) return { screen: screen(state, 'Название — от 1 до 300 символов.') };
          data.title = value;
          return go(user, state, state.editing ? 'confirm' : nextStep(state, 'title'));
        case 'participants':
          data.participants = value.split(/[,;]|\sи\s/).map((name) => name.trim()).filter(Boolean).slice(0, 20);
          return go(user, state, nextStep(state, 'participants'));
        case 'location':
          data.location = value.slice(0, 200);
          return go(user, state, 'confirm');
        case 'due':
        case 'when':
        case 'date': {
          const date = parseDate(value);
          const time = parseTime(value);
          if (!date && time && state.kind !== 'task') {
            data.date = data.date || todayKey();
            return setTime(user, state, time);
          }
          if (!date) return { screen: screen(state, 'Не понял дату. Напишите «завтра» или выберите кнопкой.') };
          if (time && state.kind !== 'task') {
            data.date = date;
            return setTime(user, state, time);
          }
          return setDate(user, state, date);
        }
        case 'hour':
        case 'minute':
        case 'tasktime': {
          const time = parseTime(value);
          if (!time) return { screen: screen(state, 'Не понял время. Напишите, например, «15:30».') };
          return setTime(user, state, time);
        }
      }
      return { screen: screen(state, 'Выберите вариант кнопкой.') };
    },
    log,
  };
}
