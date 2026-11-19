(() => {
  'use strict';

  const appEl = document.getElementById('app');
  const toastsEl = document.getElementById('toasts');

  const MAX_FILE_SIZE = 10 * 1024 * 1024;

  const STATUS_LABELS = Object.freeze({
    new: 'Новая',
    in_progress: 'В работе',
    done: 'Завершена'
  });
  const STATUS_VALUES = Object.keys(STATUS_LABELS);
  const FILTERS = [
    { value: 'all', label: 'Все' },
    { value: 'new', label: 'Новые' },
    { value: 'in_progress', label: 'В работе' },
    { value: 'done', label: 'Завершённые' }
  ];

  const state = {
    tasks: [],
    filter: 'all',
    loadError: null
  };

  class ApiError extends Error {
    constructor(message, status, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = details;
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

  async function api(url, options = {}) {
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

    let response;
    try {
      response = await fetch(url, request);
    } catch (error) {
      throw new ApiError(
        'Не удалось связаться с сервером API. Проверьте подключение и повторите попытку.',
        0
      );
    }

    let data = null;
    if (response.status !== 204) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (error) {
          data = null;
        }
      }
    }

    if (!response.ok) {
      const details = formatDetails(data?.details);
      const message = data?.error
        ? details
          ? `${data.error}: ${details}`
          : data.error
        : `Ошибка запроса (HTTP ${response.status})`;
      throw new ApiError(message, response.status, data);
    }

    return data;
  }

  function toast(message, type = 'success') {
    const element = document.createElement('div');
    element.className = `toast ${type === 'error' ? 'toast-error' : ''}`;
    element.textContent = message;
    toastsEl.appendChild(element);

    window.setTimeout(() => {
      element.classList.add('toast-hide');
      window.setTimeout(() => element.remove(), 220);
    }, 4000);
  }

  // ---------- Маршрутизация (hash SPA) ----------
  function parseRoute() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    const parts = raw.split('/').filter(Boolean);

    if (parts.length === 0) return { name: 'list' };
    if (parts[0] !== 'tasks') return { name: 'notfound' };
    if (parts[1] === 'new') return { name: 'create' };
    if (parts[1]) return { name: 'edit', id: parts[1] };
    return { name: 'list' };
  }

  let routeToken = 0;

  function refreshCurrentView() {
    const token = ++routeToken;
    const route = parseRoute();

    if (route.name === 'list') return renderList(token);
    if (route.name === 'create') {
      renderCreate();
      return Promise.resolve();
    }
    if (route.name === 'edit') return renderEdit(token, route.id);

    renderErrorState('Страница не найдена', 'Такого раздела в приложении нет.');
    return Promise.resolve();
  }

  function loadingHtml(text) {
    return `<div class="loading">${escapeHtml(text)}</div>`;
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

  function taskFormHtml(task) {
    const isEdit = Boolean(task);
    const title = task ? task.title : '';
    const status = task ? task.status : 'new';
    const dueDate = task?.dueDate || '';

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
                     <a href="/api/tasks/${task.id}/files/${file.id}/download">
                       ${escapeHtml(file.originalName)}
                     </a>
                     <span class="muted">
                       ${escapeHtml(fileSizeLabel(file.size))} ·
                       ${escapeHtml(dateTimeLabel(file.uploadedAt))}
                     </span>
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

  function renderCreate() {
    document.title = 'Новая задача — SPA';
    appEl.innerHTML = taskFormHtml(null);
    bindTaskForm(null);
  }

  async function renderEdit(token, rawId) {
    appEl.innerHTML = loadingHtml('Загрузка задачи…');
    document.title = 'Задача — SPA';

    try {
      const task = await api(`/api/tasks/${encodeURIComponent(rawId)}`);
      if (token !== routeToken) return;

      document.title = `${task.title} — SPA`;
      appEl.innerHTML = taskFormHtml(task);
      bindTaskForm(task);
      bindUploadForm(task);
    } catch (error) {
      if (token !== routeToken) return;

      if (error.status === 404) {
        renderErrorState('Задача не найдена', 'Возможно, она уже была удалена.');
      } else {
        renderErrorState('Не удалось открыть задачу', error.message);
      }
    }
  }

  function renderErrorState(title, message) {
    document.title = `${title} — SPA`;
    appEl.innerHTML = `
      <div class="panel error-panel" role="alert">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <a class="btn btn-primary" href="#/tasks">← К списку задач</a>
      </div>`;
  }

  function showFormError(form, message) {
    const errorEl = form.querySelector('#form-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = false;
    errorEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        toast(error.message, 'error');
        button.disabled = false;
        button.textContent = initialText;
      }
    });
  }

  // ---------- Делегирование событий ----------
  appEl.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;

    if (action === 'filter') {
      state.filter = button.dataset.filter;
      await refreshCurrentView();
      return;
    }

    if (action === 'retry') {
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
        toast(error.message, 'error');
        button.disabled = false;
      }
    }
  });

  appEl.addEventListener('change', async (event) => {
    const select = event.target.closest('select[data-action="status"]');
    if (!select) return;

    const id = select.dataset.id;
    select.disabled = true;

    try {
      await api(`/api/tasks/${id}`, { method: 'PATCH', body: { status: select.value } });
      toast('Статус обновлён');
      await refreshCurrentView();
    } catch (error) {
      toast(error.message, 'error');
      await refreshCurrentView();
    }
  });

  window.addEventListener('hashchange', refreshCurrentView);

  // ---------- Старт ----------
  if (!window.location.hash) {
    window.location.replace('#/tasks');
  } else {
    refreshCurrentView();
  }
})();
