const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MODEL_CATALOG = [
  {
    id: 'moondream2',
    name: 'Moondream2 (Vision)',
    family: '视觉识别（轻量）',
    vision: true,
    license: 'Apache-2.0',
    commercialUse: true,
    size: '约 1.5GB',
    hfVisionModel: 'Xenova/moondream2',
    hfTextModel: 'onnx-community/Qwen2.5-0.5B-Instruct',
    textModelFileName: 'model_quantized',
    textQuantized: false,
    recommended: { cpuCores: 6, ramGB: 12, vramGB: 2 },
    notes: '轻量视觉模型，速度快。'
  },
  {
    id: 'qwen2.5-1.5b',
    name: 'Qwen2.5 1.5B Instruct',
    family: '文本（通用）',
    vision: false,
    license: 'Apache-2.0',
    commercialUse: true,
    size: '约 2.0GB',
    hfTextModel: 'onnx-community/Qwen2.5-1.5B-Instruct',
    textModelFileName: 'model_quantized',
    textQuantized: false,
    recommended: { cpuCores: 6, ramGB: 12, vramGB: 0 },
    notes: '中文表现好，适合日常学习问答。'
  },
  {
    id: 'phi-3-mini',
    name: 'Phi-3 Mini Instruct',
    family: '文本（轻量）',
    vision: false,
    license: 'MIT',
    commercialUse: true,
    size: '约 2.4GB',
    hfTextModel: 'Xenova/Phi-3-mini-4k-instruct',
    textModelFileName: 'model_q4',
    textQuantized: false,
    recommended: { cpuCores: 6, ramGB: 12, vramGB: 0 },
    notes: '英文推理较强，速度稳定。'
  },
  {
    id: 'qwen2.5-0.5b',
    name: 'Qwen2.5 0.5B Instruct',
    family: '文本（极速）',
    vision: false,
    license: 'Apache-2.0',
    commercialUse: true,
    size: '约 1.0GB',
    hfTextModel: 'onnx-community/Qwen2.5-0.5B-Instruct',
    textModelFileName: 'model_quantized',
    textQuantized: false,
    recommended: { cpuCores: 4, ramGB: 8, vramGB: 0 },
    notes: '响应快，适合低配设备。'
  }
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBytesToGB(n) {
  const v = Number(n) || 0;
  return Math.round((v / (1024 ** 3)) * 10) / 10;
}

class LocalModelManager {
  constructor() {
    this.idleTimer = null;
    this.textGen = null;
    this.visionGen = null;
    this.running = false;
    this.activeModelId = '';
    this._transformers = null;
  }

  getCatalog() {
    return MODEL_CATALOG.slice();
  }

  getModelById(id) {
    return MODEL_CATALOG.find((m) => m.id === id) || null;
  }

  async ensureTransformers(localCfg = {}) {
    if (!this._transformers) {
      try {
        this._transformers = await import('@xenova/transformers');
      } catch (e) {
        throw new Error('缺少内置推理依赖 @xenova/transformers，请先执行 npm install。');
      }
    }
    const cacheDir = localCfg.modelStorePath
      ? path.join(localCfg.modelStorePath, 'hf-cache')
      : path.join(os.homedir(), '.study-assistant-models', 'hf-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    this._transformers.env.cacheDir = cacheDir;
    this._transformers.env.allowRemoteModels = true;
    // 使用 Hugging Face 镜像（中国大陆网络无法直连 huggingface.co）
    this._transformers.env.remoteHost = 'https://hf-mirror.com/';
    this._transformers.env.remotePathTemplate = '{model}/resolve/{revision}/';
    return this._transformers;
  }

  // 检查内置推理依赖是否已安装（@xenova/transformers）
  async checkRuntimeDependency() {
    try {
      await import('@xenova/transformers');
      return { ok: true, name: '@xenova/transformers', installed: true };
    } catch (e) {
      return { ok: false, name: '@xenova/transformers', installed: false, message: '缺少内置推理依赖 @xenova/transformers，请先执行 npm install。' };
    }
  }

  async detectGpuWindows() {
    if (process.platform !== 'win32') return [];
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
    ].join(' ');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      const out = await new Promise((resolve, reject) => {
        execFile(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
          windowsHide: true,
          timeout: 12000,
          encoding: 'utf8'
        }, (err, stdout) => {
          if (err) return reject(err);
          resolve((stdout || '').trim());
        });
      });
      if (!out) return [];
      const parsed = JSON.parse(out);
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list.map((g) => ({ name: String(g.Name || 'Unknown GPU'), vramGB: parseBytesToGB(g.AdapterRAM) }));
    } catch (e) {
      return [];
    }
  }

  async detectDevice(modelId) {
    const model = this.getModelById(modelId);
    const gpus = await this.detectGpuWindows();
    const maxVram = gpus.reduce((mx, g) => Math.max(mx, Number(g.vramGB) || 0), 0);
    const device = {
      platform: process.platform,
      arch: process.arch,
      cpuCores: (os.cpus() || []).length || 1,
      ramGB: Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10,
      gpus,
      maxVramGB: maxVram
    };
    const runtime = await this.checkRuntimeDependency();
    if (!model) return { ok: false, message: '模型不存在', device, runtime };
    const rec = model.recommended || {};
    const reasons = [];
    if (!runtime.ok) reasons.push(runtime.message);
    if (device.cpuCores < (rec.cpuCores || 0)) reasons.push('CPU 核心数偏低（推荐 >= ' + rec.cpuCores + '）');
    if (device.ramGB < (rec.ramGB || 0)) reasons.push('内存偏低（推荐 >= ' + rec.ramGB + 'GB）');
    if ((rec.vramGB || 0) > 0 && device.maxVramGB > 0 && device.maxVramGB < rec.vramGB) reasons.push('显存偏低（推荐 >= ' + rec.vramGB + 'GB）');
    if ((rec.vramGB || 0) > 0 && device.maxVramGB <= 0) reasons.push('未检测到独立显卡，可能仅 CPU 推理，速度较慢');
    return { ok: true, model, device, runtime, recommended: reasons.length === 0, reasons };
  }

  async startService(localCfg = {}, onProgress = null) {
    const model = this.getModelById(localCfg.selectedModelId) || this.getCatalog()[0];
    const t = await this.ensureTransformers(localCfg);
    const { pipeline } = t;
    const progressCb = (p) => {
      if (typeof onProgress === 'function') onProgress(p);
    };
    if (!this.textGen || this.activeModelId !== model.id) {
      progressCb({ status: 'download', file: model.hfTextModel, progress: 0, message: '正在下载文本模型 ' + model.hfTextModel + ' …' });
      const textOpts = { progress_callback: progressCb };
      if (model.textModelFileName) {
        textOpts.model_file_name = model.textModelFileName;
        textOpts.quantized = model.textQuantized !== false;
      } else {
        textOpts.quantized = true;
      }
      this.textGen = await pipeline('text-generation', model.hfTextModel, textOpts);
    }
    if (model.vision) {
      progressCb({ status: 'download', file: model.hfVisionModel, progress: 0, message: '正在下载视觉模型 ' + model.hfVisionModel + ' …' });
      const visionOpts = { progress_callback: progressCb };
      if (model.visionModelFileName) {
        visionOpts.model_file_name = model.visionModelFileName;
        visionOpts.quantized = model.visionQuantized !== false;
      } else {
        visionOpts.quantized = true;
      }
      this.visionGen = await pipeline('image-to-text', model.hfVisionModel, visionOpts);
    } else {
      this.visionGen = null;
    }
    this.running = true;
    this.activeModelId = model.id;
    return { ok: true, started: true, modelId: model.id };
  }

  async stopService() {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.textGen = null;
    this.visionGen = null;
    this.running = false;
    this.activeModelId = '';
    return { ok: true };
  }

  scheduleIdleStop(localCfg = {}) {
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (localCfg.idlePolicy !== 'idle_5m') return;
    const mins = Math.max(1, Number(localCfg.idleMinutes) || 5);
    this.idleTimer = setTimeout(() => {
      this.stopService().catch(() => {});
    }, mins * 60 * 1000);
  }

  async ensureReady(localCfg = {}) {
    if (!localCfg.enabled) throw new Error('本机模型已关闭，请在设置中开启后再使用。');
    if (!this.running || this.activeModelId !== localCfg.selectedModelId) {
      await this.startService(localCfg);
    }
    this.scheduleIdleStop(localCfg);
  }

  async listInstalled(localCfg = {}) {
    const cacheDir = localCfg.modelStorePath
      ? path.join(localCfg.modelStorePath, 'hf-cache')
      : path.join(os.homedir(), '.study-assistant-models', 'hf-cache');
    if (!fs.existsSync(cacheDir)) return { ok: true, models: [] };
    const names = fs.readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    return { ok: true, models: names };
  }

  async installModel(modelId, localCfg = {}, force = false, onProgress = null) {
    const model = this.getModelById(modelId);
    if (!model) return { ok: false, message: '模型不存在' };
    const detect = await this.detectDevice(modelId);
    if (!detect.ok) return detect;
    if (!detect.recommended && !force) {
      return { ok: false, recommended: false, needConfirm: true, model, device: detect.device, reasons: detect.reasons, message: '当前设备未达到推荐配置，不建议安装该模型。' };
    }
    const prev = localCfg.selectedModelId;
    const cfg = Object.assign({}, localCfg, { selectedModelId: modelId });
    try {
      await this.startService(cfg, onProgress);
      await delay(60);
      if (localCfg.idlePolicy === 'manual' && prev !== modelId) await this.stopService();
      return { ok: true, model, message: '模型安装完成（已缓存到本地）' };
    } catch (e) {
      return { ok: false, message: '安装失败：' + e.message };
    }
  }

  buildProvider(localCfg = {}, providerCfg = {}) {
    const selected = this.getModelById(localCfg.selectedModelId) || this.getCatalog()[0];
    return Object.assign({}, providerCfg || {}, {
      id: 'local-embedded',
      name: '本机模型',
      kind: 'embedded',
      model: selected ? selected.id : '',
      vision: !!(selected && selected.vision),
      enabled: true,
      apiKey: ''
    });
  }

  stringifyMessages(messages) {
    const arr = Array.isArray(messages) ? messages : [];
    const lines = [];
    for (const m of arr) {
      if (Array.isArray(m.content)) {
        const t = m.content.filter((x) => x.type === 'text').map((x) => x.text || '').join('\n');
        if (t) lines.push((m.role || 'user') + ': ' + t);
      } else if (m.content) {
        lines.push((m.role || 'user') + ': ' + String(m.content));
      }
    }
    return lines.join('\n');
  }

  extractLastImageDataUrl(messages) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || !Array.isArray(m.content)) continue;
      const img = m.content.find((x) => x && x.type === 'image_url' && x.image_url && x.image_url.url);
      if (img) return img.image_url.url;
    }
    return '';
  }

  async generate(messages, localCfg = {}) {
    await this.ensureReady(localCfg);
    const model = this.getModelById(localCfg.selectedModelId) || this.getCatalog()[0];
    let prompt = this.stringifyMessages(messages);
    if (model.vision) {
      const img = this.extractLastImageDataUrl(messages);
      if (img && this.visionGen) {
        try {
          let imageInput = img;
          let tmpFile = '';
          const m = String(img).match(/^data:(image\/\w+);base64,(.+)$/);
          if (m) {
            const ext = (m[1].split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
            tmpFile = path.join(os.tmpdir(), 'sa-local-vision-' + Date.now() + '.' + ext);
            fs.writeFileSync(tmpFile, Buffer.from(m[2], 'base64'));
            imageInput = tmpFile;
          }
          const cap = await this.visionGen(imageInput);
          const caption = Array.isArray(cap) && cap[0] && cap[0].generated_text ? cap[0].generated_text : '';
          if (caption) prompt += '\n图片内容识别：' + caption;
          if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) { /* ignore */ } }
        } catch (e) {
          prompt += '\n图片内容识别失败，可忽略图片继续回答。';
        }
      }
    }
    const out = await this.textGen(prompt + '\nassistant:', {
      max_new_tokens: 400,
      temperature: 0.6,
      top_p: 0.9,
      do_sample: true,
      repetition_penalty: 1.05
    });
    const text = Array.isArray(out) && out[0] && out[0].generated_text ? String(out[0].generated_text) : '';
    this.scheduleIdleStop(localCfg);
    return text.replace(prompt + '\nassistant:', '').trim() || text.trim();
  }

  async getRuntimeState(localCfg = {}) {
    const installed = await this.listInstalled(localCfg);
    const runtime = await this.checkRuntimeDependency();
    return {
      ok: true,
      running: this.running,
      runtime,
      installed: installed.models || []
    };
  }
}

module.exports = { LocalModelManager, MODEL_CATALOG };
