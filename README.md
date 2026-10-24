# Open作业贴

> 教室大屏作业看板 —— **开源离线版**
> 完全离线运行，数据只存在本机，不联网、不上传、不需要账号。

**作者：yiyi　｜　许可证：[MIT](LICENSE)　｜　[English](README.en.md)**

**仓库地址**：https://github.com/cyychenyiyicyy/open-yitie

---

## 这是什么

Open作业贴 是一块给**教室大屏**用的作业看板：

- 老师点开就能看到今天每科的作业，不用翻本子、不用拍黑板
- 九科齐全（语文 / 数学 / 英语 / 物理 / 化学 / 生物 / 政治 / 历史 / 地理）
- 内置各科教材课时表，录作业时可以直接选「同步学与练 P20」「导学案 第 3 课」
- 提交时效高亮（今天 / 明天 / 下周几，一眼看出哪科催得急）
- 备注条款快捷录入（「不用写」「只要写前三题」「明天要交」）
- 小窗模式：把作业钉成一个小窗浮在别的资料上面，讲评时两边都能看
- 本周总览：一眼看完这周每天各科几条作业
- 深色 / 浅色主题，整屏字号可调，全屏展示

## 为什么是「离线版」

这个版本**把联网相关的功能全部去掉了**，只留教室里真正用得上的部分：

| 已移除 | 说明 |
|---|---|
| **云同步** | 不再连 Gitee / GitHub 推拉数据，不再存 token，不需要网络 |
| **云端更新** | 应用不联网检查更新；新版本请到 GitHub 仓库手动获取 |
| **语音输入** | 去掉麦克风按钮、录音、音频采集 |
| **AI** | 去掉「AI 添加」弹窗、模型配置、API 调用、密钥管理 |
| **第三方 API** | 产物里没有任何 `fetch` / `XMLHttpRequest` / `WebSocket` |

**数据存在哪？** 只在这台电脑上。两种情况：

- 装成 Electron 应用 → `~/.config/open-yitie/data/data.json`（Linux）
- 直接用浏览器打开单文件 → 浏览器 localStorage

换电脑 / 重装系统前，记得用「数据 → 导出全部作业」导一份 JSON 备份。

## 安装

### 方式一：直接用单文件（最简单）

下载 [`open-yitie.html`](open-yitie.html)，用浏览器打开就能用 —— 整个应用就这一个文件，
不需要装任何东西，断网也能用。

> 想让它开机就在大屏上常驻？用下面的桌面版。

### 方式二：桌面应用（Linux）

```bash
git clone https://github.com/cyychenyiyicyy/open-yitie.git
cd open-yitie
cd electron
npm install
npm start
```

打 deb 安装包（Linux x64）：

```bash
cd electron
npx electron-builder --linux deb
# 产物在 electron/out/
```

## 从源码构建

```bash
git clone https://github.com/cyychenyiyicyy/open-yitie.git
cd open-yitie
node build.cjs          # → open-yitie.html（单文件应用）
```

`build.cjs` 会把 `src/template.html` + `src/app.js` + `data/books-*.json` 合成
单文件，并跑 20 项自检（其中包含离线自检：产物里不允许出现 `fetch` /
云同步函数 / AI 函数 / 语音函数）。

## 目录结构

```
open-yitie/
├── open-yitie.html        ← 构建产物：整个应用（可直接在浏览器里打开）
├── build.cjs              ← 构建脚本（node build.cjs）
├── src/
│   ├── template.html      ← 页面骨架 + 全部 CSS
│   ├── app.js             ← 全部交互逻辑
│   ├── bg-art.js          ← 卡片背景图（内置图案）
│   ├── bg-photos.js       ← 卡片背景图（照片）
│   └── bg-photos.json     ← 背景图数据
├── data/
│   └── books-*.json       ← 九科教材课时表
├── electron/              ← 桌面外壳（Electron）
│   ├── main.js            ← 主进程：窗口、托盘、数据目录、（可选）更新
│   ├── preload.js         ← 页面与本机文件存储之间的桥
│   ├── mini.js / mini.html← 小窗模式
│   ├── store.js           ← data.json 的读写
│   ├── assets/            ← 应用图标、托盘图标
│   └── package.json
├── tools/
│   ├── strip-online-features.cjs  ← 从 app.js 挖掉云同步/AI/语音
│   ├── strip-template.cjs         ← 从 template.html 挖掉相关 CSS/DOM
│   ├── rename-branding.cjs        ← 改名 + 版权署名
│   ├── adapt-verify-wizard.cjs   ← 把验收台改成离线版
│   ├── static-check.cjs           ← 交付形态静态检查（含离线断言）
│   └── verify-wizard.cjs          ← 端到端验收台（274 项断言）
├── LICENSE                ← MIT
└── NOTICE                 ← 版权与致谢
```

## 二次开发

改完 `src/` 之后**必须**重新构建：

```bash
node build.cjs
node tools/static-check.cjs     # 交付形态检查（单文件、零外链、无调试残留）
```

### 想加回某个功能？

这个仓库把「去掉联网功能」这件事**做成了可重放的脚本**，而不是手删：

```bash
# 从一份「有联网功能」的源码开始：
node tools/strip-online-features.cjs   # 挖掉云同步 + AI + 语音
node tools/strip-template.cjs          # 挖掉相关的 CSS 与 DOM
node tools/rename-branding.cjs         # 改名 + 版权署名
```

改回某个功能时，看 `tools/strip-online-features.cjs` 里对应的 `cut(...)` 段落，
把它注掉，再把 `src/` 里的实现加回来即可。

## 环境要求

- 浏览器：Chromium 93+（统信 UOS 20 / 国产化环境实测通过）
- 桌面版：Node.js 18+、Electron 28+
- 页面代码刻意保持 ES5 语法（`var` + `function`），不用可选链、空值合并、
  `color-mix()`、`:has()`、`oklch()` —— 老内核上不会整条声明失效

## 已知限制

- 小窗模式（置顶窗口）只有桌面版有，浏览器里做不到
- 数据不跨设备同步，这是离线版的取舍；要备份就用「导出全部作业」

## 致谢

- 界面按 [Material Design 3](https://m3.material.io/) 规范实现
- 教材课时表由本项目整理

## 许可证

[MIT](LICENSE)　© 2026 yiyi
