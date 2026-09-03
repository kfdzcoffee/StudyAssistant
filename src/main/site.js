// ===== 站点数据服务：README 档案 / 统计 / 首页题目数量 =====
const fs = require('fs');
const path = require('path');

function readMd(ws, rel) {
  const fp = ws.resolve(rel);
  if (!fs.existsSync(fp)) return null;
  let s = fs.readFileSync(fp, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return s;
}
function writeMd(ws, rel, content) {
  const fp = ws.resolve(rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, '\uFEFF' + (content || ''), 'utf8');
}
function today() {
  const d = new Date();
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function parseLink(cell) {
  const m = (cell || '').match(/\[([^\]]*)\]\(([^)]*)\)/);
  return m ? { text: m[1], url: m[2] } : { text: cell || '', url: '' };
}
function parseImage(cell) {
  const m = (cell || '').match(/!\[[^\]]*\]\(([^)]*)\)/);
  return m ? m[1] : '';
}
function section(md, heading) {
  const idx = md.indexOf(heading);
  if (idx === -1) return null;
  const from = idx + heading.length;
  const next = md.indexOf('\n## ', from);
  const end = next === -1 ? md.length : next;
  return { start: idx, end, text: md.slice(idx, end) };
}
function esc(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ===== 读取错题索引：构建 file#n -> 唯一错题编号 的映射 =====
// 用于让 sidebar 链接锚点 = 唯一错题编号（如 #E-2026-xxxxxx），与正文标题锚点一致
function readErrorNumberMap(ws) {
  const fp = ws.resolve('错题库/index.json');
  const map = {};
  if (!fs.existsSync(fp)) return map;
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    if (Array.isArray(arr)) {
      arr.forEach((e) => {
        if (e && e.file && e.n && e.number) map[e.file + '#' + e.n] = e.number;
      });
    }
  } catch (e) { /* 忽略解析失败 */ }
  return map;
}

// ===== 解析 README 目标院校 + 关于作者 =====
function parseProfile(ws) {
  const md = readMd(ws, 'README.md');
  if (md == null) return { ok: false, message: 'README.md 不存在' };
  const universities = [];
  const sec = section(md, '## 🎯 目标院校');
  if (sec) {
    sec.text.split('\n').forEach((line) => {
      const t = line.trim();
      if (!t.startsWith('|')) return;
      const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      if (!/^⭐\s*\d+$/.test(cells[0])) return;
      universities.push({
        priority: parseInt(cells[0].replace(/[^\d]/g, ''), 10) || 1,
        image: parseImage(cells[1] || ''),
        name: (cells[2] || '').replace(/\*\*/g, ''),
        official: parseLink(cells[3] || ''),
        admissions: parseLink(cells[4] || '')
      });
    });
  }
  const about = { intro: '', website: { text: '个人网站', url: '' }, blog: { text: '个人博客', url: '' } };
  const sec2 = section(md, '## 关于作者');
  if (sec2) {
    const body = sec2.text.slice(sec2.text.indexOf('\n') + 1);
    body.split('\n').forEach((line) => {
      const t = line.trim();
      const wm = t.match(/^-?\s*个人网站[：:]?\s*(\[[^\]]*\]\([^)]*\))/);
      if (wm) about.website = parseLink(wm[1]);
      const bm = t.match(/^-?\s*个人博客[：:]?\s*(\[[^\]]*\]\([^)]*\))/);
      if (bm) about.blog = parseLink(bm[1]);
      if (t && !t.startsWith('-') && !t.startsWith('#') && !about.intro && t.length > 3) about.intro = t;
    });
  }
  return { ok: true, universities, about };
}

function saveProfile(ws, data) {
  const md = readMd(ws, 'README.md');
  if (md == null) return { ok: false, message: 'README.md 不存在' };
  const unis = data.universities || [];
  let table = '## 🎯 目标院校\n\n> 心之所向，素履以往。每一道错题，都是离梦想更近一步。\n\n';
  table += '| 优先级 | | 院校 | 官网 | 本科招生网 |\n|:---:|:---:|------|:---:|:---:|\n';
  unis.forEach((u) => {
    table += '| ⭐' + u.priority + ' | ' + (u.image ? '![](' + u.image + ')' : '') +
      ' | **' + u.name + '** | [' + u.official.text + '](' + u.official.url + ') | [' +
      u.admissions.text + '](' + u.admissions.url + ') |\n';
  });
  let out = md;
  const sec = section(out, '## 🎯 目标院校');
  if (sec) out = out.slice(0, sec.start) + table + out.slice(sec.end);
  else out = out.replace(/^---/, '---\n\n' + table);

  const a = data.about || {};
  const aboutTxt = '## 关于作者\n\n' +
    (a.intro ? a.intro + '\n\n' : '') +
    '- 个人网站：[' + a.website.text + '](' + a.website.url + ')\n' +
    '- 个人博客：[' + a.blog.text + '](' + a.blog.url + ')\n';
  const sec2 = section(out, '## 关于作者');
  if (sec2) out = out.slice(0, sec2.start) + aboutTxt + out.slice(sec2.end);
  writeMd(ws, 'README.md', out);
  return { ok: true };
}

// 上传院校图片到工作目录 images/
function uploadProfileImage(ws, { name, data }) {
  if (!name || !data) return { ok: false, message: '缺少图片数据' };
  const safe = name.replace(/[\\/:*?"<>|]/g, '_');
  const rel = 'images/' + safe;
  const fp = ws.resolve(rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, Buffer.from(data, 'base64'));
  return { ok: true, path: rel };
}

// ===== 各科统计 =====
function subjectStats(ws) {
  const root = ws.root();
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return out; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    if (['README.md', '_sidebar.md', '分数预测.md', '编辑注意事项.md'].includes(f)) continue;
    const md = readMd(ws, f);
    if (md == null) continue;
    const errors = [];
    let m;
    const re = /^#{2,4}\s*错题\s*(\d+)\s*[：:]\s*(.*)$/gm;
    while ((m = re.exec(md))) errors.push({ n: parseInt(m[1], 10), title: (m[2] || '').trim() });
    const essays = [];
    // 作文 N：标题（### 作文 3：《…》/ ### 练习作文 1：…）
    const re2 = /^#{2,4}\s*(?:作文|练习作文|考场作文|新作文|作文分析)\s*(\d+)?\s*[：:]\s*(.*)$/gm;
    while ((m = re2.exec(md))) essays.push({ n: parseInt(m[1] || 0, 10), title: (m[2] || '').trim() });
    // 编号作文小节（### 2.1 《…》）
    const re3 = /^#{2,4}\s*\d+\.\d+\s*(《[^》]*》[^\n]*)/gm;
    while ((m = re3.exec(md))) essays.push({ n: 0, title: m[1].trim() });
    // 中文序号作文小节（## 三、…作文：《…》/ ## 五、新作文：《…》）
    const re4 = /^#{2,4}\s*[一二三四五六七八九十]+、([^\n《]*《[^》]*》[^\n]*)$/gm;
    while ((m = re4.exec(md))) essays.push({ n: 0, title: m[1].trim() });
    const dateM = md.match(/最后更新[：:]\s*([^\n]+)/);
    out.push({ subject: f.replace(/\.md$/, ''), file: f, errors, essays, date: dateM ? dateM[1].trim() : '' });
  }
  return out;
}

// ===== 更新 README 首页题目数量与日期 =====
function updateReadmeStats(ws) {
  const stats = subjectStats(ws);
  const md = readMd(ws, 'README.md');
  if (md == null) return { ok: false, message: 'README.md 不存在' };
  let errTotal = 0, essayTotal = 0;
  stats.forEach((s) => { errTotal += s.errors.length; essayTotal += s.essays.length; });
  let out = md;
  // 只替换日期部分（该行还含题目数量，不能整行覆盖）
  out = out.replace(/(最后更新[：:]\s*)[^|\n]*/, '$1' + today() + ' ');
  out = out.replace(/共\s*\d+\s*题（错题\s*\d+\s*道\s*\+\s*作文\s*\d+\s*篇）|共\s*\d+\s*题/,
    '共' + (errTotal + essayTotal) + '题（错题' + errTotal + '道 + 作文' + essayTotal + '篇）');
  stats.forEach((s) => {
    const parts = [];
    if (s.errors.length) parts.push('错题' + s.errors.length + '道');
    if (s.essays.length) parts.push('作文' + s.essays.length + '篇');
    const cnt = parts.join(' + ') || '0';
    const rowRe = new RegExp('\\|\\s*' + esc(s.subject) + '\\s*\\|[^|]*\\|[^|]*\\|');
    out = out.replace(rowRe, '| ' + s.subject + ' | — | ' + cnt + ' |');
  });
  writeMd(ws, 'README.md', out);
  return { ok: true, stats };
}

// ===== 错题全文搜索（含题目内容）=====
function extractSnippet(block, q) {
  const lines = String(block || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const idx = lines[i].toLowerCase().indexOf(q);
    if (idx !== -1) {
      const from = Math.max(0, idx - 30);
      const to = Math.min(lines[i].length, idx + q.length + 70);
      let s = lines[i].slice(from, to).trim();
      if (from > 0) s = '…' + s;
      if (to < lines[i].length) s = s + '…';
      return s;
    }
  }
  return '';
}

function searchErrors(ws, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const root = ws.root();
  const matches = [];
  let entries = [];
  try { entries = fs.readdirSync(root); } catch (e) { return matches; }
  for (const f of entries) {
    if (!f.toLowerCase().endsWith('.md')) continue;
    if (['README.md', '_sidebar.md', '分数预测.md', '编辑注意事项.md'].includes(f)) continue;
    const md = readMd(ws, f);
    if (md == null) continue;
    // 按「错题 N」标题切块，逐块搜索（覆盖标题 / 题目 / 错因 / 解法 等）
    const blocks = md.split(/\n(?=#{2,4}\s*错题\s*\d+\s*[：:])/);
    for (const b of blocks) {
      const hm = b.match(/^#{2,4}\s*错题\s*(\d+)\s*[：:]\s*(.*)$/m);
      if (!hm) continue;
      if (b.toLowerCase().indexOf(q) === -1) continue;
      matches.push({
        subject: f.replace(/\.md$/, ''),
        file: f,
        n: parseInt(hm[1], 10),
        title: (hm[2] || '').trim(),
        snippet: extractSnippet(b, q)
      });
      if (matches.length >= 200) break;
    }
    if (matches.length >= 200) break;
  }
  return matches;
}

// ===== 删除错题（从档案移除该块，并更新侧边栏） =====
function deleteError(ws, file, n) {
  const md = readMd(ws, file);
  if (md == null) return { ok: false, message: '文件不存在: ' + file };
  const lines = md.split('\n');
  const headRe = new RegExp('^#{2,4}\\s*错题\\s*' + n + '\\s*[：:]');
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (headRe.test(lines[i])) { start = i; break; }
  if (start === -1) return { ok: false, message: '未找到错题 ' + n };
  const lvl = lines[start].match(/^#+/)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,4})\s+/);
    if (m && m[1].length <= lvl) { end = i; break; }
  }
  let kept = lines.slice(0, start).concat(lines.slice(end));
  // 清理：合并连续分隔线 / 空行
  const cleaned = [];
  let prevHr = false, prevBlank = false;
  for (const ln of kept) {
    const isHr = /^\s*([-*_])\s*\1{2,}\s*$/.test(ln);
    const isBlank = ln.trim() === '';
    if ((isHr && (prevHr || prevBlank)) || (isBlank && prevBlank)) continue;
    cleaned.push(ln);
    prevHr = isHr; prevBlank = isBlank;
  }
  while (cleaned.length && cleaned[0].trim() === '') cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();
  writeMd(ws, file, cleaned.join('\n').trim() + '\n');
  // 更新侧边栏：移除对应条目（兼容旧格式 #错题-N：标题 与新格式 #E-2026-xxxxxx）
  const sb = readMd(ws, '_sidebar.md');
  if (sb != null) {
    const linkRe = new RegExp('^\\s*\\*\\s*\\[错题\\s*' + n + '\\s*[：:][^\\]]*\\]\\(' + esc(file) + '#[^)]*\\)\\s*$', 'gm');
    const nsb = sb.replace(linkRe, '').replace(/\n{3,}/g, '\n\n');
    writeMd(ws, '_sidebar.md', nsb.trim() + '\n');
  }
  return { ok: true, file, n };
}

// ===== 同步侧边栏：扫描各科错题，重建「错题记录」列表 =====
function syncSidebar(ws) {
  const sb = readMd(ws, '_sidebar.md');
  if (sb == null) return { ok: false, message: '_sidebar.md 不存在' };
  const stats = subjectStats(ws);
  // 读取错题索引，用于把 sidebar 链接锚点设为唯一错题编号（#E-2026-xxxxxx）
  const numMap = readErrorNumberMap(ws);
  const lines = sb.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\* /.test(lines[i])) {
      const block = [lines[i]];
      let j = i + 1;
      while (j < lines.length && !/^\* /.test(lines[j])) { block.push(lines[j]); j++; }
      const subject = lines[i].replace(/^\* /, '').trim();
      const st = stats.find((x) => x.subject === subject && x.errors.length);
      if (st) {
        // 链接锚点 = 唯一错题编号（若索引缺失则回退到旧格式 #错题-N：标题）
        const items = st.errors.map((e) => {
          const num = numMap[st.file + '#' + e.n];
          const anchor = num ? '#' + num : '#错题-' + e.n + '：' + e.title;
          return '    * [错题' + e.n + ': ' + e.title + '](' + st.file + anchor + ')';
        });
        const nb = [];
        let replaced = false;
        for (let k = 0; k < block.length; k++) {
          const l = block[k];
          if (replaced && /^\s{4,}\*\s*\[/.test(l)) continue; // 跳过旧条目
          nb.push(l);
          if (!replaced && /^\s*\*\s*错题记录\s*$/.test(l)) {
            replaced = true;
            items.forEach((it) => nb.push(it));
          }
        }
        out.push(...nb);
      } else {
        out.push(...block);
      }
      i = j;
    } else {
      out.push(lines[i]); i++;
    }
  }
  writeMd(ws, '_sidebar.md', out.join('\n').trim() + '\n');
  return { ok: true, count: stats.reduce((a, s) => a + s.errors.length, 0) };
}

module.exports = { parseProfile, saveProfile, uploadProfileImage, subjectStats, updateReadmeStats, searchErrors, deleteError, syncSidebar };
