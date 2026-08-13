const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const FORBIDDEN = ['AIGC', 'Label', 'ContentProducer', 'ProduceID', 'ReservedCode', 'ContentPropagator', 'PropagateID'];

function run(cwd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || '').toString().trim() || err.message));
      } else {
        resolve((stdout || '').toString());
      }
    });
  });
}

class GitService {
  constructor(getRoot) {
    this.getRoot = getRoot;
  }
  cwd() { return this.getRoot(); }

  // Windows 下常见 'dubious ownership'：将工作目录加入 safe.directory 豁免
  async ensureSafe() {
    try {
      await run(this.cwd(), ['config', '--global', '--add', 'safe.directory', this.cwd()]);
    } catch (e) { /* ignore */ }
  }
  async guard(args) {
    await this.ensureSafe();
    return run(this.cwd(), args);
  }

  async branch() {
    try {
      const b = await this.guard(['rev-parse', '--abbrev-ref', 'HEAD']);
      return b.trim() || 'master';
    } catch (e) { return 'master'; }
  }

  async status() {
    try {
      const short = await this.guard(['status', '--short']);
      const ahead = await this.guard(['status', '-sb']).catch(() => '');
      return { ok: true, short: short.trim(), branch: await this.branch(), remote: ahead.trim().split('\n')[0] || '' };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  async clean() {
    await this.guard(['rm', '-r', '--cached', '.']);
    await this.guard(['add', '-A']);
    return { ok: true };
  }

  async commit(message) {
    const msg = message || ('修改内容 - ' + new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'));
    await this.guard(['add', '-A']);
    // 无变更时直接跳过 commit
    const s = await this.guard(['status', '--short']);
    if (!s.trim()) return { ok: true, skipped: true, message: '无变更' };
    await this.guard(['commit', '-m', msg]);
    return { ok: true, message: msg };
  }

  async push() {
    const b = await this.branch();
    let lastErr = null;
    for (let i = 0; i < 3; i++) {
      try {
        const out = await this.guard(['push', 'origin', b]);
        return { ok: true, output: out.trim() || 'push 成功', attempt: i + 1 };
      } catch (e) {
        lastErr = e.message;
        if (i === 2) break;
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
    return { ok: false, message: lastErr || 'push 失败' };
  }

  async log(n) {
    try {
      const out = await this.guard(['log', '--oneline', '-n', String(n || 20)]);
      return { ok: true, lines: out.trim().split('\n').filter(Boolean) };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  }

  // 扫描所有 .md 是否被注入 AIGC 追踪串（YAML frontmatter）
  async scanAigc() {
    const root = this.cwd();
    const hits = [];
    const walk = (dir, depth) => {
      if (depth > 4) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue;
        const fp = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(fp, depth + 1);
        else if (ent.name.toLowerCase().endsWith('.md')) {
          try {
            const txt = fs.readFileSync(fp, 'utf8');
            const head = txt.slice(0, 600);
            const rel = path.relative(root, fp).replace(/\\/g, '/');
            for (const f of FORBIDDEN) {
              if (head.indexOf(f) !== -1) { hits.push({ file: rel, field: f }); break; }
            }
          } catch (e) { /* ignore */ }
        }
      }
    };
    if (fs.existsSync(root)) walk(root, 0);
    return { ok: true, hits };
  }
}

module.exports = GitService;
