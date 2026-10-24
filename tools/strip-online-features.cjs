/* ============================================================================
 * strip-online-features.cjs —— 把「作业贴」改成**纯离线**的 Open作业贴
 *
 * 一次性、幂等地从 src/app.js 里挖掉三类功能：
 *   ① 语音输入（voice* / mountVoice* / pcmToWav / AudioWorklet 那一套）
 *   ② AI（aiCfg / aiChat / aiSpeech / aiTts / AI 添加弹窗那一套）
 *   ③ 云同步（sync* / Gitee 推拉 / mergeRemote / 导入配置那一套）
 *
 * 做法：按**标记块**删（每块用一对注释或一段明确起止的代码），
 *      不做正则大扫除 —— 大扫除会把别的函数体里的同名字段也切掉。
 *      每个块都带边界标记，删不掉就报错退出（fail loud）。
 *
 * 用法：node tools/strip-online-features.cjs
 * 退出码：0 = 成功；1 = 有块没删干净
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'app.js');

let src = fs.readFileSync(APP, 'utf8');
/* ⚠️ 源文件是 CRLF 行尾。这里**统一转成 LF**再干活，
 *    否则下面用模板字符串写的标记（\n）对不上源文件（\r\n），
 *    一个都匹配不上 —— 2026-10-23 踩过。
 *    写回时再转回 CRLF，保持仓库里其它文件一致。 */
const CRLF = src.indexOf('\r\n') >= 0;
src = src.replace(/\r\n/g, '\n');
const problems = [];

/* ---------- 删一段：从 fromMarker 到 toMarker（含两端）
 *
 * keepEnd = true 时**保留** toMarker 那一段（默认删掉）。
 * ⚠️ 这个区别很要紧：把下一个元素的**开标签/函数头**当成终点删掉，
 *    后面那一整块就挂掉了。
 *    2026-10-23 踩过两次：
 *      ① 终点用 `function loadDB() {` ⇒ loadDB 的函数头被吃掉 ⇒ 语法错误
 *      ② 终点用 `<div id="scrimHw">` ⇒ 那个弹窗的开标签被吃掉 ⇒ 白屏
 */
function cut(fromMarker, toMarker, label, keepEnd) {
  const i = src.indexOf(fromMarker);
  if (i < 0) { problems.push('找不到起点标记：' + label + ' → ' + fromMarker.slice(0, 60)); return; }
  const j = src.indexOf(toMarker, i);
  if (j < 0) { problems.push('找不到终点标记：' + label + ' → ' + toMarker.slice(0, 60)); return; }
  const before = src.length;
  src = src.slice(0, i) + (keepEnd ? src.slice(j) : src.slice(j + toMarker.length));
  const removed = before - src.length;
  console.log('  删 ' + label + '：' + removed + ' 字符');
}

/* ---------- 删一段：从 fromMarker 起，到 toMarker 之前（不含 toMarker） ---------- */
function cutBefore(fromMarker, toMarker, label) {
  const i = src.indexOf(fromMarker);
  if (i < 0) { problems.push('找不到起点标记：' + label); return; }
  const j = src.indexOf(toMarker, i);
  if (j < 0) { problems.push('找不到终点标记：' + label); return; }
  const before = src.length;
  src = src.slice(0, i) + src.slice(j);
  const removed = before - src.length;
  console.log('  删 ' + label + '：' + removed + ' 字符');
}

/* ---------- 删一段精确的代码块（整段文本必须逐字匹配） ---------- */
function cutExact(block, label) {
  const i = src.indexOf(block);
  if (i < 0) { problems.push('找不到代码块：' + label); return; }
  src = src.slice(0, i) + src.slice(i + block.length);
  console.log('  删 ' + label + '：' + block.length + ' 字符');
}

/* ---------- 替换一段精确的代码块 ---------- */
function replaceExact(block, repl, label) {
  const i = src.indexOf(block);
  if (i < 0) { problems.push('找不到代码块：' + label); return; }
  src = src.slice(0, i) + repl + src.slice(i + block.length);
  console.log('  改 ' + label + '：' + block.length + ' → ' + repl.length + ' 字符');
}

/* ========================================================================
 * 1. DB 结构：去掉 sync 与 ai 两段
 * ======================================================================== */
cutExact(
`    /* 云同步配置。放在 DB 里跟数据一起落 data.json，
       但导出备份时会剥掉，避免 token 随备份外泄。 */
    sync: {
      on: 0,
      owner: '',
      repo: '',
      branch: 'master',
      token: '',
      path: 'sync/data.b64',
      lastAt: 0,
      lastMsg: ''
    }
`,
  'blankDB 里的 sync 配置');

cutExact(
`  /* AI 配置（MiniMax 等）：**只存在本机**。
   * ⚠️ 这个字段绝对不能进云同步 —— 上传的数据里必须剥掉它。
   *    云同步那块见 stripSecrets()：owner/repo/token + ai.key 都会被剥掉。 */
  var ai = isPlainObject(db.ai) ? db.ai : {};
  out.ai = {
    provider: toStr(ai.provider) || 'minimax',
    key: toStr(ai.key),
    model: toStr(ai.model) || 'MiniMax-M3.1-Flash',
    base: toStr(ai.base) || 'https://api.minimaxi.com',
    /* 语音识别开关：默认关（要额外权限/流量，老师明确才开） */
    speech: ai.speech ? 1 : 0
  };

`,
  'sanitizeDB 里的 ai 配置');

/* ========================================================================
 * 2. 云同步 + AI 主体 + 「云与 AI」设置面板
 *    （这两块是连续的：云同步实现 → 导入配置 → buildCloudAiPanel → 小按钮工厂）
 *
 * ⚠️ 顺序很重要：先删这一整大段，剩下的「小按钮工厂」就只剩
 *    makeFilledBtn/makeTonalBtn/makeTextBtn 三个通用按钮 ——
 *    它们在别处也有用，不能一起删掉。
 *    而 makeImportConfigBtn（导入配置）只服务于云同步/AI ⇒ 要单独删。
 * ======================================================================== */
cut(
`/* ============================================================================
 * 云同步（Gitee）`,
`/* 几个小按钮工厂（保持 MD3 层级：filled > tonal > text） */`,
  '云同步 + AI 全部实现 + 「云与 AI」设置面板', true);

/* 只服务于云同步/AI 的「导入配置」按钮 —— 删掉它，
   保留通用的 filled / tonal / text 三个按钮工厂。
   ⚠️ 终点标记 `function loadDB() {` **要保留** ——
      删掉的话 loadDB 就没了函数头 ⇒ 语法错误（2026-10-23 踩过）。 */
cut(
`/* 导入配置（云同步 + AI 同一个文件） */
function makeImportConfigBtn() {`,
`function loadDB() {`,
  'makeImportConfigBtn（导入配置按钮）', true);

/* ========================================================================
 * 4. 语音输入整段
 *    ⚠️ 终点标记（收集作业数据）**要保留**。
 * ======================================================================== */
cut(
`/* ---------- 语音输入 ----------`,
`/* ---------- 收集作业数据 ---------- */`,
  '语音输入模块', true);

/* ========================================================================
 * 5. AI 添加（Beta）整段
 *
 * ⚠️ 终点标记必须落在 bindAiPanel() 结束之后、boot() 之前 ——
 *    原来用「小窗模式」当终点，那太远了，会把 boot() 一起吃掉。
 * ⚠️ 终点标记**要保留**（boot() 前面的那段注释还要用）。
 * ======================================================================== */
cut(
`/* ============================================================================
 * AI 添加（Beta）—— 独立弹窗流程`,
`/* ⚠️ 原来的 hookAiVoice()（重赋值 voiceStop 来挂钩）**已删除** ——`,
  'AI 添加弹窗', true);

/* 5b. hookAiVoice 那段说明注释（已经没用了）—— 连同它上面那行一起删。 */
replaceExact(
`/* ⚠️ 原来的 hookAiVoice()（重赋值 voiceStop 来挂钩）**已删除** ——
 *   ① 它从来没被调用过（纯死代码）；
 *   ② 它做的"重赋值函数声明"在 ES5 严格模式下是**非法**的；
 *   ③ 现在的做法是语音模块自带的 voiceState.onDone 回调，更干净。 */

function boot() {`,
`function boot() {`,
  'hookAiVoice 的说明注释');
/* ========================================================================
 * 6. 逐个修剩下的调用点
 * ======================================================================== */

/* 6.1 saveDB 里的 syncMiniIfOpen —— **保留**（那是小窗刷新，跟云同步无关）。
     只把它前后的自动同步调度去掉（见 6.1b）。 */

/* 6.1b 自动同步调度 —— 纯离线版没有云端，删掉 */
replaceExact(
`    /* 数据变了 → 排队等 5 分钟自动同步（防抖，期间再改会重置） */
    try { if (typeof scheduleAutoSync === 'function') scheduleAutoSync(); } catch (e) {}

    /* 顺带刷新左下角状态条（同步时间可能变了） */`,
`    /* 顺带刷新左下角状态条 */`,
  'saveDB 里的自动同步调度');

/* 6.2 导出备份：不再有 sync / ai 要剥 */
replaceExact(
`  /* 导出前剥掉 sync 配置和 ai 配置：
     token 和 MiniMax 的 API key 绝不能随备份文件外流。 */
  var backup = JSON.parse(JSON.stringify(DB));
  delete backup.sync;
  delete backup.ai;
  download('作业数据-' + todayKey() + '.json', JSON.stringify(backup, null, 2));
  toast('已导出 JSON 备份文件（不含同步密钥和 AI 密钥）');`,
`  /* 纯离线版：备份里就是全部作业数据，没有任何密钥需要剥离。 */
  var backup = JSON.parse(JSON.stringify(DB));
  download('作业数据-' + todayKey() + '.json', JSON.stringify(backup, null, 2));
  toast('已导出 JSON 备份文件');`,
  '导出备份逻辑');

/* 6.3 设置页导航里的「云与 AI」入口 —— 整块删。
     ⚠️ 终点标记（`/* ---------- 右栏详情 ---------- *\/`）**要保留** ——
        那是右栏详情的开头标记，6.4 还要用它定位。 */
cut(
`  /* 导航底部：全局项（不属于任何科目） */
  var divider = el('div', 'set-nav__divider');
  nav.appendChild(divider);

  var syncItem = el('button', 'set-nav__item' + (state.setPane === 'sync' ? ' is-global' : ''));`,
`/* ---------- 右栏详情 ---------- */`,
  '设置页「云与 AI」导航入口', true);

/* 6.4 设置页「云与 AI」内容面板 —— 整块删。
     ⚠️ 起点是 `var isSyncPane = ...` **不是** `var body = ...` ——
        `var body` / `var detail` 是**右栏详情自己要用的**，
        一起删掉的话后面 `detail.querySelector(...)` 会 ReferenceError
        ⇒ 设置页整个打不开（2026-10-23 踩过：验收报「设置页打开并选中语文=false」）。 */
cut(
`  var isSyncPane = (state.setPane === 'sync');`,
`  var sub = SUBJECT_MAP[cur];`,
  '设置页「云与 AI」内容面板', true);

/* 6.5 状态条里的「同步时间」—— 改成纯本地的说法 */
replaceExact(
`  var c = null;
  try { c = syncCfg(); } catch (e) {}

  if (c && c.token) {
    if (c.lastAt) {
      var d = new Date(c.lastAt);
      var today = new Date();
      var sameDay = d.toDateString() === today.toDateString();
      var when = sameDay
        ? String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
        : (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
          String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      elTxt.textContent = '同步 ' + when;
    } else {
      elTxt.textContent = '同步：还没传过';
    }
  } else {
    elTxt.textContent = '同步未配置';
  }`,
`  /* 纯离线版：没有云端可同步，只说明数据存在本机。 */
  elTxt.textContent = '数据存在本机 · 离线可用';`,
  '左下角状态条');

/* 6.6 boot() 里挂语音 / AI 面板的调用 */
replaceExact(
`  bindVoice();
  bindAiPanel();`,
`  /* 纯离线版：没有语音输入、没有 AI 面板，这里什么都不用挂。 */`,
  'boot() 里的 bindVoice()/bindAiPanel()');

/* 6.7 关闭 AI 弹窗时的语音清理（SCRIM_CLOSE_HOOK.scrimAi） */
replaceExact(
`/* 各个弹窗自己的关闭动作（有些弹窗关了还要做别的收尾） */
var SCRIM_CLOSE_HOOK = {
  scrimAi: function () {
    voiceCleanup();
    voiceState.onDone = null;    /* 别让旧回调串到下一次录音 */
    voiceState.busy = false;
    voiceState.starting = false;
    aiDlg.recording = false;
  }
};`,
`/* 各个弹窗自己的关闭动作（有些弹窗关了还要做别的收尾）
 * 纯离线版：没有「AI 添加」弹窗，也没有录音要收尾 —— 这里留空表。 */
var SCRIM_CLOSE_HOOK = {};`,
  'SCRIM_CLOSE_HOOK（AI 弹窗收尾）');

/* 6.8 挂载语音按钮的两处调用 */
src = src.replace(/^[ \t]*mountVoiceButtons\(\);[ \t]*\r?\n/gm, '');
console.log('  删 mountVoiceButtons() 调用若干处');

/* 6.9 测试钩子：去掉语音 / AI / 云同步相关的导出 */
const HOOKS_FROM = `  /* 这几个是给无头验收脚本用的钩子（验证密钥不外泄）。
   * 平时没人调，也不影响正常流程。 */
  importSyncConfig: importSyncConfig,`;
const HOOKS_TO = `  listOf: listOf, dayOf: dayOf, countAll: countAll, accentRGB: accentRGB,`;
cut(HOOKS_FROM, HOOKS_TO, '测试钩子里的云/AI/语音导出', true);

/* ========================================================================
 * 7. 全局兜底：检查有没有漏网的函数名
 * ======================================================================== */
const MUST_BE_GONE = [
  'syncCfg', 'syncReady', 'syncPayload', 'syncUpload', 'syncUploadAuto',
  'syncDownload', 'syncHash', 'scheduleAutoSync', 'mergeRemote',
  'importSyncConfig', 'buildCloudAiPanel', 'makeImportConfigBtn',
  'aiCfg', 'aiBase', 'aiReady', 'aiChat', 'aiSpeech', 'aiTts',
  'voiceStart', 'voiceStop', 'voiceToggle', 'voiceState', 'voiceTarget',
  'voiceSupported', 'voiceSetHint', 'voiceCleanup', 'mountVoiceButton',
  'mountVoiceButtons', 'bindVoice', 'syncVoiceUI', 'pcmToWav',
  'aiParseHomework', 'renderAiResult', 'addAiItems', 'openAiDialog',
  'closeAiDialog', 'bindAiPanel', 'extractJson', 'AI_PANEL_PROMPT',
  'aiDlg', 'withTimeout', 'b64encodeUtf8', 'b64decodeUtf8'
];
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')
  .replace(/'(\\.|[^'\\])*'/g, "''")
  .replace(/"(\\.|[^"\\])*"/g, '""');
const leftovers = MUST_BE_GONE.filter(n => new RegExp('\\b' + n + '\\b').test(codeOnly));
if (leftovers.length) {
  problems.push('代码里还有这些名字：' + leftovers.join(', '));
}

/* 网络出口检查：页面里不该再有 fetch / XMLHttpRequest */
if (/[^.\w]fetch\s*\(/.test(codeOnly)) problems.push('代码里还有 fetch()');
if (/XMLHttpRequest/.test(codeOnly)) problems.push('代码里还有 XMLHttpRequest');
if (/WebSocket/.test(codeOnly)) problems.push('代码里还有 WebSocket');
if (/EventSource/.test(codeOnly)) problems.push('代码里还有 EventSource');

/* ======================================================================== */
if (problems.length) {
  console.error('\n✗ 有 ' + problems.length + ' 个问题：');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}

fs.writeFileSync(APP, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('\n✓ app.js 已改成纯离线版，' + src.length + ' 字符');
