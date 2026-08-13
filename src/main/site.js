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
    const re2 = /^#{2,4}\s*(?:作文|练习作文|考场作文)\s*(\d+)\s*[：:]\s*(.*)$/gm;
    while ((m = re2.exec(md))) essays.push({ n: parseInt(m[1], 10), title: (m[2] || '').trim() });
    // 语文：编号作文小节（### 2.1 《…》）
    const re3 = /^#{2,4}\s*\d+\.\d+\s*(《[^》]*》[^\n]*)/gm;
    while ((m = re3.exec(md))) essays.push({ n: 0, title: m[1].trim() });
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

module.exports = { parseProfile, saveProfile, uploadProfileImage, subjectStats, updateReadmeStats, searchErrors };
