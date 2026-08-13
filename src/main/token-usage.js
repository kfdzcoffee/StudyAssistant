// ===== Token 消耗跟踪（按日累计）=====
// 记录每日 AI 调用消耗的 token 总数，用于超阈值预警。
const fs = require('fs');
const path = require('path');

class TokenUsage {
  constructor({ file }) {
    this.file = file;
    this.data = this.load();
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (e) {
      return {};
    }
  }

  today() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  // 累加当日用量，返回 { today, total }
  add(count) {
    const today = this.today();
    this.data[today] = (this.data[today] || 0) + (Number(count) || 0);
    // 只保留最近 30 天
    const keys = Object.keys(this.data).sort();
    while (keys.length > 30) { delete this.data[keys.shift()]; }
    try { fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
    return { today, total: this.data[today] };
  }

  get() {
    const today = this.today();
    return { today, total: this.data[today] || 0, history: this.data };
  }
}

module.exports = TokenUsage;
