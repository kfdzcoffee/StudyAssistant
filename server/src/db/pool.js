// ===== PostgreSQL 连接池 =====
// 支持动态重连：管理面板修改数据库连接后，可调用 reconnect() 重新连接
const { Pool } = require('pg');
require('dotenv').config();

let pool = null;
let currentUrl = process.env.DATABASE_URL || '';

function createPool(url) {
  return new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}

// 初始化连接池
function initPool(url) {
  currentUrl = url || process.env.DATABASE_URL || '';
  pool = createPool(currentUrl);
  return pool;
}

// 获取当前连接池
function getPool() {
  if (!pool) pool = createPool(currentUrl);
  return pool;
}

// 测试数据库连接
async function testConnection(url) {
  const testPool = createPool(url);
  try {
    await testPool.query('SELECT 1');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  } finally {
    await testPool.end();
  }
}

// 重新连接（修改数据库配置后调用）
async function reconnect(url) {
  const newUrl = url || currentUrl;
  const test = await testConnection(newUrl);
  if (!test.ok) return { ok: false, message: test.message };
  if (pool) {
    try { await pool.end(); } catch (e) { /* 忽略 */ }
  }
  currentUrl = newUrl;
  pool = createPool(newUrl);
  return { ok: true };
}

// 获取当前连接 URL（脱敏）
function getCurrentUrl() {
  try {
    const u = new URL(currentUrl);
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
  } catch (e) {
    return currentUrl;
  }
}

module.exports = getPool();
module.exports.initPool = initPool;
module.exports.getPool = getPool;
module.exports.testConnection = testConnection;
module.exports.reconnect = reconnect;
module.exports.getCurrentUrl = getCurrentUrl;

