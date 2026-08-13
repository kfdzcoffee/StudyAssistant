const { execSync } = require('child_process');
const DIR = 'd:/BaiduSyncdisk/学习/高考复习/错题助手桌面端';
const g = (a) => execSync('git ' + a.map((x) => '"' + String(x).replace(/"/g, '\\"') + '"').join(' '), { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).toString();
g(['add', '-A']);
try { g(['-c', 'user.name=Kfdzcoffee', '-c', 'user.email=me@kfdzcoffee.cn', 'commit', '-m', 'README 增加项目官网与项目初衷']); console.log('已提交'); } catch (e) { console.log('commit:', (e.stderr || '').toString().trim().split('\n').pop()); }
g(['push', 'origin', 'master']);
console.log('master 已推送');
