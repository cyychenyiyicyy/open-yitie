/* 小窗模式 · 主进程
 *
 * 需求（用户原话）：
 *   · 点按钮切成小窗，一竖列显示全部作业（不分科目）
 *   · 可以切到其他应用去展示东西，同时还能看到作业 → 窗口必须置顶
 *   · 窗口可以调整大小，但**不要出现滚动条**
 *   · 缩得太小时用算法限制一个最小值
 *
 * 最小尺寸怎么算：
 *   每行作业至少需要「科目徽章 + 书名 + 页码」横向排开，
 *   中文最小可读字号按 12px 算，一行约占 28px 高。
 *   竖列至少露出 5 行才算"能用"，横排至少能放下
 *   「语文 同步学与练 P20」这种最长组合，约 220px。
 *   所以下限取 240 × 360，再乘上系统 DPI 系数。
 *
 * 无滚动条：
 *   窗口内是纯 flex 布局，内容按可用高度**等比缩放字号**（不是滚动），
 *   所以永远不需要滚动条。到达最小字号（11px）时，剩余内容允许裁掉，
 *   此时把窗口最小尺寸卡住，用户拖不到那个程度。
 */
'use strict';
const { BrowserWindow, screen, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let miniWin = null;
let lastMiniData = null;
let mainWin = null;   /* 主窗口引用，用于通知它重算数据 */

/* 由 main.js 在创建主窗口后调用 */
function setMainWindow(w) { mainWin = w; }

/* 最小尺寸（逻辑像素）。按"至少 5 行、每行能放下最长书名"推算。 */
const MIN_W = 260;
const MIN_H = 380;
/* 舒适尺寸：打开时的默认大小 */
const DEF_W = 360;
const DEF_H = 620;

function miniFile() {
  return path.join(__dirname, 'mini.html');
}

/* 记住用户调过的大小，下次沿用 */
let lastBounds = null;

function openMini(data) {
  /* 已存在就更新内容并聚焦 */
  if (miniWin && !miniWin.isDestroyed()) {
    sendData(miniWin, data);
    if (miniWin.isMinimized()) miniWin.restore();
    miniWin.show();
    miniWin.focus();
    return { ok: true, reused: true };
  }

  const disp = screen.getPrimaryDisplay().workAreaSize;
  const w = Math.min(DEF_W, Math.max(MIN_W, Math.floor(disp.width * 0.22)));
  const h = Math.min(DEF_H, Math.max(MIN_H, Math.floor(disp.height * 0.6)));

  const b = lastBounds || {};
  miniWin = new BrowserWindow({
    width: Math.max(MIN_W, b.width || w),
    height: Math.max(MIN_H, b.height || h),
    x: typeof b.x === 'number' ? b.x : undefined,
    y: typeof b.y === 'number' ? b.y : undefined,
    minWidth: MIN_W,
    minHeight: MIN_H,
    frame: false,               /* 自绘标题栏，省空间 */
    resizable: true,
    alwaysOnTop: true,          /* 关键：浮在别的应用上面 */
    skipTaskbar: false,
    show: false,
    backgroundColor: '#0f1210',
    title: '作业贴 · 小窗',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'mini-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  /* 置顶级别：普通置顶即可，不要压过全屏视频 */
  miniWin.setAlwaysOnTop(true, 'floating');

  miniWin.loadFile(miniFile());

  miniWin.once('ready-to-show', () => {
    miniWin.show();
    sendData(miniWin, data);
  });

  /* 记住尺寸变化 */
  miniWin.on('resize', () => {
    if (!miniWin || miniWin.isDestroyed()) return;
    const bb = miniWin.getBounds();
    lastBounds = bb;
  });
  miniWin.on('move', () => {
    if (!miniWin || miniWin.isDestroyed()) return;
    const bb = miniWin.getBounds();
    lastBounds = bb;
  });

  miniWin.on('closed', () => { miniWin = null; });

  /* 窗口内的按钮请求 */
  miniWin.webContents.on('did-finish-load', () => {
    /* nothing */
  });

  return { ok: true, reused: false };
}

function sendData(win, data) {
  if (!win || win.isDestroyed()) return;
  if (data) lastMiniData = data;
  try {
    win.webContents.send('mini-data', data || { items: [], count: 0 });
  } catch (e) {}
}

function updateMini(data) {
  if (!miniWin || miniWin.isDestroyed()) return { ok: false };
  sendData(miniWin, data);
  return { ok: true };
}

function closeMini() {
  if (miniWin && !miniWin.isDestroyed()) miniWin.close();
  miniWin = null;
  return { ok: true };
}

function isMiniOpen() {
  return !!(miniWin && !miniWin.isDestroyed() && miniWin.isVisible());
}

/* 注册小窗相关的 IPC 与窗口按钮 */
function setupMini(ipc) {
  ipc.handle('mini-open', (ev, data) => openMini(data));
  ipc.handle('mini-update', (ev, data) => updateMini(data));
  ipc.handle('mini-close', () => closeMini());
  ipc.handle('mini-is-open', () => isMiniOpen());

  /* 小窗自己的窗口控制 */
  ipc.handle('mini-pin', (ev, on) => {
    if (!miniWin || miniWin.isDestroyed()) return { ok: false };
    miniWin.setAlwaysOnTop(!!on, 'floating');
    return { ok: true, pinned: !!on };
  });
  ipc.handle('mini-min', () => {
    if (miniWin && !miniWin.isDestroyed()) miniWin.minimize();
    return { ok: true };
  });
  /* 小窗要数据时：先让主窗口重新算一遍（作业可能变了），
     同时把缓存先发过去保证不空窗。 */
  ipc.on('mini-want-data', () => {
    /* 让主窗口重新算一遍数据（作业可能变了），再推给小窗 */
    if (mainWin && !mainWin.isDestroyed()) {
      try { mainWin.webContents.send('mini-need-data'); } catch (e) {}
    }
    if (miniWin && !miniWin.isDestroyed() && lastMiniData) sendData(miniWin, lastMiniData);
  });

  ipc.handle('mini-bounds', () => {
    if (!miniWin || miniWin.isDestroyed()) return null;
    return Object.assign({}, miniWin.getBounds(), {
      minWidth: MIN_W,
      minHeight: MIN_H
    });
  });
}

module.exports = { setupMini, closeMini, isMiniOpen, setMainWindow, MIN_W, MIN_H };
