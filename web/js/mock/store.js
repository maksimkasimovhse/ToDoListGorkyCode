// «База» заглушки в localStorage: записи, состояние сессий (contracts.md, раздел 4) и токены отмены.
import { uuid } from '../dom.js';
import { stamp, toIso } from './clock.js';

const KEY = 'voice-assistant-mock-db-v1';

export function blankItem(fields) {
  const item = {
    id: uuid(),
    user_id: 'u_demo',
    type: 'task',
    title: '',
    source_text: '',
    due_date: null,
    due_at: null,
    period_start: null,
    period_end: null,
    start_at: null,
    end_at: null,
    all_day: false,
    participants: [],
    location: null,
    remind_at: null,
    status: fields.type === 'meeting' ? 'scheduled' : 'open',
    recurrence: null,
    created_at: null,
    updated_at: null,
    completed_at: null,
    deleted_at: null,
    ...fields,
  };
  item.updated_at = item.updated_at || item.created_at;
  return item;
}

// Записи «из прошлого», нужные сценариям поиска 15–17 [ФТ 16]
function seed() {
  return {
    seq: 0,
    items: [
      blankItem({
        type: 'task',
        title: 'подготовить слайды к защите',
        source_text: 'Нужно подготовить слайды к защите',
        created_at: toIso('2026-10-10', '09:15'),
      }),
      blankItem({
        type: 'task',
        title: 'подписать договор аренды',
        source_text: 'Подписать договор аренды 12 октября',
        due_date: '2026-10-12',
        status: 'done',
        completed_at: toIso('2026-10-12', '18:00'),
        created_at: toIso('2026-10-05', '11:00'),
      }),
      blankItem({
        type: 'meeting',
        title: 'Встреча с Иваном',
        source_text: 'Встреча с Иваном 20 октября в 14:00',
        start_at: toIso('2026-10-20', '14:00'),
        end_at: toIso('2026-10-20', '15:00'),
        participants: ['Иван'],
        created_at: toIso('2026-10-15', '10:30'),
      }),
    ],
    sessions: {},
    undo: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    // нет localStorage — начинаем с чистой базы
  }
  return seed();
}

let db = load();

export function getDb() {
  return db;
}

export function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch {
    // не сохранилось — работаем в памяти
  }
}

export function resetDb() {
  db = seed();
  persist();
}

export function nextStamp() {
  db.seq += 1;
  return stamp(db.seq);
}

export function findItem(id) {
  return db.items.find((item) => item.id === id && !item.deleted_at) || null;
}

export function session(id) {
  if (!db.sessions[id]) {
    db.sessions[id] = {
      history: [],
      draft: null,
      expects: null,
      candidates: null,
      focus_id: null,
      pending: null,
      last_list: null,
      last_undo: null,
      processed: {},
    };
  }
  return db.sessions[id];
}

export function dropSession(id) {
  delete db.sessions[id];
}

export const clone = (value) => JSON.parse(JSON.stringify(value));

/** change: { snapshots: [копии записей до изменения], created: [id созданных] } → undo_token */
export function remember(change) {
  const token = `undo_${uuid().slice(0, 8)}`;
  db.undo[token] = change;
  return token;
}

export function applyUndo(token) {
  const change = db.undo[token];
  if (!change) return false;
  for (const snapshot of change.snapshots) {
    const index = db.items.findIndex((item) => item.id === snapshot.id);
    if (index >= 0) db.items[index] = snapshot;
  }
  for (const id of change.created) {
    const item = db.items.find((i) => i.id === id);
    if (item) item.deleted_at = nextStamp();
  }
  delete db.undo[token];
  return true;
}
