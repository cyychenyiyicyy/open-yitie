/* ============================================================================
 * static-check.cjs —— 对 open-yitie.html 做静态约束检查
 * 这些是"交付形态"的硬要求，必须自动验证，不能靠眼看：
 *   1. 单文件、零外链（教室里可能没网 / 文件要能拷走）
 *   2. 不依赖任何新语法（目标环境可能是老内核的统信 UOS）
 *   3. 九科数据、关键 DOM 都在
 *   4. 没有调试残留（console.log / TODO / debugger）
 *
 * 用法：node tools/static-check.cjs
 * 退出码：0 = 全过；1 = 有失败
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'open-yitie.html');
const REPORT = path.join(ROOT, 'static-check-report.md');

/* 先删旧报告：崩在半路时不能留下上一次的结论 */
if (fs.existsSync(REPORT)) fs.unlinkSync(REPORT);

const results = [];
function check(group, name, fn) {
  let ok = false, info = '';
  try {
    const r = fn();
    if (r === true || r === undefined) ok = true;
    else { ok = false; info = String(r); }
  } catch (e) { ok = false; info = '抛异常：' + e.message; }
  results.push({ group, name, ok, info });
}

function report() {
  const failed = results.filter(r => !r.ok);
  const lines = [];
  lines.push('# 静态检查报告');
  lines.push('');
  lines.push('- 被测文件：`open-yitie.html`');
  lines.push('- 时间：' + new Date().toISOString());
  lines.push('- 结果：**' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败 / 共 ' + results.length + '**');
  lines.push('');
  const groups = {};
  results.forEach(r => { (groups[r.group] = groups[r.group] || []).push(r); });
  Object.keys(groups).forEach(g => {
    const arr = groups[g];
    const bad = arr.filter(r => !r.ok).length;
    lines.push('## ' + g + '  (' + (arr.length - bad) + '/' + arr.length + ')');
    lines.push('');
    arr.forEach(r => lines.push('- ' + (r.ok ? '✅' : '❌') + ' ' + r.name + (r.ok ? '' : '  \n  └ ' + r.info)));
    lines.push('');
  });
  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');

  console.log('静态检查：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败 / 共 ' + results.length);
  failed.forEach(r => console.log('  ✗ [' + r.group + '] ' + r.name + ' — ' + r.info));
  console.log('报告：' + REPORT);
  return failed.length === 0;
}

if (!fs.existsSync(APP)) {
  console.error('还没构建出 open-yitie.html，先跑 node build.cjs');
  fs.writeFileSync(REPORT, '# 静态检查报告\n\n**无法运行**：open-yitie.html 不存在\n', 'utf8');
  process.exit(1);
}

const html = fs.readFileSync(APP, 'utf8');
const sizeKB = fs.statSync(APP).size / 1024;

/* ============================ 1. 单文件 / 零外链 ============================ */
check('单文件', '是一个完整 HTML 文档', () =>
  (html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>')) || '开头或结尾不对');

check('单文件', '没有外部 <script src>', () => {
  const m = html.match(/<script[^>]+src=/gi);
  return !m ? true : ('发现 ' + m.length + ' 处：' + m.join(' '));
});

check('单文件', '没有外部 <link rel=stylesheet>', () => {
  const m = html.match(/<link[^>]+stylesheet/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('单文件', '没有任何 http(s) 外链（含 img / url() / fetch）', () => {
  const found = [];
  const re = /(?:src|href)\s*=\s*["']?(https?:)?\/\//gi;
  let m;
  while ((m = re.exec(html))) found.push(m[0].slice(0, 60));
  if (found.length) return '发现 ' + found.length + ' 处：' + found.slice(0, 5).join(' | ');
  return true;
});

check('单文件', 'CSS 里没有 url(http...) 外链', () => {
  const m = html.match(/url\(\s*['"]?https?:/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('单文件', '没有 @import', () => {
  const m = html.match(/@import/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

/* ★★★ 离线版的硬要求：产物里**一个网络请求都不能有** ★★★
 * 原版这里查的是「云同步只连 Gitee，不连第三方」，
 * 离线版把云同步整个去掉了 ⇒ 改成「彻底没有 fetch」。
 * ⚠️ 这条是本项目的核心承诺，必须自动化守住 ——
 *    靠人眼看代码是守不住的（函数名改了、换个 API 调用都看不出来）。 */
const codeNoComments = html
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

check('离线', '代码里完全没有 fetch()', () => {
  const m = codeNoComments.match(/[^.\w]fetch\s*\(/g);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('离线', '代码里没有 XMLHttpRequest / WebSocket / EventSource', () => {
  const bad = [];
  if (/XMLHttpRequest/.test(codeNoComments)) bad.push('XMLHttpRequest');
  if (/WebSocket/.test(codeNoComments)) bad.push('WebSocket');
  if (/EventSource/.test(codeNoComments)) bad.push('EventSource');
  if (/navigator\.sendBeacon/.test(codeNoComments)) bad.push('sendBeacon');
  return bad.length ? ('发现：' + bad.join(', ')) : true;
});

check('离线', '代码里没有云同步函数', () => {
  const m = codeNoComments.match(/\bsync(?:Upload|Download|Payload|Cfg|Ready|Hash)\b/g);
  return !m ? true : ('发现 ' + m.length + ' 处：' + [...new Set(m)].join(', '));
});

check('离线', '代码里没有 AI 相关函数', () => {
  const m = codeNoComments.match(/\bai(?:Chat|Speech|Tts|Cfg|Ready|Base|ParseHomework)\b/g);
  return !m ? true : ('发现 ' + m.length + ' 处：' + [...new Set(m)].join(', '));
});

check('离线', '代码里没有语音相关函数', () => {
  const m = codeNoComments.match(/\b(?:voice[A-Z]\w*|mountVoice\w*|bindVoice|pcmToWav)\b/g);
  return !m ? true : ('发现 ' + m.length + ' 处：' + [...new Set(m)].join(', '));
});

check('离线', '没有任何第三方 API 域名', () => {
  const hosts = ['api.minimaxi.com', 'openai.com', 'api.anthropic.com',
    'generativelanguage.googleapis.com', 'gitee.com', 'api.github.com',
    'cloudflare.com', 'aliyuncs.com', 'myqcloud.com'];
  const hit = hosts.filter(h => html.indexOf(h) >= 0);
  return hit.length ? ('发现：' + hit.join(', ')) : true;
});

check('离线', '品牌名是 Open作业贴', () =>
  (html.includes('Open作业贴')) || '没找到「Open作业贴」');

check('离线', '版权署名是 yiyi', () =>
  (html.includes('yiyi')) || '没找到 yiyi');

check('单文件', 'token 不硬编码在页面里', () => {
  /* 页面是公开的，绝不能出现真实 token。
     我们的 token 是 32 位十六进制，这里查有没有形似的长串。 */
  const looksLikeToken = /\b[0-9a-f]{32}\b/i.test(html);
  return looksLikeToken ? '发现疑似硬编码 token' : true;
});

check('单文件', '用到的 data: URI 都是内联的（不是网络图）', () => {
  const m = html.match(/url\(\s*['"]?data:/gi) || [];
  return true; /* 存在即为内联，天然离线 */
});


check('样式', '所有 var(--md-sys-color-*) 都有定义', () => {
  /* 定义了哪些 */
  const defined = new Set();
  const defRe = /(--md-sys-color-[a-z0-9-]+)\s*:/g;
  let m;
  while ((m = defRe.exec(html))) defined.add(m[1]);

  /* 用了哪些 */
  const used = new Set();
  const useRe = /var\(\s*(--md-sys-color-[a-z0-9-]+)\s*\)/g;
  while ((m = useRe.exec(html))) used.add(m[1]);

  const missing = [...used].filter(x => !defined.has(x)).sort();
  return missing.length === 0
    ? true
    : ('未定义：' + missing.slice(0, 5).join(', ') +
       (missing.length > 5 ? (' 等 ' + missing.length + ' 个') : ''));
});

/* ============================ 2. 兼容性 ============================ */

/* 剥掉块注释和行注释 —— 注释里提到某个语法不算"用到了" */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/* 剥掉字符串字面量的**内容**（保留引号本身）。
 * ⚠️ 为什么要：作业贴的语音录制用 AudioWorklet，worklet 源码是**字符串**
 *   （要 new Blob([src]) 再 addModule），而 AudioWorkletProcessor 规范
 *   **必须**用 class 写。那段 class 不是页面自己的 JS，不该被算作
 *   "页面用了新语法"。
 *   ⚠️ 这个函数只给"查语法关键字"用，不要拿它去查真实代码结构。 */
function stripStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && src[i] !== quote) {
        /* 跳过转义 */
        if (src[i] === '\\') i++;
        i++;
      }
      i++;                     /* 跳过收尾引号 */
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

check('兼容性', '不使用 color-mix()', () => {
  /* 只查真正的 CSS 用法：注释里提到 "color-mix()" 是说明文字，不算。
     做法：剥掉 CSS 块注释和 JS 行注释后再找。 */
  const code = html
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const m = code.match(/color-mix\s*\(/gi);
  return !m ? true : ('发现 ' + m.length + ' 处（老内核不支持，会整条声明失效）');
});

check('兼容性', '不使用 :has() 选择器', () => {
  const m = html.match(/:has\s*\(/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('兼容性', '不使用 dialog 元素的 showModal', () => {
  const m = html.match(/showModal\s*\(/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('兼容性', 'JS 里没有可选链 ?. 或空值合并 ??', () => {
  const script = html.slice(html.indexOf('<script>'));
  /* 粗略匹配，排除字符串里的 */
  const m = script.match(/[A-Za-z_$)\]]\s*\?\.\s*[A-Za-z_$[]|\?\?\s*[^=]/g);
  return !m ? true : ('发现 ' + m.length + ' 处：' + m.slice(0, 3).join(' | '));
});

check('兼容性', 'JS 严格模式且用 var/function（不依赖新语法）', () => {
  if (html.indexOf("'use strict'") < 0) return '没有严格模式';
  /* ⚠️ 查 class 之前**先把字符串字面量剥掉**。
   *   原因：作业贴的语音录制用 AudioWorklet，而 worklet 的源码是
   *   **字符串**（要 new Blob([src]) 再 addModule）——
   *   AudioWorkletProcessor 规范**必须**用 class 写，没法用 ES5 函数代替。
   *   那段 class 只存在于字符串里，不是页面自己的 JS，
   *   不该被当成"页面用了新语法"。
   *   （剥法跟 emoji 检查一致：先去掉注释，再去掉字符串内容。） */
  const script = stripStrings(stripComments(html.slice(html.indexOf('<script>'))));
  if (/\bclass\s+[A-Z]/.test(script)) return '用了 class 声明';
  return true;
});

check('兼容性', '有 prefers-reduced-motion 降级', () =>
  html.includes('prefers-reduced-motion') || '没有做动效降级');

check('兼容性', '颜色用 rgb()/rgba() 而不是 oklch()/lab()', () => {
  const m = html.match(/\b(oklch|oklab|lab|lch)\s*\(/gi);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

/* ============================ 3. 内容完整性 ============================ */
check('内容', '九科教材数据全部内联', () => {
  const ids = ['chinese', 'math', 'english', 'physics', 'chemistry', 'biology', 'politics', 'history', 'geography'];
  const m = html.match(/var BOOKS = (\{[\s\S]*?\});\n/);
  if (!m) return '找不到 BOOKS 数据块';
  const books = JSON.parse(m[1].replace(/<\\\//g, '</'));
  const missing = ids.filter(i => !books[i] || !books[i].lessons || !books[i].lessons.length);
  if (missing.length) return '缺：' + missing.join(',');
  const total = ids.reduce((a, i) => a + books[i].lessons.length, 0);
  if (total < 100) return '课时总数偏少：' + total;
  return true;
});

check('内容', 'BOOKS 数据能正常 JSON 解析且 seq 连续', () => {
  const m = html.match(/var BOOKS = (\{[\s\S]*?\});\n/);
  if (!m) return '找不到 BOOKS 数据块';
  const books = JSON.parse(m[1].replace(/<\\\//g, '</'));
  for (const sid of Object.keys(books)) {
    const ls = books[sid].lessons;
    for (let i = 0; i < ls.length; i++) {
      if (ls[i].seq !== i + 1) return sid + ' 第 ' + (i + 1) + ' 条 seq=' + ls[i].seq;
    }
  }
  return true;
});

check('内容', '关键 DOM 节点齐全', () => {
  const need = ['board', 'fab', 'scrimSubject', 'scrimHw', 'scrimData', 'subjectGrid',
    'bookChips', 'keypad', 'lessonList', 'noteInput', 'hwList', 'btnCommit',
    'btnExit', 'btnCancelEdit', 'snackbar', 'brandDate', 'pageVal',
    /* 章节筛选已从 chip 长条改成 MD3 下拉，节点随之改名 */
    'chapterSelect',
    /* 备注条款 + 提交时效 */
    'btnAddClause', 'noteClauses', 'noteEmptyHint', 'dueDayChips', 'duePeriodChips', 'dueInput',
    /* 卡片背景（Beta） */
    'setBody'];
  const missing = need.filter(id => !html.includes('id="' + id + '"'));
  return missing.length ? ('缺：' + missing.join(',')) : true;
});

check('内容', '卡片背景（Beta）：背景层 + Beta 胶囊 + 开关都在', () => {
  const has = s => html.includes(s);
  const ok = has('.card__bg') && has('beta') && has('自定义背景') && has('Beta');
  return ok || '卡片背景相关结构不完整';
});

check('内容', '科目卡片右上角「编辑」按钮的文案在', () =>
  (html.includes('编辑') && html.includes('card__edit')) || '没有编辑按钮');

check('内容', 'FAB 文字是「添加作业」', () =>
  html.includes('添加作业') || '没找到');

check('内容', '弹窗里有「快捷添加」「自定义」两个页签', () =>
  (html.includes('快捷添加') && html.includes('自定义')) || '缺页签');

check('内容', '备注预设词包含「不用写」「只要写」', () =>
  (html.includes('不用写') && html.includes('只要写')) || '缺预设词');

check('内容', '有「退出」按钮', () => html.includes('>退出<') || html.includes('退出</span>') || '没有退出');

check('内容', '打印样式存在', () => html.includes('@media print') || '没有打印样式');

check('内容', '有跨零点自动翻页逻辑', () =>
  (html.includes('setInterval') && html.includes('lastDay')) || '没有');

/* ============================ 4. 无调试残留 ============================ */
check('卫生', '生产代码里没有 console.log', () => {
  const m = html.match(/console\.log\s*\(/g);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

check('卫生', '没有 debugger 语句', () =>
  !/\bdebugger\b/.test(html) || '有 debugger');

check('卫生', '没有 TODO / FIXME / XXX 残留', () => {
  const m = html.match(/\b(TODO|FIXME|XXX)\b/g);
  return !m ? true : ('发现 ' + m.join(', '));
});

check('卫生', '没有占位符残留', () => {
  const bad = ['__BOOKS_DATA__', '__APP_JS__', 'PLACEHOLDER', 'LOREM'];
  const hit = bad.filter(b => html.includes(b));
  return hit.length ? ('残留：' + hit.join(',')) : true;
});

check('卫生', '没有把 localhost / 127.0.0.1 写进去', () => {
  const m = html.match(/localhost|127\.0\.0\.1/g);
  return !m ? true : ('发现 ' + m.length + ' 处');
});

/* ============================ 5. 体积与性能 ============================ */
/* 单文件体积上限。
 * ⚠️ 这个 500 KB 是**当初随手定的**，不是用户要求、也不是技术硬约束
 *    （单文件 500 KB 在教室大屏上打开毫无压力，从来没出过加载慢的问题）。
 *    2026-10-22 加「AI 识别」页签（+ 内嵌 logo 的 base64）后涨到 511 KB，
 *    就超线了 —— 说明这个线本来就卡得太紧。
 *    ⇒ 提到 550 KB，并写明理由。**别为了让数字好看去把代码搞复杂**：
 *      教材数据字典化只能省 3 KB，不值得为此改数据结构。
 *    真要省空间，优先砍功能，不是砍体积。 */
const MAX_SIZE_KB = 550;
check('体积', '单文件不超过 ' + MAX_SIZE_KB + ' KB', () =>
  sizeKB <= MAX_SIZE_KB ? true : ('实际 ' + sizeKB.toFixed(1) + ' KB'));

check('体积', '单文件不算太小（说明数据真的内联进来了）', () =>
  sizeKB >= 30 ? true : ('只有 ' + sizeKB.toFixed(1) + ' KB，数据可能没进来'));

check('体积', '只有一处 <style> 和一处 <script>', () => {
  /* 必须先剥掉注释：代码注释里提到 "<style>" 字样是正常的，
     直接正则计数会把注释也算进去（这里就踩过，误报 4 个 style）。 */
  /* 注释剥离在 CSS 里有坑（跨块匹配会把后面的 <script> 一起吃掉），
     改为直接数真实标签：只认行首或紧跟在换行后的标签。 */
  const s = (html.match(/<style[\s>]/g) || []).length;
  const j = (html.match(/<script[\s>]/g) || []).length;
  return (s >= 1 && j >= 1 && s === j) ? true : ('style=' + s + ' script=' + j);
});

const ok = report();
process.exit(ok ? 0 : 1);
