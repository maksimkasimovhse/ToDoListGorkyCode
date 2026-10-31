// Настройки ассистента: имя и голос озвучки. Хранятся в браузере — на бэкенде профиля пока нет.
import { el } from './dom.js';
import { pickVoice, speech } from './voice.js';

const KEY = 'assistant_settings';
export const DEFAULTS = { name: 'Ассистент', gender: 'female' };

export function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // приватный режим — настройки живут до перезагрузки
  }
}

/** «Джарвис, что у меня завтра?» → «что у меня завтра?». Одно имя без команды не трогаем */
export function stripName(text, name) {
  const clean = (name || '').trim();
  if (clean.length < 2) return text;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]');
  const rest = text.replace(new RegExp(`^(?:эй,?\\s+)?${escaped}(?:[\\s,!:.—-]+|$)`, 'i'), '');
  return rest.trim() ? rest : text;
}

/**
 * Окно настроек. elements — узлы из index.html, onChange(settings) — после каждого изменения.
 */
export function createSettings({ dialog, openButton, form, nameInput, genderGroup, previewButton, note, onChange }) {
  let settings = loadSettings();

  function apply() {
    speech.configure({ gender: settings.gender });
    onChange(settings);
  }

  function update(changes) {
    settings = { ...settings, ...changes };
    saveSettings(settings);
    apply();
    render();
  }

  function render() {
    nameInput.value = settings.name;
    for (const radio of genderGroup.querySelectorAll('input')) radio.checked = radio.value === settings.gender;

    const { voice } = pickVoice(settings.gender);
    if (!speech.supported) note.textContent = 'Этот браузер не умеет озвучивать текст.';
    else if (!voice) note.textContent = 'Браузер не нашёл русских голосов. Ответы будут читаться голосом по умолчанию.';
    else note.textContent = '';
  }

  openButton.addEventListener('click', () => {
    render();
    dialog.showModal();
    nameInput.focus();
  });

  nameInput.addEventListener('change', () => update({ name: nameInput.value.trim() || DEFAULTS.name }));
  genderGroup.addEventListener('change', (event) => update({ gender: event.target.value }));
  previewButton.addEventListener('click', () => speech.speak(`Привет! Я ${settings.name}. Чем могу помочь?`));
  form.addEventListener('submit', () => {
    // Enter в поле имени закрывает окно — имя должно сохраниться и тогда
    if (nameInput.value.trim() !== settings.name) update({ name: nameInput.value.trim() || DEFAULTS.name });
  });
  speech.onVoicesChanged(() => {
    if (dialog.open) render();
  });

  apply();
  return {
    get name() {
      return settings.name;
    },
  };
}
