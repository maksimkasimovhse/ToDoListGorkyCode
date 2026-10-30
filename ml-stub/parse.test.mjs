// Сценарии приёмки [ФТ 16] и примеры из contracts.md 3.4. «Сейчас» — четверг, 29 октября 2026, 12:00.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRequest } from './parse.mjs';

const NOW = '2026-10-29T12:00:00.123456789+03:00';
const parse = (text, extra = {}) => parseRequest({ text, now: NOW, timezone: 'Europe/Moscow', expects: null, ...extra });
const first = (text, extra) => parse(text, extra).actions[0];

test('1. напоминание завтра в 10 утра', () => {
  assert.deepEqual(first('Напомни мне завтра в 10 утра позвонить Ивану'), {
    intent: 'create_reminder',
    params: { date: '2026-10-30', time: '10:00', title: 'позвонить Ивану' },
  });
});

test('2. задача в пятницу без времени', () => {
  const { intent, params } = first('В пятницу нужно отправить отчёт');
  assert.equal(intent, 'create_task');
  assert.equal(params.title, 'отправить отчёт');
  assert.equal(params.date, '2026-10-30');
  assert.equal(params.time, null);
});

test('3. задача до конца недели — период', () => {
  const { intent, params } = first('Поставь задачу купить билеты до конца недели');
  assert.equal(intent, 'create_task');
  assert.equal(params.title, 'купить билеты');
  assert.equal(params.period, 'this_week');
  assert.equal(params.date, null);
});

test('4. встреча с командой завтра в 15:00', () => {
  const { intent, params } = first('Добавь встречу с командой завтра в 15:00');
  assert.equal(intent, 'create_meeting');
  assert.equal(params.title, 'Встреча с командой');
  assert.deepEqual(params.participants, ['команда']);
  assert.equal(params.date, '2026-10-30');
  assert.equal(params.time, '15:00');
});

test('5. «в четверг в 11», когда сегодня четверг после 11, — следующая неделя', () => {
  const { params } = first('В четверг в 11 у меня встреча с дизайнером');
  assert.equal(params.date, '2026-11-05');
  assert.equal(params.time, '11:00');
});

test('6. встреча без времени — уточнение, затем ответ «В 17»', () => {
  const result = parse('Поставь встречу с Иваном завтра');
  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missing, ['time']);
  assert.equal(result.actions[0].params.date, '2026-10-30');

  const answer = parse('В 17', { expects: 'time' });
  assert.deepEqual(answer.actions, [{ intent: 'answer', params: { value: { time: '17:00' } } }]);
});

test('7–8. список на завтра, только встречи', () => {
  for (const text of ['Что у меня завтра?', 'Какие планы на завтра?']) {
    const { intent, params } = first(text);
    assert.equal(intent, 'list');
    assert.equal(params.from, '2026-10-30T00:00:00+03:00');
    assert.equal(params.to, '2026-10-31T00:00:00+03:00');
    assert.equal(params.types, null);
  }
  assert.deepEqual(first('Покажи мои встречи на завтра').params.types, ['meeting']);
});

test('9. вопрос да/нет', () => {
  const { params } = first('Есть ли у меня встречи сегодня?');
  assert.equal(params.yes_no, true);
  assert.deepEqual(params.types, ['meeting']);
  assert.equal(params.from, '2026-10-29T00:00:00+03:00');
});

test('10. эта неделя — с текущего момента до понедельника', () => {
  const { params } = first('Что запланировано на эту неделю?');
  assert.equal(params.from, '2026-10-29T12:00:00+03:00');
  assert.equal(params.to, '2026-11-02T00:00:00+03:00');
});

test('12. через два часа', () => {
  const { intent, params } = first('Напомни через два часа проверить почту');
  assert.equal(intent, 'create_reminder');
  assert.equal(params.title, 'проверить почту');
  assert.equal(params.date, '2026-10-29');
  assert.equal(params.time, '14:00');
});

test('13. на следующей неделе — период задачи', () => {
  const { intent, params } = first('На следующей неделе нужно сдать курсовую');
  assert.equal(intent, 'create_task');
  assert.equal(params.title, 'сдать курсовую');
  assert.equal(params.period, 'next_week');
});

test('14. напоминание без времени, затем «Отмена»', () => {
  const result = parse('Напомни позвонить маме');
  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.missing, ['date', 'time']);
  assert.equal(first('Отмена', { expects: 'date' }).intent, 'cancel');
});

test('15–17. поиск: тема, морфология, участник и направление', () => {
  assert.equal(first('Найди задачу про презентацию').params.query, 'презентац');
  assert.equal(first('Я когда-то ставил задачу по договору, найди её').params.query, 'догово');
  const { params } = first('Когда у меня была встреча с Иваном?');
  assert.equal(params.participant, 'иван'); // бэкенд сравнивает без учёта регистра
  assert.equal(params.direction, 'past');
  assert.deepEqual(params.types, ['meeting']);
});

test('18. перенос и «сдвинь её на час позже»', () => {
  assert.equal(first('Перенеси встречу с командой на послезавтра').params.changes.date, '2026-10-31');
  const { intent, params } = first('А сдвинь её на час позже');
  assert.equal(intent, 'update');
  assert.deepEqual(params.target, { ref: 'focus' });
  assert.equal(params.changes.shift_min, 60);
});

test('19–20. выполнение и удаление', () => {
  const done = first('Я позвонил Ивану');
  assert.equal(done.intent, 'complete');
  assert.equal(done.params.done, true);
  assert.equal(first('Удали встречу с дизайнером').intent, 'delete');
});

test('подтверждение да/нет — словом и кнопкой', () => {
  assert.deepEqual(first('Да', { expects: 'yes_no' }), { intent: 'answer', params: { value: true } });
  assert.deepEqual(first(null, { expects: 'yes_no', choice: { option_id: 'no' } }), { intent: 'answer', params: { value: false } });
  // «Что в ней?» не подтверждение [ФТ 11]
  assert.notEqual(first('Удали вторую', { expects: 'yes_no' }).intent, 'answer');
});

test('22. вне темы', () => {
  assert.equal(parse('Какая погода?').status, 'not_understood');
});

test('несколько созданий в одной фразе', () => {
  const result = parse('Добавь встречу с Иваном в 15 и напомни купить хлеб вечером');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.actions.map((a) => a.intent), ['create_meeting', 'create_reminder']);
  assert.equal(result.actions[1].params.time, '19:00');
});

test('напомни про встречу — встреча с напоминанием за 15 минут', () => {
  const { intent, params } = first('Напомни про встречу с Иваном в 15');
  assert.equal(intent, 'create_meeting');
  assert.equal(params.remind_before_min, 15);
});

test('«создай напоминание …» — служебные слова не попадают в название', () => {
  assert.equal(first('Создай напоминание чтобы сходить к бабушке завтра в 12').params.title, 'сходить к бабушке');
  assert.equal(first('Создай напоминание на 16:33 съесть пирожное').params.title, 'съесть пирожное');
});

test('цель «я позвонил Ивану» ищется по основе слова, а не по всей фразе', () => {
  const done = first('Я позвонил Ивану');
  assert.equal(done.params.target.ref, 'filter');
  // Имя точнее глагола: «позвон» подошло бы ко всем «позвонить …»
  assert.equal(done.params.target.query, 'иван');
  assert.equal(first('я позвонил').params.target.query, 'позвон');
});

test('основа слова сохраняет «ё» из исходной фразы', () => {
  assert.equal(first('Отметь отчёт сделанным').params.target.query, 'отчё'); // «е» вместо «ё» не нашло бы «отчёт»
});

test('«верни смету в работу» — вернуть выполненную в работу', () => {
  const { intent, params } = first('Верни смету в работу');
  assert.equal(intent, 'complete');
  assert.equal(params.done, false);
  assert.equal(params.target.query, 'смет');
  assert.equal(first('Верни в работу').params.done, false);
});
