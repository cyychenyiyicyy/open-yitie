/* Open作业贴 · preload
 *
 * 两个职责：
 *   1. 给页面一个「同步」的文件存储接口（数据与页面分离的关键）
 *   2. 暴露更新检查等应用能力
 *
 * 为什么用 sendSync：页面现有代码是同步读写数据库的，
 *   invoke 是异步的会打乱时序。数据量只有几十 KB，同步完全可接受。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yitie', {
  isApp: true,

  /* ---------- 存储（同步，与 localStorage 用法一致） ---------- */
  store: {
    /* 读：返回字符串或 null */
    get: () => {
      try { return ipcRenderer.sendSync('store-get'); } catch (e) { return null; }
    },
    /* 写：返回 true/false */
    set: (text) => {
      try { return ipcRenderer.sendSync('store-set', String(text)); } catch (e) { return false; }
    },
    info: () => ipcRenderer.invoke('store-info')
  },

  /* ---------- 小窗模式 ---------- */
  mini: {
    /* 打开（或复用）小窗，data 是 buildMiniData() 的结果 */
    open: (data) => ipcRenderer.invoke('mini-open', data),
    /* 更新小窗内容 */
    update: (data) => ipcRenderer.invoke('mini-update', data),
    /* 关闭小窗 */
    close: () => ipcRenderer.invoke('mini-close'),
    /* 是否已开 */
    isOpen: () => ipcRenderer.invoke('mini-is-open'),
    /* 小窗请求刷新它的数据时回调 */
    onRefreshRequest: (fn) => {
      ipcRenderer.on('mini-need-data', (ev) => {
        try { fn(); } catch (e) {}
      });
    },
    /* 托盘菜单请求打开小窗 */
    onOpenRequest: (fn) => {
      ipcRenderer.on('open-mini', (ev) => {
        try { fn(); } catch (e) {}
      });
    }
  },

  /* ---------- 应用信息 / 更新 ---------- */
  info: () => ipcRenderer.invoke('app-info'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),

  /* 主进程推来的提示 */
  onToast: (fn) => {
    ipcRenderer.on('toast', (ev, payload) => { try { fn(payload); } catch (e) {} });
  }
});
