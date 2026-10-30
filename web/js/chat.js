// История диалога и отрисовка ответов ассистента по типам из contracts.md, 2.2.
import { el } from './dom.js';
import { TYPES, describeChanges, groupByDay, hasDate, statusLabel, whenLabel } from './items.js';
import { addDays, dayKey, dayTitle, formatDay } from './time.js';

/**
 * handlers: onOption(option, flow), onSuggestion(text), onUndo(token, button), onItem(item),
 * onFlowAnswer(flow, fields), onFlowCancel(flow)
 */
export function createChat({ container, scroller, emptyState, handlers }) {
  let thinking = null;

  function append(node) {
    emptyState.hidden = true;
    container.append(node);
    scroller.scrollTop = scroller.scrollHeight;
  }

  // Кнопки старых вопросов больше не действуют: сервер уже ждёт ответа на последний
  function lockOptions() {
    for (const button of container.querySelectorAll('.option[data-kind="choice"]')) button.disabled = true;
    for (const control of container.querySelectorAll('.flow-form input, .flow-form button')) control.disabled = true;
  }

  function addUser(text, { voice = false } = {}) {
    lockOptions();
    const message = el('div', 'msg msg--user');
    message.append(el('div', 'bubble', text));
    if (voice) message.append(el('div', 'msg__meta', 'голосом'));
    append(message);
  }

  function addAssistant(response, { interactive = true, onRetry = null } = {}) {
    lockOptions();
    const message = el('div', `msg msg--assistant msg--${response.type}`);
    message.append(el('div', 'bubble', response.reply || 'Готово.'));

    const body = renderBody(response);
    if (body) message.append(body);
    if (response.flow && response.flow.status === 'awaiting_input') message.append(renderForm(response, interactive));

    const actions = el('div', 'options');
    for (const option of response.options || []) {
      const button = el('button', 'option', option.label);
      button.type = 'button';
      button.dataset.kind = 'choice';
      button.disabled = !interactive;
      button.addEventListener('click', () => handlers.onOption(option, response.flow));
      actions.append(button);
    }
    if (response.undo_token) {
      const button = el('button', 'option option--quiet', 'Отменить');
      button.type = 'button';
      button.addEventListener('click', () => handlers.onUndo(response.undo_token, button));
      actions.append(button);
    }
    if (onRetry && interactive) {
      const button = el('button', 'option', 'Повторить');
      button.type = 'button';
      button.addEventListener('click', () => {
        button.disabled = true;
        onRetry();
      });
      actions.append(button);
    }
    if (actions.childElementCount) message.append(actions);

    if (response.suggestions && response.suggestions.length) {
      const chips = el('div', 'suggestions');
      for (const text of response.suggestions) {
        const chip = el('button', 'suggestion', text);
        chip.type = 'button';
        chip.addEventListener('click', () => handlers.onSuggestion(text));
        chips.append(chip);
      }
      message.append(chips);
    }

    append(message);
  }

  function showThinking() {
    if (thinking) return;
    thinking = el('div', 'msg msg--assistant msg--thinking');
    thinking.append(el('div', 'bubble', 'Думаю…'));
    append(thinking);
  }

  function hideThinking() {
    if (thinking) thinking.remove();
    thinking = null;
  }

  function clear() {
    hideThinking();
    container.replaceChildren();
    emptyState.hidden = false;
  }

  // ---------- Форма уточнения [бэкенд ждёт поля, а не текст] ----------

  const FIELDS = {
    time: [['time', 'Время', 'time']],
    date: [['date', 'Дата', 'date']],
    datetime: [['date', 'Дата', 'date'], ['time', 'Время', 'time']],
    title: [['title', 'Что добавить', 'text']],
  };

  function renderForm(response, interactive) {
    const flow = response.flow;
    const expects = (response.data && response.data.expects) || 'time';
    const form = el('form', 'flow-form');
    for (const [name, label, type] of FIELDS[expects] || FIELDS.time) {
      const field = el('label', 'flow-form__field');
      field.append(el('span', null, label));
      const input = el('input');
      input.type = type;
      input.name = name;
      input.required = true;
      input.disabled = !interactive;
      if (name === 'date' && response.data && response.data.draft && response.data.draft.date_hint) input.value = response.data.draft.date_hint;
      field.append(input);
      form.append(field);
    }
    const submit = el('button', 'option', 'Ответить');
    submit.type = 'submit';
    submit.disabled = !interactive;
    const cancel = el('button', 'option option--quiet', 'Отмена');
    cancel.type = 'button';
    cancel.disabled = !interactive;
    cancel.addEventListener('click', () => handlers.onFlowCancel(flow));
    form.append(submit, cancel);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const fields = Object.fromEntries(new FormData(form).entries());
      handlers.onFlowAnswer(flow, fields);
    });
    return form;
  }

  // ---------- Тело ответа по типу ----------

  function renderBody(response) {
    const items = response.items || [];
    const data = response.data || {};
    switch (response.type) {
      case 'done':
        return renderDone(items, data);
      case 'clarify':
        return data.draft ? cards([data.draft], { draft: true }) : null;
      case 'choose':
        return cards(items, { numbered: true });
      case 'conflict': {
        const box = el('div', 'stack');
        if (items.length) box.append(cards(items));
        if (data.draft) {
          box.append(el('div', 'note', 'Новая встреча:'));
          box.append(cards([data.draft], { draft: true }));
        }
        return box;
      }
      case 'results':
        return renderResults(items, data);
      default:
        return items.length ? cards(items) : null;
    }
  }

  function renderDone(items, data) {
    const box = el('div', 'stack');
    const removed = new Set();
    for (const action of data.actions || []) {
      if (action.action === 'deleted') removed.add(action.item_id);
      if (action.action !== 'updated' || !action.after) continue;
      const rows = describeChanges(action.before, action.after);
      if (!rows.length) continue;
      const diff = el('div', 'diff');
      for (const row of rows) {
        const line = el('div', 'diff__row');
        line.append(el('span', null, `${row.label}: `), el('s', null, row.from), ' → ', el('strong', null, row.to));
        diff.append(line);
      }
      box.append(diff);
    }
    if (items.length) box.append(cards(items, { flash: true, removed }));
    return box.childElementCount ? box : null;
  }

  function renderResults(items, data) {
    const box = el('div', 'stack');
    if (data.kind === 'list' && items.length) {
      const fromKey = data.from ? dayKey(data.from) : null;
      const toKey = data.to ? dayKey(data.to) : null;
      const groups = groupByDay(items, fromKey, toKey);
      const singleDay = fromKey && toKey === addDays(fromKey, 1);
      for (const group of groups) {
        if (!singleDay || groups.length > 1) box.append(el('div', 'group-title', group.key ? dayTitle(group.key) : 'Без срока'));
        box.append(cards(group.items));
      }
    } else if (items.length) {
      box.append(cards(items, { numbered: data.kind === 'search' && items.length > 1 }));
    }
    if (data.overdue && data.overdue.length) {
      box.append(el('div', 'group-title group-title--danger', 'Просроченные'));
      box.append(cards(data.overdue));
    }
    return box.childElementCount ? box : null;
  }

  function cards(items, { numbered = false, draft = false, flash = false, removed = new Set() } = {}) {
    const list = el('div', 'cards');
    items.forEach((item, index) => {
      const number = numbered ? (item.number != null ? item.number : index + 1) : null;
      list.append(card(item, { number, draft, flash, removed: removed.has(item.id) }));
    });
    return list;
  }

  function card(item, { number, draft, flash, removed }) {
    const clickable = !draft && !removed && item.id;
    const node = el(clickable ? 'button' : 'div', `card card--${item.type || 'task'}`);
    if (clickable) {
      node.type = 'button';
      node.title = 'Выбрать запись: следующая команда будет про неё';
      node.addEventListener('click', () => handlers.onItem(item));
    }
    if (draft) node.classList.add('card--draft');
    if (removed) node.classList.add('is-removed');
    if (flash && !removed) node.classList.add('is-flash');
    if (number != null) node.append(el('span', 'card__num', `${number}.`));

    const body = el('span', 'card__body');
    const title = el('span', 'card__title', item.title || 'Без названия');
    const status = statusLabel(item);
    if (status) title.append(el('span', `badge${item.computed && item.computed.overdue ? ' badge--overdue' : ''}`, status));
    body.append(title, el('span', 'card__meta', cardMeta(item, draft)));
    node.append(body);
    return node;
  }

  function cardMeta(item, draft) {
    let when = whenLabel(item);
    if (draft && !hasDate(item)) {
      when = item.date_hint ? `${formatDay(item.date_hint)}, время не указано` : 'дата и время не указаны';
    }
    const participants = item.participants && item.participants.length ? item.participants.join(', ') : null;
    return [TYPES[item.type] && TYPES[item.type].label, when, participants, item.location].filter(Boolean).join(' · ');
  }

  return { addUser, addAssistant, showThinking, hideThinking, clear };
}
