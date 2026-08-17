// ===== AI 提供商适配器 =====
// openai 兼容：DeepSeek / Kimi(Moonshot)
// anthropic：Claude

// ---- 全局串行队列 ----
// 部分账号（如 Kimi）限 max organization concurrency: 1，多个请求并发会报 HTTP 429。
// 这里把所有 AI HTTP 请求排成单队列，确保同一时刻只有一个请求在途。
let aiQueue = Promise.resolve();
function enqueueAi(fn) {
  const run = aiQueue.then(fn, fn);
  aiQueue = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 带超时的 fetch（默认 180 秒）：防止 AI 请求无限挂起「卡在思考中」
async function fetchWithTimeout(url, options, timeoutMs) {
  const ms = timeoutMs || 180000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onOuterAbort = () => controller.abort();
  if (options && options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', onOuterAbort);
  }
  try {
    const opts = Object.assign({}, options, { signal: controller.signal });
    return await fetch(url, opts);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error('请求超时（超过 ' + Math.round(ms / 1000) + ' 秒未响应）：AI 提供商响应过慢或网络异常，请检查网络后重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (options && options.signal) options.signal.removeEventListener('abort', onOuterAbort);
  }
}

async function httpJson(url, options) {
  // 串行执行 + 429 限流自动重试（最多 3 次，递增等待）
  return enqueueAi(async () => {
    let res = await fetchWithTimeout(url, options);
    let attempts = 0;
    while (res.status === 429 && attempts < 3) {
      attempts++;
      const waitMs = 1200 * attempts;
      await sleep(waitMs);
      res = await fetchWithTimeout(url, options);
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new Error('API Key 无效或已过期（HTTP 401）：请到「设置 → AI 提供商」重新复制并保存 API Key');
      }
      if (res.status === 429) {
        throw new Error('请求过于频繁（HTTP 429 并发限制）：账号同一时间只允许一个请求，请稍候再试');
      }
      throw new Error(`HTTP ${res.status}: ${(t || res.statusText).slice(0, 400)}`);
    }
    return res.json();
  });
}

// 部分模型（如 Kimi K2.6 思考模式）只允许 temperature=1 或要求省略该参数：
// 仅当提供商显式配置了数值 temperature 时才随请求发送，否则省略（使用模型默认值）。
function pickTemperature(cfg) {
  const t = cfg && cfg.temperature;
  if (t === undefined || t === null || t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

// ---- OpenAI 兼容 ----
async function chatOpenAI(cfg, messages, tools, { signal, onUsage } = {}) {
  const base = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const isLocal = /localhost|127\.0\.0\.1/.test(String(cfg.baseUrl || ''));
  const hasTools = !!(tools && tools.length);

  const buildBody = (useTools) => {
    const body = { model: cfg.model, messages, stream: false };
    const temperature = pickTemperature(cfg);
    if (temperature !== undefined) body.temperature = temperature;
    if (useTools && hasTools) { body.tools = tools; body.tool_choice = 'auto'; }
    // 本地 Ollama 等思考模型（qwen3 等）：禁用思考模式，避免只输出 reasoning 导致 content 为空或响应极慢
    if (isLocal) body.enable_thinking = false;
    return body;
  };

  const doReq = async (body) => {
    const data = await httpJson(base + '/chat/completions', {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + cfg.apiKey
      },
      body: JSON.stringify(body)
    });
    // 上报 token 用量（用于每日预警统计）
    if (onUsage && data && data.usage) {
      const total = data.usage.total_tokens || 0;
      if (total) onUsage(total);
    }
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('OpenAI 兼容接口返回异常');
    // 兜底：若 content 为空但模型返回了思考内容（reasoning），提取其结论部分，避免「处理完却无输出」
    if (!String(msg.content || '').trim() && (msg.reasoning || msg.reasoning_content)) {
      const rz = String(msg.reasoning || msg.reasoning_content || '');
      const lines = rz.split(/\n+/).map((l) => l.trim()).filter(Boolean);
      msg.content = lines.slice(-3).join('\n') || rz;
    }
    return msg;
  };

  try {
    return await doReq(buildBody(true));
  } catch (e) {
    // 本地模型不支持工具调用（如 Ollama 的 qwen2.5vl 等视觉模型）→ 自动去掉 tools 降级重试一次，
    // 保证至少能返回文本内容（不再报 HTTP 400 does not support tools）
    if (hasTools && /does not support tools/i.test(String((e && e.message) || ''))) {
      return await doReq(buildBody(false));
    }
    throw e;
  }
}

// ---- Anthropic (Claude) ----
function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] });
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      if (m.tool_calls) {
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch (e) { input = { raw: tc.function.arguments }; }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      out.push({ role: 'assistant', content });
      continue;
    }
    // user
    if (Array.isArray(m.content)) {
      const content = m.content.map((c) => {
        if (c.type === 'image_url' && c.image_url && c.image_url.url) {
          const m2 = c.image_url.url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (m2) return { type: 'image', source: { type: 'base64', media_type: m2[1], data: m2[2] } };
          return { type: 'text', text: c.image_url.url };
        }
        return { type: 'text', text: c.text || '' };
      });
      out.push({ role: 'user', content });
    } else {
      out.push({ role: 'user', content: m.content || '' });
    }
  }
  return out;
}

async function chatAnthropic(cfg, messages, tools, { signal, onUsage } = {}) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = toAnthropicMessages(messages);
  const body = {
    model: cfg.model,
    max_tokens: cfg.maxTokens || 8192,
    messages: msgs
  };
  const temperature = pickTemperature(cfg);
  if (temperature !== undefined) body.temperature = temperature;
  if (sys) body.system = sys;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: 'object', properties: {} }
    }));
  }
  const data = await httpJson(base + '/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  // 上报 token 用量（input + output）
  if (onUsage && data && data.usage) {
    const total = (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0);
    if (total) onUsage(total);
  }
  const toolCalls = (data.content || [])
    .filter((c) => c.type === 'tool_use')
    .map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) } }));
  const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { role: 'assistant', content: text, tool_calls: toolCalls.length ? toolCalls : undefined };
}

// ---- 测试连接 ----
async function testConnection(cfg) {
  const t0 = Date.now();
  const p = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
  if (cfg.kind === 'anthropic') {
    await chatAnthropic(p, [{ role: 'user', content: 'ping' }], null);
  } else {
    await chatOpenAI(p, [{ role: 'user', content: 'ping' }], null);
  }
  return Date.now() - t0;
}

// ---- 图片 OCR 识别（本地 Tesseract.js，见 src/main/ocr.js，不调用 AI）----

module.exports = { chatOpenAI, chatAnthropic, testConnection };
