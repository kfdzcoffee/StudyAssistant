// ===== 错题助手 · 渲染进程逻辑 =====
(function () {
  'use strict';

  const api = window.api;
  const $ = (id) => document.getElementById(id);

  // ---------- 全局状态 ----------
  const state = {
    config: null,
    previewUrl: '',
    currentView: 'home',
    chatHistory: [],
    pendingConfirm: null,
    yesNoResolve: null,
    currentProc: null,
    didWrite: false,
    editorFile: null,
    imageBuf: null,
    ocrUsed: false,
    pendingQueue: [],
    records: [],
    focus: { running: false, start: 0, acc: 0, timer: null },
    examSel: new Map(),
    detailKey: '', detailFile: '', detailN: 0
  };

  // ---------- 工具函数 ----------
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms || 2600);
  }

  // 渲染 Markdown 到元素，并用 MathJax 排版数学公式（$...$ / $$...$$）
  function renderMd(el, text) {
    if (!el) return;
    el.innerHTML = window.Markdown.render(text || '');
    if (window.MathJax && MathJax.typesetPromise) {
      MathJax.typesetPromise([el]).catch(() => {});
    }
  }

  function md(htmlEl, text) {
    renderMd(htmlEl, text);
  }

  function now() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function addProc(el, text, kind) {
    if (!el) return null;
    const line = document.createElement('div');
    line.className = 'proc-line' + (kind ? ' ' + kind : '');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = now().slice(11);
    line.appendChild(t);
    const s = document.createElement('span');
    s.className = 'c';
    s.innerHTML = text;
    line.appendChild(s);
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    return line;
  }

  function setStatus(el, mode) {
    if (!el) return;
    el.className = 'status-dot' + (mode === 'busy' ? ' busy' : mode === 'done' ? ' done' : '');
  }

  // ---------- 视图切换 ----------
  const VIEW_TITLES = { home: '首页', chat: 'AI 助手', entry: '错题录入', essay: '作文分析', score: '分数预测', college: '目标院校', stats: '错题统计', archive: '档案编辑', git: 'Git 同步', preview: '网页预览', users: '用户', settings: '设置' };
  function switchView(name) {
    state.currentView = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    const t = $('tb-title'); if (t) t.textContent = VIEW_TITLES[name] || name;
    if (name === 'preview') loadPreview();
    if (name === 'archive') refreshTree();
    if (name === 'git') gitStatus();
    if (name === 'stats') loadStats();
    if (name === 'college') loadCollege();
    if (name === 'users') loadUsers();
    if (name === 'settings') loadGitConfig();
  }

  // ---------- 图片读取（可选 OCR / 编辑） ----------
  // opts: { ocrBtn, ocrAuto, target, editBtn } —— OCR 按钮 id / 自动OCR 复选框 id / 识别结果填入的文本框 id / 编辑按钮 id
  function bindImage(inputId, btnId, nameId, previewId, holder, opts) {
    $(btnId).addEventListener('click', () => $(inputId).click());
    if (opts && opts.ocrBtn) {
      $(opts.ocrBtn).addEventListener('click', () => runOcr(holder.imageBuf, opts.target, opts.ocrBtn));
    }
    if (opts && opts.editBtn) {
      $(opts.editBtn).addEventListener('click', () => {
        if (!holder.imageBuf) { toast('请先选择 / 拍照图片'); return; }
        openImageEditor(holder.imageBuf, (d) => {
          holder.imageBuf = d;
          state.ocrUsed = false; // 图片已变，原 OCR 文字失效
          const pv = $(previewId);
          if (pv) { pv.innerHTML = '<img src="' + d + '" />'; pv.classList.remove('hidden'); }
          toast('✅ 已应用编辑后的图片', 2000);
        });
      });
    }
    $(inputId).addEventListener('change', () => {
      const f = $(inputId).files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        holder.imageBuf = reader.result;
        state.ocrUsed = false; // 新图尚未 OCR
        $(nameId).textContent = f.name + '（已加载，将由视觉模型识别）';
        const pv = $(previewId);
        pv.innerHTML = '<img src="' + reader.result + '" />';
        pv.classList.remove('hidden');
        // 自动 OCR（可选）：勾选后上传即识别并填入文本框
        if (opts && opts.ocrAuto && $(opts.ocrAuto).checked && opts.target) {
          runOcr(holder.imageBuf, opts.target, opts.ocrBtn);
        }
      };
      reader.readAsDataURL(f);
    });
  }

  // ---------- OCR 识别（本地 Tesseract.js，无需 AI）----------
  const OCR_NOTE = '（用户选了OCR识别，识别误差较大，请在生成时合理推断内容，必要时提醒用户二次确认内容正误）';
  // 用 OCR 结果填充文本框：在内容最前面加上 OCR 说明标记（避免重复叠加）
  function fillWithOcr(ta, text) {
    if (!ta) return;
    let rest = ta.value || '';
    if (rest.startsWith(OCR_NOTE)) rest = rest.slice(OCR_NOTE.length);
    rest = rest.replace(/^\s*\n+/, '');
    ta.value = OCR_NOTE + '\n' + (rest ? rest + '\n' : '') + (text || '');
  }
  // 图片预处理：灰度 + 自动对比度拉伸，可显著提升本地 OCR 对照片的识别精度
  function preprocessForOcr(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          let w = img.naturalWidth, h = img.naturalHeight;
          const cap = 2400;
          const scale = Math.min(1, cap / w, cap / h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          const d = imageData.data;
          let min = 255, max = 0;
          for (let i = 0; i < d.length; i += 4) {
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            if (lum < min) min = lum;
            if (lum > max) max = lum;
          }
          const range = (max - min) || 1;
          for (let i = 0; i < d.length; i += 4) {
            const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = Math.round(255 * (lum - min) / range);
            d[i] = v; d[i + 1] = v; d[i + 2] = v;
          }
          ctx.putImageData(imageData, 0, 0);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl); // 预处理失败则用原图
      img.src = dataUrl;
    });
  }
  async function runOcr(dataUrl, targetTextareaId, btnId) {
    const btn = btnId ? $(btnId) : null;
    if (!dataUrl) { toast('请先选择 / 拍照图片'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '📝 OCR 识别中…'; }
    try {
      // 预处理（灰度 + 自动对比度）后交给本地引擎，提升精度
      const processed = await preprocessForOcr(dataUrl);
      const r = await api.ai.ocrLocal(processed);
      if (r.ok && r.text) {
        const ta = targetTextareaId ? $(targetTextareaId) : null;
        fillWithOcr(ta, r.text);
        state.ocrUsed = true; // 内容已由 OCR 提取，提交时不再附图片
        toast('✅ 本地 OCR 完成，已在内容前标注「OCR 识别」，生成时会提醒核对', 3200);
      } else {
        toast('OCR 失败：' + (r.message || '未知错误'), 4000);
      }
    } catch (e) {
      toast('OCR 失败：' + (e.message || '未知错误'), 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📝 OCR 识别文字'; }
    }
  }

  // ---------- 图片编辑（旋转 / 框选） ----------
  const imgEdit = { image: null, angle: 0, scale: 1, crop: null, mode: false, drag: null, onApply: null };
  function setImgEditStatus(msg) { const s = $('img-edit-status'); if (s) s.textContent = msg; }
  function imgEditAngleDisplay() {
    const v = imgEdit.angle > 180 ? imgEdit.angle - 360 : imgEdit.angle;
    $('img-rot-slider').value = v;
    $('img-rot-val').textContent = v + '°';
  }
  function drawImgEditor() {
    const img = imgEdit.image;
    if (!img) return;
    const angle = imgEdit.angle;
    const rad = angle * Math.PI / 180;
    const w = img.naturalWidth, h = img.naturalHeight;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const rotW = Math.round(w * cos + h * sin);
    const rotH = Math.round(w * sin + h * cos);
    const maxW = 600, maxH = 420;
    imgEdit.scale = Math.min(1, maxW / rotW, maxH / rotH);
    const canvas = $('img-edit-canvas');
    canvas.width = Math.max(1, Math.round(rotW * imgEdit.scale));
    canvas.height = Math.max(1, Math.round(rotH * imgEdit.scale));
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0a0f1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(img, -w * imgEdit.scale / 2, -h * imgEdit.scale / 2, w * imgEdit.scale, h * imgEdit.scale);
    ctx.restore();
    if (imgEdit.crop) {
      const r = imgEdit.crop;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.clearRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = '#22c55e';
      ctx.lineWidth = 2;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      for (let i = 1; i < 3; i++) {
        ctx.beginPath(); ctx.moveTo(r.x + r.w * i / 3, r.y); ctx.lineTo(r.x + r.w * i / 3, r.y + r.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(r.x, r.y + r.h * i / 3); ctx.lineTo(r.x + r.w, r.y + r.h * i / 3); ctx.stroke();
      }
      ctx.setLineDash([]);
    }
  }
  function openImageEditor(dataUrl, onApply) {
    const img = new Image();
    img.onload = () => {
      imgEdit.image = img; imgEdit.angle = 0; imgEdit.crop = null; imgEdit.mode = false; imgEdit.drag = null; imgEdit.onApply = onApply;
      $('img-crop-toggle').classList.remove('active');
      imgEditAngleDisplay();
      setImgEditStatus('点「🎯 框选」后在图片上拖拽，仅保留框内区域；或直接「✅ 应用图片」。');
      drawImgEditor();
      $('img-edit-modal').classList.remove('hidden');
    };
    img.src = dataUrl;
  }
  function closeImgEditor() {
    $('img-edit-modal').classList.add('hidden');
    imgEdit.image = null; imgEdit.onApply = null;
  }
  $('img-edit-close').addEventListener('click', closeImgEditor);
  $('img-edit-cancel').addEventListener('click', closeImgEditor);
  $('img-rot-left').addEventListener('click', () => { imgEdit.angle = (imgEdit.angle - 90 + 360) % 360; imgEditAngleDisplay(); drawImgEditor(); });
  $('img-rot-right').addEventListener('click', () => { imgEdit.angle = (imgEdit.angle + 90) % 360; imgEditAngleDisplay(); drawImgEditor(); });
  $('img-rot-slider').addEventListener('input', () => {
    imgEdit.angle = (Number($('img-rot-slider').value) + 360) % 360;
    imgEditAngleDisplay();
    drawImgEditor();
  });
  $('img-crop-toggle').addEventListener('click', () => {
    imgEdit.mode = !imgEdit.mode;
    if (!imgEdit.mode) imgEdit.crop = null;
    $('img-crop-toggle').classList.toggle('active', imgEdit.mode);
    setImgEditStatus(imgEdit.mode ? '🖱 在图片上拖拽画出选区（仅保留框内区域）' : '已退出框选模式');
    drawImgEditor();
  });
  $('img-reset').addEventListener('click', () => {
    imgEdit.angle = 0; imgEdit.crop = null; imgEdit.mode = false;
    $('img-crop-toggle').classList.remove('active');
    imgEditAngleDisplay();
    setImgEditStatus('已重置');
    drawImgEditor();
  });
  (function bindImgEditCrop() {
    const canvas = $('img-edit-canvas');
    canvas.addEventListener('mousedown', (e) => {
      if (!imgEdit.mode || !imgEdit.image) return;
      const rect = canvas.getBoundingClientRect();
      imgEdit.drag = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    });
    canvas.addEventListener('mousemove', (e) => {
      if (!imgEdit.drag) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const sx = imgEdit.drag.x, sy = imgEdit.drag.y;
      imgEdit.crop = {
        x: Math.max(0, Math.round(Math.min(sx, x))),
        y: Math.max(0, Math.round(Math.min(sy, y))),
        w: Math.round(Math.abs(x - sx)),
        h: Math.round(Math.abs(y - sy))
      };
      drawImgEditor();
    });
    window.addEventListener('mouseup', () => { imgEdit.drag = null; });
  })();
  $('img-edit-apply').addEventListener('click', () => {
    const img = imgEdit.image;
    if (!img) return;
    const angle = imgEdit.angle;
    const rad = angle * Math.PI / 180;
    const w = img.naturalWidth, h = img.naturalHeight;
    const cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
    const rotW = Math.round(w * cos + h * sin);
    const rotH = Math.round(w * sin + h * cos);
    // 全分辨率旋转画布
    const rot = document.createElement('canvas');
    rot.width = rotW; rot.height = rotH;
    const rctx = rot.getContext('2d');
    rctx.fillStyle = '#fff';
    rctx.fillRect(0, 0, rotW, rotH);
    rctx.translate(rotW / 2, rotH / 2);
    rctx.rotate(rad);
    rctx.drawImage(img, -w / 2, -h / 2);
    // 若有选区则裁剪
    let sx = 0, sy = 0, sw = rotW, sh = rotH;
    if (imgEdit.crop && imgEdit.crop.w > 2 && imgEdit.crop.h > 2) {
      const s = imgEdit.scale;
      sx = Math.max(0, Math.round(imgEdit.crop.x / s));
      sy = Math.max(0, Math.round(imgEdit.crop.y / s));
      sw = Math.max(1, Math.min(rotW - sx, Math.round(imgEdit.crop.w / s)));
      sh = Math.max(1, Math.min(rotH - sy, Math.round(imgEdit.crop.h / s)));
    }
    const out = document.createElement('canvas');
    out.width = sw; out.height = sh;
    const octx = out.getContext('2d');
    octx.fillStyle = '#fff';
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(rot, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL('image/jpeg', 0.92);
    const cb = imgEdit.onApply;
    closeImgEditor();
    if (cb) cb(dataUrl);
  });

  // ---------- AI 任务执行 ----------
  function buildUserParts(text, imageBuf) {
    const parts = [];
    if (imageBuf) parts.push({ type: 'image_url', image_url: { url: imageBuf } });
    if (text && text.trim()) parts.push({ type: 'text', text: text.trim() });
    return parts;
  }

  async function runTask({ mode, text, imageBuf, procEl, resultEl, statusEl, extra, draftOnly }) {
    if (procEl) procEl.innerHTML = '';
    if (resultEl) resultEl.innerHTML = '';
    state.currentProc = procEl;
    state.didWrite = false;
    setStatus(statusEl, 'busy');

    // 若已用 OCR 提取文字，则不再把图片发给 AI（避免触发「所选模型不支持图片识别」）
    const effImage = (state.ocrUsed && imageBuf) ? null : imageBuf;
    const parts = buildUserParts(text, effImage);
    if (parts.length === 0) { toast('请输入内容'); setStatus(statusEl, ''); return null; }

    const providerId = pickProvider();
    const messages = [];
    if (mode === 'chat') {
      state.chatHistory.push({ role: 'user', content: parts });
      messages.push(...state.chatHistory);
    } else {
      messages.push({ role: 'user', content: parts });
    }

    const res = await api.ai.runTask({ mode, providerId, messages, hasImage: !!effImage, extra, draftOnly: !!draftOnly });
    if (mode === 'chat') state.chatHistory.push({ role: 'assistant', content: res.content });

    setStatus(statusEl, 'done');
    if (res.ok) {
      if (resultEl) md(resultEl, res.content);
      renderPostGit(res, mode, resultEl);
    } else {
      if (resultEl) resultEl.innerHTML = '<div class="proc-line err">✘ ' + escapeHtml(res.message) + '</div>';
      toast('任务失败：' + res.message, 4000);
    }
    if (mode !== 'chat' && resultEl) switchDone(resultEl);
    // 写文件后刷新首页题目统计
    if (res.ok && state.didWrite && mode !== 'chat') {
      api.site.refreshStats().catch(() => {});
    }
    return res;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderPostGit(res, mode, resultEl) {
    if (!res.ok) return;
    if (state.didWrite && resultEl) {
      const wrap = document.createElement('div');
      wrap.className = 'post-btns';
      const btn = document.createElement('button');
      btn.className = 'btn-primary';
      btn.textContent = '🔁 是否上传 GitHub？';
      btn.addEventListener('click', gitFlowAuto);
      wrap.appendChild(btn);
      resultEl.appendChild(wrap);
    }
  }

  function switchDone(el) { /* placeholder 便于扩展 */ }

  function pickProvider() {
    const cfg = state.config;
    const list = Object.values(cfg.providers).filter((p) => p.enabled && p.apiKey);
    if (list.length === 0) return cfg.activeProvider || 'deepseek';
    const active = cfg.providers[cfg.activeProvider];
    if (active && active.enabled && active.apiKey) return active.id;
    return list[0].id;
  }

  // ---------- Git 流程 ----------
  async function gitFlowAuto() {
    const ok = await askYesNo(
      '确认将本次修改上传到 GitHub？\n将依次执行：git clean（rm -r --cached + add -A）→ commit（修改内容 - 日期）→ push（失败重试3次）'
    );
    if (!ok) return;
    addProc(state.currentProc, '▶ 开始 git clean …', 'ok');
    const clean = await api.git.clean();
    if (!clean.ok) { toast('clean 失败：' + clean.message, 4000); return; }
    const msg = '修改内容 - ' + new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
    const cm = await api.git.commit(msg);
    if (!cm.ok) { toast('commit 失败：' + cm.message, 4000); return; }
    if (cm.skipped) { toast('无变更，无需推送'); return; }
    addProc(state.currentProc, '▶ commit: ' + cm.message, 'ok');
    const push = await api.git.push();
    if (push.ok) { toast('✅ 已推送到 GitHub'); addProc(state.currentProc, '✅ push 成功', 'ok'); }
    else { toast('❌ push 失败：' + push.message, 5000); addProc(state.currentProc, '✘ push 失败：' + push.message, 'err'); }
    gitStatus();
  }

  // ---------- 确认门（AI 变更操作） ----------
  api.app.onConfirmRequest((req) => {
    state.pendingConfirm = req;
    showConfirm(req);
  });

  function showConfirm(req) {
    $('confirm-tool').textContent = '🔧 ' + req.tool + (req.target ? '  →  ' + req.target : '');
    $('confirm-summary').textContent = req.summary || 'AI 请求执行以下操作';
    const diffEl = $('confirm-diff');
    diffEl.innerHTML = '';
    if (req.oldContent == null && req.newContent) {
      diffEl.innerHTML = '<div class="diff-line add">＋（新文件）</div>';
    } else {
      renderDiff(diffEl, req.oldContent || '', req.newContent || '');
    }
    $('confirm-modal').classList.remove('hidden');
  }

  function lineDiff(a, b) {
    const A = (a || '').split('\n');
    const B = (b || '').split('\n');
    const n = A.length, m = B.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: 'ctx', s: A[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: A[i] }); i++; }
      else { out.push({ t: 'add', s: B[j] }); j++; }
    }
    while (i < n) out.push({ t: 'del', s: A[i++] });
    while (j < m) out.push({ t: 'add', s: B[j++] });
    return out;
  }

  function renderDiff(el, a, b) {
    const lines = lineDiff(a, b);
    let ctx = 0;
    lines.forEach((l) => {
      if (l.t === 'ctx') {
        ctx++;
        if (ctx > 60) return; // 折叠过长上下文
        const d = document.createElement('div');
        d.className = 'diff-line ctx';
        d.textContent = l.s;
        el.appendChild(d);
      } else {
        ctx = 0;
        const d = document.createElement('div');
        d.className = 'diff-line ' + l.t;
        d.textContent = (l.t === 'add' ? '＋ ' : '－ ') + l.s;
        el.appendChild(d);
      }
    });
    if (ctx > 60) {
      const s = document.createElement('div');
      s.className = 'diff-sep';
      s.textContent = '……（上下文过长已折叠）……';
      el.appendChild(s);
    }
  }

  function hideConfirm() {
    $('confirm-modal').classList.add('hidden');
    state.pendingConfirm = null;
  }

  $('confirm-approve').addEventListener('click', () => {
    if (state.yesNoResolve) {
      state.yesNoResolve(true); state.yesNoResolve = null; hideConfirm(); return;
    }
    const r = state.pendingConfirm;
    hideConfirm();
    if (r) api.app.confirmResponse(r.id, true);
  });
  $('confirm-reject').addEventListener('click', () => {
    if (state.yesNoResolve) {
      state.yesNoResolve(false); state.yesNoResolve = null; hideConfirm(); return;
    }
    const r = state.pendingConfirm;
    hideConfirm();
    if (r) api.app.confirmResponse(r.id, false);
  });
  $('confirm-cancel-x').addEventListener('click', () => {
    if (state.yesNoResolve) { state.yesNoResolve(false); state.yesNoResolve = null; }
    const r = state.pendingConfirm;
    hideConfirm();
    if (r) api.app.confirmResponse(r.id, false);
  });

  // ---------- AI 提问（ask_user：二次确认 / 补充信息） ----------
  let askId = null;
  api.app.onAskRequest((req) => {
    askId = req.id;
    $('ask-question').textContent = req.question || '';
    const opts = $('ask-options');
    opts.innerHTML = '';
    (req.options || []).forEach((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-outline ask-opt';
      b.textContent = o;
      b.addEventListener('click', () => { $('ask-input').value = o; $('ask-input').focus(); });
      opts.appendChild(b);
    });
    $('ask-input').value = '';
    $('ask-modal').classList.remove('hidden');
    $('ask-input').focus();
  });
  function askAnswer(value) {
    if (askId == null) return;
    const id = askId;
    askId = null;
    $('ask-modal').classList.add('hidden');
    api.app.askResponse(id, value === '' || value == null ? null : value);
  }
  $('ask-ok').addEventListener('click', () => askAnswer($('ask-input').value.trim()));
  $('ask-cancel').addEventListener('click', () => askAnswer(null));
  $('ask-close').addEventListener('click', () => askAnswer(null));
  $('ask-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('ask-ok').click(); } });

  function askYesNo(text) {
    return new Promise((resolve) => {
      state.yesNoResolve = resolve;
      $('confirm-tool').textContent = '❓ 确认操作';
      $('confirm-summary').textContent = text;
      const d = $('confirm-diff');
      d.innerHTML = '<div class="hint">该操作由你主动发起，确认后将自动依次执行。</div>';
      $('confirm-approve').textContent = '确认执行';
      $('confirm-reject').textContent = '取消';
      $('confirm-modal').classList.remove('hidden');
    });
  }
  // 恢复按钮文案
  const approveBtn = $('confirm-approve');
  const rejectBtn = $('confirm-reject');

  // ---------- Agent 事件 ----------
  let thinkTimer = null;
  let thinkEl = null;
  function stopThinkTimer() {
    if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
    thinkEl = null;
  }
  function startThinkTimer(p) {
    stopThinkTimer();
    const line = addProc(p, '<span class="toolname">…</span> 思考中…');
    if (!line) return;
    const sEl = line.querySelector('.c');
    const t0 = Date.now();
    thinkEl = sEl;
    thinkTimer = setInterval(() => {
      if (thinkEl) {
        const sec = Math.floor((Date.now() - t0) / 1000);
        thinkEl.textContent = '思考中…（已等待 ' + sec + ' 秒）';
      }
    }, 1000);
  }
  api.app.onAgentEvent((ev) => {
    // Token 消耗预警与当前任务无关，独立处理
    if (ev.type === 'token-warning') { showTokenWarning(ev); }
    const p = state.currentProc;
    if (!p) return;
    if (ev.type === 'thinking') { startThinkTimer(p); return; }
    stopThinkTimer();
    if (ev.type === 'tool-start') addProc(p, '🔧 调用 <span class="toolname">' + escapeHtml(ev.name) + '</span>');
    if (ev.type === 'tool-end') {
      if (['write_file', 'append_to_file', 'create_subject', 'git_clean', 'git_commit', 'git_push'].indexOf(ev.name) !== -1 && ev.ok && ev.result && !ev.result.cancelled) {
        state.didWrite = true;
      }
      addProc(p, ev.ok ? '✔ ' + escapeHtml(ev.name) + ' 完成' : '✘ ' + escapeHtml(ev.name) + ' 未执行', ev.ok ? 'ok' : 'err');
    }
    if (ev.type === 'error') addProc(p, '✘ ' + escapeHtml(ev.message), 'err');
    if (ev.type === 'done') addProc(p, '✔ 完成', 'ok');
    if (ev.type === 'open-file') { openInEditor(ev.path); switchView('archive'); }
    if (ev.type === 'preview') { navPreview(ev.path); switchView('preview'); }
  });

  // ---------- Token 消耗预警 ----------
  function showTokenWarning(ev) {
    const total = Number(ev.total || 0).toLocaleString();
    const threshold = Number(ev.threshold || 0).toLocaleString();
    const s = $('token-warn-summary');
    if (s) s.textContent = '今日（' + (ev.today || '') + '）AI 调用 Token 消耗已达 ' + total + '，已超过预警阈值 ' + threshold + '。\n\n请留意今日用量，避免超出额度产生额外费用；可到「设置 → Token 消耗预警」调整阈值。';
    $('token-warn-modal').classList.remove('hidden');
    loadTokenUsage();
  }
  $('token-warn-ok').addEventListener('click', () => $('token-warn-modal').classList.add('hidden'));
  $('token-warn-close').addEventListener('click', () => $('token-warn-modal').classList.add('hidden'));

  // 刷新设置页「今日 Token 消耗」显示
  async function loadTokenUsage() {
    try {
      const r = await api.app.getTokenUsage();
      const el = $('token-today');
      if (el) el.textContent = (r && r.total ? Number(r.total).toLocaleString() : '0');
    } catch (e) { /* 忽略 */ }
  }

  // ---------- 首页：鸡汤 ----------
  const QUOTES = [
    { emoji: '💪', text: '不积跬步，无以至千里；不积小流，无以成江海。' },
    { emoji: '🌱', text: '把每一天当作最后冲刺的一天，全力以赴，不留遗憾。' },
    { emoji: '📚', text: '好好学习，天天向上。今天的努力，是明天的底气。' },
    { emoji: '🚀', text: '乾坤未定，你我皆是黑马。' },
    { emoji: '🧗', text: '那些看似不起波澜的日复一日，会在某天让你看到坚持的意义。' },
    { emoji: '🔥', text: '关关难过关关过，前路漫漫亦灿灿。' },
    { emoji: '🌟', text: '你背过的每一个单词、算过的每一道题，都不会辜负你。' },
    { emoji: '⛰️', text: '星光不问赶路人，时光不负有心人。' },
    { emoji: '✊', text: '现在流的每一滴汗，都是给未来铺的路；现在偷的每一个懒，都是给未来挖的坑。' },
    { emoji: '🎯', text: '心之所向，素履以往；生如逆旅，一苇以航。' }
  ];
  let quoteIdx = -1;
  function renderQuote() {
    if (quoteIdx < 0) {
      const d = new Date();
      quoteIdx = (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) % QUOTES.length;
    }
    const q = QUOTES[quoteIdx];
    $('quote-emoji').textContent = q.emoji;
    $('home-quote').textContent = q.text;
  }
  $('quote-refresh').addEventListener('click', () => {
    quoteIdx = (quoteIdx + 1) % QUOTES.length;
    const q = QUOTES[quoteIdx];
    $('quote-emoji').textContent = q.emoji;
    $('home-quote').textContent = q.text;
  });

  // ---------- 首页：高考/中考/自定义 倒计时 ----------
  function toggleExamNameField(selId, fieldId) {
    const sel = $(selId), field = $(fieldId);
    if (!sel || !field) return;
    field.style.display = sel.value === 'custom' ? '' : 'none';
  }
  function examInfo() {
    const ex = (state.config && state.config.exam) || {};
    const type = ex.type || 'gaokao';
    const year = Number(ex.year) || 2027;
    let name;
    if (type === 'custom') name = String(ex.name || '').trim() || '考试';
    else name = type === 'zhongkao' ? '中考' : '高考';
    const month = Number(ex.month) || 6;
    const day = Number(ex.day) || (type === 'zhongkao' ? 24 : 7);
    const target = new Date(year, month - 1, day, 0, 0, 0);
    return { year, name, target, month, day };
  }
  function updateCountdown() {
    const { year, name, target } = examInfo();
    const now = new Date();
    const diff = target - now;
    const days = Math.ceil(diff / 86400000);
    $('cd-label').textContent = '距离 ' + year + ' 年' + name;
    if (days > 0) {
      $('cd-num').textContent = String(days);
      $('cd-unit').textContent = '天';
      $('cd-date').textContent = name + '日期：' + target.getFullYear() + ' 年 ' + (target.getMonth() + 1) + ' 月 ' + target.getDate() + ' 日';
    } else if (days === 0) {
      $('cd-num').textContent = '今天';
      $('cd-unit').textContent = name + '！';
      $('cd-date').textContent = '';
    } else {
      $('cd-num').textContent = '--';
      $('cd-unit').textContent = '已结束';
      $('cd-date').textContent = year + ' 年' + name + ' 已结束';
    }
  }

  // ---------- 翻页式时钟 ----------
  function buildFlipClock(container) {
    const wrap = $(container);
    wrap.innerHTML = '';
    const cells = [];
    const addCell = () => {
      const c = document.createElement('div');
      c.className = 'fc';
      c.innerHTML = '<div class="half top"><div class="num">0</div></div>' +
        '<div class="half bot"><div class="num">0</div></div>' +
        '<div class="flap"><div class="num">0</div></div>' +
        '<div class="fold"></div>';
      wrap.appendChild(c);
      cells.push(c);
    };
    const addSep = () => {
      const s = document.createElement('div');
      s.className = 'fc-sep';
      s.textContent = ':';
      wrap.appendChild(s);
    };
    for (let i = 0; i < 2; i++) addCell(); addSep();
    for (let i = 0; i < 2; i++) addCell(); addSep();
    for (let i = 0; i < 2; i++) addCell();
    const setNum = (cell, v) => {
      const ch = String(v).slice(-1);
      cell.querySelectorAll('.half .num').forEach((n) => (n.textContent = ch));
    };
    const set = (h, m, s) => {
      const str = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0');
      for (let i = 0; i < 6; i++) {
        const cell = cells[i];
        const prev = cell.querySelector('.half.top .num').textContent;
        const nv = str[i];
        if (prev !== nv) {
          cell.querySelector('.flap .num').textContent = nv;
          cell.classList.remove('flipping');
          void cell.offsetWidth;
          cell.classList.add('flipping');
          setTimeout(() => { setNum(cell, nv); cell.classList.remove('flipping'); }, 430);
        }
      }
    };
    const setAll = (h, m, s) => {
      const str = String(h).padStart(2, '0') + String(m).padStart(2, '0') + String(s).padStart(2, '0');
      for (let i = 0; i < 6; i++) setNum(cells[i], str[i]);
    };
    return { set, setAll };
  }

  // ---------- 专注计时 ----------
  const focusClock = { main: null, big: null };
  function focusElapsed() {
    const f = state.focus;
    return f.acc + (f.running ? Date.now() - f.start : 0);
  }
  function fmtHMS(ms) {
    const total = Math.floor(ms / 1000);
    return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
  }
  function fmtDur(ms) {
    const { h, m, s } = fmtHMS(ms);
    return (h ? h + ' 小时 ' : '') + (m ? m + ' 分 ' : '') + s + ' 秒';
  }
  function focusRender() {
    const { h, m, s } = fmtHMS(focusElapsed());
    if (focusClock.main) focusClock.main.set(h, m, s);
    if (focusClock.big) focusClock.big.set(h, m, s);
    $('focus-info').textContent = state.focus.running ? '⏳ 专注中…' : (state.focus.acc ? '⏸ 已暂停' : '尚未开始');
    const fi = $('fs-info');
    if (fi) fi.textContent = state.focus.running ? '加油，保持专注！' : '当前时长：' + fmtDur(focusElapsed());
  }
  function focusPauseSafe() {
    if (state.focus.running) {
      state.focus.acc += Date.now() - state.focus.start;
      state.focus.running = false;
      clearInterval(state.focus.timer);
      state.focus.timer = null;
    }
  }
  function focusStart() {
    if (state.focus.running) return;
    state.focus.running = true;
    state.focus.start = Date.now();
    state.focus.timer = setInterval(focusRender, 200);
    toast('🍀 专注开始，加油！');
    focusRender();
  }
  function focusPause() {
    if (!state.focus.running) return;
    focusPauseSafe();
    focusRender();
  }
  function focusReset() {
    focusPauseSafe();
    state.focus.acc = 0;
    focusRender();
  }
  async function focusRecord() {
    const el = focusElapsed();
    if (el < 3000) { toast('时长过短，未记录'); focusReset(); return; }
    focusPauseSafe();
    const rec = { date: now(), seconds: Math.round(el / 1000) };
    state.records = await api.records.add(rec);
    renderRecords();
    toast('✅ 已记录专注 ' + fmtDur(el));
    focusReset();
  }
  async function renderRecords() {
    const list = $('focus-records');
    if (!list) return;
    list.innerHTML = '';
    if (!Array.isArray(state.records)) state.records = [];
    if (!state.records.length) { list.innerHTML = '<div class="hint">暂无记录</div>'; $('focus-summary').textContent = ''; return; }
    const today = now().slice(0, 10);
    let todaySec = 0, totalSec = 0;
    state.records.forEach((r) => { totalSec += r.seconds || 0; if ((r.date || '').slice(0, 10) === today) todaySec += r.seconds || 0; });
    $('focus-summary').textContent = '今日 ' + fmtDur(todaySec * 1000) + ' · 累计 ' + fmtDur(totalSec * 1000) + ' · 共 ' + state.records.length + ' 次';
    state.records.slice(-15).reverse().forEach((r) => {
      const id = r && r.id;
      const d = document.createElement('div');
      d.className = 'rec-item';
      const inner = document.createElement('div');
      inner.className = 'rdur';
      inner.innerHTML = '<span class="d">' + escapeHtml(r.date || '') + '</span><span>' + fmtDur((r.seconds || 0) * 1000) + '</span>';
      const del = document.createElement('button');
      del.className = 'rec-del';
      del.textContent = '✕';
      del.title = '删除此记录（不可恢复）';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await askYesNo('删除这条专注记录？\n此操作不可恢复！'))) return;
        state.records = await api.records.del(id);
        renderRecords();
        toast('已删除该专注记录');
      });
      d.appendChild(inner);
      d.appendChild(del);
      list.appendChild(d);
    });
  }
  $('focus-clear').addEventListener('click', async () => {
    if (!state.records || !state.records.length) { toast('暂无专注记录'); return; }
    if (!(await askYesNo('清空全部专注记录？\n此操作不可恢复！'))) return;
    state.records = await api.records.clear();
    renderRecords();
    toast('已清空全部专注记录');
  });
  $('focus-start').addEventListener('click', focusStart);
  $('focus-pause').addEventListener('click', focusPause);
  $('focus-reset').addEventListener('click', async () => { if (await askYesNo('确定重置本次计时？')) focusReset(); });
  $('focus-record').addEventListener('click', focusRecord);
  $('focus-enlarge').addEventListener('click', () => { $('focus-fullscreen').classList.remove('hidden'); });
  $('fs-close').addEventListener('click', () => { $('focus-fullscreen').classList.add('hidden'); });

  // ---------- 聊天 ----------
  function chatAddMsg(role, text) {
    const log = $('chat-log');
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'ai') {
      const body = document.createElement('div');
      body.className = 'md-body';
      renderMd(body, text);
      div.appendChild(body);
    } else {
      div.textContent = text;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  $('chat-send').addEventListener('click', async () => {
    const text = $('chat-input').value.trim();
    const imageBuf = state.imageBuf;
    if (!text && !imageBuf) return;
    chatAddMsg('user', text || '【附图】');
    $('chat-input').value = '';
    const mode = $('chat-mode').value;
    const proc = document.createElement('div');
    proc.className = 'proc-log';
    $('chat-log').appendChild(proc);
    state.currentProc = proc;
    state.didWrite = false;
    // 已用 OCR 则不再附图片
    const effImg = state.ocrUsed ? null : imageBuf;
    const res = await api.ai.runTask({
      mode, providerId: pickProvider(), hasImage: !!effImg,
      messages: [{ role: 'user', content: buildUserParts(text, effImg) }]
    });
    if (res.ok) chatAddMsg('ai', res.content);
    else chatAddMsg('ai', '⚠️ ' + res.message);
    if (state.didWrite) {
      const wrap = document.createElement('div');
      wrap.className = 'post-btns';
      const b = document.createElement('button');
      b.className = 'btn-primary';
      b.textContent = '🔁 是否上传 GitHub？';
      b.addEventListener('click', gitFlowAuto);
      wrap.appendChild(b);
      $('chat-log').appendChild(wrap);
    }
    state.imageBuf = null;
    $('chat-img').value = '';
  });
  $('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('chat-send').click(); }
  });

  // 聊天附图（可选 OCR / 编辑）
  $('chat-attach').addEventListener('change', (e) => { if (e.target.checked) $('chat-img').click(); });
  $('chat-ocr').addEventListener('click', () => runOcr(state.imageBuf, 'chat-input', 'chat-ocr'));
  $('chat-img-edit').addEventListener('click', () => {
    if (!state.imageBuf) { toast('请先选择 / 拍照图片'); return; }
    openImageEditor(state.imageBuf, (d) => {
      state.imageBuf = d;
      state.ocrUsed = false; // 图片已变
      const pv = $('chat-img-preview');
      if (pv) { pv.innerHTML = '<img src="' + d + '" />'; pv.classList.remove('hidden'); }
      toast('✅ 已应用编辑后的图片', 2000);
    });
  });
  $('chat-img').addEventListener('change', () => {
    const f = $('chat-img').files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      state.imageBuf = r.result;
      state.ocrUsed = false; // 新图尚未 OCR
      toast('已附加图片，将由视觉模型识别');
      const pv = $('chat-img-preview');
      if (pv) { pv.innerHTML = '<img src="' + r.result + '" />'; pv.classList.remove('hidden'); }
      if ($('chat-ocr-auto').checked) runOcr(state.imageBuf, 'chat-input', 'chat-ocr');
    };
    r.readAsDataURL(f);
  });

  // ---------- 错题录入 ----------
  $('entry-date').value = new Date().toISOString().slice(0, 10);
  bindImage('entry-img', 'entry-img-btn', 'entry-img-name', 'entry-img-preview', state,
    { ocrBtn: 'entry-ocr', ocrAuto: 'entry-ocr-auto', target: 'entry-question', editBtn: 'entry-img-edit' });
  $('entry-subject').addEventListener('change', () => {
    $('entry-newsubj-field').style.display = $('entry-subject').value === '其他（新建科目）' ? '' : 'none';
  });
  function entrySubject() {
    const s = $('entry-subject').value;
    if (s === '其他（新建科目）') return $('entry-newsubj').value.trim() || '新科目';
    return s;
  }
  function buildEntryText() {
    const subject = entrySubject();
    const source = $('entry-source').value.trim();
    const date = $('entry-date').value;
    const question = $('entry-question').value.trim();
    const answer = $('entry-answer').value.trim();
    let text = '科目：' + subject + '\n';
    if (source) text += '来源：' + source + '\n';
    text += '录入日期：' + date + '\n';
    text += (question ? '题目：\n' + question : '（题目以附图为准）') + '\n';
    if (answer) text += '我的作答：\n' + answer + '\n';
    text += '\n请按知识库格式整理。';
    return { subject, text };
  }
  // 加入待录入区（草稿模式：AI 只生成 markdown，不写文件）
  $('entry-draft').addEventListener('click', async () => {
    const { subject, text } = buildEntryText();
    if (!text) { toast('请填写题目内容'); return; }
    const res = await runTask({
      mode: 'error-entry', text, imageBuf: state.imageBuf, draftOnly: true,
      procEl: $('entry-proc'), resultEl: $('entry-result'), statusEl: $('entry-status')
    });
    state.imageBuf = null;
    if (res && res.ok && res.content) {
      await addToQueue(res.content, subject);
      toast('📥 已加入待录入区');
    }
  });
  // 直接整理并录入（AI 写文件，每步需确认）
  $('entry-submit').addEventListener('click', () => {
    const { subject, text } = buildEntryText();
    if (!text) { toast('请填写题目内容'); return; }
    runTask({
      mode: 'error-entry', text, imageBuf: state.imageBuf,
      procEl: $('entry-proc'), resultEl: $('entry-result'), statusEl: $('entry-status')
    });
    state.imageBuf = null;
  });
  $('entry-clear').addEventListener('click', () => {
    ['entry-question', 'entry-answer', 'entry-source'].forEach((i) => $(i).value = '');
    $('entry-img').value = '';
    $('entry-img-name').textContent = '';
    $('entry-img-preview').classList.add('hidden');
    state.ocrUsed = false;
    state.imageBuf = null;
  });
  $('entry-git').addEventListener('click', gitFlowAuto);

  // ---------- 手动录入（不经 AI，直接写知识库） ----------
  function manualSubject() {
    const s = $('manual-subject').value;
    if (s === '其他（新建科目）') return $('manual-newsubj').value.trim() || '新科目';
    return s;
  }
  $('manual-subject').addEventListener('change', () => {
    $('manual-newsubj-field').style.display = $('manual-subject').value === '其他（新建科目）' ? '' : 'none';
  });
  $('entry-manual').addEventListener('click', () => {
    $('manual-date').value = new Date().toISOString().slice(0, 10);
    $('manual-status').textContent = '';
    $('manual-preview').innerHTML = '<span class="hint">填写后点「👁 预览」或直接「💾 写入错题库」。</span>';
    $('manual-modal').classList.remove('hidden');
    $('manual-title').focus();
  });
  $('manual-close').addEventListener('click', () => $('manual-modal').classList.add('hidden'));
  $('manual-cancel').addEventListener('click', () => $('manual-modal').classList.add('hidden'));

  function fmtManualDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return dateStr;
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 组装与知识库一致的错题条目 Markdown
  function buildManualEntry(f) {
    const L = [];
    L.push('#### 错题 ' + f.n + '：' + (f.title || '未命名'));
    L.push('');
    if (f.date) L.push('- **录入时间**：' + f.date);
    if (f.source) L.push('- **来源**：' + f.source);
    if (f.question) L.push('- **原题**：' + f.question);
    L.push('');
    if (f.reason) { L.push('**错因分析**：'); L.push(''); L.push(f.reason); L.push(''); }
    if (f.solution) { L.push('**正确解法**：'); L.push(''); L.push(f.solution); L.push(''); }
    if (f.answer) { L.push('**答案**：' + f.answer); L.push(''); }
    if (f.tip) { L.push('> ⚠️ 关键技巧：' + f.tip); L.push(''); }
    if (f.similar) { L.push('---'); L.push(''); L.push('**同类题变形**（巩固）：'); L.push(''); L.push(f.similar); L.push(''); }
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function manualCollect() {
    return {
      subject: manualSubject(),
      title: $('manual-title').value.trim(),
      date: fmtManualDate($('manual-date').value),
      source: $('manual-source').value.trim(),
      question: $('manual-question').value.trim(),
      reason: $('manual-reason').value.trim(),
      solution: $('manual-solution').value.trim(),
      answer: $('manual-answer').value.trim(),
      tip: $('manual-tip').value.trim(),
      similar: $('manual-similar').value.trim()
    };
  }

  $('manual-preview-btn').addEventListener('click', () => {
    const f = manualCollect();
    if (!f.title && !f.question) { toast('请至少填写「错题标题」或「原题」'); return; }
    const text = buildManualEntry(Object.assign({}, f, { n: 'N' }));
    renderMd($('manual-preview'), text);
    $('manual-status').textContent = '科目：' + f.subject + ' · 仅预览，未写入';
  });

  $('manual-save').addEventListener('click', async () => {
    const f = manualCollect();
    if (!f.title && !f.question) { toast('请至少填写「错题标题」或「原题」'); return; }
    const file = f.subject + '.md';
    // 读取科目档案，计算下一个题号 N
    let exists = false, base = 0;
    try {
      const r = await api.workspace.read(file);
      if (r && r.ok) {
        exists = true;
        const m1 = r.content.match(/#{2,4}\s*错题\s*(\d+)/g) || [];
        m1.forEach((mm) => { const v = parseInt(mm.replace(/\D/g, ''), 10); if (v > base) base = v; });
      }
    } catch (e) { exists = false; }
    const n = base + 1;
    const text = buildManualEntry(Object.assign({}, f, { n }));
    let res;
    if (exists) {
      // 条目前统一加 `---` 分隔线，与知识库既有条目间分隔风格一致
      res = await api.workspace.append(file, '\n\n---\n\n' + text + '\n');
    } else {
      // 新科目：createSubject 会创建 科目.md 并注册到 _sidebar / README
      res = await api.workspace.createSubject(f.subject, '# ' + f.subject + '\n\n## 错题记录\n\n' + text + '\n');
    }
    if (res && res.ok) {
      renderMd($('manual-preview'), text);
      $('manual-status').textContent = '✅ 已写入 ' + file + '（错题 ' + n + '），可继续录入下一题';
      toast('✅ 已写入 ' + file + ' · 错题 ' + n);
      ['manual-title', 'manual-source', 'manual-question', 'manual-reason', 'manual-solution', 'manual-answer', 'manual-tip', 'manual-similar'].forEach((i) => $(i).value = '');
      api.site.refreshStats().catch(() => {});
      if (state.currentView === 'archive') refreshTree();
    } else {
      $('manual-status').textContent = '❌ 写入失败';
      toast('写入失败：' + ((res && res.message) || '未知错误'), 4000);
    }
  });

  // ---------- 待录入区：批量录入 ----------
  function extractTitle(content) {
    const m = (content || '').match(/^#{1,4}\s*(.*)$/m);
    return m ? m[1].slice(0, 40) : '错题草稿';
  }
  async function addToQueue(content, subject) {
    state.pendingQueue.push({
      id: Date.now() + Math.random().toString(36).slice(2, 7),
      subject: subject || '未知',
      title: extractTitle(content),
      content: content || ''
    });
    renderQueue();
  }
  function renderQueue() {
    const list = $('entry-queue');
    const q = state.pendingQueue;
    $('queue-count').textContent = q.length + ' 条草稿';
    list.innerHTML = '';
    if (!q.length) {
      list.innerHTML = '<div class="hint">先在左侧录入题目并点击「加入待录入区」，AI 生成草稿后在此汇总，可一键全部写入错题库。</div>';
      return;
    }
    q.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'queue-item';
      card.innerHTML =
        '<div class="qi-head">' +
        '<span class="qi-tag">' + escapeHtml(item.subject) + '</span>' +
        '<span class="qi-title">' + escapeHtml(item.title) + '</span>' +
        '<button class="qi-del" title="删除">✕</button>' +
        '</div>' +
        '<div class="qi-body"><div class="md-body"></div></div>';
      renderMd(card.querySelector('.md-body'), item.content);
      card.querySelector('.qi-head').addEventListener('click', () => card.classList.toggle('open'));
      card.querySelector('.qi-del').addEventListener('click', (e) => {
        e.stopPropagation();
        state.pendingQueue.splice(idx, 1);
        renderQueue();
      });
      list.appendChild(card);
    });
  }
  async function appendQueueToBank() {
    const q = state.pendingQueue;
    if (!q.length) { toast('待录入区为空'); return; }
    const grouped = {};
    q.forEach((item) => { (grouped[item.subject] = grouped[item.subject] || []).push(item); });
    const desc = Object.keys(grouped).map((s) => s + ' +' + grouped[s].length + ' 条').join('，');
    if (!(await askYesNo('确认将 ' + q.length + ' 条草稿全部录入错题库？\n将写入：' + desc))) return;

    const proc = $('queue-proc');
    proc.innerHTML = '';
    state.currentProc = proc;
    state.didWrite = false;
    for (const subject of Object.keys(grouped)) {
      const items = grouped[subject];
      const file = subject + '.md';
      let base = 0;
      try {
        const r = await api.workspace.read(file);
        if (r.ok) {
          const m1 = r.content.match(/#{2,4}\s*错题\s*(\d+)/g) || [];
          m1.forEach((n) => { const v = parseInt(n.replace(/\D/g, ''), 10); if (v > base) base = v; });
        }
      } catch (e) { /* 无文件则新建 */ }
      let appended = '';
      items.forEach((item, i) => {
        let c = item.content || '';
        c = c.replace(/^#{1,4}\s*错题\s*\d*\s*[：:]\s*/m, '#### 错题 ' + (base + i + 1) + '：');
        if (!/^#{1,4}\s*错题\s*\d+\s*[：:]/.test(c)) {
          c = '#### 错题 ' + (base + i + 1) + '：' + extractTitle(c) + '\n\n' + c;
        }
        if (!c.endsWith('\n')) c += '\n';
        appended += '\n---\n\n' + c;
      });
      const r = await api.workspace.append(file, appended);
      addProc(proc, (r.ok ? '✅ 已写入 ' : '❌ 写入失败 ') + file + '（' + items.length + ' 条）', r.ok ? 'ok' : 'err');
      if (r.ok) state.didWrite = true;
    }
    state.pendingQueue = [];
    renderQueue();
    refreshTree();
    api.site.refreshStats().catch(() => {});
    if (state.didWrite && (await askYesNo('全部录入完成 ✅\n是否现在上传到 GitHub？'))) {
      gitFlowAuto();
    }
  }
  $('queue-confirm-all').addEventListener('click', appendQueueToBank);
  $('queue-clear').addEventListener('click', async () => {
    if (!state.pendingQueue.length) return;
    if (await askYesNo('清空待录入区的 ' + state.pendingQueue.length + ' 条草稿？')) {
      state.pendingQueue = [];
      renderQueue();
    }
  });

  // ---------- 作文分析 ----------
  bindImage('essay-img', 'essay-img-btn', 'essay-img-name', 'essay-img-preview', state,
    { ocrBtn: 'essay-ocr', ocrAuto: 'essay-ocr-auto', target: 'essay-text', editBtn: 'essay-img-edit' });
  $('essay-submit').addEventListener('click', () => {
    const subject = $('essay-subject').value;
    const topic = $('essay-topic').value.trim();
    const essay = $('essay-text').value.trim();
    let text = '科目：' + subject + '\n';
    if (topic) text += '作文题目/来源：' + topic + '\n';
    text += (essay ? '作文全文：\n' + essay : '作文全文以附图为准') + '\n\n请按既有作文档案格式进行评分明细、错因逐条分析，并提供纵向与横向对比，写入对应科目档案。';
    runTask({
      mode: 'essay-analysis', text, imageBuf: state.imageBuf,
      procEl: $('essay-proc'), resultEl: $('essay-result'), statusEl: $('essay-status')
    });
    state.imageBuf = null;
  });

  // ---------- 分数预测 ----------
  $('score-run').addEventListener('click', () => {
    runTask({
      mode: 'score-predict',
      text: '请读取各科档案与 分数预测.md，重新估算各科高考分数并更新 分数预测.md。',
      procEl: $('score-proc'), resultEl: $('score-result'), statusEl: null
    });
  });

  // ---------- 档案编辑 ----------
  let treeData = [];
  async function refreshTree() {
    const r = await api.workspace.list('');
    if (!r.ok) { $('tree').innerHTML = '<div class="hint">' + r.message + '</div>'; return; }
    treeData = r.items;
    const tree = $('tree');
    tree.innerHTML = '';
    treeData.forEach((it) => {
      const isMd = /\.md$/i.test(it.name);
      const isCode = /\.(js|html|css|json)$/i.test(it.name);
      const d = document.createElement('div');
      d.className = 'tn ' + (it.isDir ? 'dir' : isMd ? 'md' : isCode ? 'code' : 'img');
      d.textContent = it.name;
      d.title = it.path;
      if (!it.isDir) {
        d.addEventListener('click', () => openInEditor(it.path));
        if (state.editorFile === it.path) d.classList.add('sel');
      }
      tree.appendChild(d);
    });
  }

  async function openInEditor(rel) {
    const r = await api.workspace.read(rel);
    if (!r.ok) { toast(r.message || '读取失败', 3000); return; }
    state.editorFile = rel;
    $('editor-file').textContent = rel;
    $('editor').value = r.content;
    $('editor').classList.remove('hidden');
    $('editor-preview').classList.add('hidden');
    $('editor-mode').textContent = '👁 预览';
    refreshTree();
    if (state.currentView === 'archive') switchView('archive');
  }

  $('tree-refresh').addEventListener('click', refreshTree);
  $('editor-mode').addEventListener('click', () => {
    const isMd = /\.md$/i.test(state.editorFile || '');
    const pv = $('editor-preview');
    if (pv.classList.contains('hidden')) {
      if (isMd) md(pv, $('editor').value);
      else pv.innerHTML = '<pre style="font-family:var(--mono);font-size:12px;color:var(--text-2)">' + escapeHtml($('editor').value) + '</pre>';
      pv.classList.remove('hidden');
      $('editor').classList.add('hidden');
      $('editor-mode').textContent = '✏️ 编辑';
    } else {
      pv.classList.add('hidden');
      $('editor').classList.remove('hidden');
      $('editor-mode').textContent = '👁 预览';
    }
  });
  $('editor-save').addEventListener('click', async () => {
    if (!state.editorFile) { toast('请先选择文件'); return; }
    const r = await api.workspace.write(state.editorFile, $('editor').value);
    if (r.ok) { toast('已保存：' + state.editorFile + '（md 为 UTF-8+BOM）'); state.didWrite = true; refreshTree(); }
    else toast('保存失败：' + r.message, 3000);
  });

  // ---------- Git 面板 ----------
  async function gitStatus() {
    const r = await api.git.status();
    if (r.ok) {
      $('git-branch').textContent = '🌿 ' + (r.branch || 'master') + (r.remote ? '   ' + r.remote : '');
      $('git-status').textContent = r.short || '（工作区干净）';
    } else {
      $('git-status').textContent = '无法读取 Git 状态：' + r.message + '\n（请确认工作目录是 Git 仓库）';
    }
    const log = await api.git.log(20);
    $('git-log').textContent = log.ok ? (log.lines.join('\n') || '（暂无提交）') : ('log 失败：' + log.message);
  }
  $('git-status-btn').addEventListener('click', gitStatus);
  $('git-clean-btn').addEventListener('click', async () => {
    if (!(await askYesNo('执行 git clean？\ngit rm -r --cached .  然后  git add -A'))) return;
    const r = await api.git.clean();
    toast(r.ok ? 'clean 完成' : 'clean 失败：' + r.message, 3000);
    gitStatus();
  });
  $('git-commit-btn').addEventListener('click', async () => {
    const msg = $('git-msg').value.trim() || ('修改内容 - ' + new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-'));
    if (!(await askYesNo('提交变更？\n' + msg))) return;
    const r = await api.git.commit(msg);
    toast(r.ok ? (r.skipped ? '无变更' : '已提交：' + r.message) : 'commit 失败：' + r.message, 3000);
    gitStatus();
  });
  $('git-push-btn').addEventListener('click', async () => {
    if (!(await askYesNo('推送到 GitHub 远程仓库？（失败重试3次）'))) return;
    const r = await api.git.push();
    toast(r.ok ? '✅ 推送成功' : '❌ push 失败：' + r.message, 4000);
    gitStatus();
  });
  $('git-scan-btn').addEventListener('click', async () => {
    const r = await api.git.scan();
    if (r.ok && r.hits.length === 0) { toast('✅ 未发现 AIGC 追踪串污染'); return; }
    $('git-status').textContent = '⚠️ 发现 ' + (r.hits ? r.hits.length : 0) + ' 处 AIGC 追踪串：\n' +
      (r.hits || []).map((h) => h.file + '  →  ' + h.field).join('\n');
    toast('⚠️ 发现 AIGC 追踪串，请检查', 4000);
  });

  // ---------- 预览 ----------
  let webview = $('preview');
  function loadPreview() {
    if (state.previewUrl && webview.getURL && !webview.getURL()) {
      webview.src = state.previewUrl;
    } else if (state.previewUrl && webview.getURL && !webview.getURL().startsWith(state.previewUrl)) {
      webview.src = state.previewUrl;
    }
  }
  function navPreview(path) {
    if (!state.previewUrl) { toast('预览服务未就绪'); return; }
    const base = state.previewUrl.replace(/\/$/, '');
    let p = String(path || '').replace(/\.md$/i, '').replace(/^\//, '');
    webview.src = base + '/#/' + encodeURIComponent(p);
    switchView('preview');
  }

  // ---------- 提供商表单 ----------
  function providerRowHTML(p) {
    const models = (p.models && p.models.length ? p.models : []);
    const opts = models.map((m) => '<option value="' + m.id + '">' + m.name + '</option>').join('');
    return '<div class="wiz-provider" data-id="' + p.id + '">' +
      '<div class="wp-head">' +
      '<input type="checkbox" data-f="enabled" ' + (p.enabled ? 'checked' : '') + ' />' +
      '<span>' + (p.name || p.id || '提供商') + '</span>' +
      '<span class="hint">' + (p.vision ? '🖼 支持图片' : '') + ' · ' + (p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容') + '</span>' +
      '</div>' +
      '<div class="wp-grid">' +
      '<div class="full"><input data-f="baseUrl" value="' + p.baseUrl + '" placeholder="Base URL" /></div>' +
      '<div class="full"><input data-f="model" value="' + p.model + '" list="models-' + p.id + '" placeholder="模型（可从下拉选择预设）" /></div>' +
      '<datalist id="models-' + p.id + '">' + opts + '</datalist>' +
      '<div class="full"><input data-f="apiKey" type="password" value="' + (p.apiKey || '') + '" placeholder="API Key（密钥环加密）" /></div>' +
      '<div class="full"><input data-f="temperature" value="' + (p.temperature ?? '') + '" placeholder="temperature（留空=模型默认；Kimi K2.6 等仅允许 1）" /></div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:8px;align-items:center;">' +
      '<button class="btn-mini test-btn">测试连接</button><span class="test-status hint"></span>' +
      '</div></div>';
  }

  function bindProviderForms(containerId, cfg, onActiveChange) {
    const c = $(containerId);
    c.innerHTML = Object.values(cfg.providers).map(providerRowHTML).join('');
    c.querySelectorAll('.wiz-provider').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('.test-btn').addEventListener('click', async (ev) => {
        const btn = ev.target;
        const st = row.querySelector('.test-status');
        // 收集表单当前值（含 API Key），未保存也可直接测试
        const p = { id };
        row.querySelectorAll('[data-f]').forEach((el) => { p[el.dataset.f] = el.value; });
        p.enabled = row.querySelector('[data-f="enabled"]').checked;
        btn.disabled = true; st.textContent = '测试中…';
        const r = await api.settings.test(id, p);
        st.textContent = r.ok ? '✅ 连接成功 ' + r.latency + 'ms' : '❌ ' + (r.message || '失败');
        btn.disabled = false;
      });
    });
  }

  function readProviderRows(containerId) {
    const out = {};
    $(containerId).querySelectorAll('.wiz-provider').forEach((row) => {
      const id = row.dataset.id;
      // 保留已有元数据（name/kind/vision/models），避免保存后显示 undefined
      const base = (state.config && state.config.providers && state.config.providers[id]) || {};
      const p = Object.assign({}, base);
      row.querySelectorAll('[data-f]').forEach((el) => { p[el.dataset.f] = el.dataset.f === 'apiKey' ? el.value.trim() : el.value; });
      p.enabled = row.querySelector('[data-f="enabled"]').checked;
      out[id] = p;
    });
    return out;
  }

  // ---------- 配置应用与设置 ----------
  // 标题栏覆盖层颜色跟随主题（深色/浅色）
  function updateTitleBarOverlay() {
    const theme = document.documentElement.dataset.theme || 'dark';
    api.app.setTitleBarOverlay({
      color: theme === 'light' ? '#eef2f9' : '#0f172a',
      symbolColor: theme === 'light' ? '#46536b' : '#9fb0c8'
    }).catch(() => {});
  }

  // 首页问候（昵称可在设置中配置）
  function renderGreeting(nickname) {
    const el = $('home-greeting');
    if (!el) return;
    const name = (nickname || '').trim();
    el.textContent = name ? '欢迎回来，' + name : '欢迎回来';
  }

  function applyConfig(cfg) {
    state.config = cfg;
    document.documentElement.dataset.theme = cfg.theme || 'dark';
    updateTitleBarOverlay();
    $('set-theme').value = cfg.theme || 'dark';
    const nnEl = $('user-nickname'); if (nnEl) nnEl.value = cfg.nickname || '';
    renderGreeting(cfg.nickname);
    $('set-token-warn').value = cfg.tokenWarn || 500000;
    loadTokenUsage();
    $('ws-tag').textContent = cfg.workspacePath ? '📁 ' + cfg.workspacePath : '📁 未设置';
    $('ws-tag').title = cfg.workspacePath || '';
    const wsEl = $('user-ws'); if (wsEl) wsEl.value = cfg.workspacePath || '';
    $('set-exam-type').value = (cfg.exam && cfg.exam.type) || 'gaokao';
    const sen = $('set-exam-name'); if (sen) sen.value = (cfg.exam && cfg.exam.name) || '';
    toggleExamNameField('set-exam-type', 'set-exam-name-field');
    $('set-exam-year').value = (cfg.exam && cfg.exam.year) || 2027;
    if (!$('set-exam-month').options.length) {
      for (let i = 1; i <= 12; i++) $('set-exam-month').add(new Option(i + ' 月', i));
      for (let i = 1; i <= 31; i++) $('set-exam-day').add(new Option(i + ' 日', i));
    }
    $('set-exam-month').value = (cfg.exam && cfg.exam.month) || 6;
    $('set-exam-day').value = (cfg.exam && cfg.exam.day) || ((cfg.exam && cfg.exam.type === 'zhongkao') ? 24 : 7);
    $('set-exampwd').value = cfg.examPassword || '';
    $('prompt-error').value = cfg.prompts.errorHelper || '';
    $('prompt-study').value = cfg.prompts.studyHelper || '';
    // OCR 开关与引擎（全局 + 各视图默认同步）
    const ocrAuto = !!(cfg.ocr && cfg.ocr.auto);
    $('set-ocr-auto').checked = ocrAuto;
    $('set-ocr-engine').value = (cfg.ocr && cfg.ocr.engine) || 'win';
    $('entry-ocr-auto').checked = ocrAuto;
    $('essay-ocr-auto').checked = ocrAuto;
    $('chat-ocr-auto').checked = ocrAuto;
    bindProviderForms('providers', cfg);
    const tp = $('tb-path'); if (tp) tp.textContent = cfg.workspacePath || '';
    updateCountdown();
    loadUsers();
    if (!cfg.initialized) showWizard(cfg);
  }

  api.app.onConfig(applyConfig);
  api.preview.getUrl().then((u) => { state.previewUrl = u; });
  api.app.onPreviewUrl((u) => { state.previewUrl = u; });

  function collectSettings() {
    const cfg = JSON.parse(JSON.stringify(state.config || {}));
    const wsEl = $('user-ws'); if (wsEl) cfg.workspacePath = wsEl.value.trim();
    cfg.theme = $('set-theme').value;
    const nnEl = $('user-nickname'); if (nnEl) cfg.nickname = nnEl.value.trim();
    cfg.tokenWarn = Number($('set-token-warn').value) || 500000;
    cfg.exam = {
      type: $('set-exam-type').value,
      name: $('set-exam-name') ? ($('set-exam-name').value || '').trim() : '',
      year: Number($('set-exam-year').value) || 2027,
      month: Number($('set-exam-month').value) || 6,
      day: Number($('set-exam-day').value) || 7
    };
    cfg.examPassword = $('set-exampwd').value;
    cfg.providers = Object.assign({}, cfg.providers, readProviderRows('providers'));
    cfg.ocr = Object.assign({ auto: false, engine: 'win' }, cfg.ocr || {}, {
      auto: $('set-ocr-auto').checked,
      engine: $('set-ocr-engine').value
    });
    cfg.prompts.errorHelper = $('prompt-error').value;
    cfg.prompts.studyHelper = $('prompt-study').value;
    return cfg;
  }

  $('settings-save').addEventListener('click', async () => {
    const cfg = collectSettings();
    const r = await api.settings.save(cfg);
    applyConfig(r);
    toast('✅ 设置已保存');
  });

  $('set-theme').addEventListener('change', async () => {
    const cfg = collectSettings();
    document.documentElement.dataset.theme = cfg.theme;
    updateTitleBarOverlay();
    await api.settings.save(cfg);
  });
  $('theme-toggle').addEventListener('click', async () => {
    const cfg = collectSettings();
    cfg.theme = cfg.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cfg.theme;
    updateTitleBarOverlay();
    await api.settings.save(cfg);
  });
  $('user-ws-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) { const ws = $('user-ws'); if (ws) ws.value = p; const cfg = collectSettings(); await api.settings.save(cfg); applyConfig(cfg); }
  });
  $('user-save').addEventListener('click', async () => {
    const cfg = collectSettings();
    const r = await api.settings.save(cfg);
    applyConfig(r);
    loadUsers();
    toast('✅ 已保存当前用户配置');
  });
  $('user-reload').addEventListener('click', async () => {
    const cfg = await api.settings.get();
    applyConfig(cfg);
    toast('↺ 已重新读取配置');
  });

  // ---------- 用户管理（多用户 / 知识库切换） ----------
  async function loadUsers() {
    const el = $('users-list');
    if (!el) return;
    const r = await api.users.list().catch(() => null);
    if (!r || !r.ok) { el.innerHTML = '<span class="hint">无法读取用户列表</span>'; return; }
    const curEl = $('user-current');
    if (curEl) curEl.textContent = r.currentName || '—';
    const curNameEl = $('user-current-name');
    if (curNameEl) curNameEl.textContent = r.currentName || '—';
    el.innerHTML = '';
    const canDel = (r.users || []).length > 1;
    (r.users || []).forEach((u) => {
      const item = document.createElement('div');
      item.className = 'user-item' + (u.isCurrent ? ' current' : '');
      const tag = u.isCurrent ? '<span class="user-tag">当前</span>' : '';
      const warn = (!u.exists) ? '<span class="hint">（文件夹不存在）</span>'
        : (u.hasDocsify ? '' : '<span class="hint">（未检测到知识库）</span>');
      item.innerHTML = '<span class="user-name">' + escapeHtml(u.name) + '</span>' + tag + warn +
        '<span class="user-path" title="' + escapeHtml(u.path) + '">' + escapeHtml(u.path) + '</span>';
      if (!u.isCurrent) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn-mini';
        b.textContent = '切换';
        b.addEventListener('click', () => switchUser(u.id));
        item.appendChild(b);
      }
      if (canDel) {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'btn-mini warn';
        d.textContent = '删除';
        d.addEventListener('click', () => removeUser(u.id, u.name));
        item.appendChild(d);
      }
      el.appendChild(item);
    });
    if (!(r.users || []).length) el.innerHTML = '<span class="hint">暂无用户。点击「新增用户」创建一个（选择或新建知识库文件夹）。</span>';
  }
  async function switchUser(id) {
    if (!id) return;
    const u = ((state.config && state.config.users) || []).find((x) => x.id === id);
    if (!u) { toast('用户不存在', 3500); return; }
    if (!(await askYesNo('切换到用户「' + u.name + '」？\n知识库：' + u.path + '\n\n切换后，错题统计 / 档案编辑 / AI 录入 / 网页预览等都将基于该知识库。确定切换吗？'))) return;
    const r = await api.users.switchTo(id);
    if (!r || !r.workspacePath) { toast('切换失败', 4000); return; }
    applyConfig(r);
    loadUsers();
    refreshTree();
    loadStats();
    gitStatus();
    loadGitConfig();
    refreshPreview();
    setTimeout(maybeOfferBuild, 400);
    toast('✅ 已切换到用户：' + u.name, 4000);
  }
  async function removeUser(id, name) {
    if (!id) return;
    // 两次警告确认
    if (!(await askYesNo('确定要删除用户「' + name + '」吗？\n\n仅移除用户记录，不会删除其知识库文件夹。'))) return;
    if (!(await askYesNo('再次确认：确定永久删除用户「' + name + '」？\n此操作不可恢复！'))) return;
    const r = await api.users.remove(id);
    if (!r || !r.workspacePath) { toast('删除失败：' + ((r && r.message) || ''), 4000); return; }
    applyConfig(r);
    loadUsers();
    refreshTree();
    loadStats();
    gitStatus();
    loadGitConfig();
    refreshPreview();
    toast('✅ 已删除用户：' + name, 4000);
  }
  function openAddUser() {
    $('add-user-dir').value = '';
    $('add-user-new-name').value = '';
    $('add-user-name').value = '';
    $('add-user-new-field').classList.add('hidden');
    $('add-user-modal').classList.remove('hidden');
    $('add-user-name').focus();
  }
  $('users-refresh').addEventListener('click', loadUsers);
  $('users-add').addEventListener('click', openAddUser);
  $('add-user-close').addEventListener('click', () => $('add-user-modal').classList.add('hidden'));
  $('add-user-cancel').addEventListener('click', () => $('add-user-modal').classList.add('hidden'));
  $('add-user-dir-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) { $('add-user-dir').value = p; $('add-user-new-field').classList.add('hidden'); }
  });
  $('add-user-new-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) {
      state.addUserNewBase = p;
      $('add-user-new-field').classList.remove('hidden');
      $('add-user-new-name').focus();
      toast('请在下方输入新文件夹名称（创建于：' + p + '）', 4000);
    }
  });
  $('add-user-ok').addEventListener('click', async () => {
    const name = ($('add-user-name').value || '').trim();
    if (!name) { toast('请输入用户名', 3500); return; }
    let dir = ($('add-user-dir').value || '').trim();
    if (!dir && state.addUserNewBase && ($('add-user-new-name').value || '').trim()) {
      const mk = await api.users.mkdir({ base: state.addUserNewBase, name: ($('add-user-new-name').value || '').trim() });
      if (!mk || !mk.ok) { toast('新建文件夹失败：' + ((mk && mk.message) || ''), 4000); return; }
      dir = mk.path;
    }
    if (!dir) { toast('请选择或新建用户的知识库文件夹', 3500); return; }
    const cr = await api.users.create({ name, path: dir });
    if (!cr || !cr.ok) { toast('创建失败：' + ((cr && cr.message) || ''), 4000); return; }
    const sw = await api.users.switchTo(cr.id);
    if (!sw || !sw.workspacePath) { toast('切换失败', 4000); return; }
    $('add-user-modal').classList.add('hidden');
    applyConfig(sw);
    loadUsers();
    // 新增用户：进入类似「初始化配置」的引导（所选文件夹可能尚未配置环境 / 知识库）
    showWizard(sw);
  });

  // 顶栏双击最大化 / 还原（自定义标题栏，按钮上不触发）
  (function bindTitleBarDblclick() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    bar.addEventListener('dblclick', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].indexOf(tag) !== -1) return;
      api.app.toggleMaximize().catch(() => {});
    });
  })();

  // ---------- 数据导出 / 导入（zip 多用户数据包） ----------
  function openDataExport() {
    const users = (state.config && state.config.users) || [];
    const el = $('data-export-users');
    el.innerHTML = '';
    if (!users.length) { el.innerHTML = '<span class="hint">暂无用户可导出。</span>'; }
    users.forEach((u) => {
      const item = document.createElement('label');
      item.className = 'user-item';
      item.style.cursor = 'pointer';
      item.innerHTML = '<input type="checkbox" data-id="' + escapeHtml(u.id) + '" checked style="flex:none" />' +
        '<span class="user-name">' + escapeHtml(u.name) + '</span>' +
        '<span class="user-path" title="' + escapeHtml(u.path) + '">' + escapeHtml(u.path) + '</span>';
      el.appendChild(item);
    });
    $('data-export-api').checked = false;
    $('data-export-modal').classList.remove('hidden');
  }
  $('data-export').addEventListener('click', openDataExport);
  $('data-export-close').addEventListener('click', () => $('data-export-modal').classList.add('hidden'));
  $('data-export-cancel').addEventListener('click', () => $('data-export-modal').classList.add('hidden'));
  $('data-export-ok').addEventListener('click', async () => {
    const ids = [];
    document.querySelectorAll('#data-export-users input:checked').forEach((c) => ids.push(c.dataset.id));
    if (!ids.length) { toast('请至少选择一个用户', 3500); return; }
    const includeApi = $('data-export-api').checked;
    $('data-export-modal').classList.add('hidden');
    toast('正在打包数据…');
    const r = await api.data.export({ userIds: ids, includeApi });
    if (r.ok) toast('✅ 已导出 ' + r.users + ' 个用户 · ' + r.files + ' 个文件 → ' + r.path, 6000);
    else if (!r.cancelled) toast('导出失败：' + (r.message || ''), 4000);
  });

  // 导入
  $('data-import').addEventListener('click', async () => {
    toast('请选择要导入的数据包…');
    const info = await api.data.inspect();
    if (!info || !info.ok) {
      if (info && !info.cancelled) toast('无法导入：' + (info.message || ''), 4000);
      return;
    }
    state.importData = info;
    $('data-import-file').textContent = info.file;
    $('data-import-count').textContent = info.users.length;
    $('data-import-time').textContent = (info.meta && info.meta.exportedAt) ? info.meta.exportedAt.slice(0, 10) : '—';
    const ul = $('data-import-users');
    ul.innerHTML = '';
    info.users.forEach((u) => {
      const item = document.createElement('label');
      item.className = 'user-item';
      item.style.cursor = 'pointer';
      item.innerHTML = '<input type="checkbox" data-id="' + escapeHtml(u.id) + '" checked style="flex:none" />' +
        '<span class="user-name">' + escapeHtml(u.name) + '</span>' +
        '<span class="hint">' + (u.fileCount || 0) + ' 个文件</span>';
      ul.appendChild(item);
    });
    // 默认解压位置：当前知识库所在目录的父目录
    const cur = String((state.config && state.config.workspacePath) || '').replace(/[\\/]+$/, '');
    $('data-import-dir').value = cur ? cur.replace(/[\\/][^\\/]*$/, '') : '';
    $('data-import-modal').classList.remove('hidden');
  });
  $('data-import-close').addEventListener('click', () => $('data-import-modal').classList.add('hidden'));
  $('data-import-cancel').addEventListener('click', () => $('data-import-modal').classList.add('hidden'));
  $('data-import-dir-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) $('data-import-dir').value = p;
  });
  $('data-import-ok').addEventListener('click', async () => {
    const info = state.importData;
    if (!info) return;
    const ids = [];
    document.querySelectorAll('#data-import-users input:checked').forEach((c) => ids.push(c.dataset.id));
    if (!ids.length) { toast('请至少选择一个要导入的用户', 3500); return; }
    const mode = (document.querySelector('input[name="data-import-mode"]:checked') || {}).value || 'insert';
    const targetDir = ($('data-import-dir').value || '').trim();
    if (!targetDir) { toast('请选择解压目标文件夹', 3500); return; }
    const modeTxt = mode === 'replace' ? '替换全部' : '插入所选用户';
    if (!(await askYesNo('确认导入？\n\n模式：' + modeTxt + '\n用户：' + ids.length + ' 个\n解压到：' + targetDir + '\n\n请确认无误，避免误覆盖数据。'))) return;
    $('data-import-modal').classList.add('hidden');
    toast('正在导入…');
    const r = await api.data.import({ buffer: info.buffer, mode, selectedIds: ids, targetDir });
    if (!r || !r.ok) { toast('导入失败：' + ((r && r.message) || ''), 5000); return; }
    const cfg = await api.settings.get();
    applyConfig(cfg);
    loadUsers();
    state.records = await api.records.list();
    renderRecords();
    refreshTree();
    loadStats();
    gitStatus();
    loadGitConfig();
    refreshPreview();
    const names = (r.imported || []).map((x) => x.name + (x.folder !== x.name ? '(' + x.folder + ')' : '')).join('、');
    toast('✅ 已导入：' + (names || '完成'), 6000);
  });

  // ---------- 开源致谢 ----------
  const CREDITS = [
    { name: 'Electron', url: 'https://github.com/electron/electron', desc: '跨平台桌面应用框架' },
    { name: 'electron-builder', url: 'https://github.com/electron-userland/electron-builder', desc: '应用打包工具' },
    { name: 'Tesseract.js', url: 'https://github.com/naptha/tesseract.js', desc: '本地 OCR 文字识别引擎' },
    { name: 'docsify', url: 'https://github.com/docsifyjs/docsify', desc: '错题知识库网页框架' },
    { name: 'MathJax', url: 'https://github.com/mathjax/MathJax', desc: '数学公式渲染' },
    { name: 'Chart.js', url: 'https://github.com/chartjs/Chart.js', desc: '分数预测图表' },
    { name: 'highlight.js', url: 'https://github.com/highlightjs/highlight.js', desc: '代码高亮（docsify 内置）' },
    { name: 'adm-zip', url: 'https://github.com/cthackers/adm-zip', desc: '数据导出/导入的 ZIP 打包与解压' }
  ];
  function renderCredits() {
    const list = $('credits-list');
    list.innerHTML = '';
    CREDITS.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'credit-row';
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'credit-name';
      a.textContent = c.name;
      a.title = c.url;
      a.addEventListener('click', (e) => { e.preventDefault(); api.app.openExternal(c.url); });
      const u = document.createElement('span');
      u.className = 'credit-url';
      u.textContent = c.url;
      row.appendChild(a);
      row.appendChild(u);
      if (c.desc) {
        const d = document.createElement('div');
        d.className = 'credit-desc';
        d.textContent = c.desc;
        row.appendChild(d);
      }
      list.appendChild(row);
    });
  }
  $('credits-open').addEventListener('click', () => { renderCredits(); $('credits-modal').classList.remove('hidden'); });
  $('credits-close').addEventListener('click', () => $('credits-modal').classList.add('hidden'));
  $('credits-close2').addEventListener('click', () => $('credits-modal').classList.add('hidden'));

  // ---------- 版本更新内容 ----------
  const VERSION_INFO = {
    current: 'v1.8.8',
    history: [
      { v: 'v1.8.8', date: '2026-08-13', items: [
        '新增「检查新版本」：自动从 GitHub Releases 检测新版并下载安装',
        '使用许可协议链接迁移至 https://studyassistant.kfdzcoffee.cn/legal.html',
        '项目官网 / 更新源上线（GitHub: kfdzcoffee/StudyAssistant）'
      ] },
      { v: 'v1.8.7', date: '2026-08-13', items: [
        '全新多用户系统：独立「用户」页面，可选择/新建知识库文件夹创建用户、一键切换（弹窗确认并自动刷新）、删除用户（两次警告、至少保留一个）',
        '初始化完成后自动创建默认用户；新增用户自动进入初始化引导，配置其考试 / AI / Git',
        '初始化向导升级：新增昵称询问、Git 授权「测试连接 / 授权」、🥳 恭喜完成结束页',
        '环境配置（可选）：可勾选安装 Git / Node / npm、指定安装位置；支持命令安装（winget 自动安装，含安装风险告知书）或自行安装（仅弹窗提示）',
        '修复初始化向导中弹窗层级被向导遮挡的问题',
        '考试类型新增「自定义」，可手动输入考试名称并显示于首页倒计时',
        '默认组卷密码改为 000000',
        '多用户数据导出 / 导入：导出为 zip 压缩包（含知识库文件，可选是否附带 AI 的 API Key）；导入可选单个 / 多个用户或替换全部，自动解压到指定位置，插入不覆盖且自动处理重名用户'
      ] },
      { v: 'v1.8.6', date: '2026-08-12', items: [
        '修复导出的 Word 试卷「解析一页一行」：分页符不再套在外层容器上（Word 会把它错误传播到每个段落），改为放在「参考答案与解析」标题上，答案解析自然跨页连续排版',
        '修复「答案与解析另起一页」选项之前不生效的问题：取消勾选后答案解析将紧跟题干、不再强制换页'
      ] },
      { v: 'v1.8.5', date: '2026-08-12', items: [
        '专注计时全屏的关闭按钮移到左上角，不再被系统窗口按钮（最小化 / 最大化 / 关闭）挡住',
        '设置「关于作者」新增联系方式邮箱：me@kfdzcoffee.cn（点击可直接发邮件）'
      ] },
      { v: 'v1.8.4', date: '2026-08-12', items: [
        '错题统计新增全文搜索：可搜索所有错题内容（含题目 / 错因 / 解法），点命中直接打开详情',
        '支持 MathJax：$...$ / $$...$$ 数学公式正常渲染（本地 SVG，离线可用）',
        '单日 Token 消耗预警：超阈值弹窗提示，阈值可在设置中调整',
        '首页「欢迎回来，昵称」问候（昵称可在设置中配置）',
        '自定义标题栏：系统按钮保留、跟随主题；顶栏可拖拽、双击最大化',
        '专注计时优化：记录可删除（不可恢复确认）、布局更紧凑',
        '刷新前弹窗确认，避免未保存内容丢失'
      ] },
      { v: 'v1.8.3', date: '2026-08-12', items: [
        'OCR 双引擎二选一：Windows 自带 OCR（中文印刷体最佳）与 Tesseract.js 全精度模型，设置中切换，失败自动回退',
        '识别前自动预处理（灰度 + 对比度），配合旋转 / 框选裁剪进一步提升精度',
        'AI 可中途提问确认（ask_user）：核对 OCR 内容、补充信息时弹窗等待你的回答',
        '使用 OCR 后提交自动去掉图片，不再提示「所选模型不支持图片识别」',
        '大幅节省 token：AI 改用紧凑摘要（subject_summary）与按行读取（read_file_range），不再整篇读大档案',
        'OCR 内容自动标注「识别误差大」，AI 生成时合理推断并提醒二次确认'
      ] },
      { v: 'v1.8.2', date: '2026-08-12', items: [
        '图片编辑：旋转（90° / 微调角度）与框选裁剪，OCR 前可先旋转 / 框选预处理',
        'OCR 改为本地引擎（Tesseract.js），不再调用 AI 提供商、图片不上传，离线可用',
        '设置新增「开源致谢」与「版本更新内容」'
      ] },
      { v: 'v1.8.1', date: '2026-08-12', items: [
        '新增「手动录入错题」窗口：不经过 AI，直接按知识库格式写入错题档案'
      ] },
      { v: 'v1.8.0', date: '2026-08-12', items: [
        '修复 AI 输出显示为 [object Object]',
        '修复 HTTP 400 / 401 / 429、请求超时，思考中实时显示等待秒数',
        'Kimi 默认模型升级为 K2.6（支持视觉 / 256K 上下文）',
        '新增图片 OCR 识别（可选）'
      ] },
      { v: 'v1.7.x', date: '2026-08', items: [
        '初始化向导多步（欢迎 / 配置 / Git / 导入 / AI 声明 / 协议）',
        '数据导出 / 导入、Git 授权配置、AIGC 追踪串扫描',
        '目标院校与主页编辑、错题统计与试卷生成（Word）',
        '首页倒计时、鸡汤、专注计时（翻页时钟）'
      ] }
    ]
  };
  function renderVersionInfo() {
    const tag = $('version-now-tag');
    if (tag) tag.textContent = VERSION_INFO.current;
    const list = $('version-list');
    list.innerHTML = '';
    VERSION_INFO.history.forEach((h) => {
      const card = document.createElement('div');
      card.className = 'version-item';
      let html = '<div class="version-head"><b>' + escapeHtml(h.v) + '</b><span class="hint">' + escapeHtml(h.date || '') + '</span></div><ul>';
      (h.items || []).forEach((it) => { html += '<li>' + escapeHtml(it) + '</li>'; });
      html += '</ul>';
      card.innerHTML = html;
      list.appendChild(card);
    });
  }
  $('version-open').addEventListener('click', () => { renderVersionInfo(); $('version-modal').classList.remove('hidden'); });
  $('version-close').addEventListener('click', () => $('version-modal').classList.add('hidden'));
  $('version-close2').addEventListener('click', () => $('version-modal').classList.add('hidden'));

  // ---------- 检查更新（GitHub Releases） ----------
  function compareVersions(a, b) {
    const pa = String(a || '').split('.').map(Number);
    const pb = String(b || '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }
  $('update-check').addEventListener('click', async () => {
    const st = $('update-status');
    if (st) st.textContent = '⏳ 正在检查更新…';
    const r = await api.update.check().catch(() => null);
    if (!r || !r.ok) {
      if (st) st.textContent = '❌ 检查失败：' + ((r && r.message) || '网络错误');
      await askYesNo('检查更新失败：' + ((r && r.message) || '网络错误') + '\n\n请确认网络可访问 GitHub 后重试，或前往：\nhttps://github.com/kfdzcoffee/StudyAssistant/releases');
      return;
    }
    const curVer = String(VERSION_INFO.current || '').replace(/^v/i, '');
    if (compareVersions(r.version, curVer) <= 0) {
      if (st) st.textContent = '✅ 已是最新版本（v' + curVer + '）';
      toast('✅ 已是最新版本（v' + curVer + '）', 4000);
      return;
    }
    if (st) st.textContent = '发现新版本 v' + r.version + '（当前 v' + curVer + '）';
    const notes = String(r.notes || '').slice(0, 600);
    if (!(await askYesNo('发现新版本：v' + r.version + '（当前 v' + curVer + '）\n\n' + (notes ? '更新说明：\n' + notes + '\n' : '') + '是否下载并安装新版？'))) {
      if (st) st.textContent = '';
      return;
    }
    if (st) st.textContent = '⏳ 正在下载新版并启动安装程序…';
    const d = await api.update.apply(r.url).catch(() => null);
    if (!d || !d.ok) {
      if (st) st.textContent = '❌ 下载/启动失败：' + ((d && d.message) || '未知错误');
      await askYesNo('下载/启动失败：' + ((d && d.message) || '未知错误') + '\n\n可前往 GitHub 手动下载：\nhttps://github.com/kfdzcoffee/StudyAssistant/releases');
      return;
    }
    if (st) st.textContent = '✅ 已启动安装程序，请按向导完成安装';
    toast('✅ 已启动安装程序，请按向导完成安装', 5000);
  });

  // ---------- Git 授权配置 ----------
  async function loadGitConfig() {
    const r = await api.gitConfig.get();
    if (!r.ok) return;
    $('git-name').value = r.name || '';
    $('git-email').value = r.email || '';
    $('git-remote').value = r.remote || '';
    $('git-cfg-status').textContent = '';
    $('git-auth-status').textContent = r.isRepo
      ? '✅ Git 仓库正常；HTTPS 推送凭据由系统凭据管理器保存，点「测试连接」可触发授权。'
      : '⚠️ 当前工作目录还不是 Git 仓库，可点「初始化 Git 仓库」。';
  }
  $('git-save').addEventListener('click', async () => {
    const r = await api.gitConfig.set({ name: $('git-name').value.trim(), email: $('git-email').value.trim() });
    $('git-cfg-status').textContent = r.ok ? '✅ 已保存到 Git 配置' : '❌ ' + (r.message || '');
    if (r.ok) toast('✅ Git 配置已保存');
  });
  $('git-init-repo').addEventListener('click', async () => {
    if (!(await askYesNo('在当前工作目录初始化 Git 仓库（git init）？'))) return;
    const r = await api.gitConfig.initRepo();
    toast(r.ok ? '✅ 已初始化 Git 仓库' : '❌ ' + (r.message || ''), 3000);
    loadGitConfig();
  });
  $('git-remote-set').addEventListener('click', async () => {
    const url = $('git-remote').value.trim();
    if (!url) { toast('请输入远程仓库地址'); return; }
    const r = await api.gitConfig.setRemote(url);
    toast(r.ok ? '✅ 远程仓库已设置' : '❌ ' + (r.message || ''), 3000);
  });
  $('git-auth-test').addEventListener('click', async () => {
    $('git-auth-status').textContent = '测试中…';
    const r = await api.gitConfig.test();
    $('git-auth-status').textContent = r.ok ? '✅ ' + r.message : '❌ ' + r.message;
  });
  $('git-creds-clear').addEventListener('click', async () => {
    if (!(await askYesNo('清除系统保存的 GitHub 凭据？\n下次推送时将重新要求登录。'))) return;
    const r = await api.gitConfig.clearCreds();
    toast(r.message || '完成', 3500);
    $('git-auth-status').textContent = r.message || '';
  });

  // ---------- 关于作者链接 ----------
  document.querySelectorAll('.about-links a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      api.app.openExternal(a.dataset.url);
    });
  });

  // ---------- 初始化向导 ----------
  function showWizard(cfg) {
    const wn = $('wiz-nickname'); if (wn) wn.value = cfg.nickname || '';
    $('wiz-ws').value = cfg.workspacePath || 'd:\\BaiduSyncdisk\\学习\\高考复习\\网页';
    $('wiz-prompt-error').value = cfg.prompts.errorHelper;
    $('wiz-prompt-study').value = cfg.prompts.studyHelper;
    bindProviderForms('wiz-providers', cfg);
    // 预填 Git 配置
    api.gitConfig.get().then((r) => {
      if (r && r.ok) {
        $('wiz-git-name').value = r.name || '';
        $('wiz-git-email').value = r.email || '';
        $('wiz-git-remote').value = r.remote || '';
      }
    }).catch(() => {});
    $('wiz-ai-agree').checked = false;
    $('wiz-agree').checked = false;
    // 预填考试日期
    if (!$('wiz-exam-month').options.length) {
      for (let i = 1; i <= 12; i++) $('wiz-exam-month').add(new Option(i + ' 月', i));
      for (let i = 1; i <= 31; i++) $('wiz-exam-day').add(new Option(i + ' 日', i));
    }
    const ex = cfg.exam || {};
    $('wiz-exam-type').value = ex.type || 'gaokao';
    const wen = $('wiz-exam-name'); if (wen) wen.value = ex.name || '';
    toggleExamNameField('wiz-exam-type', 'wiz-exam-name-field');
    $('wiz-exam-year').value = ex.year || 2027;
    $('wiz-exam-month').value = ex.month || 6;
    $('wiz-exam-day').value = ex.day || ((ex.type === 'zhongkao') ? 24 : 7);
    // 重置到欢迎页
    setWizStep(0);
    $('wizard').classList.remove('hidden');
  }
  $('wiz-ws-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (!p) return;
    $('wiz-ws').value = p;
    // 选择文件夹后提示 docsify 存在性检测（用所选文件夹检测）
    const chk = await api.workspace.checkDocsify(p).catch(() => null);
    if (chk && !chk.exists) {
      if (await askYesNo('该文件夹未检测到 docsify 知识库（无 index.html）。\n是否立即构建/安装知识库？')) {
        showBuildModal();
      }
    } else if (chk && chk.exists) {
      toast('✅ 检测到知识库（index.html）');
    }
  });
  // 环境检测
  async function envCheck() {
    const list = $('wiz-env-list');
    if (!list) return;
    list.innerHTML = '<span class="hint">检测中…</span>';
    let r = null;
    try { r = await api.env.check(); } catch (e) { r = null; }
    if (!r || !r.ok) {
      list.innerHTML = '<span class="hint">环境检测失败</span>';
      return;
    }
    state.envCheckResult = r;
    const mk = (n, res) => {
      const okk = res && res.ok;
      return '<div class="env-item ' + (okk ? 'ok' : 'err') + '">' + n + '：' + (okk ? '✅ ' + (res.version || '已安装') : '❌ 未安装') + '</div>';
    };
    list.innerHTML = mk('Git', r.git) + mk('Node.js', r.node) + mk('npm', r.npm);
    // 有缺失环境 → 自动弹出「环境配置」（可选，可跳过；弹窗层级高于向导）
    const missing = [];
    if (!(r.git && r.git.ok)) missing.push('git');
    if (!(r.node && r.node.ok)) missing.push('node');
    if (!(r.npm && r.npm.ok)) missing.push('npm');
    if (missing.length) setTimeout(openEnvConfig, 300);
  }
  $('wiz-env-check').addEventListener('click', envCheck);
  // 环境配置弹窗（可选：可勾选具体项目 / 可指定安装位置 / 已安装也可选择重装）
  function renderEnvConfigList() {
    const el = $('env-config-list');
    if (!el) return;
    const r = state.envCheckResult || null;
    const items = [
      { key: 'git', name: 'Git', url: 'https://git-scm.com/download/win',
        info: (r && r.git && r.git.ok) ? '✅ 已安装 ' + (r.git.version || '') : '❌ 未安装' },
      { key: 'node', name: 'Node.js', url: 'https://nodejs.org/zh-cn/download',
        info: (r && r.node && r.node.ok) ? '✅ 已安装 ' + (r.node.version || '') : '❌ 未安装' },
      { key: 'npm', name: 'npm（随 Node.js 安装）', url: 'https://nodejs.org/zh-cn/download',
        info: (r && r.npm && r.npm.ok) ? '✅ 已安装 ' + (r.npm.version || '') : '❌ 未安装' }
    ];
    el.innerHTML = '';
    items.forEach((it) => {
      const existed = /✅/.test(it.info);
      const row = document.createElement('div');
      row.className = 'ec-item';
      row.innerHTML =
        '<label class="ec-check"><input type="checkbox" data-key="' + it.key + '" ' + (existed ? '' : 'checked') + ' /> 配置' + (existed ? '（重装）' : '') + '</label>' +
        '<span class="ec-name">' + it.name + '</span>' +
        '<span class="ec-status ' + (existed ? 'ok' : 'err') + '">' + it.info + '</span>';
      el.appendChild(row);
    });
  }
  function openEnvConfig() {
    renderEnvConfigList();
    $('env-config-modal').classList.remove('hidden');
  }
  $('wiz-env-config').addEventListener('click', openEnvConfig);
  $('env-config-close').addEventListener('click', () => $('env-config-modal').classList.add('hidden'));
  $('env-config-cancel').addEventListener('click', () => $('env-config-modal').classList.add('hidden'));
  $('env-config-dir-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) $('env-config-dir').value = p;
  });
  $('env-config-go').addEventListener('click', () => {
    const dir = ($('env-config-dir').value || '').trim();
    const checked = [];
    document.querySelectorAll('#env-config-list input:checked').forEach((c) => checked.push(c.dataset.key));
    if (!checked.length) { toast('请至少勾选一项要配置的环境', 3500); return; }
    const mode = (document.querySelector('input[name="env-install-mode"]:checked') || {}).value || 'cmd';
    if (mode === 'cmd') {
      // 命令安装 → 先弹「安装风险告知书」，同意后才执行
      const names = checked.map((k) => ({ git: 'Git', node: 'Node.js', npm: 'npm' }[k] || k)).join('、');
      $('risk-items').textContent = names + '（' + (dir || '默认位置') + '）';
      $('risk-agree').checked = false;
      state.envInstall = { checked, dir };
      $('env-config-modal').classList.add('hidden');
      $('risk-modal').classList.remove('hidden');
    } else {
      // 自行下载安装包安装 → 仅弹窗提示，不打开官网
      $('env-config-modal').classList.add('hidden');
      const names = checked.map((k) => ({ git: 'Git', node: 'Node.js', npm: 'npm' }[k] || k)).join('、');
      askYesNo('请自行下载并安装以下环境：' + names + '。\n\n⚠️ 请下载并【完成安装】后再启动本软件，避免环境未配置好导致服务异常。\n\n安装位置：' + (dir || '默认位置（在安装向导中自选）') + '\n安装完成后点击「重新检测」确认。').then(() => {});
    }
  });
  $('risk-close').addEventListener('click', () => $('risk-modal').classList.add('hidden'));
  $('risk-cancel').addEventListener('click', () => $('risk-modal').classList.add('hidden'));
  $('risk-ok').addEventListener('click', async () => {
    if (!$('risk-agree').checked) { toast('请先勾选同意风险告知书', 3500); return; }
    const install = state.envInstall || { checked: [], dir: '' };
    $('risk-modal').classList.add('hidden');
    toast('正在通过 winget 自动安装，可能需要几分钟，请耐心等待…', 6000);
    const r = await api.env.install({ items: install.checked, dir: install.dir });
    if (!r || !r.ok) { toast('安装失败：' + ((r && r.message) || '未知错误'), 6000); return; }
    const results = r.results || [];
    const okCount = results.filter((x) => x.ok).length;
    if (results.some((x) => !x.ok)) {
      const failed = results.filter((x) => !x.ok).map((x) => x.id + ': ' + (x.err || '失败')).join('\n');
      askYesNo('部分安装未完成：\n' + failed + '\n\n可改用「自行下载安装包安装」。').then(() => {});
    } else {
      toast(okCount ? '✅ 已自动安装 ' + okCount + ' 项。请点击「重新检测」确认。' : '未安装任何项目。', 6000);
    }
  });
  const WIZ_NEXT_LABEL = { 0: '开始配置 →', 1: '下一步：Git 配置 →', 2: '下一步：数据导入 →', 3: '下一步：阅读声明 →', 4: '下一步：阅读协议 →', 5: '下一步：完成 🎉 →' };
  let wizStep = 0;
  function setWizStep(n) {
    wizStep = n;
    for (let i = 0; i <= 6; i++) {
      const el = $('wiz-step' + i);
      if (el) el.classList.toggle('hidden', n !== i);
    }
    $('wiz-back').classList.toggle('hidden', n === 0);
    $('wiz-next').classList.toggle('hidden', n === 6);
    $('wiz-done').classList.toggle('hidden', n !== 6);
    $('wiz-next').textContent = WIZ_NEXT_LABEL[n] || '下一步 →';
    if (n === 1) envCheck();
  }
  $('wiz-next').addEventListener('click', () => {
    // 步骤4：阅读 AI 声明须先勾选确认
    if (wizStep === 4 && !$('wiz-ai-agree').checked) {
      toast('请先勾选确认已阅读 AI 相关声明', 3500);
      return;
    }
    // 步骤5：阅读协议须先勾选同意
    if (wizStep === 5 && !$('wiz-agree').checked) {
      toast('请先阅读并同意《咖啡豆子coffee的小站访客及友链协议》', 4000);
      return;
    }
    setWizStep(Math.min(6, wizStep + 1));
  });
  $('wiz-back').addEventListener('click', () => setWizStep(Math.max(0, wizStep - 1)));
  $('wiz-legal-open').addEventListener('click', (e) => {
    e.preventDefault();
    api.app.openExternal('https://studyassistant.kfdzcoffee.cn/legal.html');
  });
  $('footer-legal').addEventListener('click', (e) => {
    e.preventDefault();
    api.app.openExternal('https://studyassistant.kfdzcoffee.cn/legal.html');
  });
  // 向导内 Git 配置
  $('wiz-git-save').addEventListener('click', async () => {
    const r = await api.gitConfig.set({ name: $('wiz-git-name').value.trim(), email: $('wiz-git-email').value.trim() });
    $('wiz-git-status').textContent = r.ok ? '✅ 已保存到 Git 全局配置' : '❌ ' + (r.message || '');
    const url = $('wiz-git-remote').value.trim();
    if (url) await api.gitConfig.setRemote(url);
  });
  // 向导内测试 Git 连接 / 授权
  $('wiz-git-test').addEventListener('click', async () => {
    $('wiz-git-status').textContent = '⏳ 正在测试连接…';
    const url = $('wiz-git-remote').value.trim();
    if (url) await api.gitConfig.setRemote(url).catch(() => {});
    const r = await api.gitConfig.test();
    $('wiz-git-status').textContent = r.ok ? '✅ ' + (r.message || '连接成功，授权可用') : '❌ ' + (r.message || '测试失败');
  });
  // 向导内导入数据
  $('wiz-import').addEventListener('click', async () => {
    if (!(await askYesNo('导入数据将覆盖同名文件并应用其设置。\n确定导入吗？'))) return;
    const r = await api.data.import();
    if (r.ok) {
      $('wiz-import-status').textContent = '✅ 已导入 ' + r.written + ' 个文件';
      const cfg = await api.settings.get();
      applyConfig(cfg);
      state.records = await api.records.list();
      renderRecords();
      toast('✅ 数据已导入');
    } else if (!r.cancelled) {
      $('wiz-import-status').textContent = '❌ ' + (r.message || '导入失败');
    }
  });
  $('wiz-done').addEventListener('click', async () => {
    if (!$('wiz-agree').checked) {
      toast('请先阅读并同意《咖啡豆子coffee的小站访客及友链协议》', 4000);
      return;
    }
    const cfg = JSON.parse(JSON.stringify(state.config));
    cfg.initialized = true;
    cfg.nickname = $('wiz-nickname') ? ($('wiz-nickname').value || '').trim() : (cfg.nickname || '');
    cfg.workspacePath = $('wiz-ws').value.trim();
    cfg.exam = {
      type: $('wiz-exam-type').value,
      name: $('wiz-exam-name') ? ($('wiz-exam-name').value || '').trim() : '',
      year: Number($('wiz-exam-year').value) || 2027,
      month: Number($('wiz-exam-month').value) || 6,
      day: Number($('wiz-exam-day').value) || 7
    };
    cfg.providers = readProviderRows('wiz-providers');
    cfg.prompts.errorHelper = $('wiz-prompt-error').value;
    cfg.prompts.studyHelper = $('wiz-prompt-study').value;
    // 默认提供商 = 第一个启用的
    const first = Object.keys(cfg.providers).find((k) => cfg.providers[k].enabled);
    if (first) cfg.activeProvider = first;
    const r = await api.settings.save(cfg);
    // 初始化完成：确保自动创建默认用户并设为当前用户
    const rc = await api.users.ensureCurrent().catch(() => null);
    applyConfig(rc && rc.workspacePath ? rc : r);
    loadUsers();
    $('wizard').classList.add('hidden');
    toast('🎉 初始化完成，开始使用学习助手！');
    setTimeout(maybeOfferBuild, 600);
  });
  $('settings-wizard').addEventListener('click', () => showWizard(state.config));

  // ---------- 构建 docsify 知识库 ----------
  function showBuildModal() {
    const chk = state.docsifyCheck;
    $('build-hint').textContent = chk && chk.exists
      ? '检测到已有知识库。构建将【覆盖】index.html 以同步最新设计与组卷密码，并补齐缺失的科目/文档；已有科目数据不会丢失。'
      : '未检测到 docsify 知识库。构建后将生成与当前风格一致的错题知识库站点：';
    $('build-subjects').value = '语文,数学,英语,地理,历史,政治';
    $('build-exampwd').value = (state.config && state.config.examPassword) || '';
    $('build-files').innerHTML = '';
    $('build-proc').innerHTML = '';
    $('build-modal').classList.remove('hidden');
  }
  function closeBuildModal() { $('build-modal').classList.add('hidden'); }
  $('tb-build').addEventListener('click', showBuildModal);
  $('btn-build').addEventListener('click', showBuildModal);
  $('build-cancel').addEventListener('click', closeBuildModal);
  $('build-close').addEventListener('click', closeBuildModal);
  $('build-go').addEventListener('click', async () => {
    const subjects = $('build-subjects').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    const examPassword = $('build-exampwd').value.trim();
    const proc = $('build-proc');
    proc.innerHTML = '';
    if (!(await askYesNo('确认执行构建？\n将覆盖 index.html（同步设计/组卷密码），并创建缺失的科目档案与文档。'))) return;
    addProc(proc, '▶ 开始构建…', 'ok');
    const r = await api.workspace.buildDocsify({ subjects, examPassword });
    if (r.ok) {
      addProc(proc, '✅ 构建完成', 'ok');
      (r.overwritten || []).forEach((f) => addProc(proc, '⟳ 已更新 ' + f, 'ok'));
      (r.created || []).forEach((f) => addProc(proc, '＋ 已创建 ' + f, 'ok'));
      if (examPassword && state.config) {
        const cfg = collectSettings();
        cfg.examPassword = examPassword;
        await api.settings.save(cfg);
      }
      toast('🎉 知识库构建完成');
      setTimeout(() => closeBuildModal(), 1600);
      refreshTree();
    } else {
      addProc(proc, '✘ 构建失败：' + (r.message || ''), 'err');
    }
  });

  // ---------- 刷新 / 组卷密码 ----------
  // 刷新前确认（避免未保存内容丢失）
  function confirmReload() {
    (async () => {
      if (await askYesNo('确认要刷新吗？\n请确保你所需的内容已经保存！')) location.reload();
    })();
  }
  $('btn-refresh').addEventListener('click', confirmReload);
  $('tb-refresh').addEventListener('click', confirmReload);
  $('exampwd-apply').addEventListener('click', async () => {
    const pwd = $('set-exampwd').value;
    if (!(await askYesNo('将组卷密码写入网页 index.html？' + (pwd ? '\n新密码：' + pwd : '\n将恢复为默认密码（000000）')))) return;
    const r = await api.workspace.setExamPwd(pwd);
    toast(r.ok ? '✅ ' + (r.note || '已写入') : '❌ ' + (r.message || '失败'), 3000);
    if (r.ok) { const cfg = collectSettings(); cfg.examPassword = pwd; await api.settings.save(cfg); }
  });

  // ---------- 目标考试：类型切换时默认日期 ----------
  $('set-exam-type').addEventListener('change', () => {
    toggleExamNameField('set-exam-type', 'set-exam-name-field');
    const isZk = $('set-exam-type').value === 'zhongkao';
    const m = Number($('set-exam-month').value), d = Number($('set-exam-day').value);
    if ((isZk && m === 6 && d === 7) || (!isZk && m === 6 && d === 24)) {
      $('set-exam-month').value = 6;
      $('set-exam-day').value = isZk ? 24 : 7;
    }
  });
  $('wiz-exam-type').addEventListener('change', () => toggleExamNameField('wiz-exam-type', 'wiz-exam-name-field'));

  // ---------- 目标院校 & 主页 ----------
  let collegeData = { universities: [], about: { intro: '', website: { text: '个人网站', url: '' }, blog: { text: '个人博客', url: '' } } };
  function imgSrc(rel) {
    if (!rel) return '';
    return (state.previewUrl || '').replace(/\/$/, '') + '/' + rel;
  }
  function collegeRowHTML(u, idx) {
    return '<div class="college-row" data-i="' + idx + '">' +
      '<input class="cr-priority" value="' + (u.priority || idx + 1) + '" title="优先级(数字)" />' +
      '<input class="cr-name" value="' + escapeHtml(u.name || '') + '" placeholder="院校名称" />' +
      '<div class="cr-img" title="点击上传院校图片"><input type="file" accept="image/*" hidden />' +
      (u.image ? '<img src="' + escapeHtml(imgSrc(u.image)) + '" />' : '<span>＋图片</span>') + '</div>' +
      '<input class="cr-official" value="' + escapeHtml(u.official.url || '') + '" placeholder="官网 URL" />' +
      '<input class="cr-admissions" value="' + escapeHtml(u.admissions.url || '') + '" placeholder="本科招生网 URL" />' +
      '<button class="cr-del" title="删除">✕</button></div>';
  }
  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function renderCollege() {
    const list = $('college-list');
    list.innerHTML = '';
    collegeData.universities.forEach((u, i) => list.insertAdjacentHTML('beforeend', collegeRowHTML(u, i)));
    list.querySelectorAll('.college-row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelector('.cr-del').addEventListener('click', () => { collegeData.universities.splice(i, 1); renderCollege(); });
      const imgBox = row.querySelector('.cr-img');
      const file = imgBox.querySelector('input[type=file]');
      imgBox.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT') file.click(); });
      file.addEventListener('change', async () => {
        const f = file.files[0];
        if (!f) return;
        const r = await api.site.uploadImage({ name: f.name, data: arrayBufferToBase64(await f.arrayBuffer()) });
        if (r.ok) { collegeData.universities[i].image = r.path; renderCollege(); toast('✅ 图片已上传：' + r.path); }
        else toast('上传失败：' + r.message, 3000);
      });
    });
  }
  function collegeReadForm() {
    const rows = $('college-list').querySelectorAll('.college-row');
    const unis = [];
    rows.forEach((row) => {
      unis.push({
        priority: parseInt(row.querySelector('.cr-priority').value, 10) || 1,
        name: row.querySelector('.cr-name').value.trim(),
        image: collegeData.universities[Number(row.dataset.i)] ? collegeData.universities[Number(row.dataset.i)].image : '',
        official: { text: '官网', url: row.querySelector('.cr-official').value.trim() },
        admissions: { text: '本科招生网', url: row.querySelector('.cr-admissions').value.trim() }
      });
    });
    return {
      universities: unis,
      about: {
        intro: $('college-intro').value.trim(),
        website: { text: $('college-web-text').value.trim() || '个人网站', url: $('college-web-url').value.trim() },
        blog: { text: $('college-blog-text').value.trim() || '个人博客', url: $('college-blog-url').value.trim() }
      }
    };
  }
  async function loadCollege() {
    const r = await api.site.profile();
    if (!r.ok) { toast('读取失败：' + (r.message || ''), 3000); return; }
    collegeData = r;
    $('college-intro').value = r.about.intro || '';
    $('college-web-text').value = r.about.website.text || '个人网站';
    $('college-web-url').value = r.about.website.url || '';
    $('college-blog-text').value = r.about.blog.text || '个人博客';
    $('college-blog-url').value = r.about.blog.url || '';
    if (!collegeData.universities.length) {
      collegeData.universities = [{ priority: 1, name: '', image: '', official: { text: '官网', url: '' }, admissions: { text: '本科招生网', url: '' } }];
    }
    renderCollege();
  }
  $('college-add').addEventListener('click', () => {
    collegeData.universities.push({ priority: collegeData.universities.length + 1, name: '', image: '', official: { text: '官网', url: '' }, admissions: { text: '本科招生网', url: '' } });
    renderCollege();
  });
  $('college-save').addEventListener('click', async () => {
    const data = collegeReadForm();
    if (!(await askYesNo('确认将目标院校与介绍保存到首页 README.md？'))) return;
    const proc = $('college-proc');
    proc.innerHTML = '';
    const r = await api.site.saveProfile(data);
    if (r.ok) { addProc(proc, '✅ 已保存到 README.md', 'ok'); toast('✅ 首页已更新'); api.site.refreshStats().catch(() => {}); }
    else { addProc(proc, '✘ ' + (r.message || '保存失败'), 'err'); }
  });
  $('college-reload').addEventListener('click', loadCollege);

  // ---------- 错题统计 ----------
  async function loadStats() {
    const list = $('stats-list');
    if (!list) return;
    list.innerHTML = '<div class="hint">加载中…</div>';
    const r = await api.site.stats();
    if (!r.ok) { list.innerHTML = '<div class="hint">' + (r.message || '读取失败') + '</div>'; return; }
    const subjects = r.subjects || [];
    let errT = 0, essT = 0;
    subjects.forEach((s) => { errT += s.errors.length; essT += s.essays.length; });
    $('stats-summary').textContent = '共 ' + subjects.length + ' 科 · 错题 ' + errT + ' 道 · 作文 ' + essT + ' 篇';
    list.innerHTML = '';
    subjects.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'stat-subject';
      const errs = s.errors.map((e) => {
        const key = s.file + '#' + e.n;
        return '<div class="ss-item-row"><input type="checkbox" class="ss-cb" data-key="' + key + '" ' +
          (state.examSel.has(key) ? 'checked' : '') + ' title="加入组卷" /><span class="ss-item" data-key="' + key + '">错题 ' + e.n + '：' + escapeHtml(e.title) + '</span></div>';
      }).join('') || '<div class="ss-empty">暂无错题</div>';
      const essays = s.essays.map((e) => '<div class="ss-item" data-essay="' + encodeURIComponent(e.title) + '">' + (e.n ? '作文 ' + e.n + '：' : '') + escapeHtml(e.title) + '</div>').join('') || '<div class="ss-empty">暂无作文</div>';
      card.innerHTML = '<div class="ss-head"><span>' + escapeHtml(s.subject) + '</span><span class="ss-count">错题 ' + s.errors.length + ' · 作文 ' + s.essays.length + (s.date ? ' · 更新 ' + escapeHtml(s.date) : '') + '</span></div>' +
        '<div class="ss-body"><div class="ss-col"><div class="ss-col-title">错题（勾选加入组卷）</div>' + errs + '</div>' +
        '<div class="ss-col"><div class="ss-col-title">作文</div>' + essays + '</div></div>';
      card.querySelectorAll('.ss-cb').forEach((cb) => {
        cb.addEventListener('change', async () => {
          const m = cb.dataset.key.match(/^(.*)#(\d+)$/);
          await toggleExamSel(cb.dataset.key, m[1], Number(m[2]), cb.checked);
        });
      });
      card.querySelectorAll('.ss-item[data-key]').forEach((it) => {
        it.addEventListener('click', () => {
          const m = it.dataset.key.match(/^(.*)#(\d+)$/);
          openDetail(m[1], Number(m[2]));
        });
      });
      card.querySelectorAll('.ss-item[data-essay]').forEach((it) => {
        it.addEventListener('click', () => openSectionDetail(s.file, decodeURIComponent(it.dataset.essay)));
      });
      list.appendChild(card);
    });
    updateExamBar();
  }
  $('stats-refresh').addEventListener('click', loadStats);

  // ---------- 错题全文搜索（含题目） ----------
  let statsSearchTimer = null;
  function statsSearch() {
    const q = $('stats-search').value.trim();
    const results = $('stats-search-results');
    const list = $('stats-list');
    if (!results || !list) return;
    if (!q) { results.classList.add('hidden'); list.classList.remove('hidden'); return; }
    list.classList.add('hidden');
    results.classList.remove('hidden');
    results.innerHTML = '<div class="hint">搜索中…</div>';
    api.site.search(q).then((r) => {
      if (!r.ok) { results.innerHTML = '<div class="hint">搜索失败：' + escapeHtml(r.message || '') + '</div>'; return; }
      const ms = r.matches || [];
      if (!ms.length) { results.innerHTML = '<div class="hint">未找到包含「' + escapeHtml(q) + '」的错题</div>'; return; }
      const total = ms.length > 100 ? '（仅显示前 100 条）' : '';
      results.innerHTML = '<div class="hint">找到 ' + ms.length + ' 条匹配' + total + '</div>';
      ms.slice(0, 100).forEach((m) => {
        const row = document.createElement('div');
        row.className = 'search-hit';
        row.innerHTML = '<div class="sh-line"><span class="sh-tag">' + escapeHtml(m.subject) + ' · 错题 ' + m.n + '</span><span class="sh-title">' + escapeHtml(m.title) + '</span></div>' +
          (m.snippet ? '<div class="sh-snippet">' + escapeHtml(m.snippet) + '</div>' : '');
        row.addEventListener('click', () => openDetail(m.file, m.n));
        results.appendChild(row);
      });
    });
  }
  $('stats-search').addEventListener('input', () => {
    clearTimeout(statsSearchTimer);
    statsSearchTimer = setTimeout(statsSearch, 250);
  });
  $('stats-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(statsSearchTimer); statsSearch(); } });

  // ---------- 通用：按标题定位小节 ----------
  function extractSectionByNeedle(content, needle) {
    const lines = String(content || '').split('\n');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,4}\s/.test(lines[i]) && lines[i].indexOf(needle) !== -1) { start = i; break; }
    }
    if (start === -1) return null;
    const lvl = lines[start].match(/^#+/)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{1,4})\s+/);
      if (m && m[1].length <= lvl) { end = i; break; }
    }
    return { title: lines[start].replace(/^#{1,4}\s*/, '').trim(), md: lines.slice(start, end).join('\n').trim() };
  }
  async function openSectionDetail(file, needle) {
    const r = await api.workspace.read(file);
    if (!r.ok) { toast('读取失败：' + r.message, 3000); return; }
    const sec = extractSectionByNeedle(r.content, needle);
    $('detail-file').textContent = file;
    renderMd($('detail-body'), sec ? sec.md : r.content);
    $('detail-sel').checked = false;
    $('detail-modal').classList.remove('hidden');
  }

  // ---------- 错题详情 & 组卷 ----------
  function extractErrorSection(content, n) {
    const lines = String(content || '').split('\n');
    const headRe = new RegExp('^#{2,4}\\s*错题\\s*' + n + '\\s*[：:]');
    let start = -1;
    for (let i = 0; i < lines.length; i++) if (headRe.test(lines[i])) { start = i; break; }
    if (start === -1) return null;
    const lvl = lines[start].match(/^#+/)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const m = lines[i].match(/^(#{2,4})\s+/);
      if (m && m[1].length <= lvl) { end = i; break; }
    }
    return { title: lines[start].replace(/^#{2,4}\s*/, '').trim(), md: lines.slice(start, end).join('\n').trim() };
  }
  function updateExamBar() {
    const c = $('exam-sel-count');
    if (c) c.textContent = '已选 ' + state.examSel.size + ' 题';
  }
  function syncExamCheckboxes() {
    document.querySelectorAll('.ss-cb').forEach((cb) => { cb.checked = state.examSel.has(cb.dataset.key); });
  }
  async function toggleExamSel(key, file, n, checked) {
    if (!checked) { state.examSel.delete(key); updateExamBar(); return; }
    const r = await api.workspace.read(file);
    if (!r.ok) { toast('读取失败：' + r.message, 3000); return; }
    const sec = extractErrorSection(r.content, n);
    if (!sec) { toast('未找到错题 ' + n, 3000); return; }
    state.examSel.set(key, { file: file, n: n, title: sec.title, md: sec.md });
    updateExamBar();
  }
  async function openDetail(file, n) {
    const r = await api.workspace.read(file);
    if (!r.ok) { toast('读取失败：' + r.message, 3000); return; }
    const sec = extractErrorSection(r.content, n);
    $('detail-file').textContent = file + ' · 错题 ' + n;
    if (sec) renderMd($('detail-body'), sec.md);
    else $('detail-body').innerHTML = '<div class="hint">未找到该题内容</div>';
    state.detailKey = file + '#' + n;
    state.detailFile = file;
    state.detailN = n;
    $('detail-sel').checked = state.examSel.has(state.detailKey);
    $('detail-modal').classList.remove('hidden');
  }
  // ---------- 组卷：拆分题干/答案/解析/同类题 ----------
  function splitSection(md) {
    const lines = String(md || '').split('\n');
    const body = [], analysis = [], similar = [], answer = [];
    let region = 'body';
    for (const line of lines) {
      if (/^#{1,4}\s*错题/.test(line)) continue; // 标题单独使用
      if (/(同类题变形|同类题巩固|同类题警示|同类题)/.test(line)) { region = 'similar'; }
      else if (/(错因分析|正确解法|关键步骤|错误原因|评分明细|错因逐条)/.test(line)) { region = 'analysis'; }
      else if (/^\s*(\*\*)?(正确)?答案(\*\*)?\s*[：:]/.test(line)) { region = 'answer'; }
      if (region === 'body') body.push(line);
      else if (region === 'answer') answer.push(line);
      else if (region === 'similar') similar.push(line);
      else analysis.push(line);
    }
    return {
      body: body.join('\n').trim(),
      analysisMd: analysis.join('\n').trim(),
      answerMd: answer.join('\n').trim(),
      similarMd: similar.join('\n').trim()
    };
  }
  function stripSource(md) {
    return String(md || '').split('\n').filter((l) => !/录入时间|录入日期|来源[：:]|^\s*-\s*\*\*来源\*\*|^\s*-\s*来源/.test(l)).join('\n').trim();
  }
  function openExamModal() {
    if (!state.examSel.size) { toast('请先勾选错题'); return; }
    const subj = Array.from(new Set(Array.from(state.examSel.values()).map((q) => q.file.replace(/\.md$/, ''))));
    const d = new Date();
    const ds = d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
    $('exam-name').value = subj.join('+') + '错题组卷 ' + ds;
    $('exam-count').textContent = state.examSel.size;
    $('exam-modal').classList.remove('hidden');
  }
  function closeExamModal() { $('exam-modal').classList.add('hidden'); }
  // 剥离 Markdown 分隔线（---），避免 Word 对每个 <hr/> 分页导致“一行一页”
  function stripHr(md) {
    return String(md || '').split('\n').filter((l) => !/^\s*([-*_])\s*\1{2,}\s*$/.test(l)).join('\n');
  }
  function doGenExam() {
    if (!state.examSel.size) { toast('请先勾选错题'); return; }
    const name = $('exam-name').value.trim() || '错题组卷';
    const optSource = $('exam-opt-source').checked;
    const optAnswer = $('exam-opt-answer').checked;
    const optAnalysis = $('exam-opt-analysis').checked;
    const optSimilar = $('exam-opt-similar').checked;
    const optSeparate = $('exam-opt-separate').checked;
    const items = Array.from(state.examSel.values()).map((q) => Object.assign({}, q, splitSection(q.md)));
    const d = new Date();
    const dateStr = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="utf-8"><title>' + escapeHtml(name) + '</title>';
    html += '<style>@page{size:A4;margin:2cm 2.2cm;} body{font-family:"Microsoft YaHei","SimSun",serif;font-size:12pt;line-height:1.7;color:#000;} h1{font-size:16pt;text-align:center;margin:0 0 6pt 0;} .subtitle{text-align:center;font-size:10.5pt;color:#666;margin:0 0 18pt 0;} h3,h4{font-size:12.5pt;margin:14pt 0 6pt 0;page-break-after:avoid;} p{margin:0 0 5pt 0;} table{border-collapse:collapse;width:100%;margin:6pt 0;} table td,table th{border:1pt solid #000;padding:4pt 6pt;font-size:11pt;} blockquote{margin:4pt 0 4pt 10pt;padding-left:8pt;border-left:2pt solid #ccc;color:#444;} pre{background:#f5f5f5;padding:8pt;border-radius:4pt;font-size:10.5pt;margin:6pt 0;} .qsep{margin:0 0 14pt 0;padding-bottom:8pt;border-bottom:1pt solid #ddd;} .qsep.q-body{page-break-inside:avoid;} .ans-head{page-break-before:always;font-size:16pt;text-align:center;margin:0 0 14pt 0;color:#1f4e9c;}</style>';
    html += '</head><body>';
    html += '<h1>' + escapeHtml(name) + '</h1>';
    html += '<p class="subtitle">共 ' + items.length + ' 题 | 生成时间：' + dateStr + '</p>';
    // 题干部分（每题一个块，内部避免分页；无显式 <hr>，用边框分隔）
    items.forEach((q, i) => {
      html += '<div class="qsep q-body">';
      html += '<h3>' + (i + 1) + '. ' + escapeHtml(q.title) + '</h3>';
      html += window.Markdown.render(stripHr(optSource ? q.body : stripSource(q.body)));
      html += '</div>';
    });
    // 答案与解析（默认另起一页：分页符放在单个 h2 标题上，而非外层容器。
    // 原因：Word 会把容器 div 的 page-break-before:always 错误传播到其内部每个
    // 段落，导致“解析一页一行”；放在标题元素上只分页一次，答案解析自然跨页流动）
    if (optAnalysis || optAnswer || optSimilar) {
      html += '<h2 class="ans-head" style="margin-top:0;page-break-before:' + (optSeparate ? 'always' : 'auto') + ';">参考答案与解析</h2>';
      items.forEach((q, i) => {
        const parts = [];
        if (optAnswer && q.answerMd) parts.push(q.answerMd);
        if (optAnalysis && q.analysisMd) parts.push(q.analysisMd);
        if (optSimilar && q.similarMd) parts.push(q.similarMd);
        if (!parts.length) return;
        html += '<div class="qsep q-ans">';
        html += '<h3>' + (i + 1) + '. ' + escapeHtml(q.title) + '</h3>';
        html += window.Markdown.render(stripHr(parts.join('\n\n')));
        html += '</div>';
      });
    }
    html += '</body></html>';
    const blob = new Blob(['\ufeff' + html], { type: 'application/msword;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\/:*?"<>|]/g, '_') + '.doc';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    closeExamModal();
  }
  $('detail-close').addEventListener('click', () => $('detail-modal').classList.add('hidden'));
  $('detail-sel').addEventListener('change', async (e) => {
    await toggleExamSel(state.detailKey, state.detailFile, state.detailN, e.target.checked);
    syncExamCheckboxes();
    updateExamBar();
  });
  $('detail-gen').addEventListener('click', openExamModal);
  $('detail-edit').addEventListener('click', () => { $('detail-modal').classList.add('hidden'); openInEditor(state.detailFile); switchView('archive'); });
  $('exam-gen').addEventListener('click', openExamModal);
  $('exam-modal-close').addEventListener('click', closeExamModal);
  $('exam-modal-cancel').addEventListener('click', closeExamModal);
  $('exam-modal-go').addEventListener('click', doGenExam);
  $('exam-clear').addEventListener('click', () => {
    state.examSel.clear();
    syncExamCheckboxes();
    updateExamBar();
    toast('已清空组卷选择');
  });

  // ---------- 网页预览刷新（销毁重建，避免 reload 失效/卡死） ----------
  function refreshPreview() {
    const container = $('view-preview');
    const old = $('preview');
    let url = '';
    try { if (old && old.getURL) url = old.getURL(); } catch (e) {}
    if (!url && state.previewUrl) url = state.previewUrl;
    if (url) {
      const base = url.split('#')[0];
      const hash = url.indexOf('#') !== -1 ? url.slice(url.indexOf('#')) : '';
      url = base + (base.indexOf('?') !== -1 ? '&' : '?') + 't=' + Date.now() + hash;
    }
    if (old) old.remove();
    const wv = document.createElement('webview');
    wv.id = 'preview';
    wv.className = 'preview-web';
    if (url) wv.src = url;
    container.appendChild(wv);
    webview = wv;
  }
  $('preview-refresh').addEventListener('click', refreshPreview);

  // ---------- docsify 检测 ----------
  async function maybeOfferBuild() {
    const cfg = state.config;
    if (!cfg || !cfg.workspacePath) return;
    try {
      const chk = await api.workspace.checkDocsify();
      state.docsifyCheck = chk;
      if (chk && !chk.exists) showBuildModal();
    } catch (e) { /* ignore */ }
  }

  // ---------- 导航 ----------
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  // ---------- 启动 ----------
  async function init() {
    const cfg = await api.settings.get();
    if (cfg) applyConfig(cfg);
    $('ws-tag').textContent = cfg.workspacePath ? '📁 ' + cfg.workspacePath : '📁 未设置';
    state.previewUrl = await api.preview.getUrl();
    if (state.previewUrl) webview.src = state.previewUrl;
    renderQuote();
    updateCountdown();
    focusClock.main = buildFlipClock('focus-clock');
    focusClock.big = buildFlipClock('focus-clock-big');
    focusRender();
    state.records = await api.records.list();
    renderRecords();
    renderQueue();
    refreshTree();
    gitStatus();
    switchView('home');
    if (cfg.initialized) maybeOfferBuild();
  }
  init();
})();
