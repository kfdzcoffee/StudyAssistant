// 轻量 Markdown 渲染器（支持标题/表格/列表/引用/代码/行内样式/数学透传）
(function (global) {
  'use strict';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(s) {
    s = esc(s);
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;"/>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // 数学：先处理 $$...$$ 显示公式，再用负向前/后断言避免在 $$ 内部重复匹配
    s = s.replace(/\$\$([^$]+)\$\$/g, '<span class="math">$$$$$1$$$$</span>');
    s = s.replace(/(?<!\$)\$([^$\n]+)\$(?!\$)/g, '<span class="math">$$$1$$</span>');
    return s;
  }

  function render(md) {
    md = String(md || '').replace(/\r\n/g, '\n');
    const lines = md.split('\n');
    let html = '';
    let listStack = [];
    let i = 0;

    function closeList() {
      while (listStack.length) html += listStack.pop() === 'ul' ? '</ul>' : '</ol>';
    }
    function openList(type) {
      if (listStack[listStack.length - 1] !== type) {
        closeList();
        html += type === 'ul' ? '<ul>' : '<ol>';
        listStack.push(type);
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { closeList(); i++; continue; }

      if (/^```/.test(line)) {
        closeList();
        const code = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        html += '<pre><code>' + esc(code.join('\n')) + '</code></pre>';
        continue;
      }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        closeList();
        const lvl = h[1].length;
        html += '<h' + lvl + '>' + inline(h[2]) + '</h' + lvl + '>';
        i++;
        continue;
      }

      if (/^---+$/.test(line)) { closeList(); html += '<hr/>'; i++; continue; }

      if (/^\s*[-*]\s+/.test(line)) {
        openList('ul');
        html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>';
        i++;
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        openList('ol');
        html += '<li>' + inline(line.replace(/^\s*\d+\.\s+/, '')) + '</li>';
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        closeList();
        const bq = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
        html += '<blockquote>' + render(bq.join('\n')) + '</blockquote>';
        continue;
      }

      if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|\-]+\|$/.test(lines[i + 1])) {
        closeList();
        const head = line.split('|').slice(1, -1);
        const aligns = lines[i + 1].split('|').slice(1, -1)
          .map((c) => (/:-+:/.test(c) ? 'center' : /-+:/.test(c) ? 'right' : 'left'));
        i += 2;
        html += '<table><thead><tr>' + head.map((c, k) => '<th style="text-align:' + (aligns[k] || 'left') + '">' + inline(c.trim()) + '</th>').join('') + '</tr></thead><tbody>';
        while (i < lines.length && /^\|/.test(lines[i])) {
          const cells = lines[i].split('|').slice(1, -1);
          html += '<tr>' + cells.map((c, k) => '<td style="text-align:' + (aligns[k] || 'left') + '">' + inline(c.trim()) + '</td>').join('') + '</tr>';
          i++;
        }
        html += '</tbody></table>';
        continue;
      }

      // 段落
      closeList();
      const para = [];
      const stop = /^\s*$|^#{1,4}\s|^```|^\s*[-*]\s|^\s*\d+\.\s|^\s*>\s?|^\||^---+$/;
      while (i < lines.length && !stop.test(lines[i])) { para.push(lines[i]); i++; }
      html += '<p>' + inline(para.join('<br/>')) + '</p>';
    }
    closeList();
    return html;
  }

  global.Markdown = { render };
})(window);
