/**
 * clean-exports.js —— 清空导出目录中的产物（保留目录与说明文件）
 * 用法: node test/clean-exports.js
 *
 * 注意：请用脚本文件方式运行，不要用 `node -e "..."`。
 * PowerShell 向 node -e 传递含中文的参数时会按 ANSI 代码页转换，导致路径被破坏、
 * 删除静默失败（表现为「删了但文件还在」）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['导出图片', '导出战术'];

let total = 0;
for (const name of DIRS) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const removed = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(png|json)$/i.test(f)) continue;   // 保留 说明.txt 等
    try {
      fs.unlinkSync(path.join(dir, f));
      removed.push(f);
    } catch (e) {
      console.log('  删除失败: ' + f + ' → ' + e.code + ' ' + e.message);
    }
  }
  total += removed.length;
  console.log(name + '\\: 删除 ' + removed.length + ' 个文件，剩余 ' +
              JSON.stringify(fs.readdirSync(dir)));
}
console.log('共删除 ' + total + ' 个导出产物');
