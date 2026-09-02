const { contextBridge, ipcRenderer } = require('electron')

const SEND_CHANNELS = new Set([
  'draw-cursor', 'draw-file-send', 'draw-full-sync',
  'draw-full-sync-request', 'draw-sync'
])

const ON_CHANNELS = new Set([
  'draw-flash', 'draw-host-screen-size', 'draw-peer-disconnected',
  'draw-remote-cursor', 'draw-remote-stroke', 'draw-screen-preview',
  'draw-send-sync', 'draw-request-sync'
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
