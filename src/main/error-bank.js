// ===== 统一错题库服务（网页适配版） =====
// 设计说明：
//   错题仍按科目存储在各科 md 文件中（如 数学.md），以保持 docsify 网页按科目展示不受影响。
//   错题标题格式保持为：#### 错题 <科目内序号>：<题目类型>（标题中不展示全局错题编号）
//   全局唯一错题编号仅作为软件内部调用标识，存储在 错题库/index.json 中。
//   错题组、熟悉程度、关联试卷等元数据也统一存储在 错题库/index.json。
//   软件内所有对错题的调用，一律通过唯一错题编号进行。
//
// 目录结构：
//   错题库/index.json   —— 错题索引（编号、类型、科目、文件、科目内序号、熟悉程度、错题组、关联试卷等）
//   错题库/groups.json  —— 错题组定义（如「高二上」「高三一轮」）

const fs = require('fs');
const path = require('path');

// ===== 熟悉程度（借鉴艾宾浩斯遗忘曲线 / 掌握程度分级） =====
const FAMILIARITY = {
  unfamiliar: { label: '生疏', color: '#ef4444', desc: '完全不会，需重点复习' },
  vague:      { label: '模糊', color: '#f97316', desc: '有印象但做不对' },
  medium:     { label: '中等', color: '#f59e0b', desc: '会做但易错（默认）' },
  familiar:   { label: '熟悉', color: '#22c55e', desc: '较熟练，偶尔出错' },
  mastered:   { label: '掌握', color: '#0ea5e9', desc: '完全掌握' }
};
const DEFAULT_FAMILIARITY = 'medium';
// 内置默认错题组：所有新错题默认归入该组，且该组不可删除
const DEFAULT_GROUP = '默认';

// 需要跳过的非科目 md 文件
const SKIP_FILES = ['README.md', '_sidebar.md', '分数预测.md', '编辑注意事项.md'];

function bankDir(ws) { return ws.resolve('错题库'); }
function indexFile(ws) { return path.join(bankDir(ws), 'index.json'); }
function groupsFile(ws) { return path.join(bankDir(ws), 'groups.json'); }

function readIndex(ws) {
  const fp = indexFile(ws);
  if (!fs.existsSync(fp)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeIndex(ws, arr) {
  fs.mkdirSync(bankDir(ws), { recursive: true });
  fs.writeFileSync(indexFile(ws), JSON.stringify(arr, null, 2), 'utf8');
}
function readGroups(ws) {
  const fp = groupsFile(ws);
  if (!fs.existsSync(fp)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeGroups(ws, arr) {
  fs.mkdirSync(bankDir(ws), { recursive: true });
  fs.writeFileSync(groupsFile(ws), JSON.stringify(arr, null, 2), 'utf8');
}
// 同步版本字段：标记记录已修改（version+1, updatedAt=now）
function touch(rec) {
  rec.version = (rec.version || 1) + 1;
  rec.updatedAt = new Date().toISOString();
  return rec;
}
function readMd(ws, rel) {
  const fp = ws.resolve(rel);
  if (!fs.existsSync(fp)) return null;
  let s = fs.readFileSync(fp, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  // 统一换行为 \n，便于正则解析（写入时按原文件风格还原）
  return s.replace(/\r\n/g, '\n');
}
function writeMd(ws, rel, content) {
  const fp = ws.resolve(rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // 保持原文件换行风格：若原文件为 CRLF，则写回时还原为 CRLF，避免整文件 diff
  let eol = '\n';
  try {
    if (fs.existsSync(fp)) {
      const raw = fs.readFileSync(fp, 'utf8');
      if (raw.includes('\r\n')) eol = '\r\n';
    }
  } catch (e) { /* 忽略 */ }
  const body = String(content || '').replace(/\r\n/g, '\n').replace(/\n/g, eol);
  fs.writeFileSync(fp, '\uFEFF' + body, 'utf8');
}

// 生成唯一错题编号：E-<年份>-<6位随机码>
// 采用随机码而非递增序号，避免序号位数增长问题，且编号更复杂、更唯一。
// 随机码字符集剔除易混淆字符（0/O、1/l/I），生成时检查唯一性，碰撞则重试。
const NUMBER_CHARS = '23456789abcdefghjkmnpqrstuvwxyz';
function randomCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) s += NUMBER_CHARS[Math.floor(Math.random() * NUMBER_CHARS.length)];
  return s;
}
// usedSet：已占用编号集合（用于 scanAndRebuild 批量分配时保证唯一）
function nextNumber(ws, usedSet) {
  const year = new Date().getFullYear();
  const used = usedSet || new Set(readIndex(ws).map((e) => e.number));
  let code;
  do { code = randomCode(6); } while (used.has('E-' + year + '-' + code));
  const num = 'E-' + year + '-' + code;
  used.add(num);
  return num;
}

// 计算某科目文件内当前最大错题序号
function maxSeqInFile(ws, file) {
  const md = readMd(ws, file);
  if (md == null) return 0;
  let max = 0;
  const re = /^#{2,4}\s*错题\s*(\d+)\s*[：:]/gm;
  let m;
  while ((m = re.exec(md))) { const v = parseInt(m[1], 10); if (v > max) max = v; }
  return max;
}

// 从错题块内容中解析来源 / 录入时间（兼容现有 md 格式）
function parseBlockMeta(block) {
  const meta = { source: '', date: '' };
  if (!block) return meta;
  const src = block.match(/-\s*\*\*来源\*\*\s*[：:]\s*([^\n]+)/);
  if (src) meta.source = src[1].trim();
  const dt = block.match(/-\s*\*\*录入时间\*\*\s*[：:]\s*([^\n]+)/);
  if (dt) meta.date = dt[1].trim();
  return meta;
}

// 提取某科目 md 中第 n 道错题的完整块内容（含标题行）
// 不用 m 标志：让 $ 匹配字符串末尾（而非每个行尾），从而正确处理「最后一道错题」。
// lookahead 匹配下一个错题标题 / ## 章节标题 / 文件末尾。
function extractBlock(md, n) {
  if (md == null) return '';
  const re = new RegExp('(^|\\n)(#{2,4}\\s*错题\\s*' + n + '\\s*[：:][^\\n]*\\n[\\s\\S]*?)(?=\\n#{2,4}\\s*错题\\s*\\d+\\s*[：:]|\\n#{2,4}\\s*(?!错题)|$)', '');
  const m = md.match(re);
  return m ? m[2] : '';
}

// 扫描各科 md 文件，重建错题索引（用于首次初始化 / 同步）
// 为每道错题分配全局唯一错题编号（若已存在则保留原编号）
// 现有错题（无索引记录）自动分配编号，并从 md 块解析来源/录入时间
function scanAndRebuild(ws) {
  const root = ws.root();
  const oldIndex = readIndex(ws);
  const oldByKey = {};
  oldIndex.forEach((e) => { oldByKey[e.file + '#' + e.n] = e; });
  // 已占用编号集合：旧索引中的编号 + 本次新分配的编号，保证全局唯一
  const usedSet = new Set(oldIndex.map((e) => e.number));
  const index = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return { ok: false, message: '无法读取工作区' }; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    if (SKIP_FILES.includes(f)) continue;
    const md = readMd(ws, f);
    if (md == null) continue;
    const subject = f.replace(/\.md$/, '');
    const re = /^#{2,4}\s*错题\s*(\d+)\s*[：:]\s*(.*)$/gm;
    let m;
    while ((m = re.exec(md))) {
      const n = parseInt(m[1], 10);
      const key = f + '#' + n;
      const old = oldByKey[key];
      // 提取该错题块内容（用于解析来源/日期）
      const meta = parseBlockMeta(extractBlock(md, n));
      index.push({
        number: (old && old.number) || nextNumber(ws, usedSet),
        type: (m[2] || '').trim(),
        subject,
        file: f,
        n,
        familiarity: (old && old.familiarity) || DEFAULT_FAMILIARITY,
        group: (old && old.group) || DEFAULT_GROUP,
        source: (old && old.source) || meta.source || '',
        date: (old && old.date) || meta.date || '',
        linkedPapers: (old && Array.isArray(old.linkedPapers)) ? old.linkedPapers : [],
        createdAt: (old && old.createdAt) || '',
        updatedAt: (old && old.updatedAt) || ''
      });
    }
  }
  writeIndex(ws, index);
  return { ok: true, count: index.length };
}

// 列出全部错题（含元数据）
function listErrors(ws) {
  const arr = readIndex(ws);
  const out = arr.map((e) => ({
    number: e.number,
    type: e.type || '',
    subject: e.subject || '',
    file: e.file || '',
    n: e.n || 0,
    familiarity: e.familiarity || DEFAULT_FAMILIARITY,
    group: e.group || '',
    source: e.source || '',
    date: e.date || '',
    createdAt: e.createdAt || '',
    updatedAt: e.updatedAt || '',
    version: e.version || 1,
    deleted: !!e.deleted,
    linkedPapers: Array.isArray(e.linkedPapers) ? e.linkedPapers : []
  }));
  return { ok: true, errors: out };
}

// 新增错题：{ type, subject, familiarity, group, source, date, content }
// 写入对应科目 md 文件（标题 = 题目类型，不含全局编号），并登记索引
function addError(ws, data) {
  const type = String((data && data.type) || '').trim();
  if (!type) return { ok: false, message: '请输入题目类型' };
  const subject = String((data && data.subject) || '').trim() || '未分类';
  const file = subject + '.md';
  const number = nextNumber(ws);
  const n = maxSeqInFile(ws, file) + 1;
  const familiarity = FAMILIARITY[data && data.familiarity] ? data.familiarity : DEFAULT_FAMILIARITY;
  const group = String((data && data.group) || '').trim() || DEFAULT_GROUP;
  const source = String((data && data.source) || '').trim();
  const date = String((data && data.date) || '').trim();
  const now = new Date().toISOString();

  // 标题 = 题目类型（不含全局编号）
  const content = String((data && data.content) || '').trim();
  const block = '#### 错题 ' + n + '：' + type + '\n\n' +
    (content ? content + '\n' : '') +
    '\n---\n\n> 科目：' + subject + '　熟悉程度：' + (FAMILIARITY[familiarity] ? FAMILIARITY[familiarity].label : familiarity) +
    (group ? '　错题组：' + group : '') +
    (source ? '　来源：' + source : '') +
    (date ? '　录入日期：' + date : '') + '\n';

  // 追加到科目 md 文件
  const hasEssay = !!(data && data.hasEssay);
  const md = readMd(ws, file) || ('# ' + subject + '档案\n\n> 最后更新：' + new Date().toLocaleDateString('zh-CN') + '\n\n## 一、错题\n\n### 错题记录\n' + (hasEssay ? '\n---\n\n## 二、作文\n\n### 作文记录\n' : ''));
  writeMd(ws, file, md.replace(/\s*$/, '') + '\n\n' + block);

  const arr = readIndex(ws);
  arr.push({
    number, type, subject, file, n, familiarity, group, source, date,
    linkedPapers: [], createdAt: now, updatedAt: now, version: 1
  });
  writeIndex(ws, arr);
  return { ok: true, error: { number, type, subject, n, familiarity, group, source, date } };
}

// 按编号读取错题（含内容）
function getError(ws, number) {
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (!e) return { ok: false, message: '错题不存在: ' + number };
  const md = readMd(ws, e.file);
  const content = extractBlock(md, e.n);
  return { ok: true, error: e, content: content || (md || '') };
}

// 更新错题元数据（熟悉程度 / 错题组 / 类型 / 科目 等）
function updateError(ws, number, data) {
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (!e) return { ok: false, message: '错题不存在: ' + number };
  if (data && data.type !== undefined) e.type = String(data.type).trim() || e.type;
  if (data && data.subject !== undefined) e.subject = String(data.subject).trim() || e.subject;
  if (data && data.familiarity !== undefined && FAMILIARITY[data.familiarity]) e.familiarity = data.familiarity;
  if (data && data.group !== undefined) e.group = String(data.group).trim();
  if (data && data.source !== undefined) e.source = String(data.source).trim();
  if (data && data.date !== undefined) e.date = String(data.date).trim();
  touch(e);
  writeIndex(ws, arr);
  return { ok: true, error: e };
}

// 删除错题（从科目 md 移除该块，并软删除索引条目以便同步传播）
function deleteError(ws, number) {
  const arr = readIndex(ws);
  const idx = arr.findIndex((x) => x.number === number);
  if (idx === -1) return { ok: false, message: '错题不存在: ' + number };
  const e = arr[idx];
  const md = readMd(ws, e.file);
  if (md != null) {
    // 删除整个错题块（含标题行）；不用 m 标志，$ 匹配字符串末尾以处理最后一道错题
    const re = new RegExp('(^|\\n)#{2,4}\\s*错题\\s*' + e.n + '\\s*[：:][^\\n]*\\n[\\s\\S]*?(?=\\n#{2,4}\\s*错题\\s*\\d+\\s*[：:]|\\n#{2,4}\\s*(?!错题)|$)', '');
    const nmd = md.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
    writeMd(ws, e.file, nmd + '\n');
  }
  // 软删除：标记 deleted 而非物理移除，便于同步传播删除
  e.deleted = true;
  touch(e);
  writeIndex(ws, arr);
  // 删除该错题的附件目录
  const adir = attachmentsDir(ws, number);
  if (fs.existsSync(adir)) { try { fs.rmSync(adir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
  return { ok: true, number, type: e.type };
}

// 全文搜索错题（含题目 / 错因 / 解法 等），返回带编号的匹配
function searchErrors(ws, q) {
  const needle = String(q || '').toLowerCase();
  if (!needle) return { ok: true, matches: [] };
  const arr = readIndex(ws);
  const matches = [];
  for (const e of arr) {
    const md = readMd(ws, e.file);
    const block = extractBlock(md, e.n);
    if (!block) continue;
    if (block.toLowerCase().indexOf(needle) === -1) continue;
    // 生成摘要：定位关键词附近文本
    let snippet = '';
    const idx = block.toLowerCase().indexOf(needle);
    if (idx >= 0) {
      const start = Math.max(0, idx - 30);
      const end = Math.min(block.length, idx + needle.length + 60);
      snippet = (start > 0 ? '…' : '') + block.slice(start, end).replace(/\s+/g, ' ').trim() + (end < block.length ? '…' : '');
    }
    matches.push({
      number: e.number, subject: e.subject, file: e.file, n: e.n,
      type: e.type || '', title: e.type || '', snippet
    });
    if (matches.length >= 200) break;
  }
  return { ok: true, matches };
}

// ===== 错题组管理 =====
function ensureDefaultGroup(ws) {
  const arr = readGroups(ws);
  if (!arr.some((g) => g.name === DEFAULT_GROUP)) {
    arr.unshift({ id: 'default', name: DEFAULT_GROUP, builtin: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 });
    writeGroups(ws, arr);
  }
  // 为旧数据补齐同步字段
  let changed = false;
  arr.forEach((g) => {
    if (g.updatedAt === undefined) { g.updatedAt = g.createdAt || new Date().toISOString(); changed = true; }
    if (g.version === undefined) { g.version = 1; changed = true; }
    if (g.deleted === undefined) { g.deleted = false; changed = true; }
  });
  if (changed) writeGroups(ws, arr);
  return arr;
}
function listGroups(ws) {
  return { ok: true, groups: ensureDefaultGroup(ws) };
}
function addGroup(ws, name) {
  const n = String((name && typeof name === 'object' && name.name) || name || '').trim();
  if (!n) return { ok: false, message: '请输入错题组名称' };
  if (n === DEFAULT_GROUP) return { ok: false, message: '「' + DEFAULT_GROUP + '」为内置错题组，无需创建' };
  const arr = ensureDefaultGroup(ws);
  if (arr.some((g) => g.name === n)) return { ok: false, message: '错题组已存在' };
  const g = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name: n, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), version: 1 };
  arr.push(g);
  writeGroups(ws, arr);
  return { ok: true, group: g };
}
function deleteGroup(ws, id, opts) {
  const arr = readGroups(ws);
  const idx = arr.findIndex((g) => g.id === id);
  if (idx === -1) return { ok: false, message: '错题组不存在' };
  const g = arr[idx];
  if (g.name === DEFAULT_GROUP || g.builtin) return { ok: false, message: '「' + DEFAULT_GROUP + '」为内置错题组，不可删除' };
  const opt = opts || {};
  const moveTo = String(opt.moveTo || '').trim();
  const deleteErrors = !!opt.deleteErrors;
  // 校验转移目标：不能转移到自身，且目标必须存在
  if (moveTo && moveTo !== g.name && !arr.some((x) => x.name === moveTo)) {
    return { ok: false, message: '目标错题组不存在' };
  }
  // 软删除错题组（标记 deleted 而非物理移除，便于同步传播）
  g.deleted = true;
  touch(g);
  writeGroups(ws, arr);
  const idxArr = readIndex(ws);
  const inGroup = idxArr.filter((e) => e.group === g.name);
  if (deleteErrors) {
    // 全部直接删除：删除该组下所有错题（含档案条目与附件）
    for (const e of inGroup) {
      const md = readMd(ws, e.file);
      if (md != null) {
        const re = new RegExp('(^|\\n)#{2,4}\\s*错题\\s*' + e.n + '\\s*[：:][^\\n]*\\n[\\s\\S]*?(?=\\n#{2,4}\\s*错题\\s*\\d+\\s*[：:]|\\n#{2,4}\\s*(?!错题)|$)', '');
        const nmd = md.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trim();
        writeMd(ws, e.file, nmd + '\n');
      }
      const adir = attachmentsDir(ws, e.number);
      if (fs.existsSync(adir)) { try { fs.rmSync(adir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
      // 软删除错题索引条目
      e.deleted = true;
      touch(e);
    }
    writeIndex(ws, idxArr);
    return { ok: true, id, name: g.name, deleted: inGroup.length, mode: 'delete' };
  }
  // 转移或取消分组（未指定目标时归入「默认」组）
  let changed = false;
  idxArr.forEach((e) => {
    if (e.group === g.name) {
      e.group = moveTo || DEFAULT_GROUP;
      touch(e);
      changed = true;
    }
  });
  if (changed) writeIndex(ws, idxArr);
  return { ok: true, id, name: g.name, moved: inGroup.length, mode: moveTo ? 'move' : 'ungroup' };
}

// 移动错题到指定错题组（支持批量）
function moveErrorsToGroup(ws, numbers, groupName) {
  const arr = readIndex(ws);
  const set = new Set(Array.isArray(numbers) ? numbers : []);
  let moved = 0;
  arr.forEach((e) => {
    if (set.has(e.number)) { e.group = String(groupName || '').trim() || DEFAULT_GROUP; touch(e); moved++; }
  });
  writeIndex(ws, arr);
  return { ok: true, moved };
}

// 设置错题熟悉程度（支持批量）
function setFamiliarity(ws, numbers, familiarity) {
  if (!FAMILIARITY[familiarity]) return { ok: false, message: '无效的熟悉程度' };
  const arr = readIndex(ws);
  const set = new Set(Array.isArray(numbers) ? numbers : []);
  let updated = 0;
  arr.forEach((e) => {
    if (set.has(e.number)) { e.familiarity = familiarity; touch(e); updated++; }
  });
  writeIndex(ws, arr);
  return { ok: true, updated };
}

// 关联试卷到错题
function linkPaper(ws, number, paper) {
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (!e) return { ok: false, message: '错题不存在: ' + number };
  if (!Array.isArray(e.linkedPapers)) e.linkedPapers = [];
  const pid = String((paper && paper.id) || '');
  if (pid && !e.linkedPapers.some((p) => p.id === pid)) {
    e.linkedPapers.push({ id: pid, name: String((paper && paper.name) || ''), subject: String((paper && paper.subject) || '') });
  }
  writeIndex(ws, arr);
  return { ok: true, linkedPapers: e.linkedPapers };
}
function unlinkPaper(ws, number, paperId) {
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (!e) return { ok: false, message: '错题不存在: ' + number };
  if (!Array.isArray(e.linkedPapers)) e.linkedPapers = [];
  e.linkedPapers = e.linkedPapers.filter((p) => p.id !== paperId);
  writeIndex(ws, arr);
  return { ok: true, linkedPapers: e.linkedPapers };
}

// ===== 错题附件（压缩后存储，节省空间） =====
// 附件目录：错题库/attachments/<number>/<文件名>
function attachmentsDir(ws, number) { return path.join(bankDir(ws), 'attachments', String(number || '')); }
function safeFileName(name) {
  return String(name || 'attachment').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_');
}
// 列出某错题的附件（含大小）
function listAttachments(ws, number) {
  const dir = attachmentsDir(ws, number);
  const out = [];
  if (fs.existsSync(dir)) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const fp = path.join(dir, f);
        try { out.push({ name: f, size: fs.statSync(fp).size }); } catch (e) { /* 忽略 */ }
      }
    } catch (e) { /* 忽略 */ }
  }
  return { ok: true, attachments: out };
}
// 保存附件：dataUrl 形如 data:image/jpeg;base64,xxx
function addAttachment(ws, number, data) {
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (!e) return { ok: false, message: '错题不存在: ' + number };
  const dataUrl = String((data && data.dataUrl) || '');
  const m = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return { ok: false, message: '无效的附件数据' };
  const ext = (m[1].split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
  const name = safeFileName((data && data.name) || ('attachment.' + ext));
  const dir = attachmentsDir(ws, number);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.from(m[2], 'base64'));
  // 记录附件元数据到索引
  if (!Array.isArray(e.attachments)) e.attachments = [];
  if (!e.attachments.some((a) => a.name === name)) e.attachments.push({ name, size: fs.statSync(path.join(dir, name)).size });
  e.updatedAt = new Date().toISOString();
  writeIndex(ws, arr);
  return { ok: true, attachment: { name, size: fs.statSync(path.join(dir, name)).size } };
}
// 读取附件为 dataUrl
function readAttachment(ws, number, name) {
  const fp = path.join(attachmentsDir(ws, number), safeFileName(name));
  if (!fs.existsSync(fp)) return { ok: false, message: '附件不存在' };
  const buf = fs.readFileSync(fp);
  const ext = path.extname(fp).replace('.', '').toLowerCase();
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf' }[ext] || 'application/octet-stream';
  return { ok: true, dataUrl: 'data:' + mime + ';base64,' + buf.toString('base64') };
}
// 删除附件
function deleteAttachment(ws, number, name) {
  const fp = path.join(attachmentsDir(ws, number), safeFileName(name));
  if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) { /* 忽略 */ } }
  const arr = readIndex(ws);
  const e = arr.find((x) => x.number === number);
  if (e && Array.isArray(e.attachments)) {
    e.attachments = e.attachments.filter((a) => a.name !== safeFileName(name));
    writeIndex(ws, arr);
  }
  return { ok: true };
}

// 同步用：整体替换错题索引（合并后写回）
function replaceAllErrors(ws, arr) {
  writeIndex(ws, Array.isArray(arr) ? arr : []);
  return { ok: true };
}
// 同步用：整体替换错题组（合并后写回）
function replaceAllGroups(ws, arr) {
  writeGroups(ws, Array.isArray(arr) ? arr : []);
  return { ok: true };
}

module.exports = {
  FAMILIARITY, DEFAULT_FAMILIARITY, DEFAULT_GROUP,
  scanAndRebuild, listErrors, addError, getError, updateError, deleteError, searchErrors,
  listGroups, addGroup, deleteGroup, moveErrorsToGroup, setFamiliarity,
  linkPaper, unlinkPaper,
  listAttachments, addAttachment, readAttachment, deleteAttachment,
  replaceAllErrors, replaceAllGroups
};
