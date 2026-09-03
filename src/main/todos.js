// ===== 任务待办服务 =====
// 待办数据存储在用户数据目录 todos.json（跨工作区共享）
const fs = require('fs');
const path = require('path');

function todosFile() {
  const dir = path.join(require('electron').app.getPath('userData'), 'study-assistant');
  return path.join(dir, 'todos.json');
}
function readTodos() {
  const fp = todosFile();
  if (!fs.existsSync(fp)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeTodos(arr) {
  const fp = todosFile();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
}
// 同步版本字段：标记记录已修改（version+1, updatedAt=now）
function touch(rec) {
  rec.version = (rec.version || 1) + 1;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

// 一周毫秒数
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

// 循环周期配置（毫秒）
const RECUR_MS = {
  daily: DAY_MS,
  weekly: WEEK_MS,
  biweekly: 2 * WEEK_MS,
  monthly: 30 * DAY_MS
};

// 循环任务：若为循环任务且已完成超过一个周期，则自动重置为未完成
function applyRecurring(arr) {
  const now = Date.now();
  let changed = false;
  for (const t of arr) {
    if (t.recurring && t.done && t.doneAt) {
      const ms = RECUR_MS[t.recurring];
      if (!ms) continue;
      const doneMs = new Date(t.doneAt).getTime();
      if (now - doneMs >= ms) {
        t.done = false;
        t.doneAt = '';
        changed = true;
      }
    }
  }
  if (changed) writeTodos(arr);
}

// 列出全部待办（未完成在前，按创建时间倒序）
function listTodos() {
  const arr = readTodos();
  applyRecurring(arr);
  const sorted = arr.slice().sort((a, b) => {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    return (b.createdAt || '').localeCompare(a.createdAt || '');
  });
  return { ok: true, todos: sorted };
}

// 新增待办：{ text, priority, due, recurring }
function addTodo(data) {
  const text = String((data && data.text) || '').trim();
  if (!text) return { ok: false, message: '请输入待办内容' };
  const arr = readTodos();
  const todo = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text,
    priority: (data && data.priority) || 'normal',
    due: (data && data.due) || '',
    recurring: (data && data.recurring) || '',
    done: false,
    createdAt: new Date().toISOString(),
    doneAt: '',
    updatedAt: new Date().toISOString(),
    version: 1
  };
  arr.push(todo);
  writeTodos(arr);
  return { ok: true, todo };
}

// 切换完成状态
function toggleTodo(id) {
  const arr = readTodos();
  const t = arr.find((x) => x.id === id);
  if (!t) return { ok: false, message: '待办不存在' };
  t.done = !t.done;
  t.doneAt = t.done ? new Date().toISOString() : '';
  touch(t);
  writeTodos(arr);
  return { ok: true, todo: t };
}

// 编辑待办内容
function updateTodo(id, data) {
  const arr = readTodos();
  const t = arr.find((x) => x.id === id);
  if (!t) return { ok: false, message: '待办不存在' };
  if (data && data.text !== undefined) t.text = String(data.text).trim() || t.text;
  if (data && data.priority !== undefined) t.priority = data.priority;
  if (data && data.due !== undefined) t.due = data.due;
  if (data && data.recurring !== undefined) t.recurring = data.recurring;
  touch(t);
  writeTodos(arr);
  return { ok: true, todo: t };
}

// 删除待办（软删除，便于同步传播）
function deleteTodo(id) {
  const arr = readTodos();
  const t = arr.find((x) => x.id === id);
  if (!t) return { ok: false, message: '待办不存在' };
  t.deleted = true;
  touch(t);
  writeTodos(arr);
  return { ok: true, id, text: t.text };
}

// 同步用：整体替换待办列表（合并后写回）
function replaceAll(arr) {
  writeTodos(Array.isArray(arr) ? arr : []);
  return { ok: true };
}

module.exports = { listTodos, addTodo, toggleTodo, updateTodo, deleteTodo, replaceAll };
