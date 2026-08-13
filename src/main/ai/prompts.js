// ===== 系统提示词构建 =====
// 自动注入「编辑注意事项.md」内容，使 AI 遵守知识库既有规范

function editingNotesBlock(notes) {
  const n = (notes || '').trim();
  if (!n) return '';
  return '\n\n【知识库编辑规范 —— 必须严格遵守】\n' + n + '\n';
}

function buildSystemPrompt(mode, cfg, notes, draftOnly) {
  const errorHelper = (cfg.prompts && cfg.prompts.errorHelper) || '';
  const studyHelper = (cfg.prompts && cfg.prompts.studyHelper) || '';
  if (notes == null) notes = cfg.editingNotes || '';

  const base =
    '你运行在「错题助手」桌面应用中，工作目录是 docsify 错题知识库（高考复习）。\n' +
    '你可以通过工具读写知识库文件、操作 Git。\n' +
    '重要：所有写文件与 Git 操作都会弹窗请求用户确认；因此请一次性给出完整、正确的内容，避免反复修改浪费用户时间。\n' +
    '若需要用户确认（如核对 OCR 识别内容是否准确）、或需要用户补充关键信息，请调用 ask_user 工具向用户提问并等待回答；不要只把问题写在最终回复里就结束。\n' +
    '必须严格遵守知识库既有 Markdown 格式与编辑规范。';

  let sys = base;
  if (mode === 'error-entry') {
    sys +=
      '\n\n【角色：' + (errorHelper || '错题归纳帮手') + '】\n' +
      '任务：将用户提供的错题整理为符合知识库格式的错题条目，包含：错题、错因、录入日期、正确答案、错因分析、典型例题（同类题变形）。\n' +
      '要求：\n' +
      '1. 先用 subject_summary 查看对应科目（含最大题号 N 与既有结构）；如需确认格式细节，用 read_file_range 读取该科档案开头几十行即可，不要整篇 read_file 大档案；\n' +
      '2. 使用 append_to_file 追加新错题条目（格式：#### 错题 N：标题）；\n' +
      '3. 必要时更新 _sidebar.md、README.md 的题目统计（这些小文件可用 read_file / write_file）；\n' +
      '4. 若科目档案不存在，用 create_subject 新建。\n' +
      '5. 数学公式用 $...$ / $$...$$ 包裹。';
  } else if (mode === 'essay-analysis') {
    sys +=
      '\n\n【角色：' + (studyHelper || '学习归纳帮手') + '】\n' +
      '任务：分析语文/英语作文，提供评分明细、错因逐条分析、纵向对比（对比该科历史作文）与横向对比（跨维度/跨科目）。\n' +
      '要求：\n' +
      '1. 先读取 语文.md 或 英语.md 的作文档案（若档案很大，用 subject_summary 或 read_file_range 按需读取），遵循既有格式（评分明细表格、错因逐条分析、优点/不足/修改建议）；\n' +
      '2. 纵向对比：与档案中历史作文的得分、常见问题对比；\n' +
      '3. 横向对比：与同类维度（内容/表达/发展 或 内容覆盖/语言质量/结构连贯）对比；\n' +
      '4. 用 append_to_file 或 write_file 将新分析写入档案。';
  } else if (mode === 'score-predict') {
    sys +=
      '\n\n【角色：' + (studyHelper || '学习归纳帮手') + '】\n' +
      '任务：重新估算各科高考分数并更新 分数预测.md。\n' +
      '要求（务必省 token，不要整篇读取大档案）：\n' +
      '1. 先用 subject_summary 获取各科错题档案的紧凑摘要（错题数、最大题号、题号+标题、错因概览），再读取较小的 README.md、_sidebar.md 与 分数预测.md；\n' +
      '2. 仅当需要具体细节时才用 read_file_range 按行读取某科档案，绝不整篇 read_file 大档案；\n' +
      '3. 基于摘要统计各科错题数、作文数、错因分布与掌握程度；\n' +
      '4. 基于这些数据重新估算各科分数，保持 分数预测.md 既有结构与表格格式；\n' +
      '5. 更新统计概览与各科详细预测后，用 write_file 写回 分数预测.md（会请求用户确认）。';
  } else if (mode === 'learn-notes') {
    sys +=
      '\n\n【角色：学习规范归纳】\n' +
      '任务：回顾本次会话的编辑过程，若有可沉淀的新编辑规范/注意事项（编码、格式、流程、git、污染串等），追加写入 编辑注意事项.md。\n' +
      '若没有新的规范，回复说明「本次无需更新编辑注意事项」即可。';
  } else {
    sys += '\n\n【角色：学习助手】\n回答用户关于知识库、错题、复习计划、作文与分数预测的问题，可借助工具读写文件。';
  }

  if (draftOnly) {
    sys += '\n\n【草稿模式 · 重要】\n' +
      '本次仅生成 Markdown 草稿，禁止调用任何写入文件或 Git 的工具（只保留只读工具可用）。\n' +
      '请以纯文本返回一条完整的错题条目 Markdown，包含：#### 错题 N：标题、录入时间、来源、原题、错因分析、正确解法、答案、同类题变形。\n' +
      '题号 N 请基于 subject_summary 得到的该科最大题号 +1（或用 read_file_range 读取该科开头确认格式），不要整篇读取大档案。\n' +
      '不要输出任何多余解释或代码围栏，直接输出 Markdown 正文。';
  }

  sys += editingNotesBlock(notes);
  sys +=
    '\n\n【当前知识库文件清单提示】\n' +
    '总览 README.md、侧边栏 _sidebar.md、各科档案 语文.md/数学.md/英语.md/地理.md/历史.md/政治.md、分数预测.md、编辑注意事项.md。\n' +
    '错题条目格式（以数学为例）：#### 错题 N：标题，后接 - 录入时间 / - 来源 / 原题 / 错因分析 / 正确解法 / 答案 / 同类题变形。';
  return sys;
}

module.exports = { buildSystemPrompt };
