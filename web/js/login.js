// Страница входа: логин и пароль → POST /api/auth/login. Под окном — кнопки тестовых аккаунтов,
// они только подставляют данные в форму (CONFIG.DEMO_ACCOUNTS).
import * as api from './api.js';
import { saveSession } from './auth.js';
import { CONFIG } from './config.js';
import { el } from './dom.js';

const ERRORS = {
  invalid_credentials: 'Неверный логин или пароль.',
  too_many_attempts: 'Слишком много попыток входа. Подождите минуту и попробуйте снова.',
  auth_unavailable: 'Сервер сейчас не может проверить вход. Попробуйте позже.',
};

/** root — #login из index.html; onLoggedIn(user) вызывается после успешного входа */
export function createLogin({ root, onLoggedIn }) {
  const form = root.querySelector('form');
  const loginInput = form.elements.namedItem('login');
  const passwordInput = form.elements.namedItem('password');
  const submit = form.querySelector('[type="submit"]');
  const error = root.querySelector('.login__error');
  const demo = root.querySelector('.login__demo');
  const toggle = root.querySelector('.login__eye');

  for (const account of CONFIG.DEMO_ACCOUNTS || []) {
    const button = el('button', 'btn-ghost', account.label);
    button.type = 'button';
    button.title = `Подставить ${account.login}`;
    button.addEventListener('click', () => {
      loginInput.value = account.login;
      passwordInput.value = account.password;
      passwordInput.type = 'password';
      toggle.setAttribute('aria-pressed', 'false');
      error.textContent = '';
      submit.focus();
    });
    demo.querySelector('.login__demo-buttons').append(button);
  }
  demo.hidden = !(CONFIG.DEMO_ACCOUNTS || []).length;

  toggle.addEventListener('click', () => {
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
  });

  form.addEventListener('input', () => {
    error.textContent = '';
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!loginInput.value.trim() || !passwordInput.value) {
      error.textContent = 'Введите логин и пароль.';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Входим…';
    try {
      const result = await api.login(loginInput.value, passwordInput.value);
      saveSession(result);
      passwordInput.value = '';
      onLoggedIn(result.user);
    } catch (problem) {
      console.warn('Вход не удался', problem);
      error.textContent = ERRORS[problem.code] || 'Не удалось войти. Проверьте соединение и попробуйте ещё раз.';
      if (problem.code === 'invalid_credentials') passwordInput.select();
    } finally {
      submit.disabled = false;
      submit.textContent = 'Войти';
    }
  });

  return {
    /** message — почему показали вход (например, сессия закончилась) */
    show(message = '') {
      error.textContent = '';
      root.querySelector('.login__note').textContent = message;
      root.querySelector('.login__note').hidden = !message;
      passwordInput.value = '';
      loginInput.focus();
    },
  };
}
