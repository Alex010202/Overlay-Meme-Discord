const { contextBridge, ipcRenderer } = require('electron')

const SEND_CHANNELS = new Set([
  'set-click-through', 'resize-for-media', 'get-overlay-size',
  'reset-overlay-size', 'get-settings', 'yt-view-create',
  'yt-view-resize', 'yt-view-destroy'
])

const ON_CHANNELS = new Set([
  'dragbar-hover', 'overlay-size', 'skip-media', 'ytdlp-resolved',
  'message', 'set-fontsize', 'set-volume', 'set-overlay-bg',
  'set-window-opacity', 'set-durations', 'set-dragbar-hidden',
  'set-auto-resize-media', 'load-settings'
])

contextBridge.exposeInMainWorld('ipc', {
  send(channel, ...args) {
    if (!SEND_CHANNELS.has(channel)) return
    ipcRenderer.send(channel, ...args)
  },
  on(channel, listener) {
    if (!ON_CHANNELS.has(channel)) return
    ipcRenderer.on(channel, listener)
  }
})
