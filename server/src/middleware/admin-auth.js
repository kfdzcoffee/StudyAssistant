// ===== 管理员认证 =====
// 管理员账号存储在数据库 admin_users 表中，可在管理面板中修改
// 首次启动时若数据库无管理员，进入"初始化设置"模式（面板显示引导页）
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { getSecret } = require('./auth');
const { audit } = require('../utils/security');

// 是否已配置管理员（数据库中有记录）
async function hasAdmin() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM admin_users');
    return rows[0].c > 0;
  } catch (e) {
    return false;
  }
}

// 初始化管理员（首次安装引导时调用）
async function initAdmin(username, password) {
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) {
    return { ok: false, message: '管理员用户名需为 3-20 位字母、数字或下划线' };
  }
  if (typeof pwd !== 'string' || pwd.length < 8 || !/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) {
    return { ok: false, message: '管理员密码至少 8 位，且需包含字母和数字' };
  }
  try {
    const existing = await hasAdmin();
    if (existing) return { ok: false, message: '管理员已存在，无法重复初始化' };
    const id = 'admin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const hash = await bcrypt.hash(pwd, 12);
    await pool.query(
      'INSERT INTO admin_users (id, username, password) VALUES ($1, $2, $3)',
      [id, uname, hash]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 管理员登录
async function adminLogin(username, password) {
  const uname = String(username || '').trim();
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE username = $1', [uname]);
    if (!rows.length) return { ok: false, message: '管理员账号或密码错误' };
    const ok = await bcrypt.compare(String(password || ''), rows[0].password);
    if (!ok) return { ok: false, message: '管理员账号或密码错误' };
    const token = jwt.sign({ role: 'admin', username: uname, aid: rows[0].id }, getSecret(), { expiresIn: '12h' });
    return { ok: true, token, username: uname };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 修改管理员密码
async function changeAdminPassword(aid, oldPassword, newPassword) {
  try {
    const { rows } = await pool.query('SELECT * FROM admin_users WHERE id = $1', [aid]);
    if (!rows.length) return { ok: false, message: '管理员不存在' };
    const ok = await bcrypt.compare(String(oldPassword || ''), rows[0].password);
    if (!ok) return { ok: false, message: '原密码错误' };
    if (typeof newPassword !== 'string' || newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      return { ok: false, message: '新密码至少 8 位，且需包含字母和数字' };
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE admin_users SET password = $1, updated_at = now() WHERE id = $2', [hash, aid]);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 修改管理员用户名
async function changeAdminUsername(aid, newUsername) {
  const uname = String(newUsername || '').trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(uname)) {
    return { ok: false, message: '用户名需为 3-20 位字母、数字或下划线' };
  }
  try {
    const { rows } = await pool.query('SELECT id FROM admin_users WHERE username = $1 AND id != $2', [uname, aid]);
    if (rows.length) return { ok: false, message: '该用户名已被占用' };
    await pool.query('UPDATE admin_users SET username = $1, updated_at = now() WHERE id = $2', [uname, aid]);
    return { ok: true, username: uname };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 管理员认证中间件
function adminAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, message: '未登录' });
  try {
    const payload = jwt.verify(token, getSecret());
    if (payload.role !== 'admin') return res.status(403).json({ ok: false, message: '无权限' });
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: '登录已过期' });
  }
}

module.exports = { adminLogin, adminAuth, hasAdmin, initAdmin, changeAdminPassword, changeAdminUsername };
