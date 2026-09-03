// ===== WebSocket 实时推送 =====
// 手机端连接后订阅某个用户的数据变更，服务端在数据变化时推送通知
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const { getSecret } = require('../middleware/auth');

// 维护 userId -> Set<ws>
const clients = new Map();

function initWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws, req) => {
    // 从 query 中取 token：ws://host/ws?token=xxx
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    let uid = null;
    try {
      const payload = jwt.verify(token, getSecret());
      uid = payload.uid;
    } catch (e) {
      ws.close(4001, 'unauthorized');
      return;
    }
    if (!clients.has(uid)) clients.set(uid, new Set());
    clients.get(uid).add(ws);
    ws.on('close', () => {
      const set = clients.get(uid);
      if (set) { set.delete(ws); if (!set.size) clients.delete(uid); }
    });
  });
  return wss;
}

// 向某用户的所有在线设备推送变更通知
function notifyUser(userId, payload) {
  const set = clients.get(userId);
  if (!set) return;
  const msg = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

module.exports = { initWs, notifyUser };
