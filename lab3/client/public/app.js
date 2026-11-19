(() => {
  'use strict';

  const appEl = document.getElementById('app');
  const toastsEl = document.getElementById('toasts');
  const topbarEl = document.getElementById('topbar-actions');

  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const STATUS_LABELS = Object.freeze({
    new: 'Новая',
    in_progress: 'В работе',
    done: 'Завершена'
  });
  const STATUS_VALUES = Object.keys(STATUS_LABELS);

  const ROLE_LABELS = Object.freeze({
    admin: 'Администратор',
    manager: 'Менеджер',
    user: 'Пользователь'
  });

  const AUDIT_LABELS = Object.freeze({
    'auth.login.success': 'Успешный вход',
    'auth.register': 'Создана учётная запись',
    'auth.register.failed': 'Отказ в создании учётной записи',
    'auth.login.failure': 'Неудачная попытка входа',
    'auth.login.locked': 'Учётная запись заблокирована подбором',
    'auth.login.denied': 'Вход в заблокированную учётную запись',
    'auth.logout': 'Выход из системы',
    'auth.refresh.success': 'Ключ доступа обновлён',
    'auth.refresh.reuse': 'Повторное использование ключа',
    'auth.refresh.failure': 'Отказ в обновлении ключа',
    'auth.password.changed': 'Пароль изменён',
    'auth.password.reset_requested': 'Запрошено восстановление доступа',
    'auth.password.reset': 'Пароль восстановлен',
    'auth.password.reset_failed': 'Неудачное восстановление пароля',
    'auth.session.revoked': 'Подключение завершено',
    'auth.sessions.revoked_others': 'Завершены другие подключения',
    'user.created': 'Пользователь создан',
    'user.updated': 'Пользователь изменён',
    'user.deleted': 'Пользователь удалён',
    'user.unlocked': 'Учётная запись разблокирована',
    'user.sessions_revoked': 'Сеансы пользователя завершены',
    'session.revoked': 'Сеанс завершён администратором',
    'task.created': 'Задача создана',
    'task.updated': 'Задача изменена',
    'task.deleted': 'Задача удалена',
    'file.uploaded': 'Файл загружен',
    'file.downloaded': 'Файл скачан',
    'file.deleted': 'Файл удалён'
  });

  const FILTERS = [
    { value: 'all', label: 'Все' },
    { value: 'new', label: 'Новые' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'done', label: 'Завершённые' }
  ];

  const state = {
    user: null,
    accessToken: null,
    accessExpiresAt: null,
    authChecked: false,
    redirectAfterLogin: null,
    tasks: [],
    filter: 'all',
    loadError: null,
    refreshPromise: null
  };

  class ApiError extends Error {
    constructor(message, status, data) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.data = data;
    }
  }

  // ---------- Утилиты ----------
  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  function dateLabel(value) {
    if (!value) return '—';
    const parts = String(value).split('-').map(Number);
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) {
      return value;
    }
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date.toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }

  function dateTimeLabel(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function fileSizeLabel(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) return `${size} Б`;
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1).replace('.', ',')} КБ`;
    }
    return `${(size / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
  }

  function filesLabel(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} файл`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
      return `${count} файла`;
    }
    return `${count} файлов`;
  }

  function roleBadge(role) {
    return `<span class="role-badge role-${escapeHtml(role)}">${
      ROLE_LABELS[role] || escapeHtml(role)
    }</span>`;
  }

  function initials(name) {
    const parts = String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    const first = parts[0] ? parts[0][0] : '?';
    const second = parts[1] ? parts[1][0] : '';
    return `${first}${second}`.toUpperCase();
  }

  function formatDetails(details) {
    if (!Array.isArray(details)) return '';
    return details
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!item || typeof item !== 'object') return '';
        return item.field ? `${item.field}: ${item.message}` : item.message;
      })
      .filter(Boolean)
      .join('; ');
  }

  function problemMessage(data, status, retryAfter) {
    if (!data) return `Ошибка запроса (HTTP ${status})`;

    const details = formatDetails(data.errors);
    const base = data.detail || data.title || `Ошибка запроса (HTTP ${status})`;
    const suffix = retryAfter > 0 ? ` Повторите через ${retryAfter} с.` : '';

    return `${base}${details ? `: ${details}` : ''}${suffix}`;
  }

  // ---------- Работа с API ----------
  async function refreshSession() {
    if (state.refreshPromise) return state.refreshPromise;

    state.refreshPromise = (async () => {
      try {
        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { Accept: 'application/json' }
        });

        if (!response.ok) return false;

        const data = await response.json();
        state.accessToken = data.accessToken;
        state.accessExpiresAt = data.accessExpiresAt;
        state.user = data.user;
        state.authChecked = true;
        renderTopbar();
        return true;
      } catch {
        return false;
      } finally {
        state.refreshPromise = null;
      }
    })();

    return state.refreshPromise;
  }

  async function ensureAccessToken() {
    if (!state.accessToken) return false;

    const expiresAt = Date.parse(state.accessExpiresAt || '');
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 30_000) return true;

    return refreshSession();
  }

  async function api(url, options = {}, { auth = true, retry = true } = {}) {
    const request = {
      ...options,
      headers: { ...(options.headers || {}) }
    };

    if (
      request.body !== undefined &&
      request.body !== null &&
      !(request.body instanceof FormData) &&
      typeof request.body !== 'string'
    ) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(request.body);
    }

    request.headers.Accept = 'application/json';

    if (auth && state.accessToken) {
      await ensureAccessToken();
      if (state.accessToken) {
        request.headers.Authorization = `Bearer ${state.accessToken}`;
      }
    }

    let response;
    try {
      response = await fetch(url, request);
    } catch {
      throw new ApiError(
        'Не удалось связаться с сервером API. Проверьте подключение и повторите попытку.',
        0
      );
    }

    if (response.status === 401 && auth && retry && state.accessToken) {
      const refreshed = await refreshSession();
      if (refreshed) return api(url, options, { auth, retry: false });
    }

    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }
      }
    }

    if (!response.ok) {
      const retryAfter = Number(response.headers.get('retry-after')) || 0;
      throw new ApiError(
        problemMessage(data, response.status, retryAfter),
        response.status,
        data
      );
    }

    return data;
  }

  function clearAuth() {
    state.user = null;
    state.accessToken = null;
    state.accessExpiresAt = null;
    state.authChecked = true;
  }

  function applyAuth(data) {
    state.accessToken = data.accessToken;
    state.accessExpiresAt = data.accessExpiresAt;
    state.user = data.user;
    state.authChecked = true;
    renderTopbar();
  }

  function handleAuthError(error) {
    if (!(error instanceof ApiError) || error.status !== 401) return false;

    const route = parseRoute();
    if (route.name !== 'login') {
      state.redirectAfterLogin = window.location.hash || null;
    }

    clearAuth();
    renderTopbar();
    toast('Сессия истекла. Войдите снова.', 'error');

    if (route.name !== 'login') {
      window.location.replace('#/login');
    }

    return true;
  }

  // ---------- Уведомления ----------
  function toast(message, type = 'success') {
    const element = document.createElement('div');
    element.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
    element.textContent = message;
    toastsEl.appendChild(element);

    window.setTimeout(() => {
      element.classList.add('toast-hide');
      window.setTimeout(() => element.remove(), 220);
    }, 4500);
  }

  function formErrorElement(form) {
    return form.querySelector('#form-error') || appEl.querySelector('#form-error');
  }

  function clearFormError(form) {
    const errorEl = formErrorElement(form);
    if (errorEl) errorEl.hidden = true;
  }

  function showFormError(form, message) {
    const errorEl = formErrorElement(form);
    if (!errorEl) {
      toast(message, 'error');
      return;
    }
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---------- Маршрутизация (hash SPA) ----------
  function parseRoute() {
    const raw = window.location.hash.replace(/^#/, '') || '/tasks';
    const [pathPart, queryPart = ''] = raw.split('?');
    const params = new URLSearchParams(queryPart);
    const parts = pathPart.split('/').filter(Boolean);

    if (parts.length === 0) return { name: 'list' };
    if (parts[0] === 'login') return { name: 'login' };
    if (parts[0] === 'register') return { name: 'register' };
    if (parts[0] === 'forgot-password') return { name: 'forgot' };
    if (parts[0] === 'reset-password') {
      return { name: 'reset', token: params.get('token') || '' };
    }
    if (parts[0] === 'users') return { name: 'users' };
    if (parts[0] === 'audit') return { name: 'audit' };
    if (parts[0] !== 'tasks') return { name: 'notfound' };
    if (parts[1] === 'new') return { name: 'create' };
    if (parts[1]) return { name: 'edit', id: parts[1] };
    return { name: 'list' };
  }

  let routeToken = 0;

  async function refreshCurrentView() {
    const token = ++routeToken;
    const route = parseRoute();
    renderTopbar();

    const publicRoutes = new Set(['login', 'register', 'forgot', 'reset']);

    if (!state.user && !publicRoutes.has(route.name)) {
      state.redirectAfterLogin = window.location.hash || null;
      window.location.replace('#/login');
      return;
    }

    if (state.user && publicRoutes.has(route.name)) {
      window.location.replace('#/tasks');
      return;
    }

    if (
      (route.name === 'users' || route.name === 'audit') &&
      state.user?.role !== 'admin'
    ) {
      renderErrorState('Доступ запрещён', 'Раздел доступен только администратору.');
      return;
    }

    if (route.name === 'list') {
      await renderList(token);
      return;
    }
    if (route.name === 'create') {
      await renderCreate(token);
      return;
    }
    if (route.name === 'edit') {
      await renderEdit(token, route.id);
      return;
    }
    if (route.name === 'users') {
      await renderUsers(token);
      return;
    }
    if (route.name === 'audit') {
      await renderAudit(token);
      return;
    }
    if (route.name === 'login') {
      renderLogin();
      return;
    }
    if (route.name === 'register') {
      renderRegister();
      return;
    }
    if (route.name === 'forgot') {
      renderForgot();
      return;
    }
    if (route.name === 'reset') {
      renderReset(route.token);
      return;
    }

    renderErrorState('Страница не найдена', 'Такого раздела в приложении нет.');
  }

  function loadingHtml(text) {
    return `<div class="loading">${escapeHtml(text)}</div>`;
  }

  function renderErrorState(title, message) {
    document.title = `${title} — Список задач`;
    appEl.innerHTML = `
      <div class="panel error-panel" role="alert">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <a class="btn btn-primary" href="#/tasks">← К списку задач</a>
      </div>`;
  }

  // ---------- Шапка ----------
  function renderTopbar() {
    if (!topbarEl) return;

    const route = parseRoute();

    if (!state.user) {
      topbarEl.innerHTML =
        route.name === 'login' ? '' : '<a class="btn" href="#/login">Войти</a>';
      return;
    }

    const isAdmin = state.user.role === 'admin';
    const tasksActive = ['list', 'create', 'edit'].includes(route.name);

    const links = [
      `<a class="topbar-link ${tasksActive ? 'active' : ''}" href="#/tasks">Задачи</a>`
    ];

    if (isAdmin) {
      links.push(
        `<a class="topbar-link ${route.name === 'users' ? 'active' : ''}" href="#/users">Пользователи</a>`,
        `<a class="topbar-link ${route.name === 'audit' ? 'active' : ''}" href="#/audit">Журнал</a>`
      );
    }

    topbarEl.innerHTML = `
      <nav class="topbar-nav" aria-label="Разделы приложения">
        ${links.join('')}
      </nav>
      <a class="btn btn-primary" href="#/tasks/new">+ Новая задача</a>
      <div class="user-chip" aria-label="Текущий пользователь: ${escapeHtml(
        state.user.name
      )}, роль ${escapeHtml(ROLE_LABELS[state.user.role] || state.user.role)}">
        <span class="user-avatar" aria-hidden="true">${escapeHtml(initials(state.user.name))}</span>
        <span class="user-meta">
          <span class="user-chip-name" title="${escapeHtml(state.user.email)}">${escapeHtml(
            state.user.name
          )}</span>
          <span class="user-role">Роль: ${roleBadge(state.user.role)}</span>
        </span>
        <button type="button"
                class="btn btn-ghost"
                data-action="logout"
                title="Завершить текущий сеанс">Выйти</button>
      </div>`;
  }

  // ---------- Вход, восстановление доступа ----------
  function renderLogin() {
    document.title = 'Вход — Список задач';

    appEl.innerHTML = `
      <div class="auth-wrap">
        <section class="panel auth-panel">
          <h1>Вход в систему</h1>
          <p class="muted">Доступ выдаётся по временным ключам: 15 минут для работы и 7 дней для обновления.</p>

          <div id="form-error" class="form-error" role="alert" hidden></div>

          <form id="login-form" novalidate>
            <label class="field">
              <span>Email <em>*</em></span>
              <input type="email"
                     name="email"
                     autocomplete="username"
                     maxlength="254"
                     required
                     autofocus
                     placeholder="user@example.com">
            </label>

            <label class="field">
              <span>Пароль <em>*</em></span>
              <input type="password"
                     name="password"
                     autocomplete="current-password"
                     maxlength="128"
                     required
                     placeholder="Введите пароль">
            </label>

            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Войти</button>
            </div>
          </form>

          <div class="auth-links">
            <a href="#/register">Создать учётную запись</a>
            <a href="#/forgot-password">Забыли пароль?</a>
          </div>

          <div class="demo-box">
            <strong>Демонстрационные учётные записи</strong><br>
            Администратор — <code>admin@example.com</code> / <code>Admin123!</code><br>
            Менеджер — <code>manager@example.com</code> / <code>Manager123!</code><br>
            Пользователь — <code>user@example.com</code> / <code>User123!</code>
          </div>
        </section>
      </div>`;

    bindLoginForm();
  }

  function bindLoginForm() {
    const form = appEl.querySelector('#login-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormError(form);

      const data = new FormData(form);
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');

      if (!email || !password) {
        showFormError(form, 'Введите email и пароль.');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      const initialText = button.textContent.trim();
      button.disabled = true;
      button.textContent = 'Вход…';

      try {
        const result = await api(
          '/api/auth/login',
          { method: 'POST', body: { email, password } },
          { auth: false }
        );

        applyAuth(result);
        toast(`Добро пожаловать, ${result.user.name}`);

        const target =
          state.redirectAfterLogin && state.redirectAfterLogin !== '#/login'
            ? state.redirectAfterLogin
            : '#/tasks';
        state.redirectAfterLogin = null;

        if (window.location.hash === target) await refreshCurrentView();
        else window.location.hash = target;
      } catch (error) {
        showFormError(form, error.message);
        button.disabled = false;
        button.textContent = initialText;
      }
    });
  }

  function renderRegister() {
    document.title = 'Регистрация — Список задач';

    appEl.innerHTML = `
      <div class="auth-wrap">
        <section class="panel auth-panel">
          <h1>Создание учётной записи</h1>
          <p class="muted">Новая учётная запись получает роль «Пользователь». Изменить роль может администратор.</p>

          <div id="form-error" class="form-error" role="alert" hidden></div>

          <form id="register-form" novalidate>
            <label class="field">
              <span>Имя <em>*</em></span>
              <input type="text"
                     name="name"
                     autocomplete="name"
                     maxlength="100"
                     required
                     autofocus
                     placeholder="Иван Петров">
            </label>

            <label class="field">
              <span>Email <em>*</em></span>
              <input type="email"
                     name="email"
                     autocomplete="username"
                     maxlength="254"
                     required
                     placeholder="ivan@example.com">
            </label>

            <label class="field">
              <span>Пароль <em>*</em></span>
              <input type="password"
                     name="password"
                     autocomplete="new-password"
                     maxlength="128"
                     required
                     placeholder="Не менее 8 символов">
              <small class="hint">От 8 символов, хотя бы одна буква и одна цифра</small>
            </label>

            <label class="field">
              <span>Повторите пароль <em>*</em></span>
              <input type="password"
                     name="confirmPassword"
                     autocomplete="new-password"
                     maxlength="128"
                     required>
            </label>

            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Создать учётную запись</button>
              <a class="btn btn-ghost" href="#/login">У меня есть аккаунт</a>
            </div>
          </form>
        </section>
      </div>`;

    bindRegisterForm();
  }

  function bindRegisterForm() {
    const form = appEl.querySelector('#register-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormError(form);

      const data = new FormData(form);
      const name = String(data.get('name') || '').trim();
      const email = String(data.get('email') || '').trim();
      const password = String(data.get('password') || '');
      const confirmPassword = String(data.get('confirmPassword') || '');

      if (!name || !email || !password) {
        showFormError(form, 'Заполните имя, email и пароль.');
        return;
      }
      if (password.length < 8) {
        showFormError(form, 'Пароль должен содержать не менее 8 символов.');
        return;
      }
      if (!/[A-Za-zА-Яа-яЁё]/.test(password) || !/\d/.test(password)) {
        showFormError(form, 'Пароль должен содержать хотя бы одну букву и одну цифру.');
        return;
      }
      if (password !== confirmPassword) {
        showFormError(form, 'Пароли не совпадают.');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      const initialText = button.textContent.trim();
      button.disabled = true;
      button.textContent = 'Создание…';

      try {
        const result = await api(
          '/api/auth/register',
          { method: 'POST', body: { name, email, password } },
          { auth: false }
        );

        applyAuth(result);
        toast(`Учётная запись создана. Добро пожаловать, ${result.user.name}!`);
        state.redirectAfterLogin = null;

        if (window.location.hash === '#/tasks') await refreshCurrentView();
        else window.location.hash = '#/tasks';
      } catch (error) {
        showFormError(form, error.message);
        button.disabled = false;
        button.textContent = initialText;
      }
    });
  }

  function renderForgot() {
    document.title = 'Восстановление доступа — Список задач';

    appEl.innerHTML = `
      <div class="auth-wrap">
        <section class="panel auth-panel">
          <h1>Восстановление доступа</h1>
          <p class="muted">Укажите email учётной записи. Мы отправим одноразовую ссылку на 30 минут.</p>

          <div id="form-error" class="form-error" role="alert" hidden></div>

          <form id="forgot-form" novalidate>
            <label class="field">
              <span>Email <em>*</em></span>
              <input type="email" name="email" autocomplete="username" maxlength="254" required autofocus>
            </label>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Отправить ссылку</button>
              <a class="btn btn-ghost" href="#/login">Назад ко входу</a>
            </div>
          </form>
        </section>
      </div>`;

    const form = appEl.querySelector('#forgot-form');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormError(form);

      const email = String(new FormData(form).get('email') || '').trim();
      if (!email) {
        showFormError(form, 'Введите email.');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      const initialText = button.textContent.trim();
      button.disabled = true;
      button.textContent = 'Отправка…';

      try {
        const result = await api(
          '/api/auth/forgot-password',
          { method: 'POST', body: { email } },
          { auth: false }
        );

        document.title = 'Проверьте почту — Список задач';
        appEl.innerHTML = `
          <div class="auth-wrap">
            <section class="panel info-panel">
              <div class="empty-icon" aria-hidden="true">✉</div>
              <h1>Проверьте почту</h1>
              <p>${escapeHtml(result.message)}</p>
              <p class="muted">В демонстрационном окружении письма доступны в MailHog: <a href="http://localhost:8025" target="_blank" rel="noopener">localhost:8025</a>.</p>
              <a class="btn btn-primary" href="#/login">Вернуться к входу</a>
            </section>
          </div>`;
      } catch (error) {
        showFormError(form, error.message);
        button.disabled = false;
        button.textContent = initialText;
      }
    });
  }

  function renderReset(token) {
    document.title = 'Новый пароль — Список задач';

    if (!token) {
      appEl.innerHTML = `
        <div class="auth-wrap">
          <div class="panel error-panel" role="alert">
            <h1>Ссылка недействительна</h1>
            <p>В ссылке отсутствует ключ восстановления. Запросите новое письмо.</p>
            <a class="btn btn-primary" href="#/forgot-password">Запросить ссылку</a>
          </div>
        </div>`;
      return;
    }

    appEl.innerHTML = `
      <div class="auth-wrap">
        <section class="panel auth-panel">
          <h1>Новый пароль</h1>
          <p class="muted">Пароль от 8 до 128 символов, содержит хотя бы одну букву и одну цифру.</p>

          <div id="form-error" class="form-error" role="alert" hidden></div>

          <form id="reset-form" novalidate>
            <label class="field">
              <span>Новый пароль <em>*</em></span>
              <input type="password" name="newPassword" autocomplete="new-password" maxlength="128" required autofocus>
            </label>
            <label class="field">
              <span>Повторите пароль <em>*</em></span>
              <input type="password" name="confirmPassword" autocomplete="new-password" maxlength="128" required>
            </label>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Сохранить пароль</button>
              <a class="btn btn-ghost" href="#/login">Отмена</a>
            </div>
          </form>
        </section>
      </div>`;

    const form = appEl.querySelector('#reset-form');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormError(form);

      const data = new FormData(form);
      const newPassword = String(data.get('newPassword') || '');
      const confirmPassword = String(data.get('confirmPassword') || '');

      if (newPassword.length < 8) {
        showFormError(form, 'Пароль должен содержать не менее 8 символов.');
        return;
      }
      if (newPassword !== confirmPassword) {
        showFormError(form, 'Пароли не совпадают.');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Сохранение…';

      try {
        await api(
          '/api/auth/reset-password',
          { method: 'POST', body: { token, newPassword } },
          { auth: false }
        );

        toast('Пароль изменён. Войдите с новым паролем.');
        window.location.hash = '#/login';
      } catch (error) {
        showFormError(form, error.message);
        button.disabled = false;
        button.textContent = 'Сохранить пароль';
      }
    });
  }

  // ---------- Список задач ----------
  async function renderList(token) {
    state.loadError = null;
    appEl.innerHTML = loadingHtml('Загрузка задач…');
    document.title = 'Список задач — SPA';

    try {
      const query =
        state.filter === 'all' ? '' : `?status=${encodeURIComponent(state.filter)}`;
      const tasks = await api(`/api/tasks${query}`);
      if (token !== routeToken) return;
      state.tasks = Array.isArray(tasks) ? tasks : [];
    } catch (error) {
      if (token !== routeToken) return;
      if (handleAuthError(error)) return;
      state.tasks = [];
      state.loadError = error.message;
    }

    if (token !== routeToken) return;
    appEl.innerHTML = listHtml();
  }

  function listHtml() {
    let content;

    if (state.loadError) {
      content = `
        <div class="panel error-panel" role="alert">
          <h2>Не удалось загрузить задачи</h2>
          <p>${escapeHtml(state.loadError)}</p>
          <button type="button" class="btn" data-action="retry">Повторить</button>
        </div>`;
    } else if (state.tasks.length === 0) {
      content = `
        <div class="panel empty-state">
          <div class="empty-icon" aria-hidden="true">✓</div>
          <h2>Задач пока нет</h2>
          <p class="muted">Создайте первую задачу — список обновится без перезагрузки страницы.</p>
          <a class="btn btn-primary" href="#/tasks/new">Создать задачу</a>
        </div>`;
    } else {
      content = state.tasks.map(taskCardHtml).join('');
    }

    return `
      <section class="page-head">
        <div>
          <h1>Задачи</h1>
          <p class="muted">${
            state.loadError ? 'Список недоступен' : `Найдено: ${state.tasks.length}`
          }</p>
        </div>
      </section>

      <div class="filters" role="group" aria-label="Фильтр по статусу">
        ${FILTERS.map(
          (filter) => `
            <button type="button"
                    class="filter ${state.filter === filter.value ? 'active' : ''}"
                    data-action="filter"
                    data-filter="${filter.value}"
                    aria-pressed="${state.filter === filter.value}">
              ${filter.label}
            </button>`
        ).join('')}
      </div>

      <div class="task-list">${content}</div>`;
  }

  function taskCardHtml(task) {
    const files = Array.isArray(task.files) ? task.files : [];
    const ownerLine =
      state.user && state.user.role !== 'user' && task.owner
        ? `<span>Владелец: <strong>${escapeHtml(task.owner.name || task.owner.email)}</strong></span>`
        : '';

    return `
      <article class="card" data-task-id="${task.id}">
        <div class="card-head">
          <a class="card-title" href="#/tasks/${task.id}">${escapeHtml(task.title)}</a>
          <span class="badge status-${task.status}">${
            STATUS_LABELS[task.status] || escapeHtml(task.status)
          }</span>
        </div>

        <div class="card-meta">
          <span>Срок: <strong>${escapeHtml(dateLabel(task.dueDate))}</strong></span>
          <span>${escapeHtml(filesLabel(files.length))}</span>
          ${ownerLine}
        </div>

        <div class="card-actions">
          <label class="quick-status">
            Статус
            <select data-action="status" data-id="${task.id}" aria-label="Изменить статус задачи">
              ${statusOptions(task.status)}
            </select>
          </label>
          <a class="btn btn-ghost" href="#/tasks/${task.id}">Открыть</a>
          <button type="button"
                  class="btn btn-danger-ghost"
                  data-action="delete-task"
                  data-id="${task.id}"
                  data-title="${escapeHtml(task.title)}">
            Удалить
          </button>
        </div>
      </article>`;
  }

  // ---------- Форма задачи ----------
  function statusOptions(selected) {
    return STATUS_VALUES.map(
      (value) =>
        `<option value="${value}"${value === selected ? ' selected' : ''}>${
          STATUS_LABELS[value]
        }</option>`
    ).join('');
  }

  function ownerFieldHtml(users, selectedId) {
    if (!Array.isArray(users)) return '';

    const options = users
      .filter((user) => user.isActive)
      .map(
        (user) =>
          `<option value="${user.id}"${user.id === selectedId ? ' selected' : ''}>${escapeHtml(
            user.name
          )} (${escapeHtml(user.email)})</option>`
      )
      .join('');

    return `
      <label class="field">
        <span>Владелец</span>
        <select name="ownerId">${options}</select>
        <small class="hint">Менеджер и администратор видят задачи всех пользователей</small>
      </label>`;
  }

  function taskFormHtml(task, users) {
    const isEdit = Boolean(task);
    const title = task ? task.title : '';
    const status = task ? task.status : 'new';
    const dueDate = task?.dueDate || '';
    const ownerId = task?.owner?.id ?? state.user?.id;

    return `
      <section class="page-head">
        <div>
          <a class="back-link" href="#/tasks">← К списку задач</a>
          <h1>${isEdit ? 'Редактирование задачи' : 'Новая задача'}</h1>
          ${
            isEdit
              ? `<p class="muted">ID ${task.id} · создана ${escapeHtml(
                  dateTimeLabel(task.createdAt)
                )}</p>`
              : ''
          }
        </div>
      </section>

      <form id="task-form" class="panel" novalidate>
        <div id="form-error" class="form-error" role="alert" hidden></div>

        <label class="field">
          <span>Название <em>*</em></span>
          <input type="text"
                 name="title"
                 maxlength="200"
                 required
                 autofocus
                 value="${escapeHtml(title)}"
                 placeholder="Например, подготовить отчёт">
          <small class="hint">От 1 до 200 символов</small>
        </label>

        <div class="field-row">
          <label class="field">
            <span>Статус</span>
            <select name="status">${statusOptions(status)}</select>
          </label>

          <label class="field">
            <span>Срок</span>
            <input type="date" name="dueDate" value="${escapeHtml(dueDate)}">
          </label>
        </div>

        ${ownerFieldHtml(users, ownerId)}

        <div class="form-actions">
          <button class="btn btn-primary" type="submit">
            ${isEdit ? 'Сохранить' : 'Создать'}
          </button>
          <a class="btn btn-ghost" href="#/tasks">Отмена</a>
          ${
            isEdit
              ? `<button type="button"
                         class="btn btn-danger"
                         data-action="delete-task"
                         data-id="${task.id}"
                         data-title="${escapeHtml(task.title)}">
                   Удалить задачу
                 </button>`
              : ''
          }
        </div>
      </form>

      ${isEdit ? filesPanelHtml(task) : ''}`;
  }

  function filesPanelHtml(task) {
    const files = Array.isArray(task.files) ? task.files : [];

    const list =
      files.length === 0
        ? '<p class="muted">Файлов пока нет.</p>'
        : `<ul class="file-list">
             ${files
               .map(
                 (file) => `
                   <li>
                     <span class="file-name">${escapeHtml(file.originalName)}</span>
                     <span class="muted">
                       ${escapeHtml(fileSizeLabel(file.size))} ·
                       ${escapeHtml(dateTimeLabel(file.uploadedAt))}
                     </span>
                     <button type="button"
                             class="btn btn-ghost"
                             data-action="download-file"
                             data-task-id="${task.id}"
                             data-file-id="${file.id}"
                             data-file-name="${escapeHtml(file.originalName)}">
                       Скачать
                     </button>
                     <button type="button"
                             class="btn btn-icon btn-danger-ghost"
                             title="Удалить файл"
                             aria-label="Удалить файл ${escapeHtml(file.originalName)}"
                             data-action="delete-file"
                             data-task-id="${task.id}"
                             data-file-id="${file.id}"
                             data-file-name="${escapeHtml(file.originalName)}">
                       ×
                     </button>
                   </li>`
               )
               .join('')}
           </ul>`;

    return `
      <section class="panel files-panel">
        <h2>Файлы <span class="muted">(${files.length})</span></h2>
        ${list}
        <form id="upload-form" class="upload-form">
          <input type="file"
                 name="file"
                 required
                 accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.zip,.doc,.docx,.xls,.xlsx">
          <button class="btn" type="submit">Загрузить</button>
          <span class="muted">до 10 МБ</span>
        </form>
      </section>`;
  }

  async function loadOwnerUsers() {
    if (!state.user || state.user.role !== 'admin') return null;

    try {
      return await api('/api/users');
    } catch (error) {
      if (!handleAuthError(error)) toast(error.message, 'error');
      return null;
    }
  }

  async function renderCreate(token) {
    appEl.innerHTML = loadingHtml('Подготовка формы…');

    let users = await loadOwnerUsers();
    if (token !== routeToken) return;

    document.title = 'Новая задача — SPA';
    appEl.innerHTML = taskFormHtml(null, users);
    bindTaskForm(null);
    users = null;
  }

  async function renderEdit(token, rawId) {
    appEl.innerHTML = loadingHtml('Загрузка задачи…');
    document.title = 'Задача — SPA';

    try {
      const [task, users] = await Promise.all([
        api(`/api/tasks/${encodeURIComponent(rawId)}`),
        loadOwnerUsers()
      ]);
      if (token !== routeToken) return;

      document.title = `${task.title} — SPA`;
      appEl.innerHTML = taskFormHtml(task, users);
      bindTaskForm(task);
      bindUploadForm(task);
    } catch (error) {
      if (token !== routeToken) return;
      if (handleAuthError(error)) return;

      if (error.status === 404) {
        renderErrorState('Задача не найдена', 'Возможно, она уже была удалена.');
      } else if (error.status === 403) {
        renderErrorState('Доступ запрещён', 'Задача принадлежит другому пользователю.');
      } else {
        renderErrorState('Не удалось открыть задачу', error.message);
      }
    }
  }

  function bindTaskForm(task) {
    const form = appEl.querySelector('#task-form');
    if (!form) return;

    const errorEl = form.querySelector('#form-error');
    const titleInput = form.elements.title;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.hidden = true;

      const data = new FormData(form);
      const payload = {
        title: String(data.get('title') || '').trim(),
        status: String(data.get('status') || 'new'),
        dueDate: data.get('dueDate') ? String(data.get('dueDate')) : null
      };

      if (form.elements.ownerId) {
        payload.ownerId = Number(form.elements.ownerId.value);
      }

      if (!payload.title) {
        showFormError(form, 'Введите название задачи.');
        titleInput.focus();
        return;
      }

      if (payload.title.length > 200) {
        showFormError(form, 'Название не должно превышать 200 символов.');
        titleInput.focus();
        return;
      }

      const submitButton = form.querySelector('button[type="submit"]');
      const initialText = submitButton.textContent.trim();
      submitButton.disabled = true;
      submitButton.textContent = 'Сохранение…';

      try {
        if (task) {
          await api(`/api/tasks/${task.id}`, { method: 'PUT', body: payload });
          toast('Изменения сохранены');
          await refreshCurrentView();
        } else {
          const created = await api('/api/tasks', { method: 'POST', body: payload });
          toast('Задача создана');
          window.location.hash = `#/tasks/${created.id}`;
        }
      } catch (error) {
        if (handleAuthError(error)) return;
        showFormError(form, error.message);
        submitButton.disabled = false;
        submitButton.textContent = initialText;
      }
    });
  }

  function bindUploadForm(task) {
    const form = appEl.querySelector('#upload-form');
    if (!form) return;

    const input = form.querySelector('input[type="file"]');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const file = input.files && input.files[0];
      if (!file) {
        toast('Сначала выберите файл.', 'error');
        return;
      }

      if (file.size > MAX_FILE_SIZE) {
        toast('Файл больше 10 МБ.', 'error');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      const initialText = button.textContent.trim();
      button.disabled = true;
      button.textContent = 'Загрузка…';

      const body = new FormData();
      body.append('file', file);

      try {
        await api(`/api/tasks/${task.id}/files`, { method: 'POST', body });
        toast('Файл загружен');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
        button.textContent = initialText;
      }
    });
  }

  // ---------- Пользователи (администратор) ----------
  async function renderUsers(token) {
    appEl.innerHTML = loadingHtml('Загрузка пользователей…');
    document.title = 'Пользователи — Список задач';

    try {
      const users = await api('/api/users');
      if (token !== routeToken) return;
      appEl.innerHTML = usersHtml(users);
      bindUserForm();
    } catch (error) {
      if (token !== routeToken) return;
      if (handleAuthError(error)) return;
      renderErrorState('Не удалось загрузить пользователей', error.message);
    }
  }

  function userStatus(user) {
    if (!user.isActive) return { className: 'badge-blocked', label: 'Заблокирован' };
    if (user.isLocked) return { className: 'badge-locked', label: 'Временная блокировка' };
    return { className: 'badge-active', label: 'Активен' };
  }

  function usersHtml(users) {
    return `
      <section class="page-head">
        <div>
          <h1>Пользователи</h1>
          <p class="muted">Роли: администратор, менеджер, пользователь</p>
        </div>
      </section>

      <form id="user-form" class="panel" novalidate>
        <h2 style="margin:0 0 14px;font-size:18px;">Новый пользователь</h2>
        <div id="form-error" class="form-error" role="alert" hidden></div>

        <div class="field-row">
          <label class="field">
            <span>Имя <em>*</em></span>
            <input type="text" name="name" maxlength="100" required placeholder="Иван Петров">
          </label>
          <label class="field">
            <span>Email <em>*</em></span>
            <input type="email" name="email" maxlength="254" required placeholder="ivan@example.com">
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span>Пароль <em>*</em></span>
            <input type="password" name="password" maxlength="128" required>
            <small class="hint">От 8 символов, буквы и цифры</small>
          </label>
          <label class="field">
            <span>Роль</span>
            <select name="role">
              <option value="user">Пользователь</option>
              <option value="manager">Менеджер</option>
              <option value="admin">Администратор</option>
            </select>
          </label>
        </div>

        <div class="form-actions">
          <button class="btn btn-primary" type="submit">Создать пользователя</button>
        </div>
      </form>

      <div class="task-list">
        ${
          users.length === 0
            ? '<div class="panel empty-state"><p class="muted">Пользователей нет.</p></div>'
            : users.map(userCardHtml).join('')
        }
      </div>`;
  }

  function userCardHtml(user) {
    const status = userStatus(user);
    const lockedInfo = user.isLocked
      ? `<span>Блокировка до: <strong>${escapeHtml(dateTimeLabel(user.lockedUntil))}</strong></span>`
      : '';

    return `
      <article class="card" data-user-id="${user.id}">
        <div class="card-head">
          <div>
            <div class="card-title">${escapeHtml(user.name)}</div>
            <div class="muted">${escapeHtml(user.email)}</div>
          </div>
          <span class="badge ${status.className}">${status.label}</span>
        </div>

        <div class="meta-grid">
          <span>Роль: ${roleBadge(user.role)}</span>
          <span>Последний вход: <strong>${escapeHtml(
            dateTimeLabel(user.lastLoginAt)
          )}</strong></span>
          <span>Создан: <strong>${escapeHtml(dateTimeLabel(user.createdAt))}</strong></span>
          ${lockedInfo}
        </div>

        <div class="card-actions">
          <label class="quick-status">
            Роль
            <select data-action="change-role" data-id="${user.id}" aria-label="Изменить роль пользователя">
              ${Object.entries(ROLE_LABELS)
                .map(
                  ([value, label]) =>
                    `<option value="${value}"${value === user.role ? ' selected' : ''}>${label}</option>`
                )
                .join('')}
            </select>
          </label>

          ${
            user.isLocked
              ? `<button type="button" class="btn" data-action="unlock-user" data-id="${user.id}">Разблокировать</button>`
              : ''
          }

          <button type="button"
                  class="btn"
                  data-action="toggle-user"
                  data-id="${user.id}"
                  data-active="${user.isActive ? '1' : '0'}">
            ${user.isActive ? 'Заблокировать' : 'Включить'}
          </button>

          <button type="button" class="btn btn-ghost" data-action="revoke-user-sessions" data-id="${user.id}">
            Завершить сеансы
          </button>

          <button type="button"
                  class="btn btn-danger-ghost"
                  data-action="delete-user"
                  data-id="${user.id}"
                  data-name="${escapeHtml(user.name)}">
            Удалить
          </button>
        </div>
      </article>`;
  }

  function bindUserForm() {
    const form = appEl.querySelector('#user-form');
    if (!form) return;

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearFormError(form);

      const data = new FormData(form);
      const payload = {
        name: String(data.get('name') || '').trim(),
        email: String(data.get('email') || '').trim(),
        password: String(data.get('password') || ''),
        role: String(data.get('role') || 'user')
      };

      if (!payload.name || !payload.email || !payload.password) {
        showFormError(form, 'Заполните имя, email и пароль.');
        return;
      }

      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = 'Создание…';

      try {
        await api('/api/users', { method: 'POST', body: payload });
        toast('Пользователь создан');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        showFormError(form, error.message);
        button.disabled = false;
        button.textContent = 'Создать пользователя';
      }
    });
  }

  // ---------- Журнал аудита ----------
  async function renderAudit(token) {
    appEl.innerHTML = loadingHtml('Загрузка журнала…');
    document.title = 'Журнал — Список задач';

    try {
      const events = await api('/api/audit?limit=100');
      if (token !== routeToken) return;
      appEl.innerHTML = auditHtml(events);
    } catch (error) {
      if (token !== routeToken) return;
      if (handleAuthError(error)) return;
      renderErrorState('Не удалось загрузить журнал', error.message);
    }
  }

  function auditHtml(events) {
    return `
      <section class="page-head">
        <div>
          <h1>Журнал безопасности</h1>
          <p class="muted">Последние ${events.length} событий</p>
        </div>
        <div class="page-head-actions">
          <button type="button" class="btn" data-action="refresh-audit">Обновить</button>
        </div>
      </section>

      <div class="audit-list">
        ${
          events.length === 0
            ? '<div class="panel empty-state"><p class="muted">Событий пока нет.</p></div>'
            : events.map(auditCardHtml).join('')
        }
      </div>`;
  }

  function auditCardHtml(item) {
    const details =
      item.details && Object.keys(item.details).length > 0
        ? `<pre class="audit-details">${escapeHtml(JSON.stringify(item.details, null, 2))}</pre>`
        : '';

    return `
      <article class="card">
        <div class="card-head">
          <div>
            <div class="audit-event">${escapeHtml(item.event)}</div>
            <div class="muted">${escapeHtml(AUDIT_LABELS[item.event] || item.event)}</div>
          </div>
          <span class="badge status-in_progress">${escapeHtml(
            dateTimeLabel(item.at)
          )}</span>
        </div>
        <div class="meta-grid">
          <span>Пользователь: <strong>${escapeHtml(item.email || '—')}</strong></span>
          <span>IP: <strong>${escapeHtml(item.ip || '—')}</strong></span>
          <span>Запрос: <strong>${escapeHtml(item.requestId || '—')}</strong></span>
        </div>
        ${details}
      </article>`;
  }

  // ---------- Действия ----------
  async function downloadFile(taskId, fileId, fileName) {
    const url = `/api/tasks/${taskId}/files/${fileId}/download`;

    const doFetch = () =>
      fetch(url, {
        headers: state.accessToken
          ? { Authorization: `Bearer ${state.accessToken}` }
          : {}
      });

    try {
      let response = await doFetch();

      if (response.status === 401 && (await refreshSession())) {
        response = await doFetch();
      }

      if (!response.ok) {
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        throw new ApiError(problemMessage(data, response.status, 0), response.status, data);
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = fileName || 'file';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      if (handleAuthError(error)) return;
      toast(error.message, 'error');
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Даже если сервер недоступен, локальную сессию нужно очистить.
    }

    clearAuth();
    renderTopbar();
    toast('Вы вышли из системы');
    window.location.hash = '#/login';
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;

    if (action === 'logout') {
      await logout();
      return;
    }

    if (action === 'filter') {
      state.filter = button.dataset.filter;
      await refreshCurrentView();
      return;
    }

    if (action === 'retry' || action === 'refresh-audit') {
      await refreshCurrentView();
      return;
    }

    if (action === 'delete-task') {
      const id = button.dataset.id;
      const title = button.dataset.title || 'эту задачу';

      if (!window.confirm(`Удалить задачу «${title}»? Вместе с ней удалятся её файлы.`)) {
        return;
      }

      button.disabled = true;
      try {
        await api(`/api/tasks/${id}`, { method: 'DELETE' });
        toast('Задача удалена');

        if (parseRoute().name === 'list') {
          await refreshCurrentView();
        } else {
          window.location.hash = '#/tasks';
        }
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'delete-file') {
      const taskId = button.dataset.taskId;
      const fileId = button.dataset.fileId;
      const name = button.dataset.fileName || 'этот файл';

      if (!window.confirm(`Удалить файл «${name}»?`)) return;

      button.disabled = true;
      try {
        await api(`/api/tasks/${taskId}/files/${fileId}`, { method: 'DELETE' });
        toast('Файл удалён');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'download-file') {
      await downloadFile(
        button.dataset.taskId,
        button.dataset.fileId,
        button.dataset.fileName
      );
      return;
    }

    if (action === 'revoke-user-sessions') {
      const id = button.dataset.id;
      if (!window.confirm('Завершить все подключения этого пользователя?')) return;

      button.disabled = true;
      try {
        await api(`/api/users/${id}/sessions`, { method: 'DELETE' });
        toast('Сеансы пользователя завершены');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'unlock-user') {
      const id = button.dataset.id;
      button.disabled = true;
      try {
        await api(`/api/users/${id}/unlock`, { method: 'POST' });
        toast('Учётная запись разблокирована');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'toggle-user') {
      const id = button.dataset.id;
      const isActive = button.dataset.active === '1';

      button.disabled = true;
      try {
        await api(`/api/users/${id}`, {
          method: 'PATCH',
          body: { isActive: !isActive }
        });
        toast(isActive ? 'Пользователь заблокирован' : 'Пользователь включён');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
      return;
    }

    if (action === 'delete-user') {
      const id = button.dataset.id;
      const name = button.dataset.name || 'этого пользователя';

      if (!window.confirm(`Удалить пользователя «${name}»?`)) return;

      button.disabled = true;
      try {
        await api(`/api/users/${id}`, { method: 'DELETE' });
        toast('Пользователь удалён');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        button.disabled = false;
      }
    }
  });

  document.addEventListener('change', async (event) => {
    const statusSelect = event.target.closest('select[data-action="status"]');
    if (statusSelect) {
      const id = statusSelect.dataset.id;
      statusSelect.disabled = true;

      try {
        await api(`/api/tasks/${id}`, {
          method: 'PATCH',
          body: { status: statusSelect.value }
        });
        toast('Статус обновлён');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        await refreshCurrentView();
      }
      return;
    }

    const roleSelect = event.target.closest('select[data-action="change-role"]');
    if (roleSelect) {
      const id = roleSelect.dataset.id;
      roleSelect.disabled = true;

      try {
        await api(`/api/users/${id}`, {
          method: 'PATCH',
          body: { role: roleSelect.value }
        });
        toast('Роль изменена');
        await refreshCurrentView();
      } catch (error) {
        if (handleAuthError(error)) return;
        toast(error.message, 'error');
        roleSelect.disabled = false;
        await refreshCurrentView();
      }
    }
  });

  window.addEventListener('hashchange', () => {
    refreshCurrentView();
  });

  // ---------- Старт ----------
  (async () => {
    await refreshSession();
    state.authChecked = true;
    renderTopbar();

    if (!window.location.hash) {
      window.location.replace('#/tasks');
      return;
    }

    await refreshCurrentView();
  })();
})();
