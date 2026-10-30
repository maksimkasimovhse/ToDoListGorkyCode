// Левая панель «Последнее»: недавно созданные записи, поиск и фильтр по типам.
import * as api from './api.js';
import { el } from './dom.js';
import { TYPES, shortWhen } from './items.js';

export function createRecent({ list, heading, search, filters, onSelect }) {
  const state = { query: '', types: new Set(), selectedId: null, items: [] };
  let requestSeq = 0;
  let debounce = null;

  for (const [type, meta] of Object.entries(TYPES)) {
    const chip = el('button', 'chip');
    chip.type = 'button';
    chip.setAttribute('aria-pressed', 'false');
    chip.append(el('span', `dot dot--${type}`), meta.plural);
    chip.addEventListener('click', () => {
      if (state.types.has(type)) state.types.delete(type);
      else state.types.add(type);
      chip.setAttribute('aria-pressed', String(state.types.has(type)));
      refresh();
    });
    filters.append(chip);
  }

  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = search.value.trim();
      refresh();
    }, 300);
  });

  async function refresh() {
    const seq = ++requestSeq;
    const types = [...state.types];
    heading.textContent = state.query ? 'Результаты поиска' : 'Последние записи';
    try {
      const result = state.query
        ? await api.searchItems(state.query, 20)
        : await api.getRecentItems({ types, limit: 20 });
      if (seq !== requestSeq) return;
      const items = (result && result.items) || [];
      // Поиск в контракте не принимает типы — фильтруем здесь
      state.items = types.length ? items.filter((item) => types.includes(item.type)) : items;
      render();
    } catch (error) {
      console.warn('Не загрузили последние записи', error);
      if (seq === requestSeq) list.replaceChildren(el('li', 'recent__empty', 'Не удалось загрузить записи'));
    }
  }

  function render() {
    list.replaceChildren();
    if (!state.items.length) {
      list.append(el('li', 'recent__empty', state.query ? 'Ничего не нашлось' : 'Пока записей нет'));
      return;
    }
    for (const item of state.items) {
      const row = el('li', 'recent__item');
      row.dataset.id = item.id;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      if (item.status === 'done') row.classList.add('is-done');
      if (item.id === state.selectedId) row.classList.add('is-selected');
      row.append(el('span', `dot dot--${item.type}`), el('span', 'recent__title', item.title), el('span', 'recent__date', shortWhen(item)));
      row.title = item.title;
      row.addEventListener('click', () => onSelect(item));
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect(item);
      });
      list.append(row);
    }
  }

  function setSelected(id) {
    state.selectedId = id;
    for (const row of list.querySelectorAll('.recent__item')) row.classList.toggle('is-selected', row.dataset.id === id);
  }

  return { refresh, setSelected };
}
