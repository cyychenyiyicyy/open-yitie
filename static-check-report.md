# 静态检查报告

- 被测文件：`open-yitie.html`
- 时间：2026-10-24T04:34:57.702Z
- 结果：**43 通过 / 0 失败 / 共 43**

## 单文件  (8/8)

- ✅ 是一个完整 HTML 文档
- ✅ 没有外部 <script src>
- ✅ 没有外部 <link rel=stylesheet>
- ✅ 没有任何 http(s) 外链（含 img / url() / fetch）
- ✅ CSS 里没有 url(http...) 外链
- ✅ 没有 @import
- ✅ token 不硬编码在页面里
- ✅ 用到的 data: URI 都是内联的（不是网络图）

## 离线  (8/8)

- ✅ 代码里完全没有 fetch()
- ✅ 代码里没有 XMLHttpRequest / WebSocket / EventSource
- ✅ 代码里没有云同步函数
- ✅ 代码里没有 AI 相关函数
- ✅ 代码里没有语音相关函数
- ✅ 没有任何第三方 API 域名
- ✅ 品牌名是 Open作业贴
- ✅ 版权署名是 yiyi

## 样式  (1/1)

- ✅ 所有 var(--md-sys-color-*) 都有定义

## 兼容性  (7/7)

- ✅ 不使用 color-mix()
- ✅ 不使用 :has() 选择器
- ✅ 不使用 dialog 元素的 showModal
- ✅ JS 里没有可选链 ?. 或空值合并 ??
- ✅ JS 严格模式且用 var/function（不依赖新语法）
- ✅ 有 prefers-reduced-motion 降级
- ✅ 颜色用 rgb()/rgba() 而不是 oklch()/lab()

## 内容  (11/11)

- ✅ 九科教材数据全部内联
- ✅ BOOKS 数据能正常 JSON 解析且 seq 连续
- ✅ 关键 DOM 节点齐全
- ✅ 卡片背景（Beta）：背景层 + Beta 胶囊 + 开关都在
- ✅ 科目卡片右上角「编辑」按钮的文案在
- ✅ FAB 文字是「添加作业」
- ✅ 弹窗里有「快捷添加」「自定义」两个页签
- ✅ 备注预设词包含「不用写」「只要写」
- ✅ 有「退出」按钮
- ✅ 打印样式存在
- ✅ 有跨零点自动翻页逻辑

## 卫生  (5/5)

- ✅ 生产代码里没有 console.log
- ✅ 没有 debugger 语句
- ✅ 没有 TODO / FIXME / XXX 残留
- ✅ 没有占位符残留
- ✅ 没有把 localhost / 127.0.0.1 写进去

## 体积  (3/3)

- ✅ 单文件不超过 550 KB
- ✅ 单文件不算太小（说明数据真的内联进来了）
- ✅ 只有一处 <style> 和一处 <script>
