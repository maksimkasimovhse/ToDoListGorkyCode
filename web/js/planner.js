// Правая панель «Мои записи»: записи за выбранный период, сгруппированные по дням.
import * as api from './api.js';
import { el } from './dom.js';
import { createCards } from './cards.js';
import { groupByDay } from './items.js';
import { addDays, dayTitle, startOfDayIso, todayKey, weekdayIndex } from './time.js';

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
  const { section } = createCards({
    isSelected: (id) => id === selectedId,
    isFlashed: (id) => flashIds.has(id),
    onSelect,
    onOpen,
    onToggleDone,
    onDelete,
  });
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
