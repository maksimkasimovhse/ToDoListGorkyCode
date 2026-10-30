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

export function createPlanner({ body, tabs, onSelect, onToggleDone, onDelete }) {
  let tab = 'upcoming';
  let selectedId = null;
  let flashIds = new Set();
  let requestSeq = 0;

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-tab]');
    if (!button || button.dataset.tab === tab) return;
    tab = button.dataset.tab;
    for (const other of tabs.querySelectorAll('[data-tab]')) {
      other.classList.toggle('is-active', other === button);
      other.setAttribute('aria-selected', String(other === button));
    }
    refresh({ skeleton: true });
  });

  async function refresh({ flash = [], skeleton = false } = {}) {
    const seq = ++requestSeq;
    flashIds = new Set(flash);
    if (skeleton || !body.childElementCount) renderSkeleton();

    const [fromKey, toKey] = RANGES[tab](todayKey());
    try {
      const result = await api.getItems({
        from: startOfDayIso(fromKey),
        to: startOfDayIso(toKey),
        include_overdue: tab === 'upcoming' || tab === 'today' ? true : null,
      });
      if (seq !== requestSeq) return;
      render((result && result.items) || [], (result && result.overdue) || [], fromKey, toKey);
    } catch (error) {
      console.warn('Не загрузили записи', error);
      if (seq === requestSeq) body.replaceChildren(el('p', 'planner__empty', 'Не удалось загрузить записи'));
    }
  }

  function render(items, overdue, fromKey, toKey) {
    body.replaceChildren();
    if (overdue.length) body.append(section('Просрочено', overdue, { overdue: true }));
    for (const group of groupByDay(items, fromKey, toKey)) {
      body.append(section(group.key ? dayTitle(group.key) : 'Без срока', group.items));
    }
    if (!body.childElementCount) body.append(el('p', 'planner__empty', 'На этот период ничего не запланировано'));
  }

  function section(title, items, { overdue = false } = {}) {
    const box = el('section', 'day');
    box.append(el('h3', `day__title${overdue ? ' day__title--danger' : ''}`, title));
    const list = el('ul', 'timeline');
    for (const item of items) list.append(slot(item, overdue));
    box.append(list);
    return box;
  }

  function slot(item, overdue) {
    const row = el('li', 'slot');
    const moment = itemMoment(item);
    const time = item.all_day ? 'весь день' : moment && !overdue ? formatTime(moment) : '';
    row.append(el('span', 'slot__time', time), el('span', `slot__dot slot__dot--${item.type}`));

    const card = el('div', `pcard pcard--${item.type}`);
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    if (item.id === selectedId) card.classList.add('is-selected');
    if (flashIds.has(item.id)) card.classList.add('is-flash');
    if (overdue) card.classList.add('pcard--overdue');

    if (item.type !== 'meeting') {
      const check = el('button', 'pcard__check');
      check.type = 'button';
      check.title = 'Отметить выполненным';
      check.setAttribute('aria-label', `Отметить выполненным: ${item.title}`);
      check.addEventListener('click', (event) => {
        event.stopPropagation();
        onToggleDone(item);
      });
      card.append(check);
    }

    const content = el('div', 'pcard__content');
    const timeText = overdue ? whenLabel(item) : timeLabel(item);
    if (timeText) content.append(el('div', 'pcard__time', timeText));
    content.append(el('div', 'pcard__title', item.title));
    const note = dueNote(item);
    if (note && !overdue && note !== 'без срока') content.append(el('div', 'pcard__note', note));
    card.append(content);

    const remove = el('button', 'pcard__del', '×');
    remove.type = 'button';
    remove.title = 'Удалить';
    remove.setAttribute('aria-label', `Удалить: ${item.title}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      onDelete(item);
    });
    card.append(remove);

    card.addEventListener('click', () => onSelect(item));
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

  return { refresh, setSelected };
}
