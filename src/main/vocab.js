// ===== 生词本服务：英语单词生义 + 文言文生义 =====
// 数据存储在 workspace 的 生词本/ 目录（随知识库同步）
// Word 导出使用 docx 库生成 .docx 文件
const fs = require('fs');
const path = require('path');
const { dialog } = require('electron');
const { Document, Packer, Paragraph, TextRun, AlignmentType, BorderStyle, WidthType, PageBreak } = require('docx');

const DIR = '生词本';
const WORDS_FILE = 'words.json';
const WENYAN_FILE = 'wenyan.json';

function dataFile(ws, name) {
  return ws.resolve(path.join(DIR, name));
}
function readJson(ws, name) {
  const fp = dataFile(ws, name);
  if (!fs.existsSync(fp)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8') || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}
function writeJson(ws, name, arr) {
  const fp = dataFile(ws, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8');
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 同步版本字段：标记记录已修改（version+1, updatedAt=now）
function touch(rec) {
  rec.version = (rec.version || 1) + 1;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

// ================= 英语单词 =================
function listWords(ws) {
  const arr = readJson(ws, WORDS_FILE);
  // 按 A-Z 排序（忽略大小写）
  arr.sort((a, b) => String(a.word || '').toLowerCase().localeCompare(String(b.word || '').toLowerCase()));
  return { ok: true, words: arr };
}
function addWord(ws, data) {
  const arr = readJson(ws, WORDS_FILE);
  const w = {
    id: uid(),
    word: String(data.word || '').trim(),
    type: data.type === 'phrase' ? 'phrase' : 'word',
    linked: String(data.linked || '').trim(),
    senses: Array.isArray(data.senses) ? data.senses : [],
    otherForms: Array.isArray(data.otherForms) ? data.otherForms : [], // 其它词性的单词（词族补充）
    createdAt: today(),
    // 艾宾浩斯复习字段
    reviewStage: 0,
    lastReview: '',
    nextReview: today(),
    reviewCount: 0,
    correctCount: 0,
    wrongCount: 0,
    // 同步版本字段
    updatedAt: new Date().toISOString(),
    version: 1
  };
  if (!w.word) return { ok: false, message: '单词/短语不能为空' };
  arr.push(w);
  writeJson(ws, WORDS_FILE, arr);
  return { ok: true, word: w };
}
function updateWord(ws, id, data) {
  const arr = readJson(ws, WORDS_FILE);
  const w = arr.find((x) => x.id === id);
  if (!w) return { ok: false, message: '未找到该单词' };
  if (data.word !== undefined) w.word = String(data.word).trim();
  if (data.type !== undefined) w.type = data.type === 'phrase' ? 'phrase' : 'word';
  if (data.linked !== undefined) w.linked = String(data.linked).trim();
  if (data.senses !== undefined) w.senses = data.senses;
  if (data.otherForms !== undefined) w.otherForms = data.otherForms;
  touch(w);
  writeJson(ws, WORDS_FILE, arr);
  return { ok: true, word: w };
}
function deleteWord(ws, id) {
  const arr = readJson(ws, WORDS_FILE);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: false, message: '未找到该单词' };
  const w = arr[idx];
  // 软删除：标记 deleted 而非物理移除，便于同步传播删除
  w.deleted = true;
  touch(w);
  writeJson(ws, WORDS_FILE, arr);
  return { ok: true };
}
// 同步用：整体替换单词列表（合并后写回）
function replaceAllWords(ws, arr) {
  writeJson(ws, WORDS_FILE, Array.isArray(arr) ? arr : []);
  return { ok: true };
}

// ================= 艾宾浩斯遗忘曲线复习 =================
// 复习间隔（天）：录入当天为阶段 0，之后按遗忘曲线逐步拉长
const EBBINGHAUS_INTERVALS = [1, 2, 4, 7, 15, 30, 60];
// 阶段名称（用于展示）
const STAGE_NAMES = ['新学', '第1次', '第2次', '第3次', '第4次', '第5次', '长期巩固'];

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
}
// 计算某阶段对应的下次复习日期
function nextReviewDate(stage, fromDate) {
  const idx = Math.max(0, Math.min(stage, EBBINGHAUS_INTERVALS.length - 1));
  return addDays(fromDate || today(), EBBINGHAUS_INTERVALS[idx]);
}
// 兼容旧数据：为没有复习字段的单词补齐默认值
function ensureReviewFields(w) {
  if (w.reviewStage === undefined) w.reviewStage = 0;
  if (w.lastReview === undefined) w.lastReview = '';
  if (w.nextReview === undefined) w.nextReview = w.createdAt || today();
  if (w.reviewCount === undefined) w.reviewCount = 0;
  if (w.correctCount === undefined) w.correctCount = 0;
  if (w.wrongCount === undefined) w.wrongCount = 0;
  return w;
}
// 复习概览：统计今日待复习、已掌握、各阶段分布等
function reviewOverview(ws) {
  const arr = readJson(ws, WORDS_FILE).map(ensureReviewFields).filter((w) => !w.deleted);
  const t = today();
  const due = arr.filter((w) => (w.nextReview || '') <= t);
  const mastered = arr.filter((w) => (w.reviewStage || 0) >= EBBINGHAUS_INTERVALS.length);
  const stageCounts = {};
  arr.forEach((w) => {
    const s = Math.min(w.reviewStage || 0, EBBINGHAUS_INTERVALS.length);
    stageCounts[s] = (stageCounts[s] || 0) + 1;
  });
  return {
    ok: true,
    total: arr.length,
    due: due.length,
    mastered: mastered.length,
    stageCounts,
    intervals: EBBINGHAUS_INTERVALS,
    stageNames: STAGE_NAMES
  };
}
// 获取今日待复习单词（含已到期）
function reviewDue(ws) {
  const arr = readJson(ws, WORDS_FILE).map(ensureReviewFields).filter((w) => !w.deleted);
  const t = today();
  const due = arr.filter((w) => (w.nextReview || '') <= t);
  // 按到期时间排序（最久未复习的优先）
  due.sort((a, b) => String(a.nextReview || '').localeCompare(String(b.nextReview || '')));
  return { ok: true, words: due };
}
// 提交一次复习结果：correct=true 阶段+1，false 阶段归零
// 返回更新后的单词
function submitReview(ws, id, correct) {
  const arr = readJson(ws, WORDS_FILE);
  const w = arr.find((x) => x.id === id);
  if (!w) return { ok: false, message: '未找到该单词' };
  ensureReviewFields(w);
  const t = today();
  w.lastReview = t;
  w.reviewCount = (w.reviewCount || 0) + 1;
  if (correct) {
    w.correctCount = (w.correctCount || 0) + 1;
    w.reviewStage = (w.reviewStage || 0) + 1;
  } else {
    w.wrongCount = (w.wrongCount || 0) + 1;
    w.reviewStage = 0; // 拼写错误，进度归零
  }
  w.nextReview = nextReviewDate(w.reviewStage, t);
  touch(w);
  writeJson(ws, WORDS_FILE, arr);
  return { ok: true, word: w };
}
// 手动重置某个单词的复习进度
function resetReview(ws, id) {
  const arr = readJson(ws, WORDS_FILE);
  const w = arr.find((x) => x.id === id);
  if (!w) return { ok: false, message: '未找到该单词' };
  ensureReviewFields(w);
  w.reviewStage = 0;
  w.lastReview = '';
  w.nextReview = w.createdAt || today();
  w.reviewCount = 0;
  w.correctCount = 0;
  w.wrongCount = 0;
  touch(w);
  writeJson(ws, WORDS_FILE, arr);
  return { ok: true, word: w };
}

// ================= 文言文 =================
function listWenyan(ws) {
  const arr = readJson(ws, WENYAN_FILE);
  arr.sort((a, b) => String(a.char || '').localeCompare(String(b.char || ''), 'zh'));
  return { ok: true, words: arr };
}
function addWenyan(ws, data) {
  const arr = readJson(ws, WENYAN_FILE);
  const w = {
    id: uid(),
    char: String(data.char || '').trim(),
    type: data.type === '词' ? '词' : '字',
    senses: Array.isArray(data.senses) ? data.senses : [],
    createdAt: today(),
    updatedAt: new Date().toISOString(),
    version: 1
  };
  if (!w.char) return { ok: false, message: '字/词不能为空' };
  arr.push(w);
  writeJson(ws, WENYAN_FILE, arr);
  return { ok: true, word: w };
}
function updateWenyan(ws, id, data) {
  const arr = readJson(ws, WENYAN_FILE);
  const w = arr.find((x) => x.id === id);
  if (!w) return { ok: false, message: '未找到该字/词' };
  if (data.char !== undefined) w.char = String(data.char).trim();
  if (data.type !== undefined) w.type = data.type === '词' ? '词' : '字';
  if (data.senses !== undefined) w.senses = data.senses;
  touch(w);
  writeJson(ws, WENYAN_FILE, arr);
  return { ok: true, word: w };
}
function deleteWenyan(ws, id) {
  const arr = readJson(ws, WENYAN_FILE);
  const idx = arr.findIndex((x) => x.id === id);
  if (idx === -1) return { ok: false, message: '未找到该字/词' };
  const w = arr[idx];
  w.deleted = true;
  touch(w);
  writeJson(ws, WENYAN_FILE, arr);
  return { ok: true };
}
// 同步用：整体替换文言文列表（合并后写回）
function replaceAllWenyan(ws, arr) {
  writeJson(ws, WENYAN_FILE, Array.isArray(arr) ? arr : []);
  return { ok: true };
}

// ================= Word 导出 =================
// 字体常量（half-points）：三号=32，四号=28
const SZ_TITLE = 32;   // 三号
const SZ_BODY = 28;    // 四号
const FONT_CN_TITLE = '华文中宋'; // 中宋
const FONT_CN_BODY = '楷体';
const FONT_EN = 'Times New Roman';

// 下划线（横线）文本
function underline(text) {
  return new TextRun({ text, font: { name: FONT_EN }, size: SZ_BODY, underline: {} });
}
function cnRun(text, opts = {}) {
  return new TextRun(Object.assign({ text, font: { name: FONT_CN_BODY }, size: SZ_BODY }, opts));
}
function enRun(text, opts = {}) {
  return new TextRun(Object.assign({ text, font: { name: FONT_EN }, size: SZ_BODY }, opts));
}

// 词性显示：把简写（如 n.）统一转换为带中文标注的格式（如 n.（名词））
const POS_MAP = {
  'n.': 'n.（名词）', 'v.': 'v.（动词）', 'adj.': 'adj.（形容词）', 'adv.': 'adv.（副词）',
  'prep.': 'prep.（介词）', 'conj.': 'conj.（连词）', 'pron.': 'pron.（代词）', 'num.': 'num.（数词）',
  'art.': 'art.（冠词）', 'int.': 'int.（感叹词）', 'phr.': 'phr.（短语）'
};
function posLabel(pos) {
  if (!pos) return '';
  const p = String(pos).trim();
  return POS_MAP[p] || p;
}

// 生成下划线占位（用于填写）
function blankLine(len) {
  return '＿'.repeat(Math.max(4, len));
}

// 保存 docx 到用户选择的路径
async function saveDocx(win, doc, defaultName) {
  const r = await dialog.showSaveDialog(win, {
    title: '导出 Word 文档',
    defaultPath: defaultName,
    filters: [{ name: 'Word 文档', extensions: ['docx'] }]
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  const buf = await Packer.toBuffer(doc);
  fs.writeFileSync(r.filePath, buf);
  return { ok: true, path: r.filePath };
}

// ===== 英语生词卷导出 =====
// opts: { words: [...], mode: 'en'|'zh', withAnswer: bool, title: string }
async function exportWords(win, opts) {
  const words = opts.words || [];
  const mode = opts.mode === 'zh' ? 'zh' : 'en';
  const withAnswer = !!opts.withAnswer;
  const title = opts.title || '英语生词卷';

  // 按类型分组：单词在前，短语在后
  const wordsGroup = words.filter((w) => w.type !== 'phrase');
  const phrasesGroup = words.filter((w) => w.type === 'phrase');
  const groups = [];
  if (wordsGroup.length) groups.push({ label: '一、单词', list: wordsGroup });
  if (phrasesGroup.length) groups.push({ label: '二、短语', list: phrasesGroup });

  // 生成一组题目（返回题目段落 + 该组单词列表，用于答案页）
  function buildQuestions(list) {
    const paras = [];
    list.forEach((w, i) => {
      const word = w.word || '';
      const senses = w.senses || [];
      if (mode === 'en') {
        // 给出英文：英文 + 词性 + 横线（填中文）
        const runs = [enRun((i + 1) + '. ' + word + '  ')];
        senses.forEach((s, si) => {
          runs.push(enRun('(' + (s.form ? s.form + ' ' : '') + posLabel(s.pos) + ') '));
          runs.push(underline(blankLine(6)));
          if (si < senses.length - 1) runs.push(enRun('  '));
        });
        paras.push(new Paragraph({ children: runs, spacing: { after: 160 } }));
      } else {
        // 给出中文：中文（含所有生义及词性）+ 横线（填英文）
        const meaningText = senses.map((s) => (s.form ? s.form + ' ' : '') + (s.pos ? '(' + posLabel(s.pos) + ') ' : '') + s.meaning).join('；');
        const runs = [cnRun((i + 1) + '. ' + meaningText + '  ')];
        runs.push(underline(blankLine(10)));
        paras.push(new Paragraph({ children: runs, spacing: { after: 160 } }));
      }
    });
    return paras;
  }

  const children = [];
  // 标题（中宋三号）
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, font: { name: FONT_CN_TITLE }, size: SZ_TITLE, bold: true })]
  }));
  children.push(new Paragraph({ children: [] }));

  // 题目部分（按分组输出，每组带小节标题）
  groups.forEach((g) => {
    children.push(new Paragraph({
      children: [new TextRun({ text: g.label, font: { name: FONT_CN_BODY }, size: SZ_BODY, bold: true })],
      spacing: { before: 120, after: 80 }
    }));
    children.push(...buildQuestions(g.list));
  });

  // 答案页
  if (withAnswer) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '参考答案', font: { name: FONT_CN_TITLE }, size: SZ_TITLE, bold: true })]
    }));
    children.push(new Paragraph({ children: [] }));
    groups.forEach((g) => {
      children.push(new Paragraph({
        children: [new TextRun({ text: g.label, font: { name: FONT_CN_BODY }, size: SZ_BODY, bold: true })],
        spacing: { before: 120, after: 80 }
      }));
      g.list.forEach((w, i) => {
        const word = w.word || '';
        const senses = w.senses || [];
        const meaningText = senses.map((s) => (s.form ? s.form + ' ' : '') + (s.pos ? '(' + posLabel(s.pos) + ') ' : '') + s.meaning).join('；');
        const runs = [enRun((i + 1) + '. ' + word + '  ')];
        runs.push(cnRun(meaningText));
        children.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
      });
    });
  }

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });
  return saveDocx(win, doc, title + '.docx');
}

// ===== 文言文导出 =====
// opts: { words: [...], title: string }
async function exportWenyan(win, opts) {
  const words = opts.words || [];
  const title = opts.title || '文言文生义';

  const children = [];
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, font: { name: FONT_CN_TITLE }, size: SZ_TITLE, bold: true })]
  }));
  children.push(new Paragraph({ children: [] }));

  words.forEach((w, i) => {
    const char = w.char || '';
    const senses = w.senses || [];
    // 字/词 + 类型
    children.push(new Paragraph({
      children: [
        cnRun((i + 1) + '. ' + char + '  ', { bold: true }),
        cnRun('（' + (w.type || '字') + '）', { color: '888888' })
      ],
      spacing: { before: 120, after: 60 }
    }));
    senses.forEach((s) => {
      const runs = [cnRun('　' + (s.meaning || ''))];
      if (s.example) {
        runs.push(cnRun('　例：' + s.example));
        if (s.source) runs.push(cnRun('（' + s.source + '）', { color: '888888' }));
      }
      children.push(new Paragraph({ children: runs, spacing: { after: 40 } }));
    });
  });

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });
  return saveDocx(win, doc, title + '.docx');
}

// ===== 复习卷导出 =====
// opts: { words: [...], mode: 'en'|'zh', withAnswer: bool, title: string }
// 与生词卷类似，但按艾宾浩斯阶段分组，并标注复习阶段
async function exportReview(win, opts) {
  const words = opts.words || [];
  const mode = opts.mode === 'zh' ? 'zh' : 'en';
  const withAnswer = !!opts.withAnswer;
  const title = opts.title || '词语复习卷';

  // 按复习阶段分组（阶段 0 新学 → 长期巩固）
  const groups = [];
  const stageMap = {};
  words.forEach((w) => {
    const s = Math.min(w.reviewStage || 0, EBBINGHAUS_INTERVALS.length);
    if (!stageMap[s]) { stageMap[s] = []; groups.push({ stage: s, list: stageMap[s] }); }
    stageMap[s].push(w);
  });
  groups.sort((a, b) => a.stage - b.stage);

  function buildQuestions(list) {
    const paras = [];
    list.forEach((w, i) => {
      const word = w.word || '';
      const senses = w.senses || [];
      if (mode === 'en') {
        const runs = [enRun((i + 1) + '. ' + word + '  ')];
        senses.forEach((s, si) => {
          runs.push(enRun('(' + (s.form ? s.form + ' ' : '') + posLabel(s.pos) + ') '));
          runs.push(underline(blankLine(6)));
          if (si < senses.length - 1) runs.push(enRun('  '));
        });
        paras.push(new Paragraph({ children: runs, spacing: { after: 160 } }));
      } else {
        const meaningText = senses.map((s) => (s.form ? s.form + ' ' : '') + (s.pos ? '(' + posLabel(s.pos) + ') ' : '') + s.meaning).join('；');
        const runs = [cnRun((i + 1) + '. ' + meaningText + '  ')];
        runs.push(underline(blankLine(10)));
        paras.push(new Paragraph({ children: runs, spacing: { after: 160 } }));
      }
    });
    return paras;
  }

  const children = [];
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: title, font: { name: FONT_CN_TITLE }, size: SZ_TITLE, bold: true })]
  }));
  children.push(new Paragraph({ children: [] }));

  groups.forEach((g) => {
    const stageName = STAGE_NAMES[Math.min(g.stage, STAGE_NAMES.length - 1)];
    children.push(new Paragraph({
      children: [new TextRun({ text: stageName + '（' + g.list.length + ' 个）', font: { name: FONT_CN_BODY }, size: SZ_BODY, bold: true })],
      spacing: { before: 120, after: 80 }
    }));
    children.push(...buildQuestions(g.list));
  });

  if (withAnswer) {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: '参考答案', font: { name: FONT_CN_TITLE }, size: SZ_TITLE, bold: true })]
    }));
    children.push(new Paragraph({ children: [] }));
    groups.forEach((g) => {
      const stageName = STAGE_NAMES[Math.min(g.stage, STAGE_NAMES.length - 1)];
      children.push(new Paragraph({
        children: [new TextRun({ text: stageName, font: { name: FONT_CN_BODY }, size: SZ_BODY, bold: true })],
        spacing: { before: 120, after: 80 }
      }));
      g.list.forEach((w, i) => {
        const word = w.word || '';
        const senses = w.senses || [];
        const meaningText = senses.map((s) => (s.form ? s.form + ' ' : '') + (s.pos ? '(' + posLabel(s.pos) + ') ' : '') + s.meaning).join('；');
        const runs = [enRun((i + 1) + '. ' + word + '  ')];
        runs.push(cnRun(meaningText));
        children.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
      });
    });
  }

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });
  return saveDocx(win, doc, title + '.docx');
}

module.exports = {
  listWords, addWord, updateWord, deleteWord, replaceAllWords,
  listWenyan, addWenyan, updateWenyan, deleteWenyan, replaceAllWenyan,
  exportWords, exportWenyan,
  reviewOverview, reviewDue, submitReview, resetReview, exportReview
};
