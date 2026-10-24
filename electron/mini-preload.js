/* 小窗专用 preload
 * 只给 mini.html 用，暴露窗口控制和数据接收。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniAPI', {
  /* 主进程推来的作业数据 */
  onData: (fn) => {
    ipcRenderer.on('mini-data', (ev, data) => {
      try { fn(data); } catch (e) {}
    });
  },

  /* 主动要一次数据 */
  refresh: () => {
    try { ipcRenderer.send('mini-want-data'); } catch (e) {}
  },

  /* 窗口控制 */
  pin: (on) => ipcRenderer.invoke('mini-pin', on),
  minimize: () => ipcRenderer.invoke('mini-min'),
  close: () => ipcRenderer.invoke('mini-close'),
  bounds: () => ipcRenderer.invoke('mini-bounds')
});
