// ============================================================
// MindGraph — Plain JS mind-mapping app
// ============================================================

(function () {
  'use strict';

  // ---- Storage abstraction (localStorage with in-memory fallback) ----
  const _memStore = {};
  const store = {
    getItem(key) {
      try { return window['local' + 'Storage'].getItem(key); }
      catch { return _memStore[key] || null; }
    },
    setItem(key, value) {
      try { window['local' + 'Storage'].setItem(key, value); }
      catch { _memStore[key] = value; }
    },
    removeItem(key) {
      try { window['local' + 'Storage'].removeItem(key); }
      catch { delete _memStore[key]; }
    }
  };

  // ---- State ----
  const state = {
    boards: [],           // [{id, name, data: {nodes, fields, connections, groups, viewport}}]
    activeBoardId: null,
    nodes: [],            // [{id, x, y, title, body, color, groupId}]
    fields: [],           // [{id, x, y, body}]
    connections: [],      // [{id, from, to}]
    groups: [],           // [{id, label, nodeIds, color}]
    viewport: { x: 0, y: 0, zoom: 1 },
    selected: new Set(),  // node ids
    selectedConnections: new Set(),
    connectMode: false,
    connectFrom: null,
    connectionTargets: [],
    connectionNumberBuffer: '',
    movingNodeId: null,
    isDragging: false,
    isPanning: false,
    isSelecting: false,
    dragOffset: null,
    panStart: null,
    selectStart: null,
    modalNodeId: null,
    modalFieldId: null,
    addMenuOpen: false,
    addMenuIndex: 0,
    dragMoved: false,
    suppressNodeClickUntil: 0,
    suppressModalCloseUntil: 0,
    previewSelecting: false,
    previewSelectionMoved: false,
    modalPointerDownInside: false,
  };

  let idCounter = 0;
  function genId() { return 'n' + Date.now().toString(36) + (idCounter++).toString(36); }

  // ---- DOM refs ----
  const $ = (s) => document.querySelector(s);
  const canvas = $('#canvasArea');
  const nodesCont = $('#nodesContainer');
  const svg = $('#connectionsSvg');
  const boardPanel = $('#boardPanel');
  const boardList = $('#boardList');
  const boardNameEl = $('#boardName');
  const editorModal = $('#editorModal');
  const modalEditor = $('#modalEditor');
  const modalPreview = $('#modalPreview');
  const modalTitle = $('#modalTitle');
  const contextMenu = $('#contextMenu');
  const colorPicker = $('#colorPicker');
  const zoomDisplay = $('#zoomLevel');
  const selectionRect = $('#selectionRect');
  const connectBtn = $('#btnConnect');
  const editorModeBadge = $('#editorModeBadge');
  const modalTypeLabel = $('#modalTypeLabel');
  const addMenu = $('#addMenu');

  function setEditorBadge(text, kind) {
    if (!editorModeBadge) return;
    editorModeBadge.textContent = text;
    editorModeBadge.dataset.mode = kind;
  }

  function editorBridge() {
    return window.MindGraphCodeEditor || null;
  }

  function getModalEditorValue() {
    const editor = editorBridge();
    return editor?.isReady() ? editor.getValue() : modalEditor.value;
  }

  function setModalEditorValue(value) {
    const text = value || '';
    modalEditor.value = text;
    const editor = editorBridge();
    if (editor?.isReady()) editor.setValue(text);
  }

  function focusModalEditor() {
    const editor = editorBridge();
    if (editor?.isReady()) editor.focus();
    else modalEditor.focus();
  }

  function refreshModalEditor() {
    const editor = editorBridge();
    if (editor?.isReady() && editor.refresh) editor.refresh();
  }

  function refreshModalPreview() {
    modalPreview.innerHTML = renderMd(getModalEditorValue());
  }

  function escapeHtml(value) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderInlineMd(text) {
    return text
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }

  function renderMdFallback(text) {
    const lines = text.split('\n');
    const html = [];
    let paragraph = [];
    let listItems = [];
    let codeLines = [];
    let inCodeBlock = false;

    function flushParagraph() {
      if (!paragraph.length) return;
      html.push('<p>' + renderInlineMd(paragraph.join('<br>')) + '</p>');
      paragraph = [];
    }

    function flushList() {
      if (!listItems.length) return;
      html.push('<ul>' + listItems.map(item => '<li>' + renderInlineMd(item) + '</li>').join('') + '</ul>');
      listItems = [];
    }

    function flushCodeBlock() {
      if (!codeLines.length) return;
      html.push('<pre><code>' + codeLines.join('\n') + '</code></pre>');
      codeLines = [];
    }

    for (const line of lines) {
      if (line.startsWith('```')) {
        flushParagraph();
        flushList();
        if (inCodeBlock) {
          flushCodeBlock();
          inCodeBlock = false;
        } else {
          inCodeBlock = true;
        }
        continue;
      }

      if (inCodeBlock) {
        codeLines.push(line);
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        flushList();
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushParagraph();
        flushList();
        const level = heading[1].length;
        html.push(`<h${level}>${renderInlineMd(heading[2])}</h${level}>`);
        continue;
      }

      const listItem = line.match(/^[-*]\s+(.*)$/);
      if (listItem) {
        flushParagraph();
        listItems.push(listItem[1]);
        continue;
      }

      paragraph.push(line);
    }

    flushParagraph();
    flushList();
    flushCodeBlock();

    return html.join('');
  }

  function renderMath(tex, displayMode) {
    if (window.katex?.renderToString) {
      return window.katex.renderToString(tex.trim(), { displayMode, throwOnError: false });
    }
    const cls = displayMode ? 'math-display' : 'math-inline';
    const tag = displayMode ? 'div' : 'span';
    return `<${tag} class="${cls}"><code>${escapeHtml(tex.trim())}</code></${tag}>`;
  }

  // ---- Markdown + LaTeX rendering ----
  function renderMd(text) {
    if (!text) return '';
    const mathTokens = [];
    const stashMath = (html) => {
      const token = `MINDGRAPH_MATH_${mathTokens.length}__`;
      mathTokens.push(html);
      return token;
    };
    // Process LaTeX before markdown
    // Display math: $$...$$
    let processed = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      try {
        return stashMath(renderMath(tex, true));
      } catch { return stashMath('<code>' + escapeHtml(tex) + '</code>'); }
    });
    // Inline math: $...$  (but not $$)
    processed = processed.replace(/(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)/g, (_, tex) => {
      try {
        return stashMath(renderMath(tex, false));
      } catch { return stashMath('<code>' + escapeHtml(tex) + '</code>'); }
    });
    processed = escapeHtml(processed);
    // Now render markdown
    const html = window.marked?.parse
      ? window.marked.parse(processed, { breaks: true, gfm: true })
      : renderMdFallback(processed);
    return html.replace(/MINDGRAPH_MATH_(\d+)__/g, (_, index) => mathTokens[Number(index)] || '');
  }

  // ---- Viewport / transform ----
  function applyViewport() {
    const { x, y, zoom } = state.viewport;
    nodesCont.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    zoomDisplay.textContent = Math.round(zoom * 100) + '%';
    // Update grid background offset
    canvas.style.setProperty('--bg-offset-x', x + 'px');
    canvas.style.setProperty('--bg-offset-y', y + 'px');
    canvas.style.backgroundSize = (40 * zoom) + 'px ' + (40 * zoom) + 'px';
    // Zoom-level classes for detail hiding
    canvas.classList.toggle('zoom-far', zoom < 0.5 && zoom >= 0.25);
    canvas.classList.toggle('zoom-very-far', zoom < 0.25);
    drawConnections();
    updateCrosshairTarget();
  }

  function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function screenToWorld(clientX, clientY) {
    const screen = clientToCanvas(clientX, clientY);
    const { x, y, zoom } = state.viewport;
    return { x: (screen.x - x) / zoom, y: (screen.y - y) / zoom };
  }

  function worldToScreen(wx, wy) {
    const { x, y, zoom } = state.viewport;
    return { x: wx * zoom + x, y: wy * zoom + y };
  }

  function canvasCenterClient() {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  function worldAtCrosshair() {
    const center = canvasCenterClient();
    return screenToWorld(center.x, center.y);
  }

  function itemUnderCrosshair() {
    const center = canvasCenterClient();
    const el = document.elementFromPoint(center.x, center.y)?.closest('.node, .field');
    if (!el || !nodesCont.contains(el)) return null;
    if (el.classList.contains('node')) {
      const item = state.nodes.find(node => node.id === el.dataset.id);
      return item ? { kind: 'node', item, el } : null;
    }
    const item = state.fields.find(field => field.id === el.dataset.fieldId);
    return item ? { kind: 'field', item, el } : null;
  }

  function updateCrosshairTarget() {
    nodesCont.querySelectorAll('.crosshair-target').forEach(el => el.classList.remove('crosshair-target'));
    itemUnderCrosshair()?.el.classList.add('crosshair-target');
  }

  function commitActiveTitleEdit() {
    const active = document.activeElement;
    if (active?.classList?.contains('node-header-text')) {
      active.blur();
    }
  }

  // ---- Node rendering ----
  function createNodeEl(node) {
    const el = document.createElement('div');
    el.className = 'node';
    el.dataset.id = node.id;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';

    const colorDot = node.color && node.color !== '#cdccca'
      ? `<span class="color-dot" style="background:${node.color}"></span>` : '';

    el.innerHTML = `
      <div class="node-header">
        ${colorDot}
        <span class="node-header-text" contenteditable="true" spellcheck="false">${esc(node.title)}</span>
      </div>
      <div class="node-body">${node.body ? '<div class="md-preview">' + renderMd(node.body) + '</div>' : ''}</div>
      <div class="node-expand" title="Expand (Enter)">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9,1 15,1 15,7"/><polyline points="7,15 1,15 1,9"/>
          <line x1="15" y1="1" x2="9" y2="7"/><line x1="1" y1="15" x2="7" y2="9"/>
        </svg>
      </div>
      <div class="node-port top" data-port="top"></div>
      <div class="node-port bottom" data-port="bottom"></div>
      <div class="node-port left" data-port="left"></div>
      <div class="node-port right" data-port="right"></div>
    `;

    // Header editing
    const headerText = el.querySelector('.node-header-text');
    headerText.addEventListener('blur', () => {
      node.title = headerText.textContent.trim() || 'Untitled';
      save();
    });
    headerText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); headerText.blur(); }
      e.stopPropagation();
    });
    headerText.addEventListener('mousedown', (e) => {
      // Allow connect mode clicks to bubble
      if (state.connectMode) return;
      // Shift-click: don't focus the editable, let multi-select work
      if (e.shiftKey) {
        e.preventDefault();
        return; // bubble up to canvas handler
      }
      e.stopPropagation();
    });
    headerText.addEventListener('focus', (e) => e.stopPropagation());

    // Body click -> open modal
    el.querySelector('.node-body').addEventListener('click', (e) => {
      if (state.connectMode) { finishConnection(node.id); return; }
      if (Date.now() < state.suppressNodeClickUntil) {
        e.stopPropagation();
        return;
      }
      e.stopPropagation();
      openModal(node.id);
    });

    // Expand button -> open modal
    el.querySelector('.node-expand').addEventListener('click', (e) => {
      if (state.connectMode) { finishConnection(node.id); return; }
      e.stopPropagation();
      openModal(node.id);
    });
    el.querySelector('.node-expand').addEventListener('mousedown', (e) => {
      if (state.connectMode) return;
      e.stopPropagation();
    });

    // Port mousedown -> start connection
    el.querySelectorAll('.node-port').forEach(port => {
      port.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        startConnection(node.id);
      });
    });

    // Context menu
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.selected.has(node.id)) {
        clearSelection();
        selectNode(node.id);
      }
      showContextMenu(e.clientX, e.clientY);
    });

    nodesCont.appendChild(el);
    return el;
  }

  function updateNodeEl(node) {
    const el = nodesCont.querySelector(`[data-id="${node.id}"]`);
    if (!el) return;
    el.style.left = node.x + 'px';
    el.style.top = node.y + 'px';
    const headerText = el.querySelector('.node-header-text');
    if (document.activeElement !== headerText) {
      headerText.textContent = node.title;
    }
    const colorDot = el.querySelector('.color-dot');
    if (node.color && node.color !== '#cdccca') {
      if (colorDot) {
        colorDot.style.background = node.color;
      } else {
        const dot = document.createElement('span');
        dot.className = 'color-dot';
        dot.style.background = node.color;
        el.querySelector('.node-header').insertBefore(dot, headerText);
      }
    } else if (colorDot) {
      colorDot.remove();
    }
  }

  function refreshNodeBody(node) {
    const el = nodesCont.querySelector(`[data-id="${node.id}"]`);
    if (!el) return;
    const body = el.querySelector('.node-body');
    body.innerHTML = node.body ? '<div class="md-preview">' + renderMd(node.body) + '</div>' : '';
    updateCrosshairTarget();
  }

  function createFieldEl(field) {
    const el = document.createElement('div');
    el.className = 'field';
    el.dataset.fieldId = field.id;
    el.style.left = field.x + 'px';
    el.style.top = field.y + 'px';
    el.innerHTML = field.body ? renderMd(field.body) : '';
    el.title = 'Field — Enter to edit, D to delete';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.connectMode) return;
      if (Date.now() < state.suppressNodeClickUntil) return;
      openFieldModal(field.id);
    });
    nodesCont.appendChild(el);
    return el;
  }

  function refreshFieldEl(field) {
    const el = nodesCont.querySelector(`[data-field-id="${field.id}"]`);
    if (!el) return;
    el.innerHTML = field.body ? renderMd(field.body) : '';
    updateCrosshairTarget();
  }

  // ---- Connections (SVG) ----
  function drawConnections() {
    // Remove existing paths (keep defs)
    svg.querySelectorAll('path').forEach(p => p.remove());
    const { x: vx, y: vy, zoom } = state.viewport;

    for (const conn of state.connections) {
      const fromNode = state.nodes.find(n => n.id === conn.from);
      const toNode = state.nodes.find(n => n.id === conn.to);
      if (!fromNode || !toNode) continue;

      const fromEl = nodesCont.querySelector(`[data-id="${conn.from}"]`);
      const toEl = nodesCont.querySelector(`[data-id="${conn.to}"]`);
      if (!fromEl || !toEl) continue;

      const fromRect = { x: fromNode.x, y: fromNode.y, w: fromEl.offsetWidth, h: fromEl.offsetHeight };
      const toRect = { x: toNode.x, y: toNode.y, w: toEl.offsetWidth, h: toEl.offsetHeight };

      const fromCenter = { x: fromRect.x + fromRect.w / 2, y: fromRect.y + fromRect.h / 2 };
      const toCenter = { x: toRect.x + toRect.w / 2, y: toRect.y + toRect.h / 2 };

      // Find best connection points
      const fromPt = closestEdgePoint(fromRect, toCenter);
      const toPt = closestEdgePoint(toRect, fromCenter);

      // Screen coords
      const sx1 = fromPt.x * zoom + vx;
      const sy1 = fromPt.y * zoom + vy;
      const sx2 = toPt.x * zoom + vx;
      const sy2 = toPt.y * zoom + vy;

      const dx = sx2 - sx1;
      const dy = sy2 - sy1;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const curveStr = Math.min(dist * 0.35, 120);

      // Determine curve direction based on edge points
      let cx1, cy1, cx2, cy2;
      const fromSide = fromPt.side;
      const toSide = toPt.side;

      if (fromSide === 'top' || fromSide === 'bottom') {
        cy1 = sy1 + (fromSide === 'top' ? -curveStr : curveStr);
        cx1 = sx1;
      } else {
        cx1 = sx1 + (fromSide === 'left' ? -curveStr : curveStr);
        cy1 = sy1;
      }
      if (toSide === 'top' || toSide === 'bottom') {
        cy2 = sy2 + (toSide === 'top' ? -curveStr : curveStr);
        cx2 = sx2;
      } else {
        cx2 = sx2 + (toSide === 'left' ? -curveStr : curveStr);
        cy2 = sy2;
      }

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${sx1},${sy1} C${cx1},${cy1} ${cx2},${cy2} ${sx2},${sy2}`);
      path.classList.add('connection');
      if (state.selectedConnections.has(conn.id)) path.classList.add('selected');
      path.dataset.id = conn.id;
      path.style.pointerEvents = 'stroke';

      path.addEventListener('click', (e) => {
        e.stopPropagation();
        selectConnection(conn.id);
      });
      path.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectConnection(conn.id);
        showContextMenu(e.clientX, e.clientY);
      });

      svg.appendChild(path);
    }
  }

  function closestEdgePoint(rect, target) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const dx = target.x - cx;
    const dy = target.y - cy;

    const points = [
      { x: cx, y: rect.y, side: 'top' },
      { x: cx, y: rect.y + rect.h, side: 'bottom' },
      { x: rect.x, y: cy, side: 'left' },
      { x: rect.x + rect.w, y: cy, side: 'right' },
    ];

    // Pick the edge facing the target
    let best = points[0], bestScore = -Infinity;
    for (const p of points) {
      const pdx = p.x - cx, pdy = p.y - cy;
      const score = pdx * dx + pdy * dy; // dot product
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  // ---- Groups / Subgraphs ----
  function renderGroups() {
    // Remove old group elements
    nodesCont.querySelectorAll('.subgraph, .subgraph-label').forEach(el => el.remove());
    for (const group of state.groups) {
      const memberNodes = state.nodes.filter(n => group.nodeIds.includes(n.id));
      if (memberNodes.length === 0) continue;

      // Calculate bounding box
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of memberNodes) {
        const el = nodesCont.querySelector(`[data-id="${n.id}"]`);
        const w = el ? el.offsetWidth : 160;
        const h = el ? el.offsetHeight : 60;
        minX = Math.min(minX, n.x);
        minY = Math.min(minY, n.y);
        maxX = Math.max(maxX, n.x + w);
        maxY = Math.max(maxY, n.y + h);
      }

      const pad = 24;
      const rect = document.createElement('div');
      rect.className = 'subgraph' + (state.selected.has(group.id) ? ' selected' : '');
      rect.dataset.groupId = group.id;
      rect.style.left = (minX - pad) + 'px';
      rect.style.top = (minY - pad) + 'px';
      rect.style.width = (maxX - minX + pad * 2) + 'px';
      rect.style.height = (maxY - minY + pad * 2) + 'px';
      if (group.color) {
        rect.style.borderColor = group.color;
        rect.style.background = group.color + '0a';
      }

      const label = document.createElement('div');
      label.className = 'subgraph-label';
      label.textContent = group.label;
      label.style.left = (minX - pad + 12) + 'px';
      label.style.top = (minY - pad - 22) + 'px';
      if (group.color) label.style.color = group.color;
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        const newLabel = prompt('Group label:', group.label);
        if (newLabel !== null) {
          group.label = newLabel;
          renderGroups();
          save();
        }
      });

      // Insert before nodes so they appear behind
      nodesCont.insertBefore(rect, nodesCont.firstChild);
      nodesCont.insertBefore(label, nodesCont.firstChild);
    }
  }

  // ---- Selection ----
  function selectNode(id) {
    if (state.selectedConnections.size > 0) {
      state.selectedConnections.clear();
      drawConnections();
    }
    state.selected.add(id);
    const el = nodesCont.querySelector(`[data-id="${id}"]`);
    if (el) el.classList.add('selected');
  }

  function deselectNode(id) {
    state.selected.delete(id);
    const el = nodesCont.querySelector(`[data-id="${id}"]`);
    if (el) el.classList.remove('selected');
  }

  function clearNodeSelection() {
    for (const id of state.selected) {
      const el = nodesCont.querySelector(`[data-id="${id}"]`);
      if (el) el.classList.remove('selected');
    }
    state.selected.clear();
  }

  function selectConnection(id) {
    clearNodeSelection();
    state.selectedConnections.clear();
    state.selectedConnections.add(id);
    drawConnections();
  }

  function clearSelection() {
    clearNodeSelection();
    state.selectedConnections.clear();
    drawConnections();
  }

  function selectNodesInRect(sx, sy, ex, ey) {
    const { x: vx, y: vy, zoom } = state.viewport;
    const start = clientToCanvas(sx, sy);
    const end = clientToCanvas(ex, ey);
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const right = Math.max(start.x, end.x);
    const bottom = Math.max(start.y, end.y);

    for (const node of state.nodes) {
      const el = nodesCont.querySelector(`[data-id="${node.id}"]`);
      if (!el) continue;
      const nx = node.x * zoom + vx;
      const ny = node.y * zoom + vy;
      const nw = el.offsetWidth * zoom;
      const nh = el.offsetHeight * zoom;
      if (nx + nw > left && nx < right && ny + nh > top && ny < bottom) {
        selectNode(node.id);
      }
    }
  }

  // ---- Connection mode ----
  let connectionNumberTimer = null;

  function renderConnectionShortcuts() {
    nodesCont.querySelectorAll('.connection-shortcut').forEach(el => el.remove());
    state.connectionTargets.forEach((nodeId, index) => {
      const nodeEl = nodesCont.querySelector(`[data-id="${nodeId}"]`);
      if (!nodeEl) return;
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'connection-shortcut';
      badge.textContent = String(index + 1);
      badge.title = `Connect to ${nodeEl.querySelector('.node-header-text')?.textContent || 'node'}`;
      badge.addEventListener('mousedown', e => e.stopPropagation());
      badge.addEventListener('click', (e) => {
        e.stopPropagation();
        finishConnection(nodeId);
      });
      nodeEl.appendChild(badge);
    });
  }

  function startConnection(nodeId) {
    state.connectMode = true;
    state.connectFrom = nodeId;
    state.connectionTargets = state.nodes.filter(node => node.id !== nodeId).map(node => node.id);
    state.connectionNumberBuffer = '';
    canvas.classList.add('connecting');
    connectBtn.classList.add('active');
    nodesCont.querySelectorAll('.node').forEach(el => {
      el.classList.toggle('connect-target', el.dataset.id !== nodeId);
    });
    renderConnectionShortcuts();
    showToast('Press a displayed number or click its badge · Esc to cancel');
  }

  function finishConnection(toId) {
    if (state.connectFrom && toId !== state.connectFrom) {
      const existing = state.connections.find(c =>
        (c.from === state.connectFrom && c.to === toId) ||
        (c.from === toId && c.to === state.connectFrom)
      );
      if (existing) {
        state.connections = state.connections.filter(connection => connection.id !== existing.id);
        showToast('Connection removed');
      } else {
        state.connections.push({ id: genId(), from: state.connectFrom, to: toId });
        showToast('Nodes connected');
      }
      drawConnections();
      save();
    }
    cancelConnection();
  }

  function cancelConnection() {
    clearTimeout(connectionNumberTimer);
    connectionNumberTimer = null;
    state.connectMode = false;
    state.connectFrom = null;
    state.connectionTargets = [];
    state.connectionNumberBuffer = '';
    canvas.classList.remove('connecting');
    connectBtn.classList.remove('active');
    svg.querySelector('.connection-temp')?.remove();
    nodesCont.querySelectorAll('.node').forEach(el => el.classList.remove('connect-target'));
    nodesCont.querySelectorAll('.connection-shortcut').forEach(el => el.remove());
  }

  function handleConnectionNumber(digit) {
    clearTimeout(connectionNumberTimer);
    let buffer = state.connectionNumberBuffer + digit;
    let matches = state.connectionTargets
      .map((id, index) => ({ id, label: String(index + 1) }))
      .filter(target => target.label.startsWith(buffer));
    if (matches.length === 0) {
      buffer = digit;
      matches = state.connectionTargets
        .map((id, index) => ({ id, label: String(index + 1) }))
        .filter(target => target.label.startsWith(buffer));
    }
    if (matches.length === 0) {
      state.connectionNumberBuffer = '';
      return;
    }
    state.connectionNumberBuffer = buffer;
    const exact = matches.find(target => target.label === buffer);
    const hasLongerMatch = matches.some(target => target.label.length > buffer.length);
    if (exact && !hasLongerMatch) {
      finishConnection(exact.id);
      return;
    }
    showToast(`Target ${buffer}…`);
    connectionNumberTimer = setTimeout(() => {
      const target = state.connectionTargets
        .map((id, index) => ({ id, label: String(index + 1) }))
        .find(candidate => candidate.label === state.connectionNumberBuffer);
      if (target) finishConnection(target.id);
      else state.connectionNumberBuffer = '';
    }, 650);
  }

  // ---- Modal ----
  function openModal(nodeId) {
    commitActiveTitleEdit();
    const node = state.nodes.find(n => n.id === nodeId);
    if (!node) return;
    state.modalNodeId = nodeId;
    state.modalFieldId = null;
    modalTitle.classList.remove('hidden');
    modalTypeLabel.classList.add('hidden');
    modalTitle.value = node.title;
    setModalEditorValue(node.body || '');
    refreshModalPreview();
    editorModal.classList.remove('hidden');
    refreshModalEditor();
    requestAnimationFrame(refreshModalEditor);
    focusModalEditor();
  }

  function openFieldModal(fieldId) {
    commitActiveTitleEdit();
    const field = state.fields.find(item => item.id === fieldId);
    if (!field) return;
    state.modalNodeId = null;
    state.modalFieldId = fieldId;
    modalTitle.classList.add('hidden');
    modalTypeLabel.classList.remove('hidden');
    setModalEditorValue(field.body || '');
    refreshModalPreview();
    editorModal.classList.remove('hidden');
    refreshModalEditor();
    requestAnimationFrame(refreshModalEditor);
    focusModalEditor();
  }

  function closeModalFn() {
    if (state.modalNodeId) {
      const node = state.nodes.find(n => n.id === state.modalNodeId);
      if (node) {
        node.title = modalTitle.value.trim() || 'Untitled';
        node.body = getModalEditorValue();
        updateNodeEl(node);
        refreshNodeBody(node);
        save();
      }
    }
    if (state.modalFieldId) {
      const field = state.fields.find(item => item.id === state.modalFieldId);
      if (field) {
        field.body = getModalEditorValue();
        refreshFieldEl(field);
        save();
      }
    }
    state.modalNodeId = null;
    state.modalFieldId = null;
    editorModal.classList.add('hidden');
  }

  modalEditor.addEventListener('input', refreshModalPreview);

  modalTitle.addEventListener('keydown', (e) => {
    e.stopPropagation();
  });

  function bindCodeEditor() {
    const editor = editorBridge();
    if (!editor?.onChange) return;
    editor.onChange((value) => {
      modalEditor.value = value;
      refreshModalPreview();
    });
  }

  bindCodeEditor();
  window.addEventListener('mindgraph:editor-ready', bindCodeEditor);
  window.addEventListener('mindgraph:editor-ready', () => setEditorBadge('CodeMirror • Vim', 'vim'));
  window.addEventListener('error', (e) => {
    if (typeof e.filename === 'string' && e.filename.includes('codemirror-editor.js')) {
      setEditorBadge('Fallback textarea', 'fallback');
    }
  });
  setTimeout(() => {
    if (!editorBridge()?.isReady()) setEditorBadge('Fallback textarea', 'fallback');
  }, 1200);

  editorModal.addEventListener('mousedown', (e) => {
    state.modalPointerDownInside = !!e.target.closest('.modal-content');
  });

  modalPreview.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    state.previewSelecting = true;
    state.previewSelectionMoved = false;
  });

  window.addEventListener('mousemove', () => {
    if (state.previewSelecting) state.previewSelectionMoved = true;
  });

  window.addEventListener('mouseup', () => {
    if (state.previewSelecting) {
      if (state.previewSelectionMoved || window.getSelection()?.toString()) {
        state.suppressModalCloseUntil = Date.now() + 200;
      }
      state.previewSelecting = false;
      state.previewSelectionMoved = false;
    }
    setTimeout(() => { state.modalPointerDownInside = false; }, 0);
  });

  // Tab in textarea
  modalEditor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = modalEditor.selectionStart;
      const end = modalEditor.selectionEnd;
      modalEditor.value = modalEditor.value.substring(0, start) + '  ' + modalEditor.value.substring(end);
      modalEditor.selectionStart = modalEditor.selectionEnd = start + 2;
    }
    e.stopPropagation();
  });

  $('#closeModal').addEventListener('click', closeModalFn);
  // CodeMirror's Vim keymap consumes Escape, so intercept it during capture.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || editorModal.classList.contains('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    closeModalFn();
  }, true);
  editorModal.addEventListener('click', (e) => {
    if (
      e.target === editorModal &&
      !state.modalPointerDownInside &&
      Date.now() >= state.suppressModalCloseUntil
    ) {
      closeModalFn();
    }
  });

  // ---- Context menu ----
  function showContextMenu(x, y) {
    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.remove('hidden');
  }

  function hideContextMenu() {
    contextMenu.classList.add('hidden');
    colorPicker.classList.add('hidden');
  }

  contextMenu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (!action) return;
    hideContextMenu();

    switch (action) {
      case 'edit': {
        const id = state.selected.values().next().value;
        if (id) openModal(id);
        break;
      }
      case 'connect': {
        const id = state.selected.values().next().value;
        if (id) startConnection(id);
        break;
      }
      case 'disconnect': {
        if (state.selectedConnections.size > 0) {
          state.connections = state.connections.filter(c => !state.selectedConnections.has(c.id));
          state.selectedConnections.clear();
        } else {
          const ids = [...state.selected];
          state.connections = state.connections.filter(c =>
            !ids.includes(c.from) && !ids.includes(c.to)
          );
        }
        drawConnections();
        save();
        break;
      }
      case 'group': groupSelected(); break;
      case 'ungroup': ungroupSelected(); break;
      case 'color': {
        colorPicker.style.left = contextMenu.style.left;
        colorPicker.style.top = (parseInt(contextMenu.style.top) + 30) + 'px';
        colorPicker.classList.remove('hidden');
        break;
      }
      case 'delete': deleteSelected(); break;
    }
  });

  colorPicker.addEventListener('click', (e) => {
    const color = e.target.dataset.color;
    if (!color) return;
    for (const id of state.selected) {
      const node = state.nodes.find(n => n.id === id);
      if (node) { node.color = color; updateNodeEl(node); }
    }
    colorPicker.classList.add('hidden');
    drawConnections();
    save();
  });

  // ---- CRUD operations ----
  function addNode(x, y) {
    const node = {
      id: genId(),
      x: x || 0,
      y: y || 0,
      title: 'New Node',
      body: '',
      color: null,
      groupId: null,
    };
    state.nodes.push(node);
    createNodeEl(node);
    clearSelection();
    selectNode(node.id);
    renderGroups();
    drawConnections();
    updateCrosshairTarget();
    save();
    // Focus the title for immediate editing
    setTimeout(() => {
      const el = nodesCont.querySelector(`[data-id="${node.id}"] .node-header-text`);
      if (el) { el.focus(); selectAllText(el); }
    }, 50);
    return node;
  }

  function addField(x, y) {
    const field = { id: genId(), x: x || 0, y: y || 0, body: '' };
    state.fields.push(field);
    createFieldEl(field);
    clearSelection();
    updateCrosshairTarget();
    save();
    openFieldModal(field.id);
    return field;
  }

  function deleteNodeById(id) {
    if (state.connectFrom === id) cancelConnection();
    if (state.movingNodeId === id) state.movingNodeId = null;
    nodesCont.querySelector(`[data-id="${id}"]`)?.remove();
    state.nodes = state.nodes.filter(node => node.id !== id);
    state.connections = state.connections.filter(connection => connection.from !== id && connection.to !== id);
    for (const group of state.groups) {
      group.nodeIds = group.nodeIds.filter(nodeId => nodeId !== id);
    }
    state.groups = state.groups.filter(group => group.nodeIds.length > 0);
    state.selected.delete(id);
  }

  function deleteFieldById(id) {
    nodesCont.querySelector(`[data-field-id="${id}"]`)?.remove();
    state.fields = state.fields.filter(field => field.id !== id);
  }

  function deleteSelected() {
    // Delete selected connections
    if (state.selectedConnections.size > 0) {
      state.connections = state.connections.filter(c => !state.selectedConnections.has(c.id));
      state.selectedConnections.clear();
    }
    // Delete selected nodes
    const ids = [...state.selected];
    for (const id of ids) {
      deleteNodeById(id);
    }
    state.selected.clear();
    renderGroups();
    drawConnections();
    updateCrosshairTarget();
    save();
  }

  function deleteCrosshairItem() {
    const target = itemUnderCrosshair();
    if (!target) return;
    if (target.kind === 'node') deleteNodeById(target.item.id);
    else deleteFieldById(target.item.id);
    renderGroups();
    drawConnections();
    updateCrosshairTarget();
    save();
  }

  function releaseMovingNode() {
    if (state.movingNodeId) {
      nodesCont.querySelector(`[data-id="${state.movingNodeId}"]`)?.classList.remove('keyboard-moving');
    }
    state.movingNodeId = null;
  }

  function toggleMovingNode() {
    if (state.movingNodeId) {
      releaseMovingNode();
      showToast('Node released');
      return;
    }
    const target = itemUnderCrosshair();
    if (target?.kind !== 'node') {
      showToast('Move a node under the crosshair first');
      return;
    }
    if (state.connectMode) cancelConnection();
    state.movingNodeId = target.item.id;
    target.el.classList.add('keyboard-moving');
    showToast('Node pinned · pan with H/J/K/L · S to release');
  }

  function panBoard(dx, dy) {
    if (state.movingNodeId) {
      const node = state.nodes.find(item => item.id === state.movingNodeId);
      if (node) {
        // Counteract the viewport movement so the grabbed node stays under the crosshair.
        node.x -= dx / state.viewport.zoom;
        node.y -= dy / state.viewport.zoom;
        updateNodeEl(node);
        renderGroups();
      } else {
        releaseMovingNode();
      }
    }
    state.viewport.x += dx;
    state.viewport.y += dy;
    applyViewport();
    save();
  }

  function renderAddMenuSelection() {
    addMenu.querySelectorAll('[data-kind]').forEach((button, index) => {
      button.classList.toggle('active', index === state.addMenuIndex);
    });
  }

  function openAddMenu() {
    if (itemUnderCrosshair()) return;
    state.addMenuOpen = true;
    state.addMenuIndex = 0;
    renderAddMenuSelection();
    addMenu.classList.remove('hidden');
  }

  function closeAddMenu() {
    state.addMenuOpen = false;
    addMenu.classList.add('hidden');
  }

  function addAtCrosshair(kind) {
    const world = worldAtCrosshair();
    closeAddMenu();
    if (kind === 'field') addField(world.x - 140, world.y - 28);
    else addNode(world.x - 80, world.y - 30);
  }

  addMenu.addEventListener('click', (e) => {
    const button = e.target.closest('[data-kind]');
    if (button) addAtCrosshair(button.dataset.kind);
  });

  function groupSelected() {
    const ids = [...state.selected].filter(id => state.nodes.some(n => n.id === id));
    if (ids.length < 2) { showToast('Select at least 2 nodes to group'); return; }

    // Remove from existing groups
    for (const g of state.groups) {
      g.nodeIds = g.nodeIds.filter(nid => !ids.includes(nid));
    }
    state.groups = state.groups.filter(g => g.nodeIds.length > 0);

    const group = { id: genId(), label: 'Group', nodeIds: ids, color: null };
    state.groups.push(group);
    renderGroups();
    save();
    showToast('Nodes grouped');
  }

  function ungroupSelected() {
    const ids = [...state.selected];
    for (const g of [...state.groups]) {
      if (ids.some(id => g.nodeIds.includes(id))) {
        g.nodeIds = [];
      }
    }
    state.groups = state.groups.filter(g => g.nodeIds.length > 0);
    renderGroups();
    save();
  }

  // ---- Zoom ----
  function setZoom(newZoom, pivotX, pivotY) {
    const oldZoom = state.viewport.zoom;
    newZoom = Math.max(0.1, Math.min(3, newZoom));
    if (pivotX === undefined) {
      pivotX = canvas.clientWidth / 2;
      pivotY = canvas.clientHeight / 2;
    }
    state.viewport.x = pivotX - (pivotX - state.viewport.x) * (newZoom / oldZoom);
    state.viewport.y = pivotY - (pivotY - state.viewport.y) * (newZoom / oldZoom);
    state.viewport.zoom = newZoom;
    applyViewport();
    save();
  }

  function fitView() {
    if (state.nodes.length === 0 && state.fields.length === 0) {
      state.viewport = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, zoom: 1 };
      applyViewport();
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      const el = nodesCont.querySelector(`[data-id="${n.id}"]`);
      const w = el ? el.offsetWidth : 160;
      const h = el ? el.offsetHeight : 60;
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + w);
      maxY = Math.max(maxY, n.y + h);
    }
    for (const field of state.fields) {
      const el = nodesCont.querySelector(`[data-field-id="${field.id}"]`);
      const w = el ? el.offsetWidth : 280;
      const h = el ? el.offsetHeight : 56;
      minX = Math.min(minX, field.x);
      minY = Math.min(minY, field.y);
      maxX = Math.max(maxX, field.x + w);
      maxY = Math.max(maxY, field.y + h);
    }
    const pad = 80;
    const bw = maxX - minX + pad * 2;
    const bh = maxY - minY + pad * 2;
    const vw = canvas.clientWidth;
    const vh = canvas.clientHeight;
    const zoom = Math.min(vw / bw, vh / bh, 1.5);
    state.viewport.zoom = zoom;
    state.viewport.x = (vw - bw * zoom) / 2 - (minX - pad) * zoom;
    state.viewport.y = (vh - bh * zoom) / 2 - (minY - pad) * zoom;
    applyViewport();
    save();
  }

  // ---- Board management ----
  function loadBoards() {
    try {
      const raw = store.getItem('mindgraph_boards');
      if (raw) state.boards = JSON.parse(raw);
    } catch { state.boards = []; }
    if (state.boards.length === 0) {
      const id = genId();
      state.boards.push({ id, name: 'Untitled Board', data: null });
      state.activeBoardId = id;
    }
    state.activeBoardId = state.activeBoardId || store.getItem('mindgraph_active') || state.boards[0].id;
    loadBoard(state.activeBoardId);
  }

  let _initialized = false;
  function loadBoard(boardId) {
    // Persist the current board before changing the active-board pointer.
    if (_initialized) {
      save();
    }
    if (state.connectMode) cancelConnection();
    releaseMovingNode();
    closeAddMenu();
    _initialized = true;
    state.activeBoardId = boardId;
    store.setItem('mindgraph_active', boardId);
    const board = state.boards.find(b => b.id === boardId);
    if (!board) return;

    if (board.data) {
      state.nodes = board.data.nodes || [];
      state.fields = board.data.fields || [];
      state.connections = board.data.connections || [];
      state.groups = board.data.groups || [];
      state.viewport = board.data.viewport || { x: 0, y: 0, zoom: 1 };
    } else {
      state.nodes = [];
      state.fields = [];
      state.connections = [];
      state.groups = [];
      state.viewport = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, zoom: 1 };
    }
    state.selected.clear();
    state.selectedConnections.clear();

    // Rebuild DOM
    nodesCont.innerHTML = '';
    for (const node of state.nodes) createNodeEl(node);
    for (const field of state.fields) createFieldEl(field);
    renderGroups();
    applyViewport();
    boardNameEl.textContent = board.name;
    renderBoardList();
  }

  function saveCurrentBoard() {
    const board = state.boards.find(b => b.id === state.activeBoardId);
    if (board) {
      board.data = {
        nodes: state.nodes,
        fields: state.fields,
        connections: state.connections,
        groups: state.groups,
        viewport: state.viewport,
      };
    }
  }

  function save() {
    saveCurrentBoard();
    try {
      store.setItem('mindgraph_boards', JSON.stringify(state.boards));
    } catch { /* storage full */ }
  }

  function newBoard() {
    const id = genId();
    const name = 'Board ' + (state.boards.length + 1);
    state.boards.push({ id, name, data: null });
    save();
    loadBoard(id);
    renderBoardList();
  }

  function deleteBoard(boardId) {
    if (state.boards.length <= 1) { showToast('Cannot delete the last board'); return; }
    state.boards = state.boards.filter(b => b.id !== boardId);
    if (state.activeBoardId === boardId) {
      loadBoard(state.boards[0].id);
    }
    save();
    renderBoardList();
  }

  function renameBoard(boardId, newName) {
    const board = state.boards.find(b => b.id === boardId);
    if (board) {
      board.name = newName || 'Untitled';
      if (boardId === state.activeBoardId) boardNameEl.textContent = board.name;
      save();
      renderBoardList();
    }
  }

  function renderBoardList() {
    boardList.innerHTML = '';
    for (const board of state.boards) {
      const item = document.createElement('div');
      item.className = 'board-item' + (board.id === state.activeBoardId ? ' active' : '');
      item.innerHTML = `
        <span class="board-item-name">${esc(board.name)}</span>
        <div class="board-item-actions">
          <button class="rename-btn" title="Rename">✎</button>
          <button class="del-btn" title="Delete">×</button>
        </div>
      `;
      item.querySelector('.board-item-name').addEventListener('click', () => loadBoard(board.id));
      item.querySelector('.rename-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const name = prompt('Board name:', board.name);
        if (name !== null) renameBoard(board.id, name);
      });
      item.querySelector('.del-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm('Delete "' + board.name + '"?')) deleteBoard(board.id);
      });
      boardList.appendChild(item);
    }
  }

  // ---- Event handlers ----

  // Panning and node dragging
  canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    hideContextMenu();

    const target = e.target.closest('.node');
    const fieldTarget = e.target.closest('.field');

    if (state.connectMode && target) {
      if (state.connectFrom) finishConnection(target.dataset.id);
      else startConnection(target.dataset.id);
      return;
    }

    if (target) {
      const nodeId = target.dataset.id;
      const isInteractive =
        e.target.closest('.node-expand') ||
        e.target.closest('.node-port') ||
        e.target.closest('.node-header-text');
      if (isInteractive) return;

      if (e.shiftKey) {
        // Toggle selection
        if (state.selected.has(nodeId)) deselectNode(nodeId);
        else selectNode(nodeId);
      } else if (!state.selected.has(nodeId)) {
        clearSelection();
        selectNode(nodeId);
      }

      // Start dragging
      const node = state.nodes.find(n => n.id === nodeId);
      if (!node) return;
      state.isDragging = true;
      state.dragKind = 'nodes';
      state.dragMoved = false;
      canvas.classList.add('grabbing');
      const world = screenToWorld(e.clientX, e.clientY);
      state.dragOffset = { x: world.x - node.x, y: world.y - node.y };
      // Store initial positions for all selected
      state._dragInitial = {};
      for (const sid of state.selected) {
        const sn = state.nodes.find(n => n.id === sid);
        if (sn) state._dragInitial[sid] = { x: sn.x, y: sn.y };
      }
      state._dragStart = { x: node.x, y: node.y };
      e.preventDefault();
    } else if (fieldTarget && !state.connectMode) {
      const field = state.fields.find(item => item.id === fieldTarget.dataset.fieldId);
      if (!field) return;
      state.isDragging = true;
      state.dragKind = 'field';
      state.dragFieldId = field.id;
      state.dragMoved = false;
      canvas.classList.add('grabbing');
      const world = screenToWorld(e.clientX, e.clientY);
      state.dragOffset = { x: world.x - field.x, y: world.y - field.y };
      state._dragStart = { x: field.x, y: field.y };
      e.preventDefault();
    } else if (e.target === canvas || e.target === svg || e.target.id === 'nodesContainer') {
      // Start selection rect or pan
      if (e.shiftKey) {
        // Selection rectangle
        state.isSelecting = true;
        state.selectStart = { x: e.clientX, y: e.clientY };
        selectionRect.classList.remove('hidden');
        selectionRect.style.left = e.clientX + 'px';
        selectionRect.style.top = e.clientY + 'px';
        selectionRect.style.width = '0';
        selectionRect.style.height = '0';
      } else {
        clearSelection();
        state.isPanning = true;
        state.panStart = { x: e.clientX - state.viewport.x, y: e.clientY - state.viewport.y };
        canvas.classList.add('grabbing');
      }
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (state.isDragging) {
      const world = screenToWorld(e.clientX, e.clientY);
      const newX = world.x - state.dragOffset.x;
      const newY = world.y - state.dragOffset.y;
      if (state.dragKind === 'field') {
        const field = state.fields.find(item => item.id === state.dragFieldId);
        if (field) {
          const dx = newX - state._dragStart.x;
          const dy = newY - state._dragStart.y;
          if (!state.dragMoved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) state.dragMoved = true;
          field.x = newX;
          field.y = newY;
          const el = nodesCont.querySelector(`[data-field-id="${field.id}"]`);
          if (el) {
            el.style.left = field.x + 'px';
            el.style.top = field.y + 'px';
          }
          updateCrosshairTarget();
        }
        return;
      }
      const dx = newX - state._dragStart.x;
      const dy = newY - state._dragStart.y;
      if (!state.dragMoved && (Math.abs(dx) > 2 || Math.abs(dy) > 2)) {
        state.dragMoved = true;
      }

      for (const sid of state.selected) {
        const sn = state.nodes.find(n => n.id === sid);
        const init = state._dragInitial[sid];
        if (sn && init) {
          sn.x = init.x + dx;
          sn.y = init.y + dy;
          updateNodeEl(sn);
        }
      }
      renderGroups();
      drawConnections();
      updateCrosshairTarget();
    } else if (state.isPanning) {
      state.viewport.x = e.clientX - state.panStart.x;
      state.viewport.y = e.clientY - state.panStart.y;
      applyViewport();
    } else if (state.isSelecting) {
      const x1 = state.selectStart.x;
      const y1 = state.selectStart.y;
      const x2 = e.clientX;
      const y2 = e.clientY;
      selectionRect.style.left = Math.min(x1, x2) + 'px';
      selectionRect.style.top = Math.min(y1, y2) + 'px';
      selectionRect.style.width = Math.abs(x2 - x1) + 'px';
      selectionRect.style.height = Math.abs(y2 - y1) + 'px';
    } else if (state.connectMode) {
      // Draw temporary connection line
      const fromNode = state.nodes.find(n => n.id === state.connectFrom);
      if (!fromNode) return;
      const fromEl = nodesCont.querySelector(`[data-id="${state.connectFrom}"]`);
      if (!fromEl) return;
      const { x: vx, y: vy, zoom } = state.viewport;
      const cx = (fromNode.x + fromEl.offsetWidth / 2) * zoom + vx;
      const cy = (fromNode.y + fromEl.offsetHeight / 2) * zoom + vy;

      let tempPath = svg.querySelector('.connection-temp');
      if (!tempPath) {
        tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.classList.add('connection-temp');
        svg.appendChild(tempPath);
      }
      const pointer = clientToCanvas(e.clientX, e.clientY);
      const mx = pointer.x, my = pointer.y;
      const dx = mx - cx, dy = my - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const curve = Math.min(dist * 0.3, 80);
      tempPath.setAttribute('d',
        `M${cx},${cy} C${cx},${cy + curve} ${mx},${my - curve} ${mx},${my}`
      );

      // Highlight target
      nodesCont.querySelectorAll('.node').forEach(el => el.classList.remove('connect-target'));
      const hover = document.elementFromPoint(e.clientX, e.clientY)?.closest('.node');
      if (hover && hover.dataset.id !== state.connectFrom) {
        hover.classList.add('connect-target');
      }
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (state.isDragging) {
      state.isDragging = false;
      state.dragKind = null;
      state.dragFieldId = null;
      canvas.classList.remove('grabbing');
      if (state.dragMoved) state.suppressNodeClickUntil = Date.now() + 150;
      save();
    }
    if (state.isPanning) {
      state.isPanning = false;
      canvas.classList.remove('grabbing');
      save();
    }
    if (state.isSelecting) {
      state.isSelecting = false;
      selectionRect.classList.add('hidden');
      clearSelection();
      selectNodesInRect(
        state.selectStart.x, state.selectStart.y,
        e.clientX, e.clientY
      );
    }
  });

  // Wheel zoom
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    const newZoom = state.viewport.zoom * (1 + delta);
    const pivot = clientToCanvas(e.clientX, e.clientY);
    setZoom(newZoom, pivot.x, pivot.y);
  }, { passive: false });

  // Keyboard
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (state.modalNodeId || state.modalFieldId)) {
      e.preventDefault();
      closeModalFn();
      return;
    }

    if (state.addMenuOpen) {
      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        state.addMenuIndex = (state.addMenuIndex + 1) % 2;
        renderAddMenuSelection();
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        state.addMenuIndex = (state.addMenuIndex + 1) % 2;
        renderAddMenuSelection();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        addAtCrosshair(state.addMenuIndex === 0 ? 'node' : 'field');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeAddMenu();
      }
      return;
    }

    // Don't intercept if editing text
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
      return;
    }

    if (state.connectMode && /^\d$/.test(e.key)) {
      e.preventDefault();
      handleConnectionNumber(e.key);
      return;
    }

    const step = 40;
    switch (e.key) {
      case 'k': case 'K':
        e.preventDefault();
        panBoard(0, step);
        break;
      case 'j': case 'J':
        e.preventDefault();
        panBoard(0, -step);
        break;
      case 'h': case 'H':
        e.preventDefault();
        panBoard(step, 0);
        break;
      case 'l': case 'L':
        e.preventDefault();
        panBoard(-step, 0);
        break;
      case '+': case '=':
        setZoom(state.viewport.zoom * 1.15);
        break;
      case '-': case '_':
        setZoom(state.viewport.zoom / 1.15);
        break;
      case 'Delete': case 'Backspace':
        if (state.selected.size > 0 || state.selectedConnections.size > 0) deleteSelected();
        break;
      case 'd': case 'D':
        e.preventDefault();
        deleteCrosshairItem();
        break;
      case 's': case 'S':
        e.preventDefault();
        toggleMovingNode();
        break;
      case 'Escape':
        if (state.connectMode) cancelConnection();
        else if (!editorModal.classList.contains('hidden')) closeModalFn();
        else clearSelection();
        hideContextMenu();
        break;
      case 'c': case 'C':
        if (!e.ctrlKey && !e.metaKey) {
          const target = itemUnderCrosshair();
          if (state.connectMode) cancelConnection();
          else if (target?.kind === 'node') startConnection(target.item.id);
          else showToast('Move a node under the crosshair first');
        }
        break;
      case 'g': case 'G':
        if (!e.ctrlKey && !e.metaKey) groupSelected();
        break;
      case 'b': case 'B':
        if (!e.ctrlKey && !e.metaKey) toggleBoardPanel();
        break;
      case 'f': case 'F':
        if (!e.ctrlKey && !e.metaKey) fitView();
        break;
      case 'Enter':
        {
          const target = itemUnderCrosshair();
          if (target?.kind === 'node') openModal(target.item.id);
          else if (target?.kind === 'field') openFieldModal(target.item.id);
        }
        break;
      case 'a': case 'A':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          for (const n of state.nodes) selectNode(n.id);
        } else {
          e.preventDefault();
          openAddMenu();
        }
        break;
    }
  });

  // Double-click canvas to add node
  canvas.addEventListener('dblclick', (e) => {
    if (e.target.closest('.node, .field')) return;
    const world = screenToWorld(e.clientX, e.clientY);
    addNode(world.x - 80, world.y - 20);
  });

  // ---- Toolbar buttons ----
  $('#btnAddNode').addEventListener('click', () => {
    const rect = canvas.getBoundingClientRect();
    const center = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addNode(center.x - 80, center.y - 30);
  });

  function toggleConnectMode() {
    if (state.connectMode) {
      cancelConnection();
    } else {
      state.connectMode = true;
      state.connectFrom = null;
      canvas.classList.add('connecting');
      connectBtn.classList.add('active');
      nodesCont.querySelectorAll('.node').forEach(el => el.classList.add('connect-target'));
      showToast('Click a node to start connecting');
    }
  }

  $('#btnConnect').addEventListener('click', () => {
    if (state.selected.size === 1) {
      startConnection(state.selected.values().next().value);
    } else {
      toggleConnectMode();
    }
  });
  $('#btnGroup').addEventListener('click', groupSelected);
  $('#btnDelete').addEventListener('click', deleteSelected);
  $('#btnZoomIn').addEventListener('click', () => setZoom(state.viewport.zoom * 1.2));
  $('#btnZoomOut').addEventListener('click', () => setZoom(state.viewport.zoom / 1.2));
  $('#btnFitView').addEventListener('click', fitView);

  function toggleBoardPanel() {
    boardPanel.classList.toggle('hidden');
    renderBoardList();
  }

  $('#btnBoards').addEventListener('click', toggleBoardPanel);
  $('#closeBoardPanel').addEventListener('click', () => boardPanel.classList.add('hidden'));
  $('#btnNewBoard').addEventListener('click', newBoard);

  boardNameEl.addEventListener('click', () => {
    const board = state.boards.find(b => b.id === state.activeBoardId);
    if (!board) return;
    const name = prompt('Board name:', board.name);
    if (name !== null) renameBoard(board.id, name);
  });

  // Hide context menu on click outside
  window.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu') && !e.target.closest('.color-picker')) {
      hideContextMenu();
    }
    if (!e.target.closest('.add-menu')) closeAddMenu();
  });

  // Right-click on canvas
  canvas.addEventListener('contextmenu', (e) => {
    if (!e.target.closest('.node')) {
      e.preventDefault();
    }
  });

  // ---- Utilities ----
  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function selectAllText(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  let toastTimeout;
  function showToast(msg) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  // ---- Init ----
  loadBoards();
  if (state.nodes.length === 0 && state.fields.length === 0) {
    // Show initial welcome state
    setTimeout(() => showToast('Press A to add at the crosshair'), 500);
  }

  // Autosave every 10 seconds
  setInterval(save, 10000);

})();
