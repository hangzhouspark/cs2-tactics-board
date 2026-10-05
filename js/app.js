/* ==========================================================
   CS2 战术板 · 本地版
   纯前端实现：Canvas 逻辑坐标系 1024 x 1024
   ========================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------
   * 常量
   * ------------------------------------------------------- */
  const SVG_NS   = 'http://www.w3.org/2000/svg';
  const MIN_SCALE = 0.12;
  const MAX_SCALE = 8;
  const STORE_KEY = 'cs2-tactics-board::current';
  const STORE_LIST = 'cs2-tactics-board::saved';
  const PLACE_TOOLS = ['player', 'smoke', 'flash', 'he', 'fire', 'decoy', 'c4'];
  const UTIL_ICONS = ['smoke', 'flash', 'he', 'fire', 'c4'];
  /** 道具/炸弹图标在 1024 逻辑坐标下的可调尺寸范围 */
  const MIN_ICON_SIZE = 16;
  const MAX_ICON_SIZE = 420;
  const SCALE_STEP = 1.15;

  /* ---------------------------------------------------------
   * 状态
   * ------------------------------------------------------- */
  const state = {
    mapId: DEFAULT_MAP,
    view: { x: 0, y: 0, scale: 1 },
    tool: 'move',
    color: '#E3D085',
    width: 3,
    entities: [],
    drawings: [],
    selectedId: null,
    pending: null,        // 待放置对象（点击调色板后）
    seq: 1,
    history: [],
    hIndex: -1
  };

  const stage      = document.getElementById('stage');
  const viewport   = document.getElementById('viewport');
  const board      = document.getElementById('board');
  const boardRadar = document.getElementById('boardRadar');
  const layerDraw  = document.getElementById('layerDraw');
  const layerEntity = document.getElementById('layerEntity');
  const appEl      = document.getElementById('app');
  const contextMenu = document.getElementById('contextMenu');
  const toastEl    = document.getElementById('toast');
  const stageHint  = document.getElementById('stageHint');

  let svg = null;
  let userZoomed  = false;   // 用户是否手动调整过缩放
  let dragState   = null;    // 指针交互状态

  /* ---------------------------------------------------------
   * 工具函数
   * ------------------------------------------------------- */
  const uid = (p) => (p || 'id') + '-' + (state.seq++) + '-' + Math.random().toString(36).slice(2, 7);

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(() => toastEl.classList.add('show'));
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      toastEl.classList.remove('show');
      setTimeout(() => { toastEl.hidden = true; }, 220);
    }, 1900);
  }

  function setHint(text) {
    if (text) {
      stageHint.textContent = text;
      stageHint.hidden = false;
    } else {
      stageHint.hidden = true;
    }
  }

  function el(tag, cls, attrs) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  /* ---------------------------------------------------------
   * 视图变换
   * ------------------------------------------------------- */
  function applyView() {
    const v = state.view;
    board.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.scale})`;
    document.getElementById('hudZoom').textContent = Math.round(v.scale * 100) + '%';
  }

  function fitView(animate) {
    const rect = viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pad = 40;
    const scale = Math.min(
      (rect.width  - pad * 2) / BOARD_SIZE,
      (rect.height - pad * 2) / BOARD_SIZE
    );
    const s = clamp(scale, MIN_SCALE, MAX_SCALE);
    state.view.scale = s;
    state.view.x = (rect.width  - BOARD_SIZE * s) / 2;
    state.view.y = (rect.height - BOARD_SIZE * s) / 2;
    applyView();
  }

  function zoomAt(clientX, clientY, factor) {
    const v = state.view;
    const rect = viewport.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = clamp(v.scale * factor, MIN_SCALE, MAX_SCALE);
    const k = next / v.scale;
    v.x = px - (px - v.x) * k;
    v.y = py - (py - v.y) * k;
    v.scale = next;
    userZoomed = true;
    applyView();
  }

  function screenToBoard(clientX, clientY) {
    const rect = viewport.getBoundingClientRect();
    const v = state.view;
    return {
      x: (clientX - rect.left - v.x) / v.scale,
      y: (clientY - rect.top  - v.y) / v.scale
    };
  }

  /* ---------------------------------------------------------
   * 历史记录（撤销 / 重做）
   * ------------------------------------------------------- */
  function snapshot() {
    return {
      mapId: state.mapId,
      entities: state.entities.map(e => Object.assign({}, e)),
      drawings: state.drawings.map(d => Object.assign({}, d)),
      selectedId: state.selectedId
    };
  }

  function applySnapshot(snap) {
    if (snap.mapId !== state.mapId) {
      state.mapId = snap.mapId;
      loadMapImage(snap.mapId);
      syncMapUI();
    }
    state.entities = snap.entities.map(e => Object.assign({}, e));
    state.drawings = snap.drawings.map(d => Object.assign({}, d));
    state.selectedId = snap.selectedId || null;
    renderEntities();
    renderDrawings();
    updateHud();
  }

  function commit() {
    const snap = snapshot();
    state.history = state.history.slice(0, state.hIndex + 1);
    state.history.push(snap);
    if (state.history.length > 80) state.history.shift();
    state.hIndex = state.history.length - 1;
    updateHistoryButtons();
    persistLocal();
  }

  function undo() {
    if (state.hIndex <= 0) return;
    state.hIndex--;
    applySnapshot(state.history[state.hIndex]);
    updateHistoryButtons();
    persistLocal();
  }

  function redo() {
    if (state.hIndex >= state.history.length - 1) return;
    state.hIndex++;
    applySnapshot(state.history[state.hIndex]);
    updateHistoryButtons();
    persistLocal();
  }

  function updateHistoryButtons() {
    document.getElementById('btnUndo').disabled = state.hIndex <= 0;
    document.getElementById('btnRedo').disabled = state.hIndex >= state.history.length - 1;
  }

  /* ---------------------------------------------------------
   * 地图
   * ------------------------------------------------------- */
  function loadMapImage(mapId) {
    const map = getMap(mapId);
    board.classList.add('loading');
    boardRadar.classList.remove('failed');
    boardRadar.onload = () => board.classList.remove('loading');
    boardRadar.onerror = () => {
      board.classList.remove('loading');
      boardRadar.classList.add('failed');
      toast('雷达图加载失败：' + map.img);
    };
    boardRadar.src = map.img;
    boardRadar.alt = map.name + ' 雷达图';
  }

  function setMap(mapId, keepView) {
    if (state.mapId === mapId) return;
    state.mapId = mapId;
    loadMapImage(mapId);
    syncMapUI();
    if (!keepView) {
      userZoomed = false;
      fitView();
    }
    updateHud();
  }

  /* ---------------------------------------------------------
   * 侧栏渲染
   * ------------------------------------------------------- */
  let dragMapId = null;

  function clearDropMarks() {
    document.querySelectorAll('#mapGrid .map-item').forEach(n => {
      n.classList.remove('drop-before', 'drop-after', 'dragging');
    });
  }

  /** 按用户自定义顺序渲染地图网格（可拖动调整顺序） */
  function buildMapGrid() {
    const grid = document.getElementById('mapGrid');
    grid.innerHTML = '';
    orderedMaps().forEach(map => {
      const btn = el('button', 'map-item', {
        type: 'button',
        title: map.name + ' · ' + map.en + '（可拖动排序）',
        draggable: 'true'
      });
      btn.dataset.mapId = map.id;
      const img = el('img', null, { src: map.img, alt: map.name, loading: 'lazy' });
      const span = el('span');
      span.textContent = map.name;
      btn.append(img, span);

      btn.addEventListener('click', () => {
        if (state.mapId === map.id) return;
        state.mapId = map.id;
        loadMapImage(map.id);
        syncMapUI();
        userZoomed = false;
        fitView();
        commit();
        updateHud();
        toast('已切换到 ' + map.name);
      });

      // ---- 拖动排序 ----
      btn.addEventListener('dragstart', (ev) => {
        dragMapId = map.id;
        btn.classList.add('dragging');
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          try { ev.dataTransfer.setData('text/plain', map.id); } catch (e) { /* 忽略 */ }
        }
      });

      btn.addEventListener('dragover', (ev) => {
        if (!dragMapId || dragMapId === map.id) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        const r = btn.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        btn.classList.toggle('drop-after', after);
        btn.classList.toggle('drop-before', !after);
      });

      btn.addEventListener('dragleave', () => {
        btn.classList.remove('drop-before', 'drop-after');
      });

      btn.addEventListener('drop', (ev) => {
        ev.preventDefault();
        const r = btn.getBoundingClientRect();
        const after = ev.clientX > r.left + r.width / 2;
        const from = dragMapId;
        dragMapId = null;
        if (!from || from === map.id) { clearDropMarks(); return; }
        if (moveMap(from, map.id, after)) {
          buildMapGrid();
          syncMapUI();
          toast('地图顺序已保存');
        }
        clearDropMarks();
      });

      btn.addEventListener('dragend', () => {
        dragMapId = null;
        clearDropMarks();
      });

      grid.appendChild(btn);
    });
  }

  function syncMapUI() {
    const map = getMap(state.mapId);
    document.getElementById('mapCurrentName').textContent = map.name;
    document.querySelectorAll('#mapGrid .map-item').forEach(node => {
      node.classList.toggle('active', node.dataset.mapId === state.mapId);
    });
  }

  function buildToolGrid() {
    const grid = document.getElementById('toolGrid');
    grid.innerHTML = '';
    TOOLS.forEach(tool => {
      const btn = el('button', 'tool-item', { type: 'button', 'data-tool': tool.id, title: tool.label });
      const icon = document.createElementNS(SVG_NS, 'svg');
      icon.setAttribute('viewBox', '0 0 24 24');
      icon.innerHTML = tool.svg;
      const label = el('span');
      label.textContent = tool.label;
      btn.append(icon, label);
      btn.addEventListener('click', () => setTool(tool.id));
      grid.appendChild(btn);
    });
  }

  function setTool(toolId) {
    state.tool = toolId;
    if (toolId !== 'move') state.pending = null;
    document.querySelectorAll('#toolGrid .tool-item').forEach(n => {
      n.classList.toggle('active', n.dataset.tool === toolId);
    });
    document.querySelectorAll('.entity-item').forEach(n => n.classList.remove('active'));
    viewport.className = 'viewport' + (toolId === 'move' ? '' : ' drawing');
    updateHud();
    if (toolId !== 'move' && toolId !== 'erase') {
      const t = TOOLS.find(x => x.id === toolId);
      setHint('工具：' + (t ? t.label : toolId) + ' —— 在地图上按住并拖动');
    } else {
      setHint('');
    }
  }

  function buildColorGrid() {
    const grid = document.getElementById('colorGrid');
    grid.innerHTML = '';
    COLORS.forEach(c => {
      const btn = el('button', 'color-item', { type: 'button', title: c.label });
      btn.style.background = c.value;
      btn.dataset.color = c.value;
      btn.addEventListener('click', () => {
        state.color = c.value;
        document.querySelectorAll('#colorGrid .color-item').forEach(n => {
          n.classList.toggle('active', n.dataset.color === c.value);
        });
      });
      grid.appendChild(btn);
    });
    grid.querySelector('.color-item').classList.add('active');
  }

  function buildEntityGrids() {
    const teamGrid = document.getElementById('teamGrid');
    const utilGrid = document.getElementById('utilGrid');
    teamGrid.innerHTML = '';
    utilGrid.innerHTML = '';

    TEAM_ITEMS.forEach(item => {
      const btn = el('button', 'entity-item ' + item.team, {
        type: 'button',
        title: item.label + ' ' + item.index
      });
      const mini = el('span', 'mini-player');
      mini.textContent = item.team === 'ct' ? 'CT' : 'T';
      btn.appendChild(mini);
      bindPalette(btn, { type: 'player', team: item.team, color: item.color, index: item.index });
      teamGrid.appendChild(btn);
    });

    UTIL_ITEMS.forEach(item => {
      const btn = el('button', 'entity-item util', { type: 'button', title: item.label });
      const img = el('img', null, { src: item.icon, alt: item.label, draggable: 'false' });
      btn.appendChild(img);
      bindPalette(btn, { type: item.type });
      utilGrid.appendChild(btn);
    });
  }

  function bindPalette(btn, descriptor) {
    btn.addEventListener('click', () => {
      const isSame = state.pending && state.pending.type === descriptor.type &&
                     state.pending.index === descriptor.index &&
                     state.pending.team === descriptor.team;
      document.querySelectorAll('.entity-item').forEach(n => n.classList.remove('active'));
      if (isSame) {
        state.pending = null;
        viewport.className = 'viewport' + (state.tool === 'move' ? '' : ' drawing');
        setHint('');
        updateHud();
        return;
      }
      state.pending = descriptor;
      state.selectedId = null;
      renderEntities();
      btn.classList.add('active');
      viewport.className = 'viewport placeable';
      const label = descriptor.type === 'player'
        ? (descriptor.team === 'ct' ? 'CT' : 'T') + ' 队员 ' + descriptor.index
        : (ICON_BY_TYPE[descriptor.type] || {}).label || descriptor.type;
      setHint('点击地图放置：' + label + '（再次点击该图标可取消）');
      updateHud();
    });

    // 支持直接拖拽到地图
    btn.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/plain', JSON.stringify(descriptor));
      ev.dataTransfer.effectAllowed = 'copy';
    });
  }

  /* ---------------------------------------------------------
   * 对象创建
   * ------------------------------------------------------- */
  function createEntity(descriptor, x, y) {
    if (descriptor.type === 'player') {
      return {
        id: uid('p'),
        kind: 'player',
        team: descriptor.team,
        color: descriptor.color,
        index: descriptor.index,
        x, y,
        size: 46,
        rot: 0
      };
    }
    const icon = ICON_BY_TYPE[descriptor.type];
    return {
      id: uid('u'),
      kind: descriptor.type,
      team: null,
      color: null,
      index: null,
      x, y,
      size: icon.size,
      rot: 0
    };
  }

  function addEntityAt(descriptor, x, y) {
    const e = createEntity(descriptor, x, y);
    state.entities.push(e);
    state.selectedId = e.id;
    renderEntities();
    commit();
    updateHud();
    return e;
  }

  /* ---------------------------------------------------------
   * 渲染：战术对象
   * ------------------------------------------------------- */
  function renderEntities() {
    layerEntity.innerHTML = '';
    state.entities.forEach(e => layerEntity.appendChild(buildEntityNode(e)));
  }

  function buildEntityNode(e) {
    const node = el('div', 'entity ' + (e.kind === 'player' ? 'player' : 'util'));
    node.dataset.id = e.id;
    node.style.left = (e.x - e.size / 2) + 'px';
    node.style.top  = (e.y - e.size / 2) + 'px';
    node.style.width  = e.size + 'px';
    node.style.height = e.size + 'px';

    if (e.kind === 'player') {
      node.classList.add(e.team);
      node.style.color = e.color;
      node.style.setProperty('--tok', e.size + 'px');
      const token = el('div', 'token');
      token.textContent = playerLabel(e);
      node.appendChild(token);
    } else {
      // 道具/炸弹整体旋转（旋转的是图标本身）
      node.style.transform = 'rotate(' + (e.rot || 0) + 'deg)';
      const icon = ICON_BY_TYPE[e.kind];
      node.style.color = '#FFFFFF';
      const img = el('img', null, { src: icon.icon, alt: icon.label, draggable: 'false' });
      // 道具/炸弹：选中后可拖动右下角把手自由缩放
      const handle = el('div', 'resize-handle', { title: '拖动调整大小' });
      handle.dataset.resizeFor = e.id;
      node.append(img, handle);
    }

    if (state.selectedId === e.id) node.classList.add('selected');
    return node;
  }

  /** 队员标记中间的队伍文字：蓝色圈为 CT，黄色圈为 T */
  function playerLabel(e) {
    return (e.team === 'ct' || e.color === '#8AACDF') ? 'CT' : 'T';
  }

  /** 只更新单个对象节点的位置与尺寸（拖动/缩放时避免整层重渲染） */
  function updateEntityNode(e) {
    const node = layerEntity.querySelector(`.entity[data-id="${e.id}"]`);
    if (!node) return;
    node.style.left = (e.x - e.size / 2) + 'px';
    node.style.top  = (e.y - e.size / 2) + 'px';
    node.style.width  = e.size + 'px';
    node.style.height = e.size + 'px';
    node.style.setProperty('--tok', e.size + 'px');
  }

  /* ---------------------------------------------------------
   * 渲染：绘图
   * ------------------------------------------------------- */
  function ensureSvg() {
    if (svg) return svg;
    layerDraw.innerHTML = '';
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + BOARD_SIZE + ' ' + BOARD_SIZE);
    svg.setAttribute('preserveAspectRatio', 'none');
    layerDraw.appendChild(svg);
    return svg;
  }

  function renderDrawings(live) {
    const root = ensureSvg();
    root.innerHTML = '';
    state.drawings.forEach(d => root.appendChild(buildDrawNode(d)));
    if (live) root.appendChild(buildDrawNode(live, true));
  }

  function buildDrawNode(d, isLive) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'draw-node' + (isLive ? ' dim' : ''));
    g.dataset.id = d.id;
    const common = {
      stroke: d.color,
      'stroke-width': d.width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      fill: 'none'
    };

    let node;
    if (d.tool === 'pen') {
      node = document.createElementNS(SVG_NS, 'path');
      node.setAttribute('d', d.d || '');
      apply(node, common);
      // 箭头笔迹（可选）——暂不使用
    } else if (d.tool === 'line') {
      node = document.createElementNS(SVG_NS, 'line');
      node.setAttribute('x1', d.x1); node.setAttribute('y1', d.y1);
      node.setAttribute('x2', d.x2); node.setAttribute('y2', d.y2);
      apply(node, common);
    } else if (d.tool === 'arrow') {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', d.x1); line.setAttribute('y1', d.y1);
      line.setAttribute('x2', d.x2); line.setAttribute('y2', d.y2);
      apply(line, common);
      const head = document.createElementNS(SVG_NS, 'path');
      head.setAttribute('d', arrowHead(d.x1, d.y1, d.x2, d.y2, d.width));
      apply(head, Object.assign({}, common, { fill: d.color }));
      g.append(line, head);
      return g;
    } else if (d.tool === 'rect') {
      node = document.createElementNS(SVG_NS, 'rect');
      const x = Math.min(d.x1, d.x2), y = Math.min(d.y1, d.y2);
      node.setAttribute('x', x);
      node.setAttribute('y', y);
      node.setAttribute('width', Math.abs(d.x2 - d.x1));
      node.setAttribute('height', Math.abs(d.y2 - d.y1));
      apply(node, common);
    } else if (d.tool === 'circle') {
      node = document.createElementNS(SVG_NS, 'ellipse');
      const cx = (d.x1 + d.x2) / 2, cy = (d.y1 + d.y2) / 2;
      node.setAttribute('cx', cx);
      node.setAttribute('cy', cy);
      node.setAttribute('rx', Math.abs(d.x2 - d.x1) / 2);
      node.setAttribute('ry', Math.abs(d.y2 - d.y1) / 2);
      apply(node, common);
    } else if (d.tool === 'text') {
      node = document.createElementNS(SVG_NS, 'text');
      node.setAttribute('x', d.x1);
      node.setAttribute('y', d.y1);
      node.setAttribute('fill', d.color);
      node.setAttribute('font-size', Math.max(14, d.width * 7));
      node.setAttribute('font-family', 'Manrope, PingFang SC, Microsoft YaHei, sans-serif');
      node.setAttribute('font-weight', '700');
      node.setAttribute('paint-order', 'stroke');
      node.setAttribute('stroke', 'rgba(0,0,0,.55)');
      node.setAttribute('stroke-width', Math.max(2, d.width * 1.4));
      node.setAttribute('stroke-linejoin', 'round');
      node.textContent = d.text || '';
      g.appendChild(node);
      return g;
    }
    if (node) g.appendChild(node);
    return g;
  }

  function apply(node, attrs) {
    for (const k in attrs) node.setAttribute(k, attrs[k]);
  }

  function arrowHead(x1, y1, x2, y2, w) {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const len = clamp(w * 3.4, 12, 40);
    const spread = Math.PI / 7;
    const p1x = x2 - len * Math.cos(ang - spread);
    const p1y = y2 - len * Math.sin(ang - spread);
    const p2x = x2 - len * Math.cos(ang + spread);
    const p2y = y2 - len * Math.sin(ang + spread);
    return `M${x2},${y2} L${p1x},${p1y} L${p2x},${p2y} Z`;
  }

  /* ---------------------------------------------------------
   * HUD
   * ------------------------------------------------------- */
  function updateHud() {
    const tool = TOOLS.find(t => t.id === state.tool);
    let mode = tool ? tool.label : state.tool;
    if (state.pending) mode = '放置中…';
    document.getElementById('hudMode').textContent = '工具：' + mode;
    document.getElementById('hudCount').textContent =
      '对象：' + state.entities.length + ' ｜ 笔迹：' + state.drawings.length;
    document.getElementById('widthValue').textContent = state.width + ' px';
  }

  /* ---------------------------------------------------------
   * 指针交互
   * ------------------------------------------------------- */
  function onPointerDown(ev) {
    hideContextMenu();

    // 中键 → 平移；move 工具在空白处也平移（不使用键盘）
    const hitEntity = ev.target.closest('.entity');
    const isPan = ev.button === 1 ||
                  (ev.button === 0 && state.tool === 'move' && !hitEntity);
    if (window.__CS2_DEBUG__) {
      window.__CS2_DEBUG__.lastPanDecision = {
        button: ev.button, tool: state.tool,
        pending: !!state.pending, hit: hitEntity ? hitEntity.dataset.id : null,
        isPan: isPan, target: ev.target.tagName + '.' + (ev.target.className || '')
      };
    }
    if (isPan && !state.pending && state.tool === 'move') {
      ev.preventDefault();
      viewport.classList.add('panning');
      dragState = {
        mode: 'pan',
        startX: ev.clientX,
        startY: ev.clientY,
        origin: { x: state.view.x, y: state.view.y },
        pointerId: ev.pointerId,
        moved: false,
        fromMoveTool: ev.button === 0 && state.tool === 'move'
      };
      try { viewport.setPointerCapture(ev.pointerId); } catch (err) { /* noop */ }
      return;
    }

    if (ev.button !== 0) return;

    const target = ev.target.closest('.entity');
    const pt = screenToBoard(ev.clientX, ev.clientY);

    // 放置待放置对象
    if (state.pending) {
      ev.preventDefault();
      addEntityAt(state.pending, pt.x, pt.y);
      setHint('');
      viewport.className = 'viewport' + (state.tool === 'move' ? '' : ' drawing');
      state.pending = null;
      document.querySelectorAll('.entity-item').forEach(n => n.classList.remove('active'));
      return;
    }

    // 橡皮擦
    if (state.tool === 'erase') {
      if (target) {
        deleteEntity(target.dataset.id);
      } else {
        eraseDrawingAt(pt);
      }
      return;
    }

    // 拖动缩放把手：自由改变道具/炸弹图标大小
    const handle = ev.target.closest('.resize-handle');
    if (handle) {
      const entity = state.entities.find(e => e.id === handle.dataset.resizeFor);
      if (!entity) return;
      ev.preventDefault();
      const center = screenToBoard(ev.clientX, ev.clientY);
      dragState = {
        mode: 'resize',
        id: entity.id,
        startSize: entity.size,
        startDist: Math.max(6, Math.hypot(center.x - entity.x, center.y - entity.y)),
        pointerId: ev.pointerId
      };
      handle.parentNode.classList.add('resizing');
      try { viewport.setPointerCapture(ev.pointerId); } catch (err) { /* noop */ }
      return;
    }

    // 移动已有对象
    if (target) {
      const id = target.dataset.id;
      const entity = state.entities.find(e => e.id === id);
      if (!entity) return;
      ev.preventDefault();
      state.selectedId = id;
      renderEntities();
      dragState = {
        mode: 'entity',
        id,
        startX: ev.clientX,
        startY: ev.clientY,
        origin: { x: entity.x, y: entity.y },
        moved: false,
        pointerId: ev.pointerId
      };
      try { viewport.setPointerCapture(ev.pointerId); } catch (err) { /* noop */ }
      updateHud();
      return;
    }

    // 文字工具
    if (state.tool === 'text') {
      const text = window.prompt('输入战术标注文字：', '');
      if (text && text.trim()) {
        state.drawings.push({
          id: uid('d'),
          tool: 'text',
          x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
          color: state.color,
          width: state.width,
          text: text.trim().slice(0, 60)
        });
        renderDrawings();
        commit();
        updateHud();
      }
      return;
    }

    // 绘图工具
    if (['pen', 'line', 'arrow', 'rect', 'circle'].includes(state.tool)) {
      ev.preventDefault();
      state.selectedId = null;
      renderEntities();
      const draft = {
        id: uid('d'),
        tool: state.tool,
        x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y,
        color: state.color,
        width: state.width,
        d: state.tool === 'pen' ? `M${pt.x.toFixed(1)},${pt.y.toFixed(1)}` : ''
      };
      dragState = { mode: 'draw', draft, pointerId: ev.pointerId };
      try { viewport.setPointerCapture(ev.pointerId); } catch (err) { /* noop */ }
      renderDrawings(draft);
      return;
    }

    // 空白处点击：取消选中
    state.selectedId = null;
    renderEntities();
  }

  function onPointerMove(ev) {
    if (!dragState) return;

    if (dragState.mode === 'pan') {
      const dx = ev.clientX - dragState.startX;
      const dy = ev.clientY - dragState.startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
      state.view.x = dragState.origin.x + dx;
      state.view.y = dragState.origin.y + dy;
      applyView();
      return;
    }

    if (dragState.mode === 'entity') {
      const entity = state.entities.find(e => e.id === dragState.id);
      if (!entity) return;
      const dx = (ev.clientX - dragState.startX) / state.view.scale;
      const dy = (ev.clientY - dragState.startY) / state.view.scale;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragState.moved = true;
      entity.x = dragState.origin.x + dx;
      entity.y = dragState.origin.y + dy;
      updateEntityNode(entity);
      return;
    }

    if (dragState.mode === 'resize') {
      const entity = state.entities.find(e => e.id === dragState.id);
      if (!entity) return;
      const pt = screenToBoard(ev.clientX, ev.clientY);
      const dist = Math.max(4, Math.hypot(pt.x - entity.x, pt.y - entity.y));
      const next = dragState.startSize * (dist / dragState.startDist);
      entity.size = clamp(next, MIN_ICON_SIZE, MAX_ICON_SIZE);
      dragState.moved = true;
      updateEntityNode(entity);
      return;
    }

    if (dragState.mode === 'draw') {
      const pt = screenToBoard(ev.clientX, ev.clientY);
      const d = dragState.draft;
      d.x2 = pt.x;
      d.y2 = pt.y;
      if (d.tool === 'pen') {
        if (!dragState.lastPt ||
            Math.hypot(pt.x - dragState.lastPt.x, pt.y - dragState.lastPt.y) > 2.5) {
          d.d += ` L${pt.x.toFixed(1)},${pt.y.toFixed(1)}`;
          dragState.lastPt = pt;
        }
      }
      renderDrawings(d);
      return;
    }
  }

  function onPointerUp(ev) {
    if (!dragState) return;
    const ds = dragState;
    dragState = null;
    viewport.classList.remove('panning');
    document.querySelectorAll('.entity.resizing').forEach(n => n.classList.remove('resizing'));
    try { viewport.releasePointerCapture(ds.pointerId); } catch (e) { /* noop */ }

    if (ds.mode === 'entity') {
      if (ds.moved) commit();
      return;
    }

    if (ds.mode === 'resize') {
      if (ds.moved) {
        commit();
        const entity = state.entities.find(e => e.id === ds.id);
        if (entity) {
          const icon = ICON_BY_TYPE[entity.kind];
          toast((icon ? icon.label : '图标') + ' 大小：' + Math.round(entity.size));
        }
      }
      return;
    }

    if (ds.mode === 'pan') {
      // 用「移动」工具在空白处轻点 → 取消选中
      if (!ds.moved && ds.fromMoveTool && state.selectedId) {
        state.selectedId = null;
        renderEntities();
      }
      return;
    }

    if (ds.mode === 'draw') {
      const d = ds.draft;
      const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
      const isDot = d.tool === 'pen' && (d.d || '').length < 12;
      if (d.tool === 'pen') {
        if (len > 2 || (d.d || '').split('L').length > 2) {
          state.drawings.push(d);
          commit();
        } else if (isDot) {
          // 单击点一个圆点
          d.d += ` L${(d.x1 + 0.6).toFixed(1)},${d.y1.toFixed(1)}`;
          state.drawings.push(d);
          commit();
        }
      } else if (len > 4) {
        state.drawings.push(d);
        commit();
      }
      renderDrawings();
      updateHud();
    }
  }

  function deleteEntity(id) {
    const i = state.entities.findIndex(e => e.id === id);
    if (i < 0) return;
    state.entities.splice(i, 1);
    if (state.selectedId === id) state.selectedId = null;
    renderEntities();
    commit();
    updateHud();
  }

  function eraseDrawingAt(pt) {
    // 从后往前找命中，用 SVG 元素的命中测试
    const nodes = Array.from(svg ? svg.querySelectorAll('.draw-node') : []);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      const stroke = node.querySelector('path, line, rect, ellipse, text');
      if (!stroke) continue;
      // 扩大命中范围
      try {
        if (stroke.isPointInStroke && stroke.isPointInStroke(pt.x, pt.y)) {
          removeDrawing(node.dataset.id);
          return;
        }
      } catch (e) { /* noop */ }
      const bb = stroke.getBBox ? stroke.getBBox() : null;
      if (bb) {
        const pad = 12;
        if (pt.x >= bb.x - pad && pt.x <= bb.x + bb.width + pad &&
            pt.y >= bb.y - pad && pt.y <= bb.y + bb.height + pad) {
          removeDrawing(node.dataset.id);
          return;
        }
      }
    }
  }

  function removeDrawing(id) {
    const i = state.drawings.findIndex(d => d.id === id);
    if (i < 0) return;
    state.drawings.splice(i, 1);
    renderDrawings();
    commit();
    updateHud();
  }

  /* ---------------------------------------------------------
   * 右键菜单
   * ------------------------------------------------------- */
  function showContextMenu(ev, entityId) {
    state.selectedId = entityId;
    renderEntities();
    const entity = state.entities.find(e => e.id === entityId);
    const isUtil = !!entity && entity.kind !== 'player';
    // 旋转与放大/缩小只对道具与炸弹有意义（队员是没有方向的圆标）
    contextMenu.querySelectorAll('.util-only').forEach(n => { n.hidden = !isUtil; });
    contextMenu.hidden = false;
    const rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = Math.min(ev.clientX, window.innerWidth - rect.width - 8) + 'px';
    contextMenu.style.top  = Math.min(ev.clientY, window.innerHeight - rect.height - 8) + 'px';
  }

  function hideContextMenu() { contextMenu.hidden = true; }

  contextMenu.addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    if (!act) return;
    const id = state.selectedId;
    const entity = state.entities.find(e => e.id === id);
    hideContextMenu();
    if (!entity) return;

    if (act === 'rotate-cw')  entity.rot = (entity.rot || 0) + 15;
    if (act === 'rotate-ccw') entity.rot = (entity.rot || 0) - 15;
    if (act === 'scale-up' && entity.kind !== 'player') {
      entity.size = clamp(entity.size * SCALE_STEP, MIN_ICON_SIZE, MAX_ICON_SIZE);
    }
    if (act === 'scale-down' && entity.kind !== 'player') {
      entity.size = clamp(entity.size / SCALE_STEP, MIN_ICON_SIZE, MAX_ICON_SIZE);
    }
    if (act === 'duplicate') {
      const copy = Object.assign({}, entity, { id: uid(entity.kind === 'player' ? 'p' : 'u'), x: entity.x + 40, y: entity.y + 40 });
      state.entities.push(copy);
      state.selectedId = copy.id;
    }
    if (act === 'bring-front') {
      state.entities = state.entities.filter(e => e.id !== id).concat([entity]);
    }
    if (act === 'delete') {
      deleteEntity(id);
      return;
    }
    renderEntities();
    commit();
  });

  viewport.addEventListener('contextmenu', (ev) => {
    const target = ev.target.closest('.entity');
    if (!target) { hideContextMenu(); return; }
    ev.preventDefault();
    showContextMenu(ev, target.dataset.id);
  });

  /* ---------------------------------------------------------
   * 拖拽放置
   * ------------------------------------------------------- */
  viewport.addEventListener('dragover', (ev) => {
    if (ev.dataTransfer.types.includes('text/plain')) {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }
  });

  viewport.addEventListener('drop', (ev) => {
    ev.preventDefault();
    let descriptor = null;
    try { descriptor = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch (e) { /* noop */ }
    if (!descriptor || !descriptor.type) return;
    const pt = screenToBoard(ev.clientX, ev.clientY);
    addEntityAt(descriptor, pt.x, pt.y);
    state.pending = null;
    document.querySelectorAll('.entity-item').forEach(n => n.classList.remove('active'));
    setHint('');
  });

  /* ---------------------------------------------------------
   * 缩放（仅鼠标操作：滚轮缩放、中键/移动工具拖动平移）
   * 说明：本项目不提供键盘快捷键，所有操作都在界面上完成。
   * ------------------------------------------------------- */
  viewport.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoomAt(ev.clientX, ev.clientY, factor);
  }, { passive: false });

  /* ---------------------------------------------------------
   * 顶栏动作
   * ------------------------------------------------------- */
  function bindTopbar() {
    document.getElementById('btnUndo').addEventListener('click', undo);
    document.getElementById('btnRedo').addEventListener('click', redo);

    document.getElementById('btnClearAll').addEventListener('click', () => {
      if (!state.entities.length && !state.drawings.length) return;
      if (!window.confirm('确定要清空当前地图上的全部对象与笔迹吗？')) return;
      state.entities = [];
      state.drawings = [];
      state.selectedId = null;
      renderEntities();
      renderDrawings();
      commit();
      updateHud();
      toast('已清空');
    });

    document.getElementById('btnCollapse').addEventListener('click', () => {
      appEl.classList.toggle('collapsed');
      setTimeout(() => { if (!userZoomed) fitView(); }, 220);
    });

    document.getElementById('btnZoomIn').addEventListener('click', () => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
    });
    document.getElementById('btnZoomOut').addEventListener('click', () => {
      const r = viewport.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
    });
    document.getElementById('btnZoomReset').addEventListener('click', () => {
      userZoomed = false;
      fitView();
    });

    const helpModal = document.getElementById('helpModal');
    document.getElementById('btnHelp').addEventListener('click', () => { helpModal.hidden = false; });
    document.getElementById('btnHelpClose').addEventListener('click', () => { helpModal.hidden = true; });
    helpModal.addEventListener('click', (ev) => { if (ev.target === helpModal) helpModal.hidden = true; });

    document.getElementById('btnExportPng').addEventListener('click', exportPng);
    document.getElementById('btnExportJson').addEventListener('click', exportJson);
    document.getElementById('btnSaveLocal').addEventListener('click', saveAs);
    document.getElementById('btnImport').addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });
    document.getElementById('fileInput').addEventListener('change', importFile);

    document.getElementById('widthRange').addEventListener('input', (ev) => {
      state.width = Number(ev.target.value);
      updateHud();
    });
  }

  function nextAutoName() {
    const list = loadSavedList();
    return '战术 ' + (list.length + 1);
  }

  /* ---------------------------------------------------------
   * 本地存储
   * ------------------------------------------------------- */
  function persistLocal() {
    try {
      const snap = snapshot();
      snap.view = { x: state.view.x, y: state.view.y, scale: state.view.scale };
      snap.tool = state.tool;
      snap.color = state.color;
      snap.width = state.width;
      snap.name = nextAutoName();
      localStorage.setItem(STORE_KEY, JSON.stringify(snap));
    } catch (e) { /* 存储不可用时静默忽略 */ }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const snap = JSON.parse(raw);
      state.mapId = snap.mapId || DEFAULT_MAP;
      state.entities = snap.entities || [];
      state.drawings = snap.drawings || [];
      state.tool = snap.tool || 'move';
      state.color = snap.color || '#E3D085';
      state.width = snap.width || 3;
      loadMapImage(state.mapId);
      if (snap.view) {
        state.view = snap.view;
        userZoomed = true;
      }
      return true;
    } catch (e) { return false; }
  }

  function loadSavedList() {
    try { return JSON.parse(localStorage.getItem(STORE_LIST) || '[]'); }
    catch (e) { return []; }
  }

  function writeSavedList(list) {
    try { localStorage.setItem(STORE_LIST, JSON.stringify(list)); } catch (e) { /* noop */ }
  }

  function saveAs() {
    const name = window.prompt('保存当前战术，输入名称：', nextAutoName());
    if (name === null) return;
    const trimmed = name.trim() || nextAutoName();
    const snap = snapshot();
    snap.name = trimmed;
    snap.savedAt = Date.now();
    const list = loadSavedList();
    const dup = list.findIndex(s => s.name === trimmed);
    if (dup >= 0) list[dup] = snap; else list.push(snap);
    writeSavedList(list);
    persistLocal();
    toast('已保存：' + trimmed);
  }

  /* ---------------------------------------------------------
   * 导出存放位置
   * 有本地服务时，导出文件由服务端直接写进项目文件夹：
   *   导出图片\  ← PNG    导出战术\  ← JSON
   * 没有服务时（file:// 直接打开）退回浏览器默认下载目录。
   * ------------------------------------------------------- */
  const EXPORT_DIRS = {
    image: '导出图片',
    tactic: '导出战术'
  };

  function exportFileName(ext) {
    return 'cs2-tactics-' + state.mapId + '-' + stamp() + '.' + ext;
  }

  function updateSaveBadge(text, ok) {
    const badge = document.getElementById('saveBadge');
    if (!badge) return;
    badge.textContent = text;
    badge.classList.toggle('ok', !!ok);
    badge.classList.toggle('warn', !ok);
  }

  /**
   * 保存导出内容：优先写进项目文件夹，失败则退回浏览器下载
   * @param {Blob} blob
   * @param {string} kind  'image' | 'tactic'
   * @param {string} name  文件名
   * @returns {Promise<{where:'project'|'download', path?:string}>}
   */
  async function saveExport(blob, kind, name) {
    try {
      const online = await buildHttpMesh();
      if (online) {
        const buf = await blob.arrayBuffer();
        const res = await fetch('http://127.0.0.1:' + meshPort + '/__save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dir: kind,
            name: name,
            data: bytesToBase64(new Uint8Array(buf))
          })
        });
        const info = await res.json();
        if (res.ok && info && info.ok) {
          updateSaveBadge('已连接 · 写入项目文件夹', true);
          return { where: 'project', path: info.path };
        }
        throw new Error((info && info.error) || ('HTTP ' + res.status));
      }
    } catch (e) {
      console.warn('写入项目文件夹失败，改用浏览器下载：', e);
    }
    updateSaveBadge('未连接 · 存到下载目录', false);
    download(blob, name);
    return { where: 'download' };
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  /* ---------------------------------------------------------
   * 导入 / 导出
   * ------------------------------------------------------- */
  async function exportJson() {
    const snap = snapshot();
    snap.name = nextAutoName();
    snap.exportedAt = new Date().toISOString();
    snap.app = 'cs2-tactics-board';
    const name = exportFileName('json');
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const res = await saveExport(blob, 'tactic', name);
    if (res.where === 'project') {
      toast('战术已保存到 ' + res.path);
    } else {
      toast('战术已导出到浏览器下载目录（启动 serve.cmd 可直接存进项目文件夹）');
    }
  }

  function importFile(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const snap = JSON.parse(reader.result);
        applySnapshot(Object.assign({ selectedId: null }, snap));
        if (snap.view) { state.view = snap.view; userZoomed = true; applyView(); }
        state.history = [];
        state.hIndex = -1;
        commit();
        toast('导入成功' + (snap.name ? '：' + snap.name : ''));
      } catch (e) {
        toast('导入失败：文件格式不正确');
      }
    };
    reader.readAsText(file);
  }

  function download(content, filename, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
           p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  /* ---------------------------------------------------------
   * PNG 导出：把战术板重绘到 Canvas
   * ------------------------------------------------------- */
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('无法加载图片：' + src));
      img.src = src;
    });
  }

  /* ---------------------------------------------------------
   * 本地 HTTP 中转（解决 file:// 下 canvas 被污染、无法导出 PNG 的问题）
   * 页面被直接双击打开时，浏览器会以 file:// 加载本地图片，
   * 这类图片画进 canvas 后属于“跨源污染”，toBlob 会抛异常。
   * 这里在页面内临时起一个 127.0.0.1 的静态服务，改为经 HTTP 取图，
   * 图片变成同源可控的 blob，canvas 即可正常导出。
   * ------------------------------------------------------- */
  const MESH_PORTS = [8123, 8124, 8125, 8126, 8127, 8128, 8129, 8130, 8131, 8132];
  let meshReady = null;
  let meshPort = 0;
  const blobCache = new Map();

  function pingServer(port) {
    return new Promise((resolve) => {
      if (typeof window.fetch !== 'function') { resolve(false); return; }
      let done = false;
      const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
      setTimeout(() => finish(false), 900);
      fetch('http://127.0.0.1:' + port + '/index.html', { method: 'HEAD', cache: 'no-store' })
        .then(r => finish(r.ok))
        .catch(() => finish(false));
    });
  }

  function buildHttpMesh() {
    if (meshReady) return meshReady;
    meshReady = (async () => {
      // 页面已经跑在 http 下时无需中转
      if (location.protocol !== 'file:') {
        meshPort = Number(location.port) || 80;
        return true;
      }
      const results = await Promise.all(MESH_PORTS.map(async (p) => ((await pingServer(p)) ? p : 0)));
      const hit = results.find(p => p > 0);
      if (hit) {
        meshPort = hit;
        return true;
      }
      return false;
    })();
    return meshReady;
  }

  /** 经本地 HTTP 服务取图并转成 blob URL，避免 canvas 污染 */
  async function loadImageViaHttp(relPath) {
    const key = relPath.replace(/^\.\//, '');
    if (blobCache.has(key)) return loadImage(blobCache.get(key));
    const res = await fetch('http://127.0.0.1:' + meshPort + '/' + key);
    if (!res.ok) throw new Error('HTTP ' + res.status + '：' + key);
    const url = URL.createObjectURL(await res.blob());
    blobCache.set(key, url);
    return loadImage(url);
  }

  /** 按需取图：优先走 HTTP 中转，失败则回退直接加载 */
  async function loadImageSafe(relPath, preferHttp) {
    if (preferHttp) {
      try { return await loadImageViaHttp(relPath); }
      catch (e) { /* 回退到直连 */ }
    }
    return loadImage(relPath);
  }

  async function exportPng() {
    const btn = document.getElementById('btnExportPng');
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '导出中…';
    try {
      const map = getMap(state.mapId);
      const out = 1600;
      const canvas = document.createElement('canvas');
      canvas.width = out;
      canvas.height = out;
      const ctx = canvas.getContext('2d');
      const k = out / BOARD_SIZE;

      ctx.fillStyle = '#0F1216';
      ctx.fillRect(0, 0, out, out);

      // 优先走本地 HTTP 中转（serve.cmd），避免 file:// 下 canvas 被污染
      const useHttp = await buildHttpMesh();
      const radar = await loadImageSafe(map.img, useHttp);
      ctx.drawImage(radar, 0, 0, out, out);

      // 笔迹
      state.drawings.forEach(d => drawToCanvas(ctx, d, k));

      // 对象
      for (const e of state.entities) {
        if (e.kind === 'player') {
          drawPlayerToken(ctx, e, k);
        } else {
          const icon = ICON_BY_TYPE[e.kind];
          try {
            const img = await loadImageSafe(icon.icon, useHttp);
            const size = e.size * k;
            ctx.save();
            ctx.translate(e.x * k, e.y * k);
            ctx.rotate((e.rot || 0) * Math.PI / 180);
            ctx.drawImage(img, -size / 2, -size / 2, size, size);
            ctx.restore();
          } catch (err) { /* 跳过加载失败的图标 */ }
        }
      }

      // 水印
      ctx.font = '600 26px Manrope, PingFang SC, Microsoft YaHei, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.55)';
      ctx.textAlign = 'right';
      ctx.fillText(map.name + ' · CS2 战术板', out - 28, out - 26);

      const blob = await new Promise((resolve, reject) => {
        try { canvas.toBlob(resolve, 'image/png'); }
        catch (e) { reject(e); }
      });
      if (!blob) throw new Error('canvas 导出为空');
      const res = await saveExport(blob, 'image', exportFileName('png'));
      if (res.where === 'project') {
        toast('图片已保存到 ' + res.path);
      } else {
        toast('图片已导出到浏览器下载目录（启动 serve.cmd 可直接存进项目文件夹）');
      }
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/taint|SecurityError|污染/i.test(msg)) {
        toast('导出被浏览器安全策略拦截：请改用 serve.cmd 启动本地服务后打开页面');
      } else {
        toast('导出失败：' + msg);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  function drawToCanvas(ctx, d, k) {
    ctx.save();
    ctx.strokeStyle = d.color;
    ctx.fillStyle = d.color;
    ctx.lineWidth = d.width * k;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (d.tool === 'pen') {
      const seg = String(d.d || '').trim().split(/\s*L\s*/);
      if (seg.length < 2) { ctx.restore(); return; }
      ctx.beginPath();
      seg.forEach((s, i) => {
        const [x, y] = s.replace(/^M/, '').split(',').map(Number);
        if (i === 0) ctx.moveTo(x * k, y * k);
        else ctx.lineTo(x * k, y * k);
      });
      ctx.stroke();
    } else if (d.tool === 'line' || d.tool === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(d.x1 * k, d.y1 * k);
      ctx.lineTo(d.x2 * k, d.y2 * k);
      ctx.stroke();
      if (d.tool === 'arrow') {
        const ang = Math.atan2(d.y2 - d.y1, d.x2 - d.x1);
        const len = clamp(d.width * 3.4, 12, 40);
        const spread = Math.PI / 7;
        ctx.beginPath();
        ctx.moveTo(d.x2 * k, d.y2 * k);
        ctx.lineTo((d.x2 - len * Math.cos(ang - spread)) * k, (d.y2 - len * Math.sin(ang - spread)) * k);
        ctx.lineTo((d.x2 - len * Math.cos(ang + spread)) * k, (d.y2 - len * Math.sin(ang + spread)) * k);
        ctx.closePath();
        ctx.fill();
      }
    } else if (d.tool === 'rect') {
      ctx.strokeRect(Math.min(d.x1, d.x2) * k, Math.min(d.y1, d.y2) * k,
                     Math.abs(d.x2 - d.x1) * k, Math.abs(d.y2 - d.y1) * k);
    } else if (d.tool === 'circle') {
      ctx.beginPath();
      ctx.ellipse((d.x1 + d.x2) / 2 * k, (d.y1 + d.y2) / 2 * k,
                  Math.abs(d.x2 - d.x1) / 2 * k, Math.abs(d.y2 - d.y1) / 2 * k, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (d.tool === 'text') {
      const size = Math.max(14, d.width * 7) * k;
      ctx.font = '700 ' + size + 'px Manrope, PingFang SC, Microsoft YaHei, sans-serif';
      ctx.lineWidth = Math.max(2, d.width * 1.4) * k;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.textBaseline = 'alphabetic';
      ctx.strokeText(d.text || '', d.x1 * k, d.y1 * k);
      ctx.fillStyle = d.color;
      ctx.fillText(d.text || '', d.x1 * k, d.y1 * k);
    }
    ctx.restore();
  }

  /** 绘制队员标记：CT 蓝底、T 黄底，圈内深色队伍文字，无朝向箭头 */
  function drawPlayerToken(ctx, e, k) {
    const r = (e.size / 2) * k;
    const cx = e.x * k;
    const cy = e.y * k;

    ctx.save();

    // 圆形本体：队伍色填充 + 深色描边（与页面 CSS 一致）
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = e.color;
    ctx.fill();
    ctx.lineWidth = Math.max(2, 3 * k);
    ctx.strokeStyle = '#1B2027';
    ctx.stroke();

    // 队伍文字：深色，保证在蓝/黄底上清晰
    ctx.fillStyle = '#14171B';
    ctx.font = '800 ' + (e.size * 0.38 * k) + 'px Manrope, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(playerLabel(e), cx, cy + 1 * k);

    ctx.restore();
  }

  /* ---------------------------------------------------------
   * 初始化
   * ------------------------------------------------------- */
  function init() {
    ensureSvg();
    buildMapGrid();
    buildToolGrid();
    buildColorGrid();
    buildEntityGrids();
    bindTopbar();

    const hadLocal = loadLocal();
    if (!hadLocal) loadMapImage(state.mapId);
    syncMapUI();
    setTool(state.tool || 'move');
    document.getElementById('colorGrid').querySelectorAll('.color-item').forEach(n => {
      n.classList.toggle('active', n.dataset.color === state.color);
    });
    document.getElementById('widthRange').value = state.width;

    renderEntities();
    renderDrawings();
    updateHud();

    // 初始视图
    fitView();
    if (!hadLocal) {
      state.history = [];
      state.hIndex = -1;
      commit();
    } else {
      state.history = [snapshot()];
      state.hIndex = 0;
      updateHistoryButtons();
    }

    // 探测本地服务，用于显示导出位置
    buildHttpMesh().then((ok) => {
      updateSaveBadge(ok ? '已连接 · 写入项目文件夹' : '未连接 · 存到下载目录', ok);
    });

    setHint('选择左侧工具开始布置战术');
    setTimeout(() => setHint(''), 4200);

    // 事件
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    window.addEventListener('pointerdown', (ev) => {
      if (!contextMenu.hidden && !contextMenu.contains(ev.target)) hideContextMenu();
    });
    document.addEventListener('click', (ev) => {
      if (!contextMenu.hidden && !contextMenu.contains(ev.target)) hideContextMenu();
    });

    // 视口尺寸变化
    if (window.ResizeObserver) {
      new ResizeObserver(() => { if (!userZoomed) fitView(); }).observe(viewport);
    } else {
      window.addEventListener('resize', () => { if (!userZoomed) fitView(); });
    }

    window.addEventListener('beforeunload', persistLocal);
    setInterval(persistLocal, 20000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 便于调试
  window.__CS2_BOARD__ = state;
  window.__CS2_DEBUG__ = {
    dragMode: () => (dragState ? dragState.mode : 'none'),
    drag: () => dragState,
    state: () => state,
    history: () => ({ index: state.hIndex, length: state.history.length }),
    render: () => { renderEntities(); renderDrawings(); },
    hud: () => updateHud(),
    mapOrder: () => getMapOrder().slice(),
    resetMapOrder: () => { resetMapOrder(); buildMapGrid(); syncMapUI(); }
  };
})();
