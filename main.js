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
const papers = require('./src/main/papers');
const todos = require('./src/main/todos');
const errorBank = require('./src/main/error-bank');
const vocab = require('./src/main/vocab');
const sync = require('./src/main/sync');
const { LocalModelManager } = require('./src/main/local-models');

let win = null;
let previewServer = null;
let tokenUsage = null;

const settings = new Settings({ app, safeStorage, dialog });
const confirmGate = new ConfirmGate(() => win);
const workspace = new Workspace(() => settings.getConfig().workspacePath);
const git = new GitService(() => settings.getConfig().workspacePath);
const localModels = new LocalModelManager();

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

  const runtimeCfg = Object.assign({ mode: 'api', local: {} }, cfg.modelRuntime || {});
  let provider = null;
  if (runtimeCfg.mode === 'local') {
    const localCfg = Object.assign({
      enabled: true,
      selectedModelId: 'qwen2.5-1.5b',
      modelStorePath: '',
      idlePolicy: 'idle_5m',
      idleMinutes: 5
    }, runtimeCfg.local || {});
    const p = localModels.buildProvider(localCfg, cfg.providers.local || {});
    if (task.hasImage && !p.vision) {
      throw new Error('当前本机模型不支持视觉识别，请在设置中切换支持视觉的本机模型。');
    }
    const content = await localModels.generate(task.messages || [], localCfg);
    return { content: content || '' };
  } else {
    provider = cfg.providers[task.providerId || cfg.activeProvider];
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
  // ===== 云端同步：注册各集合的本地读写器 =====
  // 生词本/文言文（workspace 生词本/）
  sync.registerReader('words', () => { try { return vocab.listWords(workspace).words || []; } catch (e) { return []; } });
  sync.registerWriter('words', (arr) => { try { vocab.replaceAllWords(workspace, arr); } catch (e) { /* 忽略 */ } });
  sync.registerReader('wenyan', () => { try { return vocab.listWenyan(workspace).words || []; } catch (e) { return []; } });
  sync.registerWriter('wenyan', (arr) => { try { vocab.replaceAllWenyan(workspace, arr); } catch (e) { /* 忽略 */ } });
  // 待办（userData study-assistant/todos.json）
  sync.registerReader('todos', () => { try { return todos.listTodos().todos || []; } catch (e) { return []; } });
  sync.registerWriter('todos', (arr) => { try { todos.replaceAll(arr); } catch (e) { /* 忽略 */ } });
  // 专注记录（userData focus-records.json）
  sync.registerReader('focus_records', () => readRecords());
  sync.registerWriter('focus_records', (arr) => writeRecords(arr));
  // 错题库（workspace 错题库/index.json、groups.json）
  sync.registerReader('errors', () => { try { return errorBank.listErrors(workspace).errors || []; } catch (e) { return []; } });
  sync.registerWriter('errors', (arr) => { try { errorBank.replaceAllErrors(workspace, arr); } catch (e) { /* 忽略 */ } });
  sync.registerReader('error_groups', () => { try { return errorBank.listGroups(workspace).groups || []; } catch (e) { return []; } });
  sync.registerWriter('error_groups', (arr) => { try { errorBank.replaceAllGroups(workspace, arr); } catch (e) { /* 忽略 */ } });
  // 知识库笔记（workspace 下所有 .md 文件，含错题正文/作文/分数预测/README/_sidebar 等）
  sync.registerReader('notes', () => readWorkspaceNotes());
  sync.registerWriter('notes', (arr) => writeWorkspaceNotes(arr));
  // 应用设置（config.json 中可跨端同步的部分：考试配置、昵称、自定义提示词、主题）
  sync.registerReader('settings', () => readSyncSettings());
  sync.registerWriter('settings', (arr) => writeSyncSettings(arr));

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

  // ===== 本机模型管理（内置 Transformers.js） =====
  ipcMain.handle('local:model:catalog', () => ({ ok: true, models: localModels.getCatalog() }));
  ipcMain.handle('local:model:state', async () => {
    const cfg = settings.getConfig();
    const localCfg = (cfg.modelRuntime && cfg.modelRuntime.local) || {};
    return localModels.getRuntimeState(localCfg);
  });
  ipcMain.handle('local:model:choose-dir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: '选择本机模型安装目录' });
    if (!r.canceled && r.filePaths.length) return { ok: true, path: r.filePaths[0] };
    return { ok: false, cancelled: true };
  });
  ipcMain.handle('local:model:detect', async (e, modelId) => localModels.detectDevice(modelId));
  ipcMain.handle('local:model:install', async (e, modelId, force) => {
    const cfg = settings.getConfig();
    const localCfg = (cfg.modelRuntime && cfg.modelRuntime.local) || {};
    const onProgress = (p) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('local:model:progress', Object.assign({}, p || {}));
      }
    };
    return localModels.installModel(modelId, localCfg, !!force, onProgress);
  });
  ipcMain.handle('local:model:start', async () => {
    const cfg = settings.getConfig();
    const localCfg = (cfg.modelRuntime && cfg.modelRuntime.local) || {};
    const onProgress = (p) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('local:model:progress', Object.assign({}, p || {}));
      }
    };
    return localModels.startService(localCfg, onProgress);
  });
  ipcMain.handle('local:model:stop', async () => localModels.stopService());

  ipcMain.handle('workspace:list', (e, rel) => workspace.list(rel || ''));
  ipcMain.handle('workspace:read', (e, rel) => workspace.read(rel));
  ipcMain.handle('workspace:write', (e, rel, content) => workspace.write(rel, content));
  ipcMain.handle('workspace:append', (e, rel, content) => workspace.append(rel, content));
  ipcMain.handle('workspace:create-subject', (e, subject, content, opts) => workspace.createSubject(subject, content, Object.assign({}, opts || {})));

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

  // ===== 试卷管理 =====
  ipcMain.handle('papers:list', () => { try { return papers.listPapers(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:add', (e, data) => { try { return papers.addPaper(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:delete', (e, id) => { try { return papers.deletePaper(workspace, id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:read-image', (e, rel) => { try { return papers.readPaperImage(workspace, rel); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:save-analysis', (e, id, content) => { try { return papers.saveAnalysis(workspace, id, content); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:read-analysis', (e, id) => { try { return papers.readAnalysis(workspace, id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:link-error', (e, id, err) => { try { return papers.linkError(workspace, id, err); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:unlink-error', (e, id, number) => { try { return papers.unlinkError(workspace, id, number); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('papers:find-by-error', (e, number) => { try { return { ok: true, papers: papers.findPaperByError(workspace, number) }; } catch (e) { return { ok: false, message: e.message }; } });

  // ===== 任务待办 =====
  ipcMain.handle('todos:list', () => { try { return todos.listTodos(); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('todos:add', (e, data) => { try { return todos.addTodo(data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('todos:toggle', (e, id) => { try { return todos.toggleTodo(id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('todos:update', (e, id, data) => { try { return todos.updateTodo(id, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('todos:delete', (e, id) => { try { return todos.deleteTodo(id); } catch (e) { return { ok: false, message: e.message }; } });

  // ===== 统一错题库 =====
  ipcMain.handle('errorbank:scan', () => { try { return errorBank.scanAndRebuild(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:list', () => { try { return errorBank.listErrors(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:add', (e, data) => { try { return errorBank.addError(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:get', (e, number) => { try { return errorBank.getError(workspace, number); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:update', (e, number, data) => { try { return errorBank.updateError(workspace, number, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:delete', (e, number) => { try { return errorBank.deleteError(workspace, number); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:search', (e, q) => { try { return errorBank.searchErrors(workspace, q); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:groups', () => { try { return errorBank.listGroups(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:add-group', (e, name) => { try { return errorBank.addGroup(workspace, name); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:delete-group', (e, id, opts) => { try { return errorBank.deleteGroup(workspace, id, opts); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:move-group', (e, numbers, groupName) => { try { return errorBank.moveErrorsToGroup(workspace, numbers, groupName); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:set-familiarity', (e, numbers, familiarity) => { try { return errorBank.setFamiliarity(workspace, numbers, familiarity); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:link-paper', (e, number, paper) => { try { return errorBank.linkPaper(workspace, number, paper); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:unlink-paper', (e, number, paperId) => { try { return errorBank.unlinkPaper(workspace, number, paperId); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:list-attachments', (e, number) => { try { return errorBank.listAttachments(workspace, number); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:add-attachment', (e, number, data) => { try { return errorBank.addAttachment(workspace, number, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:read-attachment', (e, number, name) => { try { return errorBank.readAttachment(workspace, number, name); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('errorbank:delete-attachment', (e, number, name) => { try { return errorBank.deleteAttachment(workspace, number, name); } catch (e) { return { ok: false, message: e.message }; } });

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

  // ===== 知识库笔记同步（workspace 下所有 .md 文件） =====
  // 递归收集 workspace 下所有 .md 文件，每条记录以相对路径为业务主键
  const collectWorkspaceMd = (dir, base) => {
    const out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const ent of entries) {
      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === 'temp') continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        out.push(...collectWorkspaceMd(full, base));
      } else if (ent.name.toLowerCase().endsWith('.md')) {
        const rel = path.relative(base, full).replace(/\\/g, '/');
        try {
          let content = fs.readFileSync(full, 'utf8');
          // 去掉 BOM
          if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
          out.push({ path: rel, content });
        } catch (e) { /* 忽略 */ }
      }
    }
    return out;
  };
  const readWorkspaceNotes = () => {
    try {
      const root = workspace.root();
      if (!fs.existsSync(root)) return [];
      return collectWorkspaceMd(root, root).map((n) => {
        // 用文件 mtime 作为 updatedAt 基准（无版本号则从 1 开始）
        const fp = workspace.resolve(n.path);
        let mtime = '';
        try { mtime = new Date(fs.statSync(fp).mtime).toISOString(); } catch (e) {}
        return { path: n.path, content: n.content, updatedAt: mtime, version: 1, deleted: false };
      });
    } catch (e) { return []; }
  };
  const writeWorkspaceNotes = (arr) => {
    try {
      const root = workspace.root();
      if (!fs.existsSync(root)) return;
      for (const rec of Array.isArray(arr) ? arr : []) {
        if (!rec || !rec.path) continue;
        const fp = workspace.resolve(rec.path);
        if (rec.deleted) {
          // 云端删除 → 本地删除（仅删除 .md 文件）
          try { if (fs.existsSync(fp) && fp.toLowerCase().endsWith('.md')) fs.unlinkSync(fp); } catch (e) {}
          continue;
        }
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        // 遵循知识库规范：.md 写 UTF-8+BOM
        const content = String(rec.content || '');
        fs.writeFileSync(fp, '\uFEFF' + content, 'utf8');
      }
    } catch (e) { /* 忽略 */ }
  };

  // ===== 应用设置同步（config.json 中可跨端同步的部分） =====
  // 只同步：exam（考试配置）、nickname（昵称）、prompts（自定义提示词）、theme（主题）
  // 不同步：providers.apiKey（敏感）、users/workspacePath/sync（本机相关）
  const readSyncSettings = () => {
    const cfg = settings.getConfig();
    const rec = {
      key: 'app',
      value: {
        exam: cfg.exam || {},
        nickname: cfg.nickname || '',
        prompts: cfg.prompts || {},
        theme: cfg.theme || 'dark'
      },
      updatedAt: new Date().toISOString(),
      version: 1,
      deleted: false
    };
    return [rec];
  };
  const writeSyncSettings = (arr) => {
    try {
      const rec = (Array.isArray(arr) ? arr : []).find((r) => r && r.key === 'app' && !r.deleted);
      if (!rec || !rec.value) return;
      const cfg = settings.getConfig();
      const v = rec.value || {};
      if (v.exam) cfg.exam = Object.assign({ type: 'gaokao', name: '', year: 2027, month: 6, day: 7 }, v.exam);
      if (typeof v.nickname === 'string') cfg.nickname = v.nickname;
      if (v.prompts) cfg.prompts = Object.assign({}, cfg.prompts, v.prompts);
      if (typeof v.theme === 'string') cfg.theme = v.theme;
      settings.saveConfig(cfg);
    } catch (e) { /* 忽略 */ }
  };

  ipcMain.handle('records:list', () => readRecords());
  ipcMain.handle('records:add', (e, rec) => {
    const arr = readRecords();
    // 无 id 则自动分配（供删除定位）
    if (!rec || !rec.id) rec = Object.assign({}, rec, { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7) });
    // 同步版本字段
    rec.updatedAt = new Date().toISOString();
    rec.version = (rec.version || 1) + 1;
    arr.push(rec);
    return writeRecords(arr);
  });
  // 删除单条专注记录（按 id，软删除便于同步传播）
  ipcMain.handle('records:delete', (e, id) => {
    const arr = readRecords();
    const rec = arr.find((r) => String(r && r.id) === String(id));
    if (rec) {
      rec.deleted = true;
      rec.updatedAt = new Date().toISOString();
      rec.version = (rec.version || 1) + 1;
    }
    return writeRecords(arr);
  });
  // 清空全部专注记录（软删除全部，便于同步传播）
  ipcMain.handle('records:clear', () => {
    const arr = readRecords();
    const now = new Date().toISOString();
    arr.forEach((r) => { r.deleted = true; r.updatedAt = now; r.version = (r.version || 1) + 1; });
    return writeRecords(arr);
  });

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
          // Electron net 的响应头保留原始大小写（可能是 Content-Length），需大小写不敏感读取
          const h = res.headers || {};
          const cl = h['content-length'] || h['Content-Length'] || h['CONTENT-LENGTH'] || 0;
          const total = Number(cl) || 0;
          let received = 0;
          const chunks = [];
          res.on('data', (c) => {
            chunks.push(c); received += c.length;
            emit({ status: 'downloading', received, total, percent: total ? Math.round((received / total) * 100) : Math.min(99, Math.round(received / 100000)) });
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

  // 清理缓存与旧安装包（临时目录安装包 + Chromium 缓存）
  ipcMain.handle('cache:clean', () => {
    try {
      const temp = app.getPath('temp');
      const patterns = [/学习助手-安装-.*\.exe/i, /studyassistant-.*\.exe/i, /study-helper-.*\.nsis\.7z/i, /\.exe\.blockmap$/i, /^latest\.yml$/i, /^builder-effective-config\.yaml$/i, /^builder-debug\.yml$/i];
      let files = [];
      let freed = 0;
      let deleted = [];
      try {
        files = fs.readdirSync(temp).filter((f) => patterns.some((p) => p.test(f)));
        files.forEach((f) => {
          const fp = path.join(temp, f);
          try { freed += fs.statSync(fp).size; fs.unlinkSync(fp); deleted.push(f); } catch (e) { /* 占用则跳过 */ }
        });
      } catch (e) { /* temp 读取失败则跳过 */ }
      // 清理 Chromium 缓存（不影响知识库 / 设置 / 用户数据）
      const ud = app.getPath('userData');
      ['Cache', 'GPUCache', 'Code Cache', 'CachedData', 'DawnCache'].forEach((d) => {
        const dp = path.join(ud, d);
        if (fs.existsSync(dp)) { try { fs.rmSync(dp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
      });
      return { ok: true, files: deleted.length, freed, list: deleted };
    } catch (e) {
      return { ok: false, message: e.message || '清理失败' };
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

  // ===== 生词本（英语单词 + 文言文） =====
  ipcMain.handle('vocab:words-list', () => { try { return vocab.listWords(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:words-add', (e, data) => { try { return vocab.addWord(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:words-update', (e, id, data) => { try { return vocab.updateWord(workspace, id, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:words-delete', (e, id) => { try { return vocab.deleteWord(workspace, id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:wenyan-list', () => { try { return vocab.listWenyan(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:wenyan-add', (e, data) => { try { return vocab.addWenyan(workspace, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:wenyan-update', (e, id, data) => { try { return vocab.updateWenyan(workspace, id, data); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:wenyan-delete', (e, id) => { try { return vocab.deleteWenyan(workspace, id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:words-export', (e, opts) => { try { return vocab.exportWords(win, opts); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:wenyan-export', (e, opts) => { try { return vocab.exportWenyan(win, opts); } catch (e) { return { ok: false, message: e.message }; } });
  // 艾宾浩斯复习
  ipcMain.handle('vocab:review-overview', () => { try { return vocab.reviewOverview(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:review-due', () => { try { return vocab.reviewDue(workspace); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:review-submit', (e, id, correct) => { try { return vocab.submitReview(workspace, id, correct); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:review-reset', (e, id) => { try { return vocab.resetReview(workspace, id); } catch (e) { return { ok: false, message: e.message }; } });
  ipcMain.handle('vocab:review-export', (e, opts) => { try { return vocab.exportReview(win, opts); } catch (e) { return { ok: false, message: e.message }; } });

  // ===== 云端同步 =====
  // 登录：用配置的账号密码换取 token
  ipcMain.handle('sync:login', async (e, cfg) => {
    try {
      const r = await sync.login(cfg || settings.getConfig().sync || {});
      if (r.ok) {
        const c = settings.getConfig();
        c.sync = Object.assign({}, c.sync || {}, { token: r.token, lastSync: new Date().toISOString() });
        settings.saveConfig(c);
      }
      return r;
    } catch (err) { return { ok: false, message: err.message }; }
  });
  // 全量同步所有启用的集合
  ipcMain.handle('sync:all', async (e, cfg) => {
    try {
      const c = settings.getConfig();
      const syncCfg = Object.assign({}, c.sync || {}, cfg || {});
      if (!syncCfg.token) {
        const login = await sync.login(syncCfg);
        if (!login.ok) return { ok: false, message: '请先在设置中登录云端账号' };
        syncCfg.token = login.token;
        c.sync = Object.assign({}, c.sync || {}, { token: login.token });
        settings.saveConfig(c);
      }
      const r = await sync.syncAll(syncCfg);
      if (r.ok) {
        c.sync = Object.assign({}, c.sync || {}, { lastSync: new Date().toISOString() });
        settings.saveConfig(c);
      }
      return r;
    } catch (err) { return { ok: false, message: err.message }; }
  });
  // 同步单个集合
  ipcMain.handle('sync:collection', async (e, collection, cfg) => {
    try {
      const c = settings.getConfig();
      const syncCfg = Object.assign({}, c.sync || {}, cfg || {});
      if (!syncCfg.token) return { ok: false, message: '请先在设置中登录云端账号' };
      return await sync.syncCollection(syncCfg, collection);
    } catch (err) { return { ok: false, message: err.message }; }
  });
  // 从云端下载数据（覆盖本地，以云端为权威）
  ipcMain.handle('sync:download', async (e, cfg) => {
    try {
      const c = settings.getConfig();
      const syncCfg = Object.assign({}, c.sync || {}, cfg || {});
      if (!syncCfg.token) {
        const login = await sync.login(syncCfg);
        if (!login.ok) return { ok: false, message: '请先在设置中登录云端账号' };
        syncCfg.token = login.token;
        c.sync = Object.assign({}, c.sync || {}, { token: login.token });
        settings.saveConfig(c);
      }
      const r = await sync.downloadAll(syncCfg);
      if (r.ok) {
        c.sync = Object.assign({}, c.sync || {}, { lastSync: new Date().toISOString() });
        settings.saveConfig(c);
      }
      return r;
    } catch (err) { return { ok: false, message: err.message }; }
  });
  // 检测本地与云端差异（哪个最新）
  ipcMain.handle('sync:diff', async (e, cfg) => {
    try {
      const c = settings.getConfig();
      const syncCfg = Object.assign({}, c.sync || {}, cfg || {});
      if (!syncCfg.token) {
        const login = await sync.login(syncCfg);
        if (!login.ok) return { ok: false, message: '请先在设置中登录云端账号' };
        syncCfg.token = login.token;
        c.sync = Object.assign({}, c.sync || {}, { token: login.token });
        settings.saveConfig(c);
      }
      return await sync.checkDiff(syncCfg);
    } catch (err) { return { ok: false, message: err.message }; }
  });
  // 测试服务器连接
  ipcMain.handle('sync:test', async (e, cfg) => {
    try {
      const url = String((cfg && cfg.serverUrl) || '').replace(/\/+$/, '');
      if (!url) return { ok: false, message: '未填写服务器地址' };
      const r = await sync.login(Object.assign({}, cfg, { serverUrl: url }));
      return r.ok ? { ok: true, message: '连接成功' } : { ok: false, message: r.message };
    } catch (err) { return { ok: false, message: err.message }; }
  });
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  // 允许渲染进程枚举本地已安装字体（设置 → 外观 → 界面字体）
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'local-fonts');
  });
  confirmGate.init(ipcMain);
  registerIpc();
  ocr.setDataDir(path.join(app.getPath('userData'), 'ocr-tessdata'));
  tokenUsage = new TokenUsage({ file: path.join(app.getPath('userData'), 'token-usage.json') });
  const cfg = settings.getConfig();
  if (cfg.modelRuntime && cfg.modelRuntime.mode === 'local') {
    const localCfg = cfg.modelRuntime.local || {};
    if (localCfg.enabled && localCfg.idlePolicy === 'always_on') {
      localModels.startService(localCfg).catch(() => {});
    }
  }
  ensureWorkspace();
  try { errorBank.scanAndRebuild(workspace); } catch (e) { console.error('error-bank scan failed:', e); }
  previewServer = createPreviewServer({ getRoot: () => settings.getConfig().workspacePath });
  await previewServer.start();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
