const { app, BrowserWindow, ipcMain, Menu, dialog, safeStorage, shell, net } = require('electron');
const path = require('path');
const fs = require('fs');

const Settings = require('./src/main/settings');
const { createPreviewServer } = require('./src/main/http-server');
const Workspace = require('./src/main/workspace');
const GitService = require('./src/main/git');
const ConfirmGate = require('./src/main/confirm-gate');
const { buildSystemPrompt } = require('./src/main/ai/prompts');
const { runAgent } = require('./src/main/ai/agent');
const { createTools } = require('./src/main/ai/tools');
const ocr = require('./src/main/ocr');
const TokenUsage = require('./src/main/token-usage');
const { checkDocsify, checkDocsifyPath, buildDocsify, applyExamPassword } = require('./src/main/builder');
const { parseProfile, saveProfile, uploadProfileImage, subjectStats, updateReadmeStats, searchErrors, deleteError, syncSidebar } = require('./src/main/site');
const { exportZip, inspectZip, importZip } = require('./src/main/data');

let win = null;
let previewServer = null;
let tokenUsage = null;

const settings = new Settings({ app, safeStorage, dialog });
const confirmGate = new ConfirmGate(() => win);
const workspace = new Workspace(() => settings.getConfig().workspacePath);
const git = new GitService(() => settings.getConfig().workspacePath);

const DEFAULT_WORKSPACE = path.join('d:', 'BaiduSyncdisk', '学习', '高考复习', '网页');

function createWindow() {
  win = new BrowserWindow({
    width: 1460,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: '错题助手',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    // 自定义标题栏：隐藏系统默认标题栏，用 titleBarOverlay 保留系统最小化/最大化/关闭按钮，底色与主题一致
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0f172a', symbolColor: '#9fb0c8', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('app:config', settings.getConfig());
    if (previewServer) win.webContents.send('preview:url', previewServer.getUrl());
  });
}

function ensureWorkspace() {
  const p = settings.getConfig().workspacePath;
  if (!p || !fs.existsSync(p)) {
    // 回退到默认路径
    if (fs.existsSync(DEFAULT_WORKSPACE)) {
      const cfg = settings.getConfig();
      cfg.workspacePath = DEFAULT_WORKSPACE;
      settings.saveConfig(cfg);
      return DEFAULT_WORKSPACE;
    }
    return p;
  }
  return p;
}

async function runAiTask(task) {
  const cfg = settings.getConfig();
  const wp = ensureWorkspace();
  const emit = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('agent:event', ev); };

  let provider = cfg.providers[task.providerId || cfg.activeProvider];
  // 本地服务（如 localhost / 127.0.0.1）不强制要求 API Key
  const isLocal = provider && /localhost|127\.0\.0\.1/.test(String(provider.baseUrl || ''));
  if (!provider || !provider.enabled || (!provider.apiKey && !isLocal)) {
    throw new Error('请先在「设置」中启用并配置 AI 提供商');
  }
  // 去除 API Key 首尾空白，避免复制粘贴带入空格导致 401
  if (provider.apiKey) provider = Object.assign({}, provider, { apiKey: String(provider.apiKey).trim() });
  if (task.hasImage && !provider.vision) {
    const vision = Object.keys(cfg.providers)
      .map((k) => cfg.providers[k])
      .find((p) => p.enabled && p.apiKey && p.vision);
    if (vision) provider = vision;
    else throw new Error('所选提供商不支持图片识别，且未启用任何视觉提供商（Kimi / Claude）');
  }

  // 每日 Token 消耗统计与超阈值预警（仅跨过阈值时提醒一次）
  const warnThreshold = Number(cfg.tokenWarn) || 500000;
  const onUsage = (count) => {
    if (!tokenUsage) return;
    const r = tokenUsage.add(count);
    if (r.total >= warnThreshold && r.total - count < warnThreshold) {
      emit({ type: 'token-warning', today: r.today, total: r.total, threshold: warnThreshold });
    }
  };

  const tools = createTools({ workspace, git, confirmGate, emit, windowRef: win });
  // 草稿模式：仅保留只读工具，禁止写文件 / Git（ask_user 允许，供核对 OCR 内容）
  if (task.draftOnly) {
    tools.defs = tools.defs.filter((t) =>
      ['list_files', 'read_file', 'git_status', 'ask_user'].indexOf(t.function.name) !== -1);
  }
  // 自动注入「编辑注意事项.md」，让 AI 遵守知识库既有规范（编码/锚点/git/污染串等）
  let editingNotes = '';
  try {
    const nr = workspace.read('编辑注意事项.md');
    if (nr.ok) editingNotes = nr.content;
  } catch (e) { /* 文件不存在则跳过 */ }
  const system = buildSystemPrompt(task.mode, cfg, editingNotes, task.draftOnly);
  const messages = task.messages || [];
  return runAgent({
    provider,
    system,
    messages,
    tools,
    onEvent: emit,
    onUsage,
    maxIters: 40
  });
}

function registerIpc() {
  ipcMain.handle('settings:get', () => settings.getConfig());
  ipcMain.handle('settings:save', (e, cfg) => {
    settings.saveConfig(cfg);
    if (win && !win.isDestroyed()) win.webContents.send('app:config', settings.getConfig());
    return settings.getConfig();
  });
  ipcMain.handle('settings:choose-workspace', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择知识库工作目录' });
    if (!r.canceled && r.filePaths.length) return r.filePaths[0];
    return null;
  });
  ipcMain.handle('settings:test', async (e, providerId, formCfg) => {
    const cfg = settings.getConfig();
    const saved = cfg.providers[providerId] || {};
    // 优先用表单当前填写的值测试（未保存也能测），缺失字段回退到已保存配置
    const p = Object.assign({}, saved, formCfg || {});
    if (p.apiKey) p.apiKey = String(p.apiKey).trim();
    // 本地服务（如 localhost / 127.0.0.1）无需 API Key
    const isLocal = p && /localhost|127\.0\.0\.1/.test(String(p.baseUrl || ''));
    if (!p.apiKey && !isLocal) return { ok: false, message: '未填写 API Key' };
    try {
      const { testConnection } = require('./src/main/ai/adapters');
      const latency = await testConnection(p);
      return { ok: true, latency };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('workspace:list', (e, rel) => workspace.list(rel || ''));
  ipcMain.handle('workspace:read', (e, rel) => workspace.read(rel));
  ipcMain.handle('workspace:write', (e, rel, content) => workspace.write(rel, content));
  ipcMain.handle('workspace:append', (e, rel, content) => workspace.append(rel, content));
  ipcMain.handle('workspace:create-subject', (e, subject, content) => workspace.createSubject(subject, content));

  // docsify 知识库构建 / 组卷密码
  ipcMain.handle('workspace:check-docsify', (e, rootPath) => {
    try { return checkDocsifyPath(rootPath || workspace.root()); }
    catch (e) { return { exists: false, error: e.message }; }
  });
  ipcMain.handle('workspace:build-docsify', (e, opts) => {
    const cfg = settings.getConfig();
    const examPassword = (opts && opts.examPassword != null) ? opts.examPassword : (cfg.examPassword || '');
    return buildDocsify(workspace, Object.assign({}, opts || {}, { examPassword }));
  });
  ipcMain.handle('workspace:set-exampwd', (e, pwd) => applyExamPassword(workspace, pwd || ''));

  // 站点档案（目标院校 / 关于作者）与统计
  ipcMain.handle('site:profile', () => { try { return parseProfile(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('site:save-profile', (e, data) => { try { return saveProfile(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('site:upload-image', (e, data) => { try { return uploadProfileImage(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('site:refresh-stats', () => { try { return updateReadmeStats(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('stats:list', () => { try { return { ok: true, subjects: subjectStats(workspace) }; } catch (e) { return { ok: false, message: e.message }; } });
  // 错题全文搜索（含题目）
  ipcMain.handle('stats:search', (e, query) => {
    try { return { ok: true, matches: searchErrors(workspace, query) }; }
    catch (e) { return { ok: false, message: e.message }; }
  });
  // 删除错题（移除档案中的条目并更新侧边栏）
  ipcMain.handle('stats:delete', (e, { file, n }) => {
    try { return deleteError(workspace, String(file || ''), Number(n) || 0); }
    catch (err) { return { ok: false, message: err.message }; }
  });
  // 同步侧边栏（录入/删除后重建各科错题记录列表）
  ipcMain.handle('stats:sync-sidebar', () => {
    try { return syncSidebar(workspace); }
    catch (e) { return { ok: false, message: e.message }; }
  });

  // 数据导出 / 导入（zip 多用户数据包）
  ipcMain.handle('data:export', async (e, opts) => {
    try {
      const cfg = settings.getConfig();
      let users = cfg.users || [];
      const ids = opts && opts.userIds;
      if (ids && ids.length) users = users.filter((u) => ids.indexOf(u.id) !== -1);
      if (!users.length) return { ok: false, message: '请至少选择一个用户' };
      let records = [];
      try { records = JSON.parse(fs.readFileSync(focusRecordsPath(), 'utf8') || '[]'); } catch (e) {}
      const r = exportZip(settings, users, records, { includeApi: !!(opts && opts.includeApi) });
      const s = await dialog.showSaveDialog(win, {
        title: '导出数据',
        defaultPath: path.join(app.getPath('documents'), '学习助手数据-' + new Date().toISOString().slice(0, 10) + '.zip'),
        filters: [{ name: 'ZIP 数据包', extensions: ['zip'] }]
      });
      if (s.canceled || !s.filePath) return { ok: false, cancelled: true };
      fs.writeFileSync(s.filePath, r.buffer);
      return { ok: true, path: s.filePath, users: r.users.length, files: r.totalFiles };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  // 读取 zip 数据包信息（导入弹窗预览；返回 base64 供导入时使用）
  ipcMain.handle('data:inspect', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择要导入的数据包', properties: ['openFile'], filters: [{ name: 'ZIP 数据包', extensions: ['zip'] }]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, cancelled: true };
      const buf = fs.readFileSync(r.filePaths[0]);
      const info = inspectZip(buf);
      if (!info.ok) return info;
      return { ok: true, file: r.filePaths[0], buffer: buf.toString('base64'), meta: info.meta, users: info.users };
    } catch (e) { return { ok: false, message: e.message }; }
  });
  ipcMain.handle('data:import', async (e, opts) => {
    try {
      if (!opts || !opts.buffer) return { ok: false, message: '数据为空' };
      const buffer = Buffer.from(opts.buffer, 'base64');
      return importZip(settings, focusRecordsPath(), {
        buffer,
        mode: opts.mode || 'insert',
        selectedIds: opts.selectedIds,
        targetDir: opts.targetDir
      });
    } catch (e) { return { ok: false, message: e.message }; }
  });

  // Git 授权配置
  const gitExec = (args, opts) => new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('git', args, Object.assign({ cwd: settings.getConfig().workspacePath, encoding: 'utf8', timeout: 20000 }, opts), (err, stdout, stderr) => {
      resolve(err ? { ok: false, err, stderr: (stderr || '').toString() } : { ok: true, out: (stdout || '').toString().trim() });
    });
  });
  ipcMain.handle('git:config-get', async () => {
    // 读取生效配置（优先仓库本地，其次全局）
    const name = await gitExec(['config', '--get', 'user.name']);
    const email = await gitExec(['config', '--get', 'user.email']);
    const remote = await gitExec(['remote', 'get-url', 'origin']);
    const isRepo = await gitExec(['rev-parse', '--is-inside-work-tree']);
    return { ok: true, name: name.ok ? name.out : '', email: email.ok ? email.out : '', remote: remote.ok ? remote.out : '', isRepo: isRepo.ok };
  });
  ipcMain.handle('git:config-set', async (e, { name, email }) => {
    const set = async (key, val) => {
      let r = await gitExec(['config', '--local', '--replace-all', key, val]);
      if (!r.ok) r = await gitExec(['config', '--global', '--replace-all', key, val]);
      return r;
    };
    if (name) { const r = await set('user.name', name); if (!r.ok) return { ok: false, message: r.err.message }; }
    if (email) { const r = await set('user.email', email); if (!r.ok) return { ok: false, message: r.err.message }; }
    return { ok: true };
  });
  ipcMain.handle('git:init-repo', async () => {
    const r = await gitExec(['init']);
    return r.ok ? { ok: true } : { ok: false, message: r.err.message };
  });

  // 环境检测（git / node / npm）
  const checkBin = (cmd) => new Promise((resolve) => {
    const { execFile } = require('child_process');
    // Windows 下 npm 为 npm.cmd，execFile 直接执行会 spawn EINVAL，需 shell:true
    const isWinCmd = process.platform === 'win32' && cmd === 'npm';
    const bin = isWinCmd ? 'npm.cmd' : cmd;
    const opts = { timeout: 8000 };
    if (isWinCmd) opts.shell = true;
    execFile(bin, ['--version'], opts, (err, stdout) => {
      if (!err) resolve({ ok: true, version: (stdout || '').toString().trim().split('\n')[0] || '' });
      else resolve({ ok: false, version: '' });
    });
  });
  ipcMain.handle('env:check', async () => {
    try {
      const git = await checkBin('git');
      const node = await checkBin('node');
      const npm = await checkBin('npm');
      return { ok: true, git, node, npm };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  // 命令安装环境（winget 自动安装）：{ items: ['git','node','npm'], dir: 目标位置 }
  const execWinget = (args) => new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('winget', args, { shell: true, encoding: 'utf8', timeout: 600000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: ((stderr || '') + (stdout || '')).toString().slice(0, 600) });
      else resolve({ ok: true, out: (stdout || '').toString() });
    });
  });
  ipcMain.handle('env:install', async (e, { items, dir }) => {
    try {
      const hasWinget = await checkBin('winget');
      if (!hasWinget.ok) {
        return { ok: false, message: '未检测到 Windows 包管理器（winget）。\n请改用「自行下载安装包安装」，或先到 Microsoft Store 安装「应用安装程序」。' };
      }
      const map = { git: 'Git.Git', node: 'OpenJS.NodeJS.LTS', npm: 'OpenJS.NodeJS.LTS' };
      const ids = [...new Set((items || []).map((k) => map[k]).filter(Boolean))];
      if (!ids.length) return { ok: false, message: '未选择需要安装的环境' };
      const results = [];
      for (const id of ids) {
        const args = ['install', '-e', '--id', id, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
        let r;
        if (dir) {
          r = await execWinget(args.concat(['--location', dir]));
          if (!r.ok) r = await execWinget(args); // 该包可能不支持 --location，回退默认位置
        } else {
          r = await execWinget(args);
        }
        results.push({ id, ok: r.ok, err: r.err || '', out: (r.out || '').slice(0, 300), usedLocation: !!dir });
      }
      return { ok: true, results };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // 多用户：列出已创建的用户记录（不扫描文件夹；用户主动选择文件夹并创建用户）
  ipcMain.handle('users:list', () => {
    const cfg = settings.getConfig();
    const users = (cfg.users || []).map((u) => {
      const exists = fs.existsSync(u.path);
      return {
        id: u.id,
        name: u.name,
        path: u.path,
        exists,
        hasDocsify: exists && fs.existsSync(path.join(u.path, 'index.html')),
        isCurrent: u.id === cfg.currentUser
      };
    });
    const cur = users.find((u) => u.isCurrent) || null;
    return { ok: true, current: cur ? cur.id : '', currentName: cur ? cur.name : '', users };
  });
  // 多用户：创建用户（用户选择了知识库文件夹，将其创建为用户）
  ipcMain.handle('users:create', (e, { name, path: p }) => {
    const safe = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!safe) return { ok: false, message: '请输入有效的用户名' };
    if (!p || !fs.existsSync(p)) return { ok: false, message: '请选择有效的知识库文件夹' };
    const cfg = settings.getConfig();
    const users = cfg.users || [];
    const np = path.normalize(p);
    if (users.some((u) => path.resolve(String(u.path)) === path.resolve(np))) {
      return { ok: false, message: '该文件夹已创建为用户' };
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    users.push({ id, name: safe, path: np });
    cfg.users = users;
    cfg.currentUser = id;
    cfg.workspacePath = np;
    settings.saveConfig(cfg);
    return { ok: true, id, path: np, name: safe };
  });
  // 多用户：在指定位置新建文件夹（供新增用户时选择位置）
  ipcMain.handle('users:mkdir', (e, { base, name }) => {
    const safe = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
    if (!safe) return { ok: false, message: '请输入有效的文件夹名称' };
    const dir = path.join(base || '', safe);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return { ok: false, message: e.message }; }
    return { ok: true, path: dir };
  });
  // 多用户：切换当前用户（按 id；同时切换 workspacePath，workspace 动态读取生效）
  ipcMain.handle('users:switch', (e, id) => {
    const cfg = settings.getConfig();
    const u = (cfg.users || []).find((x) => x.id === id);
    if (!u) return { ok: false, message: '用户不存在' };
    cfg.currentUser = id;
    cfg.workspacePath = u.path;
    settings.saveConfig(cfg);
    return settings.getConfig();
  });
  // 多用户：确保存在当前用户（初始化配置完成后调用；无用户时按当前知识库自动创建默认用户）
  ipcMain.handle('users:ensure-current', () => {
    const cfg = settings.getConfig();
    if ((cfg.users || []).length) return cfg;
    const wp = cfg.workspacePath;
    if (!wp) return cfg;
    const safe = String(cfg.nickname || '').trim().replace(/[\\/:*?"<>|]/g, '_') || path.basename(wp) || '默认用户';
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    cfg.users = (cfg.users || []).concat([{ id, name: safe, path: path.normalize(wp) }]);
    cfg.currentUser = id;
    settings.saveConfig(cfg);
    return settings.getConfig();
  });
  // 多用户：删除用户（仅移除用户记录，不删除其知识库文件夹；至少保留一个用户；删除当前用户时自动切到剩余第一个）
  ipcMain.handle('users:remove', (e, id) => {
    const cfg = settings.getConfig();
    const users = (cfg.users || []).filter((u) => u.id !== id);
    if (users.length === (cfg.users || []).length) return { ok: false, message: '用户不存在' };
    if (users.length < 1) return { ok: false, message: '至少需要保留一个用户，不能删除' };
    cfg.users = users;
    if (cfg.currentUser === id) {
      const next = users[0];
      cfg.currentUser = next.id;
      cfg.workspacePath = next.path;
    }
    settings.saveConfig(cfg);
    return settings.getConfig();
  });

  // 当日 Token 消耗统计
  ipcMain.handle('token:usage', () => {
    if (!tokenUsage) return { today: '', total: 0, threshold: Number(settings.getConfig().tokenWarn) || 500000 };
    const g = tokenUsage.get();
    return { today: g.today, total: g.total, threshold: Number(settings.getConfig().tokenWarn) || 500000 };
  });
  ipcMain.handle('git:remote-set', async (e, url) => {
    if (!url || !/^https?:\/\//.test(url)) return { ok: false, message: '远程地址格式不正确' };
    let r = await gitExec(['remote', 'set-url', 'origin', url]);
    if (!r.ok) r = await gitExec(['remote', 'add', 'origin', url]);
    return r.ok ? { ok: true } : { ok: false, message: r.err.message };
  });
  ipcMain.handle('git:test-auth', async () => {
    const r = await gitExec(['ls-remote', 'origin', 'HEAD']);
    if (r.ok) return { ok: true, message: '连接成功，授权可用' };
    const msg = (r.stderr || r.err.message).trim().split('\n').pop() || '连接失败';
    return { ok: false, message: msg };
  });
  ipcMain.handle('git:clear-creds', async () => {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('cmdkey', ['/delete:git:https://github.com'], { stdio: 'ignore' });
      return { ok: true, message: '已清除 GitHub 凭据（下次推送将重新要求登录）' };
    } catch (e) {
      return { ok: true, message: '未找到已保存的 GitHub 凭据，无需清除' };
    }
  });

  ipcMain.handle('git:status', () => git.status());
  ipcMain.handle('git:clean', () => git.clean());
  ipcMain.handle('git:commit', (e, msg) => git.commit(msg));
  ipcMain.handle('git:push', () => git.push());
  ipcMain.handle('git:log', (e, n) => git.log(n || 20));
  ipcMain.handle('git:scan', () => git.scanAigc());

  ipcMain.handle('preview:url', () => (previewServer ? previewServer.getUrl() : ''));

  // 专注记录存储（userData/focus-records.json）
  const focusRecordsPath = () => path.join(app.getPath('userData'), 'focus-records.json');
  const readRecords = () => {
    try {
      const arr = JSON.parse(fs.readFileSync(focusRecordsPath(), 'utf8') || '[]');
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  };
  const writeRecords = (arr) => {
    try { fs.writeFileSync(focusRecordsPath(), JSON.stringify(arr, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
    return arr;
  };
  ipcMain.handle('records:list', () => readRecords());
  ipcMain.handle('records:add', (e, rec) => {
    const arr = readRecords();
    // 无 id 则自动分配（供删除定位）
    if (!rec || !rec.id) rec = Object.assign({}, rec, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) });
    arr.push(rec);
    return writeRecords(arr);
  });
  // 删除单条专注记录（按 id）
  ipcMain.handle('records:delete', (e, id) => {
    const arr = readRecords();
    const next = arr.filter((r) => String(r && r.id) !== String(id));
    return writeRecords(next);
  });
  // 清空全部专注记录
  ipcMain.handle('records:clear', () => writeRecords([]));

  ipcMain.handle('ai:run-task', async (e, task) => {
    try {
      // runAgent 返回 { content } 对象，这里解包为纯字符串再返回
      const result = await runAiTask(task);
      return { ok: true, content: result && result.content ? result.content : '' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  // 本地 OCR（可选引擎：win=Windows 自带，tesseract=Tesseract.js，设置中选择）
  ipcMain.handle('ocr:local', async (e, imageDataUrl) => {
    try {
      const b64 = String(imageDataUrl || '').replace(/^data:[^;]+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length) return { ok: false, message: '图片数据为空' };
      const cfg = settings.getConfig();
      const engine = (cfg.ocr && cfg.ocr.engine) || 'win';
      const text = await ocr.ocrImage(buf, engine);
      return { ok: true, text: text || '' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });

  ipcMain.handle('app:open-external', (e, url) => shell.openExternal(url));

  // ---------- 远程更新（GitHub Releases） ----------
  const GITHUB_REPO = 'kfdzcoffee/StudyAssistant';
  // 用 Electron net（Chromium 网络栈）请求，走系统代理/证书，避免 Node https 的证书验证问题
  const httpsGet = (url) => new Promise((resolve, reject) => {
    const req = net.request(url);
    req.setHeader('User-Agent', 'StudyAssistant');
    // 绕过 HTTP 缓存，确保每次检查都获取服务器最新的 version.json
    req.setHeader('Cache-Control', 'no-cache');
    req.setHeader('Pragma', 'no-cache');
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
  // 检查更新：优先读取官网 version.json，失败则回退 GitHub Releases
  ipcMain.handle('update:check', async () => {
    // 1) 官网 version.json
    try {
      const body = await httpsGet('https://studyassistant.kfdzcoffee.cn/version.json');
      const j = JSON.parse(body.toString('utf8'));
      if (j && j.version) {
        return {
          ok: true,
          version: String(j.version).replace(/^v/i, ''),
          name: j.app || '',
          notes: j.notes || '',
          url: j.url || '',
          source: 'website',
          published: ''
        };
      }
    } catch (e) { /* 官网不可用，走 GitHub 回退 */ }
    // 2) GitHub Releases 回退
    try {
      const body = await httpsGet('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest');
      const j = JSON.parse(body.toString('utf8'));
      const tag = String(j.tag_name || '').replace(/^v/i, '');
      const asset = (j.assets || []).find((a) => /\.exe$/i.test(a.name)) || (j.assets || [])[0];
      return {
        ok: true,
        version: tag,
        name: j.name || '',
        notes: j.body || '',
        url: asset ? asset.browser_download_url : (j.html_url || ''),
        source: 'github',
        published: j.published_at || ''
      };
    } catch (e) {
      return { ok: false, message: e.message || '网络错误，无法访问更新源' };
    }
  });
  // 下载新版安装包（带进度推送），完成后自动运行安装程序
  ipcMain.handle('update:apply', async (e, url) => {
    try {
      if (!url) return { ok: false, message: '缺少下载地址' };
      const emit = (ev) => { if (win && !win.isDestroyed()) win.webContents.send('update:progress', ev); };
      const fileName = decodeURIComponent(url.split('/').pop()) || 'study-helper-update.exe';
      const target = path.join(app.getPath('temp'), fileName);
      const body = await new Promise((resolve, reject) => {
        const req = net.request(url);
        req.setHeader('User-Agent', 'StudyAssistant');
        req.on('response', (res) => {
          if (res.statusCode >= 400) { reject(new Error('HTTP ' + res.statusCode)); res.resume(); return; }
          const total = Number(res.headers['content-length']) || 0;
          let received = 0;
          const chunks = [];
          res.on('data', (c) => {
            chunks.push(c); received += c.length;
            emit({ status: 'downloading', received, total, percent: total ? Math.round((received / total) * 100) : 0 });
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
      });
      emit({ status: 'done', received: body.length, total: body.length, percent: 100 });
      fs.writeFileSync(target, body);
      shell.openPath(target);
      return { ok: true, path: target, size: body.length };
    } catch (e) {
      return { ok: false, message: e.message || '下载失败' };
    }
  });

  // 标题栏覆盖层（跟随主题变色）与窗口最大化切换
  ipcMain.handle('window:set-overlay', (e, { color, symbolColor }) => {
    try {
      if (win && !win.isDestroyed() && win.setTitleBarOverlay) {
        win.setTitleBarOverlay({ color: color || '#0f172a', symbolColor: symbolColor || '#9fb0c8', height: 44 });
      }
    } catch (err) { /* 忽略 */ }
    return true;
  });
  ipcMain.handle('window:toggle-maximize', () => {
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return true;
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  confirmGate.init(ipcMain);
  registerIpc();
  ocr.setDataDir(path.join(app.getPath('userData'), 'ocr-tessdata'));
  tokenUsage = new TokenUsage({ file: path.join(app.getPath('userData'), 'token-usage.json') });
  ensureWorkspace();
  previewServer = createPreviewServer({ getRoot: () => settings.getConfig().workspacePath });
  await previewServer.start();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
