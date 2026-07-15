const WebSocket = require('ws')
const {
  isTikTokUrl,
  fetchYtDlpStream,
  fetchYtDlpTikTokFile,
  fetchYtDlpMeta
} = require('./ytdlp')
const WS_URL    = process.env.WS_URL    || ''
const WS_SECRET = process.env.WS_SECRET || ''
let ws = null
let overlayWinRef  = null
let reconnectTimer = null
let destroyed      = false
let activeDrawCode = null
function setActiveDrawCode(code) {
  activeDrawCode = code || null
}
let activeChannelId = null
function setActiveChannelId(channelId) {
  activeChannelId = channelId || null
  sendDrawEvent('set-channel', { channelId: activeChannelId })
}
function buildWsUrl() {
  if (!WS_URL) return null
  const url = new URL(WS_URL)
  if (WS_SECRET) url.searchParams.set('secret', WS_SECRET)
  return url.toString()
}
async function onServerEvent(event, data) {
  const overlay = overlayWinRef
  if (!overlay || overlay.isDestroyed()) return
  if (event === 'status') {
    const { getOverlayWindow, getSettingsWindow } = require('./windows')
    getOverlayWindow()?.webContents.send('status', data)
    getSettingsWindow()?.webContents.send('status', data)
    return
  }
  if (event === 'message') {
    overlay.webContents.send('message', data)
    return
  }
  if (event === 'draw-joined') {
    console.log('[Draw] draw-joined reçu du serveur:', data)
    const { getSettingsWindow, getDrawOverlayWindow, showDrawOverlay } = require('./windows')
    getSettingsWindow()?.webContents.send('draw-joined', data)
    if (data.ok) {
      require('./ipc').setPeerDrawCode(data.code)
      const hw = data.hostScreen?.width
      const hh = data.hostScreen?.height
      showDrawOverlay(hw, hh)
      const drawWin = getDrawOverlayWindow()
      if (drawWin && !drawWin.isDestroyed()) {
        const send = () => {
          drawWin.webContents.send('draw-flash', 'Connecté à la session !')
          drawWin.webContents.send('draw-request-sync', data)
          if (data.hostScreen) {
            drawWin.webContents.send('draw-host-screen-size', { ...data.hostScreen, isPeer: true })
          }
        }
        if (drawWin.webContents.isLoading()) {
          drawWin.webContents.once('did-finish-load', send)
        } else {
          send()
        }
      }
    }
    return
  }

  if (event === 'draw-screen-resize') {
  const { getDrawOverlayWindow } = require('./windows')
  getDrawOverlayWindow()?.webContents.send('draw-host-screen-size', { ...data, isPeer: true })
  return
}

  if (event === 'draw-closed') {
    require('./ipc').setPeerDrawCode(null)
    const { getDrawOverlayWindow, getSettingsWindow, hideDrawOverlay, hideHostDrawOverlay, getHostDrawOverlay } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-flash', 'Session terminée par l\'hôte')
    getHostDrawOverlay()?.webContents.send('draw-clear')
    getSettingsWindow()?.webContents.send('draw-status', { enabled: false, code: null })
    setTimeout(() => { hideDrawOverlay(); hideHostDrawOverlay() }, 2000)
    return
  }
  if (event === 'draw-stroke') {
    const { getDrawOverlayWindow, getHostDrawOverlay, showHostDrawOverlay } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-remote-stroke', data)
    showHostDrawOverlay()
    getHostDrawOverlay()?.webContents.send('draw-remote-stroke', data)
    return
  }
  if (event === 'draw-cursor') {
    const { getDrawOverlayWindow } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-remote-cursor', data)
    return
  }
  if (event === 'draw-screen') {
    console.log('[Draw] draw-screen reçu, dataUrl:', data.dataUrl ? data.dataUrl.slice(0, 50) + '...' : 'NULL')
    const { getDrawOverlayWindow, showDrawOverlay } = require('./windows')
    showDrawOverlay()
    getDrawOverlayWindow()?.webContents.send('draw-screen-preview', data.dataUrl)
    return
  }
  if (event === 'draw-peer-joined') {
    console.log('[Draw] draw-peer-joined reçu:', data)
    const { getDrawOverlayWindow, getSettingsWindow } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-send-sync', data)
    getDrawOverlayWindow()?.webContents.send('draw-flash', `${data.username || 'Quelqu\'un'} a rejoint le dessin`)
    getSettingsWindow()?.webContents.send('draw-peer-joined', data)
    return
  }
  if (event === 'draw-peer-left') {
    const { getDrawOverlayWindow, getSettingsWindow } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-peer-disconnected', data)
    getSettingsWindow()?.webContents.send('draw-peer-left', data)
    return
  }
  if (event === 'draw-full-sync') {
    const { getDrawOverlayWindow } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-remote-stroke', { type: 'full-sync', dataUrl: data.dataUrl })
    return
  }
  if (event === 'draw-file') {
    const { getHostDrawOverlay, showHostDrawOverlay } = require('./windows')
    showHostDrawOverlay()
    getHostDrawOverlay()?.webContents.send('draw-file-show', data)
    return
  }
  if (event === 'draw-full-sync-request') {
    const { getDrawOverlayWindow } = require('./windows')
    getDrawOverlayWindow()?.webContents.send('draw-send-sync', data)
    return
  }
  if (event === 'ytdlp-needed') {
    const { url, type, content, author, avatar, time } = data
    if (type === 'tiktok') {
      const [filePath, meta] = await Promise.all([
        fetchYtDlpTikTokFile(url, global.settings),
        fetchYtDlpMeta(url, global.settings)
      ]).catch(err => {
        console.error('TikTok resolve erreur:', err.message)
        return [null, null]
      })
      overlay.webContents.send('ytdlp-resolved', {
        loadingUrl: url,
        videoUrl:  filePath ? `file:///${filePath.replace(/\\/g, '/')}` : null,
        audioUrl:  null,
        title:     meta?.title      || null,
        thumbnail: meta?.thumbnail  || null,
        duration:  meta?.duration   || null,
        uploader:  meta?.uploader || meta?.channel || null,
        sourceUrl: url
      })
    } else {
      const [streams, meta] = await Promise.all([
        fetchYtDlpStream(url, global.settings),
        fetchYtDlpMeta(url, global.settings)
      ]).catch(err => {
        console.error('yt-dlp resolve erreur:', err.message)
        return [null, null]
      })
      overlay.webContents.send('ytdlp-resolved', {
        loadingUrl: url,
        videoUrl:  streams?.video || null,
        audioUrl:  streams?.audio || null,
        title:     meta?.title    || null,
        thumbnail: meta?.thumbnail || null,
        duration:  meta?.duration  || null,
        uploader:  meta?.uploader || meta?.channel || null,
        sourceUrl: url
      })
    }
  }
}
function sendDrawEvent(event, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ e: event, d: data }))
  } else {
    console.warn('[Draw] WS pas prêt, event perdu:', event)
  }
}
let lastCursorSent = 0
const CURSOR_INTERVAL_MS = 50
function sendCursorEvent(data) {
  const now = Date.now()
  if (now - lastCursorSent < CURSOR_INTERVAL_MS) return
  lastCursorSent = now
  sendDrawEvent('draw-cursor-move', data)
}
function connect() {
  if (destroyed) return
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  const url = buildWsUrl()
  if (!url) {
    console.error('[Bot] WS_URL manquant dans token.env')
    const { getOverlayWindow, getSettingsWindow } = require('./windows')
    getOverlayWindow()?.webContents.send('status', { ok: false, error: 'WS_URL manquant' })
    getSettingsWindow()?.webContents.send('status', { ok: false, error: 'WS_URL manquant' })
    return
  }
  console.log('[Bot] Connexion WebSocket à', WS_URL)
  ws = new WebSocket(url, { perMessageDeflate: true })
  ws.on('open', () => {
    console.log('[Bot] WebSocket connecté')
    clearTimeout(reconnectTimer)
    const { getOverlayWindow, getSettingsWindow } = require('./windows')
    getOverlayWindow()?.webContents.send('status', { ok: true, tag: 'Connecté' })
    getSettingsWindow()?.webContents.send('status', { ok: true, tag: 'Connecté' })
    if (activeDrawCode) {
      const { screen } = require('electron')
      const display     = screen.getPrimaryDisplay()
      const scaleFactor = display.scaleFactor || 1
      const cssW = Math.round(display.size.width  / scaleFactor)
      const cssH = Math.round(display.size.height / scaleFactor)
      sendDrawEvent('draw-open', { code: activeDrawCode, hostScreen: { width: cssW, height: cssH } })
    }
    sendDrawEvent('set-channel', { channelId: activeChannelId })
  })
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw)
      const event = msg.e ?? msg.event
      const data  = msg.d ?? msg.data
      onServerEvent(event, data).catch(err => {
        console.error('[Bot] Erreur événement', event, ':', err.message)
      })
    } catch (err) {
      console.error('[Bot] Message invalide reçu:', err.message)
    }
  })
  ws.on('close', (code) => {
    console.warn(`[Bot] WebSocket fermé (${code}) — reconnexion dans 5s...`)
    if (!destroyed) reconnectTimer = setTimeout(connect, 5000)
  })
  ws.on('error', (err) => {
    console.error('[Bot] Erreur WebSocket:', err.message)
  })
}
function startBot(channelId, overlayWindow) {
  activeChannelId = channelId || null
  if (ws && ws.readyState === 1) {
    overlayWinRef = overlayWindow
    sendDrawEvent('set-channel', { channelId: activeChannelId })
    return
  }
  destroyBot()
  overlayWinRef = overlayWindow
  destroyed     = false
  connect()
}
function destroyBot() {
  destroyed = true
  clearTimeout(reconnectTimer)
  if (ws) {
    try { ws.close() } catch (err) {
      console.error('[Bot] Erreur fermeture WS:', err.message)
    }
    ws = null
  }
}
module.exports = { startBot, destroyBot, sendDrawEvent, sendCursorEvent, setActiveDrawCode, setActiveChannelId }