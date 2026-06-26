const WebSocket = require('ws')
const {
  isTikTokUrl,
  fetchYtDlpStream,
  fetchYtDlpTikTokFile,
  fetchYtDlpMeta
} = require('./ytdlp')

// URL du serveur Railway — à mettre dans token.env :
//   WS_URL=wss://ton-projet.railway.app
//   WS_SECRET=mot_de_passe_secret  (optionnel mais recommandé)
const WS_URL    = process.env.WS_URL    || ''
const WS_SECRET = process.env.WS_SECRET || ''

let ws = null
let overlayWinRef = null
let reconnectTimer = null
let destroyed = false

function buildWsUrl() {
  if (!WS_URL) return null
  const url = new URL(WS_URL)
  if (WS_SECRET) url.searchParams.set('secret', WS_SECRET)
  return url.toString()
}

// ─── Handlers événements reçus du serveur ───────────────────────────────────
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
        videoUrl: filePath ? `file:///${filePath.replace(/\\/g, '/')}` : null,
        audioUrl: null,
        title:    meta?.title    || null,
        thumbnail: meta?.thumbnail || null,
        duration:  meta?.duration  || null,
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

// ─── Connexion WebSocket ─────────────────────────────────────────────────────
function connect() {
  if (destroyed) return

  const url = buildWsUrl()
  if (!url) {
    console.error('[Bot] WS_URL manquant dans token.env')
    const { getOverlayWindow, getSettingsWindow } = require('./windows')
    getOverlayWindow()?.webContents.send('status', { ok: false, error: 'WS_URL manquant' })
    getSettingsWindow()?.webContents.send('status', { ok: false, error: 'WS_URL manquant' })
    return
  }

  console.log('[Bot] Connexion WebSocket à', WS_URL)

  ws = new WebSocket(url)

  ws.on('open', () => {
    console.log('[Bot] WebSocket connecté')
    clearTimeout(reconnectTimer)
  })

  ws.on('message', (raw) => {
    try {
      const { event, data } = JSON.parse(raw)
      onServerEvent(event, data).catch(err => {
        console.error('[Bot] Erreur événement', event, ':', err.message)
      })
    } catch (err) {
      console.error('[Bot] Message invalide reçu:', err.message)
    }
  })

  ws.on('close', (code, reason) => {
    console.warn(`[Bot] WebSocket fermé (${code}) — reconnexion dans 5s...`)
    if (!destroyed) {
      reconnectTimer = setTimeout(connect, 5000)
    }
  })

  ws.on('error', (err) => {
    console.error('[Bot] Erreur WebSocket:', err.message)
    // Le close event va déclencher la reconnexion
  })
}

// ─── API publique ────────────────────────────────────────────────────────────
function startBot(channelId, overlayWindow) {
  overlayWinRef = overlayWindow
  destroyed = false
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

module.exports = { startBot, destroyBot }