// ===== AI 工具调用循环 =====
// 支持 openai 兼容（DeepSeek/Kimi）与 anthropic（Claude）

const { chatOpenAI, chatAnthropic } = require('./adapters');

async function runAgent({ provider, system, messages, tools, onEvent, onUsage, maxIters = 40 }) {
  const emit = onEvent || (() => {});
  const msgs = [{ role: 'system', content: system }].concat(messages || []);
  const defs = tools.defs;

  for (let i = 0; i < maxIters; i++) {
    emit({ type: 'thinking', iter: i });
    let msg;
    try {
      msg = provider.kind === 'anthropic'
        ? await chatAnthropic(provider, msgs, defs, { onUsage })
        : await chatOpenAI(provider, msgs, defs, { onUsage });
    } catch (e) {
      emit({ type: 'error', message: e.message });
      throw e;
    }

    const calls = msg.tool_calls || [];
    if (calls.length === 0) {
      emit({ type: 'done' });
      return { content: msg.content || '' };
    }

    msgs.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
    for (const tc of calls) {
      const name = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); }
      catch (e) { args = { raw: tc.function.arguments }; }
      emit({ type: 'tool-start', name, args });

      let result;
      try {
        result = await tools.execute(name, args);
      } catch (e) {
        result = { error: e.message };
      }
      emit({ type: 'tool-end', name, ok: !result.error && result.ok !== false, result });
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }

  const err = new Error('工具调用次数过多，已自动停止。');
  emit({ type: 'error', message: err.message });
  throw err;
}

module.exports = { runAgent };
