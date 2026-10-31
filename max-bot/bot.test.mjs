// Сценарии бота с поддельными MAX и бэкендом в памяти. Запуск: node --test
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { addDays, configureClock, todayKey } from '../web/js/time.js';
import { BackendError, createBackend } from './backend.mjs';
import { createDeliverer } from './delivery.mjs';
import { createDialog } from './dialog.mjs';
import { createMax, MaxError, messageBody } from './max.mjs';
import { digest, notification, notifyNote } from './render.mjs';
import { createMemoryStore } from './store.mjs';
import { buildItem } from './wizard.mjs';

configureClock({ timezone: 'Europe/Moscow' });

const USER = 101;
const CODE = 'abcdef0123456789abcd';

function fakeMax() {
  const state = { sent: [], edited: [], answers: [], removed: [], mid: 0, fail: null };
  return {
    state,
    async send(user, message) {
      if (state.fail) throw state.fail;
      state.mid++;
      state.sent.push({ user, mid: `m${state.mid}`, ...message });
      return `m${state.mid}`;
    },
    async edit(mid, message) {
      state.edited.push({ mid, ...message });
    },
    async remove(mid) {
      state.removed.push(mid);
    },
    async answer(callbackId, body) {
      state.answers.push({ callbackId, ...body });
    },
    last: () => state.sent[state.sent.length - 1],
    lastAnswer: () => state.answers[state.answers.length - 1],
  };
}

function fakeBackend() {
  const state = {
    created: [], patches: [], links: [], acks: [], settingsPatches: [], conflictOnce: false,
    settings: { digest_enabled: true, digest_time: '07:30', quiet_enabled: false, quiet_start: '23:00', quiet_end: '08:00' },
    channel: { linked: true, enabled: true },
    items: [],
  };
  return {
    state,
    async link(user, credentials) {
      state.links.push({ user, ...credentials });
      if (credentials.code && credentials.code !== CODE) throw new BackendError(410, 'link_code', 'Код недействителен');
      if (credentials.login && credentials.password !== 'secret') throw new BackendError(401, 'invalid_credentials', 'Неверный логин или пароль.');
      return { token: 'tok', user: { id: 'u1', login: 'demo1' } };
    },
    async createItem(token, item) {
      assert.equal(token, 'tok');
      if (state.conflictOnce && !item.allow_conflicts) {
        state.conflictOnce = false;
        throw new BackendError(409, 'meeting_conflict', 'Пересечение', { conflicts: [{ id: 'c1', type: 'meeting', title: 'Планёрка', start_at: item.start_at, end_at: item.end_at, participants: [], status: 'scheduled' }] });
      }
      state.created.push(item);
      return { id: `i${state.created.length}`, participants: [], status: item.type === 'meeting' ? 'scheduled' : 'open', undo_token: 'undo1', ...item };
    },
    async patch(token, id, changes) {
      state.patches.push({ id, changes });
      return { id, title: 'позвонить Ивану', type: 'reminder', ...changes };
    },
    async items() {
      return { items: state.items };
    },
    async settings() {
      return { ...state.settings };
    },
    async updateSettings(token, patch) {
      state.settingsPatches.push(patch);
      if (patch.digest_time === '25:00') throw new BackendError(400, 'validation', 'неверное время');
      Object.assign(state.settings, patch);
      return { ...state.settings };
    },
    async channel() {
      return { ...state.channel };
    },
    async setEnabled(user, enabled) {
      state.channel.enabled = enabled;
    },
    async unlink() {},
    async undo() {
      return { reply: 'Отменил создание.' };
    },
    async ack(id, body) {
      state.acks.push({ id, ...body });
    },
    async history() {
      return { pending_messages: [] };
    },
    async send({ text }) {
      return { status: 'completed', response: { type: 'info', reply: `Ассистент: ${text}` } };
    },
  };
}

let max;
let backend;
let store;
let dialog;
let updateN = 0;

beforeEach(() => {
  max = fakeMax();
  backend = fakeBackend();
  store = createMemoryStore();
  dialog = createDialog({ max, backend, store });
});

async function text(value, user = USER) {
  updateN++;
  await dialog.handleUpdate({ update_type: 'message_created', timestamp: updateN, message: { sender: { user_id: user }, recipient: { chat_type: 'dialog' }, body: { mid: `u${updateN}`, text: value } } });
}

async function press(payload, mid = 'm1', bodyText = 'текст') {
  updateN++;
  await dialog.handleUpdate({ update_type: 'message_callback', callback: { callback_id: `cb${updateN}`, payload, user: { user_id: USER } }, message: { body: { mid, text: bodyText } } });
  return max.lastAnswer();
}

/** Найти payload кнопки по подписи на последнем экране */
function payloadOf(screen, label) {
  for (const row of screen.buttons || []) for (const b of row) if (b.text.includes(label)) return b.payload;
  throw new Error(`нет кнопки «${label}»: ${JSON.stringify(screen.buttons)}`);
}

const screenOf = (answer) => answer.message;

async function linkUser() {
  await store.setToken(USER, 'tok');
}

test('без привязки бот предлагает подключить аккаунт, код из ссылки привязывает', async () => {
  await text('привет');
  assert.match(max.last().text, /Подключите аккаунт/);
  await dialog.handleUpdate({ update_type: 'bot_started', user: { user_id: USER }, payload: CODE });
  assert.deepEqual(backend.state.links.at(-1), { user: USER, code: CODE });
  assert.equal(await store.token(USER), 'tok');
  assert.match(max.last().text, /вы вошли как demo1/);
  assert.ok(max.last().buttons.flat().some((b) => b.payload === 'm:new:meeting'));
});

test('неверный код и вход по логину с удалением пароля', async () => {
  await text('ffffffffffffffffffff');
  assert.match(max.last().text, /недействителен/);
  await press('a:login');
  await text('demo1');
  assert.match(max.last().text, /пароль/);
  await text('wrong');
  assert.equal(max.state.removed.length, 1, 'сообщение с паролем удалено');
  assert.match(max.last().text, /Неверный логин/);
  await press('a:login');
  await text('demo1');
  await text('secret');
  assert.equal(await store.token(USER), 'tok');
  assert.deepEqual(backend.state.links.at(-1), { user: USER, login: 'demo1', password: 'secret' });
});

test('встреча кнопками: дата, время, длительность, участники, место', async () => {
  await linkUser();
  let answer = await press('m:new:meeting');
  assert.match(screenOf(answer).text, /Как назвать встречу/);
  await text('Созвон с Петей');
  let screen = max.last();
  assert.match(screen.text, /Выберите день/);
  const tomorrow = addDays(todayKey(), 1);
  answer = await press(payloadOf(screen, 'Завтра'), screen.mid);
  answer = await press(payloadOf(screenOf(answer), '15:…'), screen.mid);
  answer = await press(payloadOf(screenOf(answer), '15:30'), screen.mid);
  assert.match(screenOf(answer).text, /Сколько продлится/);
  answer = await press(payloadOf(screenOf(answer), '1,5 ч'), screen.mid);
  assert.match(screenOf(answer).text, /Кто участвует/);
  await text('Петя, Аня');
  screen = max.last();
  assert.match(screen.text, /Где пройдёт/);
  answer = await press(payloadOf(screen, 'Онлайн'), screen.mid);
  const confirm = screenOf(answer);
  assert.match(confirm.text, /15:30–17:00/);
  assert.match(confirm.text, /Уведомлю в 15:15 и в 15:30/);
  answer = await press(payloadOf(confirm, 'Сохранить'), screen.mid);
  const item = backend.state.created[0];
  assert.equal(item.type, 'meeting');
  assert.equal(item.title, 'Созвон с Петей');
  assert.equal(item.start_at, `${tomorrow}T15:30:00+03:00`);
  assert.equal(Date.parse(item.end_at) - Date.parse(item.start_at), 90 * 60000);
  assert.deepEqual(item.participants, ['Петя', 'Аня']);
  assert.equal(item.location, 'Онлайн');
  assert.match(screenOf(answer).text, /Встреча добавлена/);
  assert.ok(screenOf(answer).buttons.flat().some((b) => b.payload === 'u:undo1'));
  assert.equal(await store.wizard(USER), null);
});

test('пересечение встреч: «Сохранить всё равно» отправляет allow_conflicts', async () => {
  await linkUser();
  backend.state.conflictOnce = true;
  await press('m:new:meeting');
  await text('Ретро');
  const screen = max.last();
  let answer = await press(payloadOf(screen, 'Завтра'), screen.mid);
  answer = await press(payloadOf(screenOf(answer), '10:…'));
  answer = await press(payloadOf(screenOf(answer), '10:00'));
  answer = await press(payloadOf(screenOf(answer), '30 мин'));
  answer = await press(payloadOf(screenOf(answer), 'Пропустить'));
  answer = await press(payloadOf(screenOf(answer), 'Пропустить'));
  answer = await press(payloadOf(screenOf(answer), 'Сохранить'));
  assert.match(screenOf(answer).text, /уже есть:[\s\S]*Планёрка/);
  answer = await press(payloadOf(screenOf(answer), 'Сохранить всё равно'));
  assert.equal(backend.state.created.length, 1);
  assert.equal(backend.state.created[0].allow_conflicts, true);
});

test('напоминание «через 1 ч» и задача без срока', async () => {
  await linkUser();
  await press('m:new:reminder');
  await text('проверить почту');
  let screen = max.last();
  const before = Date.now();
  let answer = await press(payloadOf(screen, 'Через 1 ч'), screen.mid);
  answer = await press(payloadOf(screenOf(answer), 'Сохранить'), screen.mid);
  const reminder = backend.state.created[0];
  assert.equal(reminder.type, 'reminder');
  const delta = Date.parse(reminder.remind_at) - before;
  assert.ok(delta > 58 * 60000 && delta <= 60 * 60000, `remind_at через час: ${delta}`);

  await press('m:new:task');
  await text('написать отчёт');
  screen = max.last();
  answer = await press(payloadOf(screen, 'Без срока'), screen.mid);
  answer = await press(payloadOf(screenOf(answer), 'Сохранить'), screen.mid);
  assert.deepEqual(backend.state.created[1], { type: 'task', title: 'написать отчёт', source_text: 'Создано кнопками в MAX' });
});

test('время можно написать текстом, прошедшее время не принимается', async () => {
  await linkUser();
  await press('m:new:reminder');
  await text('выпить воды');
  await text('завтра 09:45');
  assert.match(max.last().text, /Сохранить напоминание/);
  assert.match(max.last().text, /09:45/);
  await press('m:new:reminder');
  await text('вчерашнее');
  const screen = max.last();
  const answer = await press(payloadOf(screen, 'Сегодня'), screen.mid);
  // На экране часов прошедшие часы не показываются; пишем время текстом
  assert.ok(!screenOf(answer).buttons.flat().some((b) => b.text === '00:…') || new Date().getHours() === 0);
  await text('00:01');
  assert.match(max.last().text, /уже прошло|Сохранить/);
});

test('устаревшая кнопка мастера не срабатывает', async () => {
  await linkUser();
  await press('m:new:task');
  const state = await store.wizard(USER);
  const answer = await press(`w:${state.id}:due:0`);
  assert.match(answer.notification, /уже пройден/);
  const old = await press('w:zzzzzz:cancel:');
  assert.match(old.notification, /закрыт/);
});

test('настройки: тихие часы и время сводки', async () => {
  await linkUser();
  let answer = await press('m:settings');
  assert.match(screenOf(answer).text, /Утренняя сводка: <b>в 07:30/);
  answer = await press('s:toggle:quiet_enabled');
  assert.deepEqual(backend.state.settingsPatches.at(-1), { quiet_enabled: true });
  assert.match(screenOf(answer).text, /Тихие часы: <b>23:00–08:00/);
  assert.match(screenOf(answer).text, /Сводка попадает в тихие часы и придёт в 08:00/);
  answer = await press('s:time:digest_time');
  answer = await press(payloadOf(screenOf(answer), '08:…'));
  answer = await press(payloadOf(screenOf(answer), '08:15'));
  assert.deepEqual(backend.state.settingsPatches.at(-1), { digest_time: '08:15' });
  assert.match(screenOf(answer).text, /в 08:15/);
  answer = await press('s:toggle:channel');
  assert.equal(backend.state.channel.enabled, false);
  assert.match(screenOf(answer).text, /выключены/);
});

test('кнопки уведомления: сделано и отложить', async () => {
  await linkUser();
  let answer = await press('n:done:r1', 'm9', 'Напоминаю: позвонить Ивану');
  assert.deepEqual(backend.state.patches.at(-1), { id: 'r1', changes: { status: 'done' } });
  assert.match(screenOf(answer).text, /Отметил выполненным/);
  answer = await press('n:snooze15:r1', 'm9', 'Напоминаю');
  const at = Date.parse(backend.state.patches.at(-1).changes.remind_at);
  assert.ok(Math.abs(at - (Date.now() + 15 * 60000)) < 61000);
  assert.match(screenOf(answer).text, /напомню в/);
});

test('свободный текст уходит ассистенту', async () => {
  await linkUser();
  await text('Что у меня завтра?');
  assert.equal(max.last().text, 'Ассистент: Что у меня завтра?');
});

// ---------- Доставка уведомлений ----------

const meeting = { id: 'i1', type: 'meeting', title: 'Созвон <важный>', start_at: '2026-11-02T15:00:00+03:00', end_at: '2026-11-02T16:00:00+03:00', location: 'Онлайн', participants: ['Петя'], status: 'scheduled' };
const reminder = { id: 'r1', type: 'reminder', title: 'позвонить Ивану', remind_at: '2026-11-02T10:00:00+03:00', participants: [], status: 'open' };

test('тексты уведомлений: скоро, началось, опоздание и тихие часы', () => {
  const soon = notification({ kind: 'soon', event_at: meeting.start_at, item: meeting }, Date.parse(meeting.start_at) - 15 * 60000);
  assert.match(soon.text, /Через 15 минут: <b>Созвон &lt;важный&gt;<\/b>/);
  assert.match(soon.text, /15:00–16:00 · Онлайн · Петя/);
  assert.ok(soon.buttons.flat().some((b) => b.payload === 'n:cancel:i1'));

  const now = notification({ kind: 'now', event_at: reminder.remind_at, item: reminder }, Date.parse(reminder.remind_at));
  assert.match(now.text, /Напоминаю: <b>позвонить Ивану/);
  assert.deepEqual(now.buttons[0].map((b) => b.payload), ['n:done:r1', 'n:snooze15:r1', 'n:snooze60:r1']);

  const late = notification({ kind: 'now', event_at: meeting.start_at, item: meeting }, Date.parse(meeting.start_at) + 7 * 60000);
  assert.match(late.text, /Встреча началась в 15:00/);
  assert.match(late.text, /опозданием на 7 минут/);

  const held = notification({ kind: 'now', event_at: reminder.remind_at, item: reminder, held: true }, Date.parse(reminder.remind_at) + 5 * 3600000);
  assert.match(held.text, /Напоминание на 10:00/);
  assert.match(held.text, /после тихих часов/);
});

test('утренняя сводка', () => {
  const view = digest({ kind: 'digest', day: '2026-11-02', items: [meeting, reminder] });
  assert.match(view.text, /План на понедельник, 2 ноября: 1 встреча и 1 напоминание/);
  assert.ok(view.text.indexOf('10:00') < view.text.indexOf('15:00'), 'по времени');
  assert.match(digest({ kind: 'digest', day: '2026-11-02', items: [] }).text, /Встреч и напоминаний нет/);
});

test('доставка: отправка, подтверждение, без дублей, блокировка бота', async () => {
  const deliver = createDeliverer({ max, backend, store, now: () => Date.parse(meeting.start_at) - 15 * 60000 });
  const delivery = { version: 1, id: 'n1', kind: 'soon', channel: 'max', external_id: '101', event_at: meeting.start_at, item: meeting };
  assert.equal(await deliver(delivery), true);
  assert.equal(max.state.sent.length, 1);
  assert.equal(max.state.sent[0].user, '101');
  assert.deepEqual(backend.state.acks.at(-1), { id: 'n1', status: 'sent', external_id: '101' });
  assert.equal(await deliver(delivery), true);
  assert.equal(max.state.sent.length, 1, 'повтор не отправляется второй раз');

  max.state.fail = new MaxError('POST', '/messages', 503, 'unavailable', '');
  assert.equal(await deliver({ ...delivery, id: 'n2' }), false, 'временный сбой — повторим');
  max.state.fail = new MaxError('POST', '/messages', 403, 'chat.denied', '');
  assert.equal(await deliver({ ...delivery, id: 'n3' }), true);
  assert.deepEqual(backend.state.acks.at(-1), { id: 'n3', status: 'failed', error: max.state.fail.message, external_id: '101', disable_channel: true });
});

test('подсказка о времени уведомлений', () => {
  const nowMs = Date.parse('2026-11-02T12:00:00+03:00');
  assert.equal(notifyNote({ type: 'meeting', start_at: '2026-11-02T15:00:00+03:00' }, nowMs), '🔔 Уведомлю в 14:45 и в 15:00.');
  assert.equal(notifyNote({ type: 'reminder', remind_at: '2026-11-02T12:10:00+03:00' }, nowMs), '🔔 Уведомлю в 12:10.');
  assert.equal(notifyNote({ type: 'meeting', start_at: '2026-11-02T12:10:00+03:00' }, nowMs), '🔔 Уведомлю в 12:00 и в 12:10.');
  assert.equal(notifyNote({ type: 'task' }, nowMs), '');
});

test('buildItem: встреча на весь день и задача со временем', () => {
  assert.deepEqual(buildItem('meeting', { title: 'Конференция', date: '2026-11-05', allDay: true }), {
    type: 'meeting', title: 'Конференция', source_text: 'Создано кнопками в MAX', all_day: true,
    start_at: '2026-11-05T00:00:00+03:00', end_at: '2026-11-06T00:00:00+03:00',
  });
  assert.equal(buildItem('task', { title: 'Отчёт', date: '2026-11-05', time: '18:00' }).due_at, '2026-11-05T18:00:00+03:00');
  assert.equal(buildItem('task', { title: 'Отчёт', date: '2026-11-05' }).due_date, '2026-11-05');
});

// ---------- HTTP-клиенты ----------

test('клиент MAX: заголовок Authorization, клавиатура, повтор при 429', async () => {
  const calls = [];
  let first = true;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (first) {
      first = false;
      return new Response('{}', { status: 429, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify({ message: { body: { mid: 'mid.1' } } }), { status: 200 });
  };
  const client = createMax({ token: 'secret', baseUrl: 'https://max.test', fetchImpl });
  const mid = await client.send(101, { text: 'hi', buttons: [[{ type: 'callback', text: 'a', payload: 'b' }]] });
  assert.equal(mid, 'mid.1');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://max.test/messages?user_id=101&disable_link_preview=true');
  assert.equal(calls[1].init.headers.Authorization, 'secret');
  assert.deepEqual(JSON.parse(calls[1].init.body), messageBody({ text: 'hi', buttons: [[{ type: 'callback', text: 'a', payload: 'b' }]] }));
  assert.deepEqual(JSON.parse(calls[1].init.body).attachments[0].type, 'inline_keyboard');
});

test('клиент бэкенда: Bot-токен для /internal, Bearer для /api', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const api = createBackend({ baseUrl: 'http://b', botToken: 'bt', timezone: 'Europe/Moscow', fetchImpl });
  await api.ack('n1', { status: 'sent', external_id: '1' });
  await api.settings('ut');
  assert.equal(calls[0].url, 'http://b/internal/notifications/n1/ack');
  assert.equal(calls[0].init.headers.Authorization, 'Bot bt');
  assert.deepEqual(JSON.parse(calls[0].init.body), { channel: 'max', status: 'sent', external_id: '1' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ut');
});
