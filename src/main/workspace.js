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
      return confirmGate.request({
        tool: 'write_file', target: rel, summary: `写入文件 ${rel}`, args: { path: rel },
        oldContent, newContent: text.replace(/^\uFEFF/, '')
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, text, 'utf8');
        return { ok: true, path: rel, size: text.length };
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
      return confirmGate.request({
        tool: 'append_to_file', target: rel, summary: `追加内容到 ${rel}`,
        args: { path: rel }, oldContent, newContent: newContent.replace(/^\uFEFF/, '')
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, writeText, 'utf8');
        return { ok: true, path: rel, appended: text.length };
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, writeText, 'utf8');
    return { ok: true, path: rel, appended: text.length };
  }

  // 新建科目：创建 科目.md，并在 _sidebar.md 与 README.md 中注册（一次性确认）
  createSubject(subject, content, { confirmGate } = {}) {
    const rel = subject + '.md';
    const fp = this.resolve(rel);
    const isMd = true;
    let text = String(content || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const writeText = '\uFEFF' + text;

    const sidebarAdd = `\n* ${subject}\n  * [易错汇总](${rel}#易错题型汇总)\n  * 错题记录\n`;
    const readmeAdd = `\n| ${subject} | 新建档案 | 待录入 |\n`;
    const readmeAdd2 = `\n| ${subject} | [${subject}档案](${rel}) |\n`;

    const summary = `新建科目「${subject}」：创建 ${rel}，并注册到 _sidebar.md 与 README.md`;
    if (confirmGate) {
      return confirmGate.request({
        tool: 'create_subject', target: rel, summary, args: { subject },
        oldContent: null, newContent: text
      }).then((r) => {
        if (!r.approved) return { ok: false, cancelled: true, path: rel };
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, writeText, 'utf8');
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
