// ===== 数据导出 / 导入（zip 多用户数据包） =====
// 导出：把所选用户的整个知识库 + 全局设置 + 专注记录打包为 .zip
// 导入：解压到指定位置，用户信息按「插入」追加（不覆盖现有，重名文件夹自动加后缀）或「替换全部」
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', 'dist']);
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function collectDirFiles(root) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      const fp = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(fp, depth + 1);
      else {
        const rel = path.relative(root, fp).replace(/\\/g, '/');
        try {
          files.push({ path: rel, content: fs.readFileSync(fp).toString('base64'), md: ent.name.toLowerCase().endsWith('.md') });
        } catch (e) { /* skip */ }
      }
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return files;
}

function sanitizeSettings(imported, cur) {
  // 合并导入的设置到当前（保留当前 API Key，除非导入包自带）
  const merged = JSON.parse(JSON.stringify(cur));
  merged.exam = Object.assign({ type: 'gaokao', year: 2027, month: 6, day: 7 }, imported.exam || {});
  merged.examPassword = imported.examPassword || merged.examPassword || '';
  merged.prompts = Object.assign({}, cur.prompts, imported.prompts || {});
  merged.theme = imported.theme || cur.theme;
  merged.tokenWarn = Number(imported.tokenWarn) || merged.tokenWarn || 500000;
  merged.ocr = Object.assign({ auto: false, engine: 'win' }, merged.ocr || {}, imported.ocr || {});
  for (const k of Object.keys(imported.providers || {})) {
    const ip = imported.providers[k] || {};
    const cp = merged.providers[k] || {};
    merged.providers[k] = Object.assign({}, cp, ip, {
      apiKey: ip.apiKey || cp.apiKey, // 导入包含 API 则采用，否则保留当前
      enabled: ip.apiKey ? (ip.enabled !== false) : cp.enabled
    });
  }
  return merged;
}

// 导出：把所选用户的知识库打包为 zip
// opts: { users: [{id,name,path}], includeApi: bool }
function exportZip(settings, users, records, opts) {
  const cfg = settings.getConfig();
  const clean = JSON.parse(JSON.stringify(cfg));
  if (!opts.includeApi) {
    for (const k of Object.keys(clean.providers || {})) {
      clean.providers[k].apiKey = '';
      clean.providers[k].enabled = false;
    }
  }
  const zip = new AdmZip();
  const userMeta = [];
  (users || []).forEach((u) => {
    const uid = String(u.id || '').replace(/[^a-zA-Z0-9_-]/g, '') || ('u' + Math.random().toString(36).slice(2, 8));
    const files = collectDirFiles(u.path);
    const prefix = 'knowledge/' + uid + '/';
    files.forEach((f) => zip.addFile(prefix + f.path, Buffer.from(f.content, 'base64')));
    userMeta.push({ id: uid, name: u.name, path: u.path, fileCount: files.length });
  });
  zip.addFile('meta.json', Buffer.from(JSON.stringify({ app: 'study-helper', format: 'study-helper-zip', exportedAt: new Date().toISOString(), includeApi: !!opts.includeApi, version: 2 }), 'utf8'));
  zip.addFile('users.json', Buffer.from(JSON.stringify(userMeta, null, 2), 'utf8'));
  zip.addFile('settings.json', Buffer.from(JSON.stringify(clean, null, 2), 'utf8'));
  zip.addFile('records.json', Buffer.from(JSON.stringify(records || [], null, 2), 'utf8'));
  return {
    ok: true,
    buffer: zip.toBuffer(),
    users: userMeta,
    totalFiles: userMeta.reduce((a, b) => a + b.fileCount, 0)
  };
}

// 读取 zip 信息（供导入弹窗预览）
function inspectZip(buffer) {
  try {
    const zip = new AdmZip(buffer);
    const meta = JSON.parse(zip.readAsText('meta.json') || '{}');
    const users = JSON.parse(zip.readAsText('users.json') || '[]');
    if (meta.app !== 'study-helper') return { ok: false, message: '不是有效的学习助手数据包' };
    return { ok: true, meta, users: Array.isArray(users) ? users : [] };
  } catch (e) {
    return { ok: false, message: '无法读取数据包：' + e.message };
  }
}

// 导入
// opts: { buffer, mode: 'insert'|'replace', selectedIds: [zip用户id], targetDir: 解压父目录 }
function importZip(settings, recordsPath, opts) {
  try {
    const zip = new AdmZip(opts.buffer);
    const meta = JSON.parse(zip.readAsText('meta.json') || '{}');
    if (meta.app !== 'study-helper') return { ok: false, message: '不是有效的学习助手数据包' };
    const zipUsers = JSON.parse(zip.readAsText('users.json') || '[]');
    const selected = (opts.selectedIds && opts.selectedIds.length)
      ? zipUsers.filter((u) => opts.selectedIds.indexOf(u.id) !== -1)
      : zipUsers;
    if (!selected.length) return { ok: false, message: '未选择要导入的用户' };
    const importedSettings = JSON.parse(zip.readAsText('settings.json') || '{}');
    const importedRecords = (() => { try { return JSON.parse(zip.readAsText('records.json') || '[]'); } catch (e) { return []; } })();

    const cur = settings.getConfig();
    let cfg = JSON.parse(JSON.stringify(cur));

    if (opts.mode === 'replace') {
      // 替换全部：清空现有用户，用导入数据完全替换（设置采用导入包）
      cfg = sanitizeSettings(importedSettings, JSON.parse(JSON.stringify(cur)));
      cfg.users = [];
      cfg.currentUser = '';
    }

    const targetBase = opts.targetDir || (cur.workspacePath ? path.dirname(cur.workspacePath) : process.cwd());
    if (!fs.existsSync(targetBase)) { try { fs.mkdirSync(targetBase, { recursive: true }); } catch (e) { return { ok: false, message: '目标位置不可用：' + e.message }; } }

    const usedFolders = new Set((cfg.users || []).map((u) => path.basename(String(u.path || '').replace(/[\\/]+$/, ''))).filter(Boolean));
    const imported = [];

    for (const zu of selected) {
      // 目标文件夹名：优先用用户名，重名自动加后缀（不覆盖、不报错）
      const baseName = String(zu.name || '用户').replace(/[\\/:*?"<>|]/g, '_').trim() || '用户';
      let candidate = baseName;
      let i = 2;
      while (usedFolders.has(candidate)) { candidate = baseName + '(' + (i++) + ')'; }
      usedFolders.add(candidate);
      const dest = path.join(targetBase, candidate);
      fs.mkdirSync(dest, { recursive: true });
      const prefix = 'knowledge/' + zu.id + '/';
      const destResolved = path.resolve(dest);
      let files = 0;
      zip.getEntries().forEach((entry) => {
        const en = entry.entryName;
        if (!en.startsWith(prefix)) return;
        const rel = en.slice(prefix.length);
        if (!rel) return;
        const fp = path.join(dest, rel);
        if (path.resolve(fp).indexOf(destResolved) !== 0) return; // 防路径穿越
        const isMd = /\.md$/i.test(fp);
        let buf = entry.getData();
        if (isMd && (buf.length < 3 || buf[0] !== 0xEF)) buf = Buffer.concat([BOM, buf]);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, buf);
        files++;
      });
      // 新用户记录：插入追加（保留现有；同名允许，各自独立不报错）
      const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      cfg.users.push({ id: newId, name: String(zu.name || baseName), path: dest });
      imported.push({ name: String(zu.name || baseName), path: dest, folder: candidate, files });
    }

    // 确保有当前用户，并让 workspacePath 指向当前用户文件夹
    if (!cfg.currentUser && cfg.users.length) cfg.currentUser = cfg.users[0].id;
    const curU = cfg.users.find((u) => u.id === cfg.currentUser);
    if (curU) cfg.workspacePath = curU.path;

    settings.saveConfig(cfg);
    // 专注记录：replace 用导入的；insert 追加合并
    try {
      let recs = [];
      try { recs = JSON.parse(fs.readFileSync(recordsPath, 'utf8') || '[]'); } catch (e) {}
      if (opts.mode === 'replace') recs = importedRecords;
      else recs = recs.concat(importedRecords);
      fs.writeFileSync(recordsPath, JSON.stringify(recs, null, 2), 'utf8');
    } catch (e) { /* ignore */ }

    return { ok: true, imported, mode: opts.mode, config: cfg };
  } catch (e) {
    return { ok: false, message: '导入失败：' + e.message };
  }
}

module.exports = { exportZip, inspectZip, importZip };
