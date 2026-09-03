// ===== 认证中间件（JWT） =====
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const config = require('../config');
const { isSecretSafe } = require('../utils/security');

// 从配置模块读取 JWT 密钥（可在管理面板中修改）
function getSecret() {
  return config.get('JWT_SECRET') || process.env.JWT_SECRET || '';
}

// 启动时校验 JWT_SECRET 是否安全
const SECRET = getSecret();
if (!isSecretSafe(SECRET)) {
  console.error('❌ 安全错误：JWT_SECRET 未配置或不安全（需 ≥32 位随机字符串）。');
  console.error('   请在 server/.env 中设置 JWT_SECRET，或启动后在管理面板中配置。');
  console.error('   JWT_SECRET=' + require('crypto').randomBytes(32).toString('hex'));
  process.exit(1);
}

// 签发 token
function signToken(user) {
  return jwt.sign({ uid: user.id, username: user.username }, getSecret(), { expiresIn: '30d' });
}

// 认证中间件：校验 Authorization: Bearer <token>
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, message: '未登录' });
  try {
    const payload = jwt.verify(token, getSecret());
    const { rows } = await pool.query('SELECT id, username, nickname FROM users WHERE id = $1', [payload.uid]);
    if (!rows.length) return res.status(401).json({ ok: false, message: '用户不存在' });
    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: '登录已过期，请重新登录' });
  }
}

module.exports = { auth, signToken, SECRET, getSecret };
