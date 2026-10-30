import * as api from './api.js';
import { createChat } from './chat.js';
import { CONFIG } from './config.js';
import { el, uuid } from './dom.js';
import { createPlanner } from './planner.js';
import { createRecent } from './recent.js';
import { configureClock, formatTime, now } from './time.js';
import { createRecognizer, recognitionSupported, speech } from './voice.js';

const $ = (id) => document.getElementById(id);

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
    onOption: (option) => send({ text: option.label, choice: { option_id: option.id } }),
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
  setBusy(true);
  speech.cancel();

  chat.addUser(clean, { voice: inputMode === 'voice' });
  chat.showThinking();

  const payload = {
    client_message_id: uuid(),
    session_id: state.sessionId,
    text: clean || null,
    input: inputMode,
    choice,
    context: { selected_item_id: state.selected ? state.selected.id : null },
  };
  setSelected(null);

  let response;
  try {
    response = await api.sendMessage(payload);
  } catch (error) {
    console.warn('Сообщение не дошло', error);
    response = localReply('error', 'Не получилось обработать запрос. Попробуйте ещё раз.', { code: 'network', retryable: true });
  }

  chat.hideThinking();
  const retryable = response.type === 'error' && response.data && response.data.retryable;
  chat.addAssistant(response, { onRetry: retryable ? () => send({ text: clean, choice, input: inputMode }) : null });
  say(response.speak || response.reply);
  if (response.type === 'done') refreshLists((response.items || []).map((item) => item.id));
  setBusy(false);
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

// ---------- Микрофон ----------

function toggleMic() {
  if (state.busy && !recognizer.listening) return;
  speech.cancel(); // новый запрос голосом прерывает озвучку [ФТ 3]
  recognizer.toggle();
}

function setListening(listening) {
  document.body.classList.toggle('is-listening', listening);
  micButton.classList.toggle('is-listening', listening);
  micButton.setAttribute('aria-label', listening ? 'Остановить запись' : 'Голосовой ввод');
  micHero.setAttribute('aria-label', listening ? 'Остановить запись' : 'Начать запись');
  $('mic-hint').textContent = listening ? 'Слушаю…' : recognitionSupported ? '' : 'Голосовой ввод недоступен в этом браузере — напишите текстом';
  input.placeholder = listening ? 'Слушаю…' : PLACEHOLDER;
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
    toast('Не получилось сохранить. Попробуйте ещё раз.');
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
    toast('Не получилось удалить. Попробуйте ещё раз.');
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
    entries.forEach((entry, index) => {
      if (entry.role === 'user') chat.addUser(entry.text || '');
      else chat.addAssistant(entry.response || localReply('info', entry.text), { interactive: index === entries.length - 1 });
    });
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
  refreshLists();
  await showMissedReminders();
  rememberVisit();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') rememberVisit();
  });
  api.subscribe({ reminder: onReminder, items_changed: () => refreshLists() });
}

init();
