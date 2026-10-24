/* ============================================================================
 * adapt-verify-wizard.cjs —— 把上游的 verify-wizard.cjs 改成**离线版**的验收台
 *
 * 要改的：
 *   ① 被测文件：classboard.html → open-yitie.html
 *   ② 删掉 4 个测「已移除功能」的场景：
 *      ai-key-safety / voice-buttons / cloud-ai-panel / ai-tab
 *   ③ 加 1 个**离线专有**场景：offline-purity
 *      —— 断言页面上确实没有云同步 / AI / 语音的入口与残留
 *
 * 用法：node tools/adapt-verify-wizard.cjs
 * 退出码：0 = 成功；1 = 有块没改到
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const F = path.join(__dirname, 'verify-wizard.cjs');
let src = fs.readFileSync(F, 'utf8');
const CRLF = src.indexOf('\r\n') >= 0;
src = src.replace(/\r\n/g, '\n');
const problems = [];

function replaceExact(from, to, label) {
  const i = src.indexOf(from);
  if (i < 0) {
    if (src.indexOf(to) >= 0) { console.log('  （已改过，跳过）' + label); return; }
    problems.push('找不到：' + label);
    return;
  }
  src = src.slice(0, i) + to + src.slice(i + from.length);
  console.log('  改 ' + label);
}
function cutExact(block, label) {
  const i = src.indexOf(block);
  if (i < 0) { problems.push('找不到：' + label); return; }
  src = src.slice(0, i) + src.slice(i + block.length);
  console.log('  删 ' + label);
}

/* ① 被测文件 */
replaceExact(
"const APP = path.join(ROOT, 'classboard.html');",
"const APP = path.join(ROOT, 'open-yitie.html');",
'被测文件路径');
replaceExact(
" *   - 子进程输出**绝不能用管道捕获**",
" *   - 子进程输出**绝不能用管道捕获**",
'（占位，不改）');

/* ② 删掉测「已移除功能」的 4 个场景 */
const SCEN_AI_KEY = `    { name: 'ai-key-safety', group: '7 AI 密钥不外泄', purpose: '云同步内容 / 导出备份里都不能出现 AI 密钥（本机必须有）', act: actAiKeySafety, budget: 30000 },
`;
const SCEN_VOICE = `    { name: 'voice-buttons', group: '8 语音输入按钮', purpose: '每一个文本输入框旁边都有麦克风，且识别结果填进它自己', act: actVoiceButtons, budget: 40000 },
`;
const SCEN_PANEL = `    { name: 'cloud-ai-panel', group: '10 云与 AI 设置页', purpose: 'MD3 风格：一张卡 + 三个 list item + switch；描述文字要少；标题叫「云与 AI」', act: actCloudAiPanel, budget: 40000 },
`;
const SCEN_TAB = `    { name: 'ai-tab', group: '11 AI 添加弹窗', purpose: '入口在「选择科目」弹窗左下角带 BETA；录音→处理→直接列出可编辑条目', act: actAiTab, budget: 40000 }
`;
cutExact(SCEN_AI_KEY, '场景：AI 密钥不外泄');
cutExact(SCEN_VOICE, '场景：语音输入按钮');
cutExact(SCEN_PANEL, '场景：云与 AI 设置页');
/* 最后一个场景行（ai-tab）没有逗号 ⇒ 先把它删掉，
   再把离线场景加在 empty-state 之后（这时它就是最后一行，也不要逗号）。 */
cutExact(SCEN_TAB, '场景：AI 添加弹窗');
replaceExact(
`    { name: 'empty-state', group: '9 空状态首页', purpose: '没有作业时显示 logo+渐变 hero 与 9 科入口；有了作业就恢复卡片', act: actEmptyStatePage, budget: 40000 },
`,
`    { name: 'empty-state', group: '9 空状态首页', purpose: '没有作业时显示 logo+渐变 hero 与 9 科入口；有了作业就恢复卡片', act: actEmptyStatePage, budget: 40000 },
    { name: 'offline-purity', group: '12 离线纯净度', purpose: '页面上没有云同步 / AI / 语音的入口与残留；联网 API 一个都没有', act: actOfflinePurity, budget: 30000 }
`,
'场景：加离线纯净度');

/* ③ 加离线纯净度场景的驱动函数 */
const ANCHOR = `/* 场景 7：AI 密钥**绝不能**外泄`;
const OFFLINE_FN = `/* 场景 12：离线纯净度 —— 这个版本的**核心承诺**
 *
 * 要断言的东西：
 *   ① 页面上没有云同步 / AI / 语音的入口（DOM 层面）
 *   ② 设置页里没有「云与 AI」那个导航项
 *   ③ 代码里没有 fetch / XMLHttpRequest / WebSocket
 *   ④ 代码里没有云同步 / AI / 语音的函数
 *
 * ⚠️ 前三条**必须**用真实 DOM 造出来 —— 光查源码不够：
 *    「按钮不存在」和「按钮存在但被藏起来」是两回事，
 *    后者说明功能还在，只是没露出来。
 */
function actOfflinePurity() {
  /* ⚠️ V 是**每个场景自己的**局部变量（window.__V），
   *    不是全局的 —— 不取它就是 "V is not defined"（2026-10-23 踩过）。
   * ⚠️ 必须用 V.tick() / V.finish() 收尾 —— 直接用 setTimeout
   *    的话外层驱动脚本等不到结束，场景被判「未跑完」。 */
  var V = window.__V, CB = window.__classboard;

  /* ① 页面里不该有的 DOM id（AI 添加弹窗那一整套） */
  var mustNotExist = [
    'scrimAi', 'btnAiAdd2', 'btnAiRec', 'aiBusy', 'aiList', 'aiRaw',
    'aiRawWrap', 'aiRecArea', 'aiRecTxt', 'aiBusyTxt', 'aiResult',
    'btnAiParse', 'btnAiAdd', 'aiDlgTitle', 'aiDlgSub'
  ];
  var found = [];
  for (var i = 0; i < mustNotExist.length; i++) {
    if (document.getElementById(mustNotExist[i])) found.push(mustNotExist[i]);
  }
  V.rec('o1.no_ai_dom', found.length === 0,
    '不该存在的 AI 元素：' + (found.length ? found.join(', ') : '（无）'));

  /* ② 界面上不能出现「AI 添加」「云与 AI」这类入口文案 */
  var bodyText = (document.body && document.body.innerText) || '';
  V.rec('o2.no_ai_text', bodyText.indexOf('AI 添加') < 0 && bodyText.indexOf('云与 AI') < 0,
    '界面文案里不该有「AI 添加」/「云与 AI」');

  /* ③ 代码里不能有联网 API */
  var code = '';
  try { code = CB.getSource() || ''; } catch (e) {}
  var noComment = code
    .replace(/\\/\\*[\\s\\S]*?\\*\\//g, '')
    .replace(/^[ \\t]*\\/\\/.*$/gm, '');
  V.rec('o4.no_fetch', !/[^.\\w]fetch\\s*\\(/.test(noComment),
    '代码里有 fetch()=' + /[^.\\w]fetch\\s*\\(/.test(noComment));
  var hasNet = /XMLHttpRequest/.test(noComment) || /WebSocket/.test(noComment) ||
               /EventSource/.test(noComment);
  V.rec('o5.no_xhr', !hasNet,
    '代码里有 XHR/WebSocket/EventSource=' + hasNet);

  /* ④ 也不能有云同步 / AI / 语音的函数名 */
  var banned = /\\b(?:syncUpload|syncDownload|syncPayload|syncCfg|aiChat|aiSpeech|aiTts|aiCfg|aiReady|voiceStart|voiceStop|mountVoiceButtons|bindVoice|aiParseHomework|openAiDialog)\\b/;
  V.rec('o6.no_banned_fns', !banned.test(noComment),
    '代码里有已移除功能的函数=' + banned.test(noComment));

  /* ⑤ 也不能有任何指向第三方的域名 */
  var hosts = ['api.minimaxi.com', 'gitee.com', 'api.github.com', 'openai.com',
    'generativelanguage.googleapis.com'];
  var hitHost = '';
  for (var h = 0; h < hosts.length; h++) {
    if (code.indexOf(hosts[h]) >= 0) { hitHost = hosts[h]; break; }
  }
  V.rec('o7.no_third_party_host', !hitHost,
    '代码里有第三方域名=' + (hitHost || '（无）'));

  /* ⑥ 设置页里不该有「云与 AI」导航项 —— 要**真的打开设置页**才查得准，
   *    光看源码不够（导航项是运行时拼出来的）。 */
  V.openSettings('语文', function (ok) {
    V.rec('o3.open_settings', ok, '设置页能打开=' + ok);
    var navHasCloud = false;
    if (ok) {
      var nav = document.getElementById('setNav');
      var items = nav ? nav.querySelectorAll('.set-nav__item') : [];
      for (var k = 0; k < items.length; k++) {
        if ((items[k].textContent || '').indexOf('云与 AI') >= 0) navHasCloud = true;
      }
    }
    V.rec('o3b.no_cloud_nav', !navHasCloud,
      '设置页导航里有「云与 AI」=' + navHasCloud);

    /* 收尾：关掉设置弹窗，再结束场景 */
    V.tick(120, function () {
      var scrimSet = document.getElementById('scrimSettings');
      if (scrimSet && !scrimSet.hidden) {
        var closeBtn = scrimSet.querySelector('[data-close]');
        if (closeBtn) closeBtn.click();
      }
      V.badge('verify · offline-purity');
      V.finish({});
    });
  });
}

`;
const ai = src.indexOf(ANCHOR);
if (ai < 0) { problems.push('找不到场景 7 的位置（插入离线场景的锚点）'); }
else {
  src = src.slice(0, ai) + OFFLINE_FN + src.slice(ai);
  console.log('  加 场景：离线纯净度');
}

/* ④ 顺手把「去掉语音 / AI 后」的旧注释清理一下 */
replaceExact(
" * verify-wizard.cjs —— 「作业贴」分步向导端到端验收测试台",
" * verify-wizard.cjs —— 「Open作业贴」端到端验收测试台",
'文件头');

if (problems.length) {
  console.error('\n✗ 有 ' + problems.length + ' 个问题：');
  problems.forEach(p => console.error('  · ' + p));
  process.exit(1);
}

fs.writeFileSync(F, CRLF ? src.replace(/\n/g, '\r\n') : src, 'utf8');
console.log('\n✓ verify-wizard.cjs 已改成离线版验收台');
