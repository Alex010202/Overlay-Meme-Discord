const { Client, GatewayIntentBits } = require('discord.js')
const { WebSocketServer } = require('ws')
const https = require('https')

const PORT = process.env.PORT || 3000
const WS_SECRET = process.env.WS_SECRET || ''

const wss = new WebSocketServer({ port: PORT })
const clients = new Set()

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://localhost`)
  const token = url.searchParams.get('secret')
  if (WS_SECRET && token !== WS_SECRET) {
    ws.close(4001, 'Unauthorized')
    return
  }

  console.log('[WS] Client connecté')
  clients.add(ws)

  if (client.isReady()) {
    ws.send(JSON.stringify({ event: 'status', data: { ok: true, tag: client.user.tag } }))
  } else {
    ws.send(JSON.stringify({ event: 'status', data: { ok: false, error: 'Bot pas encore prêt' } }))
  }

  ws.on('close', () => {
    clients.delete(ws)
    console.log('[WS] Client déconnecté')
  })

  ws.on('error', (err) => {
    console.error('[WS] Erreur:', err.message)
    clients.delete(ws)
  })
})

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data })
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(payload, (err) => {
        if (err) {
          console.error('[WS] Erreur envoi:', err.message)
          clients.delete(ws)
        }
      })
    }
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
      res.on('error', () => resolve(null))
    }).on('error', () => resolve(null))
  })
}

const YTDLP_DOMAINS = [
  'youtube.com', 'youtu.be', 'twitch.tv', 'clips.twitch.tv',
  'reddit.com', 'v.redd.it', 'twitter.com', 'x.com', 'tiktok.com',
  'instagram.com', 'vimeo.com', 'dailymotion.com', 'streamable.com',
  'medal.tv', 'kick.com'
]

function isTikTokUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'tiktok.com' || host.endsWith('.tiktok.com') || host === 'vm.tiktok.com'
  } catch { return false }
}

function isYtDlpUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return YTDLP_DOMAINS.some(d => host === d || host.endsWith('.' + d))
  } catch { return false }
}

function isYouTubeUrl(url) {
  try {
    const host = new URL(url).hostname.replace('www.', '')
    return host === 'youtube.com' || host === 'youtu.be'
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
  } catch { return null }
  return null
}

function parseAttachments(message) {
  let attachmentUrl = null, gifIsVideo = false, gifIsLooping = false, audioUrl = null

  for (const att of message.attachments.values()) {
    const ct = att.contentType || ''
    const isImage  = ct.startsWith('image/')
    const isVideo  = ct.startsWith('video/')
    const isAudio  = ct.startsWith('audio/')
    const isGifUrl = /\.gif(\?|$)/i.test(att.url)
    const isVidUrl = /\.(mp4|webm|mov)(\?|$)/i.test(att.url)
    const isAudUrl = /\.(mp3|ogg|wav|flac|m4a|opus)(\?|$)/i.test(att.url)

    if (isImage || isGifUrl) {
      attachmentUrl = att.url; gifIsVideo = false; gifIsLooping = isGifUrl; break
    }
    if (isVideo || isVidUrl) { attachmentUrl = att.url; gifIsVideo = true; break }
    if ((isAudio || isAudUrl) && !audioUrl) audioUrl = att.url
  }

  if (!audioUrl && message.flags?.bitfield && (message.flags.bitfield & 8192)) {
    for (const att of message.attachments.values()) {
      if (att.url) { audioUrl = att.url; break }
    }
  }

  return { attachmentUrl, gifIsVideo, gifIsLooping, audioUrl }
}

async function handleMessage(message, currentChannelId) {
  if (message.channel.id !== currentChannelId || message.author.bot) return

  let content = message.content || ''
  let gifUrl = null, stickerUrl = null, gifIsVideo = false, gifIsLooping = false
  let audioUrl = null, attachmentUrl = null

  const author = message.author.username
  const avatar = message.author.displayAvatarURL({ size: 32 })
  const time = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })

  const stickerMatch = content.match(/^\[.+?\]\((https:\/\/media\.discordapp\.net\/stickers\/[^\)]+)\)$/)
  if (stickerMatch) { stickerUrl = stickerMatch[1]; content = '' }

  if (message.attachments.size > 0) {
    const parsed = parseAttachments(message)
    attachmentUrl = parsed.attachmentUrl
    gifIsVideo = parsed.gifIsVideo
    gifIsLooping = parsed.gifIsLooping
    audioUrl = parsed.audioUrl
  }

  if (message.embeds.length > 0) {
    for (const embed of message.embeds) {
      if (embed.video?.url) {
        const embedSourceUrl = embed.url || embed.video.url
        if (isYouTubeUrl(embedSourceUrl)) break

        const tiktokMatch = (embed.video.url || '').match(/tiktok\.com\/player\/v1\/(\d+)/)
        if (tiktokMatch) {
          const tiktokUrl = embed.url || `https://www.tiktok.com/video/${tiktokMatch[1]}`
          content = content.replace(tiktokUrl, '').replace(embed.video.url, '').trim()
          broadcast('message', { author, avatar, time, content, loading: true, loadingUrl: tiktokUrl })
          broadcast('ytdlp-needed', { url: tiktokUrl, type: 'tiktok', content, author, avatar, time })
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
        if (mp4Url) {
          broadcast('message', {
            author, avatar, time, content: content.trim(),
            gifUrl: mp4Url, gifIsVideo: true, gifIsLooping: true
          })
        }
      }).catch(err => console.error('Tenor erreur:', err.message))
      return
    }

    const urlMatch = content.match(/https?:\/\/[^\s]+/)
    if (urlMatch) {
      const url = urlMatch[0]

      if (isYouTubeUrl(url)) {
        const ytId = extractYouTubeId(url)
        if (ytId) {
          content = content.replace(url, '').trim()
          broadcast('message', { author, avatar, time, content: content.trim(), youtubeView: ytId })
          return
        }
      }

      if (isYtDlpUrl(url) && !isYouTubeUrl(url)) {
        content = content.replace(url, '').trim()
        const type = isTikTokUrl(url) ? 'tiktok' : 'ytdlp'
        broadcast('message', { author, avatar, time, content, loading: true, loadingUrl: url })
        broadcast('ytdlp-needed', { url, type, content, author, avatar, time })
        return
      }

      const mediaMatch = url.match(/https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|avif|mp4|webm|mov)(\?[^\s]*)?/i)
      if (mediaMatch) {
        attachmentUrl = mediaMatch[0]
        gifIsVideo = /\.(mp4|webm|mov)/i.test(mediaMatch[1])
        content = content.replace(mediaMatch[0], '').trim()
      }
    }
  }

  broadcast('message', {
    author, avatar, time,
    content: content.trim(),
    gifUrl: gifUrl || stickerUrl || attachmentUrl,
    gifIsVideo,
    gifIsLooping,
    audioUrl: audioUrl || null,
    isVoiceMessage: !!(message.flags?.bitfield && (message.flags.bitfield & 8192))
  })
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

const CHANNEL_ID = process.env.CHANNEL_ID || ''

client.once('clientReady', (c) => {
  console.log(`[Discord] Connecté en tant que ${c.user.tag}`)
  broadcast('status', { ok: true, tag: c.user.tag })
})

client.on('messageCreate', (message) => {
  handleMessage(message, CHANNEL_ID).catch(err => {
    console.error('[Discord] Erreur traitement message:', err.message)
  })
})

client.on('error', (err) => {
  console.error('[Discord] Erreur client:', err.message)
  broadcast('status', { ok: false })
})

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('[Discord] Erreur login:', err.message)
  broadcast('status', { ok: false })
})

console.log(`[WS] Serveur WebSocket démarré sur le port ${PORT}`)