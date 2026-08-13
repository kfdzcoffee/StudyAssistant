const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf'
};

// 本地静态服务器：serve docsify 知识库目录，供预览 webview 加载
function createPreviewServer({ getRoot }) {
  const server = http.createServer((req, res) => {
    const root = path.normalize(getRoot() || process.cwd());
    let pathname;
    try { pathname = decodeURIComponent(url.parse(req.url).pathname); }
    catch (e) { pathname = '/'; }
    if (pathname === '/') pathname = '/index.html';

    const fp = path.normalize(path.join(root, pathname));
    const rl = root.toLowerCase();
    if (fp.toLowerCase().indexOf(rl) !== 0) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }
    fs.readFile(fp, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found: ' + pathname);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });

  return {
    server,
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    },
    getUrl() {
      const addr = server.address();
      return `http://127.0.0.1:${addr.port}/`;
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { createPreviewServer };
