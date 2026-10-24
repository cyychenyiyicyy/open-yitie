## Open作业贴 v1.0.0 —— 开源离线版

教室大屏作业看板的**开源离线发行版**。

- **完全离线**：不联网、不上传、不需要账号，数据只存在本机
- **改名**：作业贴 → **Open作业贴**
- **版权**：© 2026 **yiyi**，MIT 许可证
- **仓库**：https://github.com/cyychenyiyicyy/open-yitie

---

### 附件

| 文件 | 说明 |
|---|---|
| `open-yitie.html` | **单文件应用**，下载后用浏览器打开就能用（无需安装、断网可用） |

桌面版（Electron）请从源码构建，见仓库 README。

---

### 相对原版移除的功能

| 移除项 | 说明 |
|---|---|
| **云同步** | 不再连 Gitee / GitHub 推拉数据，不再存 token |
| **云端自动更新** | 应用启动不再联网检查更新；新版本手动从仓库获取 |
| **语音输入** | 麦克风按钮、录音、AudioWorklet 采集全部移除 |
| **AI** | 「AI 添加」弹窗、模型配置、对话/识别/合成调用、密钥管理全部移除 |
| **第三方 API** | 产物里**没有** `fetch` / `XMLHttpRequest` / `WebSocket` |

### 保留的功能

- 九科作业录入（语文/数学/英语/物理/化学/生物/政治/历史/地理）
- 分步向导：选类型 → 选作业本 → 填页码/课时 → 补充信息
- 内置教材课时表（250 课时），可直接选「同步学与练 P20」
- 提交时效高亮（今天/明天/第几节/早读午休晚自习）
- 备注条款快捷录入（「不用写」「只要写前三题」「明天要交」）
- 作业本 / 快捷词自定义
- 卡片自定义背景（Beta）
- **小窗模式**：置顶小窗，讲评时一边展示别的资料一边看作业
- 本周总览
- 深色 / 浅色主题、整屏字号可调、全屏展示
- 导出 JSON / Markdown 备份、导入、打印

---

### 验证结果

| 项目 | 结果 |
|---|---|
| 静态检查（交付形态 + 离线断言） | **43 / 43 通过** |
| 端到端验收（Edge headless，24 个场景） | **274 / 274 通过** |
| 构建产物 | 465.6 KB，单文件、零外链 |
| 兼容性 | 保持 ES5 语法，老内核（统信 UOS 20 / Chromium 93）实测通过 |

---

### 安装

**最简单**：下载 `open-yitie.html`，浏览器打开即用。

**桌面版**：

```bash
git clone https://github.com/cyychenyiyicyy/open-yitie.git
cd open-yitie/electron
npm install
npm start
```

**从源码构建单文件**：

```bash
node build.cjs
```

---

### 二次开发

本仓库把「去掉联网功能」做成了**可重放的脚本**，而不是手删：

```bash
node tools/strip-online-features.cjs   # 从 app.js 挖掉云同步 + AI + 语音
node tools/strip-template.cjs          # 从 template.html 挖掉相关 CSS / DOM
node tools/rename-branding.cjs         # 改名 + 版权署名
```

想加回某个功能，看 `tools/strip-online-features.cjs` 里对应的 `cut(...)` 段落，注掉即可。

---

### 许可与致谢

MIT License © 2026 yiyi。完整条款见仓库 `LICENSE` 与 `NOTICE`。
界面按 [Material Design 3](https://m3.material.io/) 规范自行实现。
