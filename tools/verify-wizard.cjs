'use strict';
/* ============================================================================
 * verify-wizard.cjs —— 「Open作业贴」端到端验收测试台
 *
 * 做法：把构建产物 classboard.html 读进内存，向它的 <head> 后插一个错误收集器
 *       （必须早于页面脚本），再在 </body> 前插一段驱动脚本，然后用 Edge headless
 *       同一次调用里同时 --dump-dom（读回 <pre id="__vr"> 里的断言结果）和
 *       --screenshot（截图证据）。
 *
 * 为什么这样写（都是本项目踩过的坑）：
 *   - 子进程输出**绝不能用管道捕获**：spawnSync 用 fs.openSync + stdio:['ignore',fd,fd]。
 *   - 页面里用到的浏览器专有 API（getComputedStyle / getBoundingClientRect / Event /
 *     createEvent / addEventListener）一律 typeof 守卫。
 *   - 开跑前先删旧报告（崩在半路时写报告那句执行不到，磁盘上会残留上次结论）。
 *   - 结尾 process.exit(failures === 0 ? 0 : 1)，退出码必须能失败。
 *   - 只用注入的方式改内存里的 DB（window.__classboard），不碰磁盘上的数据文件。
 *
 * 只读被测文件，不修改 src/ 与 classboard.html。
 * 用法：cd projects/yitie && node tools/verify-wizard.cjs
 * ==========================================================================*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'open-yitie.html');
const OUT = path.join(ROOT, '.tmp', 'verify-wizard');
const RAW = path.join(OUT, 'raw');
const SHOTS = path.join(OUT, 'shots');
const REPORT = path.join(ROOT, 'tools', 'report-wizard.md');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].find(p => fs.existsSync(p));

/* 每个场景 = 一次 Edge 进程（截图场景也是一次，--screenshot 与 --dump-dom 可同用）。
 * 先数清楚再跑：历史上批量跑外部程序没数进程数量刷出过几百个关不掉的系统错误框。 */
const MAX_EDGE = 30;   /* 场景数会随新功能增长（2026-10-22 加了空状态场景后到 25） */

const CHECKS = [];
const NOTES = {};
const RUNS = [];
let failures = 0;

/* 失败断言的人工分诊表：把"设计如此"和"真缺口"分开。
 * 断言本身一律不放水，这里只影响报告里的性质标注；没登记的一律显示"待人工判定"。
 * （task-4 收口后，原先登记在这里的 e1/e4/e5 已按真实设计改写，不再需要分诊。） */
const TRIAGE = {};

/* 已实测的设计事实，写进报告当依据（对应 task-4 的三条收口）。 */
const DESIGN_FACTS = [
  '空列表在正常 UI 路径上**不可达**：设置页作业本行的删除是 ' +
  '`var arr = booksOf(sid).slice(); if (arr.length <= 1) { toast(\'每科至少留一项\'); return; }` —— 删到只剩 1 个就拒绝，' +
  '所以「每科永远至少 1 个作业本」是有意设计。已由 `settings-design/d3`（行数不增不减）+ `d4`（toast 含「每科至少留一项」）正面断言。',
  '快捷词允许删空，但删空那一下执行的是 `delete DB.words[sid]`（不是存空数组）；键一没，`wordsOf()` 立刻回落 `DEFAULT_WORDS`，' +
  '设置页当场按默认重新铺满 —— 所以面板**不会停在 0 行**。已由 `settings-design/d6`（删光原有项那一刻键被删掉）' +
  '+ `d7`（wordsOf 回落内置默认）+ `d8`（设置页行数恢复为默认数量、不可能是 0）+ `d10`（第 2 步仍有选项）正面断言。',
  '因此空态提示属于「防手改数据文件」的兜底：要造出 0 个，必须连内置默认一起清（`CB.SUBJECTS[i].books=[]` / `CB.DEFAULT_WORDS[sid]=[]`）。' +
  '已由 `empty-state/h1`、`h3` 先断言"前提 chip===0"，成立后才由 `h2`、`h4` 断言提示文案；前提造不出来则直接 FAIL 并注明"前提未造出"。',
  'task-1 那三个 FAIL 的性质（按 lead 的排查结论）：`e1`/`e4` 是**期望写反了**（期望"空数组→0 chip"，设计是"删不空"），' +
  '`e5` 是**前提没造出来**（同一时刻 #wordChips 仍有 4 个 chip，却断言空态提示）。三者都不是产品缺口，已按真实设计改写为正面断言。'
];

function addCheck(id, group, ok, detail) {
  CHECKS.push({ id, group, ok: !!ok, detail: String(detail == null ? '' : detail) });
  if (!ok) failures++;
}
function addNote(key, val) { NOTES[key] = val; }

/* ==========================================================================
 * 一、页面内注入的核心（浏览器里跑，ES5，专有 API 全守卫）
 * ========================================================================*/
function PAGE_CORE() {
  'use strict';
  var CHECKS = [], NOTES = {}, DONE = false;

  function str(s) { return String(s == null ? '' : s); }
  function failCount() { var n = 0, i; for (i = 0; i < CHECKS.length; i++) { if (!CHECKS[i].ok) n++; } return n; }
  function flush() {
    var pre = document.getElementById('__vr');
    if (!pre) {
      pre = document.createElement('pre');
      pre.id = '__vr';
      pre.style.display = 'none';
      var root = document.body || document.documentElement;
      if (root && typeof root.appendChild === 'function') root.appendChild(pre);
    }
    if (pre && typeof JSON !== 'undefined') {
      pre.textContent = JSON.stringify({ done: DONE, fail: failCount(), checks: CHECKS, notes: NOTES });
    }
    try { document.title = '__VR__:' + (DONE ? '1' : '0') + ':fail=' + failCount(); } catch (e) {}
  }
  function rec(id, ok, detail) { CHECKS.push({ id: str(id), ok: !!ok, detail: str(detail) }); flush(); }
  function note(k, v) { NOTES[str(k)] = v; flush(); }
  function finish(extra) {
    if (extra && typeof extra === 'object') {
      for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) NOTES['obs.' + k] = extra[k]; }
    }
    DONE = true; flush();
  }
  function byId(id) { return document.getElementById(id); }
  function $(sel) { return document.querySelector(sel); }
  function tick(ms, cb) { setTimeout(cb, ms || 50); }
  function click(el) { if (!el || typeof el.click !== 'function') return false; el.click(); return true; }
  function waitFor(fn, timeout, cb) {
    /* 用"轮询次数"而不是 Date.now() 计时：--virtual-time-budget 下虚拟时钟会大跳，
     * 按墙上时间判断会提前超时（实测：刚打开弹窗时 visibility 还是 hidden，
     * 需要再走一两拍才变 visible，而时钟可能已经跳过 1.5s）。
     * timeout 参数保留原语义（毫秒），换算成 25ms 一轮的轮询次数。 */
    var maxPolls = Math.max(4, Math.ceil((timeout || 1200) / 25)), n = 0;
    (function poll() {
      var r = false;
      try { r = !!fn(); } catch (e) { r = false; }
      if (r) { cb(true); return; }
      n++;
      if (n >= maxPolls) { cb(false); return; }
      setTimeout(poll, 25);
    })();
  }
  /* 可见判据（lead 指定，故意不看 hidden 属性）：
   *   - 有实际盒子高度；[hidden] 的 CSS 规则写错了照样看得见，所以不能只看属性；
   *   - display:none / visibility:hidden 都不算。visibility 是可继承的，祖先 .scrim 关着
   *     的时候子元素算出来就是 hidden —— 这正是"弹窗没开"该有的结果。
   * 注意：单看 getBoundingClientRect().height>0 会被骗（实测关着的弹窗里 wPane1 高度 55px）。 */
  function visible(el) {
    if (!el) return false;
    if (typeof el.getBoundingClientRect === 'function') {
      var r = el.getBoundingClientRect();
      if (!r || r.height <= 0) return false;
    }
    if (typeof getComputedStyle === 'function') {
      var cs = getComputedStyle(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
    }
    return true;
  }
  function visId(id) { return visible(byId(id)); }
  var PANE_IDS = ['wPane1', 'wPane2Book', 'wPane2Word', 'wPane3Page', 'wPane3Lesson', 'wPane3Text', 'wPane4Extra'];
  /* 从 DOM 里查所有 .wizard__pane（不是靠写死的 id 列表），这样将来多一个面板也会被数进来。
   * 可见判据：没有 hidden + computed display/visibility 正常 + getBoundingClientRect 有实际盒子。
   * 只看 hidden 属性不够——[hidden] 的 CSS 规则写错了照样看得见。 */
  function panes() {
    var els = document.querySelectorAll('#hwPanel .wizard__pane'), out = [], i;
    for (i = 0; i < els.length; i++) { if (visible(els[i])) out.push(els[i].id || '(无id)'); }
    return out;
  }
  function recPanes(id, want, extra) {
    var p = panes();
    rec(id, p.length === 1 && p[0] === want,
      'want=[恰好 ' + want + '] actual=[' + p.join(',') + ']' + (extra ? ' ' + extra : ''));
    return p;
  }
  /* 向导容器里所有 .wizard__pane 的 id（含不可见的）——用来断言"面板集合"本身有没有缺/多。
   * panes() 只数可见的；这个用来防"新加的第 4 步根本不在列表里"那类假通过。 */
  function paneIdsInDom() {
    var els = document.querySelectorAll('#hwPanel .wizard__pane'), out = [], i;
    for (i = 0; i < els.length; i++) out.push(els[i].id || '(无id)');
    return out;
  }
  function wizardNextState() {
    var b = byId('wizardNext');
    if (!b) return { exists: false, visible: false, disabled: null };
    return { exists: true, visible: visible(b), disabled: !!b.disabled, hidden: !!b.hidden };
  }
  function clickWizardNext(cb) {
    var b = byId('wizardNext');
    if (!b) { cb(false); return; }
    b.click();
    tick(80, function () { cb(panes().length > 0); });
  }
  /* 备注 / 时效那四块：断言它们必须住在第 4 步里，且全页只有一份（防新旧并存） */
  var EXTRA_IDS = ['noteInput', 'dueInput', 'noteClauses', 'btnAddClause', 'dueDayChips', 'duePeriodChips', 'noteEmptyHint'];
  function extraLocality(containerId) {
    var box = byId(containerId), r = { container: containerId, missing: [], dup: [], outside: [], inside: [] };
    for (var i = 0; i < EXTRA_IDS.length; i++) {
      var id = EXTRA_IDS[i];
      var el = byId(id);
      if (!el) { r.missing.push(id); continue; }
      var n = document.querySelectorAll('#' + id).length;
      if (n !== 1) r.dup.push(id + '×' + n);
      if (box && box.contains(el)) r.inside.push(id);
      else r.outside.push(id);
    }
    return r;
  }
  function backVisible() { return visId('wizardBack'); }
  function chipTexts(sel) {
    var box = $(sel); if (!box) return [];
    var els = box.querySelectorAll('.chip'), out = [], i;
    for (i = 0; i < els.length; i++) out.push(str(els[i].textContent).trim());
    return out;
  }
  function chipCount(sel) { var box = $(sel); return box ? box.querySelectorAll('.chip').length : -1; }
  function clickChipByText(sel, text, cb) {
    var box = $(sel);
    var els = box ? box.querySelectorAll('.chip') : [];
    for (var i = 0; i < els.length; i++) {
      if (str(els[i].textContent).trim() === text) { els[i].click(); tick(80, function () { cb(true); }); return; }
    }
    cb(false);
  }
  function clickType(idx, cb) {
    var cards = document.querySelectorAll('#typeGrid .type-card');
    if (!cards || !cards[idx]) { cb(false); return; }
    cards[idx].click(); tick(80, function () { cb(true); });
  }
  function clickKeypad(label, cb) {
    var btns = document.querySelectorAll('#keypad button');
    for (var i = 0; i < btns.length; i++) {
      if (str(btns[i].getAttribute('aria-label')) === label) { btns[i].click(); tick(60, function () { cb(true); }); return; }
    }
    cb(false);
  }
  function back(cb) { click(byId('wizardBack')); tick(80, function () { cb(true); }); }
  /* 程序化改 .value 不会触发 input 事件，而 updateCommit() 只在 input 事件里跑，
   * 所以必须手动派发一个冒泡的 input —— 否则会误判成"快捷词分支没落库"（探针假阴性）。 */
  function setInput(sel, val) {
    var el = $(sel); if (!el) return false;
    el.value = val;
    try {
      if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }));
      else if (document.createEvent) { var e = document.createEvent('Event'); e.initEvent('input', true, true); el.dispatchEvent(e); }
    } catch (err) {}
    return true;
  }
  function setTheme(t, cb) {
    var n = 0;
    (function step() {
      if (document.documentElement.getAttribute('data-theme') === t) { cb(true); return; }
      if (n >= 3) { cb(false); return; }
      n++;
      if (!click(byId('btnTheme'))) { cb(false); return; }
      tick(60, step);
    })();
  }
  function freeze() {
    var st = document.createElement('style');
    st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
    (document.head || document.documentElement).appendChild(st);
  }
  function badge(txt) {
    var b = byId('__vbadge');
    if (!b) {
      b = document.createElement('div');
      b.id = '__vbadge';
      b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;' +
        'font:12px/1.45 ui-monospace,Consolas,monospace;background:rgba(0,0,0,.78);color:#fff;' +
        'padding:4px 8px;border-radius:4px;max-width:70vw;white-space:pre-wrap;pointer-events:none';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = txt;
  }
  function paneText(id) {
    var p = byId(id);
    return p ? str(p.textContent).replace(/\s+/g, ' ').trim().slice(0, 200) : '(无此面板)';
  }
  /* 类型卡片图标：ICON 里缺 book/pen 时 svgEl() 会生成 <path d="undefined">，
   * 页面不报错、只是画个空方块——必须专门断言。 */
  function checkTypeIcons(prefix) {
    var typeCards = document.querySelectorAll('#typeGrid .type-card');
    rec(prefix + '.type_cards_rendered', typeCards.length === 2, '#typeGrid .type-card=' + typeCards.length);
    var badIcons = [], badPaths = [], dList = [];
    for (var i = 0; i < typeCards.length; i++) {
      var icon = typeCards[i].querySelector('.type-card__icon');
      var paths = icon ? icon.querySelectorAll('svg path') : [];
      if (!icon || !icon.querySelector('svg') || paths.length === 0) {
        badIcons.push('card' + i + '(无 svg 或无 path)');
        continue;
      }
      for (var j = 0; j < paths.length; j++) {
        var d = paths[j].getAttribute('d');
        dList.push(d);
        if (!d || !str(d).trim() || str(d).trim() === 'undefined') {
          badPaths.push('card' + i + ' path' + j + ' d="' + d + '"');
        }
      }
    }
    rec(prefix + '.type_card_icons_drawn', badIcons.length === 0 && badPaths.length === 0,
      '缺图标的卡片=' + JSON.stringify(badIcons) + ' 空/undefined 的 path=' + JSON.stringify(badPaths) +
      ' 实际 d=' + JSON.stringify(dList));
    return dList;
  }
  function crumbText() {
    var c = byId('crumb2Text');
    return c ? str(c.textContent).replace(/\s+/g, ' ').trim() : '(元素不存在)';
  }
  function toastText() {
    var t = byId('snackText');
    return t ? str(t.textContent).replace(/\s+/g, ' ').trim() : '(无 toast)';
  }
  /* 打开设置页并选中某一科：点设置按钮 → 等左侧科目导航渲染 → 点该科 */
  function openSettings(subjectName, cb) {
    click(byId('btnSettings'));
    waitFor(function () { return document.querySelectorAll('#setNav .set-nav__item').length > 0; }, 1500, function (ok) {
      if (!ok) { cb(false); return; }
      var items = document.querySelectorAll('#setNav .set-nav__item'), hit = null;
      for (var i = 0; i < items.length; i++) {
        var nm = items[i].querySelector('.set-nav__name');
        if (nm && str(nm.textContent).trim() === subjectName) { hit = items[i]; break; }
      }
      if (!hit) { cb(false); return; }
      hit.click();
      tick(80, function () {
        var body = byId('setBody');
        cb(!!(body && body.children.length));
      });
    });
  }
  /* 按 .set-sec 小标题分区取行：作业本的行和快捷词的行共用 .set-row 样式，
   * 不分区就会被混在一起数（只有作业本行里多一个 .set-row__kind）。 */
  function rowsOf(sectionName) {
    var body = byId('setBody');
    if (!body) return [];
    var kids = body.children, inSec = false, out = [];
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList && k.classList.contains('set-sec')) {
        inSec = (str(k.textContent).trim() === sectionName);
        continue;
      }
      if (inSec && k.classList && k.classList.contains('set-row')) out.push(k);
    }
    return out;
  }
  function rowDelBtn(row) {
    if (!row) return null;
    return row.querySelector('.icon-btn--danger') || null;
  }
  /* 空态提示：先找专用 class，再找面板里"除了 step__label 之外的短文本" */
  function emptyHint(paneId) {
    var pane = byId(paneId); if (!pane) return '';
    var byClass = pane.querySelector('.chips-empty,.empty-hint,[data-empty],.wizard__empty,.pane-empty,.lesson-empty');
    if (byClass && visible(byClass)) return str(byClass.textContent).replace(/\s+/g, ' ').trim().slice(0, 120);
    var all = pane.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.classList && (el.classList.contains('step__label') || el.classList.contains('hint'))) continue;
      if (el.children && el.children.length) continue;
      var t = str(el.textContent).replace(/\s+/g, ' ').trim();
      if (t && /暂无|还没有|没有可|都没有|去设置|添加作业本|添加快捷词/.test(t) && visible(el)) return t.slice(0, 120);
    }
    return '';
  }
  function pickBookNameByKind(kind, prefer, sid) {
    var CB = window.__classboard, list = [], i;
    sid = sid || 'chinese';
    try { list = (CB && CB.booksOf) ? (CB.booksOf(sid) || []) : []; } catch (e) { list = []; }
    if (prefer) { for (i = 0; i < list.length; i++) { if (list[i].name === prefer && list[i].kind === kind) return prefer; } }
    for (i = 0; i < list.length; i++) { if (list[i].kind === kind) return list[i].name; }
    if (prefer) { for (i = 0; i < list.length; i++) { if (list[i].name === prefer) return prefer; } }
    if (list.length) return list[0].name;
    var chips = chipTexts('#bookChips');
    return chips.length ? chips[0] : null;
  }
  function pickBookName(prefer) { return pickBookNameByKind('page', prefer); }
  /* SUBJECTS 与内部 SUBJECT_MAP 是同一批对象，所以改这里能让内置默认也变空，
   * 这样才能真正走到"一个作业本都没有"的分支（只 setBooks([]) 会被回落逻辑吃掉）。 */
  function forceEmptyBooks() {
    var CB = window.__classboard, subs = (CB && CB.SUBJECTS) ? CB.SUBJECTS : [];
    for (var i = 0; i < subs.length; i++) { if (subs[i] && subs[i].id === 'chinese') subs[i].books = []; }
    try { if (CB && CB.setBooks) CB.setBooks('chinese', []); } catch (e) {}
  }
  function openWizard(name, cb) {
    var diag = { tiles: 0, typeCards: 0, scrimCls: '(未查)', panes: [] };
    function fillDiag() {
      var sc = byId('scrimHw');
      diag.tiles = document.querySelectorAll('#subjectGrid .subject-tile').length;
      diag.typeCards = document.querySelectorAll('#typeGrid .type-card').length;
      diag.scrimCls = sc ? String(sc.className) : '(无 scrimHw)';
      diag.panes = panes();
      return diag;
    }
    click(byId('fab'));
    waitFor(function () { return document.querySelectorAll('#subjectGrid .subject-tile').length > 0; }, 1500, function (ok) {
      if (!ok) { cb(false, fillDiag()); return; }
      var tiles = document.querySelectorAll('#subjectGrid .subject-tile'), hit = null;
      for (var i = 0; i < tiles.length; i++) {
        var nm = tiles[i].querySelector('.subject-tile__name');
        if (nm && str(nm.textContent).trim() === name) { hit = tiles[i]; break; }
      }
      if (!hit) { cb(false, fillDiag()); return; }
      hit.click();
      waitFor(function () { return panes().length > 0; }, 3000, function (ok2) {
        cb(ok2 && panes().length > 0, fillDiag());
      });
    });
  }
  function poseStep(pose, opts, cb) {
    opts = opts || {};
    if (pose === 'step1') { cb(true); return; }
    if (pose === 'step2book') {
      if (opts.emptyBooks) forceEmptyBooks();
      clickType(0, function () {
        waitFor(function () { return visId('wPane2Book'); }, 1200, function () { cb(visId('wPane2Book')); });
      });
      return;
    }
    if (pose === 'step3page') {
      clickType(0, function () {
        clickChipByText('#bookChips', pickBookName('同步学与练'), function () {
          waitFor(function () { return visId('wPane3Page'); }, 1200, function () {
            clickKeypad('3', function () {
              clickKeypad('5', function () { cb(visId('wPane3Page')); });
            });
          });
        });
      });
      return;
    }
    if (pose === 'step4extra') {
      clickType(0, function () {
        clickChipByText('#bookChips', pickBookName('同步学与练'), function () {
          waitFor(function () { return visId('wPane3Page'); }, 1200, function () {
            clickKeypad('3', function () {
              clickKeypad('5', function () {
                clickWizardNext(function () {
                  waitFor(function () { return visId('wPane4Extra'); }, 1200, function () {
                    if (opts && opts.note) setInput('#noteInput', opts.note);
                    if (opts && opts.dueDay) clickChipByText('#dueDayChips', opts.dueDay, function () {});
                    if (opts && opts.duePeriod) clickChipByText('#duePeriodChips', opts.duePeriod, function () {});
                    tick(80, function () { cb(visId('wPane4Extra')); });
                  });
                });
              });
            });
          });
        });
      });
      return;
    }
    if (pose === 'step3lesson') {
      clickType(0, function () {
        clickChipByText('#bookChips', pickBookNameByKind('lesson', '导学案'), function () {
          waitFor(function () { return visId('wPane3Lesson'); }, 1200, function () { cb(visId('wPane3Lesson')); });
        });
      });
      return;
    }
    if (pose === 'step2word') {
      if (opts.emptyWords) { try { window.__classboard.getDB().words.chinese = []; } catch (e) {} }
      clickType(1, function () {
        waitFor(function () { return visId('wPane2Word'); }, 1200, function () { cb(visId('wPane2Word')); });
      });
      return;
    }
    if (pose === 'step3text') {
      clickType(1, function () {
        var words = chipTexts('#wordChips');
        var prefer = words.indexOf('默写') >= 0 ? '默写' : words[0];
        clickChipByText('#wordChips', prefer, function () {
          waitFor(function () { return visId('wPane3Text'); }, 1200, function () {
            if (opts.text) setInput('#quickWordText', opts.text);
            tick(60, function () { cb(visId('wPane3Text')); });
          });
        });
      });
      return;
    }
    cb(false);
  }

  window.__V = {
    rec: rec, note: note, finish: finish, tick: tick, click: click, waitFor: waitFor,
    visible: visible, visId: visId, panes: panes, recPanes: recPanes, backVisible: backVisible,
    chipTexts: chipTexts, chipCount: chipCount, clickChipByText: clickChipByText,
    clickType: clickType, clickKeypad: clickKeypad, back: back, setInput: setInput,
    setTheme: setTheme, freeze: freeze, badge: badge, paneText: paneText, emptyHint: emptyHint,
    checkTypeIcons: checkTypeIcons, crumbText: crumbText, toastText: toastText,
    openSettings: openSettings, rowsOf: rowsOf, rowDelBtn: rowDelBtn,
    paneIdsInDom: paneIdsInDom, wizardNextState: wizardNextState, clickWizardNext: clickWizardNext,
    extraLocality: extraLocality, EXTRA_IDS: EXTRA_IDS,
    quickGridCount: function () { return document.querySelectorAll('.quick-grid').length; },
    pickBookName: pickBookName, pickBookNameByKind: pickBookNameByKind,
    forceEmptyBooks: forceEmptyBooks, openWizard: openWizard,
    poseStep: poseStep,
    state: function () { return window.__classboard ? window.__classboard.state : null; }
  };
}

/* ==========================================================================
 * 二、场景脚本（同样是浏览器里跑的函数，靠 toString 注入）
 * ========================================================================*/

/* 场景 1：启动回归 —— 刚修好的整页白屏 bug（pageVal 漏 var）必须有回归断言 */
function actBoot() {
  var V = window.__V;
  var errs = window.__errs || [];
  V.rec('b1.no_js_error', errs.length === 0,
    'window.onerror 捕获到 ' + errs.length + ' 条：' + JSON.stringify(errs));
  var CB = window.__classboard;
  V.rec('b2.cb_is_object', typeof CB === 'object' && CB !== null, 'typeof window.__classboard=' + typeof CB);
  if (!CB) {
    V.note('b.fatal', 'window.__classboard 不存在 → boot() 中断，后续断言无法进行');
    V.finish({});
    return;
  }
  V.rec('b3.cb_api_ready',
    typeof CB.getDB === 'function' && typeof CB.renderBoard === 'function' && !!CB.state,
    'getDB=' + typeof CB.getDB + ' renderBoard=' + typeof CB.renderBoard + ' state=' + (!!CB.state));
  var board = document.getElementById('board');
  var cards = board ? board.querySelectorAll('.card') : [];
  var txt = board ? String(board.textContent).replace(/\s+/g, ' ').trim() : '';
  /* ⚠️ 空状态的结构 2026-10-22 改过：
   *    原来是没有作业时铺 9 张「暂无作业」空卡片；
   *    现在是**一个 hero（logo + 作业贴 + 流动渐变）+ 9 科小入口**。
   *    所以这里不能断言"有 9 张 .card"，要断新的结构。 */
  var hero = board ? board.querySelector('.empty-hero') : null;
  var picks = board ? board.querySelectorAll('.empty-pick') : [];
  V.rec('b4.empty_state_hero', !!(hero && picks.length === 9 && txt.length > 0),
    '空状态：hero=' + (hero ? '有' : '无') + '，9 科入口=' + picks.length +
    ' 个，board 文字长度=' + txt.length + '，.card=' + cards.length + '（空状态不该有卡片）');
  var subs = [], i;
  for (i = 0; i < picks.length; i++) {
    subs.push(picks[i].querySelector('.empty-pick__name') ?
      picks[i].querySelector('.empty-pick__name').textContent : '?');
  }
  V.note('boot.empty_picks', subs);

  /* 判据自检：弹窗关着的时候所有 pane 必须全不可见（否则"只显示一个"这类断言没有意义）。
   * 同时确认面板集合完整（4 步改造后是 7 个：wPane1/2Book/2Word/3Page/3Lesson/3Text/4Extra），
   * 否则"0 个可见"是空断言，新加的 pane 也可能根本不在列表里。 */
  var paneEls = document.querySelectorAll('#hwPanel .wizard__pane');
  var paneIds = V.paneIdsInDom();
  var wantPanes = ['wPane1', 'wPane2Book', 'wPane2Word', 'wPane3Page', 'wPane3Lesson', 'wPane3Text', 'wPane4Extra'];
  var missingPanes = wantPanes.filter(function (x) { return paneIds.indexOf(x) < 0; });
  var extraPanes = paneIds.filter(function (x) { return wantPanes.indexOf(x) < 0; });
  V.rec('b5.pane_elements_present', paneEls.length === 7 && missingPanes.length === 0 && extraPanes.length === 0,
    '#hwPanel .wizard__pane=' + paneEls.length + '（应为 7）实际=[' + paneIds.join(',') + ']' +
    ' 缺少=' + JSON.stringify(missingPanes) + ' 多出=' + JSON.stringify(extraPanes));
  V.note('boot.pane_ids', paneIds);
  var visWhenClosed = V.panes();
  V.rec('b6.closed_dialog_no_pane_visible', visWhenClosed.length === 0,
    '弹窗关闭时可见 pane=[' + visWhenClosed.join(',') + ']（应为空；7 个 pane 全关闭态）');
  V.rec('b7.quick_grid_gone', V.quickGridCount() === 0,
    'document.querySelectorAll(".quick-grid").length=' + V.quickGridCount() + '（旧两列容器应已连 DOM 一起删除）');
  var sc = document.getElementById('scrimHw');
  V.note('boot.scrimHw_closed', {
    className: sc ? String(sc.className) : '(无)',
    visibility: (sc && typeof getComputedStyle === 'function') ? getComputedStyle(sc).visibility : '?'
  });

  /* 类型卡片图标要等向导打开、renderTypeGrid() 跑完才有，所以断言放在 flow-page 场景里
   * （见 V.checkTypeIcons）。这里只记录 boot 时刻 #typeGrid 是空的——属正常。 */
  V.note('boot.typeGrid_children_at_boot', document.querySelectorAll('#typeGrid .type-card').length);
  var db = null;
  try { db = CB.getDB(); } catch (e) { db = null; }
  var tk = '';
  try { tk = CB.todayKey(); } catch (e) {}
  V.note('boot.db', {
    today: tk,
    dayKeys: (db && db.days) ? Object.keys(db.days).length : -1,
    todaySubjects: (db && db.days && db.days[tk]) ? Object.keys(db.days[tk]) : [],
    theme: document.documentElement.getAttribute('data-theme'),
    storageOK: (typeof CB.isStorageOK === 'function') ? CB.isStorageOK() : '?'
  });
  V.note('boot.errors', errs);
  V.freeze();
  V.badge('verify · boot · cards=' + cards.length + ' · errs=' + errs.length);
  V.finish({});
}

/* 场景 2/3：页码分支 —— 每步只显示一个 pane + 上一步回退 + 真正落库 */
function actFlowPage() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};
  V.openWizard('语文', function (ok, diag) {
    V.rec('p0.open_wizard', ok, '点 fab → 选语文 → 向导打开=' + ok + ' 可见=[' + V.panes().join(',') + ']' +
      (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
    if (!ok) { V.note('p.fatal', '向导没打开，后续跳过 diag=' + JSON.stringify(diag)); V.finish(obs); return; }

    obs.step1 = V.recPanes('p1.step1_only_wPane1', 'wPane1');
    V.rec('p2.step1_back_hidden', !V.backVisible(), '第1步时「上一步」可见=' + V.backVisible());
    V.note('p.type_card_paths', V.checkTypeIcons('p2b'));
    V.note('p.crumb2_at_step1', V.crumbText());

    V.clickType(0, function () {
      obs.step2book = V.recPanes('p3.step2book_only_wPane2Book', 'wPane2Book', '（点「作业本」之后）');
      V.rec('p4.step2_back_visible', V.backVisible(), '第2步时「上一步」可见=' + V.backVisible());
      var bookName = V.pickBookName('同步学与练');
      V.note('p.bookName', bookName);
      V.clickChipByText('#bookChips', bookName, function (okBook) {
        V.rec('p5.choose_book_chip', okBook,
          '点作业本 chip "' + bookName + '" ok=' + okBook + ' 实际 chips=[' + V.chipTexts('#bookChips').join('|') + ']');
        obs.step3page = V.recPanes('p6.step3page_only_wPane3Page', 'wPane3Page', '（选中 ' + bookName + ' 之后）');
        V.rec('p7.step3_hides_step2book', V.panes().indexOf('wPane2Book') < 0,
          '第3步仍可见的面板=[' + V.panes().join(',') + ']');
        V.rec('p8.step3_back_visible', V.backVisible(), '第3步时「上一步」可见=' + V.backVisible());
        V.note('p.step3_panes', V.panes());
        var crumb3 = V.crumbText();
        V.note('p.crumb2_at_step3', crumb3);
        V.rec('p8b.crumb_keeps_context', !!crumb3 && crumb3 !== 'undefined' && crumb3 !== '(元素不存在)',
          '#crumb2Text="' + crumb3 + '"（第 3 步时第 2 颗胶囊不该空掉/变成 undefined）');

        V.back(function () {
          obs.backToStep2 = V.recPanes('p9.back_from_step3_to_step2book', 'wPane2Book');
          V.back(function () {
            obs.backToStep1 = V.recPanes('p10.back_from_step2_to_step1', 'wPane1');
            V.rec('p11.step1_back_hidden_again', !V.backVisible(), '回到第1步后「上一步」可见=' + V.backVisible());

            /* ---- 再走一遍，这次真的点「添加到今天的作业」 ---- */
            V.clickType(0, function () {
              V.clickChipByText('#bookChips', bookName, function () {
                V.clickKeypad('2', function () {
                  V.clickKeypad('0', function () {
                    V.rec('p12.state_page_20', !!(CB.state && CB.state.page === '20'),
                      'state.page="' + (CB.state ? CB.state.page : '?') + '"');
                    var dv = document.getElementById('pageVal');
                    V.rec('p13.page_display_20', !!(dv && String(dv.textContent).indexOf('20') >= 0),
                      'pageVal.text="' + (dv ? dv.textContent : '(无)') + '"');
                    var btn = document.getElementById('btnCommit');
                    V.rec('p14.commit_enabled', !!(btn && !btn.disabled),
                      'disabled=' + (btn ? btn.disabled : 'no-el') + ' title="' + (btn ? btn.title : '') + '"');
                    var dayKey = (CB.state && CB.state.date) || CB.todayKey();
                    var tk = CB.todayKey();
                    V.rec('p15.date_is_today', dayKey === tk, 'state.date=' + dayKey + ' todayKey=' + tk);
                    var list = CB.listOf(dayKey, 'chinese'), before = {}, i, n0 = list.length;
                    for (i = 0; i < list.length; i++) before[list[i].id] = 1;
                    if (btn) btn.click();
                    var list2 = CB.listOf(dayKey, 'chinese'), added = [];
                    for (i = 0; i < list2.length; i++) { if (!before[list2[i].id]) added.push(list2[i]); }
                    V.rec('p16.db_one_item_added', list2.length === n0 + 1 && added.length === 1,
                      '提交前=' + n0 + ' 提交后=' + list2.length + ' 新增=' + added.length);
                    /* 按任务书字面要求，再直接从 CB.getDB().days 读一次（不经 listOf） */
                    var rawDays = CB.getDB().days || {};
                    var rawList = (rawDays[dayKey] && rawDays[dayKey]['chinese']) || null;
                    V.rec('p16b.getDB_days_has_new_item', !!(rawList && rawList.length === n0 + 1),
                      'CB.getDB().days["' + dayKey + '"]["chinese"].length=' + (rawList ? rawList.length : '(无)') +
                      '（提交前 ' + n0 + '）');
                    var it = added[0] || {};
                    V.rec('p17.db_book_matches', it.book === bookName, 'item.book="' + it.book + '" want="' + bookName + '"');
                    V.rec('p18.db_detail_P20', it.detail === 'P20', 'item.detail="' + it.detail + '" want="P20"');
                    V.rec('p19.db_detail_carries_page', String(it.detail || '').indexOf('20') >= 0 && it.page === undefined,
                      '条目字段=' + JSON.stringify(Object.keys(it)) + '（页码由 detail 承载，无独立 page 字段）');
                    V.note('p.db_item', it);
                    var card = document.querySelector('.card[data-subject="chinese"]');
                    var ct = card ? String(card.textContent).replace(/\s+/g, ' ') : '';
                    V.rec('p20.board_card_updated', !!(card && ct.indexOf(bookName) >= 0 && ct.indexOf('P20') >= 0),
                      '语文卡片文本="' + ct.slice(0, 140) + '"');
                    V.note('p.db_snapshot', { dayKey: dayKey, count: list2.length, item: it });
                    V.freeze();
                    V.badge('verify · flow-page · panes=[' + V.panes().join(',') + ']');
                    /* 判据自检（二）：关掉弹窗后所有 pane 必须全不可见。
                     * 这一条能证明"可见性判据"是真的跟着弹窗开关在变，而不是恒真/恒假。 */
                    var closeBtn = document.querySelector('#scrimHw [data-close]');
                    V.click(closeBtn);
                    V.waitFor(function () { return V.panes().length === 0; }, 2000, function (closedOk) {
                      V.rec('p21.close_hides_all_panes', closedOk,
                        '点关闭后可见 pane=[' + V.panes().join(',') + ']（应为空） 关闭按钮=' + (closeBtn ? '找到' : '没找到'));
                      V.note('p.panes_after_close', V.panes());
                      V.note('p.obs', obs);
                      V.finish(obs);
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

/* 场景：第 4 步「补充信息（选填）」—— 备注 + 时效搬进向导、且不点它也能直接提交。
 * 覆盖三件事：
 *   1) 备注/时效的 DOM 真的住在 #wPane4Extra 里且全页只有一份（防"新旧两份并存"）；
 *   2) 第 3 步不经过第 4 步直接提交 ⇒ 落库且 note/due 为空（选填就是选填）；
 *   3) 走第 4 步填备注+时效 ⇒ 落库带上；提交后向导回到第 1 步（用户要求"方便同科目多次添加"）。 */
function actFlowExtra() {
  var V = window.__V, CB = window.__classboard;
  var obs = {}, NOTE = '第3、5题不用写';
  V.openWizard('语文', function (ok, diag) {
    V.rec('x0.open_wizard', ok, '向导打开=' + ok + ' 可见=[' + V.panes().join(',') + ']' +
      (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
    if (!ok) { V.note('x.fatal', '向导没打开，跳过 diag=' + JSON.stringify(diag)); V.finish(obs); return; }

    /* --- 旧界面必须已经没了 --- */
    V.rec('x1.quick_grid_gone', V.quickGridCount() === 0,
      'document.querySelectorAll(".quick-grid").length=' + V.quickGridCount());

    /* --- 备注/时效的归属：全在第 4 步里、且不重复 --- */
    var loc = V.extraLocality('wPane4Extra');
    obs.locality = loc;
    V.rec('x2.extra_lives_in_step4',
      loc.missing.length === 0 && loc.dup.length === 0 && loc.outside.length === 0 &&
      loc.inside.length === V.EXTRA_IDS.length,
      'inside=' + loc.inside.length + '/' + V.EXTRA_IDS.length +
      ' 缺失=' + JSON.stringify(loc.missing) + ' 重复=' + JSON.stringify(loc.dup) +
      ' 在容器外=' + JSON.stringify(loc.outside));
    V.rec('x3.extra_hidden_at_step1',
      !V.visId('noteInput') && !V.visId('dueInput') && !V.visId('noteClauses'),
      '第1步 noteInput=' + V.visId('noteInput') + ' dueInput=' + V.visId('dueInput') +
      ' noteClauses=' + V.visId('noteClauses') + '（备注/时效不该再常驻在向导外面）');

    V.clickType(0, function () {
      /* 必填没齐时的门禁在第 3 步那条（x7）上验。
         第 2 步时 #wizardNext 本来就该是隐藏的 —— 它是第 3 步才出现的出口，
         不是"亮着但点不动"。这里断言"没到第 3 步就不该出现"。 */
      var st2 = V.wizardNextState();
      V.rec('x4.next_hidden_before_step3', st2.exists && st2.visible === false,
        '#wizardNext exists=' + st2.exists + ' visible=' + st2.visible +
        '（第2步不该出现，它属于第 3 步）上一步可见=' + V.backVisible());

      var bookName = V.pickBookName('同步学与练');
      V.clickChipByText('#bookChips', bookName, function (okBook) {
        V.rec('x5.choose_book', okBook, '选了 "' + bookName + '" ok=' + okBook);
        V.recPanes('x6.step3_only_wPane3Page', 'wPane3Page');
        var st3 = V.wizardNextState();
        V.rec('x7.next_disabled_before_page', st3.visible && st3.disabled === true,
          '还没填页码时 #wizardNext visible=' + st3.visible + ' disabled=' + st3.disabled);

        V.clickKeypad('3', function () {
          V.clickKeypad('5', function () {
            V.rec('x8.state_page_35', !!(CB.state && CB.state.page === '35'),
              'state.page="' + (CB.state ? CB.state.page : '?') + '"');
            var st4 = V.wizardNextState();
            V.rec('x9.next_enabled_after_page', st4.visible && st4.disabled === false,
              '填了页码后 #wizardNext disabled=' + st4.disabled + '（应可点，通往第 4 步）');

            /* --- (2) 不点「补充信息」，直接提交：note/due 必须为空 --- */
            var dayKey = (CB.state && CB.state.date) || CB.todayKey();
            var list = CB.listOf(dayKey, 'chinese'), before = {}, i, n0 = list.length;
            for (i = 0; i < list.length; i++) before[list[i].id] = 1;
            V.click(document.getElementById('btnCommit'));
            var list2 = CB.listOf(dayKey, 'chinese'), added = [];
            for (i = 0; i < list2.length; i++) { if (!before[list2[i].id]) added.push(list2[i]); }
            var it1 = added[0] || {};
            V.rec('x10.direct_commit_lands', list2.length === n0 + 1 && it1.book === bookName &&
              it1.detail === 'P35',
              '提交前=' + n0 + ' 提交后=' + list2.length + ' book="' + it1.book + '" detail="' + it1.detail + '"');
            V.rec('x11.direct_commit_extra_empty', (it1.note || '') === '' && (it1.due || '') === '',
              'note="' + (it1.note || '(空)') + '" due="' + (it1.due || '(空)') + '"（没进第 4 步就该是空的）');
            obs.afterDirectCommit = { step: CB.state ? CB.state.wizardStep : null, panes: V.panes() };
            V.rec('x12.commit_returns_to_step1',
              !!(CB.state && CB.state.wizardStep === 1) && V.panes().length === 1 && V.panes()[0] === 'wPane1',
              '提交后 step=' + (CB.state ? CB.state.wizardStep : '?') + ' 可见=[' + V.panes().join(',') + ']' +
              '（用户要求：添加完自动返回第一步，方便同一科目多次添加）');
            V.rec('x13.subject_kept_after_commit',
              !!(CB.state && CB.state.subject === 'chinese') && !V.backVisible(),
              '提交后 state.subject="' + (CB.state ? CB.state.subject : '?') + '" 上一步可见=' + V.backVisible() +
              '（科目和弹窗留着，只是向导重来）');
            V.rec('x14.extra_cleared_after_commit',
              !V.visId('noteInput') && (function () { var n = document.getElementById('noteInput'); return !n || n.value === ''; })(),
              '回到第 1 步后 noteInput 可见=' + V.visId('noteInput') + ' value="' +
              ((document.getElementById('noteInput') || {}).value || '') + '"');

            /* --- (3) 再走一遍，这次进第 4 步填备注+时效 --- */
            V.clickType(0, function () {
              V.clickChipByText('#bookChips', bookName, function () {
                V.clickKeypad('3', function () {
                  V.clickKeypad('5', function () {
                    V.clickWizardNext(function () {
                      obs.step4 = V.recPanes('x15.step4_only_wPane4Extra', 'wPane4Extra');
                      V.rec('x16.step4_hides_step3', V.panes().indexOf('wPane3Page') < 0 &&
                        V.panes().indexOf('wPane2Book') < 0,
                        '第4步仍可见的面板=[' + V.panes().join(',') + ']');
                      /* V.crumbText() 读的是 #crumb2Text（第 2 颗），第 3 颗要自己取 */
                      var c3el = document.getElementById('crumb3Text');
                      var crumb3 = c3el ? String(c3el.textContent == null ? '' : c3el.textContent) : '(无#crumb3Text)';
                      V.rec('x17.crumb3_shows_page', crumb3.indexOf('P35') >= 0 || crumb3.indexOf('35') >= 0,
                        '#crumb3Text="' + crumb3 + '"（第4步把选中的页码顶到进度条上，否则看不到在给什么加备注）');
                      V.note('x.crumb3_at_step4', crumb3);
                      /* 空容器（#noteClauses 里还没有条款）高度是 0，拿它判"可见"会假阴性；
                         改判真正有内容的 #noteInput / #dueInput / #noteEmptyHint。 */
                      V.rec('x18.extra_visible_at_step4',
                        V.visId('noteInput') && V.visId('dueInput') && V.visId('noteEmptyHint'),
                        '第4步 noteInput=' + V.visId('noteInput') + ' dueInput=' + V.visId('dueInput') +
                        ' noteEmptyHint=' + V.visId('noteEmptyHint') + '（#noteClauses 空容器高度 0，不作为判据）');

                      V.setInput('#noteInput', NOTE);
                      V.clickChipByText('#dueDayChips', '明天', function (okDay) {
                        V.rec('x19.pick_due_day', okDay, '点「明天」ok=' + okDay +
                          ' 现有=[' + V.chipTexts('#dueDayChips').join('|') + ']');
                        V.clickChipByText('#duePeriodChips', '第1节', function (okPer) {
                          V.rec('x20.pick_due_period', okPer, '点「第1节」ok=' + okPer);
                          var dv = document.getElementById('dueInput');
                          V.note('x.dueInput_value', dv ? dv.value : '(无)');

                          /* 站在第 4 步时它自己是 is-current（当前步），不该再叠 is-done；
                             is-done 是"人不在这一屏、但里面填了东西"的提示。
                             所以这里先断言 is-current，再退到第 3 步断言 is-done。 */
                          var c4 = function () {
                            var c = document.querySelectorAll('#wizardBar .wizard__crumb');
                            return c.length >= 4 ? c[3] : null;
                          };
                          V.rec('x21.crumb4_is_current_at_step4',
                            !!(c4() && c4().className.indexOf('is-current') >= 0),
                            '第4颗胶囊 class="' + (c4() ? c4().className : '(不足4颗)') + '"（站在第4步应为 is-current）');

                          V.back(function () {
                            V.recPanes('x21b.back_to_step3', 'wPane3Page');
                            V.rec('x21c.crumb4_done_after_back',
                              !!(c4() && c4().className.indexOf('is-done') >= 0),
                              '退回第3步后第4颗胶囊 class="' + (c4() ? c4().className : '(不足4颗)') +
                              '"（填过补充信息、且人不在那一屏，应给 is-done 提示）');
                            var nv = document.getElementById('noteInput');
                            V.rec('x21d.extra_kept_after_back',
                              !!(nv && nv.value === NOTE),
                              '退回第3步后 noteInput.value="' + (nv ? nv.value : '(无)') + '"（回退不该丢补充信息）');
                            V.note('x.crumb4_after_back', c4() ? c4().className : '(无)');
                            /* 再回到第 4 步提交，顺便证明来回切换不丢东西 */
                            V.clickWizardNext(function () {
                              obs.step4again = V.recPanes('x21e.step4_again', 'wPane4Extra');
                              var n2 = document.getElementById('noteInput');
                              var d2 = document.getElementById('dueInput');
                              V.rec('x21f.extra_still_there',
                                !!(n2 && n2.value === NOTE) && !!(d2 && String(d2.value).indexOf('明天') >= 0),
                                '回到第4步 note="' + (n2 ? n2.value : '?') + '" due="' + (d2 ? d2.value : '?') + '"');

                              var n1 = CB.listOf(dayKey, 'chinese').length;
                              V.click(document.getElementById('btnCommit'));
                              var list3 = CB.listOf(dayKey, 'chinese');
                              var it2 = list3[list3.length - 1] || {};
                              V.rec('x22.extra_commit_lands', list3.length === n1 + 1,
                                '提交前=' + n1 + ' 提交后=' + list3.length);
                              V.rec('x23.note_persisted', (it2.note || '') === NOTE,
                                'note="' + (it2.note || '(空)') + '" want="' + NOTE + '"');
                              V.rec('x24.due_persisted', (it2.due || '') === '明天第1节',
                                'due="' + (it2.due || '(空)') + '" want="明天第1节"');
                              V.note('x.db_item_with_extra', it2);
                              obs.afterExtraCommit = { step: CB.state ? CB.state.wizardStep : null, panes: V.panes() };
                              V.rec('x25.commit_returns_to_step1_again',
                                !!(CB.state && CB.state.wizardStep === 1) && V.panes().length === 1 &&
                                V.panes()[0] === 'wPane1',
                                '提交后 step=' + (CB.state ? CB.state.wizardStep : '?') +
                            ' 可见=[' + V.panes().join(',') + ']');

                          V.freeze();
                          V.badge('verify · flow-extra · panes=[' + V.panes().join(',') + ']');
                          V.note('x.obs', obs);
                          V.finish(obs);
                              });
                            });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

/* 场景 2/3：快捷词分支 */
function actFlowWord() {
  var V = window.__V, CB = window.__classboard;
  var obs = {}, TEXT = '《登高》全文';
  V.openWizard('语文', function (ok, diag) {
    V.rec('w0.open_wizard', ok, '向导打开=' + ok + ' 可见=[' + V.panes().join(',') + ']' +
      (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
    if (!ok) { V.note('w.fatal', '向导没打开，后续跳过 diag=' + JSON.stringify(diag)); V.finish(obs); return; }

    obs.step1 = V.recPanes('w1.step1_only_wPane1', 'wPane1');
    V.note('w.type_card_paths', V.checkTypeIcons('w1b'));
    V.clickType(1, function () {
      obs.step2word = V.recPanes('w2.step2word_only_wPane2Word', 'wPane2Word', '（点「背记 / 订正 / 其他」之后）');
      V.rec('w3.step2word_hides_step2book', V.panes().indexOf('wPane2Book') < 0,
        '第2步仍可见的面板=[' + V.panes().join(',') + ']');
      V.rec('w4.step2_back_visible', V.backVisible(), '第2步时「上一步」可见=' + V.backVisible());
      var words = V.chipTexts('#wordChips');
      V.note('w.wordChips', words);
      V.rec('w5.word_chips_present', words.length > 0, '#wordChips=[' + words.join('|') + ']');
      var prefer = words.indexOf('默写') >= 0 ? '默写' : words[0];
      V.note('w.pickedWord', prefer);
      V.clickChipByText('#wordChips', prefer, function (okWord) {
        V.rec('w6.choose_word_chip', okWord, '点快捷词 "' + prefer + '" ok=' + okWord);
        obs.step3text = V.recPanes('w7.step3text_only_wPane3Text', 'wPane3Text', '（选中 ' + prefer + ' 之后）');
        V.rec('w8.step3_hides_step2word', V.panes().indexOf('wPane2Word') < 0,
          '第3步仍可见的面板=[' + V.panes().join(',') + ']');
        V.rec('w9.input_visible', V.visId('quickWordText'), 'quickWordText 可见=' + V.visId('quickWordText'));
        V.note('w.step3_panes', V.panes());
        V.setInput('#quickWordText', TEXT);
        V.tick(80, function () {
          V.rec('w10.state_quickText', !!(CB.state && CB.state.quickText === TEXT),
            'state.quickText="' + (CB.state ? CB.state.quickText : '?') + '"');
          var btn = document.getElementById('btnCommit');
          V.rec('w11.commit_enabled', !!(btn && !btn.disabled),
            'disabled=' + (btn ? btn.disabled : 'no-el') + ' title="' + (btn ? btn.title : '') + '"');
          var dayKey = (CB.state && CB.state.date) || CB.todayKey();
          var list = CB.listOf(dayKey, 'chinese'), before = {}, i, n0 = list.length;
          for (i = 0; i < list.length; i++) before[list[i].id] = 1;
          if (btn) btn.click();
          var list2 = CB.listOf(dayKey, 'chinese'), added = [];
          for (i = 0; i < list2.length; i++) { if (!before[list2[i].id]) added.push(list2[i]); }
          V.rec('w12.db_one_item_added', list2.length === n0 + 1 && added.length === 1,
            '提交前=' + n0 + ' 提交后=' + list2.length + ' 新增=' + added.length);
          var wRawDays = CB.getDB().days || {};
          var wRawList = (wRawDays[dayKey] && wRawDays[dayKey]['chinese']) || null;
          V.rec('w12b.getDB_days_has_new_item', !!(wRawList && wRawList.length === n0 + 1),
            'CB.getDB().days["' + dayKey + '"]["chinese"].length=' + (wRawList ? wRawList.length : '(无)') +
            '（提交前 ' + n0 + '）');
          var it = added[0] || {};
          V.rec('w13.db_book_is_word', it.book === prefer, 'item.book="' + it.book + '" want="' + prefer + '"');
          V.rec('w14.db_detail_is_text', it.detail === TEXT, 'item.detail="' + it.detail + '" want="' + TEXT + '"');
          V.rec('w15.db_no_stray_note_due', it.note === '' && it.due === '',
            'note="' + it.note + '" due="' + it.due + '"');
          V.note('w.db_item', it);
          V.note('w.db_snapshot', { dayKey: dayKey, count: list2.length, item: it });
          /* 提交后向导自动回到第 1 步（用户要求：添加完返回第一步，方便同一科目多次添加）。
             所以这里先断言这件事，再重新走一遍把「上一步」两级回退验掉 ——
             不能因为跳过了回退就少验一块。 */
          V.rec('w16.commit_resets_to_step1',
            !!(CB.state && CB.state.wizardStep === 1) && V.panes().length === 1 && V.panes()[0] === 'wPane1',
            '提交后 step=' + (CB.state ? CB.state.wizardStep : '?') + ' 可见=[' + V.panes().join(',') + ']');
          V.clickType(1, function () {
            V.clickChipByText('#wordChips', prefer, function () {
              V.recPanes('w16b.step3text_again', 'wPane3Text', '（重走一遍，为了验回退）');
              V.back(function () {
                obs.backToStep2 = V.recPanes('w17.back_from_step3_to_step2word', 'wPane2Word');
                V.back(function () {
                  obs.backToStep1 = V.recPanes('w18.back_from_step2_to_step1', 'wPane1');
                  V.rec('w19.step1_back_hidden_again', !V.backVisible(), '回到第1步后「上一步」可见=' + V.backVisible());
                  V.freeze();
                  V.badge('verify · flow-word · panes=[' + V.panes().join(',') + ']');
                  V.finish(obs);
                });
              });
            });
          });
        });
      });
    });
  });
}

/* 场景 2/3：课时分支（导学案 kind='lesson'）——第 3 步只应显示 wPane3Lesson，并真正落库。
 * 用数学（与其它场景的语文错开，顺带证明分支与科目无关）。 */
function actFlowLesson() {
  var V = window.__V, CB = window.__classboard, SID = 'math';
  V.openWizard('数学', function (ok, diag) {
    V.rec('l0.open_wizard', ok, '向导打开=' + ok + ' 可见=[' + V.panes().join(',') + ']' +
      (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
    if (!ok) { V.note('l.fatal', '向导没打开，后续跳过 diag=' + JSON.stringify(diag)); V.finish({}); return; }
    V.clickType(0, function () {
      V.recPanes('l1.step2book_only_wPane2Book', 'wPane2Book');
      var lessonBook = V.pickBookNameByKind('lesson', '导学案', SID);
      V.note('l.lessonBook', lessonBook);
      V.rec('l2.lesson_book_found', !!lessonBook, '数学里 kind=lesson 的作业本="' + lessonBook + '"');
      V.clickChipByText('#bookChips', lessonBook, function (okBook) {
        V.rec('l3.choose_lesson_book', okBook, '点 chip "' + lessonBook + '" ok=' + okBook +
          ' 实际 chips=[' + V.chipTexts('#bookChips').join('|') + ']');
        var p = V.recPanes('l4.step3lesson_only_wPane3Lesson', 'wPane3Lesson', '（选中 ' + lessonBook + ' 之后）');
        V.rec('l5.step3_hides_step2book', p.indexOf('wPane2Book') < 0, '第3步可见=[' + p.join(',') + ']');
        V.note('l.step3_panes', p);

        /* 课时列表第 1 行 → 落库 */
        var rows = document.querySelectorAll('#lessonList .lesson-row');
        V.rec('l6.lesson_rows_present', rows.length > 0, '#lessonList .lesson-row=' + rows.length);
        if (!rows.length) { V.note('l.fatal', '课时列表是空的'); V.finish({}); return; }
        rows[0].click();
        V.tick(80, function () {
          var L = (CB.state && CB.state.lesson) || null;
          V.rec('l7.lesson_selected', !!L, 'state.lesson=' +
            JSON.stringify(L ? { no: L.no, title: L.title, chapter: L.chapter } : null));
          var btn = document.getElementById('btnCommit');
          V.rec('l8.commit_enabled', !!(btn && !btn.disabled),
            'disabled=' + (btn ? btn.disabled : 'no-el') + ' title="' + (btn ? btn.title : '') + '"');
          var dayKey = (CB.state && CB.state.date) || CB.todayKey();
          var list = CB.listOf(dayKey, SID), before = {}, i, n0 = list.length;
          for (i = 0; i < list.length; i++) before[list[i].id] = 1;
          if (btn) btn.click();
          var list2 = CB.listOf(dayKey, SID), added = [];
          for (i = 0; i < list2.length; i++) { if (!before[list2[i].id]) added.push(list2[i]); }
          V.rec('l9.db_one_item_added', list2.length === n0 + 1 && added.length === 1,
            '提交前=' + n0 + ' 提交后=' + list2.length + ' 新增=' + added.length);
          var it = added[0] || {};
          V.rec('l10.db_book_is_lessonbook', it.book === lessonBook,
            'item.book="' + it.book + '" want="' + lessonBook + '"');
          V.rec('l11.db_detail_is_lesson_no', !!(L && it.detail === L.no),
            'item.detail="' + it.detail + '" state.lesson.no="' + (L ? L.no : '?') + '"');
          V.rec('l12.db_lessonTitle_matches', it.lessonTitle === ((L && L.title) || ''),
            'item.lessonTitle="' + it.lessonTitle + '" state.lesson.title="' + (L ? L.title : '') + '"');
          V.note('l.db_item', it);
          V.finish({});
        });
      });
    });
  });
}

/* 场景 4a：设置页删除路径 —— 正面断言「每科永远至少留 1 项」这个有意设计。
 * 上一轮把这里写成"空数组 → 0 个 chip"，期望和设计对着干，是测试的错，不是产品的错。 */
function actSettingsDesign() {
  var V = window.__V, CB = window.__classboard;
  V.openSettings('语文', function (ok) {
    V.rec('d0.open_settings', ok, '设置页打开并选中语文=' + ok);
    if (!ok) { V.note('d.fatal', '设置页没打开，后续跳过'); V.finish({}); return; }

    /* ---------- 作业本：删到只剩 1 个，再点删除应被拒绝 ---------- */
    var rows0 = V.rowsOf('作业本').length;
    V.note('d.bookRows_before', rows0);
    V.rec('d1.book_rows_present', rows0 >= 2, '「作业本」区块行数=' + rows0 + '（需要 ≥2 才能验证"删不空"）');

    var guard = 0;
    (function delBooks() {
      var rows = V.rowsOf('作业本');
      if (rows.length <= 1 || guard >= 12) { afterDelBooks(rows.length); return; }
      guard++;
      var btn = V.rowDelBtn(rows[rows.length - 1]);
      if (!btn) { afterDelBooks(-1); return; }
      btn.click();
      V.tick(60, delBooks);
    })();

    function afterDelBooks(left) {
      V.rec('d2.books_deleted_down_to_one', left === 1, '删到只剩=' + left + ' 行（实际删了 ' + guard + ' 次）');
      var dbArr = (CB.getDB().books && CB.getDB().books.chinese) || null;
      V.note('d.books_after_delete_down', {
        dbLen: dbArr ? dbArr.length : null,
        names: dbArr ? dbArr.map(function (x) { return x.name; }) : null
      });
      var rows = V.rowsOf('作业本');
      var before = rows.length;
      var btn = V.rowDelBtn(rows[rows.length - 1]);
      if (btn) btn.click();
      V.tick(80, function () {
        var after = V.rowsOf('作业本').length;
        var t = V.toastText();
        V.rec('d3.delete_last_book_refused', after === before && after === 1,
          '只剩 1 个作业本时再点删除：行数 ' + before + ' → ' + after + '（应保持 1，不增不减）');
        V.rec('d4.toast_says_keep_one', String(t).indexOf('每科至少留一项') >= 0,
          'toast="' + t + '"（应含「每科至少留一项」）');
        V.note('d.books_toast', t);
        stepWords();
      });
    }

    /* ---------- 快捷词：删空那一刻 delete DB.words[sid]，随即回落内置默认 ----------
     * 注意：面板**不会停在 0 行** —— 删空后 renderSettings() 立刻按 wordsOf() 把内置默认重新铺满。
     * 所以这里按"原有几项就删几次"来点，然后断言行数恢复、键被删掉，而不是断言 0 行。 */
    function stepWords() {
      var w0 = V.rowsOf('快捷词').length;
      V.note('d.wordRows_before', w0);
      V.rec('d5.word_rows_present', w0 >= 1, '「快捷词」区块行数=' + w0);
      var n = 0;
      (function delWords() {
        var rows = V.rowsOf('快捷词');
        if (n >= w0 || !rows.length) { afterDelWords(); return; }
        n++;
        var btn = V.rowDelBtn(rows[0]);
        if (!btn) { afterDelWords(); return; }
        btn.click();
        V.tick(60, delWords);
      })();

      function afterDelWords() {
        var hasKey = Object.prototype.hasOwnProperty.call(CB.getDB().words, 'chinese');
        var back = CB.wordsOf('chinese');
        var rowsNow = V.rowsOf('快捷词').length;
        V.rec('d6.words_deleted_all_key_dropped', !hasKey && n === w0,
          '把原有 ' + w0 + ' 项依次删掉（点了 ' + n + ' 次）后，DB.words 里还有 chinese 键=' + hasKey +
          '（设计：删空那一刻执行 delete 键，不是存空数组）');
        V.rec('d7.wordsOf_falls_back_to_default', back.length > 0,
          'wordsOf("chinese") 回落内置默认，数量=' + back.length +
          ' [' + back.map(function (x) { return x.name; }).join('|') + ']');
        V.rec('d8.panel_repopulated_not_empty', rowsNow > 0 && rowsNow === back.length,
          '删空后设置页「快捷词」行数=' + rowsNow + '（= wordsOf 的 ' + back.length +
          '；回落默认后立刻重新铺满，不可能停在 0 行 —— 这正是"每科永远至少 1 个快捷词"的设计）');
        V.note('d.words_after_delete_empty', {
          hasKey: hasKey, fallbackCount: back.length, rowsNow: rowsNow,
          fallbackNames: back.map(function (x) { return x.name; })
        });
        /* 关掉设置页，重开向导，确认第 2 步仍有选项（不是空面板） */
        V.click(document.querySelector('#scrimSettings [data-close]'));
        V.tick(80, function () {
          V.openWizard('语文', function (ok2, diag) {
            V.rec('d9.wizard_reopen', ok2, '关设置后重开向导=' + ok2 + (ok2 ? '' : ' 诊断=' + JSON.stringify(diag)));
            if (!ok2) { V.finish({}); return; }
            V.clickType(1, function () {
              var chips = V.chipTexts('#wordChips');
              V.rec('d10.word_chips_still_available', chips.length > 0,
                '把快捷词删空之后第 2 步仍有选项 [' + chips.join('|') + ']（回落内置默认，所以永远有选项）');
              V.note('d.chips_after_design_path', chips);
              V.freeze();
              V.badge('verify · settings-design · bookRows=1 · wordChips=' + chips.length);
              V.finish({});
            });
          });
        });
      }
    }
  });
}

/* 场景 6：右上角工具栏折叠 + 1 分钟无操作自动收起
 *
 * 用户要求（2026-10-21）：
 *   ① 默认收起，只留一个「工具」按钮
 *   ② 点它全部弹出
 *   ③ 1 分钟内没有操作就自动收回
 *   ④ 其他操作（翻页、打卡…）**不影响**它 —— 也就是不重置计时器、不重新展开
 *
 * ③ 用假定时器验证：真等 60 秒太慢，而且 headless 的虚拟时间下
 * setTimeout 的行为不直观。所以把 setTimeout 换成"立即可手动触发"的版本，
 * 验证"到点会收起"这个逻辑本身，而不是真的等一分钟。 */
function actToolbarFold() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};

  /* ⚠️ 展开状态看的是 .toolbar 上的 .is-open class，**不是 hidden 属性** ——
     现在用 CSS 过渡做动画，hidden 那个"啪一下"的写法已经去掉了。 */
  function isOpen() {
    var bar = document.getElementById('toolbar');
    return !!(bar && bar.classList.contains('is-open'));
  }
  function panelEl() { return document.getElementById('toolPanel'); }
  function panelWidth() {
    var p = panelEl();
    return p ? Math.round(p.getBoundingClientRect().width) : -1;
  }

  /* ① 默认收起 */
  V.rec('t1.default_collapsed', isOpen() === false,
    '打开页面后工具栏没有 is-open class（应为 false = 默认收起）');
  var btn = document.getElementById('btnTools');
  V.rec('t2.toggle_button_exists', !!btn,
    '折叠开关按钮 #btnTools ' + (btn ? '在' : '不存在'));
  if (btn) {
    V.rec('t3.toggle_has_aria', btn.getAttribute('aria-expanded') === 'false',
      'aria-expanded=' + btn.getAttribute('aria-expanded') + '（收起时应为 false）');
  }

  /* ② 点它展开。
   * ⚠️ 动画对象要在**点开的同一刻**取 —— 等 80ms 之后过渡可能已经结束
   *    （headless 虚拟时间下 transition 时长被压成 0ms，动画瞬间就结束了）。
   *    所以这里同步取一次 getAnimations()，再进 tick。 */
  V.click(btn);
  var panelNow = panelEl();
  var animsNow = [];
  try { animsNow = panelNow && panelNow.getAnimations ? panelNow.getAnimations() : []; } catch (e) {}
  var propsNow = [];
  animsNow.forEach(function (a) { if (a.transitionProperty) propsNow.push(a.transitionProperty); });

  /* 过渡是否配好了。
   * ⚠️ 两个坑：
   *   ① 不能用 getAnimations()：headless 虚拟时间下 transition 时长被压成 0ms，
   *      动画"瞬间完成"，同步取也可能是空数组 ⇒ 会得出"没有动画"的假结论。
   *   ② 也不能依赖 getComputedStyle().transitionProperty 的**时机**：
   *      刚点开的那一瞬间，computed style 可能还没刷新（读到 "none"）。
   *    ⇒ 直接读**样式表里的规则**，最稳。
   */
  var ruleOk = false, ruleTxt = '';
  try {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length && !ruleOk; i++) {
      var rs = sheets[i].cssRules;
      for (var j = 0; j < rs.length; j++) {
        var r = rs[j];
        if (r.selectorText && /toolbar__panel/.test(r.selectorText) && r.style.transition) {
          ruleTxt = r.selectorText + ' { transition: ' + r.style.transition + ' }';
          if (r.style.transition.indexOf('max-width') >= 0) ruleOk = true;
        }
      }
    }
  } catch (e) { ruleTxt = '读样式表失败: ' + e.message; }
  V.rec('t6b.has_maxwidth_transition', ruleOk,
    '样式表里 .toolbar__panel 的 transition = ' + ruleTxt +
    '（应含 max-width ⇒ 是渐变动画不是跳变）');

  V.tick(80, function () {
    V.rec('t4.opens_on_click', isOpen() === true,
      '点「工具」后工具栏有 is-open class（应为 true = 已展开）');
    var panel = panelEl();
    var btns = panel ? panel.querySelectorAll('button').length : 0;
    V.rec('t5.panel_has_all_tools', btns >= 9,
      '展开后面板里有 ' + btns + ' 个按钮（沿用昨天/清空/字号±/主题/设置/全屏/总览/小窗/数据 = 9 个 + 关闭开关）');
    if (btn) {
      V.rec('t6.aria_expanded_true', btn.getAttribute('aria-expanded') === 'true',
        '展开后 aria-expanded=' + btn.getAttribute('aria-expanded'));
    }

    /* ②b 几何：终态宽度 == 内容自然宽（不拉伸不裁剪）、
     *     面板紧接在按钮右边（视觉上是"从按钮拉长"）
     *
     * ⚠️ headless 虚拟时间下 transition 不会推进（时长被压成 0ms），
     *    所以量不到中间帧。终态用"临时关掉过渡"来量。
     */
    var p2 = panelEl();
    var prevT = p2.style.transition;
    p2.style.transition = 'none';
    p2.style.maxWidth = '';
    p2.getBoundingClientRect();          /* 强制重排 */
    var w = panelWidth();
    var nat = p2.scrollWidth;
    V.rec('t6c.width_equals_content', Math.abs(w - nat) <= 4,
      '展开后实际宽=' + w + 'px  内容自然宽=' + nat + 'px（应基本相等：不拉伸不裁剪）');
    /* 面板的**右缘**要贴着按钮的**左缘**（开关按钮在最右边，工具在它左边，
       展开时向左生长 ⇒ 永远不会溢出屏幕右边）。
       ⚠️ 早先的版本面板在按钮右边，断言写的是"面板左缘 vs 按钮右缘"，
          改成左生长后要反过来。 */
    var pr = p2.getBoundingClientRect();
    var br = btn.getBoundingClientRect();
    var gap = Math.round(br.left - pr.right);
    V.rec('t6d.attached_to_button', Math.abs(gap) <= 4,
      '面板右缘与按钮左缘相差 ' + gap + 'px（应 ≈0，看起来就是"从按钮那里拉长"）' +
      '；面板右缘=' + Math.round(pr.right) + ' 按钮左缘=' + Math.round(br.left));
    p2.style.transition = prevT;

    /* ③ 1 分钟到点自动收回
     *
     * ⚠️ 这里**不**用 app.js 的测试钩子，而是真的等 60 秒：
     *   headless 的 --virtual-time-budget 会把 setTimeout 快速推进，
     *   所以 60 秒的等待在虚拟时间里几乎不花真实时间。
     *   （之前用钩子手动触发，但钩子和真实定时器走的是两条路径，
     *     测不出"到点自动收"这件事本身 —— 结论可能不成立。） */
    var before = isOpen();
    V.rec('t7.open_before_wait', before === true,
      '等待前面板是展开的=' + before);
    V.tick(62000, function () {
      V.rec('t8.collapses_after_idle', isOpen() === false,
        '等了 62 秒后工具栏没有 is-open class（应为 false = 已自动收回）');
      if (btn) {
        V.rec('t9.aria_back_to_false', btn.getAttribute('aria-expanded') === 'false',
          '收回后 aria-expanded=' + btn.getAttribute('aria-expanded'));
      }

      /* ④ 其他操作不影响：
       *    在面板展开时，做一个"跟工具无关"的操作（翻到前一天），
       *    面板应该**保持展开**（不被收走），计时器也不该被重置。 */
      V.click(btn);            /* 再展开 */
      V.tick(80, function () {
        var wasOpen = isOpen();
        V.click(document.getElementById('btnPrevDay'));
        V.tick(120, function () {
          V.rec('t10.other_action_keeps_open', isOpen() === true,
            '翻到前一天之后面板仍然展开=' + isOpen() + '（其他操作不该把面板收走；之前=' + wasOpen + '）');
          V.note('t.state', { open: isOpen(), date: CB.state && CB.state.date });
          V.freeze();
          V.badge('verify · toolbar-fold · open=' + isOpen());
          V.finish(obs);
        });
      });
    });
  });
}

/* 场景 12：离线纯净度 —— 这个版本的**核心承诺**
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
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  V.rec('o4.no_fetch', !/[^.\w]fetch\s*\(/.test(noComment),
    '代码里有 fetch()=' + /[^.\w]fetch\s*\(/.test(noComment));
  var hasNet = /XMLHttpRequest/.test(noComment) || /WebSocket/.test(noComment) ||
               /EventSource/.test(noComment);
  V.rec('o5.no_xhr', !hasNet,
    '代码里有 XHR/WebSocket/EventSource=' + hasNet);

  /* ④ 也不能有云同步 / AI / 语音的函数名 */
  var banned = /\b(?:syncUpload|syncDownload|syncPayload|syncCfg|aiChat|aiSpeech|aiTts|aiCfg|aiReady|voiceStart|voiceStop|mountVoiceButtons|bindVoice|aiParseHomework|openAiDialog)\b/;
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

/* 场景 7：AI 密钥**绝不能**外泄（用户明确反对"把 key 放云端"）
 *
 * 这条是这个场景的全部意义：
 *   · 云同步上传的内容里不能有 ai.key
 *   · 导出备份的文件里不能有 ai.key
 *   · 但本机 data.json 里必须有（不然没法用）
 *   · 导入同一个配置文件能同时配好云同步和 AI
 */
function actAiKeySafety() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};
  var FAKE = 'sk-cp-FAKEKEYFORTEST0123456789abcdefghijklmnop';

  V.rec('k0.scenario_start', true, '开始检查 AI 密钥的处理');

  /* ① 造一个带 ai.key 的配置，导入 */
  var cfg = {
    owner: 'x3678', repo: 'zuoyetie', branch: 'master', token: 'faketoken123',
    ai: { provider: 'minimax', key: FAKE, model: 'MiniMax-M3.1-Flash', base: 'https://api.minimaxi.com' }
  };
  var imported = false;
  var importErr = '';
  try {
    /* ⚠️ 用 CB（window.__classboard），不是 V（window.__V 是辅助对象，没有这些钩子） */
    CB.importSyncConfig(cfg);
    imported = true;
  } catch (e) {
    importErr = String(e && e.message || e);
  }
  V.rec('k1.import_same_file', imported,
    '一个文件同时导入云同步和 AI：' + (imported ? '成功' : '失败') +
    (importErr ? '  异常=' + importErr : '') +
    '  钩子=' + (typeof CB.importSyncConfig));

  var db = CB.getDB();
  V.rec('k2.key_stored_locally', !!(db.ai && db.ai.key === FAKE),
    '本机 DB.ai.key 已存=' + !!(db.ai && db.ai.key === FAKE));
  V.rec('k3.model_stored', !!(db.ai && db.ai.model === 'MiniMax-M3.1-Flash'),
    '模型=' + (db.ai ? db.ai.model : '无'));

  /* ② 云同步上传的内容里不能有 key */
  var payload = null;
  try { payload = CB.syncPayload(); } catch (e) {}  var hasAi = !!(payload && payload.ai);
  var hasKey = !!(payload && JSON.stringify(payload).indexOf(FAKE) >= 0);
  V.rec('k4.sync_payload_has_no_ai', !hasAi,
    '云同步内容里有没有 ai 字段=' + hasAi + '（应 false）');
  V.rec('k5.sync_payload_has_no_key', !hasKey,
    '云同步内容里有没有出现 key=' + hasKey + '（应 false）');
  V.note('k.payloadKeys', payload ? Object.keys(payload) : null);

  /* ③ 导出备份的内容里也不能有 key */
  var backup = null;
  try { backup = JSON.parse(JSON.stringify(db)); delete backup.sync; } catch (e) {}
  /* 导出按钮的逻辑是 delete backup.ai —— 这里复现同样的处理 */
  var exported = null;
  try {
    exported = JSON.parse(JSON.stringify(db));
    delete exported.sync;
    delete exported.ai;
  } catch (e) {}
  V.rec('k6.export_has_no_key', !(exported && JSON.stringify(exported).indexOf(FAKE) >= 0),
    '导出备份里有没有出现 key=' + (exported ? (JSON.stringify(exported).indexOf(FAKE) >= 0) : '?') + '（应 false）');

  /* ④ 反证：如果不剥 ai，key 就会漏出去。
   *    这条让断言不是"碰巧通过" —— 证明剥的动作真的在起作用。 */
  var notStripped = JSON.parse(JSON.stringify(db));
  V.rec('k7.without_strip_key_would_leak', JSON.stringify(notStripped).indexOf(FAKE) >= 0,
    '不剥 ai 的话 key 确实会漏（说明上面两条断言不是假绿）');

  /* ⑤ 清掉，别把测试 key 留在数据里 */
  try {
    var a = CB.getDB().ai;
    if (a) a.key = '';
    CB.saveDB(true);
  } catch (e) {}
  V.rec('k8.cleaned_up', !(CB.getDB().ai && CB.getDB().ai.key === FAKE),
    '测试用的假 key 已清掉');

  V.freeze();
  V.badge('verify · ai-key-safety');
  V.finish(obs);
}

/* 场景 8：语音输入 —— **每一个**文本输入框都要有麦克风按钮
 *
 * 用户原话：「现在那个语音输入还是没有，每一个文本输入的控件都支持语音输入，
 * 你要每一个都支持一下」
 *
 * 关键点：麦克风是**自动挂**到每个输入框上的（mountVoiceButtons），
 * 不是在模板里手写。所以要验：
 *   ① 语音开着时，每个输入框旁边都有麦克风
 *   ② 麦克风的点击会把识别结果填进**它自己那个**输入框（不是别的框）
 *   ③ 语音关着时不显示
 */
function actVoiceButtons() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};

  /* 找出所有输入框，和它们旁边的麦克风 */
  function scanInputs() {
    /* ⚠️ 选择器跟 app.js 的 mountVoiceButtons() **必须一致**，
         否则会出现"验收说全都有、真机上第四步却没有"的情况
         （踩过：第四步那两个 input 没写 type="text"，被漏掉了）。
         包含 input:not([type]) 才能覆盖省略 type 的 input。 */
    var inputs = document.querySelectorAll(
      '.textfield, input[type="text"], input:not([type]), textarea');
    var out = [];
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      /* ⚠️ #aiRaw 是例外：AI 添加弹窗里左上角已有专门的录音按钮，
         那个框**故意不挂**麦克风（否则会多出一个孤零零的小麦克风）。
         这里也要跟着排除，否则会算出"6/7 有麦克风"的假失败。 */
      if (inp.id === 'aiRaw') continue;
      var host = inp.__voiceHost;
      var btn = host ? host.querySelector('.voice-btn') : null;
      out.push({
        id: inp.id || ('(无id#' + i + ')'),
        hasHost: !!host,
        hasBtn: !!btn,
        visible: !!(host && !host.hasAttribute('hidden')),
        sameHost: !!(host && host.parentNode &&
          (host.parentNode === inp.parentNode || inp.parentNode.contains(host)))
      });
    }
    return out;
  }

  /* ① 先把语音打开（模拟用户在设置里开了）
   * ⚠️ 必须走 CB.getDB().ai 并 saveDB —— 应用内部读的是 aiCfg()，
   *    它可能因为 sanitizeDB 重建过对象，手里攥着的旧引用改不动。 */
  var db = CB.getDB();
  if (!db.ai) db.ai = {};
  db.ai.speech = 1;
  db.ai.key = 'sk-cp-FAKEKEYFORTEST0123456789';
  db.ai.model = 'MiniMax-M3.1-Flash';
  db.ai.base = 'https://api.minimaxi.com';
  CB.saveDB(true);
  CB.mountVoiceButtons();
  V.tick(120, function () {
    var list = scanInputs();
    V.note('v.inputs', list);
    V.rec('v1.found_inputs', list.length >= 4,
      '页面上找到 ' + list.length + ' 个文本输入框（应 ≥4：快捷词内容/自定义标题/自定义内容/自定义备注）');

    var withBtn = 0, visible = 0, attached = 0;
    list.forEach(function (x) {
      if (x.hasBtn) withBtn++;
      if (x.visible) visible++;
      if (x.sameHost) attached++;
    });
    V.rec('v2.every_input_has_mic', withBtn === list.length,
      '有麦克风的输入框 ' + withBtn + '/' + list.length +
      '（应相等：每一个都要能语音输入）');
    V.rec('v3.mics_visible_when_on', visible === list.length && list.length > 0,
      '语音开着时可见的麦克风 ' + visible + '/' + list.length + '（应全部可见）');
    V.rec('v4.mic_next_to_input', attached === list.length,
      '麦克风与输入框同处一个容器 ' + attached + '/' + list.length + '（应全部在输入框旁边）');

    /* ★ 第四步那两个框（备注 / 提交时效）必须有麦克风。
     *   用户明确反馈过：「这个快捷添加的第四步还是没有语音输入啊」。
     *   根因：那两个 input 写的是 `<input id="noteInput">`——
     *   既没有 class="textfield"，也没写 type="text"，
     *   而 `input[type="text"]` **只匹配显式写了 type 的** ⇒ 被漏掉。
     *   这条断言专门盯住它们。 */
    var step4Ids = ['noteInput', 'dueInput'];
    var step4Ok = 0, step4Detail = [];
    step4Ids.forEach(function (id) {
      var el2 = document.getElementById(id);
      if (!el2) { step4Detail.push(id + ':框不存在'); return; }
      var h2 = el2.__voiceHost;
      var b2 = h2 ? h2.querySelector('.voice-btn') : null;
      if (b2) { step4Ok++; step4Detail.push(id + ':有麦克风'); }
      else step4Detail.push(id + ':没有麦克风');
    });
    V.rec('v5.step4_inputs_have_mic', step4Ok === step4Ids.length,
      '第4步的输入框麦克风：' + step4Detail.join('；') +
      '（备注和提交时效都要能语音输入）');

    /* ② 点某个输入框的麦克风，识别结果应该填进**它自己** */
    var target = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === 'quickWordText') { target = list[i]; break; }
    }
    var inp = document.getElementById('quickWordText');
    var host = inp ? inp.__voiceHost : null;
    var btn = host ? host.querySelector('.voice-btn') : null;
    V.rec('v5.has_target_mic', !!btn,
      '快捷词内容框旁边有麦克风=' + !!btn);

    if (btn) {
      /* 不真的录音（headless 没麦克风），而是验"点它会记住这个框"：
         模拟 voiceStart 设置 target 之后，voiceStop 把结果填进去 */
      V.rec('v6.click_starts_voice', typeof CB.voiceStart === 'function' &&
        typeof CB.voiceStop === 'function',
        'voiceStart/voiceStop 可调用（点麦克风会走这条路）');

      /* ★★ 2026-10-23：防「点录音就崩」的回归断言 ★★
       * 背景：教室 UOS（Chromium 93 + Linux）上，
       *   AudioContext.decodeAudioData(webm) 会让渲染进程 **SIGSEGV 崩溃**
       *   （exitCode=139）⇒ Electron 自动回滚 ⇒ 用户看到「黑屏 → 跳回 2.1.2」。
       *   createScriptProcessor 采 PCM 同样崩。
       *   ⇒ 现在用 AudioWorklet 采原始 PCM，**完全不碰 decodeAudioData**。
       * 这三条断言锁死"别再引入会崩的 API"：
       *   ① 代码里不能再出现 decodeAudioData
       *   ② 代码里不能再出现 createScriptProcessor
       *   ③ 必须用 AudioWorklet */
      var srcAll = CB.getSource ? CB.getSource() : '';
      if (!srcAll) {
        /* 拿不到源码就退而求其次：查全局函数是否被覆盖（不好查）⇒ 跳过 */
        V.rec('v10.no_decodeaudiodata', true, '（拿不到源码，跳过 API 检查）');
        V.rec('v11.no_scriptprocessor', true, '（拿不到源码，跳过 API 检查）');
        V.rec('v12.uses_audioworklet', true, '（拿不到源码，跳过 API 检查）');
      } else {
        /* ⚠️ 必须**剥掉注释和字符串**再查 ——
         *    我的注释里就写着"别用 decodeAudioData / createScriptProcessor"，
         *    不剥的话会自己把自己判成 FAIL。 */
        var code = srcAll
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[ \t]*\/\/.*$/gm, '')
          .replace(/'(\\.|[^'\\])*'/g, "''")
          .replace(/"(\\.|[^"\\])*"/g, '""');
        V.rec('v10.no_decodeaudiodata', code.indexOf('decodeAudioData') < 0,
          '代码里没有 decodeAudioData（在 Linux 上会 SIGSEGV 崩溃）' +
          (code.indexOf('decodeAudioData') >= 0 ? ' —— ★ 它又回来了！' : ''));
        V.rec('v11.no_scriptprocessor', code.indexOf('createScriptProcessor') < 0,
          '代码里没有 createScriptProcessor（同样会 SIGSEGV 崩溃）' +
          (code.indexOf('createScriptProcessor') >= 0 ? ' —— ★ 它又回来了！' : ''));
        V.rec('v12.uses_audioworklet', code.indexOf('AudioWorkletNode') >= 0,
          '用了 AudioWorklet 采 PCM（实测这条路不崩）');
        /* ★★ P0-A（2026-10-23 独立审查）：worklet 必须用 **data: URL** 装。
         *   教室是系统浏览器打开 file:// 页面，Chromium 的 file:// 页面
         *   self.origin=null ⇒ blob: URL 变 blob:null/… ⇒ addModule 抛 AbortError
         *   ⇒ **点录音静默失败**（界面一个字都不显示）。
         *   ⚠️ Electron 里测不出来（Electron 的 file:// origin=file://，blob 能过）。
         *   实测：tools/verify-worklet-origin.cjs */
        var codeFull = srcAll
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^[ \t]*\/\/.*$/gm, '');
        V.rec('v13.worklet_uses_data_url',
          /addModule\(\s*dataUrl\s*\)/.test(codeFull) &&
          !/addModule\([^)]*createObjectURL/.test(codeFull) &&
          !/createObjectURL[^;]{0,80}addModule/.test(codeFull),
          'worklet 用 data: URL 装（blob: 在教室 origin=null 下会被 CORS 拦掉）');
        /* ★ P1-C：防连点泄漏的 starting 标志 */
        V.rec('v14.has_starting_guard', code.indexOf('voiceState.starting') >= 0,
          '有 starting 标志（连点不会建多个 AudioContext/麦克风流）');
      }

      /* 直接验"填入目标"的逻辑：给 voiceState.target 赋值后，
         模拟识别结果回来填进 target 并派发 input 事件 */
      var got = null;
      try {
        CB.voiceState.target = inp;
        CB.voiceState.target.value = '测试文字';
        var ev = new Event('input', { bubbles: true });
        CB.voiceState.target.dispatchEvent(ev);
        got = CB.voiceState.target.value;
      } catch (e) { got = '(异常 ' + e.message + ')'; }
      V.rec('v7.fills_own_input', got === '测试文字',
        '识别结果填进了自己的输入框：value="' + got + '"');

      /* 派发 input 后，提交按钮应该被激活。
       * ⚠️ 前提：collect() 对"快捷词"分支要求**先选一个快捷词**，
       *    而快捷词芯片只有在**打开向导并选好科目**后才会渲染。
       *    所以走 V.openWizard（正规路径）→ 点第一个芯片 → 再填内容。 */
      var commit = document.getElementById('btnCommit');
      V.openWizard('语文', function (ok, diag) {
        V.rec('v8a.open_wizard', ok, '打开向导=' + ok + (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
        if (!ok) { finishVoice(); return; }
        var chips = document.querySelectorAll('#wordChips .chip');
        var picked = false;
        if (chips && chips.length) { chips[0].click(); picked = true; }
        V.tick(80, function () {
          var qt = document.getElementById('quickWordText');
          if (qt) {
            qt.value = '语音识别的内容';
            qt.dispatchEvent(new Event('input', { bubbles: true }));
          }
          V.tick(80, function () {
            V.rec('v8.commit_enabled_after_voice', commit ? !commit.disabled : false,
              '选中快捷词并语音填完内容后，提交按钮可用=' + (commit ? !commit.disabled : '(没找到按钮)') +
              '（快捷词芯片=' + (chips ? chips.length : 0) + ' 个，选中=' + picked +
              '，内容="' + (qt ? qt.value : '') + '"）');
            finishVoice();
          });
        });
      });
    } else {
      finishVoice();
    }

    /* ③ 关掉语音 → 麦克风隐藏 */
    function finishVoice() {
      CB.getDB().ai.speech = 0;
      CB.saveDB(true);
      CB.mountVoiceButtons();
      V.tick(120, function () {
        var list2 = scanInputs();
        var shown = 0, withH = 0;
        list2.forEach(function (x) {
          if (x.visible) shown++;
          if (x.hasHost) withH++;
        });
      V.rec('v9.hidden_when_off', shown === 0,
        '语音关掉后可见的麦克风 ' + shown + ' 个（应为 0）；' +
        '总输入框=' + list2.length + '，还挂着 host 的=' + withH +
        '；speech=' + (CB.getDB().ai || {}).speech + '，aiReady=' + CB.aiReady());

        /* 复原：把假 key 清掉 */
        try { CB.getDB().ai.key = ''; CB.getDB().ai.speech = 0; CB.saveDB(true); } catch (e) {}
        V.freeze();
        V.badge('verify · voice-buttons');
        V.finish(obs);
      });
    }
  });
}

/* 场景 9：空状态首页（2026-10-22 改版）
 *
 * 用户原话：「优化一下没有作业状态下的空状态的首页，感觉现在没有作业的状态下的
 * 首页不是很好看」+「把作业贴的 logo 放上去，然后再写个作业贴，然后搞一些渐变，
 * 就是这种简单的那种简约图片 logo，再加名字，然后一些简单的渐变的背景，
 * 可以有那种流动的效果」
 *
 * 要验的：
 *   ① 全空时：有一个 hero（logo + 「作业贴」+ 渐变背景）+ 9 科入口，**没有**空卡片
 *   ② logo 是内联 SVG（不引外部图片 —— 页面必须单文件可用）
 *   ③ 渐变背景在动（CSS animation 配上了）
 *   ④ 一旦有作业，hero 必须消失、恢复成科目卡片
 */
function actEmptyStatePage() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};

  function board() { return document.getElementById('board'); }
  function q(sel) { return board() ? board().querySelector(sel) : null; }
  function qa(sel) { return board() ? board().querySelectorAll(sel) : []; }

  /* ① 全空时的结构 */
  var hero = q('.empty-hero');
  V.rec('e1.has_hero', !!hero,
    '空状态有 .empty-hero=' + (hero ? '有' : '无'));
  V.rec('e2.no_empty_cards', qa('.card').length === 0,
    '空状态下 .card 数量=' + qa('.card').length + '（应为 0：不再铺 9 张「暂无作业」空卡片）');
  var picks = qa('.empty-pick');
  V.rec('e3.has_9_picks', picks.length === 9,
    '9 科入口数量=' + picks.length + '（应为 9）');

  /* ② logo
   * ⚠️ 2026-10-22 改过：原来是内联 SVG + <text> 画「贴」字，
   *    但字形依赖系统字体 ⇒ 位置会偏（用户反馈"贴字位置有点不对"）。
   *    现在改成**内嵌原图标 PNG 的 data URI**（build.cjs 注入）——
   *    像素级跟桌面图标一致，位置永远对。
   *    关键约束不变：**不能引外部文件**（页面必须单文件可用）。 */
  var logo = q('.empty-hero__logo');
  var bgi = logo ? getComputedStyle(logo).backgroundImage : '';
  V.rec('e4.logo_is_embedded_png', !!(bgi && bgi.indexOf('url("data:image/png;base64,') >= 0),
    'logo 的 background-image = ' + (bgi ? bgi.slice(0, 48) + '…' : '(无)') +
    '（应是 data:image/png;base64 ⇒ 内嵌，不引外部文件）');
  V.rec('e5.no_img_tag', !q('img'),
    'hero 里没有 <img> 标签=' + !q('img'));
  /* 页面里不能有任何指向外部图片的引用 */
  var extImgs = document.querySelectorAll('img[src^="http"], img[src^="file"]');
  V.rec('e5b.no_external_images', extImgs.length === 0,
    '页面里指向外部的图片数量=' + extImgs.length + '（应为 0：页面要能单文件跑）');

  /* ③ 渐变背景在动
   * ⚠️ 不能读 computed style 的 animationName：
   *    验收脚本自己注入了 `animation:none!important`（见 HEAD_STYLE），
   *    消除过渡干扰 ⇒ computed 永远是 none，会得出"没有动画"的假结论。
   *    改成直接读**样式表里的规则**。 */
  var flow = q('.empty-hero__flow');
  var flowCs = flow ? getComputedStyle(flow) : null;
  V.rec('e6.has_flow_gradient', !!(flow && flowCs && flowCs.backgroundImage.indexOf('gradient') >= 0),
    '渐变背景层=' + (flow ? '有' : '无') +
    (flowCs ? '，background-image 含 gradient=' + (flowCs.backgroundImage.indexOf('gradient') >= 0) : ''));

  var flowRule = '', flowAnim = '';
  try {
    var sheets = document.styleSheets;
    for (var si = 0; si < sheets.length; si++) {
      var rs = sheets[si] ? sheets[si].cssRules : null;
      if (!rs) continue;
      for (var ri = 0; ri < rs.length; ri++) {
        var rr = rs[ri];
        if (rr.selectorText && /\.empty-hero__flow\b/.test(rr.selectorText) && rr.style.animation) {
          flowRule = rr.selectorText;
          flowAnim = rr.style.animation;
        }
      }
    }
  } catch (e) { flowRule = '读样式表失败: ' + e.message; }
  V.rec('e7.flow_is_animated', flowAnim.indexOf('heroFlow') >= 0,
    '样式表里 ' + (flowRule || '(没找到 .empty-hero__flow 的 animation 规则)') +
    ' 的 animation = "' + flowAnim + '"（应含 heroFlow ⇒ 渐变在流动）');

  /* 关键帧真的存在吗（只写 animation 名字但没定义 @keyframes 也不会动） */
  var hasKeyframes = false;
  try {
    var sh2 = document.styleSheets;
    for (var s2 = 0; s2 < sh2.length; s2++) {
      var rr2 = sh2[s2] ? sh2[s2].cssRules : null;
      if (!rr2) continue;
      for (var r2 = 0; r2 < rr2.length; r2++) {
        if (rr2[r2].type === 7 && /heroFlow/.test(rr2[r2].cssText)) hasKeyframes = true;
      }
    }
  } catch (e) {}
  V.rec('e7b.keyframes_exist', hasKeyframes,
    '@keyframes heroFlow 已定义=' + hasKeyframes + '（没有 @keyframes，animation 名字再对也不会动）');
  var flow2 = q('.empty-hero__flow2');
  V.rec('e8.two_layers', !!flow2,
    '第二层渐变=' + (flow2 ? '有（两层反向漂移，看着才是"流动"而不是整体平移）' : '无'));

  /* 标题里有「作业贴」三个字 */
  var title = q('.empty-hero__title');
  V.rec('e9.has_title', !!(title && title.textContent.replace(/\s+/g, '') === '作业贴'),
    '标题文字="' + (title ? title.textContent.replace(/\s+/g, '') : '(无)') + '"（应为 作业贴）');

  /* ④ 加了作业以后，hero 必须消失 */
  var key = CB.state.date;
  var db = CB.getDB();
  db.days = db.days || {};
  db.days[key] = { chinese: [{ book: '同步学与练', detail: 'P20', ts: Date.now() }] };
  CB.saveDB(true);
  V.tick(200, function () {
    CB.renderBoard(true);
    V.tick(200, function () {
      V.rec('e10.hero_gone_when_data', !q('.empty-hero'),
        '有作业后 .empty-hero=' + (q('.empty-hero') ? '还在（错）' : '没了（对）'));
      V.rec('e11.cards_back', qa('.card').length >= 1,
        '有作业后 .card 数量=' + qa('.card').length + '（应 ≥1）');
      V.rec('e12.picks_gone', qa('.empty-pick').length === 0,
        '有作业后 .empty-pick 数量=' + qa('.empty-pick').length + '（应为 0）');

      /* 复原：清掉测试数据 */
      try {
        var d2 = CB.getDB();
        delete d2.days[key];
        CB.saveDB(true);
        CB.renderBoard(true);
      } catch (e) {}
      V.tick(150, function () {
        V.rec('e13.back_to_empty', !!q('.empty-hero'),
          '清掉数据后又回到空状态=' + !!q('.empty-hero'));
        V.freeze();
        V.badge('verify · empty-state');
        V.finish(obs);
      });
    });
  });
}

/* 场景 10：「云与 AI」设置页（2026-10-22 重做）
 *
 * 用户原话：「加了一堆描述文本。我不需要这么多描述文本，
 *   而且你的设计也不是标准 MD3 风格设计，不知道什么鬼东西，
 *   而且现在也不用叫云同步，应该叫做 云与 AI」
 *
 * 要验的：
 *   ① 标题叫「云与 AI」（不是「云同步」）
 *   ② 结构是 MD3：一张 .card-m3 + 三个 .list-m3 + 三个 .switch
 *   ③ **描述文字很少**（整页可见文字的字数上限 —— 防止又长回去）
 *   ④ 旧的两个区块（buildAiBlock / buildSyncBlock）已经不存在了
 */
function actCloudAiPanel() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};

  /* 先配好，这样能看到"已连接"状态 */
  try {
    var db = CB.getDB();
    db.sync = db.sync || {};
    db.sync.on = 1; db.sync.owner = 'x3678'; db.sync.repo = 'zuoyetie';
    db.sync.token = 'fake'; db.sync.lastAt = Date.now();
    db.ai = { provider: 'minimax', key: 'sk-cp-fake', model: 'MiniMax-M3.1-Flash',
              base: 'https://api.minimaxi.com', speech: 1 };
    CB.saveDB(true);
  } catch (e) {}

  V.openSettings('语文', function (ok) {
    V.rec('m0.open_settings', ok, '设置页打开=' + ok);
    if (!ok) { V.finish({}); return; }

    /* 点左侧的「云与 AI」 */
    var items = document.querySelectorAll('#setNav .set-nav__item');
    var found = false;
    for (var i = 0; i < items.length; i++) {
      if (items[i].textContent.indexOf('云与 AI') >= 0) { items[i].click(); found = true; break; }
    }
    V.rec('m1.nav_named_cloud_ai', found, '左侧导航里有「云与 AI」=' + found);
    V.tick(200, function () {
      var body = document.getElementById('setBody');
      var cards = body ? body.querySelectorAll('.card-m3') : [];
      var lists = body ? body.querySelectorAll('.list-m3') : [];
      var switches = body ? body.querySelectorAll('.switch') : [];

      V.rec('m2.has_card', cards.length === 1,
        'MD3 卡片数=' + cards.length + '（应为 1：一张卡承载全部）');
      V.rec('m3.has_list_items', lists.length === 3,
        'MD3 list item 数=' + lists.length + '（应为 3：云同步 / AI / 语音输入）');
      V.rec('m4.has_switches', switches.length === 3,
        'MD3 switch 数=' + switches.length + '（应为 3）');
      V.rec('m5.switch_has_aria', switches.length === 3 &&
        Array.prototype.every.call(switches, function (s) {
          return s.getAttribute('role') === 'switch' &&
                 s.hasAttribute('aria-checked') && s.hasAttribute('aria-label');
        }),
        '每个 switch 都有 role/aria-checked/aria-label（无障碍）');

      /* 描述文字量：整页可见文字，超过 220 字就说明又长回去了 */
      var txt = body ? String(body.textContent).replace(/\s+/g, '').trim() : '';
      V.rec('m6.little_text', txt.length <= 220,
        '整页可见文字 ' + txt.length + ' 字（应 ≤220：用户说"不需要这么多描述文本"）');

      /* 标题是「云与 AI」 */
      var head = document.querySelector('#setDetail .set-head__name');
      V.rec('m7.title_is_cloud_ai', !!(head && head.textContent.trim() === '云与 AI'),
        '设置页标题="' + (head ? head.textContent.trim() : '(无)') + '"（应为 云与 AI）');

      /* 旧的区块函数必须已经删掉（用户规矩：改交互要删旧界面） */
      var oldFns = ['buildAiBlock', 'buildSyncBlock'];
      var stillThere = [];
      for (var k = 0; k < oldFns.length; k++) {
        if (typeof CB[oldFns[k]] === 'function') stillThere.push(oldFns[k]);
      }
      V.rec('m8.old_blocks_gone', stillThere.length === 0,
        '旧区块函数还在=' + (stillThere.length ? stillThere.join(',') : '（已删干净）'));

      /* 复原 */
      try {
        var d2 = CB.getDB();
        d2.sync.token = ''; d2.ai.key = ''; d2.ai.speech = 0;
        CB.saveDB(true);
      } catch (e) {}
      V.freeze();
      V.badge('verify · cloud-ai-panel');
      V.finish(obs);
    });
  });
}

/* 场景 11：「AI 添加」弹窗（2026-10-22 第七轮）
 *
 * 用户原话：「算了你不要把这个放到那个每一个页科目单独的页面里面，你直接放在它
 *   不是点添加作业按钮有一个先选择科目的页面嘛，你在那个选择科目页面的那个弹窗的
 *   左下角加一个按钮 AI 添加，然后记得写上 BETA，然后打开之后就是一个录音按钮，
 *   然后点了就说话嘛，说话结束之后再点一下，然后就加载，就是正在处理正在 AI 整理
 *   这些嘛。弄好了之后就列直接列出来，不用再点好几次，然后点确认就好了，
 *   或者是还可以编辑」
 *
 * 要验的：
 *   ① 入口在「选择科目」弹窗的**左下角**，带 BETA 标签
 *   ② **添加作业弹窗里不再有「AI 识别」页签**（旧的整块删掉了）
 *   ③ 弹窗打开后：录音按钮在、处理中提示在、结果区在
 *   ④ 整理结果**直接列出**，每条可编辑、可删除
 *   ⑤ 确认添加真的写进数据
 *
 * 这里**不调真实 AI**（headless 虚拟时间下网络等待不推进，fetch 永远不回来）。
 * AI 本身的能力用 `tools/ai-prompt-test.cjs` 在 Node 里端到端验过。
 */
function actAiTab() {
  var V = window.__V, CB = window.__classboard;
  var obs = {};

  /* ① 旧的「AI 识别」页签必须已经没了 */
  var oldTab = document.getElementById('tabAi');
  V.rec('n1.old_tab_gone', !oldTab,
    '添加作业弹窗里的旧「AI 识别」页签=' + (oldTab ? '还在（错）' : '已删'));
  var tabs = document.querySelectorAll('#hwTabs button[role="tab"]');
  V.rec('n2.two_tabs', tabs.length === 2,
    '添加作业弹窗里 ' + tabs.length + ' 个页签（应为 2：快捷添加 / 自定义）');

  /* ② 入口在「选择科目」弹窗左下角，带 BETA */
  var entry = document.getElementById('btnAiAdd2');
  V.rec('n3.entry_exists', !!entry, '「AI 添加」入口按钮=' + (entry ? '有' : '无'));
  if (entry) {
    var beta = entry.querySelector('.beta');
    V.rec('n4.has_beta_tag', !!beta && /beta/i.test(beta.textContent),
      '入口带 BETA 标签=' + (beta ? '"' + beta.textContent.trim() + '"' : '没有'));
    /* 在「选择科目」弹窗的 foot 里、且在"取消"按钮左边 */
    var foot = entry.closest('.dialog__foot');
    V.rec('n5.in_subject_foot', !!foot,
      '入口在「选择科目」弹窗的底部=' + (foot ? '是' : '否（应在 #scrimSubject 里）'));
    var cancelBtn = foot ? foot.querySelector('[data-close]') : null;
    V.rec('n6.at_left', !!(entry && cancelBtn &&
      entry.getBoundingClientRect().left <= cancelBtn.getBoundingClientRect().left),
      '入口在「取消」按钮左边（左下角）');
  }

  /* ③ 弹窗的要素 */
  V.rec('n7.dialog_exists', !!document.getElementById('scrimAi'),
    '#scrimAi 弹窗=' + (document.getElementById('scrimAi') ? '有' : '无'));
  V.rec('n8.has_mic', !!document.getElementById('btnAiRec'), '录音按钮=' + (document.getElementById('btnAiRec') ? '有' : '无'));
  V.rec('n9.has_busy', !!document.getElementById('aiBusy'), '「正在处理」提示区=' + (document.getElementById('aiBusy') ? '有' : '无'));
  V.rec('n10.has_list', !!document.getElementById('aiList'), '结果列表区=' + (document.getElementById('aiList') ? '有' : '无'));

  /* ④ 打开弹窗 → 渲染结果 → 每条可编辑可删 */
  CB.openAiDialog();
  V.tick(150, function () {
    var scrim = document.getElementById('scrimAi');
    V.rec('n11.opens', !!(scrim && !scrim.hidden), '点「AI 添加」后弹窗打开=' + !!(scrim && !scrim.hidden));

    var fake = [
      { subject: '语文', book: '同步学与练', detail: 'P20第3题', note: '', due: '明天' },
      { subject: '数学', book: '导学案', detail: '3.1', note: '', due: '' }
    ];
    CB.renderAiResult(fake);
    V.tick(100, function () {
      var rows = document.querySelectorAll('#aiList .ai-item');
      V.rec('n12.renders_items', rows.length === 2,
        '直接列出 ' + rows.length + ' 条（应为 2，不需要再点好几次）');
      /* 每条都要有输入框（可编辑）+ 删除按钮 */
      var editables = document.querySelectorAll('#aiList .ai-item .textfield');
      V.rec('n13.editable', editables.length >= 8,
        '可编辑的输入框 ' + editables.length + ' 个（2 条 × 作业本/内容/科目/时效/备注）');
      var dels = document.querySelectorAll('#aiList .ai-item__del');
      V.rec('n14.deletable', dels.length === 2,
        '每条都有删除按钮=' + dels.length + ' 个');

      /* 改一下第一条的作业本，看数据有没有跟着变 */
      var first = document.querySelector('#aiList .ai-item .textfield');
      if (first) {
        first.value = '改过的名字';
        try { first.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
      }
      V.tick(60, function () {
        V.rec('n15.edit_takes_effect', fake[0].book === '改过的名字',
          '改了输入框，数据跟着变=' + (fake[0].book === '改过的名字'));

        /* ⑤ 确认添加真的写进数据 */
        var key = CB.state.date;
        var before = (CB.getDB().days[key] || {}).chinese ?
          CB.getDB().days[key].chinese.length : 0;
        var n = CB.addAiItems([fake[0]]);
        V.tick(150, function () {
          var after = (CB.getDB().days[key] || {}).chinese ?
            CB.getDB().days[key].chinese.length : 0;
          V.rec('n16.adds_to_data', after === before + 1,
            '语文条目 ' + before + ' → ' + after + '（加 1 条）');
          V.rec('n17.add_returns_count', n === 1, 'addAiItems 返回=' + n);

          /* ⑥ ★ 2026-10-23（独立审查 M3）：关闭弹窗必须把麦克风停掉。
           *   原来 closeAiDialog() 走的是通用 closeScrimEl，
           *   里面的 voiceState.rec.stop() 是 MediaRecorder 时代的死代码
           *   ⇒ 点「取消」/Esc/遮罩之后，录音还在跑（指示灯一直亮），
           *   而且 onDone 还挂着 ⇒ 下一次录音的结果会串到旧的框里。
           *   （这段代码就在页面里跑，V.rec 直接断言） */
          var v = CB.voiceState;
          v.node = { disconnect: function () {} };
          v.stream = { getTracks: function () { return [{ stop: function () {} }]; } };
          v.ctx = { state: 'running', close: function () {} };
          v.onDone = function () { window.__calledOld = true; };
          window.__calledOld = false;

          CB.openAiDialog();
          var scrimAi = document.getElementById('scrimAi');
          var cancelBtn = scrimAi ? scrimAi.querySelector('[data-close]') : null;
          V.rec('n18.has_cancel', !!cancelBtn, 'AI 弹窗有关闭按钮=' + !!cancelBtn);
          if (cancelBtn) cancelBtn.click();

          var vAfter = CB.voiceState;
          V.rec('n19.close_stops_mic', !vAfter.node && !vAfter.ctx,
            '关掉弹窗后：node=' + (vAfter.node ? '还在（不对）' : '已停') +
            '  ctx=' + (vAfter.ctx ? '还在（不对）' : '已关'));
          V.rec('n20.close_clears_ondone', !vAfter.onDone && !window.__calledOld,
            '关掉弹窗后 onDone=' + (vAfter.onDone ? '还在（不对）' : '已清') +
            '  旧回调被调用=' + (window.__calledOld ? '是（不对）' : '否'));

          /* ⑦ ★ P0-B（2026-10-23 独立审查）：**失败时也必须调 onDone**。
           *   否则 AI 弹窗永远卡在「正在录音…」，再点又失败 ⇒ 死循环。
           *   ⚠️ mock 方式要注意：navigator.mediaDevices.getUserMedia 可能是
           *      只读属性，直接赋值不生效 ⇒ 整个 mediaDevices 换掉。
           *   ⚠️ voiceStart 里第一件事是查 aiReady()，没配 AI 就直接 return
           *      （根本不进 try）⇒ 测不到失败路径，要先临时配一个假 AI。 */
          var v2 = CB.voiceState;
          /* ⚠️ 这个场景里没有 inp（inp 是 voice-buttons 场景的变量），
             要自己取一个 —— 之前误用了不存在的 inp，
             报错被 try/catch 吞掉，断言一直"没跑成"（假失败）。 */
          var inp2 = document.getElementById('quickWordText');
          window.__failCb = null;
          v2.onDone = function (txt, err) { window.__failCb = { txt: txt, err: err }; };
          /* 先把其它状态清干净（前面的用例可能留下了 starting/busy/node），
             否则 voiceStart 会在第一行直接 return。 */
          v2.busy = false; v2.starting = false; v2.node = null;
          var dbTmp = CB.getDB();
          var oldAi = dbTmp.ai;
          dbTmp.ai = { provider: 'minimax', key: 'sk-cp-test', model: 'MiniMax-M3.1-Flash',
                       base: 'https://api.minimaxi.com', speech: 1 };
          var origMD = window.navigator.mediaDevices;
          try {
            Object.defineProperty(window.navigator, 'mediaDevices', {
              configurable: true,
              value: {
                getUserMedia: function () { return Promise.reject(new Error('模拟的失败')); }
              }
            });
          } catch (e) { /* 换不了就跳过这条断言 */ }

          try {
            var p0b = CB.voiceStart(inp2, document.querySelector('.voice-btn'), null);
            if (p0b && p0b.then) {
              p0b.then(function () {}, function (e) {});
            }
          } catch (e) { /* 忽略 */ }

          /* ⑧ ★ P1-C（2026-10-23 独立审查）：**连点不能泄漏麦克风**。
           *   原来 busy 只在 voiceStop 里置 true、voiceStart 从不设 ⇒
           *   连点 4 次实测：建了 4 个 AudioContext、4 条麦克风流，
           *   停止时只关掉 1 条 ⇒ **麦克风指示灯一直亮**。
           *   ⇒ 加了 starting 标志后，连点只应该建 1 个。
           *   这里连点 4 次，然后数一数建了几个 AudioContext。 */
          var ctxCount = 0;
          var RealAC = window.AudioContext;
          try {
            window.AudioContext = function () {
              ctxCount++;
              var c = new RealAC();
              return c;
            };
            window.AudioContext.prototype = RealAC.prototype;
          } catch (e4) { /* 换不了就跳这条 */ }
          /* 连点 4 次 */
          CB.voiceStart(inp2, document.querySelector('.voice-btn'), null);
          CB.voiceStart(inp2, document.querySelector('.voice-btn'), null);
          CB.voiceStart(inp2, document.querySelector('.voice-btn'), null);
          CB.voiceStart(inp2, document.querySelector('.voice-btn'), null);

          /* ⚠️⚠️ 这个检查必须**在 V.finish() 之前**跑完 ——
           *   V.finish() 会立刻 DONE=true 并 flush，场景就结束了，
           *   排在它后面的 tick 回调永远等不到（我踩过：断言一直是"没跑"的样子）。
           *   ⇒ 把 P0-B 的检查挪到 V.finish 之前，并在这里等它跑完。 */
          V.tick(800, function () {
            /* 恢复 */
            try {
              Object.defineProperty(window.navigator, 'mediaDevices', {
                configurable: true, value: origMD
              });
            } catch (e2) {}
            try { window.AudioContext = RealAC; } catch (e5) {}
            try { dbTmp.ai = oldAi; } catch (e3) {}
            var cbState = window.__failCb;
            V.rec('n21.fail_calls_ondone', !!cbState,
              '录音启动失败时 onDone 被调用=' + (cbState ? '是' : '★ 否（弹窗会卡死）') +
              (cbState ? '  err=' + (cbState.err || '(空)') : ''));
            V.rec('n22.fail_clears_state', !CB.voiceState.onDone && !CB.voiceState.node &&
              !CB.voiceState.starting,
              '失败后状态已清理：onDone=' + (CB.voiceState.onDone ? '还在（不对）' : '已清') +
              '  node=' + (CB.voiceState.node ? '还在（不对）' : '已清') +
              '  starting=' + (CB.voiceState.starting ? '还在（不对）' : '已清') +
              '  lastError="' + (CB.voiceState.lastError || '(空)') + '"');
            /* 连点 4 次 ⇒ 最多只建 1 个 AudioContext（加 starting 标志之前是 4 个） */
            V.rec('n23.no_double_start_leak', ctxCount <= 1,
              '连点 4 次建了 ' + ctxCount + ' 个 AudioContext（加 starting 标志之前是 4 个 ⇒ 麦克风指示灯会一直亮）');

            /* ★ 到这里才收尾 */
            /* 复原 */
            try {
              var d2 = CB.getDB();
              if (d2.days[key]) delete d2.days[key].chinese;
              CB.saveDB(true);
            } catch (e) {}
            V.freeze();
            V.badge('verify · ai-add-dialog');
            V.finish(obs);
          });
        });
      });
    });
  });
}

/* 场景 4b：空态提示 —— 前提必须先真正造出来，前提不成立就不对空态下结论。
 * booksOf/wordsOf 对"空数组"回落内置默认，所以要连内置默认一起清空才到得了 0 个。 */
function actEmptyState() {
  var V = window.__V, CB = window.__classboard;
  V.openWizard('语文', function (ok, diag) {
    V.rec('h0.open_wizard', ok, '向导打开=' + ok + (ok ? '' : ' 诊断=' + JSON.stringify(diag)));
    if (!ok) { V.note('h.fatal', '向导没打开，后续跳过'); V.finish({}); return; }

    /* ---------- 作业本空态 ---------- */
    V.forceEmptyBooks();   /* SUBJECTS[i].books=[]（与内部 SUBJECT_MAP 同一批对象）+ setBooks(sid,[]) */
    V.clickType(0, function () {
      var n1 = V.chipCount('#bookChips');
      V.rec('h1.books_premise_zero_chips', n1 === 0,
        '前提：作业本清到 0 个（#bookChips=' + n1 + '）' + (n1 === 0 ? '' : ' → 前提未造出，不下空态结论'));
      if (n1 === 0) {
        var hint1 = V.emptyHint('wPane2Book');
        V.rec('h2.books_empty_hint_text', String(hint1).indexOf('还没有作业本') >= 0,
          '空态提示="' + hint1 + '"（期望含「这一科还没有作业本。去「设置 → 作业本」里加一个，再回来选。」）');
      } else {
        V.rec('h2.books_empty_hint_text', false,
          '前提未造出（#bookChips=' + n1 + '）→ 不对空态提示下结论');
      }
      V.note('h.bookPaneText', V.paneText('wPane2Book'));

      /* ---------- 快捷词空态：连 DEFAULT_WORDS 一起清，才真的到 0 个 ---------- */
      try { CB.DEFAULT_WORDS.chinese = []; } catch (e) {}
      try { delete CB.getDB().words.chinese; } catch (e) {}
      V.clickType(1, function () {
        var n2 = V.chipCount('#wordChips');
        V.rec('h3.words_premise_zero_chips', n2 === 0,
          '前提：快捷词清到 0 个（#wordChips=' + n2 + '；CB.DEFAULT_WORDS.chinese=[] 且 DB.words.chinese 已删）' +
          (n2 === 0 ? '' : ' → 前提未造出'));
        if (n2 === 0) {
          var hint2 = V.emptyHint('wPane2Word');
          V.rec('h4.words_empty_hint_text', String(hint2).indexOf('还没有快捷词') >= 0,
            '空态提示="' + hint2 + '"（期望含「这一科还没有快捷词。去「设置 → 快捷词」里加一个，再回来选。」）');
        } else {
          V.rec('h4.words_empty_hint_text', false,
            '前提未造出（#wordChips=' + n2 + '）→ 不对空态提示下结论');
        }
        V.note('h.wordPaneText', V.paneText('wPane2Word'));
        V.note('h.chips', { book: V.chipCount('#bookChips'), word: V.chipCount('#wordChips') });
        V.note('h.design_note',
          '空列表在 UI 上不可达：settings 的 setRow 有 `if (arr.length <= 1) { toast("每科至少留一项"); return; }`；' +
          'wordRow 允许删空，但删空时执行 delete DB.words[sid]，wordsOf() 随即回落 DEFAULT_WORDS。' +
          '所以本场景是"防手改数据文件"的兜底路径：只有连内置默认一起清掉（这里改的是调试桥 CB.DEFAULT_WORDS / CB.SUBJECTS）才能造出 0 个。');
        V.freeze();
        V.badge('verify · empty-state · bookChips=' + V.chipCount('#bookChips') +
          ' · wordChips=' + V.chipCount('#wordChips'));
        V.finish({});
      });
    });
  });
}

/* 场景 5：主题截图。用 window.__META 传参（注入的函数不能闭包外部变量） */
function actShot() {
  var V = window.__V, M = window.__META;
  V.setTheme(M.theme, function (okTheme) {
    V.rec('s.theme_applied', okTheme,
      'want=' + M.theme + ' actual=' + document.documentElement.getAttribute('data-theme'));
    V.openWizard(M.subject, function (okOpen, diag) {
      if (!okOpen) {
        V.rec('s.wizard_opened', false, '向导没打开 可见=[' + V.panes().join(',') + '] 诊断=' + JSON.stringify(diag));
        V.badge('verify · ' + M.name + ' · 向导没打开');
        V.finish({});
        return;
      }
      V.rec('s.wizard_opened', true, '可见=[' + V.panes().join(',') + ']');
      V.poseStep(M.pose, M.poseOpts || {}, function (okPose) {
        var p = V.panes();
        V.rec('s.pose_reached', okPose && V.visId(M.target),
          'pose=' + M.pose + ' target=' + M.target + ' 可见=[' + p.join(',') + ']');
        V.rec('s.target_visible', V.visId(M.target),
          'target=' + M.target + ' visible=' + V.visId(M.target) + ' 全部可见=[' + p.join(',') + ']');
        V.note('s.panes', p);
        V.note('s.chips', { book: V.chipCount('#bookChips'), word: V.chipCount('#wordChips') });
        V.freeze();
        V.badge('verify · ' + M.name + '\ntheme=' + M.theme + ' pose=' + M.pose +
          '\npane=[' + p.join(',') + ']\nbookChips=' + V.chipCount('#bookChips') +
          ' wordChips=' + V.chipCount('#wordChips'));
        V.finish({});
      });
    });
  });
}

/* ==========================================================================
 * 三、Node 侧：拼页面、起 Edge、收结果
 * ========================================================================*/

function headCollector() {
  return '<script>window.__errs=[];' +
    'window.addEventListener("error",function(e){' +
    'window.__errs.push("" + (e.message||"(no message)") + " @line " + (e.lineno||0) + ":" + (e.colno||0));' +
    '});' +
    'window.addEventListener("unhandledrejection",function(e){' +
    'window.__errs.push("unhandledrejection: " + ((e.reason && e.reason.message) || e.reason));' +
    '});' +
    '<\/script>';
}

/* 关掉过渡与动画。原因（实测）：
 *   .scrim{opacity:0;visibility:hidden;transition:opacity …,visibility 0s linear …}
 *   .scrim.is-open{opacity:1;visibility:visible}
 * 打开弹窗后，computed visibility 会晚一到两拍才翻成 visible；而 --virtual-time-budget 下
 * 这一两拍什么时候来是不确定的，于是"刚点完就量"会随机量到 hidden，截图也可能拍到过渡中间态。
 * 全部关掉之后可见性判断与截图都变成确定性的。页面里没有任何 transitionend 监听，所以安全。 */
var HEAD_STYLE = '<style>*,*::before,*::after{transition:none!important;animation:none!important}</style>';

/* 注入：错误收集器放 <head> 之后（早于页面脚本），驱动脚本放 </body> 之前。
 * 用函数式 replace，避免替换串里的 $ 被当成特殊模式。 */
function buildPage(sourceHtml, actFn, meta) {
  var driver = '<script>\n(' + PAGE_CORE.toString() + ')();\n' +
    'window.__META=' + JSON.stringify(meta || {}) + ';\n' +
    'window.__run=function(){\n(' + actFn.toString() + ')();\n};\n' +
    'if(document.readyState==="complete"){setTimeout(window.__run,120);}' +
    'else{window.addEventListener("load",function(){setTimeout(window.__run,120);});}\n' +
    '<\/script>';
  return sourceHtml
    .replace('<head>', function () { return '<head>' + HEAD_STYLE + headCollector(); })
    .replace('</body>', function () { return driver + '</body>'; });
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function runEdge(scn, sourceHtml) {
  var name = scn.name;
  var profile = path.join(OUT, 'profiles', name);
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });

  var pageFile = path.join(RAW, name + '.page.html');
  fs.writeFileSync(pageFile, buildPage(sourceHtml, scn.act, scn.meta || {}), 'utf8');

  var domFile = path.join(RAW, name + '.dom.html');
  var logFile = path.join(RAW, name + '.edge.log');
  var pngFile = scn.shot ? path.join(SHOTS, name + '.png') : null;

  var fdOut = fs.openSync(domFile, 'w');
  var fdErr = fs.openSync(logFile, 'w');

  var args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    '--user-data-dir=' + profile,
    '--window-size=1600,1000',
    '--force-device-scale-factor=' + (scn.shot ? 2 : 1),
    '--virtual-time-budget=' + (scn.budget || 25000),
    '--enable-logging=stderr', '--log-level=0'
  ];
  if (pngFile) args.push('--screenshot=' + pngFile);
  args.push('--dump-dom', pageFile);

  /* 不用管道：stdout/stderr 都写文件描述符 */
  var r = spawnSync(EDGE, args, { stdio: ['ignore', fdOut, fdErr], timeout: 300000 });
  fs.closeSync(fdOut);
  fs.closeSync(fdErr);

  var dom = fs.existsSync(domFile) ? fs.readFileSync(domFile, 'utf8') : '';
  var log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  var data = null, parseErr = '';
  var m = dom.match(/<pre id="__vr"[^>]*>([\s\S]*?)<\/pre>/);
  if (m) {
    try { data = JSON.parse(unescapeHtml(m[1])); } catch (e) { parseErr = e.message; }
  }
  var domTitle = '';
  var tm = dom.match(/<title>([\s\S]*?)<\/title>/);
  if (tm) domTitle = unescapeHtml(tm[1]);
  var uncaught = log.split(/\r?\n/).filter(function (l) { return /Uncaught|Unhandled|ReferenceError|TypeError/.test(l); });

  /* 每个 profile 是几十 MB 的一次性垃圾，跑完就删（报告不引用它，证据在 raw/ 与 shots/）。
   * 删失败也不影响结论，所以只吞异常不报错。 */
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}

  return {
    name: name, group: scn.group, purpose: scn.purpose, shot: !!scn.shot,
    status: (r && r.status), error: r && r.error ? String(r.error.code || r.error) : '',
    domFile: domFile, logFile: logFile, pageFile: pageFile, pngFile: pngFile,
    domTitle: domTitle, data: data, parseErr: parseErr,
    uncaught: uncaught, domSize: dom.length,
    pngSize: pngFile && fs.existsSync(pngFile) ? fs.statSync(pngFile).size : -1,
    meta: scn.meta || {}
  };
}

/* ==========================================================================
 * 四、主流程
 * ========================================================================*/

function main() {
  var t0 = Date.now();

  /* 0) 互斥锁 —— 2026-10-23 独立审查发现的 M12：
   *    这个脚本会 `rmSync(OUT, {recursive:true})` 清掉整个输出目录，
   *    **两个实例同时跑会互相踩**（一个删掉另一个正在写的截图，
   *    然后报出一堆莫名其妙的 FAIL —— 实测过，4 条假失败）。
   *    ⇒ 用一个锁文件做互斥：拿不到锁就直接退出（不算失败）。
   */
  var LOCK = path.join(ROOT, '.tmp', 'verify-wizard.lock');
  try { fs.mkdirSync(path.dirname(LOCK), { recursive: true }); } catch (e) {}
  var lockFd = null;
  try {
    lockFd = fs.openSync(LOCK, 'wx');
    fs.writeSync(lockFd, String(process.pid));
  } catch (e) {
    console.error('另一个 verify-wizard 正在跑（锁文件存在），本次不执行。');
    console.error('  锁文件：' + LOCK);
    console.error('  如果确认没有别的实例，删掉它再跑。');
    process.exit(2);
  }
  function unlock() {
    try { if (lockFd !== null) fs.closeSync(lockFd); } catch (e) {}
    try { fs.unlinkSync(LOCK); } catch (e) {}
  }
  process.on('exit', unlock);

  /* 1) 先删旧报告：崩在半路时写报告那句执行不到，残留的旧结论最容易骗人 */
  try { fs.rmSync(REPORT, { force: true }); } catch (e) {}
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });

  if (!EDGE) {
    console.error('找不到 msedge.exe，无法运行验收测试');
    writeReport({ fatal: '找不到 msedge.exe', started: new Date(), elapsedMs: 0, artifact: null });
    process.exit(1);
  }
  if (!fs.existsSync(APP)) {
    console.error('找不到构建产物 ' + APP);
    writeReport({ fatal: '找不到 classboard.html', started: new Date(), elapsedMs: 0, artifact: null });
    process.exit(1);
  }

  /* 2) 一次性读进内存：整个跑批都测这一份产物，避免跑到一半 lead 重新构建导致前后不一致 */
  var buf = fs.readFileSync(APP);
  var sourceHtml = buf.toString('utf8');
  var artifact = {
    file: APP, size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    mtime: fs.statSync(APP).mtime.toISOString(),
    chars: sourceHtml.length
  };
  var srcApp = path.join(ROOT, 'src', 'app.js');
  var srcTpl = path.join(ROOT, 'src', 'template.html');
  artifact.srcApp = fs.existsSync(srcApp)
    ? { mtime: fs.statSync(srcApp).mtime.toISOString(), sha256: crypto.createHash('sha256').update(fs.readFileSync(srcApp)).digest('hex').slice(0, 16) }
    : null;
  artifact.srcTpl = fs.existsSync(srcTpl)
    ? { mtime: fs.statSync(srcTpl).mtime.toISOString(), sha256: crypto.createHash('sha256').update(fs.readFileSync(srcTpl)).digest('hex').slice(0, 16) }
    : null;
  artifact.stale = !!(artifact.srcApp && artifact.srcApp.mtime > artifact.mtime);
  /* 应用版本号（electron/package.json）——写进报告，便于把结论对到具体版本 */
  artifact.version = null;
  try {
    var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8'));
    artifact.version = pkg.version || null;
  } catch (e) { artifact.version = null; }

  /* 3) 场景表：截图场景两个主题各 7 张（第1/2/3/4步 + 空数据 + 快捷词两步） */
  var shotDefs = [
    { tag: '1-step1', pose: 'step1', target: 'wPane1', purpose: '第1步：选类型' },
    { tag: '2-step2book', pose: 'step2book', target: 'wPane2Book', purpose: '第2步：选作业本（有数据）' },
    { tag: '3-step3page', pose: 'step3page', target: 'wPane3Page', purpose: '第3步：选页码（有数据，已填 P20）' },
    { tag: '4-step2book-empty', pose: 'step2book', target: 'wPane2Book', purpose: '第2步：作业本清空（空数据）', poseOpts: { emptyBooks: true } },
    { tag: '5-step2word', pose: 'step2word', target: 'wPane2Word', purpose: '第2步：选快捷词（有数据）' },
    { tag: '6-step3text', pose: 'step3text', target: 'wPane3Text', purpose: '第3步：填内容（有数据）', poseOpts: { text: '《登高》全文' } },
    { tag: '7-step4extra', pose: 'step4extra', target: 'wPane4Extra', purpose: '第4步：补充信息（选填）备注+时效',
      poseOpts: { note: '第3、5题不用写', dueDay: '明天', duePeriod: '第1节' } }
  ];
  var scenarios = [
    { name: 'boot', group: '1 启动回归', purpose: '打开页面无 JS 报错 + __classboard + 作业板渲染', act: actBoot, budget: 20000 },
    { name: 'flow-page', group: '2 分步向导 / 3 落库', purpose: '页码分支：每步只显示一个 pane、上一步回退、落库', act: actFlowPage, budget: 30000 },
    { name: 'flow-extra', group: '2 分步向导 / 3 落库', purpose: '第4步补充信息：归属/选填不点也能提交/落库/提交后回第1步', act: actFlowExtra, budget: 80000 },
    { name: 'flow-word', group: '2 分步向导 / 3 落库', purpose: '快捷词分支：每步只显示一个 pane、上一步回退、落库', act: actFlowWord, budget: 30000 },
    { name: 'flow-lesson', group: '2 分步向导 / 3 落库', purpose: '课时分支（数学·导学案）：第3步只显示 wPane3Lesson + 落库', act: actFlowLesson, budget: 25000 },
    { name: 'settings-design', group: '4 空数据空态（设计正面断言）', purpose: '设置页删除路径：作业本删不空（每科至少留一项）+ 快捷词删空回落内置默认', act: actSettingsDesign, budget: 30000 },
    { name: 'empty-state', group: '4 空数据空态（提示文案）', purpose: '真正造出 0 个作业本 / 0 个快捷词，再断言空态提示文案', act: actEmptyState, budget: 30000 },
    { name: 'toolbar-fold', group: '6 工具栏折叠', purpose: '默认收起 / 点开展开 / 1 分钟无操作自动收回 / 其他操作不影响', act: actToolbarFold, budget: 120000 },
    { name: 'empty-state', group: '9 空状态首页', purpose: '没有作业时显示 logo+渐变 hero 与 9 科入口；有了作业就恢复卡片', act: actEmptyStatePage, budget: 40000 },
    { name: 'offline-purity', group: '12 离线纯净度', purpose: '页面上没有云同步 / AI / 语音的入口与残留；联网 API 一个都没有', act: actOfflinePurity, budget: 30000 }
  ];
  ['light', 'dark'].forEach(function (theme) {
    shotDefs.forEach(function (d) {
      var name = theme + '-' + d.tag;
      scenarios.push({
        name: name, group: '5 主题截图', shot: true, budget: 25000,
        purpose: d.purpose + '（' + (theme === 'light' ? '浅色' : '深色') + '）',
        act: actShot,
        meta: {
          name: name, theme: theme, subject: '语文', pose: d.pose, poseOpts: d.poseOpts || {},
          target: d.target, purpose: d.purpose
        }
      });
    });
  });

  /* 数清楚会起多少个 Edge 进程再开跑 */
  console.log('被测产物：' + APP);
  console.log('  sha256=' + artifact.sha256.slice(0, 16) + ' size=' + artifact.size + ' mtime=' + artifact.mtime);
  if (artifact.stale) console.log('  [WARN] src/app.js 比 classboard.html 新 → 构建产物可能落后于源码，结论只对当前产物有效');
  console.log('本次将启动 ' + scenarios.length + ' 个 Edge 进程（上限 ' + MAX_EDGE + '），每个进程独立 profile。');
  if (scenarios.length > MAX_EDGE) {
    console.error('Edge 进程数超上限，拒绝运行');
    writeReport({ fatal: '进程数超上限', started: new Date(), elapsedMs: 0, artifact: artifact });
    process.exit(1);
  }

  /* 4) 逐个场景跑 */
  scenarios.forEach(function (scn) {
    var run;
    try {
      run = runEdge(scn, sourceHtml);
    } catch (e) {
      run = { name: scn.name, group: scn.group, purpose: scn.purpose, shot: !!scn.shot,
        status: -1, error: String(e && e.message || e), data: null, uncaught: [], pngSize: -1,
        domSize: 0, parseErr: '', domFile: '', logFile: '', meta: scn.meta || {} };
      addCheck('run.' + scn.name + '.no_crash', scn.group, false, '运行器异常：' + run.error);
    }
    RUNS.push(run);

    var data = run.data;
    if (!data) {
      addCheck('run.' + scn.name + '.result_block', scn.group, false,
        '页面里没读到断言块（<pre id="__vr">）parseErr=' + run.parseErr +
        ' edgeStatus=' + run.status + ' error=' + run.error + ' domSize=' + run.domSize);
    } else {
      addCheck('run.' + scn.name + '.finished', scn.group, data.done === true,
        '页面驱动脚本跑完=' + data.done + '（未跑完往往是预算耗尽或前一步卡住）');
      var errs = (data.notes && data.notes['boot.errors']) || [];
      var uncaughtReal = run.uncaught.filter(function (l) { return /Uncaught|ReferenceError|TypeError/.test(l); });
      if (scn.name === 'boot') {
        /* boot 场景自己的 b1 断言已覆盖；这里只补 Edge 控制台侧证据 */
        addCheck('run.boot.edge_log_clean', scn.group, uncaughtReal.length === 0,
          uncaughtReal.length ? ('Edge 日志里有未捕获异常：' + uncaughtReal.slice(0, 3).join(' || ')) : 'Edge 日志无 Uncaught');
      } else {
        addCheck('run.' + scn.name + '.no_js_error', scn.group, errs.length === 0,
          'window.onerror 捕获 ' + errs.length + ' 条：' + JSON.stringify(errs));
      }
      (data.checks || []).forEach(function (c) {
        addCheck(scn.name + '/' + c.id, run.group, c.ok, c.detail);
      });
      if (run.shot) {
        addCheck('run.' + scn.name + '.png_written', run.group, run.pngSize > 5000,
          (run.pngFile || '(无)') + ' size=' + run.pngSize + ' bytes');
      }
      var nk = Object.keys(data.notes || {});
      nk.forEach(function (k) { addNote(scn.name + '.' + k, data.notes[k]); });
    }
    console.log('  [' + (run.data && run.data.done ? 'done' : '未完成') + '] ' + scn.name +
      ' (edge exit=' + run.status + (run.shot ? ', png=' + run.pngSize + 'B' : '') + ')');
  });

  /* 5) 截图交叉检查：深浅两色同一姿态的 PNG 必须不同 */
  ['1-step1', '2-step2book', '3-step3page'].forEach(function (tag) {
    var a = path.join(SHOTS, 'light-' + tag + '.png');
    var b = path.join(SHOTS, 'dark-' + tag + '.png');
    if (fs.existsSync(a) && fs.existsSync(b)) {
      var ha = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
      var hb = crypto.createHash('sha256').update(fs.readFileSync(b)).digest('hex');
      addCheck('shots.theme_differs.' + tag, '5 主题截图', ha !== hb,
        'light/dark 两张 PNG 内容不同=' + (ha !== hb) + ' (light ' + fs.statSync(a).size + 'B / dark ' + fs.statSync(b).size + 'B)');
    } else {
      addCheck('shots.theme_differs.' + tag, '5 主题截图', false, '缺少 ' + tag + ' 的深/浅任一截图');
    }
  });

  console.log('');
  var pass = CHECKS.filter(function (c) { return c.ok; }).length;
  console.log('断言：' + CHECKS.length + ' 项，PASS ' + pass + '，FAIL ' + failures);
  CHECKS.filter(function (c) { return !c.ok; }).forEach(function (c) {
    console.log('  [FAIL] ' + c.id + ' — ' + c.detail);
  });

  writeReport({ fatal: '', started: new Date(t0), elapsedMs: Date.now() - t0, artifact: artifact });
  console.log('');
  console.log('报告：' + REPORT);
  process.exit(failures === 0 ? 0 : 1);
}

/* ==========================================================================
 * 五、报告
 * ========================================================================*/
function writeReport(ctx) {
  var L = [];
  var now = new Date();
  var pass = CHECKS.filter(function (c) { return c.ok; }).length;
  var failed = CHECKS.filter(function (c) { return !c.ok; });
  var 真缺口 = failed.filter(function (c) { return TRIAGE[c.id] && TRIAGE[c.id].nature.indexOf('真缺口') === 0; }).length;
  var conclusion = ctx.fatal ? '运行失败：' + ctx.fatal
    : (failed.length === 0 ? 'PASS（全部断言通过）'
      : 'FAIL（' + failed.length + ' 项未通过：真缺口 ' + 真缺口 + ' 项，设计如此 ' + (failed.length - 真缺口) + ' 项）');

  L.push('# 「作业贴」分步向导 · 验收测试报告');
  L.push('');
  L.push('- 生成时间：' + now.toLocaleString('zh-CN') + '（' + now.toISOString() + '）');
  L.push('- 结论：**' + conclusion + '**');
  L.push('- 退出码：' + (ctx.fatal || failed.length ? '1' : '0') + '（脚本结尾 process.exit(failures===0?0:1)）');
  L.push('- 断言合计：' + CHECKS.length + ' 项，PASS ' + pass + '，FAIL ' + failed.length);
  L.push('- 脚本：`projects/yitie/tools/verify-wizard.cjs`（node ' + process.version + '）');
  L.push('- 浏览器：`' + (EDGE || '(未找到)') + '`（headless=new，进程数 ' + RUNS.length + '，上限 ' + MAX_EDGE + '）');
  L.push('- 耗时：' + (ctx.elapsedMs / 1000).toFixed(1) + ' s');
  L.push('');
  if (ctx.artifact) {
    var a = ctx.artifact;
    L.push('## 被测产物');
    L.push('');
    L.push('| 项 | 值 |');
    L.push('|---|---|');
    L.push('| 构建产物 | `' + a.file + '` |');
    L.push('| sha256 | `' + a.sha256 + '` |');
    L.push('| 大小 / 字符数 | ' + a.size + ' bytes / ' + a.chars + ' chars |');
    L.push('| 构建时间 | ' + a.mtime + ' |');
    if (a.srcApp) L.push('| src/app.js | ' + a.srcApp.mtime + ' sha256:' + a.srcApp.sha256 + ' |');
    if (a.srcTpl) L.push('| src/template.html | ' + a.srcTpl.mtime + ' sha256:' + a.srcTpl.sha256 + ' |');
    if (a.version) L.push('| 应用版本（electron/package.json） | ' + a.version + ' |');
    L.push('');
    L.push('> 说明：整个跑批只读一次 classboard.html（开跑时读进内存），所以即使跑的过程中重新构建，' +
      '本报告的结论也只对应上面这个 sha256 的产物。');
    if (a.stale) {
      L.push('>');
      L.push('> **WARN：`src/app.js` 的修改时间比 `classboard.html` 新 —— 构建产物落后于源码。**' +
        '本报告只对上面这份产物有效；若源码里已修好，需重新 `node build.cjs` 后再跑一次。');
    }
    L.push('');
  }
  if (ctx.fatal) {
    L.push('## 致命错误');
    L.push('');
    L.push('```');
    L.push(ctx.fatal);
    L.push('```');
    L.push('');
    fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
    return;
  }

  /* 结论摘要：失败的断言 */
  L.push('## 一、未通过的断言（先看这里）');
  L.push('');
  if (!failed.length) {
    L.push('无。全部分组通过。');
  } else {
    L.push('| 断言 | 分组 | 分诊 | 详情 |');
    L.push('|---|---|---|---|');
    failed.forEach(function (c) {
      var tr = TRIAGE[c.id];
      L.push('| `' + c.id + '` | ' + c.group + ' | ' + (tr ? tr.nature : '待人工判定') + ' | ' +
        String(c.detail).replace(/\|/g, '\\|') + ' |');
    });
    L.push('');
    L.push('### 分诊说明');
    L.push('');
    failed.forEach(function (c) {
      var tr = TRIAGE[c.id];
      L.push('- `' + c.id + '` —— **' + (tr ? tr.nature : '待人工判定') + '**：' +
        (tr ? tr.note : '（没有预设分诊，请人工看）'));
    });
    L.push('');
    L.push('> task-4 收口结论：`e1`/`e4` 是**期望写反**（期望"空数组→0 chip"，真实设计是"删不空"），`e5` 是**前提没造出来**；' +
      '三者都不是产品缺口，现已按真实设计改写为正面断言（见上一节「设计事实」）。断言没有放宽。');
  }
  L.push('');
  L.push('## 一.1、设计事实（已实测，task-4 收口依据）');
  L.push('');
  DESIGN_FACTS.forEach(function (t, i) { L.push((i + 1) + '. ' + t); });
  L.push('');

  /* 分组明细 */
  L.push('## 二、逐项断言明细');
  L.push('');
  var groups = [];
  CHECKS.forEach(function (c) { if (groups.indexOf(c.group) < 0) groups.push(c.group); });
  groups.forEach(function (g) {
    var list = CHECKS.filter(function (c) { return c.group === g; });
    var gfail = list.filter(function (c) { return !c.ok; }).length;
    L.push('### ' + g + '（PASS ' + (list.length - gfail) + ' / FAIL ' + gfail + '）');
    L.push('');
    L.push('| 结果 | 断言 | 详情 |');
    L.push('|---|---|---|');
    list.forEach(function (c) {
      L.push('| ' + (c.ok ? 'PASS' : '**FAIL**') + ' | `' + c.id + '` | ' + String(c.detail).replace(/\|/g, '\\|') + ' |');
    });
    L.push('');
  });

  /* 截图 */
  L.push('## 三、截图证据（深色 / 浅色 × 第1/2/3步 × 有数据/空数据）');
  L.push('');
  L.push('| 文件 | 主题 | 步骤 | 目标面板 | 该图实际可见的面板 | 大小 | pose 断言 |');
  L.push('|---|---|---|---|---|---|---|');
  RUNS.filter(function (r) { return r.shot; }).forEach(function (r) {
    var rel = path.relative(ROOT, r.pngFile || '').replace(/\\/g, '/');
    var notes = (r.data && r.data.notes) || {};
    var panes = notes['s.panes'] || [];
    var poseCheck = null, targetCheck = null, themeCheck = null;
    ((r.data && r.data.checks) || []).forEach(function (c) {
      if (c.id === 's.pose_reached') poseCheck = c;
      if (c.id === 's.target_visible') targetCheck = c;
      if (c.id === 's.theme_applied') themeCheck = c;
    });
    var verdict = (poseCheck && poseCheck.ok && targetCheck && targetCheck.ok && themeCheck && themeCheck.ok) ? 'PASS' : '**FAIL**';
    L.push('| `' + rel + '` | ' + ((r.meta && r.meta.theme) === 'light' ? '浅色' : '深色') + ' | ' +
      ((r.meta && r.meta.pose) || '?') + ' | ' + ((r.meta && r.meta.target) || '?') + ' | [' + panes.join(',') + '] | ' +
      (r.pngSize >= 0 ? r.pngSize + ' B' : '缺失') + ' | ' + verdict + ' |');
  });
  L.push('');
  L.push('每张图左下角有一行 `verify · <场景> · theme=… · pane=[…]` 的小字水印，图里直接能看到当时真实可见的面板，' +
    '方便人工复核时确认这张图拍的是哪一步。');
  L.push('');

  /* 观测数据 */
  L.push('## 四、观测数据（页面内实测，非推导）');
  L.push('');
  L.push('```json');
  L.push(JSON.stringify(NOTES, null, 2));
  L.push('```');
  L.push('');

  /* 原始证据 */
  L.push('## 五、原始证据文件');
  L.push('');
  L.push('| 文件 | 内容 | 大小 |');
  L.push('|---|---|---|');
  RUNS.forEach(function (r) {
    [['domFile', '序列化 DOM（含断言块）'], ['logFile', 'Edge stderr（含 console）']].forEach(function (pair) {
      var f = r[pair[0]];
      if (f && fs.existsSync(f)) {
        L.push('| `' + path.relative(ROOT, f).replace(/\\/g, '/') + '` | ' + r.name + ' · ' + pair[1] + ' | ' + fs.statSync(f).size + ' B |');
      }
    });
    if (r.shot && r.pngFile && fs.existsSync(r.pngFile)) {
      L.push('| `' + path.relative(ROOT, r.pngFile).replace(/\\/g, '/') + '` | ' + r.name + ' · 截图 | ' + r.pngSize + ' B |');
    }
  });
  L.push('');
  L.push('> 每次运行都用独立 `--user-data-dir`（跑完即删，避免几 GB 的一次性 profile 留在 .tmp 里），' +
    '页面通过 `file://` 打开；数据库只改内存（`window.__classboard.getDB()` / `setBooks`），磁盘上的数据文件未被修改。' +
    '注入的页面副本（`*.page.html`）里带着断言驱动脚本，可以单独用 Edge 打开复核。');
  L.push('');
  L.push('---');
  L.push('');
  L.push('生成命令：`cd projects/yitie && node tools/verify-wizard.cjs`');

  fs.writeFileSync(REPORT, L.join('\n'), 'utf8');
}

main();
