// ===== 认证路由：注册 / 登录 =====
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { signToken } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rate-limit');
const { isValidUsername, isValidPassword, audit } = require('../utils/security');

const router = express.Router();

// 登录/注册限流：同一 IP 每分钟最多 10 次尝试
const authLimiter = rateLimit({ windowMs: 60000, max: 10 });

// 注册
router.post('/register', authLimiter, async (req, res) => {
  const { username, password, nickname } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  if (!isValidUsername(uname)) {
    return res.status(400).json({ ok: false, message: '用户名需为 3-20 位字母、数字或下划线' });
  }
  if (!isValidPassword(pwd)) {
    return res.status(400).json({ ok: false, message: '密码至少 8 位，且需包含字母和数字' });
  }
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (rows.length) return res.status(409).json({ ok: false, message: '用户名已存在' });
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const hash = await bcrypt.hash(pwd, 12); // 提高 bcrypt 成本因子
    await pool.query(
      'INSERT INTO users (id, username, password, nickname) VALUES ($1, $2, $3, $4)',
      [id, uname, hash, String(nickname || '').slice(0, 50)]
    );
    const user = { id, username: uname, nickname: String(nickname || '').slice(0, 50) };
    audit('register', '新用户注册: ' + uname, req);
    return res.json({ ok: true, token: signToken(user), user });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// 登录
router.post('/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').trim();
  const pwd = String(password || '');
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [uname]);
    if (!rows.length) {
      audit('login_fail', '登录失败（用户不存在）: ' + uname, req);
      return res.status(401).json({ ok: false, message: '用户名或密码错误' });
    }
    const ok = await bcrypt.compare(pwd, rows[0].password);
    if (!ok) {
      audit('login_fail', '登录失败（密码错误）: ' + uname, req);
      return res.status(401).json({ ok: false, message: '用户名或密码错误' });
    }
    const user = { id: rows[0].id, username: rows[0].username, nickname: rows[0].nickname };
    audit('login', '登录成功: ' + uname, req);
    return res.json({ ok: true, token: signToken(user), user });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
