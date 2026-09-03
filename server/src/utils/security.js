// ===== 安全工具模块 =====
// 提供：输入校验、审计日志、安全配置校验

// 校验用户名（仅允许字母数字下划线，3-20 位）
function isValidUsername(u) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(String(u || ''));
}

// 校验密码强度（至少 8 位，含字母和数字）
function isValidPassword(p) {
  return typeof p === 'string' && p.length >= 8 && /[a-zA-Z]/.test(p) && /\d/.test(p);
}

// 校验服务器地址格式（http/https）
function isValidServerUrl(u) {
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(String(u || ''));
}

// 校验记录 id 格式（防止注入）
function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(id);
}

// 审计日志（写入 server/logs/audit.log）
const fs = require('fs');
const path = require('path');

function audit(action, detail, req) {
  try {
    const dir = path.join(__dirname, '..', '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${action} | user=${(req && req.user && req.user.username) || 'anonymous'} | ip=${(req && req.ip) || '-'} | ${detail || ''}\n`;
    fs.appendFileSync(path.join(dir, 'audit.log'), line);
  } catch (e) { /* 日志失败不阻塞 */ }
}

// 校验 JWT_SECRET 是否安全（非默认值且足够长）
function isSecretSafe(secret) {
  return typeof secret === 'string' && secret.length >= 32 && secret !== 'dev-secret' && secret !== 'change-me-to-a-long-random-string';
}

module.exports = { isValidUsername, isValidPassword, isValidServerUrl, isValidId, audit, isSecretSafe };
