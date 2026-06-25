const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen, shell } = require('electron')
const { Client, GatewayIntentBits } = require('discord.js')
const { autoUpdater } = require('electron-updater')
const { execFile, exec } = require('child_process')
const path = require('path')
const fs = require('fs')
const https = require('https')
require('dotenv').config({ path: path.join(__dirname, 'token.env') })
Menu.setApplicationMenu(null)


function checkForUpdatesManually() {
  console.log('🔍 Vérification des mises à jour...')
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    sendUpdateStatus('checking')
  }
  autoUpdater.checkForUpdates()
    .catch((err) => {
      console.error('Erreur vérification:', err)
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        sendUpdateStatus('error', { message: err?.message || 'Erreur de vérification' })
      }
    })
}


autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

function sendUpdateStatus(status, extra = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update-status', { status, ...extra })
  }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'))
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }))
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err?.message || 'Erreur inconnue' }))
autoUpdater.on('update-downloaded', () => {
  sendUpdateStatus('downloaded')
  autoUpdater.quitAndInstall(true, true)
})

const CONFIG_DIR = path.join(app.getPath('userData'), 'config')
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json')
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
  } catch {}
  return {
    channelId: process.env.CHANNEL_ID || '',
    opacity: 0.9,
    fontSize: 14,
    soundEnabled: false,
    volume: 0.8,
    soundHotkey: '',
    skipHotkey: '',
    overlayBg: 'rgba(15,15,25,0.82)',
    overlayBounds: { width: 360, height: 260, x: 20, y: 20 },
    durationText: 8000,
    durationGif: 8000,
    durationVideo: 10000,
    durationAudio: 15000,
    videoUntilEnd: false,
    audioUntilEnd: false,
    dragbarHidden: false,
    autoResizeMedia: false,
    ytResolution: '1080',
    ytFormat: 'mp4',
    ytTimeout: 30000,
    ytExtraArgs: '',
    ytSubtitles: false,
    ytReencode: false,
    ytQuality: 'hd1080',
    ytNoFullscreen: true,
    ytUaPreset: 'chrome-win',
    ytUaCustom: ''
  }
}

function saveSettings(patch) {
  const current = loadSettings()
  const next = { ...current, ...patch }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2))
  return next
}

let settings = loadSettings()

let overlayWindow
let ytView = null
let settingsWindow
let tray
let discordClient
let currentChannelId = settings.channelId
let overlayNormalBounds = null

// ─── yt-dlp ───────────────────────────────────────────────────────────────────

function findYtDlp() {
  const possiblePaths = [
    path.join(process.resourcesPath, 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, '..', 'yt-dlp.exe'),
    path.join(process.execPath, '..', '..', 'yt-dlp.exe'), 
    'yt-dlp'
  ]

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p
  }

  console.warn('yt-dlp.exe introuvable, fallback sur la commande globale')
  return 'yt-dlp'
}

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com'
  } catch { return false }
}

function buildYtDlpArgs(url) {
  const s = settings
  const res = s.ytResolution || '1080'
  const fmt = s.ytFormat || 'mp4'

  if (isTikTokUrl(url)) {
    const args = [
      '-f', `bestvideo[height<=${res}]+bestaudio/bestvideo[height<=${res}]/best[height<=${res}]/best`,
      '--get-url',
      '--no-playlist',
      '--impersonate', 'chrome',
    ]
    if (s.ytExtraArgs) {
      args.push(...s.ytExtraArgs.trim().split(/\s+/).filter(Boolean))
    }
    args.push(url)
    return args
  }

  let formatStr
  if (res === 'best') {
    if (fmt === 'any') {
      formatStr = 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
    } else {
      formatStr = `bestvideo[vcodec^=avc1][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[ext=${fmt}]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`
    }
  } else {
    if (fmt === 'any') {
      formatStr = `bestvideo[height<=${res}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`
    } else {
      formatStr = `bestvideo[height<=${res}][vcodec^=avc1][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[height<=${res}][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`
    }
  }

  const args = ['-f', formatStr, '--get-url', '--no-playlist']

  if (s.ytExtraArgs) {
    const extra = s.ytExtraArgs.trim().split(/\s+/).filter(Boolean)
    args.push(...extra)
  }

  args.push(url)
  return args
}

const os = require('os')
const TIKTOK_TMP_DIR = path.join(os.tmpdir(), 'discord-overlay-tiktok')
if (!fs.existsSync(TIKTOK_TMP_DIR)) fs.mkdirSync(TIKTOK_TMP_DIR, { recursive: true })

function cleanTiktokTmp() {
  try {
    const files = fs.readdirSync(TIKTOK_TMP_DIR)
    const now = Date.now()
    for (const f of files) {
      const fp = path.join(TIKTOK_TMP_DIR, f)
      try {
        const stat = fs.statSync(fp)
        if (now - stat.mtimeMs > 10 * 60 * 1000) fs.unlinkSync(fp)
      } catch {}
    }
  } catch {}
}
cleanTiktokTmp()

function fetchYtDlpTikTokFile(url) {
  return new Promise((resolve) => {
    const bin = findYtDlp()
    const timeout = (settings.ytTimeout || 30000) + 30000
    const outPath = path.join(TIKTOK_TMP_DIR, `tt_${Date.now()}.mp4`)
    const args = [
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--impersonate', 'chrome',
      '--no-playlist',
      '-o', outPath,
      url
    ]
    execFile(bin, args, { timeout }, (err) => {
      if (err || !fs.existsSync(outPath)) { resolve(null); return }
      resolve(outPath)
    })
  })
}

function fetchYtDlpStream(url) {
  return new Promise((resolve) => {
    const bin = findYtDlp()
    const args = buildYtDlpArgs(url)
    const timeout = settings.ytTimeout || 30000
    console.log('yt-dlp bin:', bin)
    console.log('yt-dlp url:', url)
    console.log('yt-dlp args:', args)
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      console.log('yt-dlp err:', err?.message)
      console.log('yt-dlp stdout:', stdout)
      console.log('yt-dlp stderr:', stderr)
      if (err || !stdout.trim()) { resolve(null); return }
      const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      resolve({ video: lines[0], audio: lines[1] || null })
    })
  })
}

function fetchYtDlpMeta(url) {
  return new Promise((resolve) => {
    const bin = findYtDlp()
    const timeout = settings.ytTimeout || 30000
    const args = ['--dump-json', '--no-playlist']
    if (isTikTokUrl(url)) {
      args.push('--impersonate', 'chrome')
    }
    args.push(url)
    execFile(bin, args, { timeout }, (err, stdout) => {
      if (err || !stdout.trim()) { resolve(null); return }
      try { resolve(JSON.parse(stdout.trim())) }
      catch { resolve(null) }
    })
  })
}

const YTDLP_DOMAINS = [
  'youtube.com', 'youtu.be',
  'twitch.tv', 'clips.twitch.tv',
  'reddit.com', 'v.redd.it',
  'twitter.com', 'x.com',
  'tiktok.com',
  'instagram.com',
  'vimeo.com',
  'dailymotion.com',
  'streamable.com',
  'medal.tv',
  'kick.com'
]

function isYtDlpUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return YTDLP_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  } catch { return false }
}

function extractYouTubeId(url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace('www.', '')
    if (host === 'youtu.be') return parsed.pathname.slice(1).split('?')[0]
    if (host === 'youtube.com') {
      const embedMatch = parsed.pathname.match(/^\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]+)/)
      if (embedMatch) return embedMatch[1]
      return parsed.searchParams.get('v') || null
    }
  } catch {}
  return null
}

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'youtube.com' || host === 'youtu.be'
  } catch { return false }
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
  if (settings.ytUaPreset === 'custom' && settings.ytUaCustom) return settings.ytUaCustom
  return YT_UA_PRESETS[settings.ytUaPreset] || YT_UA_PRESETS['chrome-win']
}

function createOverlayWindow() {
  const bounds = settings.overlayBounds || { width: 360, height: 260, x: 20, y: 20 }
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
      headers['Referer'] = 'https://www.tiktok.com/'
      headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      headers['Origin'] = 'https://www.tiktok.com'
      callback({ requestHeaders: headers })
    }
  )
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
    settingsWindow.webContents.send('load-settings', settings)
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

  if (settings.soundHotkey) {
    try {
      globalShortcut.register(settings.soundHotkey, () => {
        settings.soundEnabled = !settings.soundEnabled
        saveSettings({ soundEnabled: settings.soundEnabled })
        const vol = settings.soundEnabled ? settings.volume : 0
        if (overlayWindow) overlayWindow.webContents.send('set-volume', settings.soundEnabled, vol)
        if (settingsWindow) settingsWindow.webContents.send('sound-toggled', settings.soundEnabled)
        if (ytView && !ytView.webContents.isDestroyed()) {
          ytView.webContents.setAudioMuted(!settings.soundEnabled)
          ytView.webContents.executeJavaScript(`
            (function() {
              const player = document.getElementById('movie_player');
              const video = document.querySelector('video.html5-main-video');
              if (player && player.setVolume) player.setVolume(${settings.soundEnabled ? Math.round(settings.volume * 100) : 0});
              if (player) { ${settings.soundEnabled} ? player.unMute?.() : player.mute?.() }
              if (video) { video.volume = ${settings.soundEnabled ? settings.volume : 0}; video.muted = ${!settings.soundEnabled}; }
            })()
          `).catch(() => {})
        }
      })
    } catch (e) { console.error('Raccourci son invalide:', e) }
  }

  if (settings.skipHotkey) {
    try {
      globalShortcut.register(settings.skipHotkey, () => {
        if (overlayWindow) overlayWindow.webContents.send('skip-media')
      })
    } catch (e) { console.error('Raccourci skip invalide:', e) }
  }
}


function fetchTenorMp4(tenorPageUrl) {
  return new Promise((resolve) => {
    https.get(tenorPageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let html = ''
      res.on('data', chunk => html += chunk)
      res.on('end', () => {
        const match = html.match(/https:\/\/media\.tenor\.com\/[^"]+AAAPo[^"]+\.mp4/)
        resolve(match ? match[0] : null)
      })
    }).on('error', () => resolve(null))
  })
}


function startBot(channelId) {
  if (discordClient) discordClient.destroy()
  currentChannelId = channelId

  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  })

  discordClient.on('clientReady', () => {
    console.log('Bot connecté:', discordClient.user.tag)
    if (overlayWindow) overlayWindow.webContents.send('status', { ok: true, tag: discordClient.user.tag })
    if (settingsWindow) settingsWindow.webContents.send('status', { ok: true, tag: discordClient.user.tag })
  })

  discordClient.on('messageCreate', async (message) => {
    if (message.channel.id !== currentChannelId || message.author.bot) return

    let content = message.content || ''
    let gifUrl = null
    let stickerUrl = null
    let attachmentUrl = null
    let gifIsVideo = false
    let gifIsLooping = false
    let audioUrl = null

    const stickerMatch = content.match(/^\[.+?\]\((https:\/\/media\.discordapp\.net\/stickers\/[^\)]+)\)$/)
    if (stickerMatch) { stickerUrl = stickerMatch[1]; content = '' }

    if (message.attachments.size > 0) {
      for (const att of message.attachments.values()) {
        const ct = att.contentType || ''
        const isImage  = ct.startsWith('image/')
        const isVideo  = ct.startsWith('video/')
        const isAudio  = ct.startsWith('audio/')
        const isGifUrl = /\.gif(\?|$)/i.test(att.url)
        const isVidUrl = /\.(mp4|webm|mov)(\?|$)/i.test(att.url)
        const isAudUrl = /\.(mp3|ogg|wav|flac|m4a|opus)(\?|$)/i.test(att.url)

        if (isImage || isGifUrl) {
          attachmentUrl = att.url
          gifIsVideo = false
          gifIsLooping = isGifUrl
          break
        }
        if (isVideo || isVidUrl) {
          attachmentUrl = att.url
          gifIsVideo = true
          break
        }
        if ((isAudio || isAudUrl) && !audioUrl) {
          audioUrl = att.url
        }
      }
    }

    if (!audioUrl && message.flags?.bitfield && (message.flags.bitfield & 8192)) {
      for (const voiceAtt of message.attachments.values()) {
        if (voiceAtt.url) { audioUrl = voiceAtt.url; break }
      }
    }

    if (message.embeds.length > 0) {
      for (const embed of message.embeds) {
        if (embed.video?.url) {
          const embedSourceUrl = embed.url || embed.video.url

          if (isYouTubeUrl(embedSourceUrl)) break

          const tiktokEmbedMatch = (embed.video.url || '').match(/tiktok\.com\/player\/v1\/(\d+)/)
          if (tiktokEmbedMatch) {
            const tiktokUrl = embed.url || `https://www.tiktok.com/video/${tiktokEmbedMatch[1]}`
            content = content.replace(tiktokUrl, '').replace(embed.video.url, '').trim()

            const author = message.author.username
            const avatar = message.author.displayAvatarURL({ size: 32 })
            const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

            if (overlayWindow) overlayWindow.webContents.send('message', {
              author, avatar, time,
              content: content || '',
              loading: true,
              loadingUrl: tiktokUrl
            })

            const [filePath, meta] = await Promise.all([
              fetchYtDlpTikTokFile(tiktokUrl),
              fetchYtDlpMeta(tiktokUrl)
            ])

            if (overlayWindow) overlayWindow.webContents.send('ytdlp-resolved', {
              loadingUrl: tiktokUrl,
              videoUrl: filePath ? `file:///${filePath.replace(/\\/g, '/')}` : null,
              audioUrl: null,
              title: meta?.title || null,
              thumbnail: meta?.thumbnail || null,
              duration: meta?.duration || null,
              uploader: meta?.uploader || meta?.channel || null,
              sourceUrl: tiktokUrl
            })
            return
          }

          gifUrl = embed.video.url
          gifIsVideo = true
          gifIsLooping = embed.type === 'gifv' || /tenor\.com|giphy\.com/i.test(embed.url || '')
          break
        }
        if (embed.image?.url) { gifUrl = embed.image.url; break }
        if (embed.thumbnail?.url) { gifUrl = embed.thumbnail.url; break }
      }
    }

    if (gifUrl && message.embeds.length > 0) {
      const embedUrl = message.embeds[0]?.url
      if (embedUrl && content.includes(embedUrl)) {
        content = content.replace(embedUrl, '').trim()
      }
    }

    if (!gifUrl && !attachmentUrl && !stickerUrl) {
      const tenorMatch = content.match(/https?:\/\/tenor\.com\/view\/[^\s]+/)
      if (tenorMatch) {
        const tenorUrl = tenorMatch[0]
        content = content.replace(tenorUrl, '').trim()
        fetchTenorMp4(tenorUrl).then(mp4Url => {
          if (mp4Url && overlayWindow) {
            overlayWindow.webContents.send('message', {
              author: message.author.username,
              content: content.trim(),
              gifUrl: mp4Url,
              gifIsVideo: true,
              gifIsLooping: true,
              avatar: message.author.displayAvatarURL({ size: 32 }),
              time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
            })
          }
        })
        return
      }

      const urlMatch0 = content.match(/https?:\/\/[^\s]+/)
      if (urlMatch0 && isYouTubeUrl(urlMatch0[0])) {
        const ytId = extractYouTubeId(urlMatch0[0])
        if (ytId && overlayWindow) {
          content = content.replace(urlMatch0[0], '').trim()
          overlayWindow.webContents.send('message', {
            author: message.author.username,
            avatar: message.author.displayAvatarURL({ size: 32 }),
            time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
            content: content.trim(),
            youtubeView: ytId,
          })
          return
        }
      }

      const ytMatch = content.match(/https?:\/\/[^\s]+/)
      if (ytMatch && isYtDlpUrl(ytMatch[0]) && !isYouTubeUrl(ytMatch[0])) {
        const ytUrl = ytMatch[0]
        content = content.replace(ytUrl, '').trim()

        const author = message.author.username
        const avatar = message.author.displayAvatarURL({ size: 32 })
        const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

        if (overlayWindow) overlayWindow.webContents.send('message', {
          author, avatar, time,
          content: content || '',
          loading: true,
          loadingUrl: ytUrl
        })

        if (isTikTokUrl(ytUrl)) {
          const [filePath, meta] = await Promise.all([
            fetchYtDlpTikTokFile(ytUrl),
            fetchYtDlpMeta(ytUrl)
          ])
          if (overlayWindow) overlayWindow.webContents.send('ytdlp-resolved', {
            loadingUrl: ytUrl,
            videoUrl: filePath ? `file:///${filePath.replace(/\\/g, '/')}` : null,
            audioUrl: null,
            title: meta?.title || null,
            thumbnail: meta?.thumbnail || null,
            duration: meta?.duration || null,
            uploader: meta?.uploader || meta?.channel || null,
            sourceUrl: ytUrl
          })
          return
        }

        const [streams, meta] = await Promise.all([
          fetchYtDlpStream(ytUrl),
          fetchYtDlpMeta(ytUrl)
        ])

        if (overlayWindow) overlayWindow.webContents.send('ytdlp-resolved', {
          loadingUrl: ytUrl,
          videoUrl: streams?.video || null,
          audioUrl: streams?.audio || null,
          title: meta?.title || null,
          thumbnail: meta?.thumbnail || null,
          duration: meta?.duration || null,
          uploader: meta?.uploader || meta?.channel || null,
          sourceUrl: ytUrl
        })
        return
      }

      const urlMatch = content.match(/https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|avif|mp4|webm|mov)(\?[^\s]*)?/i)
      if (urlMatch) {
        attachmentUrl = urlMatch[0]
        gifIsVideo = /\.(mp4|webm|mov)/i.test(urlMatch[1])
        content = content.replace(urlMatch[0], '').trim()
      }
    }

    console.log('=== MESSAGE REÇU ===')
    console.log('content:', content)
    console.log('gifUrl:', gifUrl, '| attachmentUrl:', attachmentUrl, '| audioUrl:', audioUrl)
    console.log('gifIsVideo:', gifIsVideo, '| gifIsLooping:', gifIsLooping)
    console.log('====================')

    if (overlayWindow) overlayWindow.webContents.send('message', {
      author: message.author.username,
      content: content.trim(),
      gifUrl: gifUrl || stickerUrl || attachmentUrl,
      gifIsVideo,
      gifIsLooping,
      audioUrl: audioUrl || null,
      isVoiceMessage: !!(message.flags?.bitfield && (message.flags.bitfield & 8192)),
      avatar: message.author.displayAvatarURL({ size: 32 }),
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    })
  })

  discordClient.login(process.env.DISCORD_TOKEN).catch(() => {
    if (overlayWindow) overlayWindow.webContents.send('status', { ok: false })
    if (settingsWindow) settingsWindow.webContents.send('status', { ok: false })
  })
}


ipcMain.on('check-for-updates', () => {
  checkForUpdatesManually()
})

ipcMain.on('set-channel', (e, channelId) => {
  settings = saveSettings({ channelId })
  currentChannelId = channelId
  startBot(channelId)
})

ipcMain.on('get-channel', (e) => e.reply('current-channel', currentChannelId))

ipcMain.on('set-opacity', (e, val) => {
  settings = saveSettings({ opacity: val })
  if (overlayWindow) overlayWindow.webContents.send('set-window-opacity', val)
})

ipcMain.on('set-fontsize', (e, size) => {
  settings = saveSettings({ fontSize: size })
  if (overlayWindow) overlayWindow.webContents.send('set-fontsize', size)
})

ipcMain.on('set-volume', (e, enabled, vol) => {
  settings = saveSettings({ soundEnabled: enabled, volume: vol })
  if (overlayWindow) overlayWindow.webContents.send('set-volume', enabled, vol)
  if (ytView && !ytView.webContents.isDestroyed()) {
    ytView.webContents.setAudioMuted(!enabled)
    ytView.webContents.executeJavaScript(`
      (function() {
        const video = document.querySelector('video.html5-main-video');
        if (video) { video.volume = ${enabled ? vol : 0}; video.muted = ${!enabled}; }
        const player = document.getElementById('movie_player');
        if (player && player.setVolume) player.setVolume(${enabled ? Math.round(vol * 100) : 0});
        if (player) { ${enabled} ? player.unMute?.() : player.mute?.() }
      })()
    `).catch(() => {})
  }
})

ipcMain.on('set-hotkey', (e, accelerator) => {
  settings = saveSettings({ soundHotkey: accelerator })
  registerHotkeys()
})

ipcMain.on('set-skip-hotkey', (e, accelerator) => {
  settings = saveSettings({ skipHotkey: accelerator })
  registerHotkeys()
})

ipcMain.on('set-overlay-bg', (e, color) => {
  settings = saveSettings({ overlayBg: color })
  if (overlayWindow) overlayWindow.webContents.send('set-overlay-bg', color)
})

ipcMain.on('get-settings', (e) => e.reply('load-settings', settings))

ipcMain.on('set-durations', (e, durations) => {
  settings = saveSettings(durations)
  if (overlayWindow) overlayWindow.webContents.send('set-durations', durations)
})

ipcMain.on('set-dragbar-hidden', (e, hidden) => {
  settings = saveSettings({ dragbarHidden: hidden })
  if (overlayWindow) overlayWindow.webContents.send('set-dragbar-hidden', hidden)
})

ipcMain.on('set-auto-resize-media', (e, enabled) => {
  settings = saveSettings({ autoResizeMedia: enabled })
  if (overlayWindow) overlayWindow.webContents.send('set-auto-resize-media', enabled)
})

ipcMain.on('resize-for-media', (e, { naturalWidth, naturalHeight }) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (!settings.autoResizeMedia) return

  const bounds = overlayWindow.getBounds()
  const display = require('electron').screen.getDisplayMatching(bounds)
  const workArea = display.workArea

  const maxW = Math.floor(workArea.width  * 0.8)
  const maxH = Math.floor(workArea.height * 0.8)
  const minW = 200, minH = 150

  const ratio = naturalWidth / naturalHeight
  let newW = Math.max(minW, Math.min(maxW, naturalWidth))
  let newH = Math.round(newW / ratio) + 32

  if (newH > maxH) {
    newH = maxH
    newW = Math.round((newH - 32) * ratio)
  }
  newW = Math.max(minW, newW)
  newH = Math.max(minH, newH)

  overlayNormalBounds = bounds

  overlayWindow.setBounds({ x: bounds.x, y: bounds.y, width: newW, height: newH }, true)
})

ipcMain.on('reset-overlay-size', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  if (!settings.autoResizeMedia) return
  if (overlayNormalBounds) {
    overlayWindow.setBounds(overlayNormalBounds, true)
  }
})

ipcMain.on('open-profiles-folder', () => {
  shell.showItemInFolder(PROFILES_PATH)
})

ipcMain.on('win-minimize', () => { if (settingsWindow) settingsWindow.minimize() })
ipcMain.on('win-close', () => { if (settingsWindow) settingsWindow.close() })

ipcMain.on('get-profiles', (e) => e.reply('load-profiles', loadProfiles()))

ipcMain.on('save-profile', (e, { name, overwrite }) => {
  if (!name) return
  const profiles = loadProfiles()
  if (profiles[name] && !overwrite) {
    if (settingsWindow) settingsWindow.webContents.send('profile-exists', name)
    return
  }
  const bounds = (overlayWindow && !overlayWindow.isDestroyed())
    ? overlayWindow.getBounds()
    : settings.overlayBounds
  const { channelId, ...rest } = settings
  profiles[name] = { ...rest, overlayBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
  saveProfiles(profiles)
  if (settingsWindow) settingsWindow.webContents.send('load-profiles', profiles)
})

ipcMain.on('delete-profile', (e, { name }) => {
  const profiles = loadProfiles()
  delete profiles[name]
  saveProfiles(profiles)
  if (settingsWindow) settingsWindow.webContents.send('load-profiles', profiles)
})

ipcMain.on('get-overlay-size', (e) => {
  if (!overlayWindow) return
  const b = overlayWindow.getBounds()
  e.reply('overlay-size', { width: b.width, height: b.height })
})

ipcMain.on('set-click-through', (e, ignore) => {
  if (!overlayWindow) return
  if (!ignore) { overlayWindow.setIgnoreMouseEvents(false); return }
  const cursor = screen.getCursorScreenPoint()
  const bounds = overlayWindow.getBounds()
  const relY = cursor.y - bounds.y
  if (relY <= 24) {
    overlayWindow.setIgnoreMouseEvents(false)
  } else {
    overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  }
})

ipcMain.on('load-profile', (e, { name }) => {
  const profiles = loadProfiles()
  const p = profiles[name]
  if (!p) return
  settings = saveSettings(p)
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setBounds(p.overlayBounds)
    overlayWindow.webContents.send('set-window-opacity', settings.opacity)
    overlayWindow.webContents.send('set-fontsize', settings.fontSize)
    overlayWindow.webContents.send('set-overlay-bg', settings.overlayBg)
    overlayWindow.webContents.send('set-volume', !!settings.soundEnabled, settings.soundEnabled ? settings.volume : 0)
    overlayWindow.webContents.send('set-durations', {
      durationText: settings.durationText,
      durationGif: settings.durationGif,
      durationVideo: settings.durationVideo,
      videoUntilEnd: settings.videoUntilEnd
    })
    overlayWindow.webContents.send('set-dragbar-hidden', !!settings.dragbarHidden)
    overlayWindow.webContents.send('set-auto-resize-media', !!settings.autoResizeMedia)
  }
  if (settingsWindow) settingsWindow.webContents.send('load-settings', settings)
  registerHotkeys()
})


ipcMain.on('yt-view-create', (e, { videoId, x, y, width, height }) => {
  if (!overlayWindow) return

  if (ytView) {
    try { overlayWindow.removeBrowserView(ytView) } catch {}
    try { ytView.webContents.destroy() } catch {}
    ytView = null
  }

  ytView = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    }
  })

  const ua = getYtUserAgent()
  ytView.webContents.setUserAgent(ua)

  overlayWindow.addBrowserView(ytView)
  ytView.setBounds({ x, y, width, height })
  ytView.setAutoResize({ width: false, height: false })

  ytView.webContents.setAudioMuted(!settings.soundEnabled)

  ytView.webContents.loadURL(`https://www.youtube.com/watch?v=${videoId}&autoplay=1`)

  const noFs = settings.ytNoFullscreen !== false

  ytView.webContents.on('did-navigate', () => {})

  ytView.webContents.on('enter-html-full-screen', () => {
    ytView.webContents.executeJavaScript(`
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    `).catch(() => {})
  })

  const inject = () => {
    const url = ytView.webContents.getURL()
    if (!url.includes('youtube.com/watch')) return

    ytView.webContents.executeJavaScript(`
      (function() {
        if (window.__overlayInjected) return
        window.__overlayInjected = true

        ${noFs ? `
        Element.prototype.requestFullscreen = function() { return Promise.resolve() }
        document.addEventListener('fullscreenchange', () => {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        })
        ` : ''}

        const style = document.createElement('style')
        style.id = '__overlay-style'
        style.textContent =
          'ytd-masthead, #masthead-container { display:none!important }' +
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

          if (player.setVolume) player.setVolume(${Math.round((settings.soundEnabled ? settings.volume : 0) * 100)})
          if (player.unMute && ${settings.soundEnabled}) player.unMute()
          if (player.mute   && ${!settings.soundEnabled}) player.mute()

          video.volume = ${settings.soundEnabled ? settings.volume : 0}
          video.muted  = ${!settings.soundEnabled}

          if (player.setPlaybackQuality) player.setPlaybackQuality('${settings.ytQuality || 'hd720'}')

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
    `).catch(() => {})
  }

  ytView.webContents.on('did-finish-load', inject)
  ytView.webContents.on('dom-ready', inject)
})

ipcMain.on('yt-view-resize', (e, bounds) => {
  if (ytView) ytView.setBounds(bounds)
})

ipcMain.on('yt-view-destroy', () => {
  if (!ytView || !overlayWindow) return
  try { overlayWindow.removeBrowserView(ytView) } catch {}
  try { ytView.webContents.destroy() } catch {}
  ytView = null
})

ipcMain.on('set-yt-settings', (e, patch) => {
  settings = saveSettings(patch)
})

ipcMain.on('set-yt-useragent', (e, patch) => {
  settings = saveSettings(patch)
  if (ytView && !ytView.webContents.isDestroyed()) {
    const ua = getYtUserAgent()
    ytView.webContents.setUserAgent(ua)
    ytView.webContents.reload()
  }
})

ipcMain.on('set-yt-player-settings', (e, patch) => {
  settings = saveSettings(patch)
  if (patch.ytQuality && ytView && !ytView.webContents.isDestroyed()) {
    ytView.webContents.executeJavaScript(`
      (function() {
        const player = document.getElementById('movie_player')
        if (player && player.setPlaybackQualityRange) {
          player.setPlaybackQualityRange('${patch.ytQuality}', '${patch.ytQuality}')
        } else if (player && player.setPlaybackQuality) {
          player.setPlaybackQuality('${patch.ytQuality}')
        }
      })()
    `).catch(() => {})
  }
})

ipcMain.on('set-yt-live-volume', (e, pct) => {
  if (!ytView || ytView.webContents.isDestroyed()) return
  const vol = Math.max(0, Math.min(100, pct))
  ytView.webContents.executeJavaScript(`
    (function() {
      const player = document.getElementById('movie_player')
      const video  = document.querySelector('video.html5-main-video')
      if (player && player.setVolume) player.setVolume(${vol})
      if (player && ${vol} > 0) { if (player.unMute) player.unMute() }
      if (player && ${vol} === 0) { if (player.mute) player.mute() }
      if (video) { video.volume = ${vol / 100}; video.muted = ${vol === 0} }
    })()
  `).catch(() => {})
})

ipcMain.on('set-yt-live-quality', (e, quality) => {
  settings = saveSettings({ ytQuality: quality })
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
  `).catch(() => {})
})

const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json')

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'))
  } catch {}
  return {}
}

function saveProfiles(profiles) {
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2))
}


app.whenReady().then(() => {
  createOverlayWindow()
  createTray()
  createSettingsWindow()
  startBot(currentChannelId)
  registerHotkeys()
  
  // Vérification au lancement (après 2 secondes)
  setTimeout(() => {
    checkForUpdatesManually()
  }, 2000)

  setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const bounds = overlayWindow.getBounds()
    const onWindow = cursor.x >= bounds.x && cursor.x <= bounds.x + bounds.width &&
                     cursor.y >= bounds.y && cursor.y <= bounds.y + bounds.height
    const onDragbar = onWindow && cursor.y <= bounds.y + 24
    overlayWindow.webContents.send('dragbar-hover', onDragbar)
  }, 50)
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const b = overlayNormalBounds || overlayWindow.getBounds()
    saveSettings({ overlayBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
  }
  globalShortcut.unregisterAll()
  if (discordClient) discordClient.destroy()
})
