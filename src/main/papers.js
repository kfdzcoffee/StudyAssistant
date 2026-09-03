// ===== 试卷管理服务 =====
// 试卷数据存储在工作目录 papers/ 目录下：
//   papers/index.json        —— 试卷元数据清单（名称、科目、日期、答题卡标志、图片路径、关联错题数）
//   papers/<id>/paper.<ext>  —— 试卷本体图片
//   papers/<id>/answer.<ext> —— 答题卡图片（可选）
//   papers/<id>/analysis.md  —— AI 试卷分析结果（可选）
const fs = require('fs');
const path = require('path');

function papersDir(ws) {
  return ws.resolve('papers');
}
function indexFile(ws) {
  return path.join(papersDir(ws), 'index.json');
}
function readIndex(ws) {
  const fp = indexFile(ws);
  if (!fs.existsSync(fp)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeIndex(ws, arr) {
  fs.mkdirSync(papersDir(ws), { recursive: true });
  fs.writeFileSync(indexFile(ws), JSON.stringify(arr, null, 2), 'utf8');
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim();
}
function extFromDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:image\/([a-zA-Z0-9.+-]+);base64,/);
  const t = m ? m[1].toLowerCase() : 'png';
  if (t === 'jpeg') return 'jpg';
  if (t === 'svg+xml') return 'svg';
  return t;
}
function dataUrlToBuffer(dataUrl) {
  const b64 = String(dataUrl || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(b64, 'base64');
}

// 列出全部试卷（含关联错题列表）
function listPapers(ws) {
  const arr = readIndex(ws);
  const out = arr.map((p) => {
    const paperPath = p.paperPath || '';
    const answerPath = p.answerPath || '';
    return {
      id: p.id,
      name: p.name || '未命名试卷',
      subject: p.subject || '',
      date: p.date || '',
      hasAnswer: !!p.hasAnswer,
      paperPath,
      answerPath,
      analysisPath: p.analysisPath || '',
      linkedErrors: p.linkedErrors || [],
      createdAt: p.createdAt || ''
    };
  });
  return { ok: true, papers: out };
}

// 新增试卷：{ name, subject, date, hasAnswer, paperData, answerData }
function addPaper(ws, data) {
  const name = safeName(data && data.name);
  if (!name) return { ok: false, message: '请输入试卷名称' };
  const paperData = data && data.paperData;
  if (!paperData) return { ok: false, message: '请选择试卷图片' };
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(papersDir(ws), id);
  fs.mkdirSync(dir, { recursive: true });

  const paperExt = extFromDataUrl(paperData);
  const paperRel = 'papers/' + id + '/paper.' + paperExt;
  fs.writeFileSync(ws.resolve(paperRel), dataUrlToBuffer(paperData));

  let answerRel = '';
  if (data.hasAnswer && data.answerData) {
    const aExt = extFromDataUrl(data.answerData);
    answerRel = 'papers/' + id + '/answer.' + aExt;
    fs.writeFileSync(ws.resolve(answerRel), dataUrlToBuffer(data.answerData));
  }

  const arr = readIndex(ws);
  arr.push({
    id, name, subject: data.subject || '', date: data.date || '',
    hasAnswer: !!(data.hasAnswer && answerRel), paperPath: paperRel, answerPath: answerRel,
    analysisPath: '', linkedErrors: [], createdAt: new Date().toISOString()
  });
  writeIndex(ws, arr);
  return { ok: true, id, name, paperPath: paperRel, answerPath: answerRel };
}

// 删除试卷（移除图片目录与 index 条目）
function deletePaper(ws, id) {
  const arr = readIndex(ws);
  const idx = arr.findIndex((p) => p.id === id);
  if (idx === -1) return { ok: false, message: '试卷不存在' };
  const p = arr[idx];
  const dir = path.join(papersDir(ws), id);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  arr.splice(idx, 1);
  writeIndex(ws, arr);
  return { ok: true, id, name: p.name };
}

// 读取试卷图片（返回 dataURL，供渲染端展示）
function readPaperImage(ws, rel) {
  if (!rel) return { ok: false, message: '缺少图片路径' };
  const fp = ws.resolve(rel);
  if (!fs.existsSync(fp)) return { ok: false, message: '图片不存在' };
  const ext = path.extname(fp).replace('.', '').toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const buf = fs.readFileSync(fp);
  return { ok: true, dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64') };
}

// 保存 AI 试卷分析结果
function saveAnalysis(ws, id, content) {
  const arr = readIndex(ws);
  const p = arr.find((x) => x.id === id);
  if (!p) return { ok: false, message: '试卷不存在' };
  const rel = 'papers/' + id + '/analysis.md';
  const fp = ws.resolve(rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, '\uFEFF' + String(content || ''), 'utf8');
  p.analysisPath = rel;
  writeIndex(ws, arr);
  return { ok: true, analysisPath: rel };
}

// 读取试卷分析结果
function readAnalysis(ws, id) {
  const arr = readIndex(ws);
  const p = arr.find((x) => x.id === id);
  if (!p || !p.analysisPath) return { ok: false, message: '暂无分析结果' };
  const fp = ws.resolve(p.analysisPath);
  if (!fs.existsSync(fp)) return { ok: false, message: '分析文件不存在' };
  let s = fs.readFileSync(fp, 'utf8');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  return { ok: true, content: s };
}

// 关联错题到试卷：{ file, n, title }（由错题录入时调用）
// 关联错题到试卷（err: { number, title, subject }）
function linkError(ws, id, err) {
  const arr = readIndex(ws);
  const p = arr.find((x) => x.id === id);
  if (!p) return { ok: false, message: '试卷不存在' };
  if (!Array.isArray(p.linkedErrors)) p.linkedErrors = [];
  const number = String((err && err.number) || '').trim();
  if (!number) return { ok: false, message: '缺少错题编号' };
  if (!p.linkedErrors.some((e) => e.number === number)) {
    p.linkedErrors.push({ number, title: String((err && err.title) || '').trim(), subject: String((err && err.subject) || '').trim() });
  }
  writeIndex(ws, arr);
  return { ok: true, linkedErrors: p.linkedErrors };
}

// 取消错题与试卷的关联
function unlinkError(ws, id, number) {
  const arr = readIndex(ws);
  const p = arr.find((x) => x.id === id);
  if (!p) return { ok: false, message: '试卷不存在' };
  if (!Array.isArray(p.linkedErrors)) p.linkedErrors = [];
  p.linkedErrors = p.linkedErrors.filter((e) => e.number !== String(number || '').trim());
  writeIndex(ws, arr);
  return { ok: true, linkedErrors: p.linkedErrors };
}

// 根据错题编号查找其关联的试卷（供错题统计显示）
function findPaperByError(ws, number) {
  const arr = readIndex(ws);
  const key = String(number || '').trim();
  const found = [];
  arr.forEach((p) => {
    if (Array.isArray(p.linkedErrors) && p.linkedErrors.some((e) => e.number === key)) {
      found.push({ id: p.id, name: p.name || '未命名试卷', subject: p.subject || '' });
    }
  });
  return found;
}

module.exports = { listPapers, addPaper, deletePaper, readPaperImage, saveAnalysis, readAnalysis, linkError, unlinkError, findPaperByError };
