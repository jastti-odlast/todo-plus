// public/app.js
// Simple client for ToDo+ MVP

const API_BASE = location.origin; // assumes server serves this file
let currentUser = null;
let editingTaskId = null;

document.addEventListener('DOMContentLoaded', async () => {
  await initTelegramAuth();
  initUI();
  await loadTasks();
});

async function initTelegramAuth(){
  // If opened inside Telegram WebApp, use initDataUnsafe to get user info quickly
  try {
    if (window.Telegram && Telegram.WebApp) {
      const info = Telegram.WebApp.initDataUnsafe || {};
      const user = info.user || {};
      if (!user.id) {
        // Not in tg webapp — ask user to paste tg id (fallback)
        const manual = prompt("Не обнаружен Telegram WebApp. Введите ваш Telegram ID (для теста):");
        if (!manual) throw new Error("No user");
        currentUser = { tg_id: manual };
        return;
      }
      currentUser = {
        tg_id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        username: user.username
      };
      // register on server
      await fetch(API_BASE + '/api/auth', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(currentUser)
      });
    } else {
      // not in webapp: quick fallback prompt for tg id
      const manual = prompt("Откройте ToDo+ внутри Telegram или введите ваш Telegram ID для теста:");
      if (!manual) throw new Error("No user");
      currentUser = { tg_id: manual };
    }
  } catch (e) {
    console.warn("auth init failed", e);
  }
}

function initUI(){
  document.getElementById('addBtn').addEventListener('click', ()=> openModal());
  document.getElementById('cancelBtn').addEventListener('click', closeModal);
  document.getElementById('saveBtn').addEventListener('click', saveTask);
  document.getElementById('filter').addEventListener('change', loadTasks);
  document.getElementById('search').addEventListener('input', debounce(loadTasks, 400));
  document.getElementById('themeToggle').addEventListener('click', toggleTheme);
}

function toggleTheme(){
  document.body.classList.toggle('dark');
}

function openModal(task){
  editingTaskId = task ? task.id : null;
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('modalTitle').innerText = task ? 'Редактировать задачу' : 'Добавить задачу';
  document.getElementById('title').value = task ? task.title : '';
  document.getElementById('description').value = task ? task.description : '';
  document.getElementById('tags').value = task ? (task.tags||'') : '';
  document.getElementById('due_at').value = task && task.due_at ? isoLocal(task.due_at) : '';
  document.getElementById('reminder_at').value = task && task.reminder_at ? isoLocal(task.reminder_at) : '';
  document.getElementById('priority').value = task ? task.priority : '0';
}

function closeModal(){
  document.getElementById('modal').classList.add('hidden');
}

async function saveTask(){
  const title = document.getElementById('title').value.trim();
  if (!title) return alert('Введите заголовок');
  const payload = {
    tg_id: currentUser.tg_id,
    title,
    description: document.getElementById('description').value,
    tags: document.getElementById('tags').value.split(',').map(s=>s.trim()).filter(Boolean),
    priority: Number(document.getElementById('priority').value) || 0,
    due_at: valOrNull(document.getElementById('due_at').value),
    reminder_at: valOrNull(document.getElementById('reminder_at').value)
  };
  if (editingTaskId) {
    await fetch(API_BASE + '/api/tasks/' + editingTaskId, {
      method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
  } else {
    await fetch(API_BASE + '/api/tasks', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
    });
  }
  closeModal();
  await loadTasks();
}

function valOrNull(v){ return v ? new Date(v).toISOString().slice(0,19).replace('T',' ') : null; }
function isoLocal(dbString){
  // dbString like "2025-10-30 12:34:00" -> local input value "2025-10-30T12:34"
  if (!dbString) return '';
  const d = new Date(dbString.replace(' ','T'));
  const pad = n=> (''+n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadTasks(){
  const filter = document.getElementById('filter').value;
  const q = document.getElementById('search').value.trim();
  const res = await fetch(API_BASE + `/api/tasks?tg_id=${encodeURIComponent(currentUser.tg_id)}&filter=${filter}&q=${encodeURIComponent(q)}`);
  const json = await res.json();
  renderTasks(json.tasks || []);
}

function renderTasks(tasks){
  const ul = document.getElementById('tasksList');
  ul.innerHTML = '';
  if (!tasks.length) {
    ul.innerHTML = '<li class="small">Задач нет</li>'; return;
  }
  tasks.forEach(t=>{
    const li = document.createElement('li');
    li.className = 'task';
    const left = document.createElement('div'); left.className='left';
    const cb = document.createElement('div'); cb.className='checkbox';
    cb.innerHTML = t.completed ? '✓' : '';
    cb.addEventListener('click', async ()=> {
      await fetch('/api/tasks/' + t.id, { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ completed: t.completed ? 0 : 1 })});
      loadTasks();
    });
    const title = document.createElement('div'); title.innerHTML = `<div class="title">${escapeHtml(t.title)}</div><div class="tags">${escapeHtml(t.tags||'')}</div>`;
    left.appendChild(cb); left.appendChild(title);
    const right = document.createElement('div');
    right.innerHTML = `<div class="small">${t.due_at ? t.due_at.slice(0,16) : ''}</div>
      <div style="display:flex;gap:6px;margin-top:6px">
        <button data-id="${t.id}" class="editBtn">Изменить</button>
        <button data-id="${t.id}" class="delBtn">Удалить</button>
      </div>`;
    li.appendChild(left); li.appendChild(right);
    ul.appendChild(li);
  });

  document.querySelectorAll('.editBtn').forEach(b=>{
    b.addEventListener('click', async (e)=>{
      const id = e.target.dataset.id;
      const r = await fetch('/api/tasks?tg_id=' + encodeURIComponent(currentUser.tg_id) + '&q=&filter=all');
      const j = await r.json();
      const task = j.tasks.find(x => String(x.id) === String(id));
      openModal(task);
    });
  });

  document.querySelectorAll('.delBtn').forEach(b=>{
    b.addEventListener('click', async (e)=>{
      const id = e.target.dataset.id;
      if (!confirm('Удалить задачу?')) return;
      await fetch('/api/tasks/' + id, { method:'DELETE' });
      loadTasks();
    });
  });
}

function escapeHtml(s){ if(!s) return ''; return s.replace(/[&<>"']/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function debounce(fn, t){ let tm; return (...a)=> { clearTimeout(tm); tm = setTimeout(()=>fn(...a), t); }; }
