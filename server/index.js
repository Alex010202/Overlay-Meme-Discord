const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js')
const { WebSocketServer } = require('ws')
const https = require('https')
const PORT      = process.env.PORT      || 3000
const WS_SECRET = process.env.WS_SECRET || ''
const wss     = new WebSocketServer({ port: PORT, perMessageDeflate: true })
const clients = new Set()
const drawRooms = new Map()
const cursorThrottle = new Map()
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
    ws.send(pack('status', { ok: true, tag: client.user.tag, id: client.user.id }))
  } else {
    ws.send(pack('status', { ok: false, error: 'Bot pas encore prêt' }))
  }
  ws.on('message', (raw) => {
    try {
      const { e: event, d: data } = JSON.parse(raw)
      handleClientEvent(ws, event || JSON.parse(raw).event, data || JSON.parse(raw).data)
    } catch (err) {
      console.error('[WS] Message invalide:', err.message)
    }
  })
  ws.on('close', () => {
    clients.delete(ws)
    console.log('[WS] Client déconnecté')
    if (ws._drawCode) leaveDrawRoom(ws)
  })
  ws.on('error', (err) => {
    console.error('[WS] Erreur:', err.message)
    clients.delete(ws)
  })
})
function pack(event, data) {
  return JSON.stringify({ e: event, d: data })
}
function joinDrawRoom(ws, code, username) {
  if (ws._drawCode) leaveDrawRoom(ws)
  if (!drawRooms.has(code)) drawRooms.set(code, new Set())
  drawRooms.get(code).add(ws)
  ws._drawCode     = code
  ws._drawUsername = username || 'Pote'
  console.log(`[Draw] ${username} a rejoint la room ${code}`)
  broadcastToRoom(code, pack('draw-peer-joined', { peerId: ws._peerId, username: ws._drawUsername }), ws)
  const hostScreen = drawRooms.get(code)?._hostScreen || null
  ws.send(pack('draw-joined', { code, ok: true, hostScreen }))
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
  broadcastToRoom(code, pack('draw-peer-left', { peerId: ws._peerId, username: ws._drawUsername }))
  cursorThrottle.delete(ws._peerId)
  ws._drawCode     = null
  ws._drawUsername = null
}
function broadcastToRoom(code, str, exclude = null) {
  const room = drawRooms.get(code)
  if (!room) return
  for (const member of room) {
    if (member !== exclude && member.readyState === 1) {
      member.send(str, (err) => {
        if (err) console.error('[WS] Erreur envoi room:', err.message)
      })
    }
  }
}
function isValidSnowflake(id) {
  return /^\d{17,20}$/.test(id || '')
}
async function checkChannelAccess(channelId) {
  if (!channelId) return { code: 'empty' }
  if (!isValidSnowflake(channelId)) return { code: 'invalid-id' }
  if (!client.isReady()) return { code: 'bot-offline' }
  const channel = client.channels.cache.get(channelId)
  if (!channel) return { code: 'not-in-server' }
  if (!channel.guild) return { code: 'error' }
  try {
    const me = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null)
    if (!me) return { code: 'not-in-server' }
    const perms = channel.permissionsFor(me)
    if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel) || !perms.has(PermissionsBitField.Flags.ReadMessageHistory)) {
      return { code: 'no-permission', channelName: channel.name, guildName: channel.guild.name }
    }
    return { code: 'ok', channelName: channel.name, guildName: channel.guild.name }
  } catch (err) {
    console.error('[Channel] Erreur vérification accès:', err.message)
    return { code: 'error' }
  }
}
let lastChannelStatusKey = null
async function checkAndBroadcastIfChanged() {
  if (!CHANNEL_ID) return
  const result = await checkChannelAccess(CHANNEL_ID)
  const key = JSON.stringify(result)
  if (key !== lastChannelStatusKey) {
    lastChannelStatusKey = key
    broadcast('channel-status', result)
  }
}
let recheckTimer = null
function scheduleRecheck(delay = 800) {
  clearTimeout(recheckTimer)
  recheckTimer = setTimeout(checkAndBroadcastIfChanged, delay)
}
async function forceCheckChannel() {
  const result = await checkChannelAccess(CHANNEL_ID)
  lastChannelStatusKey = JSON.stringify(result)
  broadcast('channel-status', result)
}
function handleClientEvent(ws, event, data) {
  switch (event) {
    case 'draw-open': {
      const { code, hostScreen } = data
      if (!drawRooms.has(code)) drawRooms.set(code, new Set())
      drawRooms.get(code).add(ws)
      ws._drawCode      = code
      ws._drawUsername  = 'Host'
      ws._isDrawHost    = true
      ws._hostScreen    = hostScreen || null
      drawRooms.get(code)._hostScreen = hostScreen || null
      console.log(`[Draw] Room ouverte: ${code}`)
      break
    }
    case 'draw-close': {
      const { code } = data
      if (drawRooms.has(code)) {
        broadcastToRoom(code, pack('draw-closed', {}))
        drawRooms.delete(code)
      }
      ws._drawCode   = null
      ws._isDrawHost = false
      console.log(`[Draw] Room fermée: ${code}`)
      break
    }
    case 'draw-join': {
      const { code, username } = data
      console.log(`[Draw] Tentative join: code=${code} username=${username}`)
      if (!drawRooms.has(code)) {
        ws.send(pack('draw-joined', { ok: false, error: 'Code invalide' }))
        return
      }
      ws._peerId = Math.random().toString(36).slice(2, 9)
      joinDrawRoom(ws, code, username)
      break
    }
    case 'draw-leave': {
      leaveDrawRoom(ws)
      break
    }
    case 'draw-stroke': {
      const { code } = data
      broadcastToRoom(code, pack('draw-stroke', data), ws)
      break
    }
    case 'draw-cursor-move': {
      const { code, x, y } = data
      const now = Date.now()
      const peerId = ws._peerId
      const last = cursorThrottle.get(peerId) || 0
      if (now - last < 50) return
      cursorThrottle.set(peerId, now)
      broadcastToRoom(code, pack('draw-cursor', {
        peerId,
        username: ws._drawUsername,
        x: Math.round(x * 1000) / 1000,
        y: Math.round(y * 1000) / 1000
      }), ws)
      break
    }
    case 'draw-screen': {
      const { code } = data
      const now = Date.now()
      const roomMeta = drawRooms.get(code)
      if (!roomMeta) break
      const lastScreen = roomMeta._lastScreenAt || 0
      if (now - lastScreen < 67) return
      roomMeta._lastScreenAt = now
      broadcastToRoom(code, pack('draw-screen', data), ws)
      break
    }
    case 'draw-full-sync': {
      const { code } = data
      broadcastToRoom(code, pack('draw-full-sync', data), ws)
      break
    }
    case 'draw-file': {
      const { code } = data
      broadcastToRoom(code, pack('draw-file', data), ws)
      break
    }
    case 'set-channel': {
      const { channelId } = data
      CHANNEL_ID = channelId || ''
      console.log(`[Discord] Salon actif changé: ${CHANNEL_ID || '(aucun)'}`)
      forceCheckChannel()
      break
    }
    default:
      break
  }
}
function broadcast(event, data) {
  const str = pack(event, data)
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(str, (err) => {
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
function compactMessage(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== false && v !== '') out[k] = v
  }
  return out
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
          broadcast('message', compactMessage({ author, avatar, time, content, loading: true, loadingUrl: tiktokUrl }))
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
        if (mp4Url) broadcast('message', compactMessage({ author, avatar, time, content: content.trim(), gifUrl: mp4Url, gifIsVideo: true, gifIsLooping: true }))
      }).catch(err => console.error('Tenor erreur:', err.message))
      return
    }
    const urlMatch = content.match(/https?:\/\/[^\s]+/)
    if (urlMatch) {
      const url = urlMatch[0]
      if (isYouTubeUrl(url)) {
        const ytId = extractYouTubeId(url)
        if (ytId) { content = content.replace(url, '').trim(); broadcast('message', compactMessage({ author, avatar, time, content: content.trim(), youtubeView: ytId })); return }
      }
      if (isYtDlpUrl(url) && !isYouTubeUrl(url)) {
        content = content.replace(url, '').trim()
        const type = isTikTokUrl(url) ? 'tiktok' : 'ytdlp'
        broadcast('message', compactMessage({ author, avatar, time, content, loading: true, loadingUrl: url }))
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
  broadcast('message', compactMessage({
    author, avatar, time, content: content.trim(),
    gifUrl: gifUrl || stickerUrl || attachmentUrl || null,
    gifIsVideo,
    gifIsLooping,
    audioUrl: audioUrl || null,
    isVoiceMessage: !!(message.flags?.bitfield && (message.flags.bitfield & 8192))
  }))
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
})
let CHANNEL_ID = process.env.CHANNEL_ID || ''
client.once('clientReady', (c) => {
  console.log(`[Discord] Connecté en tant que ${c.user.tag}`)
  broadcast('status', { ok: true, tag: c.user.tag, id: c.user.id })
  forceCheckChannel()
})
client.on('guildCreate', () => scheduleRecheck(500))
client.on('guildDelete', () => scheduleRecheck(500))
client.on('channelCreate', (c) => { if (c.id === CHANNEL_ID) scheduleRecheck() })
client.on('channelDelete', (c) => { if (c.id === CHANNEL_ID) scheduleRecheck() })
client.on('channelUpdate', (oldC, newC) => { if (newC.id === CHANNEL_ID) scheduleRecheck() })
client.on('roleUpdate', () => scheduleRecheck(1200))
client.on('guildMemberUpdate', (oldM, newM) => { if (newM.id === client.user?.id) scheduleRecheck() })
setInterval(checkAndBroadcastIfChanged, 60000)
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