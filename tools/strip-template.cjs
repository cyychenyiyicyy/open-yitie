/* ============================================================================
 * strip-template.cjs —— 从 src/template.html 里挖掉语音 / AI / 云同步的痕迹
 *
 * 分三类：
 *   ① CSS 规则（voice-* / ai-* / card-m3 / list-m3 / btn-row / set-nav__divider）
 *   ② DOM 节点（AI 添加按钮、scrimAi 整个弹窗、旧的「AI 识别」页签残留）
 *   ③ 文案（「云与 AI」等）
 *
 * 做法同样是**按标记块删**，删不掉就报错退出。
 * 用法：node tools/strip-template.cjs
 * 退出码：0 = 成功；1 = 有块没删干净
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TPL = path.join(ROOT, 'src', 'template.html');

let src = fs.readFileSync(TPL, 'utf8');
const CRLF = src.indexOf('\r\n') >= 0;
src = src.replace(/\r\n/g, '\n');
const problems = [];

/* cut(from, to, label, keepEnd)
 *   从 from 开始删，删到 to 结束。
 *   keepEnd = true 时**保留** to 那一段（默认删掉）。
 *   ⚠️ 这个区别很要紧：删掉终点标记会把下一个元素的开标签一起吃掉
 *      （例如把 <div id="scrimHw"> 吃掉 ⇒ 后面整个弹窗挂掉）。 */
function cut(from, to, label, keepEnd) {
  const i = src.indexOf(from);
  if (i < 0) { problems.push('找不到起点：' + label); return; }
  const j = src.indexOf(to, i);
  if (j < 0) { problems.push('找不到终点：' + label); return; }
  const n = src.length;
  src = src.slice(0, i) + (keepEnd ? src.slice(j) : src.slice(j + to.length));
  console.log('  删 ' + label + '：' + (n - src.length) + ' 字符');
}
function cutExact(block, label) {
  const i = src.indexOf(block);
  if (i < 0) { problems.push('找不到代码块：' + label); return; }
  src = src.slice(0, i) + src.slice(i + block.length);
  console.log('  删 ' + label + '：' + block.length + ' 字符');
}
function replaceExact(block, repl, label) {
  const i = src.indexOf(block);
  if (i < 0) { problems.push('找不到代码块：' + label); return; }
  src = src.slice(0, i) + repl + src.slice(i + block.length);
  console.log('  改 ' + label + '：' + block.length + ' → ' + repl.length + ' 字符');
}

/* ========================================================================
 * 1. CSS：语音输入
 *    ⚠️ 终点标记（.beta 胶囊那段）**要保留** ——
 *       .beta 样式还被「卡片背景（Beta）」胶囊用着。
 * ======================================================================== */
cut(
`/* ---------- 语音输入 ----------`,
`/* Beta 胶囊：MD3 assist chip 的样子，小而克制 */`,
  'CSS：语音输入', true);

/* ========================================================================
 * 2. CSS：AI 识别面板 + AI 添加弹窗
 * ======================================================================== */
cut(
`/* ---------- AI 识别面板 ---------- */`,
`/* ---------- 6.9 空状态首页（没有作业时） ----------`,
  'CSS：AI 识别面板 + AI 添加弹窗', true);

/* ========================================================================
 * 3. CSS：「云与 AI」页（MD3 card / list item）
 *    这套样式**只有**「云与 AI」面板在用 ⇒ 整块删。
 *    ⚠️ .btn-row / .card-m3 / .list-m3 在别处没有引用（app.js 里
 *       buildCloudAiPanel 已删）⇒ 可以整块删。
 *    ⚠️ 终点标记（.set-subject__hint）**要保留**。
 * ======================================================================== */
cut(
`/* ---------- 「云与 AI」页（MD3 规范） ----------`,
`.set-subject__hint{`,
  'CSS：「云与 AI」页', true);

/* ========================================================================
 * 4. DOM：AI 添加入口按钮（选择科目弹窗左下角）
 * ======================================================================== */
cutExact(
`      <!-- AI 添加（Beta）：说一段话，AI 整理成一条条作业 -->
      <button class="btn btn--tonal ai-add-btn" id="btnAiAdd2" type="button">
        <svg viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5-3c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>
        <span>AI 添加</span>
        <span class="beta">Beta</span>
      </button>
`,
  'DOM：AI 添加入口按钮');

/* ========================================================================
 * 5. DOM：整个 scrimAi 弹窗
 *
 * ⚠️ 终点标记是 `<div class="scrim" id="scrimHw">`（**含**）——
 *    写成"到它之前"会把 scrimHw 的开标签吃掉 ⇒ 后面整个弹窗挂掉
 *    （2026-10-23 踩过：静态检查报「关键 DOM 节点齐全 — 缺：scrimHw」）。
 * ======================================================================== */
cut(
`<!-- AI 添加（Beta）：从「选择科目」弹窗左下角进入 -->
<div class="scrim" id="scrimAi">`,
`<div class="scrim" id="scrimHw">`,
  'DOM：AI 添加弹窗（scrimAi）', true);

/* ========================================================================
 * 6. DOM：旧的「AI 识别」页签残留（只是个空注释块）
 * ======================================================================== */
cutExact(
`          <!-- ============ AI 识别 ============
               说一整段话 → AI 拆成一条条作业 → 逐条确认 → 一起添加。 -->
          
`,
  'DOM：旧「AI 识别」页签残留');

/* ========================================================================
 * 7. CSS：.set-nav__divider（只为「云与 AI」导航项画的分割线）
 * ======================================================================== */
cutExact(
`/* 导航里的全局项（云同步）与科目之间加一条分隔线 */
.set-nav__divider{
  flex:none;height:1px;margin:.5rem .75rem;
  background:var(--md-sys-color-outline-variant);
}
`,
  'CSS：.set-nav__divider');

/* ========================================================================
 * 8. 兜底检查
 * ======================================================================== */
const MUST_BE_GONE = [
  'voice-row', 'voice-hint', 'voice-btn', 'voicepulse', 'is-rec',
  'ai-status', 'ai-result', 'ai-body', 'ai-add-btn', 'ai-rec', 'ai-mic',
  'ai-busy', 'ai-spinner', 'ai-raw', 'ai-item', 'dialog--ai',
  'card-m3', 'list-m3', 'btn-row', 'set-nav__divider',
  'scrimAi', 'btnAiAdd2', 'btnAiRec', 'aiBusy', 'aiList', 'aiRaw',
  'btnAiParse', 'btnAiAdd', 'aiDlgTitle', 'aiDlgSub', 'aiRecArea',
  'aiRecTxt', 'aiBusyTxt', 'aiRawWrap', 'AI 添加', 'AI 识别'
];
const codeOnly = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');
const left = MUST_BE_GONE.filter(n => codeOnly.indexOf(n) >= 0);
if (left.length) problems.push('还残留：' + left.join(', '));

/* 外链检查：模板里不该有 http(s) 外链 */
const links = src.match(/(?:src|href)\s*=\s*["']?https?:/gi);
if (links) problems.push('模板里有外链：' + links.length + ' 处');

/* ======================================================================== */
if (problems.length) {
  console.error('\n✗ 有 ' + problems.length + ' 个问题：');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}

fs.writeFileSync(TPL, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('\n✓ template.html 已改成纯离线版，' + src.length + ' 字符');
