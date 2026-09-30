const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = 3000;

const DATA_FILE = path.join(__dirname, 'data', 'tasks.json');
const UPLOAD_DIR = path.join(__dirname, 'data', 'uploads');

// ---------- Утилиты ----------
function readTasks() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeTasks(tasks) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
}

// ---------- Multer (загрузка файлов) ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + '-' + file.originalname);
  }
});
const upload = multer({ storage });

// ---------- Настройка EJS ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Маршруты ----------

// Главная — список задач с фильтром
app.get('/', (req, res) => {
  const filter = req.query.status || 'all';
  let tasks = readTasks();

  if (filter !== 'all') {
    tasks = tasks.filter(t => t.status === filter);
  }

  // сортировка по дате
  tasks.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  res.render('index', {
    tasks,
    filter,
    statuses: [
      { value: 'all', label: 'Все' },
      { value: 'new', label: 'Новые' },
      { value: 'in_progress', label: 'В работе' },
      { value: 'done', label: 'Завершённые' }
    ]
  });
});

// Добавить задачу
app.post('/tasks', (req, res) => {
  const tasks = readTasks();
  const { title, status, dueDate } = req.body;
  const id = tasks.length ? Math.max(...tasks.map(t => t.id)) + 1 : 1;

  tasks.push({
    id,
    title: title || 'Без названия',
    status: status || 'new',
    dueDate: dueDate || '',
    files: []
  });

  writeTasks(tasks);
  res.redirect('/');
});

// Изменить статус
app.post('/tasks/:id/status', (req, res) => {
  const tasks = readTasks();
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (task) {
    task.status = req.body.status;
    writeTasks(tasks);
  }
  res.redirect('back');
});

// Удалить задачу
app.post('/tasks/:id/delete', (req, res) => {
  let tasks = readTasks();
  tasks = tasks.filter(t => t.id !== Number(req.params.id));
  writeTasks(tasks);
  res.redirect('/');
});

// Загрузить файл к задаче
app.post('/tasks/:id/files', upload.single('file'), (req, res) => {
  const tasks = readTasks();
  const task = tasks.find(t => t.id === Number(req.params.id));
  if (task && req.file) {
    task.files.push({
      originalName: req.file.originalname,
      storedName: req.file.filename,
      uploadedAt: new Date().toISOString()
    });
    writeTasks(tasks);
  }
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});