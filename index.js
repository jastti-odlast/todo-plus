// index.js
// Simple MVP server + Telegram bot for ToDo+
// Usage: set environment variable BOT_TOKEN with your Telegram bot token
// Run: npm install && BOT_TOKEN=xxxxx node index.js

const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const cors = require('cors');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("ERROR: set BOT_TOKEN environment variable (from BotFather)");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- DB setup (sqlite file)
const db = new sqlite3.Database(path.join(__dirname, 'todo.db'));
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tg_id INTEGER UNIQUE,
    first_name TEXT,
    last_name TEXT,
    username TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_tg_id INTEGER,
    title TEXT,
    description TEXT,
    tags TEXT,
    priority INTEGER DEFAULT 0,
    due_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed INTEGER DEFAULT 0,
    reminder_at DATETIME,
    reminder_sent INTEGER DEFAULT 0
  )`);
});

// --- Telegram bot (long polling)
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const text = `Привет, ${msg.from.first_name || ''}! Это ToDo+ — открой мини-приложение кнопкой ниже.`;
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Открыть ToDo+", web_app: { url: process.env.WEBAPP_URL || `https://t.me/${msg.chat.username || msg.chat.id}?start=webapp` } }
        ]
      ]
    }
  };
  bot.sendMessage(chatId, text); // keyboard doesn't always open WebApp; user can press custom keyboard in other flows
});

// Optional: show keyboard with WebApp button when user presses /todo
bot.onText(/\/todo/, (msg) => {
  const chatId = msg.chat.id;
  const webAppUrl = process.env.WEBAPP_URL || `https://your-domain-or-ngrok-url`; // replace if you have domain
  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "Открыть ToDo+", web_app: { url: webAppUrl } }]
      ],
      resize_keyboard: true
    }
  };
  bot.sendMessage(chatId, "Открываю ToDo+", keyboard).catch(()=> {
    bot.sendMessage(chatId, "Открыть ToDo+: " + webAppUrl);
  });
});

// --- REST API ---
// Note: For MVP we accept tg_id from client (initDataUnsafe). In production verify initData signature.

app.post('/api/auth', (req, res) => {
  // body: { tg_id, first_name, last_name, username }
  const { tg_id, first_name, last_name, username } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  db.run(
    `INSERT OR IGNORE INTO users (tg_id, first_name, last_name, username) VALUES (?, ?, ?, ?)`,
    [tg_id, first_name || '', last_name || '', username || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM users WHERE tg_id = ?`, [tg_id], (err2, user) => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ user });
      });
    }
  );
});

// Create task
app.post('/api/tasks', (req, res) => {
  // body: { tg_id, title, description, tags, priority, due_at, reminder_at }
  const { tg_id, title, description, tags, priority, due_at, reminder_at } = req.body;
  if (!tg_id || !title) return res.status(400).json({ error: 'tg_id + title required' });
  db.run(
    `INSERT INTO tasks (user_tg_id, title, description, tags, priority, due_at, reminder_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tg_id, title, description || '', (tags||[]).join(','), priority || 0, due_at || null, reminder_at || null],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.get(`SELECT * FROM tasks WHERE id = ?`, [this.lastID], (e, task) => {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ task });
      });
    }
  );
});

// Get tasks with optional filters: tg_id, filter (all/active/completed/today), q (search)
app.get('/api/tasks', (req, res) => {
  const tg_id = req.query.tg_id;
  const filter = req.query.filter || 'all';
  const q = req.query.q || '';
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });

  let where = `WHERE user_tg_id = ?`;
  const params = [tg_id];

  if (filter === 'active') where += ` AND completed = 0`;
  if (filter === 'completed') where += ` AND completed = 1`;
  if (filter === 'today') {
    where += ` AND date(due_at) = date('now','localtime')`;
  }
  if (q) {
    where += ` AND (title LIKE ? OR description LIKE ? OR tags LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }

  const sql = `SELECT * FROM tasks ${where} ORDER BY 
               CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, priority DESC`;
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ tasks: rows });
  });
});

// Update task (mark complete, edit fields)
app.put('/api/tasks/:id', (req, res) => {
  const id = req.params.id;
  const fields = req.body;
  // build set clause
  const sets = [];
  const params = [];
  ['title','description','tags','priority','due_at','completed','reminder_at','reminder_sent'].forEach(f=>{
    if (fields[f] !== undefined) {
      sets.push(`${f} = ?`);
      params.push(Array.isArray(fields[f]) ? fields[f].join(',') : fields[f]);
    }
  });
  if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });
  params.push(id);
  const sql = `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`;
  db.run(sql, params, function(err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get(`SELECT * FROM tasks WHERE id = ?`, [id], (e, task) => {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ task });
    });
  });
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const id = req.params.id;
  db.get(`SELECT * FROM tasks WHERE id = ?`, [id], (err, task) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!task) return res.status(404).json({ error: 'not found' });
    db.run(`DELETE FROM tasks WHERE id = ?`, [id], function(err2) {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ deleted: true });
    });
  });
});

// --- Simple archiver: delete completed tasks older than 30 days (run every hour)
setInterval(() => {
  db.run(`DELETE FROM tasks WHERE completed = 1 AND datetime(created_at) <= datetime('now','-30 days')`, (err) => {
    if (err) console.error("Archive error:", err.message);
  });
}, 1000 * 60 * 60); // hourly

// --- Reminder checker: each minute check tasks with reminder_at <= now and not reminder_sent
setInterval(() => {
  const now = new Date();
  db.all(`SELECT * FROM tasks WHERE reminder_at IS NOT NULL AND reminder_sent = 0 AND completed = 0 AND datetime(reminder_at) <= datetime('now','localtime')`, [], (err, rows) => {
    if (err) return console.error("Reminder check error:", err.message);
    rows.forEach(task => {
      const chatId = task.user_tg_id;
      const text = `🔔 Напоминание: ${task.title}\n${task.description || ''}\nДедлайн: ${task.due_at || '—'}`;
      bot.sendMessage(chatId, text).then(()=> {
        db.run(`UPDATE tasks SET reminder_sent = 1 WHERE id = ?`, [task.id]);
      }).catch(e=> console.error("Failed send reminder:", e.message));
    });
  });
}, 1000 * 60); // every minute

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Make sure this URL is accessible from Telegram (use ngrok in dev).`);
});
