// ===== AI 工具调用循环 =====
// 支持 openai 兼容（DeepSeek/Kimi）与 anthropic（Claude）

const { chatOpenAI, chatAnthropic } = require('./adapters');

// 判断 AI 的最终回复是否疑似「需要用户补充信息」的提问
// （本地小模型常常不调用 ask_user 工具，而是把问题写进正文 —— 自动转为向用户提问，避免误判为完成）
function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/[？?]\s*$/.test(t)) return true;
  return /(请(提供|告诉|确认|补充|说明|输入)|请问|能否|能不能|需要你(提供|告诉|补充|输入)|你可以(告诉|提供|补充))/.test(t) && t.length < 500;
}

async function runAgent({ provider, system, messages, tools, onEvent, onUsage, maxIters = 40 }) {
  const emit = onEvent || (() => {});
  const msgs = [{ role: 'system', content: system }].concat(messages || []);
  const defs = tools.defs;
  const askUser = (tools && tools.confirmGate && tools.confirmGate.ask) || (() => Promise.resolve({ cancelled: true, answer: '' }));

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
      const content = String(msg.content || '').trim();
      // AI 没调用 ask_user，而是把「需要补充信息」的提问写进了正文 —— 自动向用户提问后继续，不当作完成
      if (content && looksLikeQuestion(content)) {
        const r = await askUser({ question: content, options: [] });
        if (r && !r.cancelled && String(r.answer || '').trim()) {
          emit({ type: 'tool-start', name: 'ask_user', args: { question: content } });
          msgs.push({ role: 'assistant', content });
          msgs.push({ role: 'user', content: String(r.answer).trim() });
          emit({ type: 'tool-end', name: 'ask_user', ok: true });
          continue;
        }
        // 用户跳过/取消 → 不再追问，以当前内容结束
      }
      emit({ type: 'done' });
      return { content: content };
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
