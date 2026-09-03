// ===== 管理面板 API =====
// 提供服务器状态、用户管理、数据统计、配置管理等管理接口
// 所有接口需管理员认证（除登录、初始化、config 检查外）
const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { adminLogin, adminAuth, hasAdmin, initAdmin, changeAdminPassword, changeAdminUsername } = require('../middleware/admin-auth');
const { rateLimit } = require('../middleware/rate-limit');
const { audit, isValidUsername, isValidPassword } = require('../utils/security');
const config = require('../config');
const { testConnection, reconnect, getCurrentUrl } = require('../db/pool');
const { signToken } = require('../middleware/auth');

const router = express.Router();

// 各集合的中文名与说明
const COLLECTIONS = {
  words: { label: '生词本', desc: '英语单词' },
  wenyan: { label: '文言文', desc: '文言文生义' },
  todos: { label: '待办', desc: '任务待办' },
  focus_records: { label: '专注记录', desc: '专注时长记录' },
  errors: { label: '错题', desc: '错题索引' },
  error_groups: { label: '错题组', desc: '错题分组' }
};

// 管理员登录（限流）
router.post('/login', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const { username, password } = req.body || {};
  const r = await adminLogin(String(username || ''), String(password || ''));
  if (!r.ok) {
    audit('admin_login_fail', '管理员登录失败', req);
    return res.status(401).json(r);
  }
  audit('admin_login', '管理员登录成功', req);
  return res.json(r);
});

// 是否已配置管理员（首次安装引导用）
router.get('/config', async (req, res) => {
  const has = await hasAdmin();
  res.json({ ok: true, hasAdmin: has });
});

// 初始化管理员（首次安装引导，仅当数据库无管理员时可用）
router.post('/init', rateLimit({ windowMs: 60000, max: 5 }), async (req, res) => {
  const { username, password, port } = req.body || {};
  const r = await initAdmin(String(username || ''), String(password || ''));
  if (!r.ok) return res.status(400).json(r);
  // 若同时提供了端口，则一并保存（安装向导配置端口）
  if (port !== undefined && port !== null && port !== '') {
    const p = parseInt(port, 10);
    if (isNaN(p) || p < 1 || p > 65535) {
      return res.status(400).json({ ok: false, message: '端口需为 1-65535 的数字' });
    }
    await config.setConfig('PORT', String(p));
  }
  audit('admin_init', '初始化管理员: ' + username, req);
  return res.json({ ok: true, message: '管理员初始化成功' });
});

// 以下接口需管理员认证
router.use(adminAuth);

// ===== 服务器状态总览 =====
router.get('/status', async (req, res) => {
  try {
    const dbOk = await pool.query('SELECT 1');
    const { rows: userCount } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const { rows: deviceCount } = await pool.query('SELECT COUNT(*)::int AS c FROM devices');
    const { rows: adminCount } = await pool.query('SELECT COUNT(*)::int AS c FROM admin_users');
    const counts = {};
    const activeCounts = {};
    for (const t of ['words', 'wenyan', 'todos', 'focus_records', 'errors', 'error_groups']) {
      try {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`);
        counts[t] = rows[0].c;
        const { rows: active } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE deleted = false`);
        activeCounts[t] = active[0].c;
      } catch (e) { counts[t] = 0; activeCounts[t] = 0; }
    }
    // 最近同步时间
    let lastSync = null;
    try {
      const { rows } = await pool.query('SELECT MAX(updated_at) AS t FROM sync_cursors');
      lastSync = rows[0].t;
    } catch (e) { /* 忽略 */ }
    return res.json({
      ok: true,
      status: 'running',
      db: dbOk ? 'connected' : 'error',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      users: userCount[0].c,
      devices: deviceCount[0].c,
      admins: adminCount[0].c,
      lastSync,
      counts,
      activeCounts,
      dbUrl: getCurrentUrl(),
      port: parseInt(config.get('PORT'), 10) || 3000
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ===== 配置管理 =====
// 获取所有配置
router.get('/config/all', async (req, res) => {
  try {
    const cfg = await config.getAllConfig();
    return res.json({
      ok: true,
      config: {
        PORT: cfg.PORT,
        JWT_SECRET: cfg.JWT_SECRET ? '已设置（' + cfg.JWT_SECRET.length + ' 位）' : '未设置',
        JWT_SECRET_RAW: cfg.JWT_SECRET,
        CORS_ORIGIN: cfg.CORS_ORIGIN,
        DATABASE_URL: getCurrentUrl()
      }
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 修改配置（端口、JWT密钥、CORS）
router.post('/config', async (req, res) => {
  const { PORT, JWT_SECRET, CORS_ORIGIN } = req.body || {};
  const results = [];
  if (PORT !== undefined) {
    const p = parseInt(PORT, 10);
    if (isNaN(p) || p < 1 || p > 65535) return res.status(400).json({ ok: false, message: '端口需为 1-65535 的数字' });
    results.push(await config.setConfig('PORT', String(p)));
  }
  if (JWT_SECRET !== undefined) {
    if (JWT_SECRET && JWT_SECRET.length < 32) return res.status(400).json({ ok: false, message: 'JWT 密钥至少 32 位' });
    results.push(await config.setConfig('JWT_SECRET', JWT_SECRET));
  }
  if (CORS_ORIGIN !== undefined) {
    results.push(await config.setConfig('CORS_ORIGIN', CORS_ORIGIN));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) return res.status(500).json({ ok: false, message: failed[0].message });
  audit('admin_update_config', '修改服务器配置', req);
  return res.json({ ok: true, message: '配置已保存' });
});

// 测试数据库连接
router.post('/db/test', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, message: '请填写数据库连接串' });
  const r = await testConnection(String(url));
  return res.json(r);
});

// 修改数据库连接并重连
router.post('/db/reconnect', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, message: '请填写数据库连接串' });
  const r = await reconnect(String(url));
  if (r.ok) {
    audit('admin_db_reconnect', '修改数据库连接', req);
    return res.json({ ok: true, message: '数据库连接已更新' });
  }
  return res.status(400).json(r);
});

// ===== 管理员账户管理 =====
// 修改管理员密码
router.post('/admin/password', async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const r = await changeAdminPassword(req.admin.aid, String(oldPassword || ''), String(newPassword || ''));
  if (!r.ok) return res.status(400).json(r);
  audit('admin_change_password', '修改管理员密码', req);
  return res.json({ ok: true, message: '密码已修改' });
});

// 修改管理员用户名
router.post('/admin/username', async (req, res) => {
  const { newUsername } = req.body || {};
  const r = await changeAdminUsername(req.admin.aid, String(newUsername || ''));
  if (!r.ok) return res.status(400).json(r);
  audit('admin_change_username', '修改管理员用户名: ' + newUsername, req);
  return res.json({ ok: true, message: '用户名已修改', username: r.username });
});

// ===== 用户管理 =====
// 用户列表
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.nickname, u.created_at,
              (SELECT COUNT(*)::int FROM devices d WHERE d.user_id = u.id) AS devices,
              (SELECT MAX(d.last_seen) FROM devices d WHERE d.user_id = u.id) AS last_seen,
              (SELECT MAX(s.updated_at) FROM sync_cursors s WHERE s.user_id = u.id) AS last_sync
       FROM users u ORDER BY u.created_at DESC`
    );
    return res.json({ ok: true, users: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 注册用户（管理员创建）
router.post('/users', async (req, res) => {
  const { username, password, nickname } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  if (!isValidUsername(uname)) return res.status(400).json({ ok: false, message: '用户名需为 3-20 位字母、数字或下划线' });
  if (!isValidPassword(pwd)) return res.status(400).json({ ok: false, message: '密码至少 8 位，且需包含字母和数字' });
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (rows.length) return res.status(409).json({ ok: false, message: '用户名已存在' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const hash = await bcrypt.hash(pwd, 12);
    await pool.query(
      'INSERT INTO users (id, username, password, nickname) VALUES ($1, $2, $3, $4)',
      [id, uname, hash, String(nickname || '').slice(0, 50)]
    );
    audit('admin_create_user', '管理员创建用户: ' + uname, req);
    return res.json({ ok: true, message: '用户创建成功', user: { id, username: uname, nickname: String(nickname || '').slice(0, 50) } });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 删除用户（级联删除其所有数据）
router.delete('/users/:id', async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ ok: false, message: '用户不存在' });
    audit('admin_delete_user', '删除用户: ' + req.params.id, req);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 某用户的数据统计
router.get('/users/:id/stats', async (req, res) => {
  try {
    const uid = req.params.id;
    const counts = {};
    for (const t of ['words', 'wenyan', 'todos', 'focus_records', 'errors', 'error_groups']) {
      try {
        const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM ${t} WHERE user_id = $1`, [uid]);
        counts[t] = rows[0].c;
      } catch (e) { counts[t] = 0; }
    }
    return res.json({ ok: true, counts });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ===== 设备列表 =====
router.get('/devices', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.name, d.platform, d.last_seen, d.created_at, u.username
       FROM devices d LEFT JOIN users u ON d.user_id = u.id
       ORDER BY d.last_seen DESC`
    );
    return res.json({ ok: true, devices: rows });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// ===== 审计日志 =====
router.get('/logs', async (req, res) => {
  try {
    const logFile = path.join(__dirname, '..', '..', 'logs', 'audit.log');
    if (!fs.existsSync(logFile)) return res.json({ ok: true, logs: [] });
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim()).slice(-100).reverse();
    return res.json({ ok: true, logs: lines });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
