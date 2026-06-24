const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, globalShortcut, screen, shell } = require('electron')
const { Client, GatewayIntentBits } = require('discord.js')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const https = require('https')
require('dotenv').config({ path: path.join(__dirname, 'token.env') })
Menu.setApplicationMenu(null)

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

function sendUpdateStatus(status, extra = {}) {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('update-status', { status, ...extra })
  }
}

autoUpdater.on('checking-for-update', () => {
  sendUpdateStatus('checking')
})

autoUpdater.on('update-available', (info) => {
  sendUpdateStatus('available', { version: info.version })
})

autoUpdater.on('update-not-available', () => {
  sendUpdateStatus('up-to-date')
})

autoUpdater.on('download-progress', (progress) => {
  sendUpdateStatus('downloading', { percent: Math.round(progress.percent) })
})

autoUpdater.on('error', (err) => {
  sendUpdateStatus('error', { message: err?.message || 'Erreur inconnue' })
})

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
    overlayBg: 'rgba(15,15,25,0.82)',
    overlayBounds: { width: 360, height: 260, x: 20, y: 20 },
    durationText: 8000,
    durationGif: 8000,
    durationVideo: 10000,
    videoUntilEnd: false,
    dragbarHidden: false
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
let settingsWindow
let tray
let discordClient
let currentChannelId = settings.channelId
let overlayNormalBounds = null

function createOverlayWindow() {
  const bounds = settings.overlayBounds || { width: 360, height: 260, x: 20, y: 20 }
  overlayWindow = new BrowserWindow({
    width:  bounds.width,
    height: bounds.height,
    x:      bounds.x,
    y:      bounds.y,
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

function registerSoundHotkey(accelerator) {
  globalShortcut.unregisterAll()
  if (!accelerator) return
  try {
    globalShortcut.register(accelerator, () => {
      settings.soundEnabled = !settings.soundEnabled
      saveSettings({ soundEnabled: settings.soundEnabled })
      const vol = settings.soundEnabled ? settings.volume : 0
      if (overlayWindow) overlayWindow.webContents.send('set-volume', settings.soundEnabled, vol)
      if (settingsWindow) settingsWindow.webContents.send('sound-toggled', settings.soundEnabled)
    })
  } catch (e) {
    console.error('Raccourci invalide:', e)
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

  discordClient.on('messageCreate', (message) => {
    if (message.channel.id !== currentChannelId || message.author.bot) return

    let content = message.content || ''
    let gifUrl = null
    let stickerUrl = null
    let attachmentUrl = null
    let gifIsVideo = false
    let gifIsLooping = false

    const stickerMatch = content.match(/^\[.+?\]\((https:\/\/media\.discordapp\.net\/stickers\/[^\)]+)\)$/)
    if (stickerMatch) { stickerUrl = stickerMatch[1]; content = '' }

    if (message.attachments.size > 0) {
      for (const att of message.attachments.values()) {
        if (att.contentType?.startsWith('image/') || att.contentType?.startsWith('video/')) {
          attachmentUrl = att.url
          gifIsVideo = att.contentType.startsWith('video/')
          break
        }
      }
    }

    if (message.embeds.length > 0) {
      for (const embed of message.embeds) {
        if (embed.video?.url) { gifUrl = embed.video.url; gifIsVideo = true; break }
        if (embed.image?.url) { gifUrl = embed.image.url; break }
        if (embed.thumbnail?.url && embed.type === 'image') { gifUrl = embed.thumbnail.url; break }
        if (embed.thumbnail?.url && embed.type !== 'gifv') { gifUrl = embed.thumbnail.url; break }
      }
    }

    if (!gifUrl && !attachmentUrl && !stickerUrl) {
      const urlMatch = content.match(/https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|avif|mp4|webm|mov)(\?[^\s]*)?/i)
      if (urlMatch) {
        attachmentUrl = urlMatch[0]
        gifIsVideo = /\.(mp4|webm|mov)/i.test(urlMatch[1])
        content = content.replace(urlMatch[0], '').trim()
      }

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
    }

    /*console.log('=== MESSAGE REÇU ===')
    console.log('content:', content)
    console.log('gifUrl:', gifUrl)
    console.log('stickerUrl:', stickerUrl)
    console.log('attachmentUrl:', attachmentUrl)
    console.log('gifIsVideo:', gifIsVideo)
    console.log('embeds:', JSON.stringify(message.embeds, null, 2))
    console.log('attachments:', JSON.stringify([...message.attachments.values()], null, 2))
    console.log('====================')*/

    if (overlayWindow) overlayWindow.webContents.send('message', {
      author: message.author.username,
      content: content.trim(),
      gifUrl: gifUrl || stickerUrl || attachmentUrl,
      gifIsVideo,
      gifIsLooping,
      avatar: message.author.displayAvatarURL({ size: 32 }),
      time: new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    })
  })

  discordClient.login(process.env.DISCORD_TOKEN).catch(() => {
    if (overlayWindow) overlayWindow.webContents.send('status', { ok: false })
    if (settingsWindow) settingsWindow.webContents.send('status', { ok: false })
  })
}

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
})

ipcMain.on('set-hotkey', (e, accelerator) => {
  settings = saveSettings({ soundHotkey: accelerator })
  registerSoundHotkey(accelerator)
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

ipcMain.on('open-profiles-folder', () => {
  shell.showItemInFolder(PROFILES_PATH)
})

ipcMain.on('win-minimize', () => {
  if (settingsWindow) settingsWindow.minimize()
})

ipcMain.on('win-close', () => {
  if (settingsWindow) settingsWindow.close()
})

ipcMain.on('get-profiles', (e) => {
  e.reply('load-profiles', loadProfiles())
})

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
  profiles[name] = {
    ...rest,
    overlayBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
  }
  saveProfiles(profiles)
  if (settingsWindow) settingsWindow.webContents.send('load-profiles', profiles)
})

ipcMain.on('delete-profile', (e, { name }) => {
  const profiles = loadProfiles()
  delete profiles[name]
  saveProfiles(profiles)
  if (settingsWindow) settingsWindow.webContents.send('load-profiles', profiles)
})

ipcMain.on('check-for-updates', () => {
  autoUpdater.checkForUpdates().catch((err) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('update-status', { status: 'error', message: err?.message || 'Erreur réseau' })
    }
  })
})

ipcMain.on('get-overlay-size', (e) => {
  if (!overlayWindow) return
  const b = overlayWindow.getBounds()
  e.reply('overlay-size', { width: b.width, height: b.height })
})

ipcMain.on('set-click-through', (e, ignore) => {
  if (!overlayWindow) return
  if (!ignore) {
    overlayWindow.setIgnoreMouseEvents(false)
    return
  }
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
  }
  if (settingsWindow) settingsWindow.webContents.send('load-settings', settings)
  registerSoundHotkey(settings.soundHotkey)
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
  registerSoundHotkey(settings.soundHotkey)

  autoUpdater.checkForUpdates().catch(() => {})

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