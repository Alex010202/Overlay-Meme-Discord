const { ipcMain, shell, screen } = require('electron')
const { saveSettings, loadProfiles, saveProfiles } = require('./settings')
const {
  getOverlayWindow,
  getSettingsWindow,
  getDrawOverlayWindow,
  getHostDrawOverlay,
  getYtView,
  registerHotkeys,
  createYtView,
  resizeYtView,
  destroyYtView,
  createHostDrawOverlay,
  showHostDrawOverlay,
  hideHostDrawOverlay,
  showDrawOverlay,
  hideDrawOverlay
} = require('./windows')
const { checkForUpdates } = require('./updater')
const { startBot, sendDrawEvent } = require('./bot')

let overlayNormalBounds = null

// ─── Draw session state ──────────────────────────────────────────────
let drawEnabled  = false
let drawCode     = null
let shareScreen  = false
let screenTimer  = null

function generateDrawCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

function broadcastDrawToServer(event, data) {
  sendDrawEvent(event, data)
}

function startScreenCapture() {
  if (screenTimer) return
  captureScreen()
  screenTimer = setInterval(captureScreen, 500)
}

function stopScreenCapture() {
  clearInterval(screenTimer)
  screenTimer = null
}

async function captureScreen() {
  if (!shareScreen || !drawEnabled) return
  try {
    const { desktopCapturer, screen: electronScreen } = require('electron')
    const display = electronScreen.getPrimaryDisplay()
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width:  Math.round(display.size.width  / 4),
        height: Math.round(display.size.height / 4)
      }
    })
    if (!sources.length) return
    const dataUrl = sources[0].thumbnail.toDataURL()
    // Send to draw overlay locally
    getDrawOverlayWindow()?.webContents.send('draw-screen-preview', dataUrl)
    // Broadcast to peers via server
    sendDrawEvent('draw-screen', { dataUrl, code: drawCode })
  } catch (err) {
    console.error('[Draw] Capture écran erreur:', err.message)
  }
}

function setupIpc() {

  // ── Existing IPC ──────────────────────────────────────────────────

  ipcMain.on('check-for-updates', () => checkForUpdates())

  ipcMain.on('set-channel', (e, channelId) => {
    global.settings = saveSettings({ channelId })
    startBot(channelId, getOverlayWindow(), getSettingsWindow())
  })

  ipcMain.on('get-channel', (e) => e.reply('current-channel', global.settings.channelId))

  ipcMain.on('set-opacity', (e, val) => {
    global.settings = saveSettings({ opacity: val })
    getOverlayWindow()?.webContents.send('set-window-opacity', val)
  })

  ipcMain.on('set-fontsize', (e, size) => {
    global.settings = saveSettings({ fontSize: size })
    getOverlayWindow()?.webContents.send('set-fontsize', size)
  })

  ipcMain.on('set-volume', (e, enabled, vol) => {
    global.settings = saveSettings({ soundEnabled: enabled, volume: vol })
    getOverlayWindow()?.webContents.send('set-volume', enabled, vol)

    const ytView = getYtView()
    if (ytView && !ytView.webContents.isDestroyed()) {
      ytView.webContents.setAudioMuted(!enabled)
      ytView.webContents.executeJavaScript(`
        (function() {
          const video = document.querySelector('video.html5-main-video')
          if (video) { video.volume = ${enabled ? vol : 0}; video.muted = ${!enabled} }
          const player = document.getElementById('movie_player')
          if (player?.setVolume) player.setVolume(${enabled ? Math.round(vol * 100) : 0})
          if (player) { ${enabled} ? player.unMute?.() : player.mute?.() }
        })()
      `).catch(err => console.error('IPC set-volume YT erreur:', err.message))
    }
  })

  ipcMain.on('set-hotkey', (e, accelerator) => {
    global.settings = saveSettings({ soundHotkey: accelerator })
    registerHotkeys()
  })

  ipcMain.on('set-skip-hotkey', (e, accelerator) => {
    global.settings = saveSettings({ skipHotkey: accelerator })
    registerHotkeys()
  })

  ipcMain.on('set-overlay-bg', (e, color) => {
    global.settings = saveSettings({ overlayBg: color })
    getOverlayWindow()?.webContents.send('set-overlay-bg', color)
  })

  ipcMain.on('get-settings', (e) => e.reply('load-settings', global.settings))

  ipcMain.on('set-durations', (e, durations) => {
    global.settings = saveSettings(durations)
    getOverlayWindow()?.webContents.send('set-durations', durations)
  })

  ipcMain.on('set-dragbar-hidden', (e, hidden) => {
    global.settings = saveSettings({ dragbarHidden: hidden })
    getOverlayWindow()?.webContents.send('set-dragbar-hidden', hidden)
  })

  ipcMain.on('set-auto-resize-media', (e, enabled) => {
    global.settings = saveSettings({ autoResizeMedia: enabled })
    getOverlayWindow()?.webContents.send('set-auto-resize-media', enabled)
  })

  ipcMain.on('save-normal-bounds', () => {
    const overlay = getOverlayWindow()
    if (!overlay || overlay.isDestroyed()) return
    overlayNormalBounds = { ...overlay.getBounds() }
  })

  ipcMain.on('resize-for-media', (e, { naturalWidth, naturalHeight }) => {
    const overlay = getOverlayWindow()
    if (!overlay || overlay.isDestroyed() || !global.settings.autoResizeMedia) return

    if (!overlayNormalBounds) overlayNormalBounds = { ...overlay.getBounds() }

    const bounds  = overlay.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const workArea = display.workArea

    const maxW = Math.floor(workArea.width * 0.8)
    const maxH = Math.floor(workArea.height * 0.8)
    const minW = 200, minH = 150

    const ratio = naturalWidth / naturalHeight
    let newW = Math.max(minW, Math.min(maxW, naturalWidth))
    let newH = Math.round(newW / ratio) + 32

    if (newH > maxH) { newH = maxH; newW = Math.round((newH - 32) * ratio) }
    newW = Math.max(minW, newW)
    newH = Math.max(minH, newH)

    let newX = bounds.x, newY = bounds.y
    if (newX + newW > workArea.x + workArea.width)  newX = workArea.x + workArea.width  - newW
    if (newY + newH > workArea.y + workArea.height) newY = workArea.y + workArea.height - newH
    if (newX < workArea.x) newX = workArea.x
    if (newY < workArea.y) newY = workArea.y

    overlay.setBounds({ x: newX, y: newY, width: newW, height: newH }, true)
  })

  ipcMain.on('reset-overlay-size', () => {
    const overlay = getOverlayWindow()
    if (!overlay || overlay.isDestroyed() || !global.settings.autoResizeMedia) return
    if (overlayNormalBounds) {
      overlay.setBounds(overlayNormalBounds, true)
      overlayNormalBounds = null
    }
  })

  ipcMain.on('get-overlay-size', (e) => {
    const overlay = getOverlayWindow()
    if (!overlay) return
    const b = overlay.getBounds()
    e.reply('overlay-size', { width: b.width, height: b.height })
  })

  ipcMain.on('set-click-through', (e, ignore) => {
    const overlay = getOverlayWindow()
    if (!overlay) return
    if (!ignore) { overlay.setIgnoreMouseEvents(false); return }

    const cursor = screen.getCursorScreenPoint()
    const bounds = overlay.getBounds()
    const onWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
                     cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height

    if (onWindow) {
      const relY = cursor.y - bounds.y
      overlay.setIgnoreMouseEvents(relY <= 24 ? false : true, { forward: true })
    } else {
      overlay.setIgnoreMouseEvents(true, { forward: true })
    }
  })

  ipcMain.on('win-minimize', () => getSettingsWindow()?.minimize())
  ipcMain.on('win-close',    () => getSettingsWindow()?.close())

  ipcMain.on('get-profiles', (e) => e.reply('load-profiles', loadProfiles()))

  ipcMain.on('save-profile', (e, { name, overwrite }) => {
    if (!name) return
    const profiles = loadProfiles()

    if (profiles[name] && !overwrite) {
      getSettingsWindow()?.webContents.send('profile-exists', name)
      return
    }

    const overlay = getOverlayWindow()
    const bounds  = (overlay && !overlay.isDestroyed())
      ? overlay.getBounds()
      : global.settings.overlayBounds

    const { channelId, ...rest } = global.settings
    profiles[name] = { ...rest, overlayBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
    saveProfiles(profiles)
    getSettingsWindow()?.webContents.send('load-profiles', profiles)
  })

  ipcMain.on('delete-profile', (e, { name }) => {
    const profiles = loadProfiles()
    delete profiles[name]
    saveProfiles(profiles)
    getSettingsWindow()?.webContents.send('load-profiles', profiles)
  })

  ipcMain.on('load-profile', (e, { name }) => {
    const profiles = loadProfiles()
    const p = profiles[name]
    if (!p) return

    global.settings = saveSettings(p)
    const overlay = getOverlayWindow()

    if (overlay && !overlay.isDestroyed()) {
      overlay.setBounds(p.overlayBounds)
      overlay.webContents.send('set-window-opacity',    global.settings.opacity)
      overlay.webContents.send('set-fontsize',          global.settings.fontSize)
      overlay.webContents.send('set-overlay-bg',        global.settings.overlayBg)
      overlay.webContents.send('set-volume',            !!global.settings.soundEnabled, global.settings.soundEnabled ? global.settings.volume : 0)
      overlay.webContents.send('set-durations', {
        durationText:  global.settings.durationText,
        durationGif:   global.settings.durationGif,
        durationVideo: global.settings.durationVideo,
        videoUntilEnd: global.settings.videoUntilEnd
      })
      overlay.webContents.send('set-dragbar-hidden',    !!global.settings.dragbarHidden)
      overlay.webContents.send('set-auto-resize-media', !!global.settings.autoResizeMedia)
    }

    getSettingsWindow()?.webContents.send('load-settings', global.settings)
    registerHotkeys()
  })

  ipcMain.on('open-profiles-folder', () => {
    const { PROFILES_PATH } = require('./settings')
    shell.showItemInFolder(PROFILES_PATH)
  })

  ipcMain.on('yt-view-create',  (e, params) => createYtView(params))
  ipcMain.on('yt-view-resize',  (e, bounds) => resizeYtView(bounds))
  ipcMain.on('yt-view-destroy', ()           => destroyYtView())

  ipcMain.on('set-yt-settings',        (e, patch) => { global.settings = saveSettings(patch) })
  ipcMain.on('save-settings-patch',    (e, patch) => { global.settings = saveSettings(patch) })

  ipcMain.on('set-yt-useragent', (e, patch) => {
    global.settings = saveSettings(patch)
    const ytView = getYtView()
    if (ytView && !ytView.webContents.isDestroyed()) {
      const { getYtUserAgent } = require('./windows')
      ytView.webContents.setUserAgent(getYtUserAgent?.() || '')
      ytView.webContents.reload()
    }
  })

  ipcMain.on('set-yt-player-settings', (e, patch) => {
    global.settings = saveSettings(patch)
    const ytView = getYtView()
    if (patch.ytQuality && ytView && !ytView.webContents.isDestroyed()) {
      ytView.webContents.executeJavaScript(`
        (function() {
          const player = document.getElementById('movie_player')
          if (player?.setPlaybackQualityRange) {
            player.setPlaybackQualityRange('${patch.ytQuality}', '${patch.ytQuality}')
          } else if (player?.setPlaybackQuality) {
            player.setPlaybackQuality('${patch.ytQuality}')
          }
        })()
      `).catch(err => console.error('IPC yt-player-settings erreur:', err.message))
    }
  })

  ipcMain.on('set-yt-live-volume', (e, pct) => {
    const ytView = getYtView()
    if (!ytView || ytView.webContents.isDestroyed()) return
    const vol = Math.max(0, Math.min(100, pct))
    ytView.webContents.executeJavaScript(`
      (function() {
        const player = document.getElementById('movie_player')
        const video  = document.querySelector('video.html5-main-video')
        if (player?.setVolume) player.setVolume(${vol})
        if (player && ${vol} > 0) player.unMute?.()
        if (player && ${vol} === 0) player.mute?.()
        if (video) { video.volume = ${vol / 100}; video.muted = ${vol === 0} }
      })()
    `).catch(err => console.error('IPC yt-live-volume erreur:', err.message))
  })

  ipcMain.on('set-yt-live-quality', (e, quality) => {
    global.settings = saveSettings({ ytQuality: quality })
    const ytView = getYtView()
    if (!ytView || ytView.webContents.isDestroyed()) return
    ytView.webContents.executeJavaScript(`
      (function() {
        const player = document.getElementById('movie_player')
        if (!player) return
        if (player.setPlaybackQualityRange) {
          player.setPlaybackQualityRange('${quality}', '${quality}')
        } else if (player.setPlaybackQuality) {
          player.setPlaybackQuality('${quality}')
        }
      })()
    `).catch(err => console.error('IPC yt-live-quality erreur:', err.message))
  })

  // ── Drawing IPC ───────────────────────────────────────────────────

  ipcMain.on('draw-enable', () => {
    drawEnabled = true
    drawCode    = generateDrawCode()
    const { screen } = require('electron')
    const { width, height } = screen.getPrimaryDisplay().size
    console.log('[Draw] Session ouverte, code:', drawCode)
    sendDrawEvent('draw-open', { code: drawCode, hostScreen: { width, height } })
    console.log('[Draw] Event draw-open envoyé au serveur')
    getSettingsWindow()?.webContents.send('draw-status', { enabled: true, code: drawCode })
    // Pré-créer l'overlay transparent de l'hôte (caché jusqu'à ce qu'un peer dessine)
    createHostDrawOverlay()
  })

  ipcMain.on('draw-disable', () => {
    drawEnabled = false
    const oldCode = drawCode
    drawCode = null
    stopScreenCapture()
    shareScreen = false
    hideDrawOverlay()
    hideHostDrawOverlay()
    sendDrawEvent('draw-close', { code: oldCode })
    getSettingsWindow()?.webContents.send('draw-status', { enabled: false, code: null })
  })

  ipcMain.on('draw-set-share-screen', (e, enabled) => {
    shareScreen = enabled
    if (enabled && drawEnabled) {
      startScreenCapture()
    } else {
      stopScreenCapture()
      // Tell peers no more screen
      sendDrawEvent('draw-screen', { dataUrl: null, code: drawCode })
      getDrawOverlayWindow()?.webContents.send('draw-screen-preview', null)
    }
  })

  // Relay draw stroke from the local overlay window → server → peers
  ipcMain.on('draw-sync', (e, data) => {
    if (!drawEnabled || !drawCode) return
    sendDrawEvent('draw-stroke', { ...data, code: drawCode })
  })

  // Relay cursor position
  ipcMain.on('draw-cursor', (e, pos) => {
    if (!drawEnabled || !drawCode) return
    sendDrawEvent('draw-cursor-move', { ...pos, code: drawCode })
  })

  // Relay full canvas sync to a new peer
  ipcMain.on('draw-full-sync', (e, dataUrl) => {
    if (!drawEnabled || !drawCode) return
    sendDrawEvent('draw-full-sync', { dataUrl, code: drawCode })
  })

  // Peer requests a full sync from the host canvas → ask the host's draw overlay to send its canvas
  ipcMain.on('draw-full-sync-request', () => {
    if (!drawEnabled || !drawCode) return
    getDrawOverlayWindow()?.webContents.send('draw-send-sync', {})
  })

  // Get current draw state for settings window
  ipcMain.on('draw-get-status', (e) => {
    e.reply('draw-status', { enabled: drawEnabled, code: drawCode, shareScreen })
  })

  // Peer joins from this client's settings window (they are the peer, not the host)
  ipcMain.on('draw-join', (e, { code, username }) => {
    console.log('[Draw] Tentative de join room:', code, 'username:', username)
    sendDrawEvent('draw-join', { code, username })
    console.log('[Draw] Event draw-join envoyé au serveur')
  })
}

module.exports = { setupIpc, getOverlayNormalBounds: () => overlayNormalBounds }