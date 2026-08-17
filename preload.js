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
