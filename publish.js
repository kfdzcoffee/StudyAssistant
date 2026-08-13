// 重新发布：push master + tag + 创建 Release 上传安装包
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const DIR = 'd:/BaiduSyncdisk/学习/高考复习/错题助手桌面端';
const REPO = 'kfdzcoffee/StudyAssistant';
const TAG = 'v1.8.8';
const EXE = 'C:/Users/wangz/AppData/Local/Temp/study-dist/学习助手-安装-1.8.8.exe';
const ASSET = '学习助手-安装-1.8.8.exe';

const g = (a) => execSync('git ' + a.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(' '), { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: DIR });
  const out = r.stdout || '';
  const get = (k) => { const m = out.split('\n').find((l) => l.startsWith(k + '=')); return m ? m.slice(k.length + 1) : ''; };
  return get('password');
}

function api(method, url, body, isBinary, timeoutMs) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) return reject(new Error('git credential 无 token'));
    const u = new URL(url);
    const req = https.request(u, {
      method, timeout: timeoutMs || 120000,
      headers: Object.assign({ 'User-Agent': 'StudyAssistant', 'Accept': 'application/vnd.github+json', 'Authorization': 'token ' + token },
        isBinary ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' })
    }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  try {
    g(['add', '-A']);
    try { g(['-c', 'user.name=Kfdzcoffee', '-c', 'user.email=me@kfdzcoffee.cn', 'commit', '-m', '许可证改为协议网址']); console.log('已提交 license 改动'); } catch (e) { console.log('commit: 无新改动'); }
    try { g(['remote', 'add', 'origin', 'https://github.com/' + REPO + '.git']); } catch (e) { /* 已存在 */ }
    g(['push', '-u', 'origin', 'master']);
    console.log('master 已推送');
    try { g(['tag', '-f', TAG]); g(['push', '-f', 'origin', TAG]); console.log('tag ' + TAG + ' 已推送'); } catch (e) { console.log('tag:', (e.stderr || '').trim().split('\n').pop()); }
    const del = await api('DELETE', 'https://api.github.com/repos/' + REPO + '/releases/tags/' + TAG, null, false, 60000);
    console.log('清理旧 release:', del.status);
    const r = await api('POST', 'https://api.github.com/repos/' + REPO + '/releases',
      JSON.stringify({ tag_name: TAG, name: TAG, body: '学习助手 Study Assistant v1.8.8\n- 新增「检查新版本」自动更新\n- 使用许可协议链接迁移\n- 项目官网 / 更新源上线', draft: false, prerelease: false }), false, 60000);
    let j; try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    if (!j.id) { console.log('创建 release 失败:', r.status, (j.message || r.body).slice(0, 200)); process.exit(1); }
    console.log('Release 已创建:', j.html_url || '');
    const up = (j.upload_url || '').replace('{?name,label}', '') + '?name=' + encodeURIComponent(ASSET);
    const buf = fs.readFileSync(EXE);
    const u = await api('POST', up, buf, true, 240000);
    let uj; try { uj = JSON.parse(u.body); } catch (e) { uj = {}; }
    console.log('安装包上传:', u.status, uj.name || (u.body || '').slice(0, 150));
    console.log('DONE');
  } catch (e) { console.log('ERR', e.message); process.exit(1); }
})();
