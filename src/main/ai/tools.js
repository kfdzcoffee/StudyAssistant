// ===== AI 工具定义 =====
// 变更类工具（write_file / append_to_file / create_subject / git_*）经确认门后执行

const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作目录下的文件与子目录（含相对路径）。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '相对目录，默认根目录' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作目录内文本文件（如 _sidebar.md、README.md、分数预测.md 等小文件；大档案会被截断到前 30000 字符）。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file_range',
      description: '按行号读取文本文件的指定段（省 token）。大档案请用本工具按需分段读取，不要整篇 read_file。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          start: { type: 'number', description: '起始行号（从 1 开始）' },
          end: { type: 'number', description: '结束行号（默认 start+200）' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'subject_summary',
      description: '返回知识库各科错题档案的紧凑摘要（每科：错题数、最大题号、题号+标题、错因概览），token 消耗远小于整篇读取。分数预测、错题统计、确定新题号时首选此工具。',
      parameters: {
        type: 'object',
        properties: {
          subjects: { type: 'array', items: { type: 'string' }, description: '科目列表（如 [数学,语文]），省略则返回全部科目' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入/覆盖工作目录内文件（.md 自动 UTF-8+BOM）。用于更新 _sidebar.md、README.md、分数预测.md、编辑注意事项.md 等。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string', description: '完整文件内容' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'append_to_file',
      description: '向工作目录内文件末尾追加内容（.md 自动 UTF-8+BOM）。用于新增错题条目、作文分析等。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_subject',
      description: '新建科目档案：创建 科目.md 并在 _sidebar.md 与 README.md 中注册（仅当科目档案不存在时使用）。',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: '科目名，如 物理' },
          content: { type: 'string', description: '科目档案完整 Markdown 内容' }
        },
        required: ['subject', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_status',
      description: '查看工作目录的 Git 状态（变更文件、分支）。'
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_clean',
      description: '执行 git rm -r --cached . 并 git add -A（清理索引后重新暂存）。'
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_commit',
      description: '提交变更。默认 commit 消息格式为「修改内容 - YYYY-MM-DD HH:mm」。',
      parameters: { type: 'object', properties: { message: { type: 'string', description: '提交信息' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git_push',
      description: '推送到远程仓库（失败自动重试最多 3 次）。'
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_file',
      description: '在工作区编辑器标签页中打开指定文件，供用户查看。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: '向用户提问并等待回答。需要用户确认（如核对 OCR 识别内容是否准确）、或需要用户补充关键信息时使用。用户可点快捷选项或自行输入。',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: '要问用户的问题' },
          options: { type: 'array', items: { type: 'string' }, description: '可选的快捷选项（用户也可自行输入回答）' }
        },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'preview',
      description: '在网页预览视图中打开指定文件（如 /数学.md）。',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  }
];

// 解析科目档案为紧凑摘要：每题 题号/标题/错因首段（省 token，替代整篇读取）
function parseSubjectSummary(content) {
  const blocks = String(content || '').split(/\n(?=#{2,4}\s*错题\s*\d+\s*[：:])/);
  const out = [];
  for (const b of blocks) {
    const hm = b.match(/^#{2,4}\s*错题\s*(\d+)\s*[：:]\s*(.*)$/m);
    if (!hm) continue;
    const n = parseInt(hm[1], 10);
    const title = (hm[2] || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    let cause = '';
    const cm = b.match(/\*\*错因分析\*\*\s*[：:]?\s*\n+([^\n#]+)/);
    if (cm) cause = cm[1].trim().replace(/\s+/g, ' ').slice(0, 50);
    out.push({ n, title, cause });
  }
  return out;
}

function createTools({ workspace, git, confirmGate, emit, windowRef }) {
  const onEvent = emit || (() => {});

  async function execute(name, rawArgs) {
    let args = rawArgs || {};
    switch (name) {
      case 'list_files': {
        const r = workspace.list(args.path || '');
        if (!r.ok) return { error: r.message };
        return { ok: true, root: r.root, files: r.items.map((i) => (i.isDir ? i.name + '/' : i.name)) };
      }
      case 'read_file': {
        try {
          const r = workspace.read(args.path);
          let content = r.content;
          const MAX = 30000;
          let truncated = false;
          if (content.length > MAX) { content = content.slice(0, MAX); truncated = true; }
          return { ok: true, path: r.path, content, truncated, note: truncated ? '（内容过长已截断，请用 read_file_range 按行读取所需部分）' : undefined };
        } catch (e) { return { error: e.message }; }
      }
      case 'read_file_range': {
        try {
          const r = workspace.read(args.path);
          const lines = r.content.split('\n');
          const start = Math.max(1, Number(args.start) || 1);
          const end = Math.min(lines.length, Number(args.end) || (start + 200));
          const slice = lines.slice(start - 1, end);
          return { ok: true, path: r.path, lineStart: start, lineEnd: end, total: lines.length, content: slice.map((l, i) => String(start + i) + ': ' + l).join('\n') };
        } catch (e) { return { error: e.message }; }
      }
      case 'subject_summary': {
        try {
          let files;
          if (args.subjects && args.subjects.length) {
            files = args.subjects.map((s) => String(s).replace(/\.md$/i, '') + '.md');
          } else {
            const lr = workspace.list('');
            files = lr.ok
              ? lr.items.filter((i) => !i.isDir && /\.md$/i.test(i.name) && ['README.md', '_sidebar.md', '分数预测.md', '编辑注意事项.md'].indexOf(i.name) === -1).map((i) => i.name)
              : [];
          }
          const out = [];
          for (const f of files) {
            try {
              const r = workspace.read(f);
              if (!r.ok) continue;
              const items = parseSubjectSummary(r.content);
              out.push({
                file: f,
                errors: items.length,
                maxQuestionNo: items.reduce((mx, e) => Math.max(mx, e.n), 0),
                items: items.slice(-40).map((e) => e.n + '. ' + e.title + (e.cause ? ' ｜ ' + e.cause : ''))
              });
            } catch (e) { /* 文件缺失则跳过 */ }
          }
          return { ok: true, subjects: out };
        } catch (e) { return { error: e.message }; }
      }
      case 'write_file': {
        try {
          const r = await workspace.write(args.path, args.content, { confirmGate });
          return r.cancelled ? { ok: false, cancelled: true, reason: '用户拒绝了写入' } : r;
        } catch (e) { return { error: e.message }; }
      }
      case 'append_to_file': {
        try {
          const r = await workspace.append(args.path, args.content, { confirmGate });
          return r.cancelled ? { ok: false, cancelled: true, reason: '用户拒绝了追加' } : r;
        } catch (e) { return { error: e.message }; }
      }
      case 'create_subject': {
        try {
          const r = await workspace.createSubject(args.subject, args.content, { confirmGate });
          return r.cancelled ? { ok: false, cancelled: true, reason: '用户拒绝了新建科目' } : r;
        } catch (e) { return { error: e.message }; }
      }
      case 'git_status': {
        const r = await git.status();
        return r;
      }
      case 'git_clean': {
        const r = await confirmGate.request({
          tool: 'git_clean', target: '(git)', summary: '执行 git clean（git rm -r --cached . + git add -A）', args: {}
        });
        if (!r.approved) return { ok: false, cancelled: true };
        try { await git.clean(); return { ok: true }; } catch (e) { return { error: e.message }; }
      }
      case 'git_commit': {
        const r = await confirmGate.request({
          tool: 'git_commit', target: '(git)', summary: '提交变更：' + (args.message || '默认消息'), args: { message: args.message }
        });
        if (!r.approved) return { ok: false, cancelled: true };
        try { return await git.commit(args.message); } catch (e) { return { error: e.message }; }
      }
      case 'git_push': {
        const r = await confirmGate.request({
          tool: 'git_push', target: '(git)', summary: '推送到 GitHub 远程仓库（重试最多3次）', args: {}
        });
        if (!r.approved) return { ok: false, cancelled: true };
        try { return await git.push(); } catch (e) { return { error: e.message }; }
      }
      case 'open_file': {
        onEvent({ type: 'open-file', path: args.path });
        if (windowRef) windowRef.webContents.send('agent:event', { type: 'open-file', path: args.path });
        return { ok: true };
      }
      case 'preview': {
        onEvent({ type: 'preview', path: args.path });
        if (windowRef) windowRef.webContents.send('agent:event', { type: 'preview', path: args.path });
        return { ok: true };
      }
      case 'ask_user': {
        const r = await confirmGate.ask({ question: args.question, options: args.options });
        if (r.cancelled) return { ok: false, cancelled: true, reason: '用户跳过了提问' };
        return { ok: true, answer: r.answer };
      }
      default:
        return { error: '未知工具: ' + name };
    }
  }

  return { defs: TOOL_DEFS, execute, confirmGate };
}

module.exports = { createTools, TOOL_DEFS };
