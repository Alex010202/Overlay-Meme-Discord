const { app, globalShortcut, screen, Menu } = require('electron')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, 'token.env') })

Menu.setApplicationMenu(null)

const { loadSettings, saveSettings } = require('./src/settings')
const { cleanTiktokTmp }             = require('./src/ytdlp')
const { startBot }                   = require('./src/bot')
const { setupIpc }                   = require('./src/ipc')
const {
  createOverlayWindow,
  createSettingsWindow,
  createDrawOverlayWindow,
  createHostDrawOverlay,
  createTray,
  registerHotkeys,
  getOverlayWindow
} = require('./src/windows')
const { checkForUpdates } = require('./src/updater')

global.settings = loadSettings()

cleanTiktokTmp()

app.whenReady().then(() => {
  const overlay = createOverlayWindow()
  createTray()
  createSettingsWindow()
  createDrawOverlayWindow()
  createHostDrawOverlay()
  setupIpc()
  startBot(global.settings.channelId, overlay, null)
  registerHotkeys()

  setTimeout(() => checkForUpdates(), 2000)

  setInterval(() => {
    const overlayWin = getOverlayWindow()
    if (!overlayWin || overlayWin.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = overlayWin.getBounds()
    const onWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
                     cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    const onDragbar = onWindow && cursor.y <= bounds.y + 24
    overlayWin.webContents.send('dragbar-hover', onDragbar)
  }, 50)
})

app.on('web-contents-created', (e, wc) => {
  wc.on('console-message', (e, level, message, line, sourceId) => {
    if (message.includes('[Capture]') || message.includes('[Draw]')) {
      console.log(`[RENDERER] ${message}`)
    }
  })
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  const overlayWin = getOverlayWindow()
  if (overlayWin && !overlayWin.isDestroyed()) {
    const b = overlayWin.getBounds()
    saveSettings({ overlayBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
  }
  globalShortcut.unregisterAll()
  const { destroyBot } = require('./src/bot')
  destroyBot()
})