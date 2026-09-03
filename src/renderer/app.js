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
    detailKey: '', detailFile: '', detailN: 0,
    detailList: [], detailIdx: -1, // 详情切换：当前错题所在列表及位置
    entryAttachments: [], // 录入时待上传的附件（{name, dataUrl}）
    essayDraft: null, // 作文草稿 { file, content }：改变的内容展示版
    localModelCatalog: []
  };

  // 熟悉程度标签（与 error-bank 的 FAMILIARITY 对应）
  const FAMILIARITY_LABEL = {
    unfamiliar: '生疏',
    vague: '模糊',
    medium: '中等',
    familiar: '熟悉',
    mastered: '掌握'
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
  const VIEW_TITLES = { home: '首页', chat: 'AI 助手', entry: '错题录入', essay: '作文分析', score: '分数预测', college: '目标院校', todos: '任务待办', vocab: '生词本', review: '词语复习', wenyan: '文言文', papers: '试卷', stats: '错题统计', archive: '档案编辑', git: 'Git 同步', preview: '网页预览', users: '用户', settings: '设置' };
  function switchView(name) {
    state.currentView = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === name);
    });
    // 若目标视图在收起的分组内，自动展开该分组
    document.querySelectorAll('.nav-group').forEach((g) => {
      if (g.querySelector('.nav-item[data-view="' + name + '"]')) g.open = true;
    });
    const t = $('tb-title'); if (t) t.textContent = VIEW_TITLES[name] || name;
    if (name === 'preview') loadPreview();
    if (name === 'archive') refreshTree();
    if (name === 'git') gitStatus();
    if (name === 'stats') loadStats();
    if (name === 'college') loadCollege();
    if (name === 'users') loadUsers();
    if (name === 'settings') loadGitConfig();
    if (name === 'todos') loadTodos();
    if (name === 'vocab') loadVocab();
    if (name === 'review') loadReview();
    if (name === 'wenyan') loadWenyan();
    if (name === 'papers') loadPapers();
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
      const c = String(res.content || '').trim();
      if (c) {
        if (resultEl) md(resultEl, c);
      } else if (state.didWrite) {
        if (resultEl) resultEl.innerHTML = '<div class="proc-line ok">✅ 内容已写入档案（AI 未返回文本，可到「档案编辑」查看修改）</div>';
        toast('✅ 已写入档案', 3000);
      } else {
        if (resultEl) resultEl.innerHTML = '<div class="proc-line err">✘ AI 未返回内容，请重试或更换模型 / 检查本地服务</div>';
        toast('AI 未返回内容', 4000);
      }
      renderPostGit(res, mode, resultEl);
      // 需要写文件的模式却未写入（常见于本地模型不支持工具调用）→ 提示用户
      if (!state.didWrite && mode !== 'chat' && mode !== 'learn-notes' && resultEl) {
        const tip = document.createElement('div');
        tip.className = 'proc-line';
        tip.innerHTML = '<span class="hint">💡 本次未写入档案。若该模型不支持工具调用，可复制上方内容，或用「加入待录入区」草稿模式生成后统一写入。</span>';
        resultEl.appendChild(tip);
      }
    } else {
      if (resultEl) resultEl.innerHTML = '<div class="proc-line err">✘ ' + escapeHtml(res.message) + '</div>';
      toast('任务失败：' + res.message, 4000);
    }
    if (mode !== 'chat' && resultEl) switchDone(resultEl);
    // 写文件后刷新首页题目统计与侧边栏
    if (res.ok && state.didWrite && mode !== 'chat') {
      api.site.refreshStats().catch(() => {});
      api.site.syncSidebar().catch(() => {});
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
    if (state.config && state.config.modelRuntime && state.config.modelRuntime.mode === 'local') return 'local';
    const cfg = state.config;
    const list = Object.values(cfg.providers).filter((p) => p.enabled && p.apiKey);
    if (list.length === 0) return cfg.activeProvider || 'deepseek';
    const active = cfg.providers[cfg.activeProvider];
    if (active && active.enabled && active.apiKey) return active.id;
    return list[0].id;
  }

  // ---------- 附件压缩（canvas 压缩为 JPEG，节省存储空间） ----------
  // 将图片文件压缩为 dataUrl；长边超过 maxDim 则等比缩放，质量 quality
  function compressImageFile(file, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          let w = img.width, h = img.height;
          const m = maxDim || 1600;
          if (Math.max(w, h) > m) {
            const r = m / Math.max(w, h);
            w = Math.round(w * r); h = Math.round(h * r);
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality || 0.72));
        };
        img.onerror = () => reject(new Error('图片解析失败'));
        img.src = reader.result;
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  }
  // 渲染录入区附件预览
  function renderEntryAttachments() {
    const wrap = $('entry-attach-preview');
    if (!wrap) return;
    if (!state.entryAttachments.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = state.entryAttachments.map((a, i) =>
      '<div class="attach-thumb"><img src="' + a.dataUrl + '" /><button type="button" class="at-del" data-i="' + i + '">✕</button></div>'
    ).join('');
    wrap.querySelectorAll('.at-del').forEach((b) => {
      b.addEventListener('click', () => {
        state.entryAttachments.splice(parseInt(b.dataset.i, 10), 1);
        renderEntryAttachments();
      });
    });
  }
  // 上传附件到指定错题（压缩后）
  async function uploadAttachments(number) {
    const list = state.entryAttachments;
    if (!list.length) return 0;
    let ok = 0;
    for (const a of list) {
      const r = await api.errorBank.addAttachment(number, { name: a.name, dataUrl: a.dataUrl }).catch(() => null);
      if (r && r.ok) ok++;
    }
    return ok;
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
    const tool = $('confirm-tool');
    tool.querySelector('use').setAttribute('href', '#i-tool');
    $('confirm-tool-text').textContent = req.tool + (req.target ? '  →  ' + req.target : '');
    $('confirm-summary').textContent = req.summary || 'AI 请求执行以下操作';
    const diffEl = $('confirm-diff');
    diffEl.innerHTML = '';
    if (req.oldContent == null && req.newContent) {
      diffEl.innerHTML = '<div class="diff-line add">＋（新文件）</div>';
    } else {
      renderDiff(diffEl, req.oldContent || '', req.newContent || '');
    }
    // 写文件类操作：提供可编辑区，让用户直接修改 AI 生成的内容后再确认
    const editable = ['write_file', 'append_to_file', 'create_subject'].indexOf(req.tool) !== -1;
    const editField = $('confirm-edit-field');
    const editEl = $('confirm-edit');
    if (editable && editField && editEl) {
      editEl.value = req.newContent || '';
      editField.classList.remove('hidden');
    } else if (editField) {
      editField.classList.add('hidden');
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
    const editField = $('confirm-edit-field');
    const editEl = $('confirm-edit');
    const edited = (editField && !editField.classList.contains('hidden') && editEl) ? editEl.value : undefined;
    hideConfirm();
    if (r) api.app.confirmResponse(r.id, true, edited);
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
      const tool = $('confirm-tool');
      tool.querySelector('use').setAttribute('href', '#i-help-circle');
      $('confirm-tool-text').textContent = '确认操作';
      $('confirm-summary').textContent = text;
      const d = $('confirm-diff');
      d.innerHTML = '<div class="hint">该操作由你主动发起，确认后将自动依次执行。</div>';
      const editField = $('confirm-edit-field');
      if (editField) editField.classList.add('hidden');
      $('confirm-approve').textContent = '确认执行';
      $('confirm-reject').textContent = '取消';
      $('confirm-modal').classList.remove('hidden');
    });
  }

  // ---------- 通用输入弹窗（替代 window.prompt，Electron 渲染进程不支持 prompt） ----------
  let inputResolve = null;
  function askInput(opts) {
    return new Promise((resolve) => {
      inputResolve = resolve;
      $('input-title').textContent = (opts && opts.title) || '输入';
      $('input-desc').textContent = (opts && opts.desc) || '';
      $('input-label').textContent = (opts && opts.label) || '名称';
      const v = $('input-value');
      v.value = (opts && opts.value) || '';
      v.placeholder = (opts && opts.placeholder) || '请输入…';
      $('input-modal').classList.remove('hidden');
      setTimeout(() => { v.focus(); v.select(); }, 30);
    });
  }
  function hideInput() {
    $('input-modal').classList.add('hidden');
    inputResolve = null;
  }
  $('input-ok').addEventListener('click', () => {
    const r = inputResolve;
    const val = $('input-value').value;
    hideInput();
    if (r) r(val);
  });
  $('input-cancel').addEventListener('click', () => {
    const r = inputResolve;
    hideInput();
    if (r) r(null);
  });
  $('input-close').addEventListener('click', () => {
    const r = inputResolve;
    hideInput();
    if (r) r(null);
  });
  $('input-value').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('input-ok').click(); }
    if (e.key === 'Escape') { e.preventDefault(); $('input-cancel').click(); }
  });

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
    '不积跬步，无以至千里；不积小流，无以成江海。',
    '把每一天当作最后冲刺的一天，全力以赴，不留遗憾。',
    '好好学习，天天向上。今天的努力，是明天的底气。',
    '乾坤未定，你我皆是黑马。',
    '那些看似不起波澜的日复一日，会在某天让你看到坚持的意义。',
    '关关难过关关过，前路漫漫亦灿灿。',
    '你背过的每一个单词、算过的每一道题，都不会辜负你。',
    '星光不问赶路人，时光不负有心人。',
    '现在流的每一滴汗，都是给未来铺的路；现在偷的每一个懒，都是给未来挖的坑。',
    '心之所向，素履以往；生如逆旅，一苇以航。'
  ];
  let quoteIdx = -1;
  function renderQuote() {
    if (quoteIdx < 0) {
      const d = new Date();
      quoteIdx = (d.getFullYear() * 372 + d.getMonth() * 31 + d.getDate()) % QUOTES.length;
    }
    $('home-quote').textContent = QUOTES[quoteIdx];
  }
  $('quote-refresh').addEventListener('click', () => {
    quoteIdx = (quoteIdx + 1) % QUOTES.length;
    $('home-quote').textContent = QUOTES[quoteIdx];
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
  // 加载错题组到下拉框
  async function loadEntryGroups() {
    const sel = $('entry-group');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    try {
      const r = await api.errorBank.groups();
      if (r && r.ok && Array.isArray(r.groups)) {
        r.groups.forEach((g) => {
          const o = document.createElement('option');
          o.value = g.name;
          o.textContent = g.name;
          sel.appendChild(o);
        });
      }
    } catch (e) { /* 忽略 */ }
    // 默认选中「默认」错题组
    if (cur) sel.value = cur;
    else if (Array.from(sel.options).some((o) => o.value === '默认')) sel.value = '默认';
  }
  loadEntryGroups();
  bindImage('entry-img', 'entry-img-btn', 'entry-img-name', 'entry-img-preview', state,
    { ocrBtn: 'entry-ocr', ocrAuto: 'entry-ocr-auto', target: 'entry-question', editBtn: 'entry-img-edit' });
  // 附件上传（可多张，压缩后随错题保存）
  $('entry-attach-btn').addEventListener('click', () => $('entry-attach').click());
  $('entry-attach').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    $('entry-attach-name').textContent = '压缩中…';
    for (const f of files) {
      try {
        const dataUrl = await compressImageFile(f, 1600, 0.72);
        state.entryAttachments.push({ name: f.name, dataUrl });
      } catch (err) { toast('附件处理失败：' + err.message, 3000); }
    }
    $('entry-attach-name').textContent = state.entryAttachments.length + ' 个附件';
    renderEntryAttachments();
    e.target.value = '';
  });
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
      await addToQueue(res.content, subject, $('entry-subject').value === '其他（新建科目）' && $('entry-newsubj-essay').checked);
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
    state.entryAttachments = [];
    renderEntryAttachments();
    $('entry-attach-name').textContent = '';
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
    const type = f.title || '错题';
    // 生成正文（不含标题行，error-bank 会自动生成「#### 错题 N：类型」标题）
    const body = buildManualEntry(Object.assign({}, f, { n: 'N' })).replace(/^####\s*错题\s*N\s*[：:]\s*[^\n]*\n?/, '').trim();
    const res = await api.errorBank.add({
      type, subject: f.subject, familiarity: 'medium', group: '',
      source: f.source, date: f.date, content: body,
      hasEssay: $('manual-subject').value === '其他（新建科目）' && $('manual-newsubj-essay').checked
    });
    if (res && res.ok && res.error) {
      renderMd($('manual-preview'), buildManualEntry(Object.assign({}, f, { n: 'N' })));
      $('manual-status').textContent = '✅ 已录入 ' + f.subject + ' · ' + type + '（' + res.error.number + '），可继续录入下一题';
      toast('✅ 已录入 ' + f.subject + ' · ' + type);
      ['manual-title', 'manual-source', 'manual-question', 'manual-reason', 'manual-solution', 'manual-answer', 'manual-tip', 'manual-similar'].forEach((i) => $(i).value = '');
      api.site.refreshStats().catch(() => {});
      api.site.syncSidebar().catch(() => {});
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
  async function addToQueue(content, subject, hasEssay) {
    state.pendingQueue.push({
      id: Date.now() + Math.random().toString(36).slice(2, 7),
      subject: subject || '未知',
      title: extractTitle(content),
      content: content || '',
      hasEssay: !!hasEssay
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
    // 记录成功写入的项（用于从待录入区移除 + 关联试卷）
    const written = [];
    // 录入时选择的熟悉程度 / 错题组 / 来源 / 日期
    const familiarity = $('entry-familiarity') ? $('entry-familiarity').value : 'medium';
    const group = $('entry-group') ? $('entry-group').value : '';
    const source = $('entry-source') ? $('entry-source').value.trim() : '';
    const date = $('entry-date') ? $('entry-date').value : '';
    for (const subject of Object.keys(grouped)) {
      const items = grouped[subject];
      for (const item of items) {
        // 从草稿 content 提取题目类型（标题行冒号后）与正文
        let content = item.content || '';
        let type = item.title || '';
        const hm = content.match(/^#{1,4}\s*错题\s*\d*\s*[：:]\s*(.*)$/m);
        if (hm) { type = (hm[1] || '').trim() || type; content = content.replace(/^#{1,4}\s*错题\s*\d*\s*[：:]\s*[^\n]*\n?/, '').trim(); }
        const r = await api.errorBank.add({
          type, subject, familiarity, group, source, date, content,
          hasEssay: item.hasEssay
        });
        if (r && r.ok && r.error) {
          state.didWrite = true;
          written.push({ subject, number: r.error.number, title: type });
          addProc(proc, '✅ 已录入 ' + subject + ' · ' + type + '（' + r.error.number + '）', 'ok');
        } else {
          addProc(proc, '❌ 录入失败 ' + subject + ' · ' + type + '：' + ((r && r.message) || '未知错误'), 'err');
        }
      }
    }
    // 只移除成功写入的项（失败项保留，便于重试）
    if (written.length) {
      const writtenContent = new Set(written.map((w) => w.subject + '|' + (w.title || '')));
      state.pendingQueue = state.pendingQueue.filter((item) => !writtenContent.has(item.subject + '|' + (item.title || '')));
    }
    // 上传录入时选择的附件（关联到本次成功写入的第一道错题）
    if (written.length && state.entryAttachments.length) {
      const first = written[0].number;
      const n = await uploadAttachments(first);
      if (n) addProc(proc, '📎 已保存 ' + n + ' 个附件到 ' + first, 'ok');
      state.entryAttachments = [];
      renderEntryAttachments();
      $('entry-attach-name').textContent = '';
    }
    // 关联所选试卷（手选）—— 双向关联：错题库侧 linkedPapers + 试卷侧 linkedErrors
    const paperId = $('entry-paper') ? $('entry-paper').value : '';
    if (paperId && written.length) {
      const paper = papersData.find((x) => x.id === paperId);
      for (const w of written) {
        await api.errorBank.linkPaper(w.number, { id: paperId, name: paper ? paper.name : '', subject: paper ? paper.subject : '' }).catch(() => {});
        await api.papers.linkError(paperId, { number: w.number, title: w.title, subject: w.subject }).catch(() => {});
      }
      addProc(proc, '📄 已关联 ' + written.length + ' 道错题到试卷', 'ok');
      loadPapers();
    }
    renderQueue();
    refreshTree();
    api.site.refreshStats().catch(() => {});
    api.site.syncSidebar().catch(() => {});
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

  // 解析 AI 草稿（目标文件 + 内容块），展示「改变的内容 · 展示版」
  function setupEssayDraft(content) {
    const raw = String(content || '');
    let file = '';
    let body = raw.trim();
    const fm = raw.match(/目标文件：\s*([^\n]+)/);
    if (fm) file = fm[1].trim();
    const bm = raw.match(/---\s*内容开始\s*---\n([\s\S]*?)\n---\s*内容结束\s*---/);
    if (bm && bm[1].trim()) body = bm[1].trim();
    // 未给出目标文件时按科目推断
    if (!file) {
      const subj = ($('essay-subject') || {}).value || '';
      file = (subj.indexOf('英语') !== -1) ? '英语.md' : '语文.md';
    }
    if (!/\.md$/i.test(file)) file = file.replace(/[^\w\u4e00-\u9fa5.-]/g, '') + '.md';
    state.essayDraft = { file, content: body };
    $('essay-draft-meta').textContent = '目标文件：' + file + '（合并时将追加到档案末尾）';
    md($('essay-draft-view'), body);
    $('essay-draft-edit').value = body;
    $('essay-draft-edit').style.display = 'none';
    $('essay-draft-view').style.display = '';
    $('essay-draft-edit-btn').innerHTML = '<svg class="ic"><use href="#i-edit"/></svg> 编辑';
    $('essay-draft-cancel-btn').classList.add('hidden');
    $('essay-draft').classList.remove('hidden');
    $('essay-draft').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // 编辑 / 完成编辑：切换预览与可编辑 textarea
  function toggleEssayDraftEdit() {
    const d = state.essayDraft;
    if (!d) return;
    const editBtn = $('essay-draft-edit-btn');
    const cancelBtn = $('essay-draft-cancel-btn');
    const isEditing = $('essay-draft-edit').style.display !== 'none';
    if (!isEditing) {
      $('essay-draft-edit').style.display = '';
      $('essay-draft-view').style.display = 'none';
      editBtn.innerHTML = '<svg class="ic"><use href="#i-check"/></svg> 完成编辑';
      cancelBtn.classList.remove('hidden');
    } else {
      // 保存编辑 → 回到预览
      d.content = $('essay-draft-edit').value;
      md($('essay-draft-view'), d.content);
      $('essay-draft-edit').style.display = 'none';
      $('essay-draft-view').style.display = '';
      editBtn.innerHTML = '<svg class="ic"><use href="#i-edit"/></svg> 编辑';
      cancelBtn.classList.add('hidden');
    }
  }

  // 取消编辑：还原为上次保存的内容
  function cancelEssayDraftEdit() {
    const d = state.essayDraft;
    if (!d) return;
    $('essay-draft-edit').value = d.content;
    $('essay-draft-edit').style.display = 'none';
    $('essay-draft-view').style.display = '';
    $('essay-draft-edit-btn').innerHTML = '<svg class="ic"><use href="#i-edit"/></svg> 编辑';
    $('essay-draft-cancel-btn').classList.add('hidden');
  }

  // 从作文草稿内容提取元信息（标题 / 得分 / 等级 / 类型 / 时间 / 来源）
  function parseEssayMeta(content, topic) {
    const c = String(content || '');
    const t = String(topic || '').trim();
    let title = '';
    // 优先取草稿小节标题（### 作文 N：标题）
    const hd = c.match(/^#{2,4}\s*(?:作文|练习作文|考场作文|新作文)[^：:\n]*[：:]\s*([^\n]+)/m);
    if (hd) { const s = hd[1].trim().replace(/[《》]/g, ''); title = s ? '《' + s + '》' : ''; }
    // 其次取正文中的《…》
    if (!title) { const tm = c.match(/《([^》]*)》/); if (tm) title = '《' + tm[1] + '》'; }
    // 再次取用户填写的题目
    if (!title && t) { const tm2 = t.match(/《([^》]*)》/); title = tm2 ? '《' + tm2[1] + '》' : '《' + t + '》'; }
    if (!title) title = '《新作文》';
    let score = '';
    const sm = c.match(/\*\*总分[（(]?\d*[）)]?\*\*\s*\|\s*\*?\*?(\d+(?:\.\d+)?)/);
    if (sm) score = sm[1];
    else { const sm2 = c.match(/总分[（(]?\d*[）)]?\s*\|\s*\*?\*?(\d+(?:\.\d+)?)/); if (sm2) score = sm2[1]; }
    let grade = '';
    const gm = c.match(/(一类|二类|三类|四类)/);
    if (gm) grade = gm[1];
    else { const gnum = parseInt(score, 10); if (!isNaN(gnum)) { if (gnum >= 42) grade = '一类'; else if (gnum >= 33) grade = '二类'; else if (gnum >= 25) grade = '三类'; else grade = '四类'; } }
    let type = /考场/.test(c + ' ' + t) ? '考场' : '练习';
    const now = new Date();
    const time = now.getFullYear() + '.' + (now.getMonth() + 1);
    let source = t || '—';
    const srcm = c.match(/来源[：:]\s*([^\n]+)/);
    if (srcm) source = srcm[1].trim();
    return { title, score, grade, type, time, source };
  }

  // 在档案顶部「作文档案总览」表格末尾追加一行
  function appendEssayOverviewRow(md, row) {
    const re = /(\|\s*序号\s*\|[^\n]*\n(?:\|[^\n]*\n)+)/;
    const m = md.match(re);
    if (!m) return md;
    return md.replace(re, m[1].replace(/\n+$/, '') + '\n' + row + '\n');
  }

  // 计算档案中现有作文最大编号 + 1（优先读「作文档案总览」表格序号列）
  function nextEssayNumber(md) {
    let max = 0, m;
    // 1) 总览表格序号列（| 7 | 2026.8 | …）
    const tableRe = /(\|\s*序号\s*\|[^\n]*\n(?:\|[^\n]*\n)+)/;
    const tm = md.match(tableRe);
    if (tm) {
      tm[0].split('\n').forEach((r) => { const cm = r.match(/^\|\s*(\d+)\s*\|/); if (cm) max = Math.max(max, parseInt(cm[1], 10)); });
    }
    // 2) 作文 N
    const r1 = /作文\s*(\d+)/g; while ((m = r1.exec(md))) max = Math.max(max, parseInt(m[1], 10));
    // 3) X.Y 编号作文小节
    const r2 = /^#{2,4}\s*(\d+)\.\d+\s*《/gm; while ((m = r2.exec(md))) max = Math.max(max, parseInt(m[1], 10));
    return max + 1;
  }

  // 合并到文档：规范化作文小节 → 更新「作文档案总览」表格 → 追加正文 → 询问 push
  async function mergeEssayDraft() {
    const d = state.essayDraft;
    if (!d || !d.file || !(d.content || '').trim()) { toast('没有可合并的内容', 3000); return; }
    const meta = parseEssayMeta(d.content, ($('essay-topic') || {}).value);
    const rd = await api.workspace.read(d.file).catch(() => null);
    if (!rd || !rd.ok) { toast('读取档案失败：' + ((rd && rd.message) || d.file), 4000); return; }
    let mdContent = rd.content;
    const n = nextEssayNumber(mdContent);
    // 规范化正文：统一为可识别的作文小节格式「### 作文 N：标题」
    let body = d.content.trim();
    if (!/^#{2,4}\s*(?:作文|练习作文|考场作文|新作文)/.test(body)) {
      body = '### 作文 ' + n + '：' + meta.title.replace(/[《》]/g, '') + '\n\n' + body;
    } else {
      body = body.replace(/^(#{2,4}\s*)(?:作文|练习作文|考场作文|新作文)[^：:\n]*[：:]\s*/, '$1作文 ' + n + '：');
    }
    // 更新顶部「作文档案总览」表格
    const row = '| ' + n + ' | ' + meta.time + ' | ' + meta.type + ' | ' + (meta.source || '—') + ' | ' + meta.title + ' | ' + (meta.score || '—') + ' | ' + (meta.grade || '—') + ' |';
    mdContent = appendEssayOverviewRow(mdContent, row);
    const nowStr = new Date().toLocaleString('zh-CN', { hour12: false });
    const finalMd = mdContent.replace(/\n*$/, '') + '\n\n---\n\n' + body + '\n\n---\n\n*最后更新：' + nowStr + '（合并作文' + meta.title + '分析）*\n';
    const r = await api.workspace.write(d.file, finalMd).catch(() => null);
    if (!r || !r.ok) { toast('合并失败：' + ((r && r.message) || '未知错误'), 4000); return; }
    toast('✅ 已合并到 ' + d.file + '（作文 ' + n + '，总览表格已更新）');
    state.didWrite = true;
    api.site.refreshStats().catch(() => {});
    api.site.syncSidebar().catch(() => {});
    $('essay-draft').classList.add('hidden');
    // 弹窗询问是否 push（gitFlowAuto 内部会弹窗确认）
    await gitFlowAuto();
  }

  $('essay-draft-edit-btn').addEventListener('click', toggleEssayDraftEdit);
  $('essay-draft-cancel-btn').addEventListener('click', cancelEssayDraftEdit);
  $('essay-draft-merge').addEventListener('click', mergeEssayDraft);

  $('essay-submit').addEventListener('click', async () => {
    const subject = $('essay-subject').value;
    const topic = $('essay-topic').value.trim();
    const essay = $('essay-text').value.trim();
    const region = $('essay-region') ? $('essay-region').value.trim() : '';
    const total = $('essay-total') ? $('essay-total').value.trim() : '';
    const draftMode = $('essay-draft-mode') ? $('essay-draft-mode').checked : true;
    let text = '科目：' + subject + '\n';
    if (region) text += '地区：' + region + '\n';
    if (total) text += '总分：' + total + '\n';
    if (topic) text += '作文题目/来源：' + topic + '\n';
    text += (essay ? '作文全文：\n' + essay : '作文全文以附图为准') + '\n\n请按既有作文档案格式进行评分明细、错因逐条分析，并提供纵向与横向对比，写入对应科目档案。' + (region ? '评分时请参考' + region + '当地作文评分标准。' : '') + (total ? '按满分' + total + '分评分。' : '');
    $('essay-draft').classList.add('hidden'); // 清掉上一次草稿展示
    const res = await runTask({
      mode: 'essay-analysis', text, imageBuf: state.imageBuf,
      procEl: $('essay-proc'), resultEl: $('essay-result'), statusEl: $('essay-status'),
      draftOnly: draftMode
    });
    state.imageBuf = null;
    // 草稿模式：展示「改变的内容 · 展示版」+ 编辑 / 合并到文档按钮
    if (res && res.ok && draftMode && String(res.content || '').trim()) {
      setupEssayDraft(res.content);
    }
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
    const isLocal = /localhost|127\.0\.0\.1/.test(String(p.baseUrl || ''));
    return '<div class="wiz-provider" data-id="' + p.id + '">' +
      '<div class="wp-head">' +
      '<input type="checkbox" data-f="enabled" ' + (p.enabled ? 'checked' : '') + ' />' +
      '<span>' + (p.name || p.id || '提供商') + '</span>' +
      '<span class="hint">' + (p.vision ? '🖼 支持图片' : '') + ' · ' + (p.kind === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容') + (isLocal ? ' · 🏠 本地' : '') + '</span>' +
      '</div>' +
      '<div class="wp-grid">' +
      '<div class="full"><input data-f="baseUrl" value="' + p.baseUrl + '" placeholder="Base URL" /></div>' +
      '<div class="full"><input data-f="model" value="' + p.model + '" list="models-' + p.id + '" placeholder="模型（可从下拉选择预设）" /></div>' +
      '<datalist id="models-' + p.id + '">' + opts + '</datalist>' +
      '<div class="full"><input data-f="apiKey" type="password" value="' + (p.apiKey || '') + '" placeholder="' + (isLocal ? '本地部署无需填写，留空即可' : 'API Key（密钥环加密）') + '" /></div>' +
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

  function runtimeModeFromUi() {
    return $('runtime-mode-local') && $('runtime-mode-local').checked ? 'local' : 'api';
  }

  function setLocalModeUi(mode) {
    const local = mode === 'local';
    const box = $('local-model-box');
    if (box) box.style.opacity = local ? '1' : '.8';
    const st = $('local-state');
    if (st && !local && !st.textContent) st.textContent = '当前为云端 API 模式。';
  }

  function renderLocalCatalog(selectedId) {
    const sel = $('local-model-id');
    if (!sel) return;
    const list = state.localModelCatalog || [];
    sel.innerHTML = list.map((m) =>
      '<option value="' + m.id + '">' +
      m.name + '｜' + (m.vision ? '视觉' : '文本') + '｜' + (m.size || '') +
      '</option>'
    ).join('');
    if (selectedId) sel.value = selectedId;
    if (!sel.value && list.length) sel.value = list[0].id;
    const m = list.find((x) => x.id === sel.value);
    if ($('local-model-license')) {
      $('local-model-license').textContent = m
        ? ('推荐配置：' +
          (m.recommended && m.recommended.cpuCores ? ('CPU>=' + m.recommended.cpuCores + '核') : '') + ' ' +
          (m.recommended && m.recommended.ramGB ? ('内存>=' + m.recommended.ramGB + 'GB') : '') + ' ' +
          (m.recommended && m.recommended.vramGB ? ('显存>=' + m.recommended.vramGB + 'GB') : '') +
          (m.notes ? ('；说明：' + m.notes) : ''))
        : '';
    }
  }

  async function refreshLocalRuntimeStatus() {
    const st = $('local-state');
    const r = await api.localModel.state().catch(() => null);
    if (!st) return;
    if (!r || !r.ok) {
      st.textContent = '状态读取失败';
      return;
    }
    const run = r.running ? '运行中' : '未运行';
    const installed = (r.installed || []).length;
    const rt = r.runtime && r.runtime.ok ? '内置引擎可用' : '内置引擎缺失（请先 npm install）';
    st.textContent = '状态：' + run + '；已缓存模型目录：' + installed + '；' + rt;
  }

  async function loadLocalCatalog(selectedId) {
    const r = await api.localModel.catalog().catch(() => null);
    state.localModelCatalog = (r && r.ok && Array.isArray(r.models)) ? r.models : [];
    renderLocalCatalog(selectedId);
    await refreshLocalRuntimeStatus();
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
    applyFont(cfg.fontCn, cfg.fontEn);
    const tvEl = $('set-todo-view'); if (tvEl) tvEl.value = cfg.todoView || 'list';
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
    const mr = Object.assign({ mode: 'api', local: {} }, cfg.modelRuntime || {});
    const localCfg = Object.assign({ enabled: true, selectedModelId: 'qwen2.5-1.5b', modelStorePath: '', idlePolicy: 'idle_5m', idleMinutes: 5 }, mr.local || {});
    if ($('runtime-mode-api')) $('runtime-mode-api').checked = mr.mode !== 'local';
    if ($('runtime-mode-local')) $('runtime-mode-local').checked = mr.mode === 'local';
    if ($('local-enabled')) $('local-enabled').checked = !!localCfg.enabled;
    if ($('local-model-dir')) $('local-model-dir').value = localCfg.modelStorePath || '';
    if ($('local-idle-policy')) $('local-idle-policy').value = localCfg.idlePolicy || 'idle_5m';
    if ($('local-idle-minutes')) $('local-idle-minutes').value = Number(localCfg.idleMinutes) || 5;
    setLocalModeUi(mr.mode);
    loadLocalCatalog(localCfg.selectedModelId).catch(() => {});
    // 云端同步配置
    const syncCfg = cfg.sync || {};
    const se = $('sync-enabled'); if (se) se.checked = !!syncCfg.enabled;
    const ss = $('sync-server'); if (ss) ss.value = syncCfg.serverUrl || '';
    const su = $('sync-username'); if (su) su.value = syncCfg.username || '';
    const sa = $('sync-auto'); if (sa) sa.checked = syncCfg.autoSync !== false;
    const st = $('sync-status');
    if (st) {
      if (syncCfg.token) st.textContent = '已登录' + (syncCfg.lastSync ? '，上次同步：' + new Date(syncCfg.lastSync).toLocaleString() : '');
      else st.textContent = '未登录。配置服务器地址与账号后点击「登录」。';
    }
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
    loadTodos();
    loadCollegeCarousel();
    loadPapers();
    if (!cfg.initialized) showWizard(cfg);
    // 启动后自动检查更新（仅已初始化时，延迟等界面与版本信息就绪）
    if (cfg.initialized) setTimeout(checkForUpdateSilent, 2000);
  }

  api.app.onConfig(applyConfig);
  api.preview.getUrl().then((u) => { state.previewUrl = u; });
  api.app.onPreviewUrl((u) => { state.previewUrl = u; });

  // ---------- 界面字体（设置 → 外观） ----------
  let fontList = [];
  function applyFont(cn, en) {
    const root = document.documentElement;
    // 中文字体：仅中文字体（不含西文字体，避免西文字体被中文字体覆盖）
    if (cn) {
      root.style.setProperty('--font-cn', '"' + cn + '", "HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif');
    } else {
      root.style.setProperty('--font-cn', '"HarmonyOS Sans", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif');
    }
    // 西文字体：仅西文字体（不含中文字体，确保西文字符使用西文字体）
    if (en) {
      root.style.setProperty('--font-en', '"' + en + '", "Segoe UI", "Helvetica Neue", Arial, sans-serif');
    } else {
      root.style.setProperty('--font-en', '"Segoe UI", "Helvetica Neue", Arial, sans-serif');
    }
    const selCn = $('set-font-cn');
    if (selCn) selCn.value = cn || '';
    const selEn = $('set-font-en');
    if (selEn) selEn.value = en || '';
  }
  function fillFontSelect(sel, current) {
    if (!sel) return;
    sel.innerHTML = '<option value="">默认</option>';
    for (const fam of fontList) {
      const opt = document.createElement('option');
      opt.value = fam;
      opt.textContent = fam;
      sel.appendChild(opt);
    }
    if (current) {
      const exists = Array.from(sel.options).some((o) => o.value === current);
      sel.value = exists ? current : '';
    }
  }
  async function loadFonts() {
    const selCn = $('set-font-cn');
    const selEn = $('set-font-en');
    if (!selCn && !selEn) return;
    const curCn = selCn ? selCn.value : '';
    const curEn = selEn ? selEn.value : '';
    try {
      if (window.queryLocalFonts) {
        const fonts = await window.queryLocalFonts();
        const seen = new Set();
        fontList = [];
        for (const f of fonts) {
          const fam = (f.family || '').trim();
          if (!fam || seen.has(fam)) continue;
          seen.add(fam);
          fontList.push(fam);
        }
        fontList.sort((a, b) => a.localeCompare(b, 'zh'));
      } else {
        // 兜底：常用中文字体
        fontList = ['微软雅黑', 'Microsoft YaHei', '宋体', 'SimSun', '黑体', 'SimHei', '楷体', 'KaiTi', '仿宋', 'FangSong', 'HarmonyOS Sans SC', 'PingFang SC', 'Noto Sans SC', 'Source Han Sans SC', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Consolas'];
      }
    } catch (e) {
      console.error('加载字体失败：', e);
    }
    fillFontSelect(selCn, curCn);
    fillFontSelect(selEn, curEn);
  }
  $('font-refresh').addEventListener('click', loadFonts);
  $('set-font-cn').addEventListener('change', async () => {
    const cfg = collectSettings();
    applyFont(cfg.fontCn, cfg.fontEn);
    await api.settings.save(cfg);
  });
  $('set-font-en').addEventListener('change', async () => {
    const cfg = collectSettings();
    applyFont(cfg.fontCn, cfg.fontEn);
    await api.settings.save(cfg);
  });
  loadFonts();

  function collectSettings() {
    const cfg = JSON.parse(JSON.stringify(state.config || {}));
    const wsEl = $('user-ws'); if (wsEl) cfg.workspacePath = wsEl.value.trim();
    cfg.theme = $('set-theme').value;
    cfg.fontCn = $('set-font-cn').value;
    cfg.fontEn = $('set-font-en').value;
    const tvEl = $('set-todo-view'); if (tvEl) cfg.todoView = tvEl.value;
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
    cfg.modelRuntime = {
      mode: runtimeModeFromUi(),
      local: {
        enabled: $('local-enabled') ? $('local-enabled').checked : true,
        selectedModelId: $('local-model-id') ? $('local-model-id').value : 'qwen2.5-1.5b',
        modelStorePath: $('local-model-dir') ? $('local-model-dir').value.trim() : '',
        idlePolicy: $('local-idle-policy') ? $('local-idle-policy').value : 'idle_5m',
        idleMinutes: Math.max(1, Number(($('local-idle-minutes') || {}).value) || 5)
      }
    };
    // 云端同步配置
    const se = $('sync-enabled'), ss = $('sync-server'), su = $('sync-username'), sa = $('sync-auto');
    if (se && ss && su && sa) {
      cfg.sync = Object.assign({}, cfg.sync || {}, {
        enabled: se.checked,
        serverUrl: ss.value.trim(),
        username: su.value.trim(),
        autoSync: sa.checked
      });
    }
    return cfg;
  }

  $('settings-save').addEventListener('click', async () => {
    const cfg = collectSettings();
    const r = await api.settings.save(cfg);
    applyConfig(r);
    toast('✅ 设置已保存');
  });

  if ($('runtime-mode-api')) $('runtime-mode-api').addEventListener('change', () => setLocalModeUi(runtimeModeFromUi()));
  if ($('runtime-mode-local')) $('runtime-mode-local').addEventListener('change', () => setLocalModeUi(runtimeModeFromUi()));
  if ($('local-model-id')) $('local-model-id').addEventListener('change', () => renderLocalCatalog(($('local-model-id') || {}).value));
  if ($('local-model-dir-btn')) $('local-model-dir-btn').addEventListener('click', async () => {
    const r = await api.localModel.chooseDir().catch(() => null);
    if (r && r.ok && $('local-model-dir')) $('local-model-dir').value = r.path || '';
  });
  if ($('local-refresh')) $('local-refresh').addEventListener('click', async () => {
    await loadLocalCatalog(($('local-model-id') || {}).value);
    toast('已刷新本机模型状态');
  });
  if ($('local-start')) $('local-start').addEventListener('click', async () => {
    const r = await api.localModel.start().catch(() => null);
    toast(r && r.ok ? '本机模型已加载' : '加载失败：' + ((r && r.message) || '未知错误'));
    await refreshLocalRuntimeStatus();
  });
  if ($('local-stop')) $('local-stop').addEventListener('click', async () => {
    const r = await api.localModel.stop().catch(() => null);
    toast(r && r.ok ? '本机模型已释放' : '释放失败：' + ((r && r.message) || '未知错误'));
    await refreshLocalRuntimeStatus();
  });

  // ---------- 本机模型安装向导 ----------
  const lwState = { step: 1, envResult: null, device: null, selectedModelId: '' };
  function lwSetStep(n) {
    lwState.step = n;
    document.querySelectorAll('.lw-pane').forEach((p) => p.classList.toggle('hidden', Number(p.dataset.lwPane) !== n));
    document.querySelectorAll('.lw-step').forEach((s) => s.classList.toggle('active', Number(s.dataset.lwStep) === n));
    const back = $('lw-back'), next = $('lw-next'), done = $('lw-done');
    if (back) back.classList.toggle('hidden', n === 1);
    if (next) next.classList.toggle('hidden', n === 4);
    if (done) done.classList.toggle('hidden', n !== 4);
    if (n === 1) lwEnvCheck();
    if (n === 2) lwDeviceDetect();
    if (n === 3) lwRenderModels();
  }
  function lwOpen() {
    lwState.step = 1;
    $('local-wizard-modal').classList.remove('hidden');
    lwSetStep(1);
  }
  function lwClose() { $('local-wizard-modal').classList.add('hidden'); }
  if ($('local-wizard-open')) $('local-wizard-open').addEventListener('click', lwOpen);
  if ($('local-wizard-close')) $('local-wizard-close').addEventListener('click', lwClose);

  // 步骤1：系统依赖检测
  async function lwEnvCheck() {
    const items = $('lw-env-items');
    if (!items) return;
    items.innerHTML = '<span class="hint">检测中…</span>';
    const r = await api.env.check().catch(() => null);
    if (!r || !r.ok) { items.innerHTML = '<span class="hint">环境检测失败</span>'; return; }
    lwState.envResult = r;
    const defs = [
      { key: 'git', name: 'Git', url: 'https://git-scm.com/download/win' },
      { key: 'node', name: 'Node.js', url: 'https://nodejs.org/zh-cn/download' },
      { key: 'npm', name: 'npm（随 Node.js 安装）', url: 'https://nodejs.org/zh-cn/download' }
    ];
    items.innerHTML = '';
    defs.forEach((d) => {
      const res = r[d.key] || {};
      const okk = !!res.ok;
      const row = document.createElement('div');
      row.className = 'env-item ' + (okk ? 'ok' : 'err');
      row.innerHTML =
        '<label class="ec-check"><input type="checkbox" data-key="' + d.key + '" ' + (okk ? '' : 'checked') + ' /> 配置' + (okk ? '（重装）' : '') + '</label>' +
        '<span class="ec-name">' + d.name + '</span>' +
        '<span class="ec-status ' + (okk ? 'ok' : 'err') + '">' + (okk ? '✅ ' + (res.version || '已安装') : '❌ 未安装') + '</span>';
      items.appendChild(row);
    });
    const missing = defs.filter((d) => !(r[d.key] && r[d.key].ok)).map((d) => d.name).join('、');
    const st = $('lw-env-status');
    if (st) st.textContent = missing ? '检测到缺失：' + missing + '。可点击「下一步」前先补齐，或直接继续（缺失依赖可能影响部分功能）。' : '✅ 系统依赖齐全。';
  }
  if ($('lw-env-check')) $('lw-env-check').addEventListener('click', lwEnvCheck);
  if ($('lw-env-dir-btn')) $('lw-env-dir-btn').addEventListener('click', async () => {
    const p = await api.settings.chooseWorkspace();
    if (p) $('lw-env-dir').value = p;
  });

  // 步骤2：设备检测
  async function lwDeviceDetect() {
    const box = $('lw-device-result');
    if (!box) return;
    box.innerHTML = '<span class="hint">检测中…</span>';
    const id = lwState.selectedModelId || (state.localModelCatalog && state.localModelCatalog[0] && state.localModelCatalog[0].id) || 'qwen2.5-1.5b';
    const r = await api.localModel.detect(id).catch(() => null);
    if (!r || !r.ok) { box.innerHTML = '<span class="hint">设备检测失败</span>'; return; }
    lwState.device = r;
    const d = r.device || {};
    const gpu = (d.gpus && d.gpus.length) ? d.gpus.map((g) => g.name + ' ' + g.vramGB + 'GB').join(' / ') : '未检测到独立显卡';
    const dep = r.runtime && r.runtime.ok ? '内置引擎：可用' : '内置引擎：缺失（请先 npm install）';
    box.innerHTML =
      '<div class="lw-device-row"><span>CPU</span><b>' + d.cpuCores + ' 核</b></div>' +
      '<div class="lw-device-row"><span>内存</span><b>' + d.ramGB + ' GB</b></div>' +
      '<div class="lw-device-row"><span>显卡</span><b>' + gpu + '</b></div>' +
      '<div class="lw-device-row"><span>平台</span><b>' + (d.platform || '') + ' / ' + (d.arch || '') + '</b></div>' +
      '<div class="lw-device-row"><span>内置引擎</span><b>' + dep + '</b></div>' +
      '<div class="lw-device-verdict ' + (r.recommended ? 'ok' : 'err') + '">' +
      (r.recommended ? '✅ 当前设备达到所选模型推荐配置。' : '⚠️ 未达推荐配置：' + (r.reasons || []).join('；')) +
      '</div>';
  }
  if ($('lw-device-detect')) $('lw-device-detect').addEventListener('click', lwDeviceDetect);

  // 步骤3：模型列表
  function lwRenderModels() {
    const box = $('lw-model-list');
    if (!box) return;
    const list = state.localModelCatalog || [];
    box.innerHTML = '';
    list.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'lw-model-card' + (lwState.selectedModelId === m.id ? ' active' : '');
      card.dataset.id = m.id;
      const rec = m.recommended || {};
      card.innerHTML =
        '<div class="lw-model-head"><b>' + m.name + '</b><span class="lw-model-tag">' + (m.vision ? '视觉' : '文本') + '</span></div>' +
        '<div class="lw-model-meta">' + (m.size || '') + ' · ' + (m.license || '') + '</div>' +
        '<div class="lw-model-note">' + (m.notes || '') + '</div>' +
        '<div class="lw-model-rec">推荐：CPU>=' + (rec.cpuCores || '-') + '核 内存>=' + (rec.ramGB || '-') + 'GB' + (rec.vramGB ? ' 显存>=' + rec.vramGB + 'GB' : '') + '</div>';
      card.addEventListener('click', () => {
        lwState.selectedModelId = m.id;
        lwRenderModels();
      });
      box.appendChild(card);
    });
    if (!lwState.selectedModelId && list.length) lwState.selectedModelId = list[0].id;
  }

  // 步骤4：安装
  function lwLogLine(text) {
    const log = $('lw-install-log');
    if (!log) return;
    const line = document.createElement('div');
    line.className = 'lw-log-line';
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  function lwSetProgress(pct, text) {
    const bar = $('lw-install-bar'), pctEl = $('lw-install-pct');
    const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
    if (bar) bar.style.width = v + '%';
    if (pctEl) pctEl.textContent = v + '%';
    if (text) lwLogLine(text);
  }
  // 监听安装进度事件（主进程推送）
  api.localModel.onProgress((p) => {
    if (!p) return;
    const status = $('lw-install-status');
    const pct = Number(p.progress);
    if (p.status === 'download' && pct > 0) {
      lwSetProgress(pct * 100, (p.message || '') + (p.file ? ' ' + p.file : ''));
      if (status) status.textContent = '正在下载模型 ' + (p.file || '') + ' … ' + Math.round(pct * 100) + '%';
    } else if (p.status === 'progress' && pct > 0) {
      lwSetProgress(pct * 100, (p.message || '') + (p.file ? ' ' + p.file : ''));
      if (status) status.textContent = '正在加载模型 ' + (p.file || '') + ' … ' + Math.round(pct * 100) + '%';
    } else if (p.message) {
      lwLogLine(p.message);
    }
  });
  async function lwInstall() {
    const id = lwState.selectedModelId;
    if (!id) { toast('请先选择模型'); return; }
    const status = $('lw-install-status'), bar = $('lw-install-bar'), tip = $('lw-install-tip');
    const log = $('lw-install-log');
    if (log) log.innerHTML = '';
    if (status) status.textContent = '正在检测设备…';
    if (bar) bar.style.width = '10%';
    lwSetProgress(10, '开始安装 ' + id);
    const det = await api.localModel.detect(id).catch(() => null);
    if (!det || !det.ok) { if (status) status.textContent = '设备检测失败'; return; }
    if (det.runtime && !det.runtime.ok) {
      if (status) status.textContent = '❌ ' + (det.runtime.message || '缺少内置推理依赖，请先 npm install');
      return;
    }
    let force = false;
    if (!det.recommended) {
      force = await askYesNo('当前设备未达推荐配置，不建议安装。\n' + (det.reasons || []).join('\n') + '\n\n是否仍继续安装？');
      if (!force) { if (status) status.textContent = '已取消安装。'; return; }
    }
    if (status) status.textContent = '正在下载并安装模型（首次下载较慢，请耐心等待）…';
    if (bar) bar.style.width = '30%';
    if (tip) tip.textContent = '模型将缓存到本地目录，安装完成后可离线使用。';
    lwSetProgress(30, '开始下载模型文件…');
    const r = await api.localModel.install(id, force).catch(() => null);
    if (r && r.ok) {
      lwSetProgress(100, '✅ 模型安装完成');
      if (bar) bar.style.width = '100%';
      if (status) status.textContent = '✅ 模型安装完成！可点击「完成」关闭向导，或返回上一步继续安装其他模型。';
      if (tip) tip.textContent = '';
      await refreshLocalRuntimeStatus();
    } else {
      if (status) status.textContent = '❌ 安装失败：' + ((r && r.message) || '未知错误');
      if (tip) tip.textContent = '可返回上一步重新选择模型，或检查网络后重试。';
      lwLogLine('❌ 安装失败：' + ((r && r.message) || '未知错误'));
    }
  }
  if ($('lw-back')) $('lw-back').addEventListener('click', () => lwSetStep(Math.max(1, lwState.step - 1)));
  if ($('lw-next')) $('lw-next').addEventListener('click', () => {
    if (lwState.step === 1) {
      // 补齐缺失依赖（勾选的项目）
      const checked = [];
      document.querySelectorAll('#lw-env-items input:checked').forEach((c) => checked.push(c.dataset.key));
      if (checked.length) {
        const dir = ($('lw-env-dir').value || '').trim();
        const st = $('lw-env-status');
        if (st) st.textContent = '正在通过 winget 自动安装依赖，请稍候…';
        api.env.install({ items: checked, dir }).then((r) => {
          if (st) {
            if (r && r.ok) {
              const okCount = (r.results || []).filter((x) => x.ok).length;
              st.textContent = okCount ? '✅ 已自动安装 ' + okCount + ' 项依赖。' : '未安装任何项目。';
            } else {
              st.textContent = '依赖安装失败：' + ((r && r.message) || '未知错误') + '。可继续下一步。';
            }
          }
        });
      }
    }
    const next = Math.min(4, lwState.step + 1);
    lwSetStep(next);
    // 进入安装步骤时自动开始安装
    if (next === 4) lwInstall();
  });
  if ($('lw-done')) $('lw-done').addEventListener('click', lwClose);

  // ---------- 云端同步 ----------
  const syncCfgFromForm = () => ({
    serverUrl: ($('sync-server') || {}).value || '',
    username: ($('sync-username') || {}).value || '',
    password: ($('sync-password') || {}).value || '',
    enabled: !!($('sync-enabled') || {}).checked,
    autoSync: !!($('sync-auto') || {}).checked
  });
  const setSyncStatus = (msg, type) => {
    const st = $('sync-status');
    if (st) { st.textContent = msg; st.style.color = type === 'err' ? 'var(--red, #ef4444)' : (type === 'ok' ? 'var(--green, #22c55e)' : ''); }
  };
  // 测试连接
  const syncTestBtn = $('sync-test');
  if (syncTestBtn) syncTestBtn.addEventListener('click', async () => {
    const cfg = syncCfgFromForm();
    if (!cfg.serverUrl) { setSyncStatus('请先填写服务器地址', 'err'); return; }
    setSyncStatus('正在测试连接…');
    const r = await api.sync.test(cfg);
    setSyncStatus(r.ok ? '✅ ' + r.message : '❌ ' + r.message, r.ok ? 'ok' : 'err');
  });
  // 登录
  const syncLoginBtn = $('sync-login');
  if (syncLoginBtn) syncLoginBtn.addEventListener('click', async () => {
    const cfg = syncCfgFromForm();
    if (!cfg.serverUrl || !cfg.username || !cfg.password) { setSyncStatus('请填写服务器地址、账号和密码', 'err'); return; }
    setSyncStatus('正在登录…');
    const r = await api.sync.login(cfg);
    if (r.ok) {
      setSyncStatus('✅ 登录成功，已保存 token', 'ok');
      // 保存配置（含 token）
      const full = collectSettings();
      full.sync = Object.assign({}, full.sync || {}, { token: r.token, lastSync: new Date().toISOString() });
      await api.settings.save(full);
      applyConfig(full);
      toast('✅ 云端登录成功');
    } else {
      setSyncStatus('❌ ' + r.message, 'err');
    }
  });
  // 立即同步
    // 渲染同步结果到面板
  const renderSyncResult = (results) => {
    const box = $('sync-result');
    if (!box) return;
    if (!results || !results.length) { box.style.display = 'none'; return; }
    let html = '';
    results.forEach((r) => {
      const icon = r.ok ? '✓' : '✗';
      const color = r.ok ? '#22c55e' : '#ef4444';
      let detail = '';
      if (r.ok) {
        detail = '推送 ' + (r.pushed || 0) + ' 条，云端 ' + (r.records || 0) + ' 条' + (r.changed ? '（已更新本地）' : '');
      } else {
        detail = r.message || '失败';
      }
      html += '<div style="color:' + color + '">' + icon + ' ' + (r.label || r.collection) + '：' + detail + '</div>';
    });
    box.innerHTML = html;
    box.style.display = 'block';
  };
  // 刷新各视图数据
  const refreshAllViews = () => {
    loadTodos(); loadUsers(); loadPapers();
    if (typeof loadVocab === 'function') loadVocab();
    if (typeof loadWenyan === 'function') loadWenyan();
    if (typeof loadStats === 'function') loadStats();
  };
  // 立即同步
  const syncNowBtn = $('sync-now');
  if (syncNowBtn) syncNowBtn.addEventListener('click', async () => {
    const cfg = syncCfgFromForm();
    setSyncStatus('正在同步…');
    const r = await api.sync.all(cfg);
    if (r.ok) {
      const okCount = r.results.filter((x) => x.ok).length;
      setSyncStatus('✓ 同步完成：' + okCount + '/' + r.results.length + ' 个集合成功', 'ok');
      toast('云端同步完成');
      renderSyncResult(r.results);
      refreshAllViews();
    } else {
      setSyncStatus('✗ ' + (r.message || '同步失败，请检查网络或服务器'), 'err');
      toast('同步失败：' + (r.message || '未知错误'));
      renderSyncResult(r.results);
    }
  });
  // 检测差异
  const syncDiffBtn = $('sync-diff');
  if (syncDiffBtn) syncDiffBtn.addEventListener('click', async () => {
    const cfg = syncCfgFromForm();
    setSyncStatus('正在检测本地与云端差异…');
    const r = await api.sync.diff(cfg);
    if (r.ok) {
      const box = $('sync-result');
      if (box) {
        let html = '';
        r.results.forEach((x) => {
          if (!x.ok) { html += '<div style="color:#ef4444">✗ ' + (x.label || x.collection) + '：' + (x.message || '检测失败') + '</div>'; return; }
          const parts = [];
          parts.push('本地 ' + x.localCount + ' 条');
          parts.push('云端 ' + x.cloudCount + ' 条');
          if (x.localNewer) parts.push('本地较新 ' + x.localNewer);
          if (x.cloudNewer) parts.push('云端较新 ' + x.cloudNewer);
          if (x.onlyLocal) parts.push('仅本地 ' + x.onlyLocal);
          if (x.onlyCloud) parts.push('仅云端 ' + x.onlyCloud);
          if (x.conflict) parts.push('同时修改 ' + x.conflict);
          html += '<div>' + (x.label || x.collection) + '：' + parts.join('，') + '</div>';
        });
        box.innerHTML = html;
        box.style.display = 'block';
      }
      setSyncStatus('✓ 差异检测完成', 'ok');
    } else {
      setSyncStatus('✗ ' + (r.message || '检测失败'), 'err');
    }
  });
  // 从云端下载（覆盖本地）
  const syncDownloadBtn = $('sync-download');
  if (syncDownloadBtn) syncDownloadBtn.addEventListener('click', async () => {
    const cfg = syncCfgFromForm();
    if (!confirm('将从云端下载数据并覆盖本地文件，本地未同步的修改可能丢失。确定继续？')) return;
    setSyncStatus('正在从云端下载…');
    const r = await api.sync.download(cfg);
    if (r.ok) {
      const okCount = r.results.filter((x) => x.ok).length;
      setSyncStatus('✓ 下载完成：' + okCount + '/' + r.results.length + ' 个集合', 'ok');
      toast('已从云端下载数据');
      renderSyncResult(r.results);
      refreshAllViews();
    } else {
      setSyncStatus('✗ ' + (r.message || '下载失败'), 'err');
      renderSyncResult(r.results);
    }
  });

  // 设置页：左侧分类导航切换
  document.querySelectorAll('.settings-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.settings-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.querySelector('.settings-pane[data-pane="' + btn.dataset.pane + '"]');
      if (pane) pane.classList.add('active');
    });
  });

  $('set-theme').addEventListener('change', async () => {
    const cfg = collectSettings();
    document.documentElement.dataset.theme = cfg.theme;
    updateTitleBarOverlay();
    await api.settings.save(cfg);
  });
  const tvSel = $('set-todo-view');
  if (tvSel) tvSel.addEventListener('change', async () => {
    const cfg = collectSettings();
    await api.settings.save(cfg);
    loadTodos();
    toast('✅ 待办展示方式已更新');
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
    { name: 'adm-zip', url: 'https://github.com/cthackers/adm-zip', desc: '数据导出/导入的 ZIP 打包与解压' },
    { name: 'docx', url: 'https://github.com/dolanmiu/docx', desc: 'Word 文档（.docx）导出（MIT 许可）' },
    { name: 'Feather Icons', url: 'https://github.com/feathericons/feather', desc: '界面图标库（MIT 许可）' },
    { name: 'ECDICT', url: 'https://github.com/skywind3000/ECDICT', desc: '简明英汉词典数据库（76 万词条，MIT 许可，允许商用）' }
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
    current: 'v1.10.0',
    history: [
      { v: 'v1.10.0', date: '2026-09-03', items: [
        '🎉 大版本更新：新增「积累」三件套 —— 生词本（英语单词 / 短语生义，多词性 + 例句，可关联词族，导出 Word 生词卷）、文言文（字 / 词生义与例句来源，导出 Word）、词语复习（艾宾浩斯遗忘曲线自动安排复习，中英 / 英中双向测验，拼写错误自动重置进度，可导出复习卷）',
        '新增「试卷管理」：保存试卷本体与答题卡图片，AI 智能分析试卷，试卷与错题可互相关联',
        '生成试卷升级：支持「按试卷（取其关联错题）/ 按错题组 / 手动勾选 / 按科目随机」四种组卷方式',
        '新增「任务待办」：优先级、日期、循环任务（每天 / 每周 / 每两周 / 每月），支持日历视图；首页新增「今日待办」可直接勾选完成',
        '新增「云端同步」：配套自建服务器后端（server/：账号注册登录、鉴权、加密、管理后台），同步生词本、文言文、待办、专注记录、错题库；电脑端本地为权威、云端备份中转，支持多端',
        '本机 AI 模型重大改进：改为软件内置推理引擎（Transformers.js），无需 API Key、数据不出本机、支持视觉识别（不再依赖 Ollama 程序）',
        '修复本机模型「安装失败」：模型下载切换至国内镜像（hf-mirror.com），无需科学上网即可下载；模型列表精简为镜像可稳定下载的 4 款（Qwen2.5 1.5B / Qwen2.5 0.5B / Phi-3 Mini / Moondream2 视觉），安装向导带进度条',
        '错题管理增强：熟悉程度可批量设置，新增错题组分类管理（新建 / 移动 / 删除）',
        '整体界面与交互优化：弹窗过渡、布局间距、生词本 / 待办等列表体验提升'
      ] },
      { v: 'v1.9.1', date: '2026-08-17', items: [
        '本地 AI（Ollama）全面适配：新增「本地」提供商、无需 API Key；思考模型适配（content 为空时自动用思考结果兜底）；不支持工具调用的模型自动降级，不再报错',
        '确认弹窗可直接编辑 AI 生成的内容后再确认写入',
        'AI 需要补充信息时会自动弹窗提问并继续任务，不再误判为「完成」',
        '错题统计新增「删除错题」（二次确认，同步更新侧边栏）',
        '录入 / 删除错题后自动同步侧边栏（_sidebar.md）'
      ] },
      { v: 'v1.9.0', date: '2026-08-14', items: [
        '新增「本地」AI 提供商：适配本地 AI 模型（Ollama 兼容接口 http://localhost:11434/v1），无需 API Key、数据不出本机',
        '启动时自动检测新版本：发现新版弹窗提醒，可一键下载安装',
        '更新下载进度弹窗「下一曲即将奏响！」：实时显示下载进度，可关闭弹窗不中断下载、随时再次打开查看'
      ] },
      { v: 'v1.8.9', date: '2026-08-14', items: [
        '新增「本地」AI 提供商：适配本地 AI 模型（Ollama 兼容接口 http://localhost:11434/v1），无需 API Key、数据不出本机',
        '启动时自动检测新版本：发现新版弹窗提醒，可一键下载安装'
      ] },
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
  // ---------- 更新下载进度（下一曲即将奏响） ----------
  const dlState = { active: false, percent: 0, received: 0, total: 0, status: 'idle', error: '', url: '' };
  function fmtBytes(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i ? v.toFixed(1) : v.toFixed(0)) + ' ' + u[i];
  }
  function renderDl() {
    const openBtn = $('dl-open');
    if (openBtn) openBtn.classList.toggle('hidden', !dlState.active);
    const bar = $('dl-bar'), pct = $('dl-pct'), size = $('dl-size'), status = $('dl-status');
    if (bar) bar.style.width = (dlState.percent || 0) + '%';
    if (pct) pct.textContent = (dlState.percent || 0) + '%';
    if (size) size.textContent = dlState.total ? fmtBytes(dlState.received) + ' / ' + fmtBytes(dlState.total) : fmtBytes(dlState.received);
    if (status) {
      if (dlState.status === 'downloading') status.textContent = '🎶 正在下载新版本…';
      else if (dlState.status === 'done') status.textContent = '✅ 下载完成，即将启动安装程序！';
      else if (dlState.status === 'error') status.textContent = '❌ 下载失败：' + (dlState.error || '未知错误');
      else status.textContent = '正在准备下载…';
    }
  }
  function openDlModal() { renderDl(); const m = $('dl-modal'); if (m) m.classList.remove('hidden'); }
  function closeDlModal() { const m = $('dl-modal'); if (m) m.classList.add('hidden'); }
  async function startDownload(url) {
    dlState.active = true; dlState.url = url || '';
    dlState.status = 'starting'; dlState.percent = 0; dlState.received = 0; dlState.total = 0; dlState.error = '';
    renderDl(); openDlModal();
    const d = await api.update.apply(url).catch((e) => ({ ok: false, message: String((e && e.message) || e) }));
    if (d && d.ok) { dlState.status = 'done'; dlState.percent = 100; dlState.active = false; }
    else { dlState.status = 'error'; dlState.error = (d && d.message) || '未知错误'; dlState.active = false; }
    renderDl();
    if (d && d.ok) toast('✅ 已启动安装程序，请按向导完成安装', 5000);
    else await askYesNo('下载/启动失败：' + dlState.error + '\n\n可前往 GitHub 手动下载：\nhttps://github.com/kfdzcoffee/StudyAssistant/releases');
    return d;
  }
  // 主进程推送下载进度
  if (api.update.onProgress) api.update.onProgress((ev) => {
    if (!ev) return;
    if (ev.status) dlState.status = ev.status;
    if (typeof ev.percent === 'number') dlState.percent = ev.percent;
    if (typeof ev.received === 'number') dlState.received = ev.received;
    if (typeof ev.total === 'number') dlState.total = ev.total;
    renderDl();
  });
  (function () {
    const c = $('dl-close'), c2 = $('dl-close2'), o = $('dl-open');
    if (c) c.addEventListener('click', closeDlModal);
    if (c2) c2.addEventListener('click', closeDlModal);
    if (o) o.addEventListener('click', () => {
      if (!dlState.active) { toast('当前没有正在进行的下载任务'); return; }
      openDlModal();
    });
  })();

  // ---------- 清理缓存 / 旧安装包 ----------
  $('cache-clean').addEventListener('click', async () => {
    if (!(await askYesNo('清理缓存与旧版安装包？\n\n将删除：\n· 临时目录中的旧版安装包（学习助手-安装-*.exe 等）\n· 下载缓存（.blockmap / .nsis.7z / latest.yml）\n· Chromium 渲染缓存（Cache / GPU Cache 等）\n\n不影响你的知识库、设置与用户数据。'))) return;
    const btn = $('cache-clean');
    btn.disabled = true; btn.textContent = '🧹 清理中…';
    const r = await api.cache.clean();
    btn.disabled = false; btn.textContent = '🧹 清理缓存';
    if (r.ok) {
      const freed = fmtBytes(r.freed || 0);
      const list = r.list || [];
      const names = list.slice(0, 10).map((f) => '· ' + f).join('\n') + (list.length > 10 ? '\n… 等 ' + list.length + ' 项' : '');
      await askYesNo('🧹 清理完成！\n\n已删除 ' + r.files + ' 个缓存文件\n释放空间：' + freed + '\n' + (names ? '\n' + names : '') + '\n\n（同时清理了 Chromium 渲染缓存，不影响知识库与设置）');
      toast('✅ 已清理 ' + r.files + ' 个文件，释放 ' + freed, 5000);
    } else {
      toast('清理失败：' + (r.message || ''), 4000);
    }
  });

  // 启动时静默检查更新：有新版则弹窗提醒
  async function checkForUpdateSilent() {
    const r = await api.update.check().catch(() => null);
    if (!r || !r.ok) return; // 检查失败不打扰
    const curVer = String(VERSION_INFO.current || '').replace(/^v/i, '');
    if (compareVersions(r.version, curVer) <= 0) return; // 已是最新
    const notes = String(r.notes || '').slice(0, 500);
    if (await askYesNo('🎉 发现新版本：v' + r.version + '（当前 v' + curVer + '）\n\n' + (notes ? '更新说明：\n' + notes + '\n\n' : '') + '是否下载并安装新版？')) {
      await startDownload(r.url);
    }
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
      if (st) st.textContent = '✅ 已是最新版本（当前 v' + curVer + '，服务器 v' + r.version + '）';
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
    const d = await startDownload(r.url);
    if (d && d.ok) { if (st) st.textContent = '✅ 已启动安装程序，请按向导完成安装'; }
    else if (st) st.textContent = '❌ 下载/启动失败：' + ((d && d.message) || '未知错误');
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
      toast('请先阅读并同意《学习助手-Study Assistant 开源终端软件使用许可协议》', 4000);
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
    $('wiz-import-status').textContent = '⏳ 请选择要导入的数据包…';
    const info = await api.data.inspect();
    if (!info || !info.ok) {
      if (info && !info.cancelled) $('wiz-import-status').textContent = '❌ ' + (info.message || '导入失败');
      else $('wiz-import-status').textContent = '已取消，可点「下一步」跳过。';
      return;
    }
    // 选择解压目标文件夹（默认当前知识库所在目录的父目录）
    const cur = String((state.config && state.config.workspacePath) || '').replace(/[\\/]+$/, '');
    let targetDir = cur ? cur.replace(/[\\/][^\\/]*$/, '') : '';
    if (!targetDir) {
      const p = await api.settings.chooseWorkspace();
      if (!p) { $('wiz-import-status').textContent = '已取消，可点「下一步」跳过。'; return; }
      targetDir = p;
    }
    const names = (info.users || []).map((u) => u.name).join('、');
    if (!(await askYesNo('确认导入？\n\n数据包：' + (info.file || '') + '\n用户：' + (info.users || []).length + ' 个（' + names + '）\n解压到：' + targetDir + '\n\n导入会解压到所选文件夹并应用其设置（不含 API Key）。'))) {
      $('wiz-import-status').textContent = '已取消，可点「下一步」跳过。';
      return;
    }
    $('wiz-import-status').textContent = '⏳ 正在导入…';
    const r = await api.data.import({ buffer: info.buffer, mode: 'insert', selectedIds: (info.users || []).map((u) => u.id), targetDir });
    if (!r || !r.ok) {
      $('wiz-import-status').textContent = '❌ ' + ((r && r.message) || '导入失败');
      return;
    }
    $('wiz-import-status').textContent = '✅ 已导入 ' + (r.imported || []).length + ' 个用户';
    const cfg = await api.settings.get();
    applyConfig(cfg);
    state.records = await api.records.list();
    renderRecords();
    toast('✅ 数据已导入');
  });
  $('wiz-done').addEventListener('click', async () => {
    if (!$('wiz-agree').checked) {
      toast('请先阅读并同意《学习助手-Study Assistant 开源终端软件使用许可协议》', 4000);
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
    const essaySubjects = $('build-essay-subjects').value.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
    const examPassword = $('build-exampwd').value.trim();
    const proc = $('build-proc');
    proc.innerHTML = '';
    if (!(await askYesNo('确认执行构建？\n将覆盖 index.html（同步设计/组卷密码），并创建缺失的科目档案与文档。'))) return;
    addProc(proc, '▶ 开始构建…', 'ok');
    const r = await api.workspace.buildDocsify({ subjects, essaySubjects, examPassword });
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

  // ---------- 首页目标院校轮播 ----------
  let collegeCarouselTimer = null;
  let collegeCarouselIndex = 0;
  function collegeSlideHTML(u) {
    const img = u.image
      ? '<img src="' + escapeHtml(imgSrc(u.image)) + '" alt="' + escapeHtml(u.name || '') + '" />'
      : '<span class="cs-placeholder">🎓</span>';
    const links = [];
    if (u.official && u.official.url) links.push('<a href="' + escapeHtml(u.official.url) + '" target="_blank" rel="noopener">官网</a>');
    if (u.admissions && u.admissions.url) links.push('<a href="' + escapeHtml(u.admissions.url) + '" target="_blank" rel="noopener">本科招生网</a>');
    return '<div class="college-slide">' +
      '<div class="college-slide-img">' + img + '</div>' +
      '<div class="college-slide-info">' +
      '<div class="college-slide-name">' + escapeHtml(u.name || '未命名院校') + '<span class="college-slide-prio">⭐ ' + (u.priority || '') + '</span></div>' +
      (links.length ? '<div class="college-slide-links">' + links.join('') + '</div>' : '') +
      '</div></div>';
  }
  function renderCollegeCarousel() {
    const el = $('college-carousel');
    if (!el) return;
    const unis = (collegeData.universities || []).filter((u) => u && u.name);
    if (!unis.length) {
      el.innerHTML = '<div class="hint">暂无目标院校，去「目标院校」添加吧。</div>';
      return;
    }
    const sorted = unis.slice().sort((a, b) => (a.priority || 99) - (b.priority || 99));
    el.innerHTML =
      '<div class="college-track">' + sorted.map(collegeSlideHTML).join('') + '</div>' +
      (sorted.length > 1
        ? '<button class="college-carousel-nav college-carousel-prev" title="上一个"><svg class="ic"><use href="#i-arrow-left"/></svg></button>' +
          '<button class="college-carousel-nav college-carousel-next" title="下一个"><svg class="ic"><use href="#i-arrow-right"/></svg></button>' +
          '<div class="college-carousel-dots">' + sorted.map((_, i) => '<button class="college-dot' + (i === 0 ? ' active' : '') + '" data-i="' + i + '"></button>').join('') + '</div>'
        : '');
    const track = el.querySelector('.college-track');
    const dots = el.querySelectorAll('.college-dot');
    function goTo(i) {
      collegeCarouselIndex = ((i % sorted.length) + sorted.length) % sorted.length;
      if (track) track.style.transform = 'translateX(-' + (collegeCarouselIndex * 100) + '%)';
      dots.forEach((d) => d.classList.toggle('active', Number(d.dataset.i) === collegeCarouselIndex));
    }
    const prev = el.querySelector('.college-carousel-prev');
    const next = el.querySelector('.college-carousel-next');
    if (prev) prev.addEventListener('click', () => { goTo(collegeCarouselIndex - 1); restartCollegeCarousel(); });
    if (next) next.addEventListener('click', () => { goTo(collegeCarouselIndex + 1); restartCollegeCarousel(); });
    dots.forEach((d) => d.addEventListener('click', () => { goTo(Number(d.dataset.i)); restartCollegeCarousel(); }));
    el._goTo = goTo;
    restartCollegeCarousel();
  }
  function restartCollegeCarousel() {
    if (collegeCarouselTimer) clearInterval(collegeCarouselTimer);
    const el = $('college-carousel');
    const unis = (collegeData.universities || []).filter((u) => u && u.name);
    if (!el || unis.length <= 1) return;
    collegeCarouselTimer = setInterval(() => {
      if (el._goTo) el._goTo(collegeCarouselIndex + 1);
    }, 4000);
  }
  async function loadCollegeCarousel() {
    const r = await api.site.profile().catch(() => null);
    if (r && r.ok) collegeData = r;
    renderCollegeCarousel();
  }
  $('home-college-more').addEventListener('click', () => switchView('college'));

  // ---------- 错题统计 ----------
  async function loadStats() {
    const list = $('stats-list');
    if (!list) return;
    list.innerHTML = '<div class="hint">加载中…</div>';
    // 错题数据来自统一错题库（含编号 / 熟悉程度 / 错题组 / 关联试卷）
    const eb = await api.errorBank.list();
    const errors = (eb && eb.ok && eb.errors) ? eb.errors : [];
    // 记录全局错题顺序，供详情切换使用
    state.statsOrder = errors.map((e) => e.number);
    // 作文与日期来自 site.stats
    const st = await api.site.stats();
    const subjects = (st && st.ok && st.subjects) ? st.subjects : [];
    const essayByFile = {};
    subjects.forEach((s) => { essayByFile[s.file] = { essays: s.essays, date: s.date }; });
    // 按科目分组错题
    const bySubject = {};
    errors.forEach((e) => { (bySubject[e.subject] = bySubject[e.subject] || []).push(e); });
    const allSubjects = Array.from(new Set([...Object.keys(bySubject), ...subjects.map((s) => s.subject)]));
    let errT = errors.length, essT = 0;
    subjects.forEach((s) => { essT += s.essays.length; });
    $('stats-summary').textContent = '共 ' + allSubjects.length + ' 科 · 错题 ' + errT + ' 道 · 作文 ' + essT + ' 篇';
    list.innerHTML = '';
    allSubjects.forEach((subject) => {
      const file = subject + '.md';
      const subjErrors = bySubject[subject] || [];
      const essays = (essayByFile[file] && essayByFile[file].essays) || [];
      const date = (essayByFile[file] && essayByFile[file].date) || '';
      const card = document.createElement('div');
      card.className = 'stat-subject';
      const errs = subjErrors.map((e) => {
        const key = e.number;
        const fam = FAMILIARITY_LABEL[e.familiarity] || '';
        const grp = e.group ? '<span class="ss-group-tag" title="错题组">' + escapeHtml(e.group) + '</span>' : '';
        const papers = (Array.isArray(e.linkedPapers) && e.linkedPapers.length)
          ? e.linkedPapers.map((p) => '<span class="ss-paper-tag" title="关联试卷：' + escapeHtml(p.name) + '">📄 ' + escapeHtml(p.name) + '</span>').join('')
          : '';
        // 每行：错题 + 中间信息（关联试卷 / 错题组）在同一行对齐
        return '<div class="ss-row">' +
          '<div class="ss-item-row"><input type="checkbox" class="ss-cb" data-key="' + key + '" ' +
          (state.examSel.has(key) ? 'checked' : '') + ' title="加入组卷" /><span class="ss-item" data-key="' + key + '">' + fam + ' 错题 ' + e.n + '：' + escapeHtml(e.type) + '</span>' +
          '<button type="button" class="ss-del" data-key="' + key + '" title="删除该错题">🗑</button></div>' +
          '<div class="ss-meta-row">' + grp + papers + '</div>' +
          '</div>';
      }).join('') || '<div class="ss-empty">暂无错题</div>';
      // 作文列：仅当该科目存在作文时显示
      const hasEssays = essays.length > 0;
      const essaysHtml = hasEssays
        ? essays.map((e) => '<div class="ss-item" data-essay="' + encodeURIComponent(e.title) + '">' + (e.n ? '作文 ' + e.n + '：' : '') + escapeHtml(e.title) + '</div>').join('')
        : '';
      const essayCol = hasEssays
        ? '<div class="ss-col"><div class="ss-col-title">作文</div>' + essaysHtml + '</div>'
        : '';
      card.innerHTML = '<div class="ss-head"><span>' + escapeHtml(subject) + '</span><span class="ss-count">错题 ' + subjErrors.length + (hasEssays ? ' · 作文 ' + essays.length : '') + (date ? ' · 更新 ' + escapeHtml(date) : '') + '</span></div>' +
        '<div class="ss-body"><div class="ss-col"><div class="ss-col-title">错题（勾选加入组卷）</div>' + errs + '</div>' +
        essayCol + '</div>';
      card.querySelectorAll('.ss-cb').forEach((cb) => {
        cb.addEventListener('change', async () => {
          await toggleExamSel(cb.dataset.key, cb.checked);
        });
      });
      card.querySelectorAll('.ss-item[data-key]').forEach((it) => {
        it.addEventListener('click', () => {
          const key = it.dataset.key;
          openDetail(key, state.statsOrder, state.statsOrder.indexOf(key));
        });
      });
      card.querySelectorAll('.ss-del').forEach((btn) => {
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          const number = btn.dataset.key;
          if (!number) return;
          if (!(await askYesNo('确定要删除错题 ' + number + ' 吗？\n将从对应科目档案中删除该条目。'))) return;
          if (!(await askYesNo('再次确认：确定永久删除错题 ' + number + '？\n此操作不可恢复！'))) return;
          const r = await api.errorBank.del(number);
          if (r.ok) {
            toast('✅ 已删除错题 ' + number, 3000);
            loadStats();
            refreshTree();
            api.site.refreshStats().catch(() => {});
            api.site.syncSidebar().catch(() => {});
          } else {
            toast('删除失败：' + (r.message || ''), 4000);
          }
        });
      });
      card.querySelectorAll('.ss-item[data-essay]').forEach((it) => {
        it.addEventListener('click', () => openSectionDetail(file, decodeURIComponent(it.dataset.essay)));
      });
      list.appendChild(card);
    });
    updateExamBar();
  }
  $('stats-refresh').addEventListener('click', loadStats);

  // ---------- 批量设置熟悉程度 ----------
  function selectedNumbers() {
    return Array.from(state.examSel.keys());
  }
  $('stats-fam').addEventListener('click', () => {
    const bar = $('stats-fam-bar');
    if (!bar) return;
    bar.classList.toggle('hidden');
    $('stats-fam-count').textContent = selectedNumbers().length;
  });
  $('stats-fam-cancel').addEventListener('click', () => $('stats-fam-bar').classList.add('hidden'));
  $('stats-fam-apply').addEventListener('click', async () => {
    const nums = selectedNumbers();
    if (!nums.length) { toast('请先勾选错题'); return; }
    const fam = $('stats-fam-select').value;
    const r = await api.errorBank.setFamiliarity(nums, fam);
    if (r.ok) {
      toast('✅ 已更新 ' + r.updated + ' 道错题的熟悉程度', 3000);
      $('stats-fam-bar').classList.add('hidden');
      loadStats();
    } else toast('操作失败：' + (r.message || ''), 4000);
  });

  // ---------- 错题组管理 ----------
  async function loadStatsGroups() {
    const sel = $('stats-group-select');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '';
    try {
      const r = await api.errorBank.groups();
      if (r && r.ok && Array.isArray(r.groups)) {
        r.groups.forEach((g) => {
          const o = document.createElement('option');
          o.value = g.name;
          o.textContent = g.name;
          sel.appendChild(o);
        });
      }
    } catch (e) { /* 忽略 */ }
    if (cur) sel.value = cur;
    else if (Array.from(sel.options).some((o) => o.value === '默认')) sel.value = '默认';
  }
  $('stats-group').addEventListener('click', () => {
    const bar = $('stats-group-bar');
    if (!bar) return;
    bar.classList.toggle('hidden');
    if (!bar.classList.contains('hidden')) loadStatsGroups();
  });
  $('stats-group-cancel').addEventListener('click', () => $('stats-group-bar').classList.add('hidden'));
  $('stats-group-move').addEventListener('click', async () => {
    const nums = selectedNumbers();
    if (!nums.length) { toast('请先勾选错题'); return; }
    const grp = $('stats-group-select').value;
    const r = await api.errorBank.moveGroup(nums, grp);
    if (r.ok) {
      toast('✅ 已移动 ' + r.moved + ' 道错题到「' + (grp || '默认') + '」', 3000);
      loadStats();
    } else toast('操作失败：' + (r.message || ''), 4000);
  });
  $('stats-group-new').addEventListener('click', async () => {
    const name = await askInput({ title: '新建错题组', desc: '请输入新错题组的名称。', label: '错题组名称', placeholder: '例如：函数与导数' });
    if (!name || !name.trim()) return;
    const r = await api.errorBank.addGroup(name.trim());
    if (r.ok) {
      toast('✅ 已创建错题组「' + name.trim() + '」', 3000);
      loadStatsGroups();
      loadEntryGroups();
    } else toast('创建失败：' + (r.message || ''), 4000);
  });
  $('stats-group-del').addEventListener('click', async () => {
    const grp = $('stats-group-select').value;
    if (!grp) { toast('请先选择要删除的错题组'); return; }
    if (grp === '默认') { toast('「默认」为内置错题组，不可删除'); return; }
    const r = await api.errorBank.groups();
    const groups = (r && r.ok && r.groups) || [];
    const g = groups.find((x) => x.name === grp);
    if (!g) { toast('错题组不存在'); return; }
    // 填充转移目标下拉（排除自身）
    const moveSel = $('group-del-move-select');
    moveSel.innerHTML = '';
    groups.forEach((x) => {
      if (x.name === grp) return;
      const o = document.createElement('option');
      o.value = x.name;
      o.textContent = x.name;
      moveSel.appendChild(o);
    });
    // 默认选中「默认」组
    if (Array.from(moveSel.options).some((o) => o.value === '默认')) moveSel.value = '默认';
    $('group-del-desc').textContent = '删除错题组「' + grp + '」后，组内错题如何处理？';
    $('group-del-modal').classList.remove('hidden');
    // 记录待删除的组 id，供确定按钮使用
    $('group-del-modal').dataset.groupId = g.id;
    $('group-del-modal').dataset.groupName = grp;
  });
  $('group-del-cancel').addEventListener('click', () => $('group-del-modal').classList.add('hidden'));
  $('group-del-close').addEventListener('click', () => $('group-del-modal').classList.add('hidden'));
  $('group-del-ok').addEventListener('click', async () => {
    const modal = $('group-del-modal');
    const id = modal.dataset.groupId;
    const name = modal.dataset.groupName;
    modal.classList.add('hidden');
    if (!id) return;
    const mode = document.querySelector('input[name="gd-mode"]:checked').value;
    if (mode === 'delete') {
      // 全部直接删除：二次确认
      if (!(await askYesNo('确定要删除错题组「' + name + '」并【一并删除】组内所有错题吗？\n\n此操作不可恢复，错题档案与附件将全部删除！'))) return;
      if (!(await askYesNo('再次确认：确定永久删除错题组「' + name + '」及其全部错题？\n此操作不可恢复！'))) return;
      const dr = await api.errorBank.deleteGroup(id, { deleteErrors: true });
      if (dr.ok) {
        toast('✅ 已删除错题组「' + name + '」及 ' + (dr.deleted || 0) + ' 道错题', 3000);
      } else toast('删除失败：' + (dr.message || ''), 4000);
    } else {
      const moveTo = $('group-del-move-select').value;
      const dr = await api.errorBank.deleteGroup(id, { moveTo });
      if (dr.ok) {
        toast('✅ 已删除错题组「' + name + '」' + (moveTo ? '，错题已转移到「' + moveTo + '」' : '，错题已转移到「默认」组'), 3000);
      } else toast('删除失败：' + (dr.message || ''), 4000);
    }
    loadStatsGroups();
    loadEntryGroups();
    loadStats();
  });

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
    api.errorBank.search(q).then((r) => {
      if (!r.ok) { results.innerHTML = '<div class="hint">搜索失败：' + escapeHtml(r.message || '') + '</div>'; return; }
      const ms = r.matches || [];
      if (!ms.length) { results.innerHTML = '<div class="hint">未找到包含「' + escapeHtml(q) + '」的错题</div>'; return; }
      const total = ms.length > 100 ? '（仅显示前 100 条）' : '';
      results.innerHTML = '<div class="hint">找到 ' + ms.length + ' 条匹配' + total + '</div>';
      const searchOrder = ms.map((m) => m.number);
      ms.slice(0, 100).forEach((m) => {
        const row = document.createElement('div');
        row.className = 'search-hit';
        row.innerHTML = '<div class="sh-line"><span class="sh-tag">' + escapeHtml(m.subject) + ' · 错题 ' + m.n + '</span><span class="sh-title">' + escapeHtml(m.type) + '</span></div>' +
          (m.snippet ? '<div class="sh-snippet">' + escapeHtml(m.snippet) + '</div>' : '');
        row.addEventListener('click', () => openDetail(m.number, searchOrder, searchOrder.indexOf(m.number)));
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
  async function toggleExamSel(key, checked) {
    if (!checked) { state.examSel.delete(key); updateExamBar(); return; }
    const r = await api.errorBank.get(key);
    if (!r.ok) { toast('读取失败：' + (r.message || ''), 3000); return; }
    const sec = r.content || '';
    state.examSel.set(key, { number: key, subject: r.error.subject || '', title: r.error.type || '', md: sec });
    updateExamBar();
  }
  async function openDetail(number, list, idx) {
    const r = await api.errorBank.get(number);
    if (!r.ok) { toast('读取失败：' + (r.message || ''), 3000); return; }
    const e = r.error;
    $('detail-file').textContent = e.subject + ' · 错题 ' + e.n + ' · ' + number;
    if (r.content) renderMd($('detail-body'), r.content);
    else $('detail-body').innerHTML = '<div class="hint">未找到该题内容</div>';
    state.detailKey = number;
    state.detailFile = e.file;
    state.detailN = e.n;
    // 记录切换上下文（列表 + 当前位置）
    state.detailList = Array.isArray(list) ? list : [];
    state.detailIdx = (typeof idx === 'number' && idx >= 0) ? idx : -1;
    // 显示附件
    renderDetailAttachments(number);
    $('detail-sel').checked = state.examSel.has(state.detailKey);
    $('detail-modal').classList.remove('hidden');
  }
  // 渲染错题详情附件
  async function renderDetailAttachments(number) {
    const wrap = $('detail-attachments');
    if (!wrap) return;
    wrap.innerHTML = '';
    const r = await api.errorBank.listAttachments(number).catch(() => null);
    const atts = (r && r.ok && r.attachments) ? r.attachments : [];
    if (!atts.length) return;
    for (const a of atts) {
      const ar = await api.errorBank.readAttachment(number, a.name).catch(() => null);
      if (!ar || !ar.ok) continue;
      const item = document.createElement('div');
      item.className = 'da-item';
      item.innerHTML = '<img src="' + ar.dataUrl + '" /><div class="da-name">' + escapeHtml(a.name) + '</div>';
      wrap.appendChild(item);
    }
  }
  // 详情切换：上一道 / 下一道
  async function detailNav(dir) {
    const list = state.detailList;
    if (!list.length || state.detailIdx < 0) { toast('当前无切换列表'); return; }
    const ni = state.detailIdx + dir;
    if (ni < 0 || ni >= list.length) { toast(dir < 0 ? '已是第一道' : '已是最后一道'); return; }
    const target = list[ni];
    const num = typeof target === 'string' ? target : target.number;
    await openDetail(num, list, ni);
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
  // ===== 新建试卷（4 种组卷方式） =====
  let examAllErrors = []; // 错题库全量（含元数据），供各方式筛选
  let examMethod = 'paper'; // 当前方式
  function examFamSelected() {
    return Array.from(document.querySelectorAll('.exam-fam-cb:checked')).map((cb) => cb.value);
  }
  function examSetCount() {
    const c = $('exam-count');
    if (c) c.textContent = state.examSel.size;
  }
  function examRenderPicked() {
    const list = $('exam-picked-list');
    if (!list) return;
    examSetCount();
    if (!state.examSel.size) {
      list.innerHTML = '<div class="hint">尚未载入错题，请选择上方一种方式。</div>';
      return;
    }
    list.innerHTML = Array.from(state.examSel.values()).map((q) =>
      '<div class="exam-picked-item" data-key="' + escapeHtml(q.number) + '">' +
      '<span class="ep-title">' + escapeHtml(q.subject || '') + ' · 错题 ' + (q.n || '') + '：' + escapeHtml(q.title || '') + '</span>' +
      '<button type="button" class="btn-mini warn" data-remove="1">移除</button></div>'
    ).join('');
    list.querySelectorAll('.exam-picked-item').forEach((item) => {
      item.querySelector('[data-remove]').addEventListener('click', () => {
        state.examSel.delete(item.dataset.key);
        examRenderPicked();
        syncExamCheckboxes();
        updateExamBar();
      });
    });
  }
  // 把一批错题编号加入待选（去重）
  async function examAddNumbers(numbers) {
    let added = 0;
    for (const num of numbers) {
      if (state.examSel.has(num)) continue;
      const r = await api.errorBank.get(num);
      if (!r.ok) continue;
      const sec = r.content || '';
      state.examSel.set(num, { number: num, subject: r.error.subject || '', title: r.error.type || '', n: r.error.n || 0, md: sec });
      added++;
    }
    examRenderPicked();
    syncExamCheckboxes();
    updateExamBar();
    return added;
  }
  async function examLoadPaper() {
    const pid = $('exam-paper-select').value;
    if (!pid) { toast('请先选择试卷'); return; }
    const p = papersData.find((x) => x.id === pid);
    if (!p) { toast('试卷不存在'); return; }
    const linked = Array.isArray(p.linkedErrors) ? p.linkedErrors : [];
    if (!linked.length) { toast('该试卷暂无关联错题'); return; }
    const nums = linked.map((e) => e.number).filter(Boolean);
    const added = await examAddNumbers(nums);
    toast('✅ 已载入 ' + added + ' 道关联错题', 3000);
  }
  async function examLoadGroup() {
    const grp = $('exam-group-select').value;
    const fams = examFamSelected();
    const nums = examAllErrors
      .filter((e) => (!grp || e.group === grp) && (!fams.length || fams.indexOf(e.familiarity) !== -1))
      .map((e) => e.number);
    if (!nums.length) { toast('没有符合条件的错题'); return; }
    const added = await examAddNumbers(nums);
    toast('✅ 已载入 ' + added + ' 道错题', 3000);
  }
  function examRenderManual() {
    const list = $('exam-manual-list');
    if (!list) return;
    if (!examAllErrors.length) { list.innerHTML = '<div class="hint">暂无错题</div>'; return; }
    list.innerHTML = examAllErrors.map((e) =>
      '<div class="exam-manual-item" data-key="' + escapeHtml(e.number) + '">' +
      '<input type="checkbox" class="em-cb" data-key="' + escapeHtml(e.number) + '" ' + (state.examSel.has(e.number) ? 'checked' : '') + ' />' +
      '<span class="em-title">' + escapeHtml(e.subject) + ' · 错题 ' + (e.n || '') + '：' + escapeHtml(e.type || '') + '</span>' +
      '<span class="em-meta">' + (FAMILIARITY_LABEL[e.familiarity] || '') + (e.group ? ' · ' + escapeHtml(e.group) : '') + '</span></div>'
    ).join('');
    list.querySelectorAll('.em-cb').forEach((cb) => {
      cb.addEventListener('change', async () => {
        await toggleExamSel(cb.dataset.key, cb.checked);
        examRenderManual();
        examRenderPicked();
      });
    });
  }
  async function examLoadRandom() {
    const subj = $('exam-random-subject').value;
    const fams = examFamSelected();
    const count = parseInt($('exam-random-count').value, 10) || 10;
    let pool = examAllErrors.filter((e) => (!subj || e.subject === subj) && (!fams.length || fams.indexOf(e.familiarity) !== -1));
    if (!pool.length) { toast('没有符合条件的错题'); return; }
    // 打乱后取前 count 道
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    pool = pool.slice(0, count);
    const added = await examAddNumbers(pool.map((e) => e.number));
    toast('✅ 已随机抽取 ' + added + ' 道错题', 3000);
  }
  function examSwitchMethod(method) {
    examMethod = method;
    document.querySelectorAll('.exam-method-tab').forEach((t) => t.classList.toggle('active', t.dataset.method === method));
    document.querySelectorAll('.exam-method-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.method !== method));
  }
  async function openExamModal() {
    // 载入错题库全量（供各方式筛选）
    const eb = await api.errorBank.list();
    examAllErrors = (eb && eb.ok && eb.errors) ? eb.errors : [];
    // 方式①：试卷下拉
    const paperSel = $('exam-paper-select');
    if (paperSel) {
      const cur = paperSel.value;
      paperSel.innerHTML = papersData.length
        ? papersData.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + (p.subject ? '（' + escapeHtml(p.subject) + '）' : '') + '</option>').join('')
        : '<option value="">（暂无试卷）</option>';
      if (cur) paperSel.value = cur;
    }
    // 方式②：错题组下拉
    const grpSel = $('exam-group-select');
    if (grpSel) {
      const cur = grpSel.value;
      grpSel.innerHTML = '<option value="">全部错题组</option>';
      try {
        const gr = await api.errorBank.groups();
        if (gr && gr.ok && Array.isArray(gr.groups)) gr.groups.forEach((g) => {
          const o = document.createElement('option'); o.value = g.name; o.textContent = g.name; grpSel.appendChild(o);
        });
      } catch (e) { /* 忽略 */ }
      if (cur) grpSel.value = cur;
    }
    // 方式④：科目下拉
    const subjSel = $('exam-random-subject');
    if (subjSel) {
      const cur = subjSel.value;
      const subs = Array.from(new Set(examAllErrors.map((e) => e.subject).filter(Boolean)));
      subjSel.innerHTML = '<option value="">全部科目</option>' + subs.map((s) => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');
      if (cur) subjSel.value = cur;
    }
    // 方式③：手动列表
    examRenderManual();
    // 默认试卷名称
    const subj = Array.from(new Set(Array.from(state.examSel.values()).map((q) => q.subject || ''))).filter(Boolean);
    const d = new Date();
    const ds = d.getFullYear() + '.' + (d.getMonth() + 1) + '.' + d.getDate();
    $('exam-name').value = subj.join('+') + '错题组卷 ' + ds;
    examRenderPicked();
    examSwitchMethod('paper');
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
    await toggleExamSel(state.detailKey, e.target.checked);
    syncExamCheckboxes();
    updateExamBar();
  });
  // 详情切换：上一道 / 下一道
  $('detail-prev').addEventListener('click', () => detailNav(-1));
  $('detail-prev2').addEventListener('click', () => detailNav(-1));
  $('detail-next2').addEventListener('click', () => detailNav(1));
  $('detail-gen').addEventListener('click', openExamModal);
  $('detail-edit').addEventListener('click', () => { $('detail-modal').classList.add('hidden'); openInEditor(state.detailFile); switchView('archive'); });
  $('exam-gen').addEventListener('click', openExamModal);
  $('exam-modal-close').addEventListener('click', closeExamModal);
  $('exam-modal-cancel').addEventListener('click', closeExamModal);
  $('exam-modal-go').addEventListener('click', doGenExam);
  // 方式切换
  document.querySelectorAll('.exam-method-tab').forEach((t) => {
    t.addEventListener('click', () => examSwitchMethod(t.dataset.method));
  });
  // 方式①：按试卷
  $('exam-paper-load').addEventListener('click', examLoadPaper);
  // 方式②：按错题组
  $('exam-group-load').addEventListener('click', examLoadGroup);
  // 方式④：按科目随机
  $('exam-random-load').addEventListener('click', examLoadRandom);
  $('exam-clear').addEventListener('click', () => {
    state.examSel.clear();
    syncExamCheckboxes();
    updateExamBar();
    examRenderPicked();
    examRenderManual();
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

  // ---------- 任务待办 ----------
  const PRIORITY_LABEL = { high: '🔴 高', normal: '🟡 中', low: '🟢 低' };
  const RECUR_LABEL = { daily: '每天', weekly: '每周', biweekly: '每两周', monthly: '每月' };
  function todoItemHTML(t) {
    const due = t.due ? '<span class="todo-due">📅 ' + escapeHtml(t.due) + '</span>' : '';
    const prio = '<span class="todo-prio prio-' + escapeHtml(t.priority) + '">' + (PRIORITY_LABEL[t.priority] || '🟡 中') + '</span>';
    const rec = t.recurring ? '<span class="todo-rec" title="循环任务：' + (RECUR_LABEL[t.recurring] || t.recurring) + '">🔁 ' + (RECUR_LABEL[t.recurring] || t.recurring) + '</span>' : '';
    return '<div class="todo-item' + (t.done ? ' done' : '') + '" data-id="' + t.id + '">' +
      '<input type="checkbox" class="todo-cb" data-id="' + t.id + '" ' + (t.done ? 'checked' : '') + ' />' +
      '<span class="todo-text">' + escapeHtml(t.text) + '</span>' +
      rec + prio + due +
      '<button class="todo-del" data-id="' + t.id + '" title="删除">🗑</button>' +
      '</div>';
  }
  async function loadTodos() {
    const r = await api.todos.list().catch(() => null);
    if (!r || !r.ok) return;
    const todos = r.todos || [];
    const list = $('todo-list');
    const cal = $('todo-calendar');
    const viewMode = (state.config && state.config.todoView) || 'list';
    if (list) list.classList.toggle('hidden', viewMode === 'calendar');
    if (cal) cal.classList.toggle('hidden', viewMode !== 'calendar');
    if (viewMode === 'calendar') {
      renderTodoCalendar(todos);
    } else if (list) {
      list.innerHTML = todos.length ? todos.map(todoItemHTML).join('') : '<div class="hint">暂无待办。</div>';
      list.querySelectorAll('.todo-cb').forEach((cb) => cb.addEventListener('change', () => toggleTodo(cb.dataset.id)));
      list.querySelectorAll('.todo-del').forEach((btn) => btn.addEventListener('click', async () => {
        if (!(await askYesNo('确定删除该待办？'))) return;
        const dr = await api.todos.del(btn.dataset.id);
        if (dr.ok) { toast('已删除'); loadTodos(); } else toast(dr.message || '删除失败', 3000);
      }));
    }
    const done = todos.filter((t) => t.done).length;
    const sum = $('todo-summary'); if (sum) sum.textContent = '共 ' + todos.length + ' 项 · 已完成 ' + done + ' 项';
    // 首页待办（未完成项，最多显示 8 条）
    const homeList = $('home-todos-list');
    if (homeList) {
      const pending = todos.filter((t) => !t.done);
      if (!pending.length) {
        homeList.innerHTML = '<div class="hint">🎉 太棒了，没有未完成的待办！</div>';
      } else {
        homeList.innerHTML = pending.slice(0, 8).map(todoItemHTML).join('') +
          (pending.length > 8 ? '<div class="hint">…还有 ' + (pending.length - 8) + ' 项，去「任务待办」查看</div>' : '');
        homeList.querySelectorAll('.todo-cb').forEach((cb) => cb.addEventListener('change', () => toggleTodo(cb.dataset.id)));
      }
    }
  }
  // ---------- 待办日历视图 ----------
  let todoCalDate = new Date();
  todoCalDate.setDate(1);
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function renderTodoCalendar(todos) {
    const grid = $('cal-grid');
    const title = $('cal-title');
    if (!grid || !title) return;
    const y = todoCalDate.getFullYear(), m = todoCalDate.getMonth();
    title.textContent = y + ' 年 ' + (m + 1) + ' 月';
    const byDate = {};
    todos.forEach((t) => { if (t.due) { (byDate[t.due] = byDate[t.due] || []).push(t); } });
    const first = new Date(y, m, 1);
    const startDow = (first.getDay() + 6) % 7; // 周一为一周开始
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const todayKey = fmtDateKey(new Date());
    const dows = ['一', '二', '三', '四', '五', '六', '日'];
    let html = dows.map((d, i) => '<div class="cal-dow' + (i >= 5 ? ' weekend' : '') + '">' + d + '</div>').join('');
    // 上月补位
    const prevDays = new Date(y, m, 0).getDate();
    for (let i = startDow - 1; i >= 0; i--) {
      const d = new Date(y, m - 1, prevDays - i);
      html += '<div class="cal-cell other"><div class="cal-cell-num">' + d.getDate() + '</div></div>';
    }
    for (let day = 1; day <= daysInMonth; day++) {
      const d = new Date(y, m, day);
      const key = fmtDateKey(d);
      const dayTodos = byDate[key] || [];
      const isToday = key === todayKey;
      const dow = (d.getDay() + 6) % 7;
      html += '<div class="cal-cell' + (isToday ? ' today' : '') + '">' +
        '<div class="cal-cell-num">' + day + '</div>' +
        '<div class="cal-cell-todos">' +
        (dayTodos.length
          ? dayTodos.map((t) => '<button class="cal-todo' + (t.done ? ' done' : '') + ' prio-' + escapeHtml(t.priority) + '" data-id="' + t.id + '" title="' + escapeHtml(t.text) + '">' + escapeHtml(t.text) + '</button>').join('')
          : '<span class="cal-empty"></span>') +
        '</div></div>';
    }
    // 下月补位
    const endDow = (new Date(y, m, daysInMonth).getDay() + 6) % 7;
    for (let i = 1; i < 7 - endDow; i++) {
      html += '<div class="cal-cell other"><div class="cal-cell-num">' + i + '</div></div>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.cal-todo').forEach((btn) => btn.addEventListener('click', () => toggleTodo(btn.dataset.id)));
  }
  $('cal-prev').addEventListener('click', () => { todoCalDate.setMonth(todoCalDate.getMonth() - 1); loadTodos(); });
  $('cal-next').addEventListener('click', () => { todoCalDate.setMonth(todoCalDate.getMonth() + 1); loadTodos(); });
  $('cal-today').addEventListener('click', () => { todoCalDate = new Date(); todoCalDate.setDate(1); loadTodos(); });
  async function toggleTodo(id) {
    const r = await api.todos.toggle(id);
    if (r.ok) { loadTodos(); } else toast(r.message || '操作失败', 3000);
  }
  $('todo-add').addEventListener('click', async () => {
    const text = $('todo-text').value.trim();
    if (!text) { toast('请输入待办内容'); return; }
    const r = await api.todos.add({
      text,
      priority: $('todo-priority').value,
      due: $('todo-due').value,
      recurring: $('todo-recurring') ? $('todo-recurring').value : ''
    });
    if (r.ok) {
      $('todo-text').value = '';
      $('todo-due').value = '';
      if ($('todo-recurring')) $('todo-recurring').value = '';
      loadTodos();
      toast('✅ 已添加待办');
    } else toast(r.message || '添加失败', 3000);
  });
  $('todo-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('todo-add').click(); });
  $('home-todos-more').addEventListener('click', () => switchView('todos'));

  // ---------- 试卷管理 ----------
  let papersData = [];
  let paperModalMode = 'add';
  let paperModalEditId = null;
  let paperPaperData = null;
  let paperAnswerData = null;
  let paperDetailId = null;
  function paperCardHTML(p) {
    const hasAns = p.hasAnswer ? '<span class="paper-tag">答题卡</span>' : '';
    const subj = p.subject ? '<span class="paper-subj">' + escapeHtml(p.subject) + '</span>' : '';
    const date = p.date ? '<span class="paper-date">📅 ' + escapeHtml(p.date) + '</span>' : '';
    const linked = '<span class="paper-linked">关联错题 ' + (Array.isArray(p.linkedErrors) ? p.linkedErrors.length : 0) + ' 道</span>';
    return '<div class="paper-card" data-id="' + p.id + '">' +
      '<div class="paper-card-head"><span class="paper-name">' + escapeHtml(p.name) + '</span>' + hasAns + '</div>' +
      '<div class="paper-card-meta">' + subj + date + linked + '</div>' +
      '<div class="paper-card-actions"><button class="btn-mini" data-act="view">👁 查看</button>' +
      '<button class="btn-mini" data-act="analyze">🤖 AI 分析</button>' +
      '<button class="btn-mini warn" data-act="del">🗑 删除</button></div>' +
      '</div>';
  }
  async function loadPapers() {
    const r = await api.papers.list().catch(() => null);
    if (!r || !r.ok) return;
    papersData = r.papers || [];
    // 填充错题录入的「关联试卷」下拉框
    const entryPaper = $('entry-paper');
    if (entryPaper) {
      const cur = entryPaper.value;
      entryPaper.innerHTML = '<option value="">不关联试卷</option>' +
        papersData.map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + (p.subject ? '（' + escapeHtml(p.subject) + '）' : '') + '</option>').join('');
      entryPaper.value = cur;
    }
    const list = $('paper-list');
    if (!list) return;
    list.innerHTML = papersData.length ? papersData.map(paperCardHTML).join('') : '<div class="hint">暂无试卷，点击「添加试卷」开始。</div>';
    list.querySelectorAll('.paper-card').forEach((card) => {
      const id = card.dataset.id;
      card.querySelector('[data-act=view]').addEventListener('click', () => openPaperDetail(id));
      card.querySelector('[data-act=analyze]').addEventListener('click', () => { openPaperDetail(id); runPaperAnalysis(id); });
      card.querySelector('[data-act=del]').addEventListener('click', async () => {
        if (!(await askYesNo('确定删除该试卷？\n将同时删除其图片与分析文件。'))) return;
        const dr = await api.papers.del(id);
        if (dr.ok) { toast('已删除试卷'); loadPapers(); } else toast(dr.message || '删除失败', 3000);
      });
    });
  }
  function openPaperModal(mode, id) {
    paperModalMode = mode;
    paperModalEditId = id || null;
    paperPaperData = null;
    paperAnswerData = null;
    $('paper-modal-title').textContent = mode === 'edit' ? '编辑试卷' : '添加试卷';
    $('paper-name').value = '';
    $('paper-subject').value = '数学';
    $('paper-date').value = '';
    $('paper-has-answer').checked = false;
    $('paper-answer-field').style.display = 'none';
    $('paper-img-name').textContent = '';
    $('paper-answer-name').textContent = '';
    $('paper-img-preview').classList.add('hidden');
    $('paper-answer-preview').classList.add('hidden');
    if (mode === 'edit' && id) {
      const p = papersData.find((x) => x.id === id);
      if (p) {
        $('paper-name').value = p.name;
        $('paper-subject').value = p.subject || '数学';
        $('paper-date').value = p.date || '';
        $('paper-has-answer').checked = !!p.hasAnswer;
        if (p.hasAnswer) $('paper-answer-field').style.display = '';
      }
    }
    $('paper-modal').classList.remove('hidden');
  }
  function closePaperModal() { $('paper-modal').classList.add('hidden'); }
  $('paper-add').addEventListener('click', () => openPaperModal('add'));
  $('paper-modal-close').addEventListener('click', closePaperModal);
  $('paper-modal-cancel').addEventListener('click', closePaperModal);
  $('paper-has-answer').addEventListener('change', () => {
    $('paper-answer-field').style.display = $('paper-has-answer').checked ? '' : 'none';
  });
  $('paper-img-btn').addEventListener('click', () => $('paper-img').click());
  $('paper-answer-btn').addEventListener('click', () => $('paper-answer-img').click());
  $('paper-img').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('paper-img-name').textContent = f.name;
    const rd = new FileReader();
    rd.onload = () => {
      openImageEditor(rd.result, (dataUrl) => {
        paperPaperData = dataUrl;
        const pv = $('paper-img-preview');
        pv.innerHTML = '<img src="' + dataUrl + '" />';
        pv.classList.remove('hidden');
      });
    };
    rd.readAsDataURL(f);
    e.target.value = '';
  });
  $('paper-answer-img').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    $('paper-answer-name').textContent = f.name;
    const rd = new FileReader();
    rd.onload = () => {
      openImageEditor(rd.result, (dataUrl) => {
        paperAnswerData = dataUrl;
        const pv = $('paper-answer-preview');
        pv.innerHTML = '<img src="' + dataUrl + '" />';
        pv.classList.remove('hidden');
      });
    };
    rd.readAsDataURL(f);
    e.target.value = '';
  });
  $('paper-modal-save').addEventListener('click', async () => {
    const name = $('paper-name').value.trim();
    if (!name) { toast('请输入试卷名称'); return; }
    const data = {
      name,
      subject: $('paper-subject').value,
      date: $('paper-date').value,
      hasAnswer: $('paper-has-answer').checked,
      paperData: paperPaperData,
      answerData: paperAnswerData
    };
    const r = await api.papers.add(data);
    if (r.ok) {
      toast('✅ 已添加试卷');
      closePaperModal();
      loadPapers();
    } else toast(r.message || '添加失败', 3000);
  });
  async function openPaperDetail(id) {
    paperDetailId = id;
    const p = papersData.find((x) => x.id === id);
    if (!p) return;
    $('paper-detail-title').textContent = p.name;
    const paperImg = $('paper-detail-paper');
    paperImg.src = '';
    const pr = await api.papers.readImage(p.paperPath);
    if (pr.ok) paperImg.src = pr.dataUrl;
    const ansWrap = $('paper-detail-answer-wrap');
    if (p.hasAnswer && p.answerPath) {
      const ar = await api.papers.readImage(p.answerPath);
      if (ar.ok) { $('paper-detail-answer').src = ar.dataUrl; ansWrap.style.display = ''; }
      else ansWrap.style.display = 'none';
    } else ansWrap.style.display = 'none';
    $('paper-analysis').innerHTML = '<div class="hint">点击「开始 AI 分析」生成试卷分析。</div>';
    // 渲染关联错题列表
    const linkedEl = $('paper-linked-errors');
    const linked = Array.isArray(p.linkedErrors) ? p.linkedErrors : [];
    if (!linked.length) {
      linkedEl.innerHTML = '<div class="hint">暂无关联错题。可在「错题录入」时选择关联本试卷。</div>';
    } else {
      linkedEl.innerHTML = linked.map((e) =>
        '<div class="paper-linked-item" data-number="' + escapeHtml(e.number) + '">' +
        '<span class="pl-title">' + escapeHtml(e.number) + '：' + escapeHtml(e.title || '') + '</span>' +
        '<button class="btn-mini warn" data-unlink="1">取消关联</button></div>'
      ).join('');
      linkedEl.querySelectorAll('.paper-linked-item').forEach((item) => {
        item.querySelector('[data-unlink]').addEventListener('click', async () => {
          if (!(await askYesNo('取消该错题与本试卷的关联？'))) return;
          const ur = await api.papers.unlinkError(id, item.dataset.number);
          if (ur.ok) {
            // 同步更新错题库侧关联
            await api.errorBank.unlinkPaper(item.dataset.number, id).catch(() => {});
            toast('已取消关联'); loadPapers(); openPaperDetail(id);
          }
          else toast(ur.message || '操作失败', 3000);
        });
      });
    }
    $('paper-detail-modal').classList.remove('hidden');
    loadPaperAnalysis(id);
  }
  $('paper-detail-close').addEventListener('click', () => $('paper-detail-modal').classList.add('hidden'));
  $('paper-detail-close2').addEventListener('click', () => $('paper-detail-modal').classList.add('hidden'));
  $('paper-detail-delete').addEventListener('click', async () => {
    if (!paperDetailId) return;
    if (!(await askYesNo('确定删除该试卷？\n将同时删除其图片与分析文件。'))) return;
    const dr = await api.papers.del(paperDetailId);
    if (dr.ok) {
      toast('已删除试卷');
      $('paper-detail-modal').classList.add('hidden');
      loadPapers();
    } else toast(dr.message || '删除失败', 3000);
  });
  async function loadPaperAnalysis(id) {
    const r = await api.papers.readAnalysis(id);
    const el = $('paper-analysis');
    if (r.ok) renderMd(el, r.content);
    else el.innerHTML = '<div class="hint">暂无分析结果。</div>';
  }
  $('paper-analysis-refresh').addEventListener('click', () => { if (paperDetailId) loadPaperAnalysis(paperDetailId); });
  async function runPaperAnalysis(id) {
    const p = papersData.find((x) => x.id === id);
    if (!p) return;
    const el = $('paper-analysis');
    el.innerHTML = '<div class="hint">正在读取试卷图片并生成分析…</div>';
    const pr = await api.papers.readImage(p.paperPath);
    if (!pr.ok) { el.innerHTML = '<div class="hint">读取试卷图片失败</div>'; return; }
    let answerText = '';
    if (p.hasAnswer && p.answerPath) {
      const ar = await api.papers.readImage(p.answerPath);
      if (ar.ok) answerText = '\n\n【答题卡图片】\n' + ar.dataUrl;
    }
    const task = {
      providerId: state.config ? state.config.activeProvider : null,
      mode: 'paper-analysis',
      hasImage: true,
      messages: [{ role: 'user', content: '请分析这张试卷图片' + (p.subject ? '（科目：' + p.subject + '）' : '') + '。请给出：1) 试卷整体结构与题型分布；2) 各题难度评估；3) 重点/易错考点归纳；4) 结合错题知识库给出针对性复习建议。请用 Markdown 输出。\n\n【试卷图片】\n' + pr.dataUrl + answerText }]
    };
    const r = await api.ai.runTask(task);
    if (r && r.ok && r.content) {
      renderMd(el, r.content);
      await api.papers.saveAnalysis(id, r.content);
      toast('✅ 分析完成并已保存');
    } else {
      el.innerHTML = '<div class="hint">分析失败：' + escapeHtml((r && r.message) || '未知错误') + '</div>';
    }
  }

  // ---------- 导航 ----------
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  // ---------- 启动 ----------
  // ================= 生词本（英语单词生义） =================
  const POS_OPTIONS = ['n.（名词）', 'v.（动词）', 'adj.（形容词）', 'adv.（副词）', 'prep.（介词）', 'conj.（连词）', 'pron.（代词）', 'num.（数词）', 'art.（冠词）', 'int.（感叹词）', 'phr.（短语）'];
  // 词性显示：把简写（如 n.）统一转换为带中文标注的格式（如 n.（名词））
  const POS_MAP = {
    'n.': 'n.（名词）', 'v.': 'v.（动词）', 'adj.': 'adj.（形容词）', 'adv.': 'adv.（副词）',
    'prep.': 'prep.（介词）', 'conj.': 'conj.（连词）', 'pron.': 'pron.（代词）', 'num.': 'num.（数词）',
    'art.': 'art.（冠词）', 'int.': 'int.（感叹词）', 'phr.': 'phr.（短语）'
  };
  function posLabel(pos) {
    if (!pos) return '';
    const p = String(pos).trim();
    return POS_MAP[p] || p;
  }
  // 生义显示标签：单词显示词性；短语无词性；已移除「单词形式」字段
  function vocabSenseLabel(s, isPhrase) {
    const parts = [];
    if (!isPhrase && s.pos) parts.push(posLabel(s.pos));
    if (s.meaning) parts.push(s.meaning);
    return parts.join(' ');
  }
  let vocabData = { words: [] };
  let vocabEditingId = null;
  let vocabDetailId = null;
  let vocabExportSel = {};
  let vocabFilter = 'all'; // all | word | phrase

  function vocabSenseRowHTML(s, idx) {
    const isPhrase = $('vocab-type').value === 'phrase';
    const posHtml = isPhrase ? '' : '<select class="vocab-sense-pos">' + POS_OPTIONS.map((p) => '<option value="' + p + '"' + (s.pos === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>';
    return '<div class="vocab-sense-row" data-i="' + idx + '">' +
      posHtml +
      '<input class="vocab-sense-meaning" placeholder="中文释义" value="' + escapeHtml(s.meaning || '') + '" />' +
      '<input class="vocab-sense-example" placeholder="例句（可选）" value="' + escapeHtml(s.example || '') + '" />' +
      '<button class="vocab-sense-del" title="删除">✕</button>' +
      '</div>';
  }

  function renderVocabSenses() {
    const box = $('vocab-senses');
    const senses = box._senses || [];
    box.innerHTML = senses.length ? senses.map(vocabSenseRowHTML).join('') : '<div class="hint">暂无生义，点击下方按钮添加。</div>';
    box.querySelectorAll('.vocab-sense-row').forEach((row) => {
      const i = Number(row.dataset.i);
      const posSel = row.querySelector('.vocab-sense-pos');
      if (posSel) posSel.addEventListener('change', () => { box._senses[i].pos = posSel.value; });
      row.querySelector('.vocab-sense-meaning').addEventListener('input', () => { box._senses[i].meaning = row.querySelector('.vocab-sense-meaning').value; });
      row.querySelector('.vocab-sense-example').addEventListener('input', () => { box._senses[i].example = row.querySelector('.vocab-sense-example').value; });
    });
    box.querySelectorAll('.vocab-sense-del').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.closest('.vocab-sense-row').dataset.i);
        box._senses.splice(i, 1);
        renderVocabSenses();
      });
    });
  }

  // 其它词性的单词（词族补充）行
  function vocabOtherRowHTML(o, idx) {
    return '<div class="vocab-other-row" data-i="' + idx + '">' +
      '<input class="vocab-other-word" placeholder="英语单词，如 abandonment" value="' + escapeHtml(o.word || '') + '" />' +
      '<select class="vocab-other-pos">' + POS_OPTIONS.map((p) => '<option value="' + p + '"' + (o.pos === p ? ' selected' : '') + '>' + p + '</option>').join('') + '</select>' +
      '<input class="vocab-other-meaning" placeholder="释义（可选）" value="' + escapeHtml(o.meaning || '') + '" />' +
      '<button class="vocab-other-del" title="删除">✕</button>' +
      '</div>';
  }
  function renderVocabOthers() {
    const box = $('vocab-others');
    const others = box._others || [];
    box.innerHTML = others.length ? others.map(vocabOtherRowHTML).join('') : '<div class="hint">暂无其它词性，点击下方按钮补充词族单词。</div>';
    box.querySelectorAll('.vocab-other-row').forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelector('.vocab-other-word').addEventListener('input', () => { box._others[i].word = row.querySelector('.vocab-other-word').value; });
      row.querySelector('.vocab-other-pos').addEventListener('change', () => { box._others[i].pos = row.querySelector('.vocab-other-pos').value; });
      row.querySelector('.vocab-other-meaning').addEventListener('input', () => { box._others[i].meaning = row.querySelector('.vocab-other-meaning').value; });
    });
    box.querySelectorAll('.vocab-other-del').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.closest('.vocab-other-row').dataset.i);
        box._others.splice(i, 1);
        renderVocabOthers();
      });
    });
  }

  function openVocabModal(word) {
    vocabEditingId = word ? word.id : null;
    $('vocab-modal-title').textContent = word ? '编辑单词/短语' : '添加单词/短语';
    $('vocab-word').value = word ? word.word : '';
    $('vocab-type').value = word ? (word.type || 'word') : 'word';
    $('vocab-linked').value = word ? (word.linked || '') : '';
    const box = $('vocab-senses');
    box._senses = word && word.senses ? word.senses.map((s) => Object.assign({}, s)) : [];
    const obox = $('vocab-others');
    obox._others = word && word.otherForms ? word.otherForms.map((o) => Object.assign({}, o)) : [];
    toggleVocabLinkedField();
    $('vocab-modal').classList.remove('hidden');
    $('vocab-word').focus();
  }
  function toggleVocabLinkedField() {
    const isPhrase = $('vocab-type').value === 'phrase';
    $('vocab-linked-field').style.display = isPhrase ? '' : 'none';
    // 词性列与其它词性补充仅适用于单词：短语无词性、无其它词性
    $('vocab-other-field').style.display = isPhrase ? 'none' : '';
    renderVocabSenses();
    renderVocabOthers();
    const label = $('vocab-senses-label');
    if (label) label.textContent = isPhrase ? '生义（中文释义 + 例句）' : '生义（词性 + 中文释义 + 例句）';
  }

  // 关联词语校验：处理三种情况
  // 1) 本身没有这个词  2) 没有匹配上（拼写/大小写）  3) 关联词是某个词的释义
  function validateVocabLinked(linked) {
    const words = vocabData.words || [];
    const linkedLower = (linked || '').trim().toLowerCase();
    if (!linkedLower) return { ok: true };
    // 情况1：精确匹配（本身有这个单词）
    const exact = words.find((w) => (w.word || '').trim().toLowerCase() === linkedLower);
    if (exact) return { ok: true };
    // 情况2：没有匹配上（模糊匹配：包含关系）
    const similar = words.find((w) => {
      const wl = (w.word || '').trim().toLowerCase();
      return wl && (wl.indexOf(linkedLower) !== -1 || linkedLower.indexOf(wl) !== -1);
    });
    // 情况3：关联词是某个词的释义内容
    const inSense = words.find((w) => (w.senses || []).some((s) => (s.meaning || '').toLowerCase().indexOf(linkedLower) !== -1));
    if (similar) return { ok: false, message: '关联的「' + linked + '」未精确匹配，是否关联到「' + similar.word + '」？', suggestion: similar.word };
    if (inSense) return { ok: false, message: '「' + linked + '」是「' + inSense.word + '」的释义，是否关联到「' + inSense.word + '」？', suggestion: inSense.word };
    return { ok: false, message: '关联的「' + linked + '」不在生词本中，是否仍要关联？', suggestion: null };
  }

  // 把文本拆分成英文词汇（按空格/标点）
  function splitVocabWords(text) {
    return (text || '').toLowerCase().split(/[^a-z']+/).filter((w) => w.length > 0);
  }
  // 判断某个词是否与已录入的某个词条重合（词条本身或其生义中的单词形式/释义）
  function vocabMatchesEntry(token, entry) {
    const t = (token || '').trim().toLowerCase();
    if (!t) return false;
    if ((entry.word || '').trim().toLowerCase() === t) return true;
    return (entry.senses || []).some((s) => {
      const form = (s.form || '').trim().toLowerCase();
      const meaning = (s.meaning || '').trim().toLowerCase();
      return (form && form === t) || (meaning && meaning === t);
    });
  }
  // 自动检测重合：录入短语时，检测短语中的词汇与已录入单词重合；录入单词时，检测该单词出现在已录入短语中
  // 返回建议关联的候选词条（{ entry, token }），按优先级排序
  function suggestVocabLinks(word, isPhrase) {
    const words = vocabData.words || [];
    const candidates = [];
    if (isPhrase) {
      // 录入短语：拆分短语词汇，与已录入的「单词」比对
      const tokens = splitVocabWords(word);
      words.forEach((w) => {
        if (w.type === 'phrase') return; // 只与单词比对
        tokens.forEach((tk) => {
          if (vocabMatchesEntry(tk, w)) candidates.push({ entry: w, token: tk });
        });
      });
    } else {
      // 录入单词：检测该单词是否出现在已录入的「短语」中（短语本身或其生义）
      const wl = (word || '').trim().toLowerCase();
      if (!wl) return candidates;
      words.forEach((w) => {
        if (w.type !== 'phrase') return; // 只与短语比对
        // 短语本身或其生义中是否包含该单词（作为组成部分）
        const phraseTokens = splitVocabWords(w.word);
        const inPhrase = phraseTokens.includes(wl) || vocabMatchesEntry(wl, w);
        if (inPhrase) candidates.push({ entry: w, token: wl });
      });
    }
    // 去重（同一词条只保留一次）
    const seen = {};
    return candidates.filter((c) => {
      if (seen[c.entry.id]) return false;
      seen[c.entry.id] = true;
      return true;
    });
  }

  // 查找关联到指定单词的短语列表
  function findLinkedPhrases(word) {
    const wl = (word || '').trim().toLowerCase();
    if (!wl) return [];
    return (vocabData.words || []).filter((w) => w.type === 'phrase' && w.linked && (w.linked || '').trim().toLowerCase() === wl);
  }

  function renderVocabList() {
    const el = $('vocab-list');
    const q = ($('vocab-search').value || '').trim().toLowerCase();
    let words = (vocabData.words || []).filter((w) => !w.deleted);
    if (vocabFilter === 'word') words = words.filter((w) => w.type !== 'phrase');
    else if (vocabFilter === 'phrase') words = words.filter((w) => w.type === 'phrase');
    if (q) {
      words = words.filter((w) => {
        const wordMatch = (w.word || '').toLowerCase().indexOf(q) !== -1;
        const senseMatch = (w.senses || []).some((s) => (s.meaning || '').toLowerCase().indexOf(q) !== -1);
        return wordMatch || senseMatch;
      });
    }
    const label = vocabFilter === 'word' ? '单词' : (vocabFilter === 'phrase' ? '短语' : '单词');
    $('vocab-count').textContent = '共 ' + words.length + ' 个' + label;
    if (!words.length) {
      el.innerHTML = '<div class="hint">' + (q ? '未找到匹配的' + label + '。' : '暂无' + label + '，点击「添加单词」开始记录。') + '</div>';
      return;
    }
    el.innerHTML = words.map((w) => {
      const senses = (w.senses || []).map((s) => '<span class="vocab-sense-tag">' + escapeHtml(vocabSenseLabel(s, w.type === 'phrase')) + '</span>').join('');
      const typeTag = (w.type === 'phrase') ? '<span class="vocab-item-type">短语</span>' : '<span class="vocab-item-type">单词</span>';
      // 短语：显示关联的单词；单词：显示关联到它的短语（最多显示 3 个）
      let linked = '';
      if (w.type === 'phrase' && w.linked) {
        linked = '<div class="vocab-item-linked">关联：<a class="vocab-link" data-word="' + escapeHtml(w.linked) + '">' + escapeHtml(w.linked) + '</a></div>';
      } else if (w.type !== 'phrase') {
        const phrases = findLinkedPhrases(w.word);
        if (phrases.length) {
          const shown = phrases.slice(0, 3).map((p) => '<a class="vocab-link" data-word="' + escapeHtml(p.word) + '">' + escapeHtml(p.word) + '</a>').join('、');
          linked = '<div class="vocab-item-linked">被短语关联：' + shown + (phrases.length > 3 ? ' 等 ' + phrases.length + ' 个' : '') + '</div>';
        }
      }
      const otherTag = (w.otherForms || []).length ? '<div class="vocab-item-other">其它词性：' + (w.otherForms || []).map((o) => escapeHtml(o.word || '')).join('、') + '</div>' : '';
      return '<div class="vocab-item" data-id="' + w.id + '">' +
        '<label class="vocab-check" title="加入生词卷"><input type="checkbox" data-id="' + w.id + '" /></label>' +
        '<div class="vocab-item-main">' +
        '<div class="vocab-item-word">' + escapeHtml(w.word || '') + typeTag + '</div>' +
        '<div class="vocab-item-senses">' + (senses || '<span class="hint">暂无生义</span>') + '</div>' +
        otherTag +
        linked +
        '</div>' +
        '<div class="vocab-item-actions">' +
        '<button class="vocab-item-edit" title="编辑" data-id="' + w.id + '"><svg class="ic"><use href="#i-edit"/></svg></button>' +
        '<button class="vocab-item-del" title="删除" data-id="' + w.id + '"><svg class="ic"><use href="#i-trash"/></svg></button>' +
        '</div>' +
        '</div>';
    }).join('');
    el.querySelectorAll('.vocab-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.vocab-check')) return;
        if (e.target.closest('.vocab-item-edit')) { openVocabModal((vocabData.words || []).find((x) => x.id === item.dataset.id)); return; }
        if (e.target.closest('.vocab-item-del')) { deleteVocabItem(item.dataset.id); return; }
        // 点击关联单词链接 → 跳转到对应单词详情
        const linkEl = e.target.closest('.vocab-link');
        if (linkEl) {
          const target = (vocabData.words || []).find((x) => (x.word || '').trim().toLowerCase() === (linkEl.dataset.word || '').trim().toLowerCase());
          if (target) { openVocabDetail(target.id); return; }
          toast('未找到关联单词「' + linkEl.dataset.word + '」', 3000);
          return;
        }
        openVocabDetail(item.dataset.id);
      });
    });
  }
  async function deleteVocabItem(id) {
    if (!(await askYesNo('确定删除该单词/短语？'))) return;
    const r = await api.vocab.wordsDelete(id);
    if (r && r.ok) { toast('已删除'); await loadVocab(); }
    else toast((r && r.message) || '删除失败', 3000);
  }

  async function loadVocab() {
    const r = await api.vocab.wordsList().catch(() => null);
    if (r && r.ok) {
      vocabData = r;
      // 过滤已删除（软删除标记），避免删除后仍显示
      if (Array.isArray(vocabData.words)) vocabData.words = vocabData.words.filter((w) => !w.deleted);
    }
    renderVocabList();
  }

  function openVocabDetail(id) {
    const w = (vocabData.words || []).find((x) => x.id === id);
    if (!w) return;
    vocabDetailId = id;
    const typeTag = (w.type === 'phrase') ? '<span class="vocab-detail-type">短语</span>' : '<span class="vocab-detail-type">单词</span>';
    const linked = (w.type === 'phrase' && w.linked) ? '<div class="vocab-detail-linked">关联单词：<a class="vocab-link" data-word="' + escapeHtml(w.linked) + '">' + escapeHtml(w.linked) + '</a></div>' : '';
    // 单词详情：显示关联到它的短语
    if (w.type !== 'phrase') {
      const phrases = findLinkedPhrases(w.word);
      if (phrases.length) {
        const shown = phrases.map((p) => '<a class="vocab-link" data-word="' + escapeHtml(p.word) + '">' + escapeHtml(p.word) + '</a>').join('、');
        linked += '<div class="vocab-detail-linked">被短语关联：' + shown + '</div>';
      }
    }
    $('vocab-detail-word').innerHTML = escapeHtml(w.word || '') + typeTag;
    const senses = (w.senses || []).map((s) => {
      let html = '<div class="vocab-detail-sense"><span class="vocab-detail-pos">' + escapeHtml(w.type === 'phrase' ? '' : posLabel(s.pos)) + '</span><span>' + escapeHtml(s.meaning || '') + '</span></div>';
      if (s.example) html += '<blockquote class="vocab-detail-example">' + escapeHtml(s.example) + '</blockquote>';
      return html;
    }).join('');
    const otherHtml = (w.otherForms || []).length
      ? '<div class="vocab-detail-others" style="margin-top:8px"><span style="color:var(--text-2);font-size:13px">其它词性：</span>' + (w.otherForms || []).map((o) => '<span style="margin-right:8px">' + escapeHtml(o.word || '') + ' <span style="color:var(--accent-3)">' + posLabel(o.pos) + '</span>' + (o.meaning ? ' ' + escapeHtml(o.meaning) : '') + '</span>').join('') + '</div>'
      : '';
    $('vocab-detail-senses').innerHTML = (senses || '<div class="hint">暂无生义</div>') + linked + otherHtml;
    // 复习进度
    renderVocabDetailReview(w);
    // 关联单词可点击跳转
    $('vocab-detail-senses').querySelectorAll('.vocab-link').forEach((linkEl) => {
      linkEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = (vocabData.words || []).find((x) => (x.word || '').trim().toLowerCase() === (linkEl.dataset.word || '').trim().toLowerCase());
        if (target) {
          $('vocab-detail-modal').classList.add('hidden');
          openVocabDetail(target.id);
        } else {
          toast('未找到关联单词「' + linkEl.dataset.word + '」', 3000);
        }
      });
    });
    $('vocab-detail-modal').classList.remove('hidden');
  }

  // 渲染单词详情中的复习进度
  function renderVocabDetailReview(w) {
    const el = $('vocab-detail-review');
    if (!el) return;
    const stage = Math.max(0, Math.min(w.reviewStage || 0, REVIEW_STAGE_NAMES.length - 1));
    const stageName = REVIEW_STAGE_NAMES[stage];
    const mastered = (w.reviewStage || 0) >= REVIEW_INTERVALS.length;
    const next = w.nextReview || '';
    const last = w.lastReview || '从未复习';
    const reviewCount = w.reviewCount || 0;
    const correctCount = w.correctCount || 0;
    const wrongCount = w.wrongCount || 0;
    // 阶段进度条（共 7 个阶段）
    const barPct = Math.round((stage / REVIEW_STAGE_NAMES.length) * 100);
    const nextText = next ? (next <= todayStr() ? '今天到期（待复习）' : next + ' 到期') : '待安排';
    el.innerHTML =
      '<div class="vdr-title"><svg class="ic"><use href="#i-refresh-cw"/></svg> 复习进度</div>' +
      '<div class="vdr-stage">当前阶段：<b>' + stageName + '</b>' + (mastered ? ' <span class="vdr-mastered">✓ 已掌握</span>' : '') + '</div>' +
      '<div class="vdr-bar"><div class="vdr-fill" style="width:' + barPct + '%"></div></div>' +
      '<div class="vdr-meta">' +
      '<span>复习 ' + reviewCount + ' 次</span>' +
      '<span>正确 ' + correctCount + '</span>' +
      '<span>错误 ' + wrongCount + '</span>' +
      '</div>' +
      '<div class="vdr-meta">' +
      '<span>上次复习：' + (last || '从未复习') + '</span>' +
      '<span>下次复习：' + nextText + '</span>' +
      '</div>' +
      '<button class="btn-mini vdr-reset" id="vocab-detail-reset"><svg class="ic"><use href="#i-reset"/></svg> 重置复习进度</button>';
    const resetBtn = el.querySelector('#vocab-detail-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        const r = await api.vocab.reviewReset(w.id);
        if (r && r.ok) {
          toast('已重置复习进度');
          // 更新本地数据
          const ww = (vocabData.words || []).find((x) => x.id === w.id);
          if (ww) {
            ww.reviewStage = 0; ww.lastReview = ''; ww.nextReview = ww.createdAt || todayStr();
            ww.reviewCount = 0; ww.correctCount = 0; ww.wrongCount = 0;
          }
          renderVocabDetailReview(ww || w);
        } else {
          toast((r && r.message) || '重置失败', 3000);
        }
      });
    }
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderVocabExportSelect() {
    const el = $('vocab-export-select');
    const words = vocabData.words || [];
    const itemHtml = (w) => {
      const checked = vocabExportSel[w.id] ? ' checked' : '';
      const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
      return '<label class="vocab-export-item"><input type="checkbox" data-id="' + w.id + '"' + checked + ' />' +
        '<span class="ve-word">' + escapeHtml(w.word || '') + '</span>' +
        '<span class="ve-sense">' + escapeHtml(senses) + '</span></label>';
    };
    const wordsGroup = words.filter((w) => w.type !== 'phrase');
    const phrasesGroup = words.filter((w) => w.type === 'phrase');
    let html = '';
    if (wordsGroup.length) {
      html += '<div class="ve-group"><div class="ve-group-title">单词（' + wordsGroup.length + '）</div>' + wordsGroup.map(itemHtml).join('') + '</div>';
    }
    if (phrasesGroup.length) {
      html += '<div class="ve-group"><div class="ve-group-title">短语（' + phrasesGroup.length + '）</div>' + phrasesGroup.map(itemHtml).join('') + '</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        vocabExportSel[cb.dataset.id] = cb.checked;
        updateVocabExportCount();
      });
    });
    updateVocabExportCount();
  }
  function updateVocabExportCount() {
    const n = Object.keys(vocabExportSel).filter((k) => vocabExportSel[k]).length;
    $('vocab-export-count').textContent = n;
  }

  // ================= 词语复习（艾宾浩斯遗忘曲线） =================
  let reviewData = { words: [] };
  let reviewOverviewData = null;
  let reviewQueue = [];      // 当前复习队列
  let reviewIndex = 0;       // 当前题号
  let reviewMode = 'en';     // en=给出英文写中文, zh=给出中文拼英文
  let reviewStats = { correct: 0, wrong: 0 };
  let reviewExportSel = {};

  // 艾宾浩斯间隔（与主进程一致）
  const REVIEW_INTERVALS = [1, 2, 4, 7, 15, 30, 60];
  const REVIEW_STAGE_NAMES = ['新学', '第1次', '第2次', '第3次', '第4次', '第5次', '长期巩固'];

  function reviewStageName(stage) {
    const s = Math.max(0, Math.min(stage || 0, REVIEW_STAGE_NAMES.length - 1));
    return REVIEW_STAGE_NAMES[s];
  }

  async function loadReview() {
    const [ov, due, words] = await Promise.all([
      api.vocab.reviewOverview().catch(() => null),
      api.vocab.reviewDue().catch(() => null),
      api.vocab.wordsList().catch(() => null)
    ]);
    if (ov && ov.ok) reviewOverviewData = ov;
    if (due && due.ok) {
      reviewData = due;
      // 过滤已删除，避免出现在待复习列表 / 复习队列中
      if (Array.isArray(reviewData.words)) reviewData.words = reviewData.words.filter((w) => !w.deleted);
    }
    if (words && words.ok) {
      vocabData = words;
      // 过滤已删除，避免出现在生词本列表 / 复习统计中
      if (Array.isArray(vocabData.words)) vocabData.words = vocabData.words.filter((w) => !w.deleted);
    }
    renderReviewCards();
    renderReviewDueList();
    renderReviewStages();
  }

  function renderReviewCards() {
    const el = $('review-cards');
    if (!el) return;
    const ov = reviewOverviewData || {};
    const total = ov.total || 0;
    const due = ov.due || 0;
    const mastered = ov.mastered || 0;
    const progress = total ? Math.round((mastered / total) * 100) : 0;
    el.innerHTML =
      '<div class="review-card-stat rc-accent"><span class="rc-label">今日待复习</span><span class="rc-value">' + due + '</span><span class="rc-sub">个单词需要复习</span></div>' +
      '<div class="review-card-stat"><span class="rc-label">已掌握</span><span class="rc-value">' + mastered + '</span><span class="rc-sub">完成全部阶段</span></div>' +
      '<div class="review-card-stat"><span class="rc-label">单词总数</span><span class="rc-value">' + total + '</span><span class="rc-sub">生词本全部单词</span></div>' +
      '<div class="review-card-stat"><span class="rc-label">掌握进度</span><span class="rc-value">' + progress + '%</span><span class="rc-sub">已掌握 / 总数</span></div>';
  }

  function renderReviewDueList() {
    const el = $('review-due-list');
    if (!el) return;
    const words = (reviewData.words || []).filter((w) => !w.deleted);
    if (!words.length) {
      el.innerHTML = '<div class="hint">太棒了！今天没有需要复习的单词 🎉</div>';
      return;
    }
    el.innerHTML = words.map((w) => {
      const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
      const stage = reviewStageName(w.reviewStage);
      const days = w.nextReview ? daysFromToday(w.nextReview) : 0;
      const daysText = days > 0 ? '已到期 ' + days + ' 天' : '今天到期';
      return '<div class="review-due-item">' +
        '<span class="rd-word">' + escapeHtml(w.word || '') + '</span>' +
        '<span class="rd-sense">' + escapeHtml(senses) + '</span>' +
        '<span class="rd-stage">' + stage + '</span>' +
        '<span class="rd-days">' + daysText + '</span>' +
        '</div>';
    }).join('');
  }

  function daysFromToday(dateStr) {
    if (!dateStr) return 0;
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const d = new Date(dateStr + 'T00:00:00');
    return Math.round((t - d) / 86400000);
  }

  function renderReviewStages() {
    const el = $('review-stage-list');
    if (!el) return;
    const ov = reviewOverviewData || {};
    const counts = ov.stageCounts || {};
    const total = ov.total || 0;
    const maxCount = Math.max(1, ...Object.values(counts));
    // 按阶段分组所有单词（用于展开查看）
    const stageWords = {};
    (vocabData.words || []).forEach((w) => {
      const s = Math.max(0, Math.min(w.reviewStage || 0, REVIEW_STAGE_NAMES.length - 1));
      if (!stageWords[s]) stageWords[s] = [];
      stageWords[s].push(w);
    });
    el.innerHTML = REVIEW_STAGE_NAMES.map((name, i) => {
      const c = counts[i] || 0;
      const pct = total ? Math.round((c / total) * 100) : 0;
      const barPct = maxCount ? Math.round((c / maxCount) * 100) : 0;
      const words = stageWords[i] || [];
      const listHtml = words.length ? words.map((w) => {
        const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
        return '<div class="review-stage-word" data-id="' + w.id + '">' +
          '<span class="rsw-word">' + escapeHtml(w.word || '') + '</span>' +
          '<span class="rsw-sense">' + escapeHtml(senses) + '</span>' +
          '</div>';
      }).join('') : '<div class="hint" style="padding:6px 4px">暂无单词</div>';
      return '<div class="review-stage-row">' +
        '<span class="review-stage-name">' + name + '</span>' +
        '<div class="review-stage-bar"><div class="review-stage-fill" style="width:' + barPct + '%"></div></div>' +
        '<span class="review-stage-count">' + c + ' 个（' + pct + '%）</span>' +
        (c ? '<button class="review-stage-toggle" data-stage="' + i + '" title="展开/收起">▾</button>' : '') +
        '</div>' +
        '<div class="review-stage-words" id="review-stage-words-' + i + '" style="display:none">' + listHtml + '</div>';
    }).join('');
    // 展开/收起
    el.querySelectorAll('.review-stage-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const stage = btn.dataset.stage;
        const box = $('review-stage-words-' + stage);
        const isOpen = box.style.display !== 'none';
        box.style.display = isOpen ? 'none' : 'block';
        btn.textContent = isOpen ? '▾' : '▴';
      });
    });
    // 点击单词跳转到生词本详情
    el.querySelectorAll('.review-stage-word').forEach((item) => {
      item.addEventListener('click', () => {
        const id = item.dataset.id;
        // 确保生词本数据已加载
        if (!(vocabData.words || []).length) {
          loadVocab().then(() => {
            switchView('vocab');
            openVocabDetail(id);
          });
        } else {
          switchView('vocab');
          openVocabDetail(id);
        }
      });
    });
  }

  // 开始复习
  function startReview() {
    const words = (reviewData.words || []).filter((w) => !w.deleted);
    if (!words.length) { toast('今天没有需要复习的单词'); return; }
    reviewQueue = words.slice();
    // 重置提交标记（避免上次复习残留导致本次不提交）
    reviewQueue.forEach((w) => { w._submitted = false; });
    reviewIndex = 0;
    reviewStats = { correct: 0, wrong: 0 };
    $('review-modal-title').textContent = '词语复习';
    $('review-modal').classList.remove('hidden');
    $('review-mode-row').classList.remove('hidden');
    $('review-next').classList.add('hidden');
    $('review-input-row').classList.remove('hidden');
    $('review-input').value = '';
    $('review-feedback').innerHTML = '';
    $('review-input').focus();
    renderReviewQuestion();
  }

  function renderReviewQuestion() {
    const w = reviewQueue[reviewIndex];
    if (!w) { finishReview(); return; }
    const total = reviewQueue.length;
    const cur = reviewIndex + 1;
    $('review-progress-bar').style.width = (cur / total * 100) + '%';
    $('review-progress-text').textContent = cur + ' / ' + total;
    const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
    const card = $('review-card');
    if (reviewMode === 'en') {
      // 给出英文，写中文
      card.innerHTML = '<div class="rc-prompt">请写出中文释义</div><div class="rc-main">' + escapeHtml(w.word || '') + '</div>';
    } else {
      // 给出中文，拼英文
      card.innerHTML = '<div class="rc-prompt">请拼写英文单词</div><div class="rc-main">' + escapeHtml(senses || '（无释义）') + '</div>';
    }
    $('review-input').value = '';
    $('review-feedback').innerHTML = '';
    $('review-next').classList.add('hidden');
    $('review-input-row').classList.remove('hidden');
    $('review-input').focus();
  }

  function submitReviewAnswer() {
    const w = reviewQueue[reviewIndex];
    if (!w) return;
    const answer = ($('review-input').value || '').trim();
    if (!answer) { toast('请输入答案'); return; }
    const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
    let correct = false;
    if (reviewMode === 'en') {
      // 给出英文写中文：宽松匹配（包含任一释义关键词）
      const meanings = (w.senses || []).map((s) => (s.meaning || '').toLowerCase());
      correct = meanings.some((m) => m && (answer.toLowerCase().indexOf(m) !== -1 || m.indexOf(answer.toLowerCase()) !== -1));
    } else {
      // 给出中文拼英文：精确匹配（忽略大小写与首尾空格）
      const target = (w.word || '').trim().toLowerCase();
      correct = answer.toLowerCase() === target;
    }
    // 提交结果到主进程（更新复习进度）
    // 仅首次作答时提交（升级/降级）；重复练习（重拼）答对时不再升级，只确认掌握
    if (!w._submitted) {
      api.vocab.reviewSubmit(w.id, correct);
      w._submitted = true;
    }
    if (correct) reviewStats.correct++; else reviewStats.wrong++;
    // 答错时把该词重新加入队列末尾，本轮末尾会重新复习直到拼对
    if (!correct) reviewQueue.push(w);
    // 显示反馈
    const fb = $('review-feedback');
    if (correct) {
      fb.className = 'review-feedback rf-correct';
      fb.innerHTML = '✅ 回答正确！';
    } else {
      fb.className = 'review-feedback rf-wrong';
      const expected = reviewMode === 'en' ? senses : (w.word || '');
      fb.innerHTML = '❌ 回答错误，复习进度已重置。<br>正确答案：<span class="rf-answer">' + escapeHtml(expected) + '</span><br><span class="rf-hint">本轮末尾将重新复习该词，直到拼对为止</span>';
    }
    $('review-input-row').classList.add('hidden');
    $('review-next').classList.remove('hidden');
  }

  function nextReviewQuestion() {
    reviewIndex++;
    if (reviewIndex >= reviewQueue.length) {
      finishReview();
    } else {
      renderReviewQuestion();
    }
  }

  function finishReview() {
    const correct = reviewStats.correct;
    const wrong = reviewStats.wrong;
    const total = correct + wrong;
    $('review-modal-title').textContent = '复习完成';
    $('review-progress-bar').style.width = '100%';
    $('review-progress-text').textContent = total + ' / ' + total;
    $('review-card').innerHTML =
      '<div class="rc-prompt">本次复习完成</div>' +
      '<div class="rc-main" style="font-size:22px">正确 ' + correct + ' 题 · 错误 ' + wrong + ' 题</div>' +
      '<div class="rc-hint">正确率 ' + (total ? Math.round(correct / total * 100) : 0) + '%' + (wrong ? ' · 错误单词已重置进度' : '') + '</div>';
    $('review-input-row').classList.add('hidden');
    $('review-feedback').innerHTML = '';
    $('review-next').classList.add('hidden');
    // 刷新概览
    loadReview();
  }

  function closeReviewModal() {
    $('review-modal').classList.add('hidden');
    loadReview();
  }

  // 复习卷导出
  function renderReviewExportSelect() {
    const el = $('review-export-select');
    if (!el) return;
    const words = (reviewData.words || []).length ? reviewData.words : (vocabData.words || []);
    el.innerHTML = words.map((w) => {
      const checked = reviewExportSel[w.id] ? ' checked' : '';
      const senses = (w.senses || []).map((s) => vocabSenseLabel(s, w.type === 'phrase')).join('；');
      const stage = reviewStageName(w.reviewStage);
      return '<label class="vocab-export-item"><input type="checkbox" data-id="' + w.id + '"' + checked + ' />' +
        '<span class="ve-word">' + escapeHtml(w.word || '') + '</span>' +
        '<span class="ve-sense">' + escapeHtml(senses) + '（' + stage + '）</span></label>';
    }).join('');
    el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        reviewExportSel[cb.dataset.id] = cb.checked;
        updateReviewExportCount();
      });
    });
    updateReviewExportCount();
  }
  function updateReviewExportCount() {
    const n = Object.keys(reviewExportSel).filter((k) => reviewExportSel[k]).length;
    $('review-export-count').textContent = n;
  }

  // 复习视图事件绑定
  $('review-start').addEventListener('click', startReview);
  $('review-export').addEventListener('click', () => {
    reviewExportSel = {};
    renderReviewExportSelect();
    $('review-export-modal').classList.remove('hidden');
  });
  $('review-export-close').addEventListener('click', () => $('review-export-modal').classList.add('hidden'));
  $('review-export-cancel').addEventListener('click', () => $('review-export-modal').classList.add('hidden'));
  $('review-export-go').addEventListener('click', async () => {
    const ids = Object.keys(reviewExportSel).filter((k) => reviewExportSel[k]);
    if (!ids.length) { toast('请至少选择一个单词'); return; }
    const words = (reviewData.words || []).length ? reviewData.words : (vocabData.words || []);
    const selected = words.filter((w) => ids.indexOf(w.id) !== -1);
    const r = await api.vocab.reviewExport({
      words: selected,
      mode: $('review-export-mode').value,
      withAnswer: $('review-export-answer').checked,
      title: $('review-export-title').value.trim() || '词语复习卷'
    });
    if (r && r.ok) { toast('已导出：' + r.path); $('review-export-modal').classList.add('hidden'); }
    else toast((r && r.message) || '导出失败', 3000);
  });
  $('review-modal-close').addEventListener('click', closeReviewModal);
  $('review-modal-cancel').addEventListener('click', closeReviewModal);
  $('review-submit').addEventListener('click', submitReviewAnswer);
  $('review-next').addEventListener('click', nextReviewQuestion);
  $('review-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if ($('review-next').classList.contains('hidden')) submitReviewAnswer();
      else nextReviewQuestion();
    }
  });
  // 复习模式切换
  document.querySelectorAll('#review-mode-row .review-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#review-mode-row .review-mode-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      reviewMode = btn.dataset.mode;
      renderReviewQuestion();
    });
  });

  // ================= 文言文生义 =================
  let wenyanData = { words: [] };
  let wenyanEditingId = null;
  let wenyanDetailId = null;
  let wenyanExportSel = {};
  let wenyanFilter = 'all'; // all | 字 | 词

  function wenyanSenseRowHTML(s, idx) {
    return '<div class="wenyan-sense-row" data-i="' + idx + '">' +
      '<input class="wenyan-sense-meaning" placeholder="生义" value="' + escapeHtml(s.meaning || '') + '" />' +
      '<div class="wenyan-sense-example">' +
      '<input class="wenyan-sense-ex" placeholder="例句（可选）" value="' + escapeHtml(s.example || '') + '" />' +
      '<input class="wenyan-sense-src" placeholder="来源（可选）" value="' + escapeHtml(s.source || '') + '" />' +
      '</div>' +
      '<button class="wenyan-sense-del" title="删除">✕</button>' +
      '</div>';
  }

  function renderWenyanSenses() {
    const box = $('wenyan-senses');
    const senses = box._senses || [];
    box.innerHTML = senses.length ? senses.map(wenyanSenseRowHTML).join('') : '<div class="hint">暂无生义，点击下方按钮添加。</div>';
    box.querySelectorAll('.wenyan-sense-del').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.closest('.wenyan-sense-row').dataset.i);
        box._senses.splice(i, 1);
        renderWenyanSenses();
      });
    });
  }

  function openWenyanModal(word) {
    wenyanEditingId = word ? word.id : null;
    $('wenyan-modal-title').textContent = word ? '编辑字/词' : '录入字/词';
    $('wenyan-char').value = word ? word.char : '';
    $('wenyan-type').value = word ? (word.type || '字') : '字';
    const box = $('wenyan-senses');
    box._senses = word && word.senses ? word.senses.map((s) => Object.assign({}, s)) : [];
    renderWenyanSenses();
    $('wenyan-modal').classList.remove('hidden');
    $('wenyan-char').focus();
  }

  function renderWenyanList() {
    const el = $('wenyan-list');
    const q = ($('wenyan-search').value || '').trim().toLowerCase();
    let words = (wenyanData.words || []).filter((w) => !w.deleted);
    if (wenyanFilter === '字') words = words.filter((w) => (w.type || '字') === '字');
    else if (wenyanFilter === '词') words = words.filter((w) => (w.type || '字') === '词');
    if (q) {
      words = words.filter((w) => {
        const charMatch = (w.char || '').toLowerCase().indexOf(q) !== -1;
        const senseMatch = (w.senses || []).some((s) => (s.meaning || '').toLowerCase().indexOf(q) !== -1 || (s.example || '').toLowerCase().indexOf(q) !== -1);
        return charMatch || senseMatch;
      });
    }
    const zi = words.filter((w) => (w.type || '字') === '字');
    const ci = words.filter((w) => (w.type || '字') === '词');
    $('wenyan-count').textContent = '共 ' + words.length + ' 个（字 ' + zi.length + ' · 词 ' + ci.length + '）';
    if (!words.length) {
      el.innerHTML = '<div class="hint">' + (q ? '未找到匹配的字/词。' : '暂无记录，点击「录入」开始。') + '</div>';
      return;
    }
    const itemHTML = (w) => {
      const senses = (w.senses || []).map((s) => '<span class="wenyan-sense-tag">' + escapeHtml(s.meaning || '') + '</span>').join('');
      return '<div class="wenyan-item" data-id="' + w.id + '">' +
        '<label class="wenyan-check" title="加入导出"><input type="checkbox" data-id="' + w.id + '" /></label>' +
        '<div class="wenyan-item-main">' +
        '<div class="wenyan-item-char">' + escapeHtml(w.char || '') + '<span class="wenyan-item-type">' + escapeHtml(w.type || '字') + '</span></div>' +
        '<div class="wenyan-item-senses">' + (senses || '<span class="hint">暂无生义</span>') + '</div>' +
        '</div>' +
        '<div class="wenyan-item-actions">' +
        '<button class="wenyan-item-edit" title="编辑" data-id="' + w.id + '"><svg class="ic"><use href="#i-edit"/></svg></button>' +
        '<button class="wenyan-item-del" title="删除" data-id="' + w.id + '"><svg class="ic"><use href="#i-trash"/></svg></button>' +
        '</div>' +
        '</div>';
    };
    let html = '';
    if (zi.length) html += '<div class="wenyan-group"><div class="wenyan-group-title">字</div>' + zi.map(itemHTML).join('') + '</div>';
    if (ci.length) html += '<div class="wenyan-group"><div class="wenyan-group-title">词</div>' + ci.map(itemHTML).join('') + '</div>';
    el.innerHTML = html;
    el.querySelectorAll('.wenyan-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        if (e.target.closest('.wenyan-check')) return;
        if (e.target.closest('.wenyan-item-edit')) { openWenyanModal((wenyanData.words || []).find((x) => x.id === item.dataset.id)); return; }
        if (e.target.closest('.wenyan-item-del')) { deleteWenyanItem(item.dataset.id); return; }
        openWenyanDetail(item.dataset.id);
      });
    });
  }
  async function deleteWenyanItem(id) {
    if (!(await askYesNo('确定删除该字/词？'))) return;
    const r = await api.vocab.wenyanDelete(id);
    if (r && r.ok) { toast('已删除'); await loadWenyan(); }
    else toast((r && r.message) || '删除失败', 3000);
  }

  async function loadWenyan() {
    const r = await api.vocab.wenyanList().catch(() => null);
    if (r && r.ok) {
      wenyanData = r;
      // 过滤已删除，避免删除后仍显示
      if (Array.isArray(wenyanData.words)) wenyanData.words = wenyanData.words.filter((w) => !w.deleted);
    }
    renderWenyanList();
  }

  function openWenyanDetail(id) {
    const w = (wenyanData.words || []).find((x) => x.id === id);
    if (!w) return;
    wenyanDetailId = id;
    $('wenyan-detail-char').textContent = w.char || '';
    const senses = (w.senses || []).map((s) => {
      let html = '<div class="wenyan-detail-sense"><div class="wenyan-detail-meaning">' + escapeHtml(s.meaning || '') + '</div>';
      if (s.example) {
        html += '<blockquote class="wenyan-detail-example">' + escapeHtml(s.example || '') + (s.source ? '<span class="wenyan-detail-src">——' + escapeHtml(s.source) + '</span>' : '') + '</blockquote>';
      }
      html += '</div>';
      return html;
    }).join('');
    $('wenyan-detail-senses').innerHTML = senses || '<div class="hint">暂无生义</div>';
    $('wenyan-detail-modal').classList.remove('hidden');
  }

  function renderWenyanExportSelect() {
    const el = $('wenyan-export-select');
    const words = wenyanData.words || [];
    el.innerHTML = words.map((w) => {
      const checked = wenyanExportSel[w.id] ? ' checked' : '';
      const senses = (w.senses || []).map((s) => s.meaning).join('；');
      return '<label class="wenyan-export-item"><input type="checkbox" data-id="' + w.id + '"' + checked + ' />' +
        '<span class="we-char">' + escapeHtml(w.char || '') + '</span>' +
        '<span class="we-type">' + escapeHtml(w.type || '字') + '</span>' +
        '<span class="we-sense">' + escapeHtml(senses) + '</span></label>';
    }).join('');
    el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        wenyanExportSel[cb.dataset.id] = cb.checked;
        updateWenyanExportCount();
      });
    });
    updateWenyanExportCount();
  }
  function updateWenyanExportCount() {
    const n = Object.keys(wenyanExportSel).filter((k) => wenyanExportSel[k]).length;
    $('wenyan-export-count').textContent = n;
  }

  // 生词本事件绑定
  $('vocab-add').addEventListener('click', () => openVocabModal(null));
  $('vocab-modal-close').addEventListener('click', () => $('vocab-modal').classList.add('hidden'));
  $('vocab-modal-cancel').addEventListener('click', () => $('vocab-modal').classList.add('hidden'));
  $('vocab-sense-add').addEventListener('click', () => {
    const box = $('vocab-senses');
    const isPhrase = $('vocab-type').value === 'phrase';
    box._senses.push(isPhrase ? { meaning: '' } : { pos: 'n.', meaning: '' });
    renderVocabSenses();
  });
  $('vocab-other-add').addEventListener('click', () => {
    const box = $('vocab-others');
    box._others.push({ word: '', pos: 'n.', meaning: '' });
    renderVocabOthers();
  });
  $('vocab-modal-save').addEventListener('click', async () => {
    const word = $('vocab-word').value.trim();
    if (!word) { toast('请输入英文单词/短语'); return; }
    // 内容重复检测：主词 + 其它词性里的英语单词都参与检测
    const others0 = ($('vocab-others')._others || []).filter((o) => o.word && o.word.trim());
    const allWords = [word].concat((others0 || []).map((o) => o.word.trim()));
    const lowerAll = allWords.map((s) => s.toLowerCase());
    const dup = (vocabData.words || []).find((w) => {
      if (w.deleted || w.id === vocabEditingId) return false;
      const wl = (w.word || '').trim().toLowerCase();
      if (lowerAll.indexOf(wl) !== -1) return true;
      return (w.otherForms || []).some((o) => lowerAll.indexOf((o.word || '').trim().toLowerCase()) !== -1);
    });
    if (dup) {
      const dupText = dup.word + ((dup.otherForms || []).length ? '（含其它词性）' : '');
      const goDup = await askYesNo('已有录入内容「' + dupText + '」（' + (dup.type === 'phrase' ? '短语' : '单词') + '）。\n\n点击「确认执行」跳转到该条，可补充其它词性或编辑，点击「取消」坚持录入。');
      if (goDup) {
        $('vocab-modal').classList.add('hidden');
        openVocabModal(dup); // 打开编辑弹窗，便于补充其它词性
        return;
      }
      // 用户选择坚持录入 → 继续后续校验与保存
    }
    const box = $('vocab-senses');
    const senses = (box._senses || []).filter((s) => s.meaning && s.meaning.trim());
    const otherForms = ($('vocab-others')._others || []).filter((o) => o.word && o.word.trim());
    const linked = $('vocab-linked').value.trim();
    const isPhrase = $('vocab-type').value === 'phrase';
    // 关联词语校验：处理三种情况
    if (isPhrase && linked) {
      const check = validateVocabLinked(linked);
      if (!check.ok) {
        if (check.suggestion) {
          // 情况2/3：有建议的关联词，询问是否改用
          const useSug = await askYesNo(check.message + '\n\n点击「确认执行」改用「' + check.suggestion + '」，点击「取消」保留原值。');
          if (useSug) $('vocab-linked').value = check.suggestion;
        } else {
          // 情况1：本身没有这个词，询问是否仍要关联
          const keep = await askYesNo(check.message + '\n\n点击「确认执行」仍要关联，点击「取消」清空关联。');
          if (!keep) $('vocab-linked').value = '';
        }
      }
    }
    // 自动检测重合：录入短语时检测短语词汇与已录入单词重合；录入单词时检测该单词出现在已录入短语中
    const suggestions = suggestVocabLinks(word, isPhrase);
    if (suggestions.length) {
      if (isPhrase) {
        // 录入短语：若尚未手动关联，提示是否关联到重合的单词
        if (!$('vocab-linked').value.trim()) {
          const names = suggestions.map((c) => '「' + c.entry.word + '」（' + c.token + '）').join('、');
          const linkTo = await askYesNo('检测到短语中的词汇与已录入单词重合：' + names + '\n\n是否关联到「' + suggestions[0].entry.word + '」？\n点击「确认执行」关联，点击「取消」不关联。');
          if (linkTo) $('vocab-linked').value = suggestions[0].entry.word;
        }
      } else {
        // 录入单词：检测到该单词出现在已录入短语中，提示是否关联（自动更新短语的 linked）
        const names = suggestions.map((c) => '「' + c.entry.word + '」').join('、');
        const linkPhrases = await askYesNo('检测到该单词出现在已录入短语中：' + names + '\n\n是否将这些短语关联到「' + word + '」？\n点击「确认执行」关联，点击「取消」不关联。');
        if (linkPhrases) {
          // 保存单词后，自动更新这些短语的 linked
          const pendingPhraseLinks = suggestions.map((c) => c.entry.id);
          const data2 = { word, type: $('vocab-type').value, linked: $('vocab-linked').value.trim(), senses, otherForms };
          let r2;
          if (vocabEditingId) r2 = await api.vocab.wordsUpdate(vocabEditingId, data2);
          else r2 = await api.vocab.wordsAdd(data2);
          if (r2 && r2.ok) {
            // 更新短语的 linked
            for (const pid of pendingPhraseLinks) {
              const p = (vocabData.words || []).find((x) => x.id === pid);
              if (p) {
                const pd = { word: p.word, type: 'phrase', linked: word, senses: p.senses || [] };
                await api.vocab.wordsUpdate(pid, pd).catch(() => {});
              }
            }
            toast(vocabEditingId ? '已更新' : '已添加');
            $('vocab-modal').classList.add('hidden');
            await loadVocab();
            return;
          } else {
            toast((r2 && r2.message) || '保存失败', 3000);
            return;
          }
        }
      }
    }
    // 保存单词时：若此前有短语关联了它，提示用户
    if (!isPhrase && !vocabEditingId) {
      const wordLower = word.toLowerCase();
      const linkedPhrases = (vocabData.words || []).filter((w) => w.type === 'phrase' && w.linked && (w.linked || '').trim().toLowerCase() === wordLower);
      if (linkedPhrases.length) {
        const names = linkedPhrases.map((w) => '「' + w.word + '」').join('、');
        await askYesNo('已有短语 ' + names + ' 关联到「' + word + '」。\n\n现在新建该单词后，关联即可正常跳转。');
      }
    }
    const data = { word, type: $('vocab-type').value, linked: $('vocab-linked').value.trim(), senses, otherForms };
    let r;
    if (vocabEditingId) r = await api.vocab.wordsUpdate(vocabEditingId, data);
    else r = await api.vocab.wordsAdd(data);
    if (r && r.ok) {
      toast(vocabEditingId ? '已更新' : '已添加');
      $('vocab-modal').classList.add('hidden');
      await loadVocab();
    } else toast((r && r.message) || '保存失败', 3000);
  });
  $('vocab-type').addEventListener('change', toggleVocabLinkedField);
  $('vocab-detail-close').addEventListener('click', () => $('vocab-detail-modal').classList.add('hidden'));
  $('vocab-detail-close2').addEventListener('click', () => $('vocab-detail-modal').classList.add('hidden'));
  $('vocab-detail-edit').addEventListener('click', () => {
    const w = (vocabData.words || []).find((x) => x.id === vocabDetailId);
    $('vocab-detail-modal').classList.add('hidden');
    if (w) openVocabModal(w);
  });
  $('vocab-detail-delete').addEventListener('click', async () => {
    if (!(await askYesNo('确定删除该单词？'))) return;
    const r = await api.vocab.wordsDelete(vocabDetailId);
    if (r && r.ok) { toast('已删除'); $('vocab-detail-modal').classList.add('hidden'); await loadVocab(); }
    else toast((r && r.message) || '删除失败', 3000);
  });
  $('vocab-search').addEventListener('input', renderVocabList);
  $('vocab-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.vf-btn');
    if (!btn) return;
    vocabFilter = btn.dataset.f;
    $('vocab-filter').querySelectorAll('.vf-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderVocabList();
  });
  $('vocab-export').addEventListener('click', () => {
    vocabExportSel = {};
    renderVocabExportSelect();
    $('vocab-export-modal').classList.remove('hidden');
  });
  $('vocab-export-close').addEventListener('click', () => $('vocab-export-modal').classList.add('hidden'));
  $('vocab-export-cancel').addEventListener('click', () => $('vocab-export-modal').classList.add('hidden'));
  $('vocab-export-go').addEventListener('click', async () => {
    const ids = Object.keys(vocabExportSel).filter((k) => vocabExportSel[k]);
    let words = (vocabData.words || []).filter((w) => ids.indexOf(w.id) !== -1);
    if (!words.length) { toast('请至少勾选一个单词'); return; }
    const randomN = Number($('vocab-export-random').value);
    if (randomN && randomN > 0 && randomN < words.length) {
      const shuffled = words.slice().sort(() => Math.random() - 0.5);
      words = shuffled.slice(0, randomN);
    }
    const r = await api.vocab.wordsExport({
      words,
      mode: $('vocab-export-mode').value,
      withAnswer: $('vocab-export-answer').checked,
      title: $('vocab-export-title').value.trim() || '英语生词卷'
    });
    if (r && r.ok) { toast('已导出：' + r.path); $('vocab-export-modal').classList.add('hidden'); }
    else if (r && r.canceled) { /* 用户取消 */ }
    else toast((r && r.message) || '导出失败', 3000);
  });

  // 文言文事件绑定
  $('wenyan-add').addEventListener('click', () => openWenyanModal(null));
  $('wenyan-modal-close').addEventListener('click', () => $('wenyan-modal').classList.add('hidden'));
  $('wenyan-modal-cancel').addEventListener('click', () => $('wenyan-modal').classList.add('hidden'));
  $('wenyan-sense-add').addEventListener('click', () => {
    const box = $('wenyan-senses');
    box._senses.push({ meaning: '', example: '', source: '' });
    renderWenyanSenses();
  });
  $('wenyan-modal-save').addEventListener('click', async () => {
    const char = $('wenyan-char').value.trim();
    if (!char) { toast('请输入字/词'); return; }
    // 内容重复检测：已有同内容时提示「跳转补充」或「坚持录入」
    const dup = (wenyanData.words || []).find((w) => !w.deleted && w.id !== wenyanEditingId && (w.char || '').trim() === char);
    if (dup) {
      const goDup = await askYesNo('已有录入内容「' + dup.char + '」（' + (dup.type || '字') + '）。\n\n点击「确认执行」跳转到该条编辑/补充，点击「取消」坚持录入。');
      if (goDup) {
        $('wenyan-modal').classList.add('hidden');
        openWenyanModal(dup); // 打开编辑弹窗，便于补充
        return;
      }
      // 用户选择坚持录入 → 继续保存
    }
    const box = $('wenyan-senses');
    const senses = (box._senses || []).filter((s) => s.meaning && s.meaning.trim());
    const data = { char, type: $('wenyan-type').value, senses };
    let r;
    if (wenyanEditingId) r = await api.vocab.wenyanUpdate(wenyanEditingId, data);
    else r = await api.vocab.wenyanAdd(data);
    if (r && r.ok) {
      toast(wenyanEditingId ? '已更新' : '已录入');
      $('wenyan-modal').classList.add('hidden');
      await loadWenyan();
    } else toast((r && r.message) || '保存失败', 3000);
  });
  $('wenyan-detail-close').addEventListener('click', () => $('wenyan-detail-modal').classList.add('hidden'));
  $('wenyan-detail-close2').addEventListener('click', () => $('wenyan-detail-modal').classList.add('hidden'));
  $('wenyan-detail-edit').addEventListener('click', () => {
    const w = (wenyanData.words || []).find((x) => x.id === wenyanDetailId);
    $('wenyan-detail-modal').classList.add('hidden');
    if (w) openWenyanModal(w);
  });
  $('wenyan-detail-delete').addEventListener('click', async () => {
    if (!(await askYesNo('确定删除该字/词？'))) return;
    const r = await api.vocab.wenyanDelete(wenyanDetailId);
    if (r && r.ok) { toast('已删除'); $('wenyan-detail-modal').classList.add('hidden'); await loadWenyan(); }
    else toast((r && r.message) || '删除失败', 3000);
  });
  $('wenyan-search').addEventListener('input', renderWenyanList);
  $('wenyan-filter').addEventListener('click', (e) => {
    const btn = e.target.closest('.vf-btn');
    if (!btn) return;
    wenyanFilter = btn.dataset.f;
    $('wenyan-filter').querySelectorAll('.vf-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderWenyanList();
  });
  $('wenyan-export').addEventListener('click', () => {
    wenyanExportSel = {};
    renderWenyanExportSelect();
    $('wenyan-export-modal').classList.remove('hidden');
  });
  $('wenyan-export-close').addEventListener('click', () => $('wenyan-export-modal').classList.add('hidden'));
  $('wenyan-export-cancel').addEventListener('click', () => $('wenyan-export-modal').classList.add('hidden'));
  $('wenyan-export-go').addEventListener('click', async () => {
    const ids = Object.keys(wenyanExportSel).filter((k) => wenyanExportSel[k]);
    const words = (wenyanData.words || []).filter((w) => ids.indexOf(w.id) !== -1);
    if (!words.length) { toast('请至少勾选一个字/词'); return; }
    const r = await api.vocab.wenyanExport({
      words,
      title: $('wenyan-export-title').value.trim() || '文言文生义'
    });
    if (r && r.ok) { toast('已导出：' + r.path); $('wenyan-export-modal').classList.add('hidden'); }
    else if (r && r.canceled) { /* 用户取消 */ }
    else toast((r && r.message) || '导出失败', 3000);
  });

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
