const fs = require('fs');
const path = require('path');

// ===== 工作目录文件服务 =====
// 规则：所有 .md 文件以 UTF-8+BOM 写入（遵循知识库编码规范）
class Workspace {
  constructor(getRoot) {
    this.getRoot = getRoot;
  }

  root() {
    return path.normalize(this.getRoot() || process.cwd());
  }

  resolve(rel) {
    const root = this.root();
    const fp = path.normalize(path.join(root, rel || ''));
    if (fp.toLowerCase().indexOf(root.toLowerCase()) !== 0) {
      throw new Error('路径越界: ' + rel);
    }
    return fp;
  }

  list(rel = '') {
    const dir = this.resolve(rel);
    if (!fs.existsSync(dir)) return { ok: false, message: '目录不存在: ' + rel };
    const items = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return { ok: false, message: e.message }; }
    for (const ent of entries) {
      if (ent.name === '.git') continue;
      if (ent.name === 'node_modules') continue;
      items.push({ name: ent.name, isDir: ent.isDirectory(), path: rel ? rel.replace(/\\/g, '/') + '/' + ent.name : ent.name });
    }
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh') : a.isDir ? -1 : 1));
    return { ok: true, items, root: this.root() };
  }

  read(rel) {
    const fp = this.resolve(rel);
    if (!fs.existsSync(fp)) throw new Error('文件不存在: ' + rel);
    if (fs.statSync(fp).isDirectory()) throw new Error('是目录: ' + rel);
    let content = fs.readFileSync(fp, 'utf8');
    // 去掉 BOM 便于编辑
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    return { ok: true, path: rel, content, size: content.length };
  }

  // 写入；.md 自动补 BOM
  write(rel, content, { confirmGate, meta } = {}) {
    const fp = this.resolve(rel);
    const isMd = path.extname(fp).toLowerCase() === '.md';
    let text = String(content || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    if (isMd) text = '\uFEFF' + text;

    let oldContent = null;
    if (fs.existsSync(fp)) {
      oldContent = fs.readFileSync(fp, 'utf8');
      if (oldContent.charCodeAt(0) === 0xFEFF) oldContent = oldContent.slice(1);
    }

    if (confirmGate) {
      const baseNew = String(text || '').replace(/^\uFEFF/, '');
      return confirmGate.request({
        tool: 'write_file', target: rel, summary: `写入文件 ${rel}`, args: { path: rel },
        oldContent, newContent: baseNew
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        // 用户可在确认弹窗中直接修改 AI 生成的内容，写入修改后的内容
        let finalText = text;
        if (r.editedContent && String(r.editedContent) !== baseNew) {
          finalText = String(r.editedContent);
          if (finalText.charCodeAt(0) === 0xFEFF) finalText = finalText.slice(1);
          if (isMd) finalText = '\uFEFF' + finalText;
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, finalText, 'utf8');
        return { ok: true, path: rel, size: finalText.length };
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, text, 'utf8');
    return { ok: true, path: rel, size: text.length };
  }

  append(rel, content, { confirmGate } = {}) {
    const fp = this.resolve(rel);
    const isMd = path.extname(fp).toLowerCase() === '.md';
    let text = String(content || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    let oldContent = null;
    if (fs.existsSync(fp)) {
      oldContent = fs.readFileSync(fp, 'utf8');
      if (oldContent.charCodeAt(0) === 0xFEFF) oldContent = oldContent.slice(1);
    }
    const newContent = (oldContent || '') + text;
    const writeText = isMd ? '\uFEFF' + (newContent.replace(/^\uFEFF/, '')) : newContent;

    if (confirmGate) {
      const baseNew = String(newContent || '').replace(/^\uFEFF/, '');
      return confirmGate.request({
        tool: 'append_to_file', target: rel, summary: `追加内容到 ${rel}`,
        args: { path: rel }, oldContent, newContent: baseNew
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        // 用户可在确认弹窗中直接修改追加后的完整内容，写入修改后的内容
        let finalContent = baseNew;
        if (r.editedContent && String(r.editedContent) !== baseNew) {
          finalContent = String(r.editedContent);
          if (finalContent.charCodeAt(0) === 0xFEFF) finalContent = finalContent.slice(1);
        }
        const writeFinal = isMd ? '\uFEFF' + finalContent : finalContent;
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, writeFinal, 'utf8');
        return { ok: true, path: rel, appended: finalContent.length };
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, writeText, 'utf8');
    return { ok: true, path: rel, appended: text.length };
  }

  // 新建科目：创建 科目.md，并在 _sidebar.md 与 README.md 中注册（一次性确认）
  createSubject(subject, content, { confirmGate, hasEssay } = {}) {
    const rel = subject + '.md';
    const fp = this.resolve(rel);
    const isMd = true;
    let text = String(content || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    // 若未提供内容，则按模板生成（含可选作文部分）
    if (!text.trim()) {
      text = `# ${subject}档案

> 最后更新：${new Date().toISOString().slice(0, 10)}

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
        text += `
---

## 二、作文

### 作文记录

（可通过「错题助手 · 学习助手」的作文录入功能添加作文，格式：#### 作文 N：标题）

`;
      }
    }
    const writeText = '\uFEFF' + text;

    const sidebarAdd = `\n* ${subject}\n  * [易错汇总](${rel}#易错题型汇总)\n  * 错题记录\n`;
    const readmeAdd = `\n| ${subject} | 新建档案 | 待录入 |\n`;
    const readmeAdd2 = `\n| ${subject} | [${subject}档案](${rel}) |\n`;

    const summary = `新建科目「${subject}」：创建 ${rel}，并注册到 _sidebar.md 与 README.md`;
    if (confirmGate) {
      const baseNew = String(text || '').replace(/^\uFEFF/, '');
      return confirmGate.request({
        tool: 'create_subject', target: rel, summary, args: { subject },
        oldContent: null, newContent: baseNew
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        // 用户可在确认弹窗中直接修改科目档案内容
        let finalText = text;
        if (r.editedContent && String(r.editedContent) !== baseNew) {
          finalText = String(r.editedContent);
          if (finalText.charCodeAt(0) === 0xFEFF) finalText = finalText.slice(1);
          if (isMd) finalText = '\uFEFF' + finalText;
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, finalText, 'utf8');
        this._touchSidebar(sidebarAdd);
        this._touchReadme(readmeAdd, readmeAdd2, subject);
        return { ok: true, path: rel, sidebar: true, readme: true };
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, writeText, 'utf8');
    this._touchSidebar(sidebarAdd);
    this._touchReadme(readmeAdd, readmeAdd2, subject);
    return { ok: true, path: rel, sidebar: true, readme: true };
  }

  _touchSidebar(addText) {
    const s = this.resolve('_sidebar.md');
    let cur = fs.existsSync(s) ? fs.readFileSync(s, 'utf8') : '';
    if (cur.charCodeAt(0) === 0xFEFF) cur = cur.slice(1);
    if (cur.indexOf('* ' + addText.trim().split('\n')[0].replace('* ', '')) === -1) {
      fs.writeFileSync(s, '\uFEFF' + cur + addText, 'utf8');
    }
  }

  _touchReadme(row, row2, subject) {
    const r = this.resolve('README.md');
    let cur = fs.existsSync(r) ? fs.readFileSync(r, 'utf8') : '';
    if (cur.charCodeAt(0) === 0xFEFF) cur = cur.slice(1);
    if (cur.indexOf('| ' + subject + ' ') === -1) {
      // 在各科入口表前插入统计行，在各科入口表末尾追加入口行
      cur = cur.replace(/\n\| 学科 \| 内容 \| 错题\/作文数 \|/, '\n' + row + '\n| 学科 | 内容 | 错题/作文数 |');
      const idx = cur.lastIndexOf('| 政治 |');
      if (idx !== -1) {
        const end = cur.indexOf('\n', idx);
        cur = cur.slice(0, end) + '\n' + row2.trim() + cur.slice(end);
      }
      fs.writeFileSync(r, '\uFEFF' + cur, 'utf8');
    }
  }
}

module.exports = Workspace;
