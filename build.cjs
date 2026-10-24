/* ============================================================================
 * build.cjs —— 把 src/template.html + data/books-*.json + src/app.js
 *              合成单文件 open-yitie.html
 *
 * 用法：node build.cjs
 * 退出码：0 = 成功；1 = 失败（缺文件 / JSON 非法 / 占位符缺失 / 自检不过）
 *
 * ⚠️ 路径一律从 __dirname 推，不写死绝对路径。
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TPL = path.join(ROOT, 'src', 'template.html');
const APP = path.join(ROOT, 'src', 'app.js');
const DATA = path.join(ROOT, 'data');
const OUT = path.join(ROOT, 'open-yitie.html');

const SUBJECTS = ['chinese', 'math', 'english', 'physics', 'chemistry',
                  'biology', 'politics', 'history', 'geography'];

const problems = [];
function fail(msg) { problems.push(msg); }

/* --- 读取模板 --- */
if (!fs.existsSync(TPL)) fail('缺少模板：' + TPL);
if (!fs.existsSync(APP)) fail('缺少逻辑：' + APP);
if (problems.length) { report(); }

const template = fs.readFileSync(TPL, 'utf8');
const appJs = fs.readFileSync(APP, 'utf8');

/* --- 汇总教材数据 --- */
const books = {};
let totalLessons = 0;

/* ★ 构建时间戳 —— 让构建**可复现**（reproducible build）
 *
 * 为什么重要：产物 open-yitie.html 是要发到 release 上给人家用的。
 *   如果每次构建都嵌一个"当前时间"，那么：
 *     · 仓库里提交的那份和用户自己 `node build.cjs` 出来的**不一样**
 *     · 用户没法验证「我下载的这份确实是这份源码构建出来的」
 *   ⇒ 时间戳改成**由内容决定**的：
 *     ① 环境变量 SOURCE_DATE_EPOCH（业界标准，Debian/RPM 打包都这么用）
 *     ② 退而求其次：用 git 最后一次提交的���间
 *     ③ 都没有：退回固定串（而不是当前时间）—— 保证同一份源码永远构建出同一个产物
 *
 * ⚠️ 注意只影响**注释里的时间戳**，不影响功能。
 */
function buildStamp() {
  const ep = process.env.SOURCE_DATE_EPOCH;
  if (ep && /^\d+$/.test(String(ep))) {
    return new Date(Number(ep) * 1000).toISOString();
  }
  try {
    const t = require('child_process').execFileSync(
      'git', ['log', '-1', '--format=%cI'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (t) return t;
  } catch (e) { /* 不是 git 仓库 → 走下面 */ }
  return '1970-01-01T00:00:00.000Z';
}
const BUILD_STAMP = buildStamp();

for (const sid of SUBJECTS) {
  const f = path.join(DATA, 'books-' + sid + '.json');
  if (!fs.existsSync(f)) { fail(`缺少教材数据：books-${sid}.json`); continue; }

  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); }
  catch (e) { fail(`读不到 books-${sid}.json：${e.message}`); continue; }

  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { fail(`books-${sid}.json 不是合法 JSON：${e.message}`); continue; }

  if (!doc || typeof doc !== 'object') { fail(`books-${sid}.json 顶层不是对象`); continue; }
  if (!Array.isArray(doc.lessons) || !doc.lessons.length) {
    fail(`books-${sid}.json 的 lessons 为空或不是数组`); continue;
  }
  if (doc.subject !== sid) fail(`books-${sid}.json 里 subject=${JSON.stringify(doc.subject)}，与文件名不一致`);

  const seenSeq = new Set();
  const clean = [];
  doc.lessons.forEach((l, i) => {
    if (!l || typeof l !== 'object') { fail(`books-${sid}.json lessons[${i}] 不是对象`); return; }
    const no = String(l.no == null ? '' : l.no).trim();
    const title = String(l.title == null ? '' : l.title).trim();
    if (!no) { fail(`books-${sid}.json lessons[${i}] 缺 no`); return; }
    let seq = Number(l.seq);
    if (!Number.isFinite(seq) || seq < 1) seq = i + 1;
    if (seenSeq.has(seq)) fail(`books-${sid}.json seq 重复：${seq}`);
    seenSeq.add(seq);
    clean.push({
      seq,
      no,
      title,
      chapter: String(l.chapter == null ? '' : l.chapter).trim() || '未分章'
    });
  });

  clean.sort((a, b) => a.seq - b.seq);

  books[sid] = {
    subject: sid,
    subjectName: doc.subjectName || sid,
    book: doc.book || '',
    publisher: doc.publisher || '',
    structure: doc.structure || '',
    lessons: clean
  };
  totalLessons += clean.length;
}

/* --- 应用 logo：内嵌成 base64（页面是单文件，不能引外部图片） --- */
const LOGO_CANDIDATES = [
  path.join(ROOT, 'electron', 'assets', 'icon256.png'),
  path.join(ROOT, 'electron', 'assets', 'icon.png')
];
let LOGO_DATA_URI = '';
for (const p of LOGO_CANDIDATES) {
  if (fs.existsSync(p)) {
    LOGO_DATA_URI = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
    break;
  }
}
if (!LOGO_DATA_URI) fail('找不到应用图标（electron/assets/icon256.png 或 icon.png）');

/* --- 检查占位符 --- */
if (!template.includes('/* __BOOKS_DATA__ */')) fail('模板里找不到 /* __BOOKS_DATA__ */ 占位符');
if (!template.includes('/* __APP_JS__ */')) fail('模板里找不到 /* __APP_JS__ */ 占位符');
if (!appJs.includes('__LOGO_DATA_URI__')) fail('app.js 里找不到 __LOGO_DATA_URI__ 占位符');
if (problems.length) report();

/* --- 组装 --- */
const booksLiteral =
  'var BOOKS = ' + JSON.stringify(books, null, 0)
    .replace(/<\//g, '<\\/') + ';\n' +
  '/* 教材课时数据：' + String(totalLessons) + ' 课时 · 生成于 ' + BUILD_STAMP + ' */';

/* 版本号与构建时间：注入到页面。版本号取 electron/package.json（唯一权威来源）。 */
const pkgPath = path.join(ROOT, 'electron', 'package.json');
let APP_VERSION = 'dev';
try {
  APP_VERSION = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'dev';
} catch (e) {
  console.warn('读不到 electron/package.json 的版本号，用 dev');
}


const out = template
  .replace('/* __BOOKS_DATA__ */', () => booksLiteral)
  .replace('/* __APP_JS__ */', () => appJs)
  .replace(/__VERSION__/g, () => APP_VERSION)
  .replace(/__APP_VERSION__/g, () => APP_VERSION)
  .replace(/__LOGO_DATA_URI__/g, () => LOGO_DATA_URI);

fs.writeFileSync(OUT, out, 'utf8');

/* --- 同步到**安装包内置页** ---
 * ⚠️ 这一步以前漏过：electron/page/classboard.html 是装进 deb 里的那份页面，
 *   不同步的话全新安装的用户拿到的还是旧版。 */
const EMBEDDED_PAGE = path.join(ROOT, 'electron', 'page', 'open-yitie.html');
try {
  fs.mkdirSync(path.dirname(EMBEDDED_PAGE), { recursive: true });
  fs.copyFileSync(OUT, EMBEDDED_PAGE);
} catch (e) {
  fail('同步内置页失败（electron/page/open-yitie.html）：' + e.message);
}

/* --- 自检：产物必须包含关键内容，且**不能有联网功能** --- */
const produced = fs.readFileSync(OUT, 'utf8');
const codeOnly = produced
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const checks = [
  ['含 <!DOCTYPE html>', produced.startsWith('<!DOCTYPE html>')],
  ['版本号已注入（无残留占位符）', !produced.includes('__VERSION__')],
  ['代码里的版本号已替换', !produced.includes('__APP_VERSION__')],
  ['构建时间戳已注入（无残留占位符）', !produced.includes('__BUILD_TIME__')],
  ['含 BOOKS 数据', produced.includes('var BOOKS =')],
  ['含应用逻辑', produced.includes('window.__classboard')],
  ['无残留占位符', !produced.includes('/* __BOOKS_DATA__ */') && !produced.includes('/* __APP_JS__ */')],
  ['九科数据齐全', SUBJECTS.every(s => books[s] && books[s].lessons.length > 0)],
  ['品牌名是 Open作业贴', produced.includes('Open作业贴')],
  ['版权署名是 yiyi', produced.includes('yiyi')],
  /* 内置页必须和产物一致 */
  ['内置页已同步（electron/page/open-yitie.html 与产物一致）', (() => {
    try {
      return fs.readFileSync(EMBEDDED_PAGE, 'utf8') === produced;
    } catch (e) { return false; }
  })()],
  /* ★ 离线自检：产物里不允许有联网功能 */
  ['代码里没有 fetch()', !/[^.\w]fetch\s*\(/.test(codeOnly)],
  ['代码里没有 XMLHttpRequest', !/XMLHttpRequest/.test(codeOnly)],
  ['代码里没有 WebSocket', !/WebSocket/.test(codeOnly)],
  ['代码里没有云同步函数', !/\bsync(?:Upload|Download|Payload|Cfg|Ready)\b/.test(codeOnly)],
  ['代码里没有 AI 函数', !/\bai(?:Chat|Speech|Tts|Cfg|Ready|Base)\b/.test(codeOnly)],
  ['代码里没有语音函数', !/\bvoice(?:Start|Stop|Toggle|State|Cleanup|Supported)\b/.test(codeOnly)],
  ['没有外部 http(s) 链接', !(produced.match(/(?:src|href)\s*=\s*["']?https?:/gi) || []).length],
  ['没有 @import', !produced.includes('@import')],
  ['没有硬编码的 32 位 token', !/\b[0-9a-f]{32}\b/i.test(produced)]
];

checks.forEach(([name, ok]) => { if (!ok) fail('产出自检失败：' + name); });

report();

function report() {
  if (problems.length) {
    console.error('\n构建失败，' + problems.length + ' 个问题：');
    problems.forEach(p => console.error('  ✗ ' + p));
    process.exit(1);
  }
  console.log('构建成功 → ' + OUT);
  console.log('  大小：' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
  console.log('  课时：' + totalLessons + ' 条');
  console.log('  离线自检：' + checks.length + ' 项全过（无 fetch / 无云同步 / 无 AI / 无语音）');
  SUBJECTS.forEach(s => {
    const b = books[s];
    if (b) console.log(`    ${b.subjectName.padEnd(3, '　')} ${String(b.lessons.length).padStart(3)} 课时  ${b.book}`);
  });
  process.exit(0);
}
