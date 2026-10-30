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
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      failed = true;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') onError('denied');
      else if (event.error === 'audio-capture') onError('no_mic');
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

export const speech = {
  supported: 'speechSynthesis' in window,

  speak(text) {
    if (!this.supported || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ru-RU';
    const voice = window.speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith('ru'));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  },

  cancel() {
    if (this.supported) window.speechSynthesis.cancel();
  },
};
