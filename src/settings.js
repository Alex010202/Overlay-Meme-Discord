const { app } = require('electron')
const path = require('path')
const fs = require('fs')

const CONFIG_DIR = path.join(app.getPath('userData'), 'config')
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true })

const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json')
const PROFILES_PATH = path.join(CONFIG_DIR, 'profiles.json')

const DEFAULTS = {
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
  ytUaCustom: '',
  // ── Screen share ──────────────────────────────────────────────
  shareResolution: '540p',  // '360p' | '540p' | '720p' | '1080p'
  shareFps: 10,             // 5 | 10 | 15 | 30
  shareQuality: 70          // 40-95, qualité JPEG (%)
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    }
  } catch (err) {
    console.error('Erreur lecture settings:', err.message)
  }
  return { ...DEFAULTS }
}

function saveSettings(patch) {
  const current = loadSettings()
  const next = { ...current, ...patch }
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2))
  } catch (err) {
    console.error('Erreur écriture settings:', err.message)
  }
  return next
}

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) {
      return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'))
    }
  } catch (err) {
    console.error('Erreur lecture profils:', err.message)
  }
  return {}
}

function saveProfiles(profiles) {
  try {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2))
  } catch (err) {
    console.error('Erreur écriture profils:', err.message)
  }
}

module.exports = {
  PROFILES_PATH,
  loadSettings,
  saveSettings,
  loadProfiles,
  saveProfiles
}