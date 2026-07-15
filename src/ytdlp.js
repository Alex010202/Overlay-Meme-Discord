const { execFile } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const crypto = require('crypto')

const TIKTOK_TMP_DIR = path.join(os.tmpdir(), 'discord-overlay-tiktok')
if (!fs.existsSync(TIKTOK_TMP_DIR)) fs.mkdirSync(TIKTOK_TMP_DIR, { recursive: true })

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

function cleanTiktokTmp() {
  try {
    const files = fs.readdirSync(TIKTOK_TMP_DIR)
    const now = Date.now()
    for (const f of files) {
      const fp = path.join(TIKTOK_TMP_DIR, f)
      try {
        const stat = fs.statSync(fp)
        if (now - stat.mtimeMs > 60 * 60 * 1000) fs.unlinkSync(fp)
      } catch (err) {
        console.warn('Impossible de supprimer le cache tiktok:', err.message)
      }
    }
  } catch (err) {
    console.warn('Erreur nettoyage cache tiktok:', err.message)
  }
}

function findYtDlp() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'yt-dlp.exe'),
    path.join(process.resourcesPath, 'yt-dlp.exe'),
    path.join(__dirname, '..', 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp.exe'),
    'yt-dlp'
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return 'yt-dlp'
}

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com'
  } catch {
    return false
  }
}

function isYtDlpUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return YTDLP_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  } catch {
    return false
  }
}

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'youtube.com' || host === 'youtu.be'
  } catch {
    return false
  }
}

function isTwitchUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'twitch.tv' || host.endsWith('.twitch.tv')
  } catch {
    return false
  }
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
  } catch {
    return null
  }
  return null
}

function tiktokCachePath(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 12)
  return path.join(TIKTOK_TMP_DIR, `tt_${hash}.mp4`)
}

function buildYtDlpArgs(url, settings) {
  const res = settings.ytResolution || '1080'
  const fmt = settings.ytFormat || 'mp4'

  if (isTikTokUrl(url)) {
    const args = [
      '-f', `bestvideo[height<=${res}]+bestaudio/bestvideo[height<=${res}]/best[height<=${res}]/best`,
      '--get-url',
      '--no-playlist',
      '--impersonate', 'chrome'
    ]
    if (settings.ytExtraArgs) {
      args.push(...settings.ytExtraArgs.trim().split(/\s+/).filter(Boolean))
    }
    args.push(url)
    return args
  }

  let formatStr
  if (res === 'best') {
    formatStr = fmt === 'any'
      ? 'bestvideo[vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'
      : `bestvideo[vcodec^=avc1][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[ext=${fmt}]+bestaudio[ext=m4a]/bestvideo+bestaudio/best`
  } else {
    formatStr = fmt === 'any'
      ? `bestvideo[height<=${res}][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`
      : `bestvideo[height<=${res}][vcodec^=avc1][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[height<=${res}][ext=${fmt}]+bestaudio[ext=m4a]/bestvideo[height<=${res}]+bestaudio/best[height<=${res}]`
  }

  const args = ['-f', formatStr, '--get-url', '--no-playlist']

  if (isTwitchUrl(url) && settings.twitchProxy) {
    args.push('--proxy', settings.twitchProxy)
  }

  if (settings.ytExtraArgs) {
    args.push(...settings.ytExtraArgs.trim().split(/\s+/).filter(Boolean))
  }
  args.push(url)
  return args
}

function fetchYtDlpStream(url, settings) {
  return new Promise((resolve) => {
    const bin = findYtDlp()
    const args = buildYtDlpArgs(url, settings)
    const timeout = settings.ytTimeout || 30000

    console.log('yt-dlp bin:', bin)
    console.log('yt-dlp url:', url)
    console.log('yt-dlp args:', args)

    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp erreur:', err.message)
        console.error('yt-dlp stderr:', stderr)
        resolve(null)
        return
      }
      if (!stdout.trim()) {
        console.error('yt-dlp stdout vide, stderr:', stderr)
        resolve(null)
        return
      }
      const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
      resolve({ video: lines[0], audio: lines[1] || null })
    })
  })
}

function fetchYtDlpTikTokFile(url, settings) {
  return new Promise((resolve) => {
    const cachedPath = tiktokCachePath(url)

    if (fs.existsSync(cachedPath)) {
      fs.utimesSync(cachedPath, new Date(), new Date())
      resolve(cachedPath)
      return
    }

    const bin = findYtDlp()
    const timeout = (settings.ytTimeout || 30000) + 30000
    const args = [
      '-f', 'bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--impersonate', 'chrome',
      '--no-playlist',
      '-o', cachedPath,
      url
    ]

    execFile(bin, args, { timeout }, (err) => {
      if (err) {
        console.error('yt-dlp tiktok erreur:', err.message)
        resolve(null)
        return
      }
      if (!fs.existsSync(cachedPath)) {
        console.error('yt-dlp tiktok: fichier introuvable après téléchargement')
        resolve(null)
        return
      }
      resolve(cachedPath)
    })
  })
}

function fetchYtDlpMeta(url, settings) {
  return new Promise((resolve) => {
    const bin = findYtDlp()
    const timeout = settings.ytTimeout || 30000
    const args = ['--dump-json', '--no-playlist']

    if (isTikTokUrl(url)) args.push('--impersonate', 'chrome')
    args.push(url)

    execFile(bin, args, { timeout }, (err, stdout) => {
      if (err) {
        console.error('yt-dlp meta erreur:', err.message)
        resolve(null)
        return
      }
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (parseErr) {
        console.error('yt-dlp meta parse erreur:', parseErr.message)
        resolve(null)
      }
    })
  })
}

module.exports = {
  cleanTiktokTmp,
  isTikTokUrl,
  isYtDlpUrl,
  isYouTubeUrl,
  isTwitchUrl,
  extractYouTubeId,
  fetchYtDlpStream,
  fetchYtDlpTikTokFile,
  fetchYtDlpMeta
}