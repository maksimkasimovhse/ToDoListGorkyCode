// Панель «Мои записи»: календарь — неделя (с понедельника) и месяц.
// Два режима: узкий (в панели) — мини-календарь с точками и список выбранного дня; полноэкранный —
// месяц с плашками записей и неделя со шкалой времени. Данные — из GET /api/items за видимый период.
import * as api from './api.js';
import { createCards } from './cards.js';
import { el } from './dom.js';
import { compareItems, itemDayKey, itemMoment, timeLabel } from './items.js';
import { addDays, dayTitle, formatTime, now, startOfDayIso, todayKey, weekdayIndex } from './time.js';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const HOUR_PX = 48;
const MIN_EVENT_MIN = 30;
const API_LIMIT = 100; // больше записей за один запрос бэкенд не отдаёт

const pad = (n) => String(n).padStart(2, '0');
const mondayOf = (key) => addDays(key, -weekdayIndex(key));
const monthStart = (key) => `${key.slice(0, 8)}01`;
const daysInMonth = (key) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0)).getUTCDate();
const sameMonth = (a, b) => a.slice(0, 7) === b.slice(0, 7);
const isFinished = (item) => item.status === 'done' || item.status === 'cancelled';

/** Месяц: сетка с понедельника, 5 или 6 строк. Неделя: понедельник–воскресенье. [start, end) */
function rangeOf(view, cursor) {
  if (view === 'week') {
    const start = mondayOf(cursor);
    return { start, end: addDays(start, 7) };
  }
  const first = monthStart(cursor);
  const start = mondayOf(first);
  const rows = Math.ceil((weekdayIndex(first) + daysInMonth(first)) / 7);
  return { start, end: addDays(start, rows * 7) };
}

function shiftMonth(key, delta) {
  const date = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1 + delta, 1));
  return date.toISOString().slice(0, 10);
}

function minutesOf(value) {
  const [h, m] = formatTime(value).split(':').map(Number);
  return h * 60 + m;
}

/**
 * root — контейнер .calendar; onSelect/onOpen/onToggleDone/onDelete(item) — как у списка;
 * onAdd(dayKey) — двойной клик по пустому месту дня.
 */
export function createCalendar({ root, onSelect, onOpen, onToggleDone, onDelete, onAdd }) {
  const state = {
    view: 'month',
    cursor: todayKey(),
    selectedDay: todayKey(),
    full: false,
    items: new Map(), // dayKey → записи дня
    overdue: [], // просроченные и без срока — только в узкой текущей неделе
    undated: [],
    total: 0,
    selectedId: null,
    flashIds: new Set(),
    seq: 0,
  };
  let popover = null;

  const toolbar = el('div', 'cal-toolbar');
  const body = el('div', 'cal-body');
  root.append(toolbar, body);

  const cards = createCards({
    isSelected: (id) => id === state.selectedId,
    isFlashed: (id) => state.flashIds.has(id),
    onSelect,
    onOpen,
    onToggleDone,
    onDelete,
  });

  // ---------- Данные ----------

  async function refresh({ flash = [] } = {}) {
    const seq = ++state.seq;
    state.flashIds = new Set(flash);
    const { start, end } = rangeOf(state.view, state.cursor);
    // Текущая неделя заменяет прежний список «Ближайшие»: в ней же просроченные и задачи без срока [ФТ 8].
    // Просроченные бэкенд в ответе не отдаёт (overdue всегда пустой): берём открытые задачи со сроком
    // раньше сегодняшнего дня и оставляем те, что он сам пометил computed.overdue
    const extras = state.view === 'week' && todayKey() >= start && todayKey() < end;
    try {
      const [result, undated, past] = await Promise.all([
        api.getItems({ from: startOfDayIso(start), to: startOfDayIso(end) }),
        extras ? api.getUndatedItems(['task']) : null,
        extras ? api.getItems({ to: startOfDayIso(todayKey()), status: 'open', types: ['task'] }) : null,
      ]);
      if (seq !== state.seq) return;
      const items = (result && result.items) || [];
      const active = (list) => ((list && list.items) || []).filter((item) => item.status === 'open' || item.status === 'scheduled');
      const shown = new Set(items.map((item) => item.id));
      state.undated = active(undated).filter((item) => !shown.has(item.id));
      state.overdue = active(past).filter((item) => item.computed && item.computed.overdue && !shown.has(item.id));
      const byDay = new Map();
      for (const item of items) {
        const key = itemDayKey(item, start, end);
        if (!key || key < start || key >= end) continue; // без срока в календарь не попадает
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(item);
      }
      for (const list of byDay.values()) list.sort(compareItems);
      state.items = byDay;
      state.total = (result && result.total) || items.length;
      render();
    } catch (error) {
      console.warn('Не загрузили календарь', error);
      if (seq === state.seq) body.replaceChildren(el('p', 'planner__empty', 'Не удалось загрузить записи'));
    }
  }

  // ---------- Панель управления ----------

  function title() {
    if (state.view === 'month') return `${MONTHS[Number(state.cursor.slice(5, 7)) - 1]} ${state.cursor.slice(0, 4)}`;
    const start = mondayOf(state.cursor);
    const end = addDays(start, 6);
    const label = (key) => `${Number(key.slice(8))} ${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}`;
    return `${label(start)} – ${label(end)}`;
  }

  function step(direction) {
    if (state.view === 'month') {
      state.cursor = shiftMonth(state.cursor, direction);
      state.selectedDay = sameMonth(state.cursor, todayKey()) ? todayKey() : state.cursor;
    } else {
      state.cursor = addDays(mondayOf(state.cursor), direction * 7);
      const monday = mondayOf(state.cursor);
      state.selectedDay = todayKey() >= monday && todayKey() < addDays(monday, 7) ? todayKey() : monday;
    }
    refresh();
  }

  function goToday() {
    state.cursor = todayKey();
    state.selectedDay = todayKey();
    refresh();
  }

  function renderToolbar() {
    const prev = el('button', 'cal-nav', '‹');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Назад');
    prev.addEventListener('click', () => step(-1));
    const next = el('button', 'cal-nav', '›');
    next.type = 'button';
    next.setAttribute('aria-label', 'Вперёд');
    next.addEventListener('click', () => step(1));
    const today = el('button', 'btn-ghost cal-today', 'Сегодня');
    today.type = 'button';
    today.addEventListener('click', goToday);
    toolbar.replaceChildren(el('span', 'cal-title', title()), el('span', 'cal-spacer'), today, prev, next);
  }

  // ---------- Общие части ----------

  function chip(item, { time = true } = {}) {
    const node = el('div', `cal-chip cal-chip--${item.type}${isFinished(item) ? ' is-done' : ''}`);
    node.dataset.id = item.id;
    if (item.id === state.selectedId) node.classList.add('is-selected');
    if (state.flashIds.has(item.id)) node.classList.add('is-flash');
    const label = timeLabel(item);
    if (time && label) node.append(el('span', 'cal-chip__time', label.split('–')[0]));
    node.append(el('span', 'cal-chip__title', item.title));
    node.title = `${label ? `${label} · ` : ''}${item.title}`;
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      onSelect(item);
    });
    node.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      onOpen(item);
    });
    return node;
  }

  function dayItems(key) {
    return state.items.get(key) || [];
  }

  function selectDay(key) {
    state.selectedDay = key;
    if (state.view === 'month' && !sameMonth(key, state.cursor)) {
      state.cursor = key;
      refresh();
      return;
    }
    render();
  }

  function note() {
    if (state.total <= API_LIMIT) return null;
    return el('p', 'cal-note', `Показаны первые ${API_LIMIT} записей из ${state.total}.`);
  }

  function closePopover() {
    if (popover) popover.remove();
    popover = null;
  }

  // ---------- Месяц, узкий ----------

  function renderMonthNarrow() {
    const { start, end } = rangeOf('month', state.cursor);
    const wrap = el('div', 'cal-month');
    const head = el('div', 'cal-weekdays');
    for (const name of WEEKDAYS) head.append(el('span', null, name));
    const grid = el('div', 'cal-grid');
    for (let key = start; key < end; key = addDays(key, 1)) {
      const items = dayItems(key);
      const cell = el('button', 'cal-day');
      cell.type = 'button';
      cell.dataset.day = key;
      if (!sameMonth(key, state.cursor)) cell.classList.add('is-other');
      if (key === todayKey()) cell.classList.add('is-today');
      if (key === state.selectedDay) cell.classList.add('is-selected');
      cell.setAttribute('aria-label', `${dayTitle(key)}${items.length ? `, записей: ${items.length}` : ''}`);
      cell.append(el('span', 'cal-day__num', String(Number(key.slice(8)))));
      const dots = el('span', 'cal-dots');
      for (const item of items.slice(0, 3)) dots.append(el('i', `cal-dot cal-dot--${item.type}${isFinished(item) ? ' is-done' : ''}`));
      if (items.length > 3) dots.append(el('i', 'cal-dot-more', '+'));
      cell.append(dots);
      cell.addEventListener('click', () => selectDay(key));
      cell.addEventListener('dblclick', () => onAdd(key));
      grid.append(cell);
    }
    wrap.append(head, grid);

    const list = el('div', 'cal-daylist');
    const items = dayItems(state.selectedDay);
    list.append(items.length ? cards.section(dayTitle(state.selectedDay), items) : el('p', 'planner__empty', `${dayTitle(state.selectedDay)}: записей нет`));
    body.replaceChildren(wrap, list, ...(note() ? [note()] : []));
  }

  // ---------- Месяц, во весь экран ----------

  function renderMonthFull() {
    const { start, end } = rangeOf('month', state.cursor);
    const wrap = el('div', 'cal-month cal-month--full');
    const head = el('div', 'cal-weekdays');
    for (const name of WEEKDAYS) head.append(el('span', null, name));
    const grid = el('div', 'cal-grid');
    const cells = [];
    for (let key = start; key < end; key = addDays(key, 1)) {
      const cell = el('div', 'cal-cell');
      cell.dataset.day = key;
      if (!sameMonth(key, state.cursor)) cell.classList.add('is-other');
      if (key === todayKey()) cell.classList.add('is-today');
      if (key === state.selectedDay) cell.classList.add('is-selected');
      const num = el('span', 'cal-cell__num', key.slice(8).replace(/^0/, '') + (key.endsWith('-01') ? ` ${MONTHS_SHORT[Number(key.slice(5, 7)) - 1]}` : ''));
      cell.append(num, el('div', 'cal-cell__items'));
      cell.addEventListener('click', () => selectDay(key));
      cell.addEventListener('dblclick', () => onAdd(key));
      cells.push([key, cell]);
      grid.append(cell);
    }
    wrap.append(head, grid);
    body.replaceChildren(wrap, ...(note() ? [note()] : []));

    // Сколько плашек влезает, видно только после раскладки: заполняем ячейки теперь
    for (const [key, cell] of cells) {
      const box = cell.querySelector('.cal-cell__items');
      const items = dayItems(key);
      const room = Math.max(1, Math.floor((cell.clientHeight - 26) / 21));
      const shown = items.length > room ? Math.max(room - 1, 0) : items.length;
      for (const item of items.slice(0, shown)) box.append(chip(item));
      if (items.length > shown) {
        const more = el('button', 'cal-more', `ещё ${items.length - shown}`);
        more.type = 'button';
        more.addEventListener('click', (event) => {
          event.stopPropagation();
          openPopover(key, cell);
        });
        box.append(more);
      }
    }
  }

  /** «ещё N»: все записи дня во всплывающем окне рядом с ячейкой */
  function openPopover(key, cell) {
    closePopover();
    popover = el('div', 'cal-pop');
    popover.append(el('div', 'cal-pop__title', dayTitle(key)));
    const list = el('div', 'cal-pop__list');
    for (const item of dayItems(key)) list.append(chip(item));
    popover.append(list);
    popover.addEventListener('click', (event) => event.stopPropagation());
    root.append(popover);
    const box = root.getBoundingClientRect();
    const rect = cell.getBoundingClientRect();
    const left = Math.min(Math.max(rect.left - box.left, 8), Math.max(box.width - popover.offsetWidth - 8, 8));
    const top = Math.min(Math.max(rect.top - box.top, 8), Math.max(box.height - popover.offsetHeight - 8, 8));
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  // ---------- Неделя, узкая: список дней до конца недели ----------

  function renderWeekNarrow() {
    const { start, end } = rangeOf('week', state.cursor);
    // Текущая неделя показывается с сегодняшнего дня — «до конца недели»
    const from = todayKey() >= start && todayKey() < end ? todayKey() : start;
    const wrap = el('div', 'cal-agenda');
    if (state.overdue.length) wrap.append(cards.section('Просрочено', state.overdue, { overdue: true }));
    for (let key = from; key < end; key = addDays(key, 1)) {
      const items = dayItems(key);
      if (items.length) wrap.append(cards.section(dayTitle(key), items));
    }
    if (state.undated.length) wrap.append(cards.section('Без срока', state.undated, { plain: true }));
    if (!wrap.childElementCount) wrap.append(el('p', 'planner__empty', 'На эти дни записей нет'));
    body.replaceChildren(wrap, ...(note() ? [note()] : []));
  }

  // ---------- Неделя, во весь экран: шкала времени ----------

  /** Записи дня в пределах суток: { item, from, to } в минутах; остальные — «на весь день» */
  function split(items) {
    const timed = [];
    const allDay = [];
    for (const item of items) {
      const moment = itemMoment(item);
      if (item.all_day || !moment) {
        allDay.push(item);
        continue;
      }
      const from = minutesOf(moment);
      let to = from + MIN_EVENT_MIN;
      if (item.type === 'meeting' && item.end_at) {
        const length = Math.round((Date.parse(item.end_at) - Date.parse(item.start_at)) / 60000);
        to = from + Math.max(length, MIN_EVENT_MIN);
      }
      timed.push({ item, from, to: Math.min(to, 24 * 60) });
    }
    return { timed, allDay };
  }

  /** Пересекающиеся записи делят ширину колонки: простой жадный раскладчик */
  function layout(events) {
    const sorted = events.slice().sort((a, b) => a.from - b.from || b.to - a.to);
    const clusters = [];
    let cluster = null;
    let clusterEnd = -1;
    for (const event of sorted) {
      if (!cluster || event.from >= clusterEnd) {
        cluster = [];
        clusters.push(cluster);
        clusterEnd = -1;
      }
      cluster.push(event);
      clusterEnd = Math.max(clusterEnd, event.to);
    }
    for (const group of clusters) {
      const columns = [];
      for (const event of group) {
        let index = columns.findIndex((end) => end <= event.from);
        if (index === -1) index = columns.length;
        columns[index] = event.to;
        event.column = index;
      }
      for (const event of group) event.columns = columns.length;
    }
    return sorted;
  }

  function renderWeekFull() {
    const { start } = rangeOf('week', state.cursor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const wrap = el('div', 'week');

    const head = el('div', 'week__head');
    head.append(el('span', 'week__corner'));
    for (const key of days) {
      const cell = el('button', `week__day${key === todayKey() ? ' is-today' : ''}${key === state.selectedDay ? ' is-selected' : ''}`);
      cell.type = 'button';
      cell.append(el('span', 'week__dow', WEEKDAYS[weekdayIndex(key)]), el('span', 'week__num', String(Number(key.slice(8)))));
      cell.addEventListener('click', () => selectDay(key));
      head.append(cell);
    }

    const allDayRow = el('div', 'week__allday');
    allDayRow.append(el('span', 'week__corner week__label', 'весь день'));
    const columns = days.map((key) => {
      const { timed, allDay } = split(dayItems(key));
      const cell = el('div', 'week__allday-cell');
      for (const item of allDay) cell.append(chip(item, { time: false }));
      allDayRow.append(cell);
      return { key, timed };
    });
    const hasAllDay = allDayRow.querySelector('.cal-chip');

    const scroll = el('div', 'week__scroll');
    const grid = el('div', 'week__grid');
    grid.style.setProperty('--hour', `${HOUR_PX}px`);
    const times = el('div', 'week__times');
    for (let h = 1; h < 24; h += 1) {
      const label = el('span', 'week__time', `${pad(h)}:00`);
      label.style.top = `${h * HOUR_PX}px`;
      times.append(label);
    }
    grid.append(times);

    let earliest = 24 * 60;
    for (const { key, timed } of columns) {
      const col = el('div', `week__col${key === todayKey() ? ' is-today' : ''}`);
      col.dataset.day = key;
      col.addEventListener('dblclick', () => onAdd(key));
      for (const event of layout(timed)) {
        earliest = Math.min(earliest, event.from);
        const node = el('div', `week-ev week-ev--${event.item.type}${isFinished(event.item) ? ' is-done' : ''}`);
        node.dataset.id = event.item.id;
        if (event.item.id === state.selectedId) node.classList.add('is-selected');
        if (state.flashIds.has(event.item.id)) node.classList.add('is-flash');
        node.style.top = `${(event.from / 60) * HOUR_PX}px`;
        node.style.height = `${Math.max(((event.to - event.from) / 60) * HOUR_PX - 2, 20)}px`;
        node.style.left = `calc(${(event.column / event.columns) * 100}% + 1px)`;
        node.style.width = `calc(${100 / event.columns}% - 3px)`;
        node.append(el('div', 'week-ev__title', event.item.title), el('div', 'week-ev__time', timeLabel(event.item)));
        node.title = `${timeLabel(event.item)} · ${event.item.title}`;
        node.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelect(event.item);
        });
        node.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          onOpen(event.item);
        });
        col.append(node);
      }
      if (key === todayKey()) {
        const line = el('div', 'week__now');
        line.style.top = `${(minutesOf(now()) / 60) * HOUR_PX}px`;
        col.append(line);
      }
      grid.append(col);
    }
    scroll.append(grid);

    wrap.append(head);
    if (hasAllDay) wrap.append(allDayRow);
    wrap.append(scroll);
    body.replaceChildren(wrap, ...(note() ? [note()] : []));

    // Сразу показываем рабочие часы: от ближайшей записи или от часа перед «сейчас»
    const weekHasToday = days.includes(todayKey());
    const focus = Math.min(earliest < 24 * 60 ? earliest - 30 : Infinity, weekHasToday ? minutesOf(now()) - 60 : 7 * 60);
    scroll.scrollTop = Math.max(0, (Math.min(focus, 20 * 60) / 60) * HOUR_PX);
  }

  // ---------- Отрисовка ----------

  function render() {
    closePopover();
    renderToolbar();
    root.classList.toggle('cal--full', state.full);
    if (state.view === 'week') (state.full ? renderWeekFull : renderWeekNarrow)();
    else (state.full ? renderMonthFull : renderMonthNarrow)();
  }

  function setSelected(id) {
    state.selectedId = id;
    for (const node of root.querySelectorAll('[data-id]')) node.classList.toggle('is-selected', node.dataset.id === id);
  }

  document.addEventListener('click', (event) => {
    if (popover && !event.target.closest('.cal-pop')) closePopover();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !popover) return;
    closePopover();
    // Первое нажатие закрывает только окно дня; свернуть календарь можно следующим
    event.preventDefault();
  });

  return {
    /** Показать вид 'month' | 'week'; today — вернуться к текущему периоду */
    show(view, { today = false, flash = [] } = {}) {
      if (state.view !== view || today) {
        state.view = view;
        state.cursor = todayKey();
        state.selectedDay = todayKey();
      }
      return refresh({ flash });
    },
    refresh,
    setSelected,
    setFull(full) {
      state.full = full;
      render();
    },
    /** День, выбранный в календаре: его предлагает окно новой записи */
    selectedDay: () => state.selectedDay,
  };
}
