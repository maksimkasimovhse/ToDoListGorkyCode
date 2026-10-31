// Карточки записей в виде шкалы времени: общие для списка в «Мои записи» и дня в календаре.
import { el } from './dom.js';
import { dueNote, itemMoment, timeLabel, whenLabel } from './items.js';
import { formatTime } from './time.js';

/**
 * isSelected(id), isFlashed(id) — состояние панели; onSelect/onOpen/onToggleDone/onDelete(item) — действия.
 * Возвращает { section(title, items, opts), slot(item, opts) }.
 */
export function createCards({ isSelected, isFlashed, onSelect, onOpen, onToggleDone, onDelete }) {
  function section(title, items, { overdue = false, plain = false } = {}) {
    const box = el('section', 'day');
    box.append(el('h3', `day__title${overdue ? ' day__title--danger' : ''}`, title));
    // plain — раздел без времени («Без срока»): карточки на всю ширину, без шкалы времени
    const list = el('ul', `timeline${plain ? ' timeline--plain' : ''}`);
    for (const item of items) list.append(slot(item, { overdue, plain }));
    box.append(list);
    return box;
  }

  function slot(item, { overdue = false, plain = false } = {}) {
    const row = el('li', `slot${plain ? ' slot--plain' : ''}`);
    if (!plain) {
      const moment = itemMoment(item);
      const time = item.all_day ? 'весь день' : moment && !overdue ? formatTime(moment) : '';
      row.append(el('span', 'slot__time', time), el('span', `slot__dot slot__dot--${item.type}`));
    }

    const finished = item.status === 'done' || item.status === 'cancelled';
    const card = el('div', `pcard pcard--${item.type}`);
    card.dataset.id = item.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    if (isSelected(item.id)) card.classList.add('is-selected');
    if (isFlashed(item.id)) card.classList.add('is-flash');
    if (overdue) card.classList.add('pcard--overdue');
    if (finished) card.classList.add('is-done');

    const content = el('div', 'pcard__content');
    const timeText = overdue ? whenLabel(item) : timeLabel(item);
    if (timeText) content.append(el('div', 'pcard__time', timeText));
    content.append(el('div', 'pcard__title', item.title));
    const note = dueNote(item);
    if (note && !overdue && note !== 'без срока') content.append(el('div', 'pcard__note', note));
    card.append(content);

    // Крестик: задача и напоминание отмечаются выполненными (в окне записи они ещё и удаляются),
    // встреча не бывает «выполненной» — её крестик удаляет. У уже закрытых крестика нет: вернуть
    // в работу или удалить можно в окне записи (двойной клик)
    const closable = item.type !== 'meeting';
    if (!(closable && finished)) {
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
    }

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

  return { section, slot };
}
