// Заглушка бэкенда: те же пути и форматы, что в contracts.md, раздел 2, только в браузере.
// Подключается из js/api.js: в режиме mock на все запросы, в режиме auto — на маршруты, которых нет в бэкенде.
import { handleMessage, undoByToken } from './assistant.js';
import { NOW, TIMEZONE } from './clock.js';
import { listItems, overdueItems, present, searchItems, undatedTasks, alive } from './queries.js';
import { normalize } from './nlu.js';
import { clone, dropSession, findItem, getDb, nextStamp, persist, remember, resetDb, session } from './store.js';

const listeners = new Set();

export function subscribe(handlers) {
  listeners.add(handlers);
  return () => listeners.delete(handlers);
}

function emit(event, payload) {
  for (const handlers of listeners) if (handlers[event]) handlers[event](payload);
}

const ok = (body) => ({ status: 200, body });
const fail = (status, code, message) => ({ status, body: { error: { code, message } } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function handle(method, path, query = {}, body = null) {
  // Ответ «LLM» дольше, чтобы был виден индикатор «Думаю…»
  await sleep(path === '/api/message' ? 500 + Math.random() * 600 : 60 + Math.random() * 120);
  try {
    // Копия, чтобы фронт не мог случайно поменять «базу» по ссылке
    return clone(route(method, path, query, body));
  } catch (error) {
    console.error('[mock]', error);
    return fail(500, 'internal', 'Внутренняя ошибка заглушки');
  }
}

const EDITABLE = ['title', 'start_at', 'end_at', 'remind_at', 'due_date', 'due_at', 'status', 'participants', 'location', 'all_day'];

function route(method, path, query, body) {
  if (method === 'POST' && path === '/api/message') return ok(handleMessage(body || {}));

  if (method === 'GET' && path === '/api/me') {
    // now — предложение к контракту: чтобы фронт считал «сегодня» по часам сервера
    return ok({ id: 'u_demo', login: null, timezone: TIMEZONE, settings: { speak: false }, now: NOW });
  }

  if (method === 'GET' && path === '/api/items') return ok(listForApi(query));

  if (method === 'GET' && path === '/api/items/undated') {
    const items = undatedTasks();
    return ok({ items: items.map(present), total: items.length, overdue: [] });
  }

  if (method === 'GET' && path === '/api/items/search') {
    const words = normalize(query.q || '').split(' ').filter((word) => word.length > 1);
    const items = words.length ? searchItems({ words }).slice(0, Number(query.limit) || 5) : [];
    return ok({ items: items.map(present), total: items.length, overdue: [] });
  }

  const itemPath = /^\/api\/items\/([^/]+)$/.exec(path);
  if (itemPath) {
    const item = findItem(decodeURIComponent(itemPath[1]));
    if (!item) return fail(404, 'not_found', 'Запись не найдена');

    if (method === 'GET') return ok(present(item));

    if (method === 'PATCH') {
      const changes = Object.fromEntries(Object.entries(body || {}).filter(([key]) => EDITABLE.includes(key)));
      if (changes.status === 'done' && item.type === 'meeting') return fail(400, 'validation', 'Встречи не отмечаются выполненными');
      const at = nextStamp();
      if (changes.status === 'done') changes.completed_at = at;
      if (changes.status === 'open') changes.completed_at = null;
      Object.assign(item, changes, { updated_at: at });
      persist();
      return ok(present(item));
    }

    if (method === 'DELETE') {
      const token = remember({ snapshots: [clone(item)], created: [] });
      const at = nextStamp();
      Object.assign(item, { deleted_at: at, updated_at: at });
      persist();
      return ok({ undo_token: token });
    }
  }

  if (method === 'POST' && path === '/api/undo') {
    const response = undoByToken(body && body.undo_token);
    return response ? ok(response) : fail(404, 'not_found', 'Нечего отменять');
  }

  if (method === 'GET' && path === '/api/history') return ok({ history: session(query.session_id || 'default').history });

  if (method === 'POST' && path === '/api/session/reset') {
    dropSession(body && body.session_id);
    persist();
    return ok({ ok: true });
  }

  if (method === 'GET' && path === '/api/reminders/missed') return ok({ items: [] });

  return fail(404, 'not_found', `Нет метода ${method} ${path}`);
}

function listForApi(query) {
  const types = query.types ? query.types.split(',') : null;

  // [не в контракте] последние созданные записи для панели «Последнее»
  if (query.sort === '-created_at') {
    const items = alive()
      .filter((item) => !types || types.includes(item.type))
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    return { items: items.slice(0, Number(query.limit) || 20).map(present), total: items.length, overdue: [] };
  }

  const items = listItems({
    fromMs: query.from ? Date.parse(query.from) : -Infinity,
    toMs: query.to ? Date.parse(query.to) : Infinity,
    types,
    status: query.status || null,
  });
  const overdue = query.include_overdue === 'true' ? overdueItems().filter((item) => !items.includes(item)) : [];
  return { items: items.map(present), total: items.length, overdue: overdue.map(present) };
}

// Помощники для ручной проверки из консоли браузера
if (typeof window !== 'undefined') {
  window.__mock = {
    /** Сбросить данные заглушки к начальным и перезагрузить страницу */
    reset() {
      resetDb();
      localStorage.removeItem('session_id');
      location.reload();
    },
    /** Сымитировать срабатывание напоминания (по id или первое открытое) */
    fireReminder(id) {
      const item = id ? findItem(id) : alive().find((i) => i.type === 'reminder' && i.status === 'open');
      if (!item) return console.warn('[mock] Нет открытых напоминаний. Создайте: «Напомни завтра в 10 позвонить Ивану»');
      for (const s of Object.values(getDb().sessions)) s.focus_id = item.id; // напоминание становится фокусом [ФТ 12]
      persist();
      emit('reminder', { item: present(item), reply: `Напоминаю: ${item.title}.` });
      return item.title;
    },
    now: NOW,
  };
}
