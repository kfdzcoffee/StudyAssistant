// 创建 GitHub Release 并上传安装包（token 由 git 凭据管理器提供，不打印）
const https = require('https');
const fs = require('fs');
const { spawnSync } = require('child_process');

const REPO = 'kfdzcoffee/StudyAssistant';
const TAG = 'v1.8.8';
const EXE = 'C:/Users/wangz/AppData/Local/Temp/study-dist/学习助手-安装-1.8.8.exe';
const ASSET_NAME = '学习助手-安装-1.8.8.exe';

function getToken() {
  const r = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
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
    // 1. 创建 release（从已推送的 tag）
    const body = JSON.stringify({
      tag_name: TAG,
      name: TAG,
      body: '学习助手 Study Assistant v1.8.8\n\n- 新增「检查新版本」自动更新（从 GitHub Releases 获取）\n- 使用许可协议链接迁移至 studyassistant.kfdzcoffee.cn\n- 项目官网/更新源上线',
      draft: false,
      prerelease: false
    });
    let r = await api('POST', 'https://api.github.com/repos/' + REPO + '/releases', body, false);
    let j;
    try { j = JSON.parse(r.body); } catch (e) { j = {}; }
    if (r.status !== 201 && j.id == null) {
      // 可能已存在（重复运行）→ 尝试复用已有 release
      console.log('create release status:', r.status, '| msg:', (j.message || r.body).slice(0, 200));
      const rr = await api('GET', 'https://api.github.com/repos/' + REPO + '/releases/tags/' + TAG, null, false);
      j = JSON.parse(rr.body);
      if (!j.id) { console.log('FAIL 找不到既有 release'); process.exit(1); }
    }
    // 2. 上传安装包 asset
    const uploadUrl = (j.upload_url || '').replace('{?name,label}', '') + '?name=' + encodeURIComponent(ASSET_NAME);
    const buf = fs.readFileSync(EXE);
    const u = await api('POST', uploadUrl, buf, true);
    let uj; try { uj = JSON.parse(u.body); } catch (e) { uj = {}; }
    console.log('asset upload status:', u.status);
    console.log('asset:', uj.name || u.body.slice(0, 200));
    console.log('release url:', j.html_url || '');
    console.log('DONE');
  } catch (e) {
    console.log('ERR', e.message);
    process.exit(1);
  }
})();
