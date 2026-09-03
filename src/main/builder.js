// ===== docsify 知识库构建器 =====
// 为首次使用的用户一键生成与当前风格一致的 docsify 站点
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const DEFAULT_SUBJECTS = ['语文', '数学', '英语', '地理', '历史', '政治'];
const DEFAULT_PWD_HASH = '91b4d142823f7d20c5f08df69122de43f35f057a988d9619f6d3138485c9a203'; // 默认组卷密码 000000

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function today() {
  const d = new Date();
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

const TEMPLATE_README = `# 学科学情档案汇总

> 最后更新：{date} &nbsp;|&nbsp; 共0题（错题0道 + 作文0篇）&nbsp;|&nbsp; 涵盖各科

---

## 🎯 目标院校

> 心之所向，素履以往。每一道错题，都是离梦想更近一步。

（在此填写目标院校）

---

## 各科概览

| 学科 | 内容 | 错题/作文数 |
|:---:|------|:---:|
| 语文 | — | — |
| 数学 | — | — |
| 英语 | — | — |
| 地理 | — | — |
| 历史 | — | — |
| 政治 | — | — |

## 使用说明

- 左侧边栏按学科分类，点击可跳转各科档案
- 数学公式由 **MathJax** 渲染，支持行内公式和块级公式
- 顶部搜索框可快速定位关键知识点
- 错题更新后本知识库自动同步

> ⚠️ 本知识库为私人题库，仅供个人复习使用，谢绝转载与传播。

## 关于作者

- 个人网站：[kfdzcoffee.cn](https://kfdzcoffee.cn)
- 个人博客：[blog.kfdzcoffee.cn](https://blog.kfdzcoffee.cn)

## 各科入口

| 学科 | 直达链接 |
|:---:|------|
| 语文 | [语文档案](语文.md) |
| 数学 | [数学档案](数学.md) |
| 英语 | [英语档案](英语.md) |
| 地理 | [地理档案](地理.md) |
| 历史 | [历史档案](历史.md) |
| 政治 | [政治档案](政治.md) |
`;

function templateSidebar(subjects) {
  const lines = ['* [🏠 总览](/)'];
  subjects.forEach((s) => {
    lines.push('* ' + s);
    lines.push('  * [易错汇总](' + s + '.md#易错题型汇总)');
    lines.push('  * 错题记录');
    lines.push('    * [错题1: 待录入](' + s + '.md#错题记录)');
  });
  lines.push('* 工具箱');
  lines.push('  * [分数预测](分数预测.md)');
  lines.push('  * [编辑注意事项](编辑注意事项.md)');
  return lines.join('\n') + '\n';
}

function templateSubject(subject, hasEssay) {
  let tpl = `# ${subject}档案

> 最后更新：{date}

---

## 一、错题

### 易错题型汇总

| 题型 | 出错次数 | 典型表现 |
|------|:---:|------|
| （待录入） | — | — |

### 易错原因汇总

| 原因 | 频率 |
|------|:---:|
| （待录入） | — |

---

### 错题记录

（可通过「错题助手 · 学习助手」的错题录入功能添加错题，格式：#### 错题 N：标题）

`;
  if (hasEssay) {
    tpl += `
---

## 二、作文

### 作文记录

（可通过「错题助手 · 学习助手」的作文录入功能添加作文，格式：#### 作文 N：标题）

`;
  }
  return tpl;
}

const TEMPLATE_SCORE = `# 分数预测

> 基于当前错题档案的学情数据，预估各科高考分数。数据更新于 {date}。

---

## 统计概览

| 学科 | 错题数 | 掌握程度 | 预估得分率 |
|:---|:---:|:---|:---:|
| 语文 | — | — | — |
| 数学 | — | — | — |
| 英语 | — | — | — |
| 地理 | — | — | — |
| 历史 | — | — | — |
| 政治 | — | — | — |

> **说明**：各科满分按北京高考标准：语文150、数学150、英语150（笔试部分）、地理/历史/政治各100。

---

## 各科详细预测

（待错题录入后，由「学习助手」根据全部错题档案自动更新）

`;

const TEMPLATE_NOTES = `# 编辑注意事项

> 本栏仅用于 AI 生成时确认生成步骤与要点，避免疏漏

## 编码规范

- **_sidebar.md 及所有中文 Markdown 文件**：写入时必须使用 **UTF-8+BOM** 编码，避免乱码（字符变 \`?\`）。
- 修改后必须校验锚点中无非法字符（如 \`?\`），确认无误再提交。

## docsify 版本

- 本项目使用 **docsify v5**（非 v4），即使 v5 早期存在 sidebar 渲染问题也不回退到 v4。

## 锚点规则（第二高级事项）

- sidebar 锚点必须与 docsify slugify 算法生成的实际 DOM id 完全一致。
- 验证方法：在浏览器中点击正文标题，查看地址栏 hash 中生成的 id，sidebar 中锚点必须与之匹配。
- 常见 slugify 规则：\`(III)\` → \`iii\`、空格 → \`-\`、\`·\` → 保留、中文括号 \`（）\` → 保留。
- **严禁**使用 \`?id=\` 格式、简化标签或合并条目。

## 编辑后验证流程

1. 先本地浏览器验证修复/修改效果。
2. 用户核验通过后，再执行 \`git push\`。
3. 不得在用户核验前自行 push。

## Git 工作流

1. \`git rm -r --cached .\`
2. \`git add -A\`
3. commit 格式：\`修改内容 - YYYY-MM-DD HH:mm\`
4. push 失败最多重试 3 次并核验结果。

## 错题录入流程（五步）

1. 修改档案文档（对应科目 .md）
2. 修改知识库网页内容（_sidebar.md 新增条目）
3. 更新 README 题目数量和日期（新科目需补上科目行）
4. 浏览器验证：新录入题目格式、侧边栏子目锚点跳转位置、显著 bug
5. 验证通过后无需二次询问直接 push（必要时 force push）

## 组卷功能要求

- 新增题目必须可被组卷功能选中。\`injectCheckboxes\` 扫描 h2/h3/h4 标题，新题目标题使用 \`##\` / \`###\` / \`####\` 格式，确保被扫描到。
- \`generateExam\` 同样从 h2/h3/h4 标题中提取题目。

## Sidebar 结构规则（第一高级事项）

- 严格按用户指定原始结构逐条列出每道错题，不得自行总结、分类或增删条目。
- 不增实体、不改无关内容。用户未安排的事不做。

## 严禁 AIGC 追踪串（第三高级事项）

- **绝对禁止**在任何 \`.md\` 文件的 YAML frontmatter 中出现 \`AIGC\`、\`Label\`、\`ContentProducer\`、\`ProduceID\`、\`ReservedCode\`、\`ContentPropagator\`、\`PropagateID\` 等追踪字段。
- 每次编辑或生成文件后，必须检查文件开头是否被注入此类 frontmatter 块（特征：以 \`---\` 开头，包含上述字段，以 \`---\` 结束）。如发现，立即删除整块。
- Push 前必须逐文件确认无此类污染。

## 完成后清理

- 任务完成后清理临时截图与中间产物。
`;

function checkDocsifyPath(rootPath) {
  const rp = path.normalize(rootPath || process.cwd());
  const idx = path.join(rp, 'index.html');
  const exists = fs.existsSync(idx);
  const files = [];
  if (exists) files.push('index.html');
  if (fs.existsSync(path.join(rp, '_sidebar.md'))) files.push('_sidebar.md');
  if (fs.existsSync(path.join(rp, 'README.md'))) files.push('README.md');
  return { exists, files, workspace: rp };
}
function checkDocsify(ws) { return checkDocsifyPath(ws.root()); }

function readTemplateIndex() {
  const tpl = path.join(__dirname, 'templates', 'index.html');
  if (fs.existsSync(tpl)) return fs.readFileSync(tpl, 'utf8');
  return '';
}

function buildDocsify(ws, opts = {}) {
  const subjects = (opts.subjects && opts.subjects.length) ? opts.subjects : DEFAULT_SUBJECTS;
  const essaySubjects = opts.essaySubjects || [];
  const created = [];
  const overwritten = [];
  const date = today();
  const write = (rel, content, isMd, overwrite) => {
    const fp = ws.resolve(rel);
    if (fs.existsSync(fp) && !overwrite) return;
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, (isMd ? '\uFEFF' : '') + content, 'utf8');
    (fs.existsSync(fp) && overwrite ? overwritten : created).push(rel);
  };

  // index.html：始终覆盖（同步最新设计与组卷密码）
  let idx = readTemplateIndex();
  if (!idx) return { ok: false, message: '内置模板缺失' };
  if (opts.examPassword) {
    idx = idx.replace(/'[0-9a-f]{64}'/, "'" + sha256(opts.examPassword) + "'");
  }
  write('index.html', idx, false, true);
  write('README.md', TEMPLATE_README.replace('{date}', date), true, false);
  write('_sidebar.md', templateSidebar(subjects), true, false);
  subjects.forEach((s) => write(s + '.md', templateSubject(s, essaySubjects.indexOf(s) !== -1).replace('{date}', date), true, false));
  write('分数预测.md', TEMPLATE_SCORE.replace('{date}', date), true, false);
  write('编辑注意事项.md', TEMPLATE_NOTES, true, false);

  return { ok: true, created, overwritten, subjects };
}

// 将组卷密码写入现有 index.html
function applyExamPassword(ws, pwd) {
  const fp = ws.resolve('index.html');
  if (!fs.existsSync(fp)) return { ok: false, message: 'index.html 不存在，请先构建知识库' };
  let content = fs.readFileSync(fp, 'utf8');
  const hash = pwd ? sha256(pwd) : DEFAULT_PWD_HASH; // 留空恢复默认密码（000000）
  if (/'[0-9a-f]{64}'/.test(content)) {
    content = content.replace(/'[0-9a-f]{64}'/, "'" + hash + "'");
    fs.writeFileSync(fp, content, 'utf8');
    return { ok: true, hash, note: pwd ? '已设置组卷密码' : '已恢复默认密码（000000）' };
  }
  return { ok: false, message: '未在 index.html 中找到组卷密码字段' };
}

module.exports = {
  checkDocsify, checkDocsifyPath, buildDocsify, applyExamPassword,
  sha256, DEFAULT_SUBJECTS, DEFAULT_PWD_HASH
};
