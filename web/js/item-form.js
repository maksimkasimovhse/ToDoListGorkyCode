// Окно записи: ручное создание из «+» и редактирование по двойному клику в любой панели.
// Правила полей — как у ассистента [ФТ 6, 7]: задаче срок не нужен, напоминанию — дата и время,
// встрече — дата и время начала, длительность по умолчанию 60 минут. Тип записи не меняется.
import * as api from './api.js';
import { el } from './dom.js';
import { dueNote } from './items.js';
import { addDays, dayKey, formatTime, localIso, now, todayKey } from './time.js';

const PLACEHOLDERS = {
  task: 'Например: купить билеты',
  reminder: 'Например: позвонить маме',
  meeting: 'Например: встреча с командой',
};
const HINTS = {
  task: 'Дату и время можно не указывать — задача будет без срока.',
  reminder: 'Напомню в указанные дату и время.',
  meeting: '',
};
const DURATIONS = [30, 60, 90, 120, 180];

/** Ближайший целый час: в 14:20 — 15:00. Поздним вечером — завтра в 09:00 */
function nextHour() {
  const hour = Number(formatTime(now()).slice(0, 2)) + 1;
  return hour > 22 ? { date: addDays(todayKey(), 1), time: '09:00' } : { date: todayKey(), time: `${String(hour).padStart(2, '0')}:00` };
}

/** Описание конфликта для окна: «Встреча с командой, 16:00–17:00» */
function conflictLine(item) {
  if (!item.start_at) return item.title;
  return `${item.title}, ${formatTime(item.start_at)}–${formatTime(item.end_at)}`;
}

/** Дата, время и длительность записи в полях окна: '2026-10-31', '15:00', 60 */
function whenOf(item) {
  const point = item.type === 'meeting' ? item.start_at : item.type === 'reminder' ? item.remind_at : item.due_at;
  if (point) {
    const minutes = item.type === 'meeting' && item.end_at ? Math.round((Date.parse(item.end_at) - Date.parse(item.start_at)) / 60000) : 60;
    return { date: dayKey(point), time: formatTime(point), duration: minutes };
  }
  if (item.due_date) return { date: item.due_date, time: '', duration: 60 };
  if (item.period_end) return { date: dayKey(item.period_end), time: '', duration: 60 };
  return { date: '', time: '', duration: 60 };
}

/**
 * dialog — <dialog id="item-dialog"> из index.html. Колбэки: onCreated(item), onUpdated(item),
 * onDelete(item), onDone(item), onReopen(item).
 * Возвращает { open({ date }), edit(item) }: date — день, выбранный во вкладке панели.
 */
export function createItemForm({ dialog, onCreated, onUpdated, onDelete, onDone, onReopen }) {
  const form = dialog.querySelector('form');
  const field = (name) => form.elements.namedItem(name);
  const title = field('title');
  const date = field('date');
  const time = field('time');
  const duration = field('duration');
  const durationField = dialog.querySelector('[data-for="meeting"]');
  const hint = dialog.querySelector('.item-form__hint');
  const error = dialog.querySelector('.item-form__error');
  const conflictBox = dialog.querySelector('.item-form__conflict');
  const heading = dialog.querySelector('.dialog__title');
  const extra = dialog.querySelector('.item-form__extra');
  const doneButton = dialog.querySelector('[data-action="toggle-done"]');
  const submit = dialog.querySelector('[type="submit"]');
  const typeRadios = [...form.querySelectorAll('input[name="type"]')];

  let editing = null; // запись в окне редактирования, null — окно создания
  let initial = null; // значения полей при открытии: по ним видно, что изменил пользователь
  let allowConflicts = false;

  const type = () => form.elements.namedItem('type').value;
  const submitLabel = () => (editing ? 'Сохранить изменения' : 'Добавить');

  function resetConflict() {
    allowConflicts = false;
    conflictBox.hidden = true;
    submit.textContent = submitLabel();
  }

  function syncType() {
    const current = type();
    title.placeholder = PLACEHOLDERS[current];
    hint.textContent = HINTS[current];
    hint.hidden = !HINTS[current];
    durationField.hidden = current !== 'meeting';
    const needsWhen = current !== 'task';
    date.required = needsWhen;
    time.required = needsWhen;
    // Напоминанию и встрече нужно время: подставляем ближайший час, чтобы не вводить с нуля
    if (!editing && needsWhen && !time.value) {
      const next = nextHour();
      if (!date.value) date.value = next.date;
      time.value = next.time;
    }
    error.textContent = '';
    resetConflict();
  }

  function setDuration(minutes) {
    for (const option of [...duration.options]) if (option.dataset.custom) option.remove();
    if (!DURATIONS.includes(minutes)) {
      const option = el('option', null, `${minutes} мин`);
      option.value = String(minutes);
      option.dataset.custom = '1';
      duration.append(option);
    }
    duration.value = String(minutes);
  }

  function prepare(mode) {
    editing = mode;
    form.reset();
    heading.textContent = mode ? 'Редактирование' : 'Новая запись';
    for (const radio of typeRadios) radio.disabled = Boolean(mode);
    extra.hidden = !mode;
    date.disabled = false;
    time.disabled = false;
    duration.disabled = false;
    setDuration(60);
  }

  function open({ date: day = null } = {}) {
    prepare(null);
    form.elements.namedItem('type').value = 'task';
    date.value = day || '';
    time.value = '';
    initial = null;
    syncType();
    dialog.showModal();
    title.focus();
  }

  function edit(item) {
    prepare(item);
    form.elements.namedItem('type').value = item.type;
    title.value = item.title;
    const when = whenOf(item);
    date.value = when.date;
    time.value = when.time;
    setDuration(when.duration);
    initial = { date: date.value, time: time.value, duration: duration.value };
    syncType();

    if (item.type === 'task' && item.period_end) hint.textContent = `Срок: ${dueNote(item)}. Если выбрать дату, срок заменится.`;
    if (item.type === 'task') hint.hidden = !hint.textContent;
    if (item.all_day) {
      // Встреча на весь день: пересчёт границ суток здесь не нужен — меняется только название
      date.disabled = true;
      time.disabled = true;
      durationField.hidden = true;
      hint.textContent = 'Встреча на весь день: можно изменить название.';
      hint.hidden = false;
    }

    const closable = item.type !== 'meeting';
    doneButton.hidden = !closable;
    doneButton.textContent = item.status === 'done' ? 'Вернуть в работу' : 'Выполнено';
    dialog.showModal();
    title.focus();
    title.select();
  }

  /** Поля для POST /api/items или исключение с текстом для пользователя */
  function build() {
    const current = type();
    const text = title.value.trim();
    if (!text) throw new Error('Напишите, что нужно сделать.');
    // Время без даты — сегодня, как в ответах ассистента [ФТ 5]
    const day = date.value || (time.value ? todayKey() : '');
    const fields = { type: current, title: text, source_text: text };

    if (current === 'task') {
      if (day && time.value) fields.due_at = localIso(day, time.value);
      else if (day) fields.due_date = day;
      return fields;
    }
    if (!day || !time.value) throw new Error(current === 'meeting' ? 'Укажите дату и время встречи.' : 'Укажите, когда напомнить.');
    const start = localIso(day, time.value);
    if (current === 'reminder') return { ...fields, remind_at: start };
    const end = new Date(Date.parse(start) + Number(duration.value) * 60000).toISOString();
    return { ...fields, start_at: start, end_at: end };
  }

  /** Только изменённые поля для PATCH /api/items/{id}; пустой объект — менять нечего */
  function buildPatch() {
    const full = build();
    const patch = {};
    if (full.title !== editing.title) patch.title = full.title;
    if (editing.all_day) return patch;

    const changed = date.value !== initial.date || time.value !== initial.time || duration.value !== initial.duration;
    if (!changed) return patch;
    if (editing.type === 'task') {
      // Вариант срока один: старый нужно очистить явно, иначе бэкенд отклонит запись
      Object.assign(patch, { due_date: null, due_at: null, period_start: null, period_end: null });
      if (full.due_at) patch.due_at = full.due_at;
      else if (full.due_date) patch.due_date = full.due_date;
    } else if (editing.type === 'reminder') {
      patch.remind_at = full.remind_at;
    } else {
      patch.start_at = full.start_at;
      patch.end_at = full.end_at;
    }
    return patch;
  }

  function showConflict(conflicts) {
    conflictBox.replaceChildren(el('strong', null, 'В это время уже есть:'));
    const list = el('ul');
    for (const item of conflicts) list.append(el('li', null, conflictLine(item)));
    conflictBox.append(list, el('span', null, 'Можно выбрать другое время или сохранить всё равно.'));
    conflictBox.hidden = false;
    allowConflicts = true;
    submit.textContent = editing ? 'Всё равно сохранить' : 'Всё равно добавить';
  }

  form.addEventListener('change', (event) => {
    if (event.target.name === 'type') syncType();
    else resetConflict();
  });
  form.addEventListener('input', () => {
    error.textContent = '';
  });
  dialog.querySelector('[data-action="cancel"]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-action="delete"]').addEventListener('click', () => {
    const item = editing;
    dialog.close();
    onDelete(item);
  });
  doneButton.addEventListener('click', () => {
    const item = editing;
    dialog.close();
    if (item.status === 'done') onReopen(item);
    else onDone(item);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let request;
    try {
      if (editing) {
        const patch = buildPatch();
        if (!Object.keys(patch).length) {
          dialog.close();
          return;
        }
        request = () => api.patchItem(editing.id, patch, { allowConflicts });
      } else {
        const fields = build();
        request = () => api.createItem(fields, { allowConflicts });
      }
    } catch (problem) {
      error.textContent = problem.message;
      return;
    }
    submit.disabled = true;
    try {
      const item = await request();
      const wasEditing = Boolean(editing);
      dialog.close();
      (wasEditing ? onUpdated : onCreated)(item);
    } catch (problem) {
      if (problem.code === 'meeting_conflict') showConflict((problem.details && problem.details.conflicts) || []);
      else error.textContent = problem.status === 400 ? problem.message : 'Не получилось сохранить. Попробуйте ещё раз.';
    } finally {
      submit.disabled = false;
    }
  });

  return { open, edit };
}
