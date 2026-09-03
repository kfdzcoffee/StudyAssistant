// ===== 服务器配置管理 =====
// 配置存储在数据库 server_config 表中，可在管理面板中可视化修改
// 数据库连接信息（DATABASE_URL）必须通过 .env 提供（bootstrap 配置）
// 其余配置（端口、JWT密钥、CORS、管理员等）存储在数据库，修改后自动生效
const pool = require('./db/pool');

// 默认配置（当数据库中没有记录时使用）
const DEFAULTS = {
  PORT: '3000',
  JWT_SECRET: '',
  CORS_ORIGIN: '*',
  // 数据库连接（bootstrap，来自 .env，但可在面板中修改后重连）
  DATABASE_URL: process.env.DATABASE_URL || ''
};

// 内存缓存
let cache = { ...DEFAULTS };

// 从数据库加载配置到缓存
async function loadConfig() {
  try {
    const { rows } = await pool.query('SELECT key, value FROM server_config');
    cache = { ...DEFAULTS };
    for (const r of rows) cache[r.key] = r.value;
    // 数据库连接始终以 .env 为准（避免循环依赖：配置表在数据库里）
    cache.DATABASE_URL = process.env.DATABASE_URL || cache.DATABASE_URL;
    return cache;
  } catch (e) {
    // 数据库不可用时用默认值
    cache = { ...DEFAULTS };
    return cache;
  }
}

// 获取配置（同步，返回缓存）
function getConfig() {
  return { ...cache };
}

// 获取单个配置
function get(key) {
  return cache[key] !== undefined ? cache[key] : DEFAULTS[key];
}

// 写入配置（异步，更新数据库 + 缓存）
async function setConfig(key, value) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, message: '配置键不能为空' };
  const v = String(value == null ? '' : value);
  try {
    await pool.query(
      `INSERT INTO server_config (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [k, v]
    );
    cache[k] = v;
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 批量写入配置
async function setConfigs(obj) {
  const results = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const r = await setConfig(k, v);
    results.push({ key: k, ok: r.ok, message: r.message });
  }
  const failed = results.filter((r) => !r.ok);
  return { ok: failed.length === 0, results };
}

// 获取所有配置（含默认值说明）
async function getAllConfig() {
  await loadConfig();
  return { ...cache };
}

module.exports = { loadConfig, getConfig, get, setConfig, setConfigs, getAllConfig, DEFAULTS };
