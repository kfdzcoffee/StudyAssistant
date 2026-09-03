const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: (cfg) => ipcRenderer.invoke('settings:save', cfg),
    test: (providerId, cfg) => ipcRenderer.invoke('settings:test', providerId, cfg),
    chooseWorkspace: () => ipcRenderer.invoke('settings:choose-workspace')
  },
  workspace: {
    list: (rel) => ipcRenderer.invoke('workspace:list', rel || ''),
    read: (rel) => ipcRenderer.invoke('workspace:read', rel),
    write: (rel, content) => ipcRenderer.invoke('workspace:write', rel, content),
    append: (rel, content) => ipcRenderer.invoke('workspace:append', rel, content),
    createSubject: (subject, content) => ipcRenderer.invoke('workspace:create-subject', subject, content),
    checkDocsify: (path) => ipcRenderer.invoke('workspace:check-docsify', path || ''),
    buildDocsify: (opts) => ipcRenderer.invoke('workspace:build-docsify', opts),
    setExamPwd: (pwd) => ipcRenderer.invoke('workspace:set-exampwd', pwd)
  },
  git: {
    status: () => ipcRenderer.invoke('git:status'),
    clean: () => ipcRenderer.invoke('git:clean'),
    commit: (msg) => ipcRenderer.invoke('git:commit', msg),
    push: () => ipcRenderer.invoke('git:push'),
    log: (n) => ipcRenderer.invoke('git:log', n),
    scan: () => ipcRenderer.invoke('git:scan')
  },
  ai: {
    runTask: (task) => ipcRenderer.invoke('ai:run-task', task),
    ocrLocal: (imageDataUrl) => ipcRenderer.invoke('ocr:local', imageDataUrl)
  },
  localModel: {
    catalog: () => ipcRenderer.invoke('local:model:catalog'),
    state: () => ipcRenderer.invoke('local:model:state'),
    chooseDir: () => ipcRenderer.invoke('local:model:choose-dir'),
    detect: (modelId) => ipcRenderer.invoke('local:model:detect', modelId),
    install: (modelId, force) => ipcRenderer.invoke('local:model:install', modelId, !!force),
    start: () => ipcRenderer.invoke('local:model:start'),
    stop: () => ipcRenderer.invoke('local:model:stop'),
    onProgress: (cb) => {
      ipcRenderer.on('local:model:progress', (_e, data) => { if (typeof cb === 'function') cb(data); });
    }
  },
  records: {
    list: () => ipcRenderer.invoke('records:list'),
    add: (rec) => ipcRenderer.invoke('records:add', rec),
    del: (id) => ipcRenderer.invoke('records:delete', id),
    clear: () => ipcRenderer.invoke('records:clear')
  },
  site: {
    profile: () => ipcRenderer.invoke('site:profile'),
    saveProfile: (data) => ipcRenderer.invoke('site:save-profile', data),
    uploadImage: (data) => ipcRenderer.invoke('site:upload-image', data),
    refreshStats: () => ipcRenderer.invoke('site:refresh-stats'),
    stats: () => ipcRenderer.invoke('stats:list'),
    search: (query) => ipcRenderer.invoke('stats:search', query),
    del: (file, n) => ipcRenderer.invoke('stats:delete', { file, n }),
    syncSidebar: () => ipcRenderer.invoke('stats:sync-sidebar')
  },
  papers: {
    list: () => ipcRenderer.invoke('papers:list'),
    add: (data) => ipcRenderer.invoke('papers:add', data),
    del: (id) => ipcRenderer.invoke('papers:delete', id),
    readImage: (rel) => ipcRenderer.invoke('papers:read-image', rel),
    saveAnalysis: (id, content) => ipcRenderer.invoke('papers:save-analysis', id, content),
    readAnalysis: (id) => ipcRenderer.invoke('papers:read-analysis', id),
    linkError: (id, err) => ipcRenderer.invoke('papers:link-error', id, err),
    unlinkError: (id, number) => ipcRenderer.invoke('papers:unlink-error', id, number),
    findByError: (number) => ipcRenderer.invoke('papers:find-by-error', number)
  },
  todos: {
    list: () => ipcRenderer.invoke('todos:list'),
    add: (data) => ipcRenderer.invoke('todos:add', data),
    toggle: (id) => ipcRenderer.invoke('todos:toggle', id),
    update: (id, data) => ipcRenderer.invoke('todos:update', id, data),
    del: (id) => ipcRenderer.invoke('todos:delete', id)
  },
  errorBank: {
    scan: () => ipcRenderer.invoke('errorbank:scan'),
    list: () => ipcRenderer.invoke('errorbank:list'),
    add: (data) => ipcRenderer.invoke('errorbank:add', data),
    get: (number) => ipcRenderer.invoke('errorbank:get', number),
    update: (number, data) => ipcRenderer.invoke('errorbank:update', number, data),
    del: (number) => ipcRenderer.invoke('errorbank:delete', number),
    search: (q) => ipcRenderer.invoke('errorbank:search', q),
    groups: () => ipcRenderer.invoke('errorbank:groups'),
    addGroup: (name) => ipcRenderer.invoke('errorbank:add-group', name),
    deleteGroup: (id, opts) => ipcRenderer.invoke('errorbank:delete-group', id, opts),
    moveGroup: (numbers, groupName) => ipcRenderer.invoke('errorbank:move-group', numbers, groupName),
    setFamiliarity: (numbers, familiarity) => ipcRenderer.invoke('errorbank:set-familiarity', numbers, familiarity),
    linkPaper: (number, paper) => ipcRenderer.invoke('errorbank:link-paper', number, paper),
    unlinkPaper: (number, paperId) => ipcRenderer.invoke('errorbank:unlink-paper', number, paperId),
    listAttachments: (number) => ipcRenderer.invoke('errorbank:list-attachments', number),
    addAttachment: (number, data) => ipcRenderer.invoke('errorbank:add-attachment', number, data),
    readAttachment: (number, name) => ipcRenderer.invoke('errorbank:read-attachment', number, name),
    deleteAttachment: (number, name) => ipcRenderer.invoke('errorbank:delete-attachment', number, name)
  },
  vocab: {
    wordsList: () => ipcRenderer.invoke('vocab:words-list'),
    wordsAdd: (data) => ipcRenderer.invoke('vocab:words-add', data),
    wordsUpdate: (id, data) => ipcRenderer.invoke('vocab:words-update', id, data),
    wordsDelete: (id) => ipcRenderer.invoke('vocab:words-delete', id),
    wenyanList: () => ipcRenderer.invoke('vocab:wenyan-list'),
    wenyanAdd: (data) => ipcRenderer.invoke('vocab:wenyan-add', data),
    wenyanUpdate: (id, data) => ipcRenderer.invoke('vocab:wenyan-update', id, data),
    wenyanDelete: (id) => ipcRenderer.invoke('vocab:wenyan-delete', id),
    wordsExport: (opts) => ipcRenderer.invoke('vocab:words-export', opts),
    wenyanExport: (opts) => ipcRenderer.invoke('vocab:wenyan-export', opts),
    reviewOverview: () => ipcRenderer.invoke('vocab:review-overview'),
    reviewDue: () => ipcRenderer.invoke('vocab:review-due'),
    reviewSubmit: (id, correct) => ipcRenderer.invoke('vocab:review-submit', id, correct),
    reviewReset: (id) => ipcRenderer.invoke('vocab:review-reset', id),
    reviewExport: (opts) => ipcRenderer.invoke('vocab:review-export', opts)
  },
  sync: {
    login: (cfg) => ipcRenderer.invoke('sync:login', cfg),
    all: (cfg) => ipcRenderer.invoke('sync:all', cfg),
    collection: (collection, cfg) => ipcRenderer.invoke('sync:collection', collection, cfg),
    download: (cfg) => ipcRenderer.invoke('sync:download', cfg),
    diff: (cfg) => ipcRenderer.invoke('sync:diff', cfg),
    test: (cfg) => ipcRenderer.invoke('sync:test', cfg)
  },
  data: {
    export: (opts) => ipcRenderer.invoke('data:export', opts),
    inspect: () => ipcRenderer.invoke('data:inspect'),
    import: (opts) => ipcRenderer.invoke('data:import', opts)
  },
  gitConfig: {
    get: () => ipcRenderer.invoke('git:config-get'),
    set: (c) => ipcRenderer.invoke('git:config-set', c),
    setRemote: (url) => ipcRenderer.invoke('git:remote-set', url),
    test: () => ipcRenderer.invoke('git:test-auth'),
    clearCreds: () => ipcRenderer.invoke('git:clear-creds'),
    initRepo: () => ipcRenderer.invoke('git:init-repo')
  },
  env: {
    check: () => ipcRenderer.invoke('env:check'),
    install: (opts) => ipcRenderer.invoke('env:install', opts)
  },
  users: {
    list: () => ipcRenderer.invoke('users:list'),
    create: (opts) => ipcRenderer.invoke('users:create', opts),
    mkdir: (opts) => ipcRenderer.invoke('users:mkdir', opts),
    switchTo: (id) => ipcRenderer.invoke('users:switch', id),
    remove: (id) => ipcRenderer.invoke('users:remove', id),
    ensureCurrent: () => ipcRenderer.invoke('users:ensure-current')
  },
  preview: {
    getUrl: () => ipcRenderer.invoke('preview:url')
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    apply: (url) => ipcRenderer.invoke('update:apply', url),
    onProgress: (cb) => ipcRenderer.on('update:progress', (e, ev) => cb(ev))
  },
  cache: {
    clean: () => ipcRenderer.invoke('cache:clean')
  },
  app: {
    onConfig: (cb) => ipcRenderer.on('app:config', (e, c) => cb(c)),
    onAgentEvent: (cb) => ipcRenderer.on('agent:event', (e, ev) => cb(ev)),
    onConfirmRequest: (cb) => ipcRenderer.on('confirm-request', (e, req) => cb(req)),
    onAskRequest: (cb) => ipcRenderer.on('ask-request', (e, req) => cb(req)),
    onPreviewUrl: (cb) => ipcRenderer.on('preview:url', (e, u) => cb(u)),
    confirmResponse: (id, approved, editedContent) => ipcRenderer.invoke('confirm-response', { id, approved, editedContent }),
    askResponse: (id, answer) => ipcRenderer.invoke('ask-response', { id, answer }),
    setTitleBarOverlay: (o) => ipcRenderer.invoke('window:set-overlay', o),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    getTokenUsage: () => ipcRenderer.invoke('token:usage'),
    openExternal: (url) => ipcRenderer.invoke('app:open-external', url)
  }
});
