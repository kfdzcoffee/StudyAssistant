// 完整发布流程：本地初始化 + 清空远程分支 + 干净推送 master + 创建 Release 上传安装包
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync, spawnSync } = require('child_process');

const DIR = 'd:/BaiduSyncdisk/学习/高考复习/错题助手桌面端';
const REPO = 'kfdzcoffee/StudyAssistant';
const TAG = 'v1.8.8';
const EXE = 'C:/Users/wangz/AppData/Local/Temp/study-dist/学习助手-安装-1.8.8.exe';
const ASSET_NAME = '学习助手-安装-1.8.8.exe';

function git(args) {
  return execSync('git ' + args.map((a) => '"' + String(a).replace(/"/g, '\\"') + '"').join(' '), { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', cwd: DIR });
  const out = r.stdout || '';
  const get = (k) => { const m = out.split('\n').find((l) => l.startsWith(k + '=')); return m ? m.slice(k.length + 1) : ''; };
  return get('password');
}

function api(method, url, body, isBinary) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) return reject(new Error('无法从 git 凭据管理器获取 GitHub 凭据'));
    const u = new URL(url);
    const req = https.request(u, {
      method,
      headers: Object.assign({
        'User-Agent': 'StudyAssistant',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'token ' + token
      }, isBinary ? { 'Content-Type': 'application/octet-stream' } : { 'Content-Type': 'application/json' })
    }, (res) => {
      let d = '';
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  try {
    // 1. 本地初始化（若已存在则复用）
    if (!fs.existsSync(path.join(DIR, '.git'))) git(['init', '-b', 'master']);
    git(['add', '-A']);
    try { git(['-c', 'user.name=Kfdzcoffee', '-c', 'user.email=me@kfdzcoffee.cn', 'commit', '-m', '学习助手 Study Assistant 桌面端 v1.8.8']); } catch (e) { /* 无改动 */ }
    try { git(['remote', 'add', 'origin', 'https://github.com/' + REPO + '.git']); } catch (e) { /* 已存在 */ }

    // 2. 清空远程：删除 web 分支 与 旧 tag
    try { git(['push', 'origin', '--delete', 'web']); console.log('已删除远程分支 web'); } catch (e) { console.log('删除 web 分支:', (e.stderr || e.message || '').trim().split('\n').pop()); }
    try { git(['push', 'origin', '--delete', 'refs/tags/' + TAG]); console.log('已删除远程 tag ' + TAG); } catch (e) { console.log('删除 tag:', (e.stderr || e.message || '').trim().split('\n').pop()); }

    // 3. 干净推送 master（force 覆盖）
    git(['push', '-f', '-u', 'origin', 'master']);
    console.log('已推送 master 分支');

    // 4. 重新打 tag 并推送
    try { git(['tag', '-f', TAG]); } catch (e) {}
    try { git(['push', '-f', 'origin', TAG]); console.log('已推送 tag ' + TAG); } catch (e) { console.log('推送 tag:', (e.stderr || e.message || '').trim().split('\n').pop()); }

    // 5. 创建 Release（若已存在则先删除）
    try {
      const del = await api('DELETE', 'https://api.github.com/repos/' + REPO + '/releases/tags/' + TAG, null, false);
      console.log('清理旧 release:', del.status);
    } catch (e) { console.log('清理 release 跳过:', e.message); }
    const body = JSON.stringify({
      tag_name: TAG, name: TAG,
      body: '学习助手 Study Assistant v1.8.8\n\n- 新增「检查新版本」自动更新（从 GitHub Releases 获取）\n- 使用许可协议链接迁移至 studyassistant.kfdzcoffee.cn\n- 项目官网/更新源上线',
      draft: false, prerelease: false
    });
    let r = await api('POST', 'https://api.github.com/repos/' + REPO + '/releases', body, false);
    let j; try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    if (j.id == null) { console.log('创建 release 失败:', r.status, (j.message || r.body).slice(0, 200)); process.exit(1); }
    console.log('Release 已创建:', j.html_url || '');

    // 6. 上传安装包
    const uploadUrl = (j.upload_url || '').replace('{?name,label}', '') + '?name=' + encodeURIComponent(ASSET_NAME);
    const buf = fs.readFileSync(EXE);
    const u = await api('POST', uploadUrl, buf, true);
    let uj; try { uj = JSON.parse(u.body); } catch (e) { uj = {}; }
    console.log('安装包上传状态:', u.status, '| asset:', uj.name || (u.body || '').slice(0, 200));
    console.log('DONE');
  } catch (e) {
    console.log('ERR', e.message);
    process.exit(1);
  }
})();
