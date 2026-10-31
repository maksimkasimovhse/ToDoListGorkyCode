// Экран «Уведомления»: включение уведомлений в MAX, время утренней сводки и тихие часы.
// Payload: s:open, s:toggle:<поле>, s:time:<поле>, s:h:<поле>:<ЧЧ>, s:m:<поле>:<ЧЧ:ММ>.
import { button, hours, minutes } from './ui.mjs';

const FIELDS = {
  digest_time: 'Во сколько присылать утреннюю сводку?',
  quiet_start: 'Когда начинаются тихие часы?',
  quiet_end: 'Когда заканчиваются тихие часы?',
};

const toMinutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** Попадает ли время сводки в тихие часы: тогда она придёт в момент их окончания */
export function digestInQuiet(s) {
  if (!s.quiet_enabled) return false;
  const d = toMinutes(s.digest_time);
  const start = toMinutes(s.quiet_start);
  const end = toMinutes(s.quiet_end);
  return start < end ? d >= start && d < end : d >= start || d < end;
}

export function settingsScreen(settings, channel, notice) {
  const lines = ['<b>⚙️ Уведомления</b>', ''];
  lines.push(channel.enabled
    ? '🔔 Уведомления в MAX <b>включены</b>: за 15 минут до встречи или напоминания и в момент начала.'
    : '🔕 Уведомления в MAX <b>выключены</b>. Сводка и напоминания сюда не придут.');
  lines.push(`☀️ Утренняя сводка: ${settings.digest_enabled ? `<b>в ${settings.digest_time}</b>` : '<b>выключена</b>'}`);
  lines.push(`🌙 Тихие часы: ${settings.quiet_enabled ? `<b>${settings.quiet_start}–${settings.quiet_end}</b>` : '<b>выключены</b>'}`);
  if (settings.quiet_enabled) lines.push('<i>В тихие часы ничего не присылаю. Всё, что наступило за это время, придёт сразу после их окончания.</i>');
  if (settings.digest_enabled && digestInQuiet(settings)) lines.push(`<i>Сводка попадает в тихие часы и придёт в ${settings.quiet_end}.</i>`);
  if (notice) lines.push('', `<i>${notice}</i>`);
  const buttons = [
    [button(channel.enabled ? '🔕 Выключить уведомления' : '🔔 Включить уведомления', 's:toggle:channel')],
    [button(settings.digest_enabled ? '☀️ Выключить сводку' : '☀️ Включить сводку', 's:toggle:digest_enabled')],
  ];
  if (settings.digest_enabled) buttons[1].push(button(`🕖 ${settings.digest_time}`, 's:time:digest_time'));
  buttons.push([button(settings.quiet_enabled ? '🌙 Выключить тихие часы' : '🌙 Включить тихие часы', 's:toggle:quiet_enabled')]);
  if (settings.quiet_enabled) buttons.push([button(`С ${settings.quiet_start}`, 's:time:quiet_start'), button(`До ${settings.quiet_end}`, 's:time:quiet_end')]);
  buttons.push([button('☰ Меню', 'm:menu')]);
  return { text: lines.join('\n'), buttons };
}

export function hourScreen(field) {
  return { text: `<b>${FIELDS[field]}</b>\nВыберите час:`, buttons: [...hours(`s:h:${field}`), [button('‹ Назад', 's:open')]] };
}

export function minuteScreen(field, hour) {
  return { text: `<b>${FIELDS[field]}</b>\nУточните минуты:`, buttons: [...minutes(`s:m:${field}`, hour, { step: 15 }), [button('‹ Назад', `s:time:${field}`)]] };
}

export const isSettingsField = (field) => Object.hasOwn(FIELDS, field);
