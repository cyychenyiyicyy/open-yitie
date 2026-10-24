/* ============================================================================
 * rename-branding.cjs —— 把「作业贴」改名为「Open作业贴」，版权归 yiyi
 *
 * 改的地方：
 *   · 页面标题 / 顶栏品牌名 / 开屏动画 / 空状态 hero / 版权行
 *   · Electron 窗口标题、托盘提示、菜单文案、User-Agent
 *   · package.json 的 productName / author / description / homepage
 *
 * ⚠️ 只改**面向用户**的名字，教材名「同步学与练」这类不能碰。
 * 用法：node tools/rename-branding.cjs
 * 退出码：0 = 成功；1 = 有块没改到
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const problems = [];
let changed = 0;

function edit(rel, pairs) {
  const f = path.join(ROOT, rel);
  let s = fs.readFileSync(f, 'utf8');
  const CRLF = s.indexOf('\r\n') >= 0;
  s = s.replace(/\r\n/g, '\n');
  let n = 0;
  for (const [from, to] of pairs) {
    const has = s.indexOf(from) >= 0;
    /* ⚠️ 幂等：已经改过的地方（to 已存在）不算失败，
     *    否则脚本第二次跑就会自己报一堆「找不到」——
     *    那样就没法重复跑了（2026-10-23 踩过）。 */
    if (!has) {
      if (s.indexOf(to) >= 0) { console.log('    （已改过，跳过）' + from.slice(0, 50)); continue; }
      problems.push(rel + '：找不到 → ' + from.slice(0, 70));
      continue;
    }
    const c = s.split(from).length - 1;
    s = s.split(from).join(to);
    n += c;
  }
  fs.writeFileSync(f, CRLF ? s.replace(/\n/g, '\r\n') : s, 'utf8');
  changed += n;
  console.log('  ' + rel + '：改 ' + n + ' 处');
}

/* ---------------- 页面模板 ---------------- */
edit('src/template.html', [
  ['<title>作业贴 · 教室大屏</title>',
   '<title>Open作业贴 · 教室大屏</title>'],

  ['  作业贴 · 教室大屏作业板',
   '  Open作业贴 · 教室大屏作业板'],

  /* 顶栏品牌名：原来「作业<em>贴</em>」把「贴」做成主题色，
     改成「Open作业<em>贴</em>」—— 「贴」还是高亮，前面加 Open。 */
  ['<h1 class="brand__title">作业<em>贴</em>',
   '<h1 class="brand__title">Open作业<em>贴</em>'],

  /* 版权行 */
  ['<span class="statusbar__copy">Copyright © 2026 HidaTerm. All rights reserved. e1e.site · yiyicyy.com.</span>',
   '<span class="statusbar__copy">Open作业贴 · Copyright © 2026 yiyi · MIT License · 开源离线版</span>'],

  /* 状态条说明文字 */
  ['<!-- 左下角状态：版本号 + 上次同步时间 + 版权行 -->',
   '<!-- 左下角状态：版本号 + 本机存储说明 + 版权行 -->'],
]);

/* ---------------- Electron 主进程 ---------------- */
edit('electron/main.js', [
  /* 更新源：纯离线版不需要联网更新 ⇒ 关掉。
     （用户明确要求「去除云同步等功能」，云端更新同属联网功能。） */
  ["  updateBase: 'https://gitee.com/x3678/zuoyetie/raw/master/',",
   "  /* 纯离线版：**不联网更新**。留空表示关闭。\n" +
   "   * 想自己加更新源的话，把这里改成你的 raw 地址即可。 */\n" +
   "  updateBase: '',"],

  ['  // 启动时是否检查更新\n  checkOnStart: true,',
   '  // 启动时是否检查更新（离线版默认关）\n  checkOnStart: false,'],

  ["  if (html.indexOf('作业贴') < 0) return '内容里找不到「作业贴」';",
   "  if (html.indexOf('Open作业贴') < 0) return '内容里找不到「Open作业贴」';"],

  ["      headers: { 'User-Agent': 'yitie/' + app.getVersion() }",
   "      headers: { 'User-Agent': 'open-yitie/' + app.getVersion() }"],

  ["    title: '作业贴',",
   "    title: 'Open作业贴',"],

  ["      '<h2>作业贴</h2><p>页面文件缺失。请点托盘菜单「检查更新」重新下载。</p></body></html>'",
   "      '<h2>Open作业贴</h2><p>页面文件缺失。请重新安装本应用。</p></body></html>'"],

  ["  tray.setToolTip('作业贴');",
   "  tray.setToolTip('Open作业贴');"],

  ["    { label: '打开作业贴', click: () => showWindow() },",
   "    { label: '打开 Open作业贴', click: () => showWindow() },"],

  ["    { label: '检查更新', click: () => checkUpdate(true) },",
   "    { label: '检查更新（离线版通常无需更新）', click: () => checkUpdate(true) },"],

  ["      notify('作业贴仍在后台', '点托盘图标可以再打开');",
   "      notify('Open作业贴仍在后台', '点托盘图标可以再打开');"],

  /* 文件头注释 */
  ['/* 作业贴 · Electron 主进程',
   '/* Open作业贴 · Electron 主进程'],

  /* 头部的设计说明：把「云控更新」那条改成离线说明 */
  [' *   3. 云控更新：从 Gitee 拉最新的 HTML 本体，静默替换',
   ' *   3. 纯离线：默认不联网、不检查更新（可在 CONFIG 里自己开）'],

  /* 更新源那段注释 */
  ['/* Gitee 仓库地址。改成你自己的仓库即可。\n' +
   ' * 注意：公开仓库用 raw 地址；私有仓库需要带 token（不建议，token 会留在客户端）。 */',
   '/* 更新源地址。**离线版默认留空**（不联网）。\n' +
   ' * 想自己加更新源的话，改成你的 raw 地址即可，例如：\n' +
   ' *   https://github.com/<你的账号>/<你的仓库>/raw/main/dist/ */'],

  ['  // 例：https://gitee.com/用户名/作业贴/raw/master/dist/',
   '  // 例：https://github.com/你的账号/open-yitie/raw/main/dist/'],

  ['  /* 更新源协议：Gitee 的内容审核会拦含教材目录的 HTML（451），\n' +
   '     所以页面以 gzip+base64 分块存储，应用端拉回来解压还原。 */',
   '  /* 更新源协议：页面以 gzip+base64 分块存储，应用端拉回来解压还原。\n' +
   '     （离线版用不到，留着是为了想加更新源的人不用重写。） */'],
]);

/* ---------------- preload ---------------- */
edit('electron/preload.js', [
  ['/* 作业贴 · preload',
   '/* Open作业贴 · preload'],
]);

/* ---------------- package.json ---------------- */
{
  const f = path.join(ROOT, 'electron', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  pkg.name = 'open-yitie';
  pkg.productName = 'Open作业贴';
  pkg.version = '1.0.0';
  pkg.description = 'Open作业贴 —— 教室大屏作业看板（开源离线版）';
  pkg.author = { name: 'yiyi', email: 'yiyi@users.noreply.github.com' };
  pkg.homepage = 'https://github.com/yiyi/open-yitie';
  pkg.repository = {
    type: 'git',
    url: 'https://github.com/yiyi/open-yitie.git'
  };
  pkg.license = 'MIT';
  pkg.build.productName = 'Open作业贴';
  pkg.build.copyright = 'Copyright © 2026 yiyi';
  pkg.build.appId = 'com.yiyi.openuitie';
  pkg.build.linux.maintainer = 'yiyi <yiyi@users.noreply.github.com>';
  pkg.build.linux.synopsis = '教室大屏作业看板（开源离线版）';
  pkg.build.linux.description =
    'Open作业贴 —— 给教室大屏用的每日作业看板。支持九科作业录入、提交时效高亮、导学案课时、展示模式、卡片自定义背景；' +
    '**完全离线运行**，数据只存在本机，不联网、不上传、不含 AI 与语音功能。MIT 开源。';
  pkg.build.linux.desktop.entry.Name = 'Open作业贴';
  pkg.build.linux.desktop.entry.Comment = '教室大屏作业看板（开源离线版）';
  pkg.build.linux.desktop.entry.StartupWMClass = 'open-yitie';
  pkg.build.files = [
    'main.js', 'store.js', 'mini.js', 'preload.js',
    'mini-preload.js', 'mini.html', 'page/**/*',
    'assets/icon.png', 'assets/tray.png',
    'assets/tray22.png', 'assets/tray32.png', 'assets/tray64.png'
  ];
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log('  electron/package.json：改 ' + pkg.productName + ' / ' + pkg.author.name);
}

/* ---------------- 兜底检查 ---------------- */
const tpl = fs.readFileSync(path.join(ROOT, 'src', 'template.html'), 'utf8');
if (tpl.indexOf('Open作业贴') < 0) problems.push('template.html 里没有「Open作业贴」');
if (tpl.indexOf('HidaTerm') >= 0) problems.push('template.html 里还有旧的版权署名 HidaTerm');

const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
if (main.indexOf('gitee.com') >= 0) problems.push('main.js 里还有 gitee 更新源');

if (problems.length) {
  console.error('\n✗ 有 ' + problems.length + ' 个问题：');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}
console.log('\n✓ 改名与版权信息已更新（共 ' + changed + ' 处）');
