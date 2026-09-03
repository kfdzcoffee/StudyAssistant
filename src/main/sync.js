// ===== 桌面端云端同步模块 =====
// 负责：从本地数据生成带版本号的记录 → 推送/拉取 → 合并冲突
// 数据源：
//   - 生词本/文言文：workspace 生词本/words.json、wenyan.json
//   - 待办：userData study-assistant/todos.json
//   - 专注记录：userData focus-records.json
//   - 错题库：workspace 错题库/index.json、groups.json
// 本地记录统一带 updatedAt + version 字段（由各业务模块写入时维护）

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// ===== 本地数据读取 =====
// 各集合的本地读取函数（由 main.js 注入，避免循环依赖）
const readers = {};
const writers = {};

function registerReader(collection, fn) { readers[collection] = fn; }
function registerWriter(collection, fn) { writers[collection] = fn; }

// 读取本地记录数组
function readLocal(collection) {
  if (readers[collection]) return readers[collection]() || [];
  return [];
}
// 写入本地记录数组
function writeLocal(collection, arr) {
  if (writers[collection]) writers[collection](arr);
}

// ===== 同步状态文件（记录上次同步游标） =====
function syncStateFile() {
  return path.join(app.getPath('userData'), 'sync-state.json');
}
function readState() {
  try {
    const j = JSON.parse(fs.readFileSync(syncStateFile(), 'utf8') || '{}');
    return j && typeof j === 'object' ? j : {};
  } catch (e) { return {}; }
}
function writeState(state) {
  try { fs.writeFileSync(syncStateFile(), JSON.stringify(state, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
}

// ===== HTTP 请求封装 =====
function httpRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const zlib = require('zlib');
    // 注意：必须用 options 对象方式设置 method，直接改 req.method 不生效
    const req = net.request({
      method: opts.method || 'GET',
      url
    });
    req.setHeader('Content-Type', 'application/json');
    if (opts.token) req.setHeader('Authorization', 'Bearer ' + opts.token);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = { ok: false, message: text }; }
        resolve(json);
      });
    });
    req.on('error', reject);
    if (opts.body) {
      // 上传时用 gzip 压缩请求体，减小传输体积（服务器端自动解压）
      try {
        const buf = zlib.gzipSync(Buffer.from(JSON.stringify(opts.body), 'utf8'));
        req.setHeader('Content-Encoding', 'gzip');
        req.setHeader('Content-Length', buf.length);
        req.write(buf);
      } catch (e) {
        req.write(JSON.stringify(opts.body));
      }
    }
    req.end();
  });
}

// ===== 记录版本工具 =====
// 各集合的业务主键字段（与服务器端一致；errors 用 number）
const KEY_FIELDS = {
  words: 'id',
  wenyan: 'id',
  todos: 'id',
  focus_records: 'id',
  errors: 'number',
  error_groups: 'id',
  notes: 'path',
  settings: 'key'
};

// 确保记录带 updatedAt + version
function ensureVersion(rec) {
  if (!rec.updatedAt) rec.updatedAt = new Date().toISOString();
  if (!rec.version) rec.version = 1;
  return rec;
}
// 标记记录已修改（version+1, updatedAt=now）
function touch(rec) {
  rec.version = (rec.version || 1) + 1;
  rec.updatedAt = new Date().toISOString();
  return rec;
}

// ===== 认证 =====
async function login(cfg) {
  const url = (cfg.serverUrl || '').replace(/\/+$/, '');
  if (!url) return { ok: false, message: '未配置服务器地址' };
  try {
    const r = await httpRequest(url + '/api/auth/login', {
      method: 'POST',
      body: { username: cfg.username, password: cfg.password }
    });
    if (r && r.ok) {
      return { ok: true, token: r.token, user: r.user };
    }
    return { ok: false, message: (r && r.message) || '登录失败' };
  } catch (e) {
    return { ok: false, message: '无法连接服务器: ' + e.message };
  }
}

// ===== 推送一个集合 =====
async function pushCollection(cfg, collection, records) {
  const url = (cfg.serverUrl || '').replace(/\/+$/, '');
  try {
    const r = await httpRequest(url + '/api/sync/' + collection, {
      method: 'POST',
      token: cfg.token,
      body: { records }
    });
    return r || { ok: false, message: '推送失败' };
  } catch (e) {
    return { ok: false, message: '无法连接服务器: ' + e.message };
  }
}

// ===== 拉取一个集合 =====
async function pullCollection(cfg, collection, since) {
  const url = (cfg.serverUrl || '').replace(/\/+$/, '');
  const q = since ? '?since=' + encodeURIComponent(since) : '';
  try {
    const r = await httpRequest(url + '/api/sync/' + collection + q, {
      method: 'GET',
      token: cfg.token
    });
    return r || { ok: false, message: '拉取失败' };
  } catch (e) {
    return { ok: false, message: '无法连接服务器: ' + e.message };
  }
}

// ===== 全量拉取 =====
async function pullAllCollection(cfg, collection) {
  const url = (cfg.serverUrl || '').replace(/\/+$/, '');
  try {
    const r = await httpRequest(url + '/api/sync/' + collection + '/all', {
      method: 'GET',
      token: cfg.token
    });
    return r || { ok: false, message: '拉取失败' };
  } catch (e) {
    return { ok: false, message: '无法连接服务器: ' + e.message };
  }
}

// ===== 合并：将云端记录合并回本地 =====
// 规则：比较 updatedAt，后修改的赢；deleted=true 则从本地移除
function mergeIntoLocal(collection, cloudRecords) {
  const local = readLocal(collection);
  const keyField = KEY_FIELDS[collection] || 'id';
  const localMap = new Map(local.map((r) => [String(r[keyField]), r]));
  let changed = false;

  for (const cr of cloudRecords) {
    const key = String(cr[keyField] != null ? cr[keyField] : cr.id);
    const lr = localMap.get(key);
    if (cr.deleted) {
      // 云端已删除 → 本地也删除
      if (lr) { localMap.delete(key); changed = true; }
      continue;
    }
    const cloudTime = new Date(cr.updatedAt || 0).getTime();
    const localTime = lr ? new Date(lr.updatedAt || 0).getTime() : 0;
    if (!lr || cloudTime > localTime) {
      // 云端更新 → 覆盖本地（保留本地主键字段）
      const merged = Object.assign({}, cr);
      if (keyField !== 'id') merged[keyField] = key;
      localMap.set(key, merged);
      changed = true;
    }
  }

  if (changed) {
    writeLocal(collection, Array.from(localMap.values()));
  }
  return changed;
}

// ===== 集合中文名（用于提示） =====
const COLLECTION_LABELS = {
  words: '生词本',
  wenyan: '文言文',
  todos: '待办',
  focus_records: '专注记录',
  errors: '错题',
  error_groups: '错题组',
  notes: '知识库',
  settings: '设置'
};

// ===== 全量同步一个集合 =====
// 策略：先推送本地所有记录，再全量拉取云端合并
async function syncCollection(cfg, collection) {
  const local = readLocal(collection).map(ensureVersion);
  // 1. 推送本地全部
  const pushRes = await pushCollection(cfg, collection, local);
  if (!pushRes || !pushRes.ok) return { ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: (pushRes && pushRes.message) || '推送失败' };
  // 2. 全量拉取云端（含冲突解决后的最新状态）
  const pullRes = await pullAllCollection(cfg, collection);
  if (!pullRes || !pullRes.ok) return { ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: (pullRes && pullRes.message) || '拉取失败' };
  // 3. 合并回本地
  const changed = mergeIntoLocal(collection, pullRes.records || []);
  return {
    ok: true,
    collection,
    label: COLLECTION_LABELS[collection] || collection,
    pushed: pushRes.pushed || 0,
    records: (pullRes.records || []).length,
    changed
  };
}

// ===== 全量同步所有启用的集合 =====
async function syncAll(cfg) {
  const collections = cfg.collections || {};
  const results = [];
  let ok = true;
  for (const [collection, enabled] of Object.entries(collections)) {
    if (!enabled) continue;
    try {
      const r = await syncCollection(cfg, collection);
      results.push(r);
      if (!r.ok) ok = false;
    } catch (e) {
      results.push({ ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: e.message });
      ok = false;
    }
  }
  // 汇总 message：失败时给出具体原因，避免前端显示 undefined
  let message = '';
  if (!ok) {
    const failed = results.filter((r) => !r.ok);
    message = failed.map((r) => (r.label || r.collection) + '：' + (r.message || '同步失败')).join('；');
  }
  return { ok, results, message };
}

// ===== 下载：从云端全量拉取并覆盖本地（不推送本地） =====
// 用于"从云端下载数据"，以云端为权威
async function downloadCollection(cfg, collection) {
  const pullRes = await pullAllCollection(cfg, collection);
  if (!pullRes || !pullRes.ok) return { ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: (pullRes && pullRes.message) || '拉取失败' };
  const cloud = pullRes.records || [];
  // 直接以云端为准覆盖本地（保留主键字段）
  const keyField = KEY_FIELDS[collection] || 'id';
  const merged = cloud.map((cr) => {
    const m = Object.assign({}, cr);
    if (keyField !== 'id' && cr[keyField] != null) m[keyField] = cr[keyField];
    return m;
  });
  writeLocal(collection, merged);
  return { ok: true, collection, label: COLLECTION_LABELS[collection] || collection, records: merged.length };
}

// 下载所有启用的集合
async function downloadAll(cfg) {
  const collections = cfg.collections || {};
  const results = [];
  let ok = true;
  for (const [collection, enabled] of Object.entries(collections)) {
    if (!enabled) continue;
    try {
      const r = await downloadCollection(cfg, collection);
      results.push(r);
      if (!r.ok) ok = false;
    } catch (e) {
      results.push({ ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: e.message });
      ok = false;
    }
  }
  let message = '';
  if (!ok) {
    const failed = results.filter((r) => !r.ok);
    message = failed.map((r) => (r.label || r.collection) + '：' + (r.message || '下载失败')).join('；');
  }
  return { ok, results, message };
}

// ===== 检测本地与云端的差异（哪个更新） =====
// 返回每个集合：本地数、云端数、本地较新数、云端较新数、冲突数
async function checkDiff(cfg) {
  const collections = cfg.collections || {};
  const results = [];
  let ok = true;
  for (const [collection, enabled] of Object.entries(collections)) {
    if (!enabled) continue;
    try {
      const pullRes = await pullAllCollection(cfg, collection);
      if (!pullRes || !pullRes.ok) {
        results.push({ ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: (pullRes && pullRes.message) || '拉取失败' });
        ok = false;
        continue;
      }
      const cloud = pullRes.records || [];
      const local = readLocal(collection);
      const keyField = KEY_FIELDS[collection] || 'id';
      const localMap = new Map(local.map((r) => [String(r[keyField] != null ? r[keyField] : r.id), r]));
      const cloudMap = new Map(cloud.map((r) => [String(r[keyField] != null ? r[keyField] : r.id), r]));
      let localNewer = 0, cloudNewer = 0, conflict = 0, onlyLocal = 0, onlyCloud = 0;
      const allKeys = new Set([...localMap.keys(), ...cloudMap.keys()]);
      for (const key of allKeys) {
        const lr = localMap.get(key);
        const cr = cloudMap.get(key);
        if (!lr) { onlyCloud++; continue; }
        if (!cr) { onlyLocal++; continue; }
        const lt = new Date(lr.updatedAt || 0).getTime();
        const ct = new Date(cr.updatedAt || 0).getTime();
        if (lt > ct) localNewer++;
        else if (ct > lt) cloudNewer++;
        else conflict++;
      }
      results.push({
        ok: true,
        collection,
        label: COLLECTION_LABELS[collection] || collection,
        localCount: local.length,
        cloudCount: cloud.length,
        localNewer, cloudNewer, conflict, onlyLocal, onlyCloud
      });
    } catch (e) {
      results.push({ ok: false, collection, label: COLLECTION_LABELS[collection] || collection, message: e.message });
      ok = false;
    }
  }
  return { ok, results };
}

module.exports = {
  registerReader, registerWriter,
  login, syncAll, syncCollection, downloadAll, downloadCollection, checkDiff,
  ensureVersion, touch, mergeIntoLocal,
  readLocal, writeLocal, readState, writeState
};
