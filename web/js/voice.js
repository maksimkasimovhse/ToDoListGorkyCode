// Голос в браузере: распознавание — Web Speech API (Chrome, Edge, Safari), озвучка — speechSynthesis.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const MAX_RECORDING_MS = 30000; // [ФТ 3]

export const recognitionSupported = Boolean(Recognition);

/**
 * onStart(), onInterim(text), onResult(text), onEmpty(), onError(kind), onEnd()
 * kind: 'unsupported' | 'denied' | 'no_mic' | 'unavailable'
 */
export function createRecognizer({ onStart, onInterim, onResult, onEmpty, onError, onEnd }) {
  let recognition = null;
  let finalText = '';
  let interimText = '';
  let failed = false;
  let aborted = false;
  let timer = null;

  function start() {
    if (!Recognition) {
      onError('unsupported');
      return;
    }
    if (recognition) return;
    finalText = '';
    interimText = '';
    failed = false;
    aborted = false;

    recognition = new Recognition();
    recognition.lang = 'ru-RU';
    recognition.interimResults = true;
    // Без continuous браузер сам заканчивает запись после паузы в речи
    recognition.continuous = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => onStart();
    recognition.onresult = (event) => {
      interimText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0].transcript;
        else interimText += result[0].transcript;
      }
      onInterim(`${finalText}${interimText}`.trim());
    };
    recognition.onerror = (event) => {
      console.warn('[voice] ошибка распознавания:', event.error, event.message || '');
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      failed = true;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') onError('denied');
      else if (event.error === 'audio-capture') onError('no_mic');
      // Chrome распознаёт речь на серверах Google; в Chromium без ключей Google тоже приходит network
      else if (event.error === 'network') onError('network');
      else onError('unavailable');
    };
    recognition.onend = () => {
      clearTimeout(timer);
      recognition = null;
      onEnd();
      if (failed || aborted) return;
      const text = (finalText || interimText).trim();
      if (text) onResult(text);
      else onEmpty();
    };

    try {
      recognition.start();
    } catch {
      recognition = null;
      onError('unavailable');
      return;
    }
    timer = setTimeout(stop, MAX_RECORDING_MS);
  }

  function stop() {
    if (recognition) recognition.stop();
  }

  /** Прервать без отправки результата */
  function cancel() {
    aborted = true;
    if (recognition) recognition.abort();
  }

  return {
    start,
    stop,
    cancel,
    toggle: () => (recognition ? stop() : start()),
    get listening() {
      return Boolean(recognition);
    },
  };
}

// ---------- Озвучка ----------

// Браузер не сообщает пол голоса — определяем по имени. Сначала женские: в «female» есть «male».
// Google и Microsoft — голоса Chrome и Edge, Milena и Yuri — macOS, Anna, Aleksandr и др. — RHVoice,
// «Russian+Alicia» и подобные — варианты eSpeak, через которые Chrome озвучивает на Linux.
const FEMALE = /google русский|milena|irina|svetlana|ekaterina|katya|alena|alyona|anna|elena|tatiana|victoria|marina|natalia|daria|alicia|andrea|annie|auntie|belinda|linda|steph|anika|shelby|female|женск/i;
const MALE = /pavel|dmitr|yuri|maxim|aleksandr|artemiy|mikhail|evgeniy|vitaliy|\badam|\balex\b|\bandy|antonio|benjamin|boris|caleb|david|denis|diogo|\bed\b|edward|\bgene|gustave|henrique|hugo|\bian\b|iven|jacky|john|\blee\b|marcelo|marco|mario|\bmax\b|michael|michel|miguel|\bmike|norbert|pablo|\bpaul|pedro|quincy|reed|\brob\b|robert|sandro|storm|travis|victor|\bzac|male|мужск/i;
// Варианты eSpeak, которые звучат как спецэффект, и пронумерованные дубли
const JUNK = /demonic|croak|whisper|robo|tweaky|fast_test|anxious|kaukovalta|ricishay|serious|klatt|grandpa|grandma|\d$/i;
// Чем выше в списке, тем естественнее звучит
const QUALITY = [/google|microsoft/i, /milena|yuri|irina|svetlana|pavel|dmitr/i, /anna|elena|aleksandr|artemiy|tatiana|mikhail|victoria/i];

/** 'female' | 'male' | null */
export function voiceGender(voice) {
  if (FEMALE.test(voice.name)) return 'female';
  if (MALE.test(voice.name)) return 'male';
  return null;
}

function quality(voice) {
  const index = QUALITY.findIndex((re) => re.test(voice.name));
  return index === -1 ? QUALITY.length : index;
}

/** Русские голоса браузера, лучшие первыми */
export function russianVoices() {
  if (!('speechSynthesis' in window)) return [];
  return window.speechSynthesis
    .getVoices()
    .filter((v) => (v.lang && v.lang.toLowerCase().startsWith('ru')) || /russian|русск/i.test(v.name))
    .filter((v) => !JUNK.test(v.name.split('+').pop()))
    .sort((a, b) => quality(a) - quality(b) || a.name.localeCompare(b.name));
}

// eSpeak (Linux) — разные «пол»-варианты почти не различаются на слух, поэтому разницу задаём тоном
const ROBOTIC = /espeak|\+|^russian$/i;
const PITCH = { robotic: { female: 1.45, male: 0.55 }, natural: { female: 1, male: 1 }, fallback: { female: 1.2, male: 0.75 } };

/**
 * Голос и высота тона для выбранного пола. Если голоса нужного пола нет, берётся первый русский,
 * а пол имитируется тоном.
 */
export function pickVoice(gender = 'female') {
  const voices = russianVoices();
  const match = voices.find((v) => voiceGender(v) === gender);
  if (match) return { voice: match, pitch: PITCH[ROBOTIC.test(match.name) ? 'robotic' : 'natural'][gender], exact: true };
  const voice = voices[0] || null;
  const kind = voice && ROBOTIC.test(voice.name) ? 'robotic' : 'fallback';
  return { voice, pitch: PITCH[kind][gender], exact: false };
}

export const speech = {
  supported: 'speechSynthesis' in window,
  prefs: { gender: 'female' },

  configure(prefs) {
    Object.assign(this.prefs, prefs);
  },

  speak(text) {
    if (!this.supported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    const { voice, pitch } = pickVoice(this.prefs.gender);
    if (voice) utterance.voice = voice;
    utterance.pitch = pitch;
    window.speechSynthesis.speak(utterance);
  },

  cancel() {
    if (this.supported) window.speechSynthesis.cancel();
  },

  /** Список голосов браузер загружает асинхронно */
  onVoicesChanged(callback) {
    if (this.supported) window.speechSynthesis.addEventListener('voiceschanged', callback);
  },
};
