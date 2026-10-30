import * as api from './api.js';
import { isCancel, parseAnswer, parseConfirmation } from './answer.js';
import { createChat } from './chat.js';
import { CONFIG } from './config.js';
import { el, uuid } from './dom.js';
import { createNotifier } from './notifications.js';
import { createPlanner } from './planner.js';
import { createRecent } from './recent.js';
import { createSettings, stripName } from './settings.js';
import { configureClock, formatDayMonth, formatTime, now } from './time.js';
import { createRecognizer, recognitionSupported, speech } from './voice.js';

const $ = (id) => document.getElementById(id);
// Создаётся в init(), когда известно серверное «сейчас»
let notifier = null;

const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // приватный режим — живём без сохранения
    }
  },
};

const PLACEHOLDER = 'Напишите сообщение';
const MIC_ERRORS = {
  unsupported: 'Этот браузер не поддерживает голосовой ввод. Напишите текстом или откройте страницу в Chrome.',
  denied: 'Нет доступа к микрофону. Разрешите доступ в настройках браузера или напишите текстом.',
  no_mic: 'Микрофон не найден. Подключите его или напишите текстом.',
  network: 'Распознавание речи не отвечает: нужен интернет и Google Chrome (в Chromium оно не работает). Напишите текстом.',
  unavailable: 'Голосовой ввод сейчас не работает. Напишите текстом.',
};

const state = {
  sessionId: store.get('session_id') || newSessionId(),
  selected: null,
  busy: false,
  // 'on' | 'off' — выбор пользователя. null — не выбирал: озвучка включается, если диалог начат голосом [ФТ 3]
  speakChoice: store.get('speak'),
  usedVoice: false,
  // Сценарий ждёт ответа пользователя: { ...flow бэкенда, reply } — см. backend/docs/dialogue-flow.md
  flow: null,
  listening: false,
};

const input = $('composer-input');
const micButton = $('mic-btn');
const micHero = $('mic-hero');
const sendButton = $('send-btn');
const speakToggle = $('speak-toggle');

const chat = createChat({
  container: $('messages'),
  scroller: $('chat'),
  emptyState: $('chat-empty'),
  handlers: {
    // Текст кнопки тоже отправляем: он попадает в историю и понятен серверу без choice
    // Подтверждение сценария бэкенда — через /answer; без flow (заглушка) — обычным сообщением
    onOption: (option, flow) => (flow
      ? runFlow(option.label, (f) => api.answerFlow(f, { confirmed: option.id === 'yes' }))
      : send({ text: option.label, choice: { option_id: option.id } })),
    onFlowAnswer: (flow, fields) => runFlow(describeFields(fields), (f) => api.answerFlow(f, fields)),
    onFlowCancel: () => runFlow('Отмена', api.cancelFlow),
    onSuggestion: (text) => send({ text }),
    onUndo: undoAction,
    onItem: toggleSelected,
  },
});

const planner = createPlanner({
  body: $('planner-body'),
  tabs: $('planner-tabs'),
  onSelect: toggleSelected,
  onToggleDone: markDone,
  onDelete: removeItem,
});

const recent = createRecent({
  list: $('recent-list'),
  heading: $('recent-heading'),
  search: $('recent-search'),
  filters: $('recent-filters'),
  onSelect: toggleSelected,
});

const recognizer = createRecognizer({
  onStart: () => setListening(true),
  onInterim: (text) => {
    input.value = text;
  },
  onResult: (text) => {
    input.value = '';
    state.usedVoice = true;
    syncSpeakToggle();
    send({ text, input: 'voice' });
  },
  onEmpty: () => {
    input.value = '';
    showLocal(localReply('error', 'Не расслышал, повторите, пожалуйста.', { code: 'empty_speech', retryable: false }));
  },
  onError: (kind) => showLocal(localReply('error', MIC_ERRORS[kind] || MIC_ERRORS.unavailable, { code: kind, retryable: false })),
  onEnd: () => setListening(false),
});

// ---------- Отправка сообщения ----------

async function send({ text, choice = null, input: inputMode = 'text' }) {
  const clean = text ? text.trim() : '';
  if (state.busy || (!clean && !choice)) return;
  // Бэкенд не принимает новых сообщений, пока сценарий ждёт ответа (409 conversation_busy)
  if (state.flow) return answerByText(clean, inputMode);
  setBusy(true);
  speech.cancel();

  chat.addUser(clean, { voice: inputMode === 'voice' });
  chat.showThinking();

  const payload = {
    client_message_id: uuid(),
    session_id: state.sessionId,
    // Обращение по имени («Джарвис, …») серверу не нужно: модель разбирает только команду
    text: clean ? stripName(clean, settings.name) : null,
    input: inputMode,
    choice,
    context: { selected_item_id: state.selected ? state.selected.id : null },
  };
  setSelected(null);

  const response = await api.sendMessage(payload).catch(failureReply);
  showReply(response, { text: clean, choice, input: inputMode });
}

/** Ответ ассистента в чат, озвучка, обновление списков. retry — что отправить снова при ошибке */
function showReply(response, retry = null) {
  chat.hideThinking();
  state.flow = response.flow ? { ...response.flow, reply: response } : null;
  syncComposer();
  const retryable = retry && response.type === 'error' && response.data && response.data.retryable;
  chat.addAssistant(response, { onRetry: retryable ? () => send(retry) : null });
  say(response.speak || response.reply);
  if (response.type === 'done') refreshLists((response.items || []).map((item) => item.id));
  setBusy(false);
}

// ---------- Ответы на вопросы ассистента ----------

/** «5 ноября, 17:00» — как реплика пользователя при отправке формы */
function describeFields(fields) {
  const parts = [];
  if (fields.date) parts.push(formatDayMonth(fields.date));
  if (fields.time) parts.push(fields.time);
  if (fields.title) parts.push(fields.title);
  return parts.join(', ');
}

/** Продолжение сценария: userText — реплика в чат, call(flow) — запрос к бэкенду */
async function runFlow(userText, call, { voice = false } = {}) {
  const flow = state.flow;
  if (state.busy || !flow) return;
  setBusy(true);
  speech.cancel();
  chat.addUser(userText, { voice });
  chat.showThinking();
  let response;
  try {
    response = await call(flow);
  } catch (error) {
    response = await flowFailure(error, flow);
  }
  showReply(response);
}

async function flowFailure(error, flow) {
  console.warn('Ответ на вопрос не принят', error);
  // Окно устарело или сценарий уже завершён: спрашиваем бэкенд, что сейчас
  if (error instanceof api.ApiError && error.status === 409 && ['stale_input', 'message_state'].includes(error.code)) {
    try {
      return await api.refreshFlow(flow);
    } catch (refreshError) {
      console.warn(refreshError);
    }
  }
  // Остальное (неверное поле, обрыв связи): вопрос остаётся, token тот же — можно отправить ещё раз
  const note = error instanceof api.ApiError && error.status === 400 ? error.message : 'Не получилось отправить ответ. Попробуйте ещё раз.';
  return { ...flow.reply, reply: `${note} ${flow.reply.reply}` };
}

/** Ответ словами или голосом на вопрос, ждущий формы */
function answerByText(text, inputMode) {
  const voice = inputMode === 'voice';
  const flow = state.flow;
  if (isCancel(text)) return runFlow(text, api.cancelFlow, { voice });
  if (flow.status === 'awaiting_confirmation') {
    const confirmed = parseConfirmation(text);
    if (confirmed === null) return toast('Ответьте «да» или «нет».');
    return runFlow(text, (f) => api.answerFlow(f, { confirmed }), { voice });
  }
  const fields = parseAnswer((flow.reply.data && flow.reply.data.expects) || 'time', text);
  if (!fields) return toast('Не получилось разобрать. Заполните поля выше или скажите, например: «завтра в 17».');
  return runFlow(text, (f) => api.answerFlow(f, fields), { voice });
}

/** Сообщение не дошло или ответ не получен — ответ-ошибка в формате /api/message */
function failureReply(error) {
  console.warn('Сообщение не обработано', error);
  // 409: conversation_busy — диалог ещё занят прошлым сообщением, idempotency_conflict — повтор id
  if (error instanceof api.ApiError && error.status === 409) {
    return localReply('error', error.message, { code: error.code, retryable: error.code === 'conversation_busy' });
  }
  return localReply('error', 'Не получилось обработать запрос. Попробуйте ещё раз.', { code: error.code || 'network', retryable: true });
}

/** Ответ, собранный на фронте, в формате /api/message — чтобы чат рисовал его как обычный */
function localReply(type, reply, data = {}, items = []) {
  return { type, reply, speak: null, items, options: [], data, undo_token: null, suggestions: [] };
}

function showLocal(response) {
  chat.addAssistant(response);
  say(response.reply);
}

function setBusy(busy) {
  state.busy = busy;
  sendButton.disabled = busy;
  if (!recognizer.listening) {
    micButton.disabled = busy;
    micHero.disabled = busy;
  }
}

// ---------- Озвучка ----------

function speakEnabled() {
  return state.speakChoice ? state.speakChoice === 'on' : state.usedVoice;
}

function syncSpeakToggle() {
  speakToggle.checked = speech.supported && speakEnabled();
  speakToggle.disabled = !speech.supported;
}

function say(text) {
  if (speakEnabled()) speech.speak(text);
}

speakToggle.addEventListener('change', () => {
  state.speakChoice = speakToggle.checked ? 'on' : 'off';
  store.set('speak', state.speakChoice);
  if (!speakToggle.checked) speech.cancel();
});

// ---------- Имя и голос ассистента ----------

const settings = createSettings({
  dialog: $('settings'),
  openButton: $('settings-btn'),
  form: $('settings-form'),
  nameInput: $('settings-name'),
  genderGroup: document.querySelector('#settings .choice'),
  previewButton: $('settings-preview'),
  note: $('settings-note'),
  onChange: ({ name }) => {
    $('assistant-name').textContent = name;
    document.title = `${name} — голосовой ассистент`;
  },
});

// ---------- Микрофон ----------

function toggleMic() {
  if (state.busy && !recognizer.listening) return;
  speech.cancel(); // новый запрос голосом прерывает озвучку [ФТ 3]
  recognizer.toggle();
}

function syncComposer() {
  let placeholder = PLACEHOLDER;
  if (state.listening) placeholder = 'Слушаю…';
  else if (state.flow) placeholder = state.flow.status === 'awaiting_confirmation' ? 'Ответьте «да» или «нет»' : 'Ответьте на вопрос или скажите «отмена»';
  input.placeholder = placeholder;
}

function setListening(listening) {
  state.listening = listening;
  document.body.classList.toggle('is-listening', listening);
  micButton.classList.toggle('is-listening', listening);
  micButton.setAttribute('aria-label', listening ? 'Остановить запись' : 'Голосовой ввод');
  micHero.setAttribute('aria-label', listening ? 'Остановить запись' : 'Начать запись');
  $('mic-hint').textContent = listening ? 'Слушаю…' : recognitionSupported ? '' : 'Голосовой ввод недоступен в этом браузере — напишите текстом';
  syncComposer();
}

micButton.addEventListener('click', toggleMic);
micHero.addEventListener('click', toggleMic);

// ---------- Ввод текста ----------

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (state.busy || !input.value.trim()) return;
  if (recognizer.listening) recognizer.cancel();
  const text = input.value;
  input.value = '';
  send({ text });
});

// ---------- Выбранная запись (контекст для «перенеси её») ----------

function toggleSelected(item) {
  setSelected(state.selected && state.selected.id === item.id ? null : item);
}

function setSelected(item) {
  state.selected = item ? { id: item.id, title: item.title } : null;
  $('selection').hidden = !item;
  $('selection-title').textContent = item ? item.title : '';
  planner.setSelected(item ? item.id : null);
  recent.setSelected(item ? item.id : null);
  if (item) input.focus();
}

$('selection-clear').addEventListener('click', () => setSelected(null));

// ---------- Ручные действия в списке (2.3) ----------

function refreshLists(flash = []) {
  planner.refresh({ flash });
  recent.refresh();
  if (notifier) notifier.refresh();
}

async function markDone(item) {
  try {
    await api.patchItem(item.id, { status: 'done' });
    refreshLists();
    toast(`Отмечено выполненным: ${item.title}`, {
      label: 'Вернуть',
      run: () => api.patchItem(item.id, { status: 'open' }).then(() => refreshLists([item.id])),
    });
  } catch (error) {
    console.warn(error);
    toast(error.code === 'not_implemented' ? 'Отметка выполнения пока не поддерживается бэкендом.' : 'Не получилось сохранить. Попробуйте ещё раз.');
  }
}

async function removeItem(item) {
  try {
    const result = await api.deleteItem(item.id);
    if (state.selected && state.selected.id === item.id) setSelected(null);
    refreshLists();
    const token = result && result.undo_token;
    toast(`Удалено: ${item.title}`, token ? { label: 'Отменить', run: () => api.undo(token).then(() => refreshLists([item.id])) } : null);
  } catch (error) {
    console.warn(error);
    toast(error.code === 'not_implemented' ? 'Удаление пока не поддерживается бэкендом.' : 'Не получилось удалить. Попробуйте ещё раз.');
  }
}

async function undoAction(token, button) {
  button.disabled = true;
  try {
    const response = await api.undo(token);
    if (response && response.reply) chat.addAssistant(response, { interactive: false });
    refreshLists();
  } catch (error) {
    console.warn(error);
    button.disabled = false;
    toast('Не получилось отменить. Попробуйте ещё раз.');
  }
}

function toast(text, action = null) {
  const node = el('div', 'toast');
  node.append(el('span', null, text));
  if (action) {
    const button = el('button', null, action.label);
    button.type = 'button';
    button.addEventListener('click', () => {
      node.remove();
      Promise.resolve(action.run()).catch(() => toast('Не получилось. Попробуйте ещё раз.'));
    });
    node.append(button);
  }
  $('toasts').append(node);
  setTimeout(() => node.remove(), 6000);
}

// ---------- Сессия и история ----------

function newSessionId() {
  const id = `s_${uuid()}`;
  store.set('session_id', id);
  return id;
}

$('new-dialog').addEventListener('click', async () => {
  speech.cancel();
  try {
    await api.resetSession(state.sessionId);
  } catch (error) {
    console.warn(error);
  }
  state.sessionId = newSessionId();
  state.flow = null;
  syncComposer();
  setSelected(null);
  chat.clear();
});

$('profile-btn').addEventListener('click', () => {
  toast('Вход и регистрация появятся позже. Сейчас вы работаете как гость.');
});

async function loadHistory() {
  try {
    const result = await api.getHistory(state.sessionId);
    const entries = Array.isArray(result) ? result : (result && result.history) || [];
    const pending = (result && result.pending_messages) || [];
    // Сценарий, ждущий ответа, бэкенд отдаёт и в истории (его вопрос), и в pending_messages (с токеном)
    const waiting = new Map(pending.filter((m) => m.status !== 'processing').map((m) => [m.message_id, m]));

    entries.forEach((entry, index) => {
      // Нажатие кнопки бэкенд хранит без текста — пустую реплику не показываем
      if (entry.role === 'user') {
        if (entry.text) chat.addUser(entry.text);
        return;
      }
      const flowMessage = waiting.get(entry.message_id);
      if (flowMessage) {
        const reply = api.replyFrom(flowMessage);
        chat.addAssistant(reply, { interactive: true });
        state.flow = reply.flow ? { ...reply.flow, reply } : null;
        syncComposer();
      } else {
        chat.addAssistant(entry.response || localReply('info', entry.text), { interactive: index === entries.length - 1 });
      }
    });

    // Страницу перезагрузили, пока ассистент думал: сообщение уже принято, дожидаемся ответа
    for (const message of pending.filter((m) => m.status === 'processing')) {
      setBusy(true);
      chat.showThinking();
      showReply(await api.waitForReply(message).catch(failureReply));
    }
  } catch (error) {
    console.warn('История не загрузилась', error);
  }
}

// ---------- Напоминания (2.5) ----------

function onReminder({ item, reply }) {
  const text = reply || `Напоминаю: ${item.title}.`;
  chat.addAssistant({ ...localReply('info', text, { reason: 'reminder' }, [item]), suggestions: ['Сделано', 'Напомни через 15 минут'] });
  beep();
  say(text);
}

// За 15 минут и в момент начала. Напоминание в момент срабатывания ведёт себя как событие сервера:
// реплика в чате, звук и озвучка. Если системное уведомление не показано, сообщаем на странице.
function onDue(item, kind, text, shown) {
  if (item.type === 'reminder' && kind === 'now') {
    onReminder({ item });
    return;
  }
  beep();
  if (!shown) toast(`${text.title}. ${text.body}`);
}

function offerNotifications() {
  if (!notifier.canAsk) return;
  toast('Показывать уведомления о встречах и напоминаниях?', {
    label: 'Включить',
    run: () => notifier.enable(),
  });
}

async function showMissedReminders() {
  const since = store.get('last_seen');
  if (!since) return;
  try {
    const result = await api.getMissedReminders(since);
    const items = Array.isArray(result) ? result : (result && result.items) || [];
    if (!items.length) return;
    const list = items.map((item) => `«${item.title}» в ${formatTime(item.remind_at)}`).join(', ');
    const noun = items.length === 1 ? 'напоминание' : 'напоминания';
    chat.addAssistant(localReply('info', `Пока вас не было: ${noun} ${list}.`, { reason: 'missed' }, items));
  } catch (error) {
    console.warn(error);
  }
}

function rememberVisit() {
  store.set('last_seen', now().toISOString());
}

function beep() {
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.4);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.4);
    oscillator.onended = () => context.close();
  } catch {
    // звук не обязателен
  }
}

// ---------- Источник данных: бэкенд или заглушка ----------

const source = { backendAlive: null, mockRoutes: new Set() };

api.apiEvents.addEventListener('fallback', ({ detail }) => {
  if (detail.reason !== 'not_implemented') source.backendAlive = false;
  if (source.mockRoutes.has(detail.route)) return;
  source.mockRoutes.add(detail.route);
  console.info(`[api] ${detail.route} → заглушка (${detail.reason})`);
  renderSource();
});

function renderSource() {
  const badge = $('source-badge');
  const routes = [...source.mockRoutes].sort().join('\n');
  let text = null;
  let title = '';
  if (CONFIG.MODE === 'mock') {
    text = 'Заглушка';
    title = 'CONFIG.MODE = mock: все ответы даёт js/mock/';
  } else if (source.backendAlive === false) {
    text = 'Бэкенд не отвечает';
    title = CONFIG.MODE === 'auto' ? 'Ответы даёт заглушка js/mock/' : 'Запросы будут падать с ошибкой';
  } else if (source.mockRoutes.size) {
    text = `Бэкенд + заглушка (${source.mockRoutes.size})`;
    title = `Этих маршрутов в бэкенде пока нет, их отвечает заглушка:\n${routes}`;
  }
  badge.hidden = !text;
  badge.textContent = text || '';
  badge.title = title;
  badge.classList.toggle('is-offline', source.backendAlive === false);
}

// ---------- Старт ----------

async function init() {
  syncSpeakToggle();
  setListening(false);
  source.backendAlive = await api.checkHealth();
  renderSource();
  try {
    const me = await api.getMe();
    configureClock(me);
    $('profile-btn').title = me.login || 'Гость';
  } catch (error) {
    console.warn('Профиль не загрузился', error);
  }
  await loadHistory();
  notifier = createNotifier({
    loadItems: ({ from, to }) => api.getItems({ from, to, types: 'meeting,reminder' }),
    onDue,
    toggle: $('notify-toggle'),
    note: $('notify-note'),
  });
  // Разрешение могли поменять в настройках браузера, пока страница была открыта
  $('settings-btn').addEventListener('click', () => notifier.render());
  refreshLists();
  offerNotifications();
  await showMissedReminders();
  rememberVisit();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') rememberVisit();
  });
  api.subscribe({ reminder: onReminder, items_changed: () => refreshLists() });
}

init();
