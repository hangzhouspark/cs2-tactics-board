/**
 * test/run.js —— 用 Chrome DevTools Protocol 驱动本地战术板做功能自测
 * 用法: node test/run.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REF = path.join(ROOT, '_ref');
fs.mkdirSync(REF, { recursive: true });
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const HARNESS_HEAD = `<meta charset="UTF-8">
<script>
window.__TEST__ = { logs: [], blobs: [] };
(function () {
  // 测试隔离：屏蔽 localStorage，保证每次运行都从空状态开始，
  // 避免上一轮遗留的自动存档污染计数基线。
  var mem = {};
  try {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); window.__TEST__.logs.push('setItem:' + k); },
        removeItem: function (k) { delete mem[k]; },
        clear: function () { mem = {}; },
        key: function (i) { return Object.keys(mem)[i] || null; },
        get length() { return Object.keys(mem).length; }
      }
    });
  } catch (e) { window.__TEST__.logs.push('localStorage stub failed: ' + e.message); }

  const realCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    try {
      const rec = { size: blob.size, type: blob.type, head: null, valid: false };
      window.__TEST__.blobs.push(rec);
      blob.slice(0, 8).arrayBuffer().then(function (buf) {
        const b = new Uint8Array(buf);
        rec.head = Array.from(b).join(',');
        rec.valid = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
      }).catch(function () {});
    } catch (e) {}
    return realCreate(blob);
  };
  const realClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) { window.__TEST__.logs.push('download:' + this.download); return; }
    return realClick.apply(this, arguments);
  };
  window.confirm = function () { return true; };
  window.prompt = function (_m, d) { return d || '测试战术'; };
  window.addEventListener('error', function (e) {
    window.__TEST__.logs.push('ERROR: ' + (e.message || e.type));
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__TEST__.logs.push('REJECT: ' + (e.reason && e.reason.message ? e.reason.message : e.reason));
  });
})();
</script>`;

/**
 * 拼出自测页：<head> 直接复用 index.html 的 <title> / favicon / 样式表，
 * 这样关于标题与图标的断言测的是真实页面，而不是自测页自己的模板。
 */
function buildHarness(indexHtml) {
  const head = indexHtml.split('<head>')[1].split('</head>')[0];
  const body = indexHtml.split('<body>')[1].split('</body>')[0];
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' + head +
         HARNESS_HEAD + '\n</head>\n<body>\n' + body + '\n</body>\n</html>';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 本地服务是否在线（决定 PNG 导出是否可校验） */
async function serverOnline() {
  for (const port of [8123, 8124, 8125]) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/index.html', { method: 'HEAD' });
      if (r.ok) return port;
    } catch (e) { /* 该端口没服务 */ }
  }
  return 0;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve(data); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async attach(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new Cdp(ws);
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        cdp.events.push(msg);
      }
    };
    return cdp;
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    }
    return r.result.value;
  }
}

(async function main() {
  // 1. 生成测试页（<head> 复用 index.html，确保标题/图标断言测的是真实页面）
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const harness = buildHarness(html);
  const harnessPath = path.join(ROOT, '_harness.html');
  fs.writeFileSync(harnessPath, harness, 'utf8');
  console.log('[1] 测试页已生成:', harnessPath);

  // 2. 记录导出目录的现有文件（自测只校验本次新增的文件，不动用户的产物）
  const dirImg = path.join(ROOT, '导出图片');
  const dirTac = path.join(ROOT, '导出战术');
  const beforeFiles = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    return fs.readdirSync(dir);
  };
  const imgBefore = beforeFiles(dirImg);
  const tacBefore = beforeFiles(dirTac);
  console.log('[2] 导出目录已有文件: 图片 ' + imgBefore.length + ' 个，战术 ' + tacBefore.length + ' 个');

  // 3. 启动 Chrome
  // 注意：不要写死调试端口。某些安全软件（例如卡巴斯基 avp.exe）会占用常见端口，
  // 这里用 --remote-debugging-port=0 让 Chrome 自己挑空闲端口，
  // 再从 <user-data-dir>/DevToolsActivePort 读出真实端口。
  const profile = path.join(REF, 'prof-test');
  fs.mkdirSync(profile, { recursive: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  fs.rmSync(portFile, { force: true });

  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=0',
    '--window-size=1600,950',
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  let debugPort = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const raw = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (raw && Number(raw) > 0) { debugPort = Number(raw); break; }
    } catch (e) { /* 还没写出来 */ }
  }
  if (!debugPort) { chrome.kill(); throw new Error('Chrome 未写出调试端口（DevToolsActivePort 缺失）'); }
  console.log('[2] Chrome 调试端口: ' + debugPort);

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      const list = await getJson('http://127.0.0.1:' + debugPort + '/json/list');
      target = (Array.isArray(list) ? list : []).find(t => t.type === 'page');
      if (target && target.webSocketDebuggerUrl) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!target) { chrome.kill(); throw new Error('无法连接 Chrome 调试端口 ' + debugPort); }
  console.log('[3] 已连接 Chrome');

  const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  await cdp.send('Page.navigate', { url: 'file:///' + harnessPath.replace(/\\/g, '/') });
  await sleep(2800);

  // 首屏检查
  const boot = await cdp.eval(`(function(){
    var s = window.__CS2_BOARD__;
    return {
      ready: !!s,
      radar: !!document.getElementById('boardRadar').src,
      maps: document.querySelectorAll('#mapGrid .map-item').length,
      tools: document.querySelectorAll('#toolGrid .tool-item').length,
      colors: document.querySelectorAll('#colorGrid .color-item').length,
      team: document.querySelectorAll('#teamGrid .entity-item').length,
      util: document.querySelectorAll('#utilGrid .entity-item').length,
      utilIcons: Array.prototype.map.call(document.querySelectorAll('#utilGrid img'), function(i){ return i.naturalWidth; }),
      title: document.title,
      favicon: (function () {
        const l = document.querySelector('link[rel="icon"]');
        return l ? l.getAttribute('href') : '';
      })(),
      brandSrc: (function () {
        const i = document.querySelector('.topbar .brand-mark');
        return i && i.tagName === 'IMG' ? i.getAttribute('src') : '';
      })(),
      brandLoaded: (function () {
        const i = document.querySelector('.topbar .brand-mark');
        return i && i.tagName === 'IMG' ? i.naturalWidth : 0;
      })(),
      hasLocalTag: document.querySelector('.topbar').textContent.indexOf('本地版') >= 0,
      scale: s ? Math.round(s.view.scale*1000)/1000 : null,
      errors: window.__TEST__.logs
    };
  })()`);
  console.log('[3] 首屏:', JSON.stringify(boot));

  // 3. 模拟交互
  const interact = await cdp.eval(`(async function(){
    const T = window.__TEST__;
    const s = window.__CS2_BOARD__;
    const vp = document.getElementById('viewport');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rect = vp.getBoundingClientRect();

    function pe(type, x, y, opts){
      const ev = new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1
      }, opts || {}));
      vp.dispatchEvent(ev);
    }
    function clickAt(x, y){
      hitAt('pointerdown', x, y);
      hitAt('pointerup', x, y);
    }
    /** 在坐标命中的真实元素上派发指针事件，模拟浏览器行为（保证 ev.target 正确） */
    function hitAt(type, x, y){
      const target = document.elementFromPoint(x, y) || vp;
      const ev = new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1
      });
      target.dispatchEvent(ev);
    }
    function buttonByText(sel, text){
      return Array.prototype.find.call(document.querySelectorAll(sel), n => n.textContent.trim() === text);
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const out = {};
    const baseDrawings = s.drawings.length;
    const baseEntities = s.entities.length;
    out.base = baseDrawings + '/' + baseEntities;

    // --- 画笔 ---
    buttonByText('#toolGrid .tool-item', '画笔').click();
    out.toolAfterPen = s.tool;
    pe('pointerdown', cx - 120, cy - 60);
    for (let i = 1; i <= 24; i++) pe('pointermove', cx - 120 + i * 8, cy - 60 + Math.sin(i / 3) * 22);
    pe('pointerup', cx - 120 + 192, cy - 60);
    out.drawingsAfterPen = s.drawings.length;

    // --- 箭头 ---
    buttonByText('#toolGrid .tool-item', '箭头').click();
    pe('pointerdown', cx - 140, cy + 90);
    pe('pointermove', cx + 60, cy + 150);
    pe('pointerup', cx + 60, cy + 150);
    out.drawingsAfterArrow = s.drawings.length;
    out.arrowIsArrow = s.drawings[s.drawings.length - 1].tool;

    // --- 矩形 ---
    buttonByText('#toolGrid .tool-item', '矩形').click();
    pe('pointerdown', cx + 90, cy - 120);
    pe('pointermove', cx + 200, cy - 40);
    pe('pointerup', cx + 200, cy - 40);
    out.drawingsAfterRect = s.drawings.length;

    // --- 文字 ---
    buttonByText('#toolGrid .tool-item', '文字').click();
    clickAt(cx - 60, cy + 200);
    out.drawingsAfterText = s.drawings.length;
    out.textContent = s.drawings[s.drawings.length - 1].text;

    // --- 放置队员 ---
    out.paletteLabels = Array.prototype.map.call(
      document.querySelectorAll('#teamGrid .mini-player'), n => n.textContent).join(',');
    document.querySelectorAll('#teamGrid .entity-item')[5].click();   // T 队员 1
    out.pendingType = s.pending && s.pending.type;
    clickAt(cx - 80, cy - 20);
    out.entitiesAfterPlayer1 = s.entities.length;
    out.lastKind = s.entities[s.entities.length - 1].kind;
    out.playerTeam = s.entities[s.entities.length - 1].team;
    out.playerIndex = s.entities[s.entities.length - 1].index;
    out.tokenTextT = (document.querySelector(
      '.entity[data-id="' + s.entities[s.entities.length - 1].id + '"] .token') || {}).textContent;

    // --- 再放一个 CT ---
    document.querySelectorAll('#teamGrid .entity-item')[2].click();   // CT 队员 3
    clickAt(cx + 40, cy + 60);
    out.entitiesAfterPlayer2 = s.entities.length;
    out.tokenTextCT = (document.querySelector(
      '.entity[data-id="' + s.entities[s.entities.length - 1].id + '"] .token') || {}).textContent;
    // 队员标记的底色应为队伍色（CT 蓝 #8AACDF / T 黄 #E3D085），文字深色
    const ctToken = document.querySelector('.entity.player.ct .token');
    const tToken = document.querySelector('.entity.player.t .token');
    out.ctTokenBg = ctToken ? getComputedStyle(ctToken).backgroundColor : '';
    out.tTokenBg = tToken ? getComputedStyle(tToken).backgroundColor : '';
    out.ctTokenFg = ctToken ? getComputedStyle(ctToken).color : '';
    out.paletteCtBg = (function () {
      const n = document.querySelector('#teamGrid .entity-item.ct .mini-player');
      return n ? getComputedStyle(n).backgroundColor : '';
    })();

    // --- 放烟雾弹 ---
    document.querySelectorAll('#utilGrid .entity-item')[0].click();
    clickAt(cx + 140, cy + 20);
    out.entitiesAfterSmoke = s.entities.length;
    out.utilKind = s.entities[s.entities.length - 1].kind;

    // --- 拖动烟雾弹 ---
    const smoke = s.entities[s.entities.length - 1];
    const smokeScreen = { x: cx + 140, y: cy + 20 };
    const before = { x: smoke.x, y: smoke.y };
    document.querySelectorAll('#toolGrid .tool-item')[0].click(); // 移动
    const node = document.querySelector('.entity[data-id="' + smoke.id + '"]');
    const nr = node.getBoundingClientRect();
    out.dragNode = node ? (node.className + ' ' + Math.round(nr.width) + 'x' + Math.round(nr.height)) : 'no-node';
    out.elementAtPoint = (function(){
      const el = document.elementFromPoint(nr.left + nr.width / 2, nr.top + nr.height / 2);
      return el ? (el.tagName + '.' + (el.className || '') + ' closest=' + !!el.closest('.entity')) : 'null';
    })();
    out.toolBeforeDrag = s.tool;
    out.pendingBeforeDrag = !!s.pending;
    hitAt('pointerdown', nr.left + nr.width / 2, nr.top + nr.height / 2);
    out.panDecision = window.__CS2_DEBUG__ ? window.__CS2_DEBUG__.lastPanDecision : 'n/a';
    out.dragStateAfterDown = window.__CS2_DEBUG__ ? window.__CS2_DEBUG__.dragMode() : 'n/a';
    hitAt('pointermove', nr.left + nr.width / 2 + 60, nr.top + nr.height / 2 + 30);
    hitAt('pointerup', nr.left + nr.width / 2 + 60, nr.top + nr.height / 2 + 30);
    out.dragMoved = Math.round(smoke.x - before.x) + ',' + Math.round(smoke.y - before.y);

    // --- 撤销 / 重做（用拖动前后对象坐标判定，比数量更可靠） ---
    const H = window.__CS2_DEBUG__.history;
    const smokeId = smoke.id;
    const posOf = () => {
      const e2 = s.entities.find(x => x.id === smokeId);
      return e2 ? { x: e2.x, y: e2.y } : null;
    };
    const idxBefore = H().index;
    const dragSnapshot = posOf();
    document.getElementById('btnUndo').click();
    const idxAfterUndo = H().index;
    const posAfterUndo = posOf();
    document.getElementById('btnRedo').click();
    const idxAfterRedo = H().index;
    const posAfterRedo = posOf();
    out.undoIndex = idxBefore + '→' + idxAfterUndo + '→' + idxAfterRedo;
    out.undoRevertedPos = !!posAfterUndo &&
      (Math.abs(posAfterUndo.x - dragSnapshot.x) > 1 || Math.abs(posAfterUndo.y - dragSnapshot.y) > 1);
    out.redoRestoredPos = !!posAfterRedo &&
      Math.abs(posAfterRedo.x - dragSnapshot.x) < 0.01 && Math.abs(posAfterRedo.y - dragSnapshot.y) < 0.01;
    out.undoWorked = out.undoRevertedPos && out.redoRestoredPos &&
                     idxAfterUndo === idxBefore - 1 && idxAfterRedo === idxBefore;

    // --- 橡皮擦 ---
    buttonByText('#toolGrid .tool-item', '橡皮').click();
    const drawBefore = s.drawings.length;
    const firstStroke = smokeScreen; // 用已有笔迹坐标附近的命中测试
    if (s.drawings.length) {
      const d = s.drawings[0];
      const bbPoint = d.tool === 'pen' ? d.d.split('L')[0].replace('M', '').split(',') : [d.x1, d.y1];
      const bx = rect.left + s.view.x + Number(bbPoint[0]) * s.view.scale;
      const by = rect.top + s.view.y + Number(bbPoint[1]) * s.view.scale;
      clickAt(bx, by);
    }
    out.drawingsAfterErase = s.drawings.length;
    out.eraseWorked = s.drawings.length < drawBefore;

    // --- 地图拖动排序 ---
    const gridOf = () => Array.prototype.map.call(
      document.querySelectorAll('#mapGrid .map-item'), n => n.dataset.mapId);
    const orderBefore = gridOf();
    const items = document.querySelectorAll('#mapGrid .map-item');
    const src = items[0];
    const dst = items[3];
    const sr = src.getBoundingClientRect();
    const dr = dst.getBoundingClientRect();
    const dt = new DataTransfer();
    function fireDrag(type, node, x, y) {
      node.dispatchEvent(new DragEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, dataTransfer: dt
      }));
    }
    fireDrag('dragstart', src, sr.left + 4, sr.top + 4);
    fireDrag('dragover', dst, dr.right - 4, dr.top + 4);   // 落在右半边 → 插到后面
    fireDrag('drop', dst, dr.right - 4, dr.top + 4);
    fireDrag('dragend', src, sr.left + 4, sr.top + 4);
    await sleep(120);
    const orderAfter = gridOf();
    out.mapOrderBefore = orderBefore.join(',');
    out.mapOrderAfter = orderAfter.join(',');
    out.mapOrderChanged = orderBefore.join(',') !== orderAfter.join(',');
    // 期望：原来的第 1 张被移到第 4 张之后
    const expectOrder = orderBefore.slice();
    const moved = expectOrder.shift();
    expectOrder.splice(3, 0, moved);
    out.mapOrderExpected = expectOrder.join(',');
    out.mapOrderCorrect = orderAfter.join(',') === expectOrder.join(',');
    out.mapOrderPersisted = JSON.stringify(window.__CS2_DEBUG__.mapOrder()) === JSON.stringify(orderAfter);
    // 还原顺序，避免影响后续断言
    window.__CS2_DEBUG__.resetMapOrder();
    await sleep(80);
    out.mapOrderRestored = gridOf().join(',') === orderBefore.join(',');

    // --- 切换地图 ---
    document.querySelectorAll('#mapGrid .map-item')[6].click();  // 阿努比斯
    await sleep(400);
    out.mapAfterSwitch = s.mapId;
    out.radarLoaded = document.getElementById('boardRadar').complete &&
                      document.getElementById('boardRadar').naturalWidth > 0;
    out.radarSrc = document.getElementById('boardRadar').getAttribute('src');

    // --- 缩放 ---
    const scaleBefore = s.view.scale;
    document.getElementById('btnZoomIn').click();
    out.zoomInWorked = s.view.scale > scaleBefore;

    // --- 队员标记不应有朝向箭头，只保留圆圈 + 队伍文字 ---
    out.playerHasFacing = !!document.querySelector('.entity.player .facing');
    out.playerNodeCount = document.querySelectorAll('.entity.player').length;
    const firstToken = document.querySelector('.entity.player .token');
    out.playerChildCount = firstToken && firstToken.parentNode
      ? firstToken.parentNode.childElementCount : -1;

    // --- 缩放道具图标（拖动右下角把手）---
    document.querySelectorAll('#toolGrid .tool-item')[0].click(); // 移动工具
    const util = s.entities.find(e2 => e2.kind !== 'player');
    const utilId = util.id;
    const sizeBefore = util.size;
    // 先在空白处点一下取消选中
    clickAt(rect.left + s.view.x + 40 * s.view.scale, rect.top + s.view.y + 40 * s.view.scale);
    await sleep(60);
    out.deselectWorked = !s.selectedId;
    const unselectedHandle = document.querySelector('.entity[data-id="' + utilId + '"] .resize-handle');
    out.handleExists = !!unselectedHandle;
    out.handleHiddenWhenUnselected = !unselectedHandle ||
      getComputedStyle(unselectedHandle).display === 'none';
    clickAt(rect.left + s.view.x + util.x * s.view.scale,
            rect.top + s.view.y + util.y * s.view.scale);   // 选中
    await sleep(60);
    const handle = document.querySelector('.entity[data-id="' + utilId + '"] .resize-handle');
    out.handleVisibleWhenSelected = !!handle && getComputedStyle(handle).display !== 'none';
    if (handle) {
      const hr = handle.getBoundingClientRect();
      const hx = hr.left + hr.width / 2;
      const hy = hr.top + hr.height / 2;
      const cxb = rect.left + s.view.x + util.x * s.view.scale;
      const cyb = rect.top + s.view.y + util.y * s.view.scale;
      // 沿「中心 → 把手」方向继续往外拖，尺寸应放大
      const k = 1.9;
      hitAt('pointerdown', hx, hy);
      out.resizeDragMode = window.__CS2_DEBUG__.dragMode();
      hitAt('pointermove', cxb + (hx - cxb) * k, cyb + (hy - cyb) * k);
      hitAt('pointerup', cxb + (hx - cxb) * k, cyb + (hy - cyb) * k);
      out.sizeBefore = sizeBefore;
      out.sizeAfter = util.size;
      out.resizeGrew = util.size > sizeBefore;
      // 按比例还原数值应接近 1.9 倍
      out.resizeRatio = Math.round((util.size / sizeBefore) * 100) / 100;
      // 缩回原大小：右键菜单「缩小图标」
      document.getElementById('btnUndo').click();
      out.sizeAfterUndo = s.entities.find(e2 => e2.id === utilId).size;
      out.resizeUndoWorked = Math.abs(out.sizeAfterUndo - sizeBefore) < 0.51;
    }
    // 右键菜单缩放（对道具可用、对队员隐藏）
    const menuItems = () => Array.prototype.map.call(
      document.querySelectorAll('#contextMenu button'), n => n.dataset.act + (n.hidden ? ':hidden' : ''));
    const utilNode = document.querySelector('.entity[data-id="' + utilId + '"]');
    utilNode.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy
    }));
    out.menuForUtil = menuItems().join(',');
    document.getElementById('contextMenu').hidden = true;
    const playerEnt = s.entities.find(e2 => e2.kind === 'player');
    if (playerEnt) {
      document.querySelector('.entity[data-id="' + playerEnt.id + '"]').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      out.menuForPlayer = menuItems().join(',');
      document.getElementById('contextMenu').hidden = true;
    }
    // 键盘快捷键应已彻底移除
    out.keyboardHandlersGone = (function () {
      let fired = false;
      const before = JSON.stringify({ tool: s.tool, entities: s.entities.length, drawings: s.drawings.length });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      const after = JSON.stringify({ tool: s.tool, entities: s.entities.length, drawings: s.drawings.length });
      fired = before !== after;
      return !fired;
    })();

    // --- 导出 PNG ---
    window.__TEST__.blobs.length = 0;
    try {
      const btn = document.getElementById('btnExportPng');
      const toastEl = document.getElementById('toast');
      btn.click();
      let seen = null;
      for (let i = 0; i < 80; i++) {
        await sleep(150);
        const b0 = window.__TEST__.blobs[0];
        if (b0 && b0.valid) break;
        if (b0 && b0.size > 0 && b0.head) break;
        if (!toastEl.hidden && toastEl.textContent) seen = toastEl.textContent;
        if (!btn.disabled && i > 3 && seen) break;
      }
      out.toastText = seen || (toastEl.hidden ? '' : toastEl.textContent);
      out.exportBlobs = window.__TEST__.blobs.length;
      out.btnLabel = btn.textContent;
    } catch (e) {
      out.exportError = String(e && e.message || e);
    }
    out.blobsDetail = window.__TEST__.blobs.slice();
    out.saveBadge = (document.getElementById('saveBadge') || {}).textContent;
    out.liveEntities = window.__CS2_BOARD__.entities.length;
    out.liveDrawings = window.__CS2_BOARD__.drawings.length;
    // 触发一次「导出战术」，用于校验 JSON 是否写进项目文件夹
    out.tacticName = null;
    try {
      window.__TEST__.logs.length = 0;
      document.getElementById('btnExportJson').click();
      for (let i = 0; i < 60; i++) {
        await sleep(120);
        const dl = window.__TEST__.logs.find(l => /^download:.*\.json$/.test(l));
        if (dl) { out.tacticName = dl.replace('download:', ''); break; }
        if (!/导出中/.test(document.getElementById('btnExportJson').textContent)) { /* 忽略 */ }
      }
      out.tacticToast = document.getElementById('toast').textContent;
    } catch (e) {
      out.tacticError = String(e && e.message || e);
    }
    out.nDrawPen = out.drawingsAfterPen - baseDrawings;
    out.nDrawArrow = out.drawingsAfterArrow - baseDrawings;
    out.nDrawRect = out.drawingsAfterRect - baseDrawings;
    out.nDrawText = out.drawingsAfterText - baseDrawings;
    out.nEntPlayer1 = out.entitiesAfterPlayer1 - baseEntities;
    out.nEntPlayer2 = out.entitiesAfterPlayer2 - baseEntities;
    out.nEntSmoke = out.entitiesAfterSmoke - baseEntities;
    out.logs = window.__TEST__.logs.slice();
    out.entityCount = s.entities.length;
    out.drawingCount = s.drawings.length;
    return out;
  })()`);

  console.log('[4] 交互结果:');
  for (const k of Object.keys(interact)) {
    const v = interact[k];
    console.log('    ' + k + ' = ' + (typeof v === 'object' ? JSON.stringify(v) : v));
  }

  // 4. 断言
  const svcPort = await serverOnline();
  console.log('[4a] 本地服务端口: ' + (svcPort || '未启动（仅校验导出提示）'));
  const fails = [];
  const expect = (cond, msg) => { if (!cond) fails.push(msg); };
  expect(boot.ready, '状态未初始化');
  expect(boot.maps === 10, `地图数量应为 10（已删除意大利小镇），实际 ${boot.maps}`);
  expect(boot.tools === 8, `工具数量应为 8，实际 ${boot.tools}`);
  expect(boot.colors === 8, `颜色数量应为 8，实际 ${boot.colors}`);
  expect(boot.team === 10, `队员图标应为 10，实际 ${boot.team}`);
  expect(boot.util === 5, `道具图标应为 5（已删除诱饵弹），实际 ${boot.util}`);
  expect(boot.utilIcons.every(w => w > 0), '有道具图标未加载: ' + JSON.stringify(boot.utilIcons));
  expect(boot.title === 'CS2 战术板', '页面标题应为「CS2 战术板」，实际「' + boot.title + '」');
  expect(boot.hasLocalTag === false, '顶栏不应再有「本地版」字样');
  expect(boot.favicon === 'assets/icons/cs2.png',
         'favicon 应指向官方 CS2 图标，实际 ' + boot.favicon);
  expect(boot.brandSrc === 'assets/icons/cs2.png',
         '顶栏图标应使用官方 CS2 图标，实际 ' + boot.brandSrc);
  expect(boot.brandLoaded === 512, '顶栏图标未按 512px 加载，naturalWidth=' + boot.brandLoaded);
  expect(interact.nDrawPen === 1, '画笔未生成笔迹');
  expect(interact.nDrawArrow === 2 && interact.arrowIsArrow === 'arrow', '箭头未生成');
  expect(interact.nDrawRect === 3, '矩形未生成');
  expect(interact.nDrawText === 4, '文字未生成');
  expect(interact.textContent === '测试战术', '文字内容不正确: ' + interact.textContent);
  expect(interact.nEntPlayer1 === 1, '队员未放置');
  expect(interact.lastKind === 'player' && interact.playerTeam === 't' && interact.playerIndex === 1, '队员属性不正确');
  expect(interact.tokenTextT === 'T', '黄色队员圈中间应显示 T，实际 ' + interact.tokenTextT);
  expect(interact.tokenTextCT === 'CT', '蓝色队员圈中间应显示 CT，实际 ' + interact.tokenTextCT);
  expect(interact.paletteLabels === 'CT,CT,CT,CT,CT,T,T,T,T,T',
         '队员面板图标文字不正确: ' + interact.paletteLabels);
  expect(interact.ctTokenBg === 'rgb(138, 172, 223)',
         'CT 标记底色应为蓝色 rgb(138, 172, 223)，实际 ' + interact.ctTokenBg);
  expect(interact.tTokenBg === 'rgb(227, 208, 133)',
         'T 标记底色应为黄色 rgb(227, 208, 133)，实际 ' + interact.tTokenBg);
  expect(interact.paletteCtBg === 'rgb(138, 172, 223)',
         '队员面板里的 CT 图标底色应为蓝色，实际 ' + interact.paletteCtBg);
  expect(/rgb\(20, 23, 27\)/.test(interact.ctTokenFg || ''),
         '队员标记文字应为深色，实际 ' + interact.ctTokenFg);
  expect(interact.nEntPlayer2 === 2, '第二个队员未放置');
  expect(interact.nEntSmoke === 3 && interact.utilKind === 'smoke', '烟雾弹未放置');
  expect(interact.dragMoved !== '0,0', '拖动未生效: ' + interact.dragMoved);
  expect(interact.undoWorked, '撤销/重做异常');
  expect(interact.eraseWorked, '橡皮擦未删除笔迹');
  expect(interact.handleExists, '道具缺少缩放把手');
  expect(interact.handleHiddenWhenUnselected, '未选中时缩放把手不应显示');
  expect(interact.deselectWorked, '空白处点击未能取消选中');
  expect(interact.handleVisibleWhenSelected, '选中后缩放把手未显示');
  expect(interact.resizeDragMode === 'resize', '按下把手未进入缩放状态: ' + interact.resizeDragMode);
  expect(interact.resizeGrew, '拖动把手未放大图标: ' + interact.sizeBefore + ' → ' + interact.sizeAfter);
  expect(interact.resizeRatio > 1.7 && interact.resizeRatio < 2.1,
         '缩放比例不符合预期（应约 1.9）: ' + interact.resizeRatio);
  expect(interact.resizeUndoWorked, '撤销后图标大小未还原: ' + interact.sizeAfterUndo);
  expect(!interact.playerHasFacing, '队员标记不应再有朝向箭头（.facing）');
  expect(interact.playerNodeCount >= 2, '队员标记数量异常: ' + interact.playerNodeCount);
  expect(interact.playerChildCount === 1,
         '队员标记应只包含圆圈与文字两层，实际子元素数 ' + interact.playerChildCount);
  expect(/rotate-cw:hidden/.test(interact.menuForPlayer || '') &&
         /rotate-ccw:hidden/.test(interact.menuForPlayer || ''),
         '队员的右键菜单不应显示旋转: ' + interact.menuForPlayer);
  expect(/scale-up:hidden/.test(interact.menuForPlayer || '') &&
         /scale-down:hidden/.test(interact.menuForPlayer || ''),
         '队员的右键菜单不应显示放大/缩小: ' + interact.menuForPlayer);
  expect(!/:hidden/.test(interact.menuForUtil || ''),
         '道具的右键菜单应显示放大/缩小: ' + interact.menuForUtil);
  expect(/scale-up/.test(interact.menuForUtil || '') && /scale-down/.test(interact.menuForUtil || ''),
         '道具的右键菜单缺少放大/缩小项: ' + interact.menuForUtil);
  expect(interact.keyboardHandlersGone, '仍存在键盘快捷键响应');
  expect(interact.mapOrderChanged, '地图拖动后顺序未变化');
  expect(interact.mapOrderCorrect,
         '地图拖动结果不正确: 实际 ' + interact.mapOrderAfter + ' 期望 ' + interact.mapOrderExpected);
  expect(interact.mapOrderPersisted, '地图顺序未写入本地存储');
  expect(interact.mapOrderRestored, '恢复默认地图顺序失败');
  expect(interact.mapAfterSwitch === 'de_anubis', '切换地图失败: ' + interact.mapAfterSwitch);
  expect(interact.radarLoaded, '切换后雷达图未加载');
  expect(interact.zoomInWorked, '放大未生效');
  const blobs = interact.blobsDetail || [];
  const biggest = blobs.slice().sort((a, b) => b.size - a.size)[0];
  if (svcPort) {
    expect(blobs.length >= 1, '导出未产生任何文件');
    expect(!!biggest && biggest.size > 100000, '导出的 PNG 体积异常: ' + JSON.stringify(biggest));
    expect(!!biggest && biggest.head && biggest.head.indexOf('137,80,78,71') === 0,
           '导出的不是合法 PNG: ' + JSON.stringify(biggest));
    // 导出应直接写进项目文件夹，而不是走浏览器下载
    expect(!interact.tacticName, '有服务时战术文件不应走浏览器下载: ' + interact.tacticName);
    expect(/保存到/.test(interact.tacticToast || ''),
           '战术导出提示未指出项目路径: ' + interact.tacticToast);
    expect(/已连接/.test(interact.saveBadge || ''), '导出位置状态未显示已连接: ' + interact.saveBadge);
    // 校验服务端确实落盘（只看本次新增的文件）
    const imgs = fs.readdirSync(dirImg).filter(f => !imgBefore.includes(f) && f.endsWith('.png'));
    const tacs = fs.readdirSync(dirTac).filter(f => !tacBefore.includes(f) && f.endsWith('.json'));
    expect(imgs.length === 1, '导出图片\\ 本次应新增 1 个 PNG，实际 ' + JSON.stringify(imgs));
    expect(tacs.length === 1, '导出战术\\ 本次应新增 1 个 JSON，实际 ' + JSON.stringify(tacs));
    if (tacs.length) {
      const parsed = JSON.parse(fs.readFileSync(path.join(dirTac, tacs[0]), 'utf8'));
      const live = interact.liveEntities;
      expect(parsed.mapId === 'de_anubis', '导出的战术文件地图不对: ' + parsed.mapId);
      expect(Array.isArray(parsed.entities) && parsed.entities.length === live,
             '导出的战术文件对象数不对: ' + JSON.stringify(parsed.entities && parsed.entities.length) +
             ' 期望 ' + live);
      expect(Array.isArray(parsed.drawings) && parsed.drawings.length === interact.liveDrawings,
             '导出的战术文件笔迹数不对: ' + JSON.stringify(parsed.drawings && parsed.drawings.length) +
             ' 期望 ' + interact.liveDrawings);
    }
    if (imgs.length) {
      const head = fs.readFileSync(path.join(dirImg, imgs[0])).subarray(0, 4);
      expect(head.equals(Buffer.from([0x89, 0x50, 0x4E, 0x47])), '导出图片\\ 中的文件不是 PNG');
    }
  } else {
    // 没有本地服务时，导出应被安全策略拦截并给出中文指引
    expect(blobs.length === 0, '无服务时不应导出成功');
    expect(/serve\.cmd|安全策略/.test(interact.toastText || ''),
           '无服务时缺少导出降级提示: ' + interact.toastText);
  }
  const errLogs = ([] .concat(boot.errors || [], interact.logs || [])).filter(l => /^ERROR|^REJECT/.test(l));
  expect(errLogs.length === 0, '页面存在运行时错误: ' + JSON.stringify(errLogs));

  // 5. 截图
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(REF, 'shot-test.png'), Buffer.from(shot.data, 'base64'));
  console.log('[5] 截图已保存: _ref/shot-test.png');

  chrome.kill();

  if (fails.length) {
    console.log('\n=== 失败 ' + fails.length + ' 项 ===');
    fails.forEach(f => console.log('  ✗ ' + f));
    process.exit(1);
  }
  console.log('\n=== 全部检查通过 ===');
})().catch(err => {
  console.error('测试驱动异常:', err);
  process.exit(2);
});
