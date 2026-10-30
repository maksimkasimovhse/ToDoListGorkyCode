// Правая панель «Мои записи»: записи за выбранный период, сгруппированные по дням.
import * as api from './api.js';
import { el } from './dom.js';
import { dueNote, groupByDay, itemMoment, timeLabel, whenLabel } from './items.js';
import { addDays, dayTitle, formatTime, startOfDayIso, todayKey, weekdayIndex } from './time.js';

// [from, to) в днях; «Неделя» — до конца текущей календарной недели [ФТ 5]
const RANGES = {
  upcoming: (today) => [today, addDays(today, 7)],
  today: (today) => [today, addDays(today, 1)],
  tomorrow: (today) => [addDays(today, 1), addDays(today, 2)],
  week: (today) => [today, addDays(today, 7 - weekdayIndex(today))],
};

export function createPlanner({ body, tabs, onSelect, onOpen, onToggleDone, onDelete }) {
  let tab = 'upcoming';
  let selectedId = null;
  let flashIds = new Set();
  let requestSeq = 0;
  let skeletonTimer = null;
  // Заглушка загрузки нужна только при долгом ответе: на быстром она мелькала и тут же пропадала
  const SKELETON_DELAY_MS = 300;

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (button) showTab(button.dataset.tab);
  });

  function showTab(name, { flash = [] } = {}) {
    if (name === tab) return refresh({ flash });
    tab = name;
    for (const other of tabs.querySelectorAll('[data-tab]')) {
      const active = other.dataset.tab === name;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', String(active));
    }
    return refresh({ flash, skeleton: true });
  }

  async function refresh({ flash = [], skeleton = false } = {}) {
    const seq = ++requestSeq;
    flashIds = new Set(flash);
    clearTimeout(skeletonTimer);
    if (skeleton || !body.childElementCount) {
      skeletonTimer = setTimeout(() => {
        if (seq === requestSeq) renderSkeleton();
      }, SKELETON_DELAY_MS);
    }

    const [fromKey, toKey] = RANGES[tab](todayKey());
    try {
      // Задачи без срока ни в один период не попадают [ФТ 8] — во «Ближайших» они отдельным разделом внизу.
      // Просроченные бэкенд в ответе не отдаёт (overdue всегда пустой): берём открытые задачи со сроком
      // раньше сегодняшнего дня и оставляем те, что он сам пометил computed.overdue
      const withOverdue = tab === 'upcoming' || tab === 'today';
      const [result, undated, past] = await Promise.all([
        api.getItems({ from: startOfDayIso(fromKey), to: startOfDayIso(toKey) }),
        tab === 'upcoming' ? api.getUndatedItems(['task']) : null,
        withOverdue ? api.getItems({ to: startOfDayIso(todayKey()), status: 'open', types: ['task'] }) : null,
      ]);
      if (seq !== requestSeq) return;
      clearTimeout(skeletonTimer);
      // В планах только незакрытые записи [ФТ 8]: бэкенд отдаёт все статусы, а фильтр status у него один
      const active = (list) => list.filter((item) => item.status === 'open' || item.status === 'scheduled');
      const items = active((result && result.items) || []);
      const shown = new Set(items.map((item) => item.id));
      for (const item of active((undated && undated.items) || [])) if (!shown.has(item.id)) items.push(item);
      const late = [...((result && result.overdue) || []), ...((past && past.items) || []).filter((item) => item.computed && item.computed.overdue)];
      const lateIds = new Set();
      const overdue = active(late).filter((item) => !shown.has(item.id) && !lateIds.has(item.id) && lateIds.add(item.id));
      render(items, overdue, fromKey, toKey);
    } catch (error) {
      console.warn('Не загрузили записи', error);
      if (seq === requestSeq) clearTimeout(skeletonTimer);
      if (seq === requestSeq) body.replaceChildren(el('p', 'planner__empty', 'Не удалось загрузить записи'));
    }
  }

  function render(items, overdue, fromKey, toKey) {
    body.replaceChildren();
    if (overdue.length) body.append(section('Просрочено', overdue, { overdue: true }));
    for (const group of groupByDay(items, fromKey, toKey)) {
      body.append(section(group.key ? dayTitle(group.key) : 'Без срока', group.items, { plain: !group.key }));
    }
    if (!body.childElementCount) body.append(el('p', 'planner__empty', 'На этот период ничего не запланировано'));
  }

  function section(title, items, { overdue = false, plain = false } = {}) {
    const box = el('section', 'day');
    box.append(el('h3', `day__title${overdue ? ' day__title--danger' : ''}`, title));
    // plain — раздел без времени («Без срока»): карточки на всю ширину, без шкалы времени
    const list = el('ul', `timeline${plain ? ' timeline--plain' : ''}`);
    for (const item of items) list.append(slot(item, overdue, plain));
    box.append(list);
    return box;
  }

  function slot(item, overdue, plain = false) {
    const row = el('li', `slot${plain ? ' slot--plain' : ''}`);
    if (!plain) {
      const moment = itemMoment(item);
      const time = item.all_day ? 'весь день' : moment && !overdue ? formatTime(moment) : '';
      row.append(el('span', 'slot__time', time), el('span', `slot__dot slot__dot--${item.type}`));
    }

    const card = el('div', `pcard pcard--${item.type}`);
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    if (item.id === selectedId) card.classList.add('is-selected');
    if (flashIds.has(item.id)) card.classList.add('is-flash');
    if (overdue) card.classList.add('pcard--overdue');

    const content = el('div', 'pcard__content');
    const timeText = overdue ? whenLabel(item) : timeLabel(item);
    if (timeText) content.append(el('div', 'pcard__time', timeText));
    content.append(el('div', 'pcard__title', item.title));
    const note = dueNote(item);
    if (note && !overdue && note !== 'без срока') content.append(el('div', 'pcard__note', note));
    card.append(content);

    // Крестик: задача и напоминание отмечаются выполненными (в окне записи они ещё и удаляются),
    // встреча не бывает «выполненной» — её крестик удаляет
    const closable = item.type !== 'meeting';
    const label = closable ? 'Отметить выполненным' : 'Удалить';
    const remove = el('button', 'pcard__del', '×');
    remove.type = 'button';
    remove.title = label;
    remove.setAttribute('aria-label', `${label}: ${item.title}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      // Карточка уезжает, затем действие; при ошибке список перерисуется заново
      card.classList.add('is-removing');
      setTimeout(() => (closable ? onToggleDone(item) : onDelete(item)), 180);
    });
    card.append(remove);

    card.addEventListener('click', () => onSelect(item));
    card.addEventListener('dblclick', () => onOpen(item));
    card.addEventListener('keydown', (event) => {
      if (event.target !== card || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      onSelect(item);
    });

    row.append(card);
    return row;
  }

  function renderSkeleton() {
    const list = el('ul', 'timeline');
    for (const type of ['task', 'reminder', 'meeting']) {
      const row = el('li', 'slot');
      row.append(el('span', 'slot__time'), el('span', `slot__dot slot__dot--${type}`), el('div', `pcard pcard--${type} is-skeleton`));
      list.append(row);
    }
    body.replaceChildren(list);
  }

  function setSelected(id) {
    selectedId = id;
    for (const card of body.querySelectorAll('.pcard[data-id]')) card.classList.toggle('is-selected', card.dataset.id === id);
  }

  /** День открытой вкладки — его предлагает окно новой записи. Для «Ближайшие» и «Неделя» — null */
  function selectedDay() {
    if (tab === 'today') return todayKey();
    if (tab === 'tomorrow') return addDays(todayKey(), 1);
    return null;
  }

  return { refresh, setSelected, selectedDay, showTab };
}
