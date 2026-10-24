/* 数据与页面彻底分离
 *
 * 问题（用户指出）：
 *   页面用 localStorage 存数据，而 Electron 的 localStorage 是
 *   按「页面来源(file://路径)」隔离的。更新 HTML = 换文件路径 =
 *   读到空数据 = 作业全没了。
 *
 * 解决：
 *   · 在 preload 里暴露一个「同步的」文件存储 API（data.json）
 *   · 页面优先用它；不在应用里（纯浏览器打开）时回退到 localStorage
 *   · 文件在 ~/.config/作业贴/data/data.json，永不被更新覆盖
 *
 * 关键点：存储层必须**同步**，因为现有代码是同步读写 DB 的。
 *   Electron 的 ipcRenderer.invoke 是异步的，所以改用
 *   ipcRenderer.sendSync（同步）——对 localStorage 这种小数据量完全够。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DATA_DIR = path.join(app.getPath('userData'), 'data');
const DB_FILE = path.join(DATA_DIR, 'data.json');
const DB_BAK = path.join(DATA_DIR, 'data.json.bak');

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}

/* 读：优先主文件，坏了/没有就用备份 */
function readDB() {
  ensureDir();
  const tryRead = (p) => {
    try {
      if (!fs.existsSync(p)) return null;
      const s = fs.readFileSync(p, 'utf8');
      if (!s || !s.trim()) return null;
      return s;
    } catch (e) { return null; }
  };
  let s = tryRead(DB_FILE);
  if (s) return s;
  s = tryRead(DB_BAK);
  if (s) {
    console.log('[store] 主数据文件不可用，已回退到备份');
    return s;
  }
  return null;
}

/* 写：先写临时文件再改名，避免写一半断电导致文件损坏 */
function writeDB(text) {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    if (fs.existsSync(DB_FILE)) {
      try { fs.copyFileSync(DB_FILE, DB_BAK); } catch (e) {}
    }
    fs.renameSync(tmp, DB_FILE);
    return true;
  } catch (e) {
    console.error('[store] 写入失败: ' + e.message);
    try { fs.unlinkSync(tmp); } catch (x) {}
    return false;
  }
}

function info() {
  return {
    dir: DATA_DIR,
    file: DB_FILE,
    exists: fs.existsSync(DB_FILE),
    size: (function () {
      try { return fs.statSync(DB_FILE).size; } catch (e) { return 0; }
    })()
  };
}

module.exports = { readDB, writeDB, info, DATA_DIR, DB_FILE };
