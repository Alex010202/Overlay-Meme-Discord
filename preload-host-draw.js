const { contextBridge, ipcRenderer } = require('electron')

const SEND_CHANNELS = new Set(['capture-frame'])

const ON_CHANNELS = new Set([
  'draw-remote-stroke', 'draw-clear', 'draw-file-show',
  'capture-start', 'capture-stop'
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
