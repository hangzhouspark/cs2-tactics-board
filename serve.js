/**
 * serve.js —— 本地静态服务（零依赖）
 * 用途：让战术板通过 http://127.0.0.1:8123 打开。
 * 这样做有三个好处：
 *   1) 「导出图片 / 导出战术」可以直接写进项目里的 导出图片\ 与 导出战术\ 文件夹；
 *   2) 导出 PNG 时 canvas 不会被 file:// 跨源策略污染；
 *   3) 导入/导出文件、localStorage 等浏览器行为更稳定。
 * 用法：  node serve.js      （或直接双击 serve.cmd）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 8123;

/** 允许写入的导出目录（白名单，防止越权写文件） */
const EXPORT_DIRS = {
  image: '导出图片',
  tactic: '导出战术'
};
const MAX_BODY = 25 * 1024 * 1024; // 25MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const target = path.normalize(path.join(root, decoded));
  if (!target.startsWith(root)) return null;
  return target;
}

/** 清理客户端传来的文件名，杜绝目录穿越 */
function safeFileName(name) {
  const base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 80);
  return base || 'export';
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/** 目录内重名时自动追加 -1 / -2 …，避免连续导出互相覆盖 */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, stem + '-' + n + ext);
    n++;
    if (n > 999) break;
  }
  return candidate;
}

/** 处理导出落盘：POST /__save  body = { dir, name, data(base64) } */
function handleSave(req, res) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) {
      sendJson(res, 413, { ok: false, error: '内容过大' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    const folder = EXPORT_DIRS[payload.dir];
    if (!folder) {
      sendJson(res, 400, { ok: false, error: '不允许写入该目录' });
      return;
    }
    const name = safeFileName(payload.name);
    const folderPath = path.join(ROOT, folder);
    const target = uniquePath(folderPath, name);
    if (!target.startsWith(folderPath)) {
      sendJson(res, 400, { ok: false, error: '非法文件名' });
      return;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(String(payload.data || ''), 'base64'));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: '写入失败：' + e.message });
      return;
    }
    const savedName = path.basename(target);
    const rel = folder + '/' + savedName;
    console.log('  已导出 → ' + rel);
    sendJson(res, 200, { ok: true, path: rel, name: savedName });
  });
}

function createServer() {
  return http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url.split('?')[0] === '/__save') {
      handleSave(req, res);
      return;
    }

    let file = safeJoin(ROOT, req.url === '/' ? '/index.html' : req.url);
    if (!file) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('禁止访问');
      return;
    }

    fs.stat(file, (err, stat) => {
      if (!err && stat.isDirectory()) file = path.join(file, 'index.html');
      fs.readFile(file, (err2, buf) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('未找到：' + req.url);
          return;
        }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': buf.length
        });
        res.end(buf);
      });
    });
  });
}

function listen(port, attemptsLeft) {
  const server = createServer();
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      console.log('端口 ' + port + ' 已被占用，改用 ' + (port + 1) + ' …');
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error('启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    // 确保导出目录存在
    Object.keys(EXPORT_DIRS).forEach((k) => {
      try { fs.mkdirSync(path.join(ROOT, EXPORT_DIRS[k]), { recursive: true }); } catch (e) { /* 忽略 */ }
    });

    console.log('');
    console.log('  CS2 战术板 · 本地服务已启动');
    console.log('  http://' + HOST + ':' + port + '/index.html');
    console.log('');
    console.log('  导出会直接写入项目文件夹：');
    console.log('    ' + EXPORT_DIRS.image + '\\   ← 导出的 PNG 图片');
    console.log('    ' + EXPORT_DIRS.tactic + '\\   ← 导出的 .json 战术文件');
    console.log('');
    console.log('  请在浏览器中打开上面的地址（页面也会自动探测 ' + BASE_PORT + '–' + (BASE_PORT + 9) + ' 端口）。');
    console.log('  关闭窗口即停止服务。按 Ctrl+C 退出。');
    console.log('');
  });
}

listen(BASE_PORT, 9);
