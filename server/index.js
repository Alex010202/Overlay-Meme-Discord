const { Client, GatewayIntentBits } = require('discord.js')
const { WebSocketServer } = require('ws')
const https = require('https')

const PORT      = process.env.PORT      || 3000
const WS_SECRET = process.env.WS_SECRET || ''

const wss     = new WebSocketServer({ port: PORT })
const clients = new Set()

// Draw rooms: code → Set of ws clients in that room
// Each ws has ws._drawCode and ws._drawUsername
const drawRooms = new Map()

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, `http://localhost`)
  const token = url.searchParams.get('secret')
  if (WS_SECRET && token !== WS_SECRET) {
    ws.close(4001, 'Unauthorized')
    return
  }

  console.log('[WS] Client connecté')
  clients.add(ws)
  ws._drawCode     = null
  ws._drawUsername = null

  if (client.isReady()) {
    ws.send(JSON.stringify({ event: 'status', data: { ok: true, tag: client.user.tag } }))
  } else {
    ws.send(JSON.stringify({ event: 'status', data: { ok: false, error: 'Bot pas encore prêt' } }))
  }

  ws.on('message', (raw) => {
    try {
      const { event, data } = JSON.parse(raw)
      handleClientEvent(ws, event, data)
    } catch (err) {
      console.error('[WS] Message invalide:', err.message)
    }
  })

  ws.on('close', () => {
    clients.delete(ws)
    console.log('[WS] Client déconnecté')

    // Leave draw room if in one
    if (ws._drawCode) {
      leaveDrawRoom(ws)
    }
  })

  ws.on('error', (err) => {
    console.error('[WS] Erreur:', err.message)
    clients.delete(ws)
  })
})

// ─── Draw room management ────────────────────────────────────────────
function joinDrawRoom(ws, code, username) {
  // Leave previous room if any
  if (ws._drawCode) leaveDrawRoom(ws)

  if (!drawRooms.has(code)) drawRooms.set(code, new Set())
  drawRooms.get(code).add(ws)

  ws._drawCode     = code
  ws._drawUsername = username || 'Pote'

  console.log(`[Draw] ${username} a rejoint la room ${code}`)

  broadcastToRoom(code, {
    event: 'draw-peer-joined',
    data:  { peerId: ws._peerId, username: ws._drawUsername }
  }, ws)

  // Inclure hostScreen dans la confirmation
  const hostScreen = drawRooms.get(code)?._hostScreen || null
  ws.send(JSON.stringify({
    event: 'draw-joined',
    data:  { code, ok: true, hostScreen }
  }))
}

function leaveDrawRoom(ws) {
  const code = ws._drawCode
  if (!code) return

  const room = drawRooms.get(code)
  if (room) {
    room.delete(ws)
    if (room.size === 0) drawRooms.delete(code)
  }

  console.log(`[Draw] ${ws._drawUsername} a quitté la room ${code}`)

  broadcastToRoom(code, {
    event: 'draw-peer-left',
    data:  { peerId: ws._peerId, username: ws._drawUsername }
  })

  ws._drawCode     = null
  ws._drawUsername = null
}

function broadcastToRoom(code, payload, exclude = null) {
  const room = drawRooms.get(code)
  if (!room) return
  const str = JSON.stringify(payload)
  for (const member of room) {
    if (member !== exclude && member.readyState === 1) {
      member.send(str, (err) => {
        if (err) console.error('[WS] Erreur envoi room:', err.message)
      })
    }
  }
}

// ─── Client event handler ────────────────────────────────────────────
function handleClientEvent(ws, event, data) {
  switch (event) {

    // ── Draw: host opens a room ──────────────────────────────────────
    case 'draw-open': {
      const { code, hostScreen } = data
      if (!drawRooms.has(code)) drawRooms.set(code, new Set())
      drawRooms.get(code).add(ws)
      ws._drawCode      = code
      ws._drawUsername  = 'Host'
      ws._isDrawHost    = true
      ws._hostScreen    = hostScreen || null
      // Stocker hostScreen sur la room pour les peers qui rejoignent
      drawRooms.get(code)._hostScreen = hostScreen || null
      console.log(`[Draw] Room ouverte: ${code} | Rooms actives: ${[...drawRooms.keys()].join(', ')}`)
      break
    }

    case 'draw-close': {
      const { code } = data
      if (drawRooms.has(code)) {
        broadcastToRoom(code, { event: 'draw-closed', data: {} })
        drawRooms.delete(code)
      }
      ws._drawCode   = null
      ws._isDrawHost = false
      console.log(`[Draw] Room fermée: ${code}`)
      break
    }

    case 'draw-join': {
      const { code, username } = data
      console.log(`[Draw] Tentative join: code=${code} username=${username} | Rooms: ${[...drawRooms.keys()].join(', ')}`)
      if (!drawRooms.has(code)) {
        console.warn(`[Draw] Code invalide: ${code}`)
        ws.send(JSON.stringify({ event: 'draw-joined', data: { ok: false, error: 'Code invalide' } }))
        return
      }
      ws._peerId = Math.random().toString(36).slice(2, 9)
      joinDrawRoom(ws, code, username)
      break
    }

    // ── Draw: peer leaves ────────────────────────────────────────────
    case 'draw-leave': {
      leaveDrawRoom(ws)
      break
    }

    // ── Draw: relay stroke ───────────────────────────────────────────
    case 'draw-stroke': {
      const { code } = data
      broadcastToRoom(code, { event: 'draw-stroke', data }, ws)
      break
    }

    // ── Draw: relay cursor ───────────────────────────────────────────
    case 'draw-cursor-move': {
      const { code, x, y } = data
      broadcastToRoom(code, {
        event: 'draw-cursor',
        data:  { peerId: ws._peerId, username: ws._drawUsername, x, y }
      }, ws)
      break
    }

    // ── Draw: relay screen capture ────────────────────────────────────
    case 'draw-screen': {
      const { code } = data
      broadcastToRoom(code, { event: 'draw-screen', data }, ws)
      break
    }

    // ── Draw: relay full canvas sync ─────────────────────────────────
    case 'draw-full-sync': {
      const { code } = data
      broadcastToRoom(code, { event: 'draw-full-sync', data }, ws)
      break
    }

    default:
      break
  }
}

// ─── Discord broadcast ───────────────────────────────────────────────
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
  try { const h = new URL(url).hostname.replace('www.', ''); return h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === 'vm.tiktok.com' } catch { return false }
}
function isYtDlpUrl(url) {
  try { const h = new URL(url).hostname.replace('www.', ''); return YTDLP_DOMAINS.some(d => h === d || h.endsWith('.' + d)) } catch { return false }
}
function isYouTubeUrl(url) {
  try { const h = new URL(url).hostname.replace('www.', ''); return h === 'youtube.com' || h === 'youtu.be' } catch { return false }
}
function extractYouTubeId(url) {
  try {
    const p = new URL(url); const h = p.hostname.replace('www.', '')
    if (h === 'youtu.be') return p.pathname.slice(1).split('?')[0]
    if (h === 'youtube.com') {
      const m = p.pathname.match(/^\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]+)/)
      if (m) return m[1]
      return p.searchParams.get('v') || null
    }
  } catch { return null }
  return null
}

function parseAttachments(message) {
  let attachmentUrl = null, gifIsVideo = false, gifIsLooping = false, audioUrl = null
  for (const att of message.attachments.values()) {
    const ct = att.contentType || ''
    const isImage = ct.startsWith('image/'), isVideo = ct.startsWith('video/'), isAudio = ct.startsWith('audio/')
    const isGifUrl = /\.gif(\?|$)/i.test(att.url), isVidUrl = /\.(mp4|webm|mov)(\?|$)/i.test(att.url)
    const isAudUrl = /\.(mp3|ogg|wav|flac|m4a|opus)(\?|$)/i.test(att.url)
    if (isImage || isGifUrl) { attachmentUrl = att.url; gifIsVideo = false; gifIsLooping = isGifUrl; break }
    if (isVideo || isVidUrl) { attachmentUrl = att.url; gifIsVideo = true; break }
    if ((isAudio || isAudUrl) && !audioUrl) audioUrl = att.url
  }
  if (!audioUrl && message.flags?.bitfield && (message.flags.bitfield & 8192)) {
    for (const att of message.attachments.values()) { if (att.url) { audioUrl = att.url; break } }
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
    attachmentUrl = parsed.attachmentUrl; gifIsVideo = parsed.gifIsVideo
    gifIsLooping  = parsed.gifIsLooping;  audioUrl   = parsed.audioUrl
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

        gifUrl = embed.video.url; gifIsVideo = true
        gifIsLooping = embed.type === 'gifv' || /tenor\.com|giphy\.com/i.test(embed.url || '')
        break
      }
      if (embed.image?.url)     { gifUrl = embed.image.url; break }
      if (embed.thumbnail?.url) { gifUrl = embed.thumbnail.url; break }
    }
  }

  if (gifUrl && message.embeds.length > 0) {
    const embedUrl = message.embeds[0]?.url
    if (embedUrl && content.includes(embedUrl)) content = content.replace(embedUrl, '').trim()
  }

  if (!gifUrl && !attachmentUrl && !stickerUrl) {
    const tenorMatch = content.match(/https?:\/\/tenor\.com\/view\/[^\s]+/)
    if (tenorMatch) {
      const tenorUrl = tenorMatch[0]; content = content.replace(tenorUrl, '').trim()
      fetchTenorMp4(tenorUrl).then(mp4Url => {
        if (mp4Url) broadcast('message', { author, avatar, time, content: content.trim(), gifUrl: mp4Url, gifIsVideo: true, gifIsLooping: true })
      }).catch(err => console.error('Tenor erreur:', err.message))
      return
    }

    const urlMatch = content.match(/https?:\/\/[^\s]+/)
    if (urlMatch) {
      const url = urlMatch[0]
      if (isYouTubeUrl(url)) {
        const ytId = extractYouTubeId(url)
        if (ytId) { content = content.replace(url, '').trim(); broadcast('message', { author, avatar, time, content: content.trim(), youtubeView: ytId }); return }
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
        gifIsVideo    = /\.(mp4|webm|mov)/i.test(mediaMatch[1])
        content       = content.replace(mediaMatch[0], '').trim()
      }
    }
  }

  broadcast('message', {
    author, avatar, time, content: content.trim(),
    gifUrl: gifUrl || stickerUrl || attachmentUrl,
    gifIsVideo, gifIsLooping,
    audioUrl: audioUrl || null,
    isVoiceMessage: !!(message.flags?.bitfield && (message.flags.bitfield & 8192))
  })
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})

const CHANNEL_ID = process.env.CHANNEL_ID || ''

client.once('clientReady', (c) => {
  console.log(`[Discord] Connecté en tant que ${c.user.tag}`)
  broadcast('status', { ok: true, tag: c.user.tag })
})

client.on('messageCreate', (message) => {
  handleMessage(message, CHANNEL_ID).catch(err => console.error('[Discord] Erreur traitement message:', err.message))
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