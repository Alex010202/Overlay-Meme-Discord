const { contextBridge, ipcRenderer, clipboard } = require('electron')

const SEND_CHANNELS = new Set([
  'check-for-updates', 'debug-log', 'invite-bot', 'set-channel',
  'get-channel', 'set-opacity', 'set-fontsize', 'set-volume',
  'set-hotkey', 'set-skip-hotkey', 'set-overlay-bg', 'get-settings',
  'set-durations', 'set-dragbar-hidden', 'set-auto-resize-media',
  'save-normal-bounds', 'win-minimize', 'win-close', 'get-profiles',
  'save-profile', 'delete-profile', 'load-profile',
  'open-profiles-folder', 'set-yt-settings', 'save-settings-patch',
  'set-yt-useragent', 'set-yt-player-settings', 'set-yt-live-volume',
  'set-yt-live-quality', 'draw-enable', 'draw-disable',
  'draw-set-share-screen', 'draw-set-share-settings', 'draw-get-status',
  'draw-join'
])

const ON_CHANNELS = new Set([
  'status', 'channel-status', 'sound-toggled', 'load-profiles',
  'load-settings', 'update-status', 'app-version', 'draw-status',
  'draw-peer-joined', 'draw-peer-left', 'draw-joined',
  'current-channel', 'overlay-size'
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

contextBridge.exposeInMainWorld('clipboardAPI', {
  writeText: (text) => clipboard.writeText(String(text))
})
