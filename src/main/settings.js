const fs = require('fs');
const path = require('path');

// ===== 默认配置 =====
const DEFAULT_PROVIDERS = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', kind: 'openai',
    baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash',
    vision: false, enabled: false, apiKey: '', systemPrompt: '', temperature: '',
    models: [
      { name: 'DeepSeek-V4 Flash（deepseek-v4-flash）· 推荐', id: 'deepseek-v4-flash' },
      { name: 'DeepSeek-V4 Pro（deepseek-v4-pro）· 更强', id: 'deepseek-v4-pro' }
    ]
  },
  kimi: {
    id: 'kimi', name: 'Kimi (Moonshot)', kind: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6',
    vision: true, enabled: false, apiKey: '', systemPrompt: '', temperature: '',
    models: [
      { name: 'Kimi K2.6（kimi-k2.6）· 推荐', id: 'kimi-k2.6' },
      { name: 'Kimi K2.7 Code（kimi-k2.7-code）', id: 'kimi-k2.7-code' },
      { name: 'Kimi K2.7 Code 高速（kimi-k2.7-code-highspeed）', id: 'kimi-k2.7-code-highspeed' },
      { name: 'Kimi K2.5（kimi-k2.5）', id: 'kimi-k2.5' },
      { name: 'Kimi K2 思考版（kimi-k2-thinking）', id: 'kimi-k2-thinking' },
      { name: 'Kimi 视觉（moonshot-v1-8k-vision-preview）', id: 'moonshot-v1-8k-vision-preview' },
      { name: 'moonshot-v1-8k', id: 'moonshot-v1-8k' },
      { name: 'moonshot-v1-32k', id: 'moonshot-v1-32k' },
      { name: 'moonshot-v1-128k', id: 'moonshot-v1-128k' }
    ]
  },
  claude: {
    id: 'claude', name: 'Claude (Anthropic)', kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-20250514',
    vision: true, enabled: false, apiKey: '', systemPrompt: '', temperature: '',
    models: [
      { name: 'Claude Sonnet 4（claude-sonnet-4-20250514）', id: 'claude-sonnet-4-20250514' },
      { name: 'Claude Opus 4（claude-opus-4-20250514）', id: 'claude-opus-4-20250514' },
      { name: 'Claude Sonnet 3.7（claude-3-7-sonnet-20250219）', id: 'claude-3-7-sonnet-20250219' },
      { name: 'Claude Haiku 3.5（claude-3-5-haiku-20241022）', id: 'claude-3-5-haiku-20241022' }
    ]
  }
};

const DEFAULT_PROMPTS = {
  errorHelper:
    '你是一个「错题归纳帮手」。请把用户提供的错题整理为：错题、错因、录入日期、正确答案、错因分析、典型例题（同类题变形），并严格按知识库既有科目档案的 Markdown 格式输出与写入。',
  studyHelper:
    '你是一个「学习归纳帮手」。请帮忙：预估高考各科分数、分析语文和英语的作文（评分明细 + 错因逐条分析），并提供纵向（历史同类）与横向（跨科目/维度）对比。'
};

function defaultConfig() {
  return {
    version: 1,
    initialized: false,
    workspacePath: '',
    theme: 'dark',
    nickname: '',
    tokenWarn: 500000,
    activeProvider: 'deepseek',
    exam: { type: 'gaokao', name: '', year: 2027, month: 6, day: 7 },
    examPassword: '',
    ocr: { auto: false, engine: 'win' },
    users: [],
    currentUser: '',
    providers: JSON.parse(JSON.stringify(DEFAULT_PROVIDERS)),
    prompts: JSON.parse(JSON.stringify(DEFAULT_PROMPTS))
  };
}

class Settings {
  constructor({ app, safeStorage, dialog }) {
    this.app = app;
    this.safeStorage = safeStorage;
    this.dialog = dialog;
    this.configPath = path.join(app.getPath('userData'), 'config.json');
    this.config = null;
    this.load();
  }

  get configFile() { return this.configPath; }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        const cfg = Object.assign(defaultConfig(), raw);
        // 合并 providers（保留已存字段，补齐默认字段）
        for (const key of Object.keys(DEFAULT_PROVIDERS)) {
          cfg.providers[key] = Object.assign({}, DEFAULT_PROVIDERS[key], cfg.providers[key] || {});
          // 迁移：DeepSeek 旧模型名已下线，自动切到新模型
          if (key === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner'].includes(cfg.providers[key].model)) {
            cfg.providers[key].model = 'deepseek-v4-flash';
          }
          // 迁移：Kimi 旧默认模型已下线，自动切到 K2.6
          if (key === 'kimi' && ['kimi-k2-0711-preview', 'kimi-k2-turbo-preview'].includes(cfg.providers[key].model)) {
            cfg.providers[key].model = 'kimi-k2.6';
          }
        }
        cfg.exam = Object.assign({ type: 'gaokao', name: '', year: 2027, month: 6, day: 7 }, cfg.exam || {});
        cfg.ocr = Object.assign({ auto: false, engine: 'win' }, cfg.ocr || {});
        cfg.nickname = cfg.nickname || '';
        cfg.tokenWarn = Number(cfg.tokenWarn) || 500000;
        cfg.users = Array.isArray(cfg.users) ? cfg.users : [];
        cfg.currentUser = cfg.currentUser || '';
        cfg.prompts = Object.assign({}, DEFAULT_PROMPTS, cfg.prompts || {});
        this.config = cfg;
        return cfg;
      }
    } catch (e) { /* 损坏则重置 */ }
    this.config = defaultConfig();
    return this.config;
  }

  // 解密单个 key
  decryptKey(b64) {
    if (!b64) return '';
    try {
      const buf = Buffer.from(b64, 'base64');
      return this.safeStorage.decryptString(buf);
    } catch (e) {
      return '';
    }
  }

  encryptKey(str) {
    if (!str) return '';
    try {
      return this.safeStorage.encryptString(str).toString('base64');
    } catch (e) {
      return str; // 无安全存储时降级明文
    }
  }

  getConfig() {
    if (!this.config) this.load();
    const out = JSON.parse(JSON.stringify(this.config));
    // 返回时解密 key（仅给主进程内部/渲染进程展示掩码）
    for (const k of Object.keys(out.providers)) {
      out.providers[k].apiKey = this.decryptKey(out.providers[k].apiKey);
    }
    return out;
  }

  saveConfig(cfg) {
    const clean = JSON.parse(JSON.stringify(cfg));
    for (const k of Object.keys(clean.providers)) {
      clean.providers[k].apiKey = this.encryptKey(clean.providers[k].apiKey || '');
    }
    try {
      fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
      fs.writeFileSync(this.configPath, JSON.stringify(clean, null, 2), 'utf8');
    } catch (e) { /* ignore */ }
    this.config = clean;
    return clean;
  }
}

module.exports = Settings;
module.exports.DEFAULT_PROVIDERS = DEFAULT_PROVIDERS;
module.exports.DEFAULT_PROMPTS = DEFAULT_PROMPTS;
