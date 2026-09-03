// ===== 学习助手云端同步服务入口 =====
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const syncRoutes = require('./routes/sync');
const adminRoutes = require('./routes/admin');
const { initWs } = require('./ws');
const config = require('./config');
const pool = require('./db/pool');

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));

// 请求体 gzip 解压：客户端上传时用 gzip 压缩以减小体积
// 手动读取原始字节流，再根据 content-encoding 解压并解析 JSON
// 注意：不使用 express.json()/express.raw()，避免与手动读取冲突
app.use((req, res, next) => {
  const enc = (req.headers['content-encoding'] || '').toLowerCase();
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks);
      if (enc === 'gzip') {
        req.body = JSON.parse(zlib.gunzipSync(raw).toString('utf8'));
      } else if (raw.length) {
        req.body = JSON.parse(raw.toString('utf8'));
      }
      next();
    } catch (e) {
      next(e);
    }
  });
  req.on('error', next);
});

// 请求日志（诊断用）
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} from ${req.ip}`);
  next();
});

// 健康检查
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'study-assistant-server', time: new Date().toISOString() }));

// 路由
app.use('/api/auth', authRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/admin', adminRoutes);

// 管理面板静态页面
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));

// 404
app.use((req, res) => res.status(404).json({ ok: false, message: '接口不存在: ' + req.path }));

// 错误处理
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ ok: false, message: err.message });
});

let server = null;
let wsServer = null;

// 启动 HTTP 服务（支持动态重启）
async function startServer(port) {
  if (server) {
    try { server.close(); } catch (e) { /* 忽略 */ }
  }
  const PORT = port || parseInt(config.get('PORT'), 10) || 3000;
  server = http.createServer(app);
  wsServer = initWs(server);
  return new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`✅ 学习助手同步服务已启动: http://localhost:${PORT}`);
      console.log(`   健康检查: http://localhost:${PORT}/api/health`);
      console.log(`   管理面板: http://localhost:${PORT}/admin`);
      resolve(PORT);
    });
  });
}

// 启动流程：加载配置 → 启动服务
(async () => {
  try {
    await config.loadConfig();
    await startServer();
  } catch (e) {
    console.error('❌ 启动失败:', e.message);
    process.exit(1);
  }
})();

module.exports = { app, startServer, getServer: () => server };
