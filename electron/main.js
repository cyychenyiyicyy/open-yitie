/* Open作业贴 · Electron 主进程
 *
 * 设计目标（用户要求）：
 *   1. 单独的应用，点图标就开，像个真软件
 *   2. 常驻后台：关窗口不退出，托盘能唤出
 *   3. 纯离线：默认不联网、不检查更新（可在 CONFIG 里自己开）
 *   4. 全部依赖内置（打包成 .deb，双击图形化安装）
 *
 * 更新逻辑要点：
 *   · 页面本体不打包进 asar，放在用户数据目录，方便直接替换
 *   · 启动时先读本地缓存的 HTML，若有网再后台检查更新
 *   · 用版本号 + ETag 双重判断，避免每次全量下载
 *   · 下载失败/文件损坏一律保留旧版，绝不让应用变砖
 */
'use strict';

const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');
const mini = require('./mini');

/* ---------------- 配置：更新源 ---------------- */
/* 更新源地址。**离线版默认留空**（不联网）。
 * 想自己加更新源的话，改成你的 raw 地址即可，例如：
 *   https://github.com/<你的账号>/<你的仓库>/raw/main/dist/ */
const CONFIG = {
  // 例：https://github.com/你的账号/open-yitie/raw/main/dist/
  /* 纯离线版：**不联网更新**。留空表示关闭。
   * 想自己加更新源的话，把这里改成你的 raw 地址即可。 */
  updateBase: '',
  // 版本清单文件名
  /* 更新源协议：页面以 gzip+base64 分块存储，应用端拉回来解压还原。
     （离线版用不到，留着是为了想加更新源的人不用重写。） */
  manifestName: 'manifest.json',
  partPrefix: 'p',
  partSuffix: '.dat',
  // 启动时是否检查更新（离线版默认关）
  checkOnStart: false,
  // 深色标题栏
  bg: '#0f1210'
};

/* ---------------- 路径 ---------------- */
/* 路径惰性求值：Electron 要求 app.getPath 只能在 ready 之后调。
   顶层直接调用在某些环境下会崩溃，这里改成用到时才取。 */
let _paths = null;
function P() {
  if (!_paths) {
    var u = app.getPath('userData');
    _paths = {
      user: u,
      data: path.join(u, 'data'),
      cache: path.join(u, 'cache')
    };
    _paths.page = path.join(_paths.data, 'classboard.html');
    _paths.pageBak = path.join(_paths.data, 'classboard.html.bak');
    /* 第二份备份（独立审查的 D4）：原来只有一份 .bak ⇒
     * 降级一次就再也回不到更早的版本（用户会一直卡在那个版本）。
     * ⇒ 保留两级：.bak（上一版）和 .bak2（上上版）。 */
    _paths.pageBak2 = path.join(_paths.data, 'classboard.html.bak2');
    _paths.manifest = path.join(_paths.cache, 'version.json');
  }
  return _paths;
}
function USER_DIR() { return P().user; }
function DATA_DIR() { return P().data; }
function CACHE_DIR() { return P().cache; }
function PAGE_FILE() { return P().page; }
function PAGE_BAK() { return P().pageBak; }
function PAGE_BAK2() { return P().pageBak2; }
function MANIFEST_FILE() { return P().manifest; }

let win = null;
let tray = null;
let isQuitting = false;

/* ================= 工具函数 ================= */

function ensureDirs() {
  [DATA_DIR(), CACHE_DIR()].forEach(d => {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  });
}

/* 内置的初始页面（首次启动时从 app 里复制出来） */
function seedPageIfNeeded() {
  if (fs.existsSync(PAGE_FILE())) return;
  const bundled = path.join(__dirname, 'page', 'classboard.html');
  try {
    if (fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, PAGE_FILE());
      console.log('[seed] 已从内置页面初始化');
    }
  } catch (e) {
    console.error('[seed] 失败: ' + e.message);
  }
}

/* base64 + gzip 解码（Node zlib 内置） */
function decodePage(b64) {
  try {
    var zlib = require('zlib');
    var buf = Buffer.from(b64, 'base64');
    return zlib.gunzipSync(buf).toString('utf8');
  } catch (e) {
    return null;
  }
}

/* 下载到文件；返回 Promise<{ok, status, data}> */
function fetchUrl(url, timeoutMs) {
  return new Promise(resolve => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      timeout: timeoutMs || 20000,
      headers: { 'User-Agent': 'open-yitie/' + app.getVersion() }
    }, res => {
      /* 跟随重定向 */
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        fetchUrl(next, timeoutMs).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ ok: false, status: res.statusCode, data: '' });
        return;
      }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => (buf += d));
      res.on('end', () => resolve({ ok: true, status: 200, data: buf }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, data: 'timeout' }); });
    req.on('error', e => resolve({ ok: false, status: 0, data: e.message }));
  });
}

/* 校验下载到的 HTML：必须像那么回事，防止被网关劫持成错误页 */
function looksLikeValidPage(html) {
  if (!html || html.length < 20000) return '文件太小(' + (html ? html.length : 0) + '字节)';
  if (html.indexOf('<!DOCTYPE html') !== 0 && html.indexOf('<!doctype html') !== 0) {
    return '开头不是 <!DOCTYPE html>';
  }
  if (html.indexOf('Open作业贴') < 0) return '内容里找不到「Open作业贴」';
  return null;
}

/* ================= 更新 ================= */

async function checkUpdate(manual) {
  /* manual=true 时（用户点「检查更新」）要给出反馈 */
  ensureDirs();

  /* ★ 纯离线版：没配更新源就**直接返回**，一个网络请求都不发。
   *   （原来 updateBase 是写死的 Gitee 地址，离线版把它清空了，
   *     但 checkUpdate 还会照常去请求 ⇒ 每次启动都白等一次超时。
   *     这里提前挡住。） */
  if (!CONFIG.updateBase) {
    if (manual) notify('这是离线版', 'Open作业贴 不联网更新，请到 GitHub 仓库获取新版本。');
    return { ok: false, msg: 'offline-build' };
  }

  const mfUrl = CONFIG.updateBase + CONFIG.manifestName + '?t=' + Date.now();
  const r1 = await fetchUrl(mfUrl, 15000);

  if (!r1.ok) {
    const msg = r1.status === 404
      ? '更新源上还没有 version.json'
      : '连不上更新源 (' + (r1.data || r1.status) + ')';
    if (manual) notify('检查更新失败', msg);
    return { ok: false, msg };
  }

  let mf;
  try { mf = JSON.parse(r1.data); }
  catch (e) {
    if (manual) notify('检查更新失败', 'version.json 格式不对');
    return { ok: false, msg: '清单格式错误' };
  }

  /* 记下清单，方便排查 */
  try { fs.writeFileSync(MANIFEST_FILE(), r1.data, 'utf8'); } catch (e) {}

  const remoteVer = String(mf.version || '').trim();
  const remoteHash = String(mf.hash || '').trim();
  const remoteDate = String(mf.date || '').trim();

  /* 本地版本 */
  let localVer = '';
  try {
    if (fs.existsSync(MANIFEST_FILE())) {
      /* 用上次成功应用的那份清单作为本地版本 */
      const applied = path.join(DATA_DIR(), 'applied.json');
      if (fs.existsSync(applied)) {
        localVer = JSON.parse(fs.readFileSync(applied, 'utf8')).version || '';
      }
    }
  } catch (e) {}

  if (remoteVer && localVer && remoteVer === localVer && !manual) {
    if (manual) notify('已是最新', '当前版本 ' + localVer);
    return { ok: true, updated: false, version: localVer };
  }

  /* ★ 坏版本黑名单：自动更新时跳过已知会崩的版本。
   *   手动检查**不跳过**（用户明确要求时该给机会强推）——
   *   这也是上面那个条件要加 `&& !manual` 的原因：
   *   回滚后 localVer 仍等于坏版本号，若不加 !manual，
   *   手动检查会先被"已是最新"挡掉，永远强推不了。 */
  if (!manual && isBadVersion(remoteVer)) {
    console.error('[update] 云端版本 ' + remoteVer + ' 之前崩过，自动更新跳过（手动检查可强推）');
    return { ok: true, updated: false, version: localVer, skipped: true };
  }

  /* 下载页面：按清单里的分块数逐个拉，再拼起来解压 */
  const partCount = Number(mf.parts) || 1;
  let joined = '';
  for (let i = 0; i < partCount; i++) {
    const pUrl = CONFIG.updateBase + CONFIG.partPrefix + i + CONFIG.partSuffix + '?t=' + Date.now();
    const pr = await fetchUrl(pUrl, 90000);
    if (!pr.ok) {
      if (manual) notify('下载失败', '第 ' + (i + 1) + '/' + partCount + ' 块没拿到');
      return { ok: false, msg: '分块下载失败 ' + i };
    }
    joined += pr.data.trim();
  }

  const decoded = decodePage(joined);
  if (!decoded) {
    if (manual) notify('解压失败', '拿到的数据不完整，已保留旧版');
    return { ok: false, msg: 'decode failed' };
  }

  const r2 = { data: decoded };

  const bad = looksLikeValidPage(r2.data);
  if (bad) {
    if (manual) notify('新版本有问题', bad + '，已保留旧版');
    return { ok: false, msg: bad };
  }

  /* 哈希校验（对解压后的 HTML 内容算，与发布端一致） */
  if (remoteHash) {
    const h = crypto.createHash('sha256').update(r2.data, 'utf8').digest('hex');
    if (h !== remoteHash) {
      if (manual) notify('校验失败', '文件哈希对不上，已保留旧版');
      return { ok: false, msg: 'hash mismatch' };
    }
  }

  /* 备份旧版 → 写入新版（滚动保留两级备份） */
  try {
    if (fs.existsSync(PAGE_FILE())) {
      /* .bak2 ← 旧的 .bak；.bak ← 当前页 */
      if (fs.existsSync(PAGE_BAK())) fs.copyFileSync(PAGE_BAK(), PAGE_BAK2());
      fs.copyFileSync(PAGE_FILE(), PAGE_BAK());
    }
    fs.writeFileSync(PAGE_FILE(), r2.data, 'utf8');
    fs.writeFileSync(path.join(DATA_DIR(), 'applied.json'),
      JSON.stringify({ version: remoteVer, date: remoteDate, at: Date.now() }), 'utf8');
  } catch (e) {
    if (manual) notify('写入失败', e.message);
    return { ok: false, msg: e.message };
  }

  console.log('[update] 已更新到 ' + remoteVer);
  pageFailCount = 0;   /* 新版本，重置失败计数 */

  if (manual) {
    notify('更新完成', '已更新到 ' + remoteVer + '，正在重新载入');
    setTimeout(() => loadPage(), 600);
  } else if (win) {
    /* 静默更新：下次打开生效，这里直接重载 */
    loadPage();
  }

  return { ok: true, updated: true, version: remoteVer };
}

function notify(title, body) {
  if (win) {
    try { win.webContents.send('toast', { title, body }); } catch (e) {}
    /* 同时弹一个系统通知，用户切到别的窗口也知道 */
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch (e) {}
  } else {
    try {
      const { Notification } = require('electron');
      if (Notification.isSupported()) new Notification({ title, body }).show();
    } catch (e) {}
  }
}

/* ================= 窗口 ================= */

/* ---------- 坏版本黑名单 ----------
 * 场景：云端发了一个有问题的版本，页面一加载就崩。
 * 回滚后如果还一直去拉它，就会「新版 ↔ 旧版」死循环（见 rollbackPage 的说明）。
 * ⇒ 记下崩过的版本号，**同一个版本不再自动更新**。
 *   · 手动检查更新仍然可以强推（用户明确要求时该给机会）；
 *   · 云端发了**新版本号** ⇒ 黑名单不命中 ⇒ 正常更新。
 *   · 黑名单存在 data/bad-versions.json（跟着数据目录走，重装不丢）。
 */
function BAD_VERSIONS_FILE() {
  return path.join(DATA_DIR(), 'bad-versions.json');
}
function readBadVersions() {
  try {
    const raw = fs.readFileSync(BAD_VERSIONS_FILE(), 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}
function markBadVersion(v) {
  const list = readBadVersions();
  const s = String(v || '');
  if (!s || list.indexOf(s) >= 0) return;
  list.push(s);
  while (list.length > 10) list.shift();   /* 只留最近 10 个 */
  try {
    fs.writeFileSync(BAD_VERSIONS_FILE(), JSON.stringify(list), 'utf8');
  } catch (e) {}
  console.error('[update] 已把版本 ' + s + ' 记入坏版本名单，不再自动更新它');
}
function isBadVersion(v) {
  const s = String(v || '');
  return !!s && readBadVersions().indexOf(s) >= 0;
}

/* 页面加载失败时回滚到上一版。
 * 场景：新版本语法错误导致白屏。这时如果不回滚，用户永远打不开。
 *
 * ⚠️⚠️ 2026-10-23 修了一个**死循环**：
 *   原来回滚时会删掉 applied.json（想让它"下次重新检查更新"），
 *   但下次启动时 localVer 变空 ⇒ 版本号对不上 ⇒ **又把同一个坏版本下载回来**
 *   ⇒ 又崩 ⇒ 又回滚 ⇒ 用户永远在"新版本 ↔ 旧版本"之间来回跳
 *   （用户报告的现象正是「点录音 → 黑屏 → 跳回 2.1.2」）。
 *   ⇒ 现在**回滚时保留 applied.json**：
 *      applied.json 里记着"云端当前是哪个版本"，回滚后 localVer 仍等于云端版本
 *      ⇒ 下次启动判定"已是最新" ⇒ 不会再拉那个坏版本 ⇒ 循环断了。
 *      等云端发了新版本，版本号变了，照样会正常更新。
 *
 * ⚠️ 这条修复在**外壳**里（main.js）⇒ 需要重装 deb 才生效。
 *    但页面侧的崩溃修复（音频采集）随页面更新就生效。
 */
let pageFailCount = 0;
const MAX_PAGE_FAIL = 3;

function rollbackPage(reason) {
  pageFailCount++;
  console.error('[rollback] 页面加载失败(' + reason + ')，第 ' + pageFailCount + ' 次');

  if (pageFailCount > MAX_PAGE_FAIL) {
    console.error('[rollback] 连续失败太多次，停止自动回滚');
    return false;
  }

  /* 备份链：先用 .bak（上一版），没有再用 .bak2（上上版） */
  let bak = PAGE_BAK();
  if (!fs.existsSync(bak)) {
    bak = PAGE_BAK2();
    console.log('[rollback] .bak 没有，试试 .bak2');
  }
  if (!fs.existsSync(bak)) {
    console.error('[rollback] 没有备份可回滚');
    return false;
  }

  try {
    fs.copyFileSync(bak, PAGE_FILE());
    /* ⚠️ **不要**删 applied.json —— 那会造成死循环（见上面的说明）。
       保留它 = 下次启动不会把同一个坏版本再拉回来。
       顺便把这个版本记进坏版本名单 ⇒ 自动更新也会跳过它。 */
    try {
      const applied = path.join(DATA_DIR(), 'applied.json');
      if (fs.existsSync(applied)) {
        const v = JSON.parse(fs.readFileSync(applied, 'utf8')).version || '';
        markBadVersion(v);
      }
    } catch (e) {}
    console.log('[rollback] 已回滚到上一版页面（保留 applied.json，避免反复拉同一个坏版本）');
    notify('已退回上一版', '这个版本有问题，已自动换回上一版。等新版本发布后会自动更新。');
    return true;
  } catch (e) {
    console.error('[rollback] 回滚失败: ' + e.message);
    return false;
  }
}

function loadPage() {
  if (!win) return;
  if (fs.existsSync(PAGE_FILE())) {
    const target = PAGE_FILE();

    /* 加载失败 → 自动回滚（只挂一次，用 once + 标记避免重复） */
    const onFail = (e, code, desc) => {
      console.error('[load] 失败 ' + code + ' ' + desc);
      if (rollbackPage('did-fail-load ' + code)) {
        setTimeout(() => { try { win.loadFile(PAGE_FILE()); } catch (x) {} }, 300);
      }
    };
    win.webContents.once('did-fail-load', onFail);

    /* ★ 页面成功加载 ⇒ 把失败计数清零。
     *   原来只在"检查更新成功"时清零 ⇒ 连续三次失败后回滚**永久停用**，
     *   后面真出白屏也不会再自动救（独立审查的 D3）。 */
    win.webContents.once('did-finish-load', () => {
      if (pageFailCount) {
        console.log('[load] 页面加载成功，失败计数清零');
        pageFailCount = 0;
      }
    });

    /* 渲染进程崩溃（白屏的另一种表现）
     *
     * ⚠️⚠️ 2026-10-23 收窄了判定条件（独立审查的 D1）：
     *   原来只要 `reason !== 'clean-exit'` 就**整版降级**。
     *   但"运行中崩溃"和"页面本身坏了"是两回事 ——
     *   2026-10-23 的教室事故就是：应用完全正常，
     *   只是用户点录音时踩了 Chromium 93 在 Linux 上的一个 bug
     *   （AudioContext.decodeAudioData → SIGSEGV），
     *   结果整个应用被降级回 2.1.2，用户作业全丢。
     *
     *   ⇒ 现在区分两种情况：
     *     · 'crashed' / 'oom' / 'launch-failed' / 'integrity-failure'
     *       等**致命**原因 ⇒ 降级（页面很可能真的坏了）
     *     · 其它 reason ⇒ 只提示，**不降级**（可能是用户操作触发的偶发崩溃，
     *       降级反而会丢掉用户正在用的新版本）
     *   ⚠️ 更根本的修法在页面侧：不用会崩的 API（AudioWorklet 代替
     *      decodeAudioData）。这条只是兜底。
     */
    const FATAL_REASONS = ['crashed', 'oom', 'launch-failed', 'integrity-failure', 'gpu-process-crashed'];
    win.webContents.once('render-process-gone', (e, details) => {
      const reason = String(details.reason || '');
      console.error('[load] 渲染进程异常: ' + reason);
      if (reason === 'clean-exit') return;
      if (FATAL_REASONS.indexOf(reason) < 0) {
        /* 非致命：提示一下，不动版本 */
        console.error('[load] 非致命崩溃，不降级（避免把用户正在用的新版本换掉）');
        notify('页面出了点问题', '已自动恢复。如果反复出现，请从托盘菜单检查更新。');
        setTimeout(() => { try { win.reload(); } catch (x) {} }, 800);
        return;
      }
      if (rollbackPage('render-gone ' + reason)) {
        setTimeout(() => { try { win.loadFile(PAGE_FILE()); } catch (x) {} }, 300);
      }
    });

    win.loadFile(target);
  } else {
    /* 连内置页面都没有：显示一个兜底页 */
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<html><body style="background:#111;color:#ddd;font:16px sans-serif;padding:40px">' +
      '<h2>Open作业贴</h2><p>页面文件缺失。请重新安装本应用。</p></body></html>'
    ));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: CONFIG.bg,
    show: false,
    autoHideMenuBar: true,
    title: 'Open作业贴',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.once('ready-to-show', () => {
    win.show();
    /* 首次打开时如果没更新过，后台查一次 */
    if (CONFIG.checkOnStart) {
      setTimeout(() => { checkUpdate(false); }, 2500);
    }
  });

  /* 关窗口不退出，收到托盘 */
  win.on('close', e => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
      notify('Open作业贴仍在后台', '点托盘图标可以再打开');
    }
  });

  /* 外链用系统浏览器打开，不在应用里跳走 */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  loadPage();
}

/* ================= 托盘 ================= */

function createTray() {
  let icon;
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  try {
    icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
    if (icon.isEmpty()) throw new Error('empty');
    /* 托盘图标别太大 */
    icon = icon.resize({ width: 22, height: 22 });
  } catch (e) {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Open作业贴');

  const menu = Menu.buildFromTemplate([
    { label: '打开 Open作业贴', click: () => showWindow() },
    { type: 'separator' },
    { label: '小窗模式', click: () => { if (win && !win.isDestroyed()) win.webContents.send('open-mini'); } },
    { label: '检查更新（离线版通常无需更新）', click: () => checkUpdate(true) },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR()) },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);

  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ================= 生命周期 ================= */

/* 单实例：重复点图标只把已有的窗口叫出来 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    ensureDirs();
    seedPageIfNeeded();

    /* ---------- 存储 IPC（同步，供页面直接读写） ---------- */
    ipcMain.on('store-get', (ev) => {
      ev.returnValue = store.readDB();
    });
    ipcMain.on('store-set', (ev, text) => {
      ev.returnValue = store.writeDB(String(text || ''));
    });
    ipcMain.handle('store-info', () => store.info());

    /* 小窗模式 */
    mini.setupMini(ipcMain);

    /* 主进程收到的请求 */
    ipcMain.handle('check-update', () => checkUpdate(true));
    ipcMain.handle('app-info', () => {
      const si = store.info();
      return {
        version: app.getVersion(),
        userDir: USER_DIR(),
        dataDir: DATA_DIR(),
        pageFile: PAGE_FILE(),
        hasPage: fs.existsSync(PAGE_FILE()),
        dbFile: si.file,
        dbExists: si.exists,
        dbSize: si.size
      };
    });
    ipcMain.handle('open-data-dir', () => shell.openPath(DATA_DIR()));

    /* ---------- 界面：窗口 + 托盘（放最后，任何一个失败都不影响存储） ---------- */
    createWindow();
    mini.setMainWindow(win);


    /* 托盘在某些桌面环境可能失败（无托盘区 / 缺 libappindicator），
       包起来：失败了应用照样能用，只是没有托盘图标。
       注意托盘必须放在所有 IPC 注册之后 —— 它抛异常会中断后续代码。 */
    try {
      createTray();
    } catch (e) {
      console.error('[tray] 托盘创建失败（不影响主功能）: ' + e.message);
    }
  });

  app.on('activate', () => showWindow());

  /* 所有窗口关闭不退出（托盘常驻） */
  app.on('window-all-closed', () => {
    /* Linux 下同样保持后台 */
  });

  app.on('before-quit', () => {
    isQuitting = true;
    try { mini.closeMini(); } catch (e) {}
  });
}
