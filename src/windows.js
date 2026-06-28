const { BrowserWindow, BrowserView, Tray, Menu, nativeImage, globalShortcut, screen } = require('electron')
const path = require('path')
const { loadSettings, saveSettings, loadProfiles } = require('./settings')
const { app } = require('electron')

let overlayWindow     = null
let settingsWindow    = null
let drawOverlayWindow = null
let hostDrawOverlay   = null
let ytView            = null
let tray              = null
let endCheckInterval  = null

let _onDrawWindowClosed = null

function setOnDrawWindowClosed(fn) {
  _onDrawWindowClosed = fn
}

const YT_UA_PRESETS = {
  'chrome-win':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'chrome-mac':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'firefox-win':  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'edge-win':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  'safari-mac':   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'chrome-linux': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
}

function getYtUserAgent() {
  const s = global.settings
  if (s.ytUaPreset === 'custom' && s.ytUaCustom) return s.ytUaCustom
  return YT_UA_PRESETS[s.ytUaPreset] || YT_UA_PRESETS['chrome-win']
}

function getOverlayWindow()     { return overlayWindow }
function getSettingsWindow()    { return settingsWindow }
function getDrawOverlayWindow() { return drawOverlayWindow }
function getHostDrawOverlay()   { return hostDrawOverlay }
function getYtView()            { return ytView }

function createOverlayWindow() {
  const bounds = global.settings.overlayBounds || { width: 360, height: 260, x: 20, y: 20 }

  overlayWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      allowRunningInsecureContent: true
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.loadFile('overlay.html')

  const ses = overlayWindow.webContents.session

  ses.webRequest.onBeforeSendHeaders(
    { urls: ['*://*.tiktok.com/*', '*://*.tiktokcdn.com/*', '*://*.tiktokv.com/*'] },
    (details, callback) => {
      const headers = { ...details.requestHeaders }
      headers['Referer']    = 'https://www.tiktok.com/'
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      headers['Origin']     = 'https://www.tiktok.com'
      callback({ requestHeaders: headers })
    }
  )

  ses.webRequest.onBeforeRequest(
    { urls: ['*://*.doubleclick.net/*', '*://*.googlesyndication.com/*', '*://*.googleadservices.com/*'] },
    (details, callback) => callback({ cancel: true })
  )

  return overlayWindow
}

function createDrawOverlayWindow(hostWidth, hostHeight) {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) {
    if (hostWidth && hostHeight) resizeDrawWindow(hostWidth, hostHeight)
    return drawOverlayWindow
  }

  // Toujours utiliser la taille physique totale de l'écran (taskbar incluse)
  // pour que le canvas couvre exactement les mêmes pixels que l'écran de l'hôte.
  const { width: sw, height: sh } = screen.getPrimaryDisplay().size

  drawOverlayWindow = new BrowserWindow({
    width:  sw,
    height: sh,
    x: 0,
    y: 0,
    frame: true,
    title: 'Session de dessin',
    alwaysOnTop: false,
    skipTaskbar: false,
    resizable: true,
    movable: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  })

  drawOverlayWindow.loadFile('draw-overlay.html')
  drawOverlayWindow.hide()

  drawOverlayWindow.on('closed', () => {
    drawOverlayWindow = null
    if (_onDrawWindowClosed) _onDrawWindowClosed()
  })

  return drawOverlayWindow
}

function resizeDrawWindow(hostWidth, hostHeight) {
  if (!drawOverlayWindow || drawOverlayWindow.isDestroyed()) return
  // On reste toujours en plein écran physique — le HTML gère le scaling interne
  const { width: sw, height: sh } = screen.getPrimaryDisplay().size
  drawOverlayWindow.setBounds({ x: 0, y: 0, width: sw, height: sh }, true)
}

function showDrawOverlay(hostWidth, hostHeight) {
  const isNew = !drawOverlayWindow || drawOverlayWindow.isDestroyed()
  if (isNew) {
    createDrawOverlayWindow(hostWidth, hostHeight)
  }
  if (!drawOverlayWindow.isVisible()) {
    drawOverlayWindow.show()
    drawOverlayWindow.focus()
  }
}

function hideDrawOverlay() {
  if (drawOverlayWindow && !drawOverlayWindow.isDestroyed()) drawOverlayWindow.hide()
}

function createHostDrawOverlay() {
  if (hostDrawOverlay && !hostDrawOverlay.isDestroyed()) return hostDrawOverlay

  const b = screen.getPrimaryDisplay().bounds

  hostDrawOverlay = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false,
      enableRemoteModule: true
    }
  })

  hostDrawOverlay.setAlwaysOnTop(true, 'pop-up-menu')
  hostDrawOverlay.setIgnoreMouseEvents(true, { forward: true })
  //hostDrawOverlay.setContentProtection(true)
  hostDrawOverlay.loadFile('host-draw-overlay.html')

  // Force les bounds après loadFile — Electron/Windows peut reclipper
  // la fenêtre à workArea pendant le chargement
  hostDrawOverlay.webContents.once('did-finish-load', () => {
    const b2 = screen.getPrimaryDisplay().bounds
    hostDrawOverlay.setBounds({ x: b2.x, y: b2.y, width: b2.width, height: b2.height })
  })

  hostDrawOverlay.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') return callback(true)
    callback(false)
  })
  hostDrawOverlay.webContents.session.setPermissionCheckHandler((wc, permission) => {
    if (permission === 'media') return true
    return false
  })
  hostDrawOverlay.hide()

  hostDrawOverlay.on('closed', () => { hostDrawOverlay = null })

  return hostDrawOverlay
}

function showHostDrawOverlay() {
  if (!hostDrawOverlay || hostDrawOverlay.isDestroyed()) createHostDrawOverlay()
  hostDrawOverlay.setIgnoreMouseEvents(true, { forward: true })
  hostDrawOverlay.setAlwaysOnTop(true, 'pop-up-menu')
  hostDrawOverlay.show()
  // setBounds après show() force la fenêtre à couvrir toute la résolution
  // taskbar incluse — Windows bloque ça à la création mais pas après show()
  const b = screen.getPrimaryDisplay().bounds
  hostDrawOverlay.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height })
}

function hideHostDrawOverlay() {
  if (hostDrawOverlay && !hostDrawOverlay.isDestroyed()) hostDrawOverlay.hide()
}

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return }

  settingsWindow = new BrowserWindow({
    width: 560,
    height: 460,
    minWidth: 400,
    minHeight: 320,
    resizable: true,
    frame: false,
    title: 'Discord Overlay - Settings',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })

  settingsWindow.loadFile('settings.html')

  settingsWindow.on('closed', () => {
    settingsWindow = null
    app.quit()
  })

  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('load-settings', global.settings)
    settingsWindow.webContents.send('load-profiles', loadProfiles())
    settingsWindow.webContents.send('app-version', app.getVersion())
  })
}

function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABMklEQVR4nO2Wy0rDQBSGz6SJpF6wCy9QEHHhTlS8oAt8AB9A8AU09AHs0o0PoQtBF1asWFGsVCiIFy9QBBEUFRQUrSCKoCCKxYwcGJI0yUzSRRf+cJY5c75/5jwJkJCQkJCQkPgHdIDrNAGgBeANgAkAYQDXOecS8MiA0rBFwDUAjHPOGWOcMXbIOeecc84ZY845Z4wRxhhCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEEEIIIYQQQgghhBBCCCGEkH/gC3pXME7cI5TAAAAAAElFTkSuQmCC')
  tray = new Tray(icon)
  tray.setToolTip('Discord Overlay')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Ouvrir les settings', click: () => createSettingsWindow() },
    { label: 'Quitter', click: () => app.quit() }
  ]))
  tray.on('click', () => createSettingsWindow())
}

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const s = global.settings

  if (s.soundHotkey) {
    try {
      globalShortcut.register(s.soundHotkey, () => {
        global.settings.soundEnabled = !global.settings.soundEnabled
        global.settings = saveSettings({ soundEnabled: global.settings.soundEnabled })

        const vol = global.settings.soundEnabled ? global.settings.volume : 0
        overlayWindow?.webContents.send('set-volume', global.settings.soundEnabled, vol)
        settingsWindow?.webContents.send('sound-toggled', global.settings.soundEnabled)

        if (ytView && !ytView.webContents.isDestroyed()) {
          ytView.webContents.setAudioMuted(!global.settings.soundEnabled)
          ytView.webContents.executeJavaScript(`
            (function() {
              const player = document.getElementById('movie_player')
              const video = document.querySelector('video.html5-main-video')
              if (player?.setVolume) player.setVolume(${global.settings.soundEnabled ? Math.round(global.settings.volume * 100) : 0})
              if (player) { ${global.settings.soundEnabled} ? player.unMute?.() : player.mute?.() }
              if (video) { video.volume = ${global.settings.soundEnabled ? global.settings.volume : 0}; video.muted = ${!global.settings.soundEnabled} }
            })()
          `).catch(err => console.error('YT volume hotkey erreur:', err.message))
        }
      })
    } catch (err) {
      console.error('Raccourci son invalide:', err.message)
    }
  }

  if (s.skipHotkey) {
    try {
      globalShortcut.register(s.skipHotkey, () => {
        overlayWindow?.webContents.send('skip-media')
      })
    } catch (err) {
      console.error('Raccourci skip invalide:', err.message)
    }
  }
}

function createYtView({ videoId, x, y, width, height }) {
  if (!overlayWindow) return

  destroyYtView()

  ytView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true
    }
  })

  ytView.webContents.setUserAgent(getYtUserAgent())
  overlayWindow.addBrowserView(ytView)
  ytView.setBounds({ x, y, width, height })
  ytView.setAutoResize({ width: false, height: false })
  ytView.webContents.setAudioMuted(!global.settings.soundEnabled)
  ytView.webContents.loadURL(`https://www.youtube.com/watch?v=${videoId}&autoplay=1`)

  const noFs = global.settings.ytNoFullscreen !== false

  ytView.webContents.on('enter-html-full-screen', () => {
    ytView.webContents.executeJavaScript(
      `if (document.fullscreenElement) document.exitFullscreen().catch(() => {})`
    ).catch(err => console.error('YT fullscreen erreur:', err.message))
  })

  const inject = () => {
    const url = ytView.webContents.getURL()
    if (!url.includes('youtube.com/watch')) return

    ytView.webContents.executeJavaScript(`
      (function() {
        if (window.__overlayInjected) return
        window.__overlayInjected = true

        setInterval(() => {
          const btn = document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')
          if (btn) btn.click()
          const adShowing = document.querySelector('.ad-showing')
          if (adShowing) {
            const video = document.querySelector('video')
            if (video?.duration) video.currentTime = video.duration
            if (video) video.muted = true
          } else {
            const video = document.querySelector('video')
            if (video) video.muted = ${!global.settings.soundEnabled}
          }
          const endscreen = document.querySelector('.ytp-endscreen-content, .ytp-ce-element')
          if (endscreen) window.__ytEnded = true
        }, 20)

        ${noFs ? `
          Element.prototype.requestFullscreen = function() { return Promise.resolve() }
          document.addEventListener('fullscreenchange', () => {
            if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          })
        ` : ''}

        const style = document.createElement('style')
        style.id = '__overlay-style'
        style.textContent =
          '#masthead, ytd-masthead, #masthead-container, tp-yt-app-header { display:none!important }' +
          'ytd-watch-flexy { --ytd-masthead-height: 0px!important }' +
          '#page-manager { margin-top: 0!important; padding-top: 0!important }' +
          'ytd-watch-next-secondary-results-renderer, #secondary { display:none!important }' +
          '#below, #comments, ytd-miniplayer { display:none!important }' +
          'tp-yt-paper-dialog, ytd-popup-container, ytd-consent-bump-v2-lightbox { display:none!important }' +
          '#cookie-banner, .ytd-consent-bump-v2-renderer { display:none!important }' +
          '.ytp-pause-overlay, .ytp-endscreen-content { display:none!important }' +
          'html, body { overflow:hidden!important; margin:0!important; padding:0!important }' +
          ${noFs ? `'.ytp-fullscreen-button { display:none!important }'` : `''`}
        if (!document.getElementById('__overlay-style')) document.head.appendChild(style)

        const run = () => {
          const player = document.getElementById('movie_player')
          const video  = document.querySelector('video.html5-main-video')
          if (!player || !video) return false

          if (!video.__endedListener) {
            video.__endedListener = true
            video.addEventListener('ended', () => { window.__ytEnded = true })
          }

          if (player.setVolume) player.setVolume(${Math.round((global.settings.soundEnabled ? global.settings.volume : 0) * 100)})
          if (player.unMute && ${global.settings.soundEnabled}) player.unMute()
          if (player.mute   && ${!global.settings.soundEnabled}) player.mute()

          video.volume = ${global.settings.soundEnabled ? global.settings.volume : 0}
          video.muted  = ${!global.settings.soundEnabled}

          if (player.setPlaybackQuality) player.setPlaybackQuality('${global.settings.ytQuality || 'hd720'}')
          if (player.playVideo) player.playVideo()

          const rect = player.getBoundingClientRect()
          window.scrollTo(0, rect.top + window.scrollY)
          return true
        }

        let tries = 0
        const iv = setInterval(() => {
          tries++
          if (run() || tries > 40) clearInterval(iv)
        }, 200)
      })()
    `).catch(err => console.error('YT inject erreur:', err.message))
  }

  ytView.webContents.on('did-finish-load', inject)
  ytView.webContents.on('dom-ready', inject)

  endCheckInterval = null

const checkEnded = () => {
  if (!ytView || ytView.webContents.isDestroyed()) {
    clearInterval(endCheckInterval)
    return
  }
  ytView.webContents.executeJavaScript(`
    (function() {
      const video = document.querySelector('video.html5-main-video')
      if (!video || !video.duration) return 0
      return video.duration - video.currentTime
    })()
  `).then(remaining => {
    if (remaining > 0 && remaining <= 0.5) {
      clearInterval(endCheckInterval)
      overlayWindow?.webContents.send('skip-media')
    }
  }).catch(() => clearInterval(endCheckInterval))
}

endCheckInterval = setInterval(checkEnded, 500)
}

function resizeYtView(bounds) {
  if (ytView) ytView.setBounds(bounds)
}

function destroyYtView() {
  if (!ytView || !overlayWindow) return
    clearInterval(endCheckInterval)  // ← ajoute ça
    endCheckInterval = null
  try { overlayWindow.removeBrowserView(ytView) } catch (err) {
    console.error('Erreur suppression BrowserView:', err.message)
  }
  try { ytView.webContents.destroy() } catch (err) {
    console.error('Erreur destruction webContents YT:', err.message)
  }
  ytView = null
}

module.exports = {
  getOverlayWindow,
  getSettingsWindow,
  getDrawOverlayWindow,
  getHostDrawOverlay,
  getYtView,
  createOverlayWindow,
  createSettingsWindow,
  createDrawOverlayWindow,
  showDrawOverlay,
  hideDrawOverlay,
  createHostDrawOverlay,
  showHostDrawOverlay,
  hideHostDrawOverlay,
  createTray,
  registerHotkeys,
  createYtView,
  resizeYtView,
  destroyYtView,
  getYtUserAgent,
  setOnDrawWindowClosed
}