import express from 'express'
import cors from 'cors'

const app = express()

app.use(cors())
app.use(express.json({ limit: '64kb' }))

const BACKEND_PORT = Number(process.env.PORT || 5050)

const AXL_A_BASE = process.env.AXL_A_BASE || 'http://127.0.0.1:9002'
const AXL_B_BASE = process.env.AXL_B_BASE || 'http://127.0.0.1:9012'

/** @type {{ A?: { base: string, peerId?: string }, B?: { base: string, peerId?: string } }} */
const axl = {
  A: { base: AXL_A_BASE, peerId: undefined },
  B: { base: AXL_B_BASE, peerId: undefined },
}

/** @type {Array<{ id: string, ts: number, from: 'A'|'B', to: 'A'|'B', text: string }>} */
const messages = []

/** @type {Set<import('express').Response>} */
const sseClients = new Set()

/**
 * AXL doesn't give us a message id. We optimistically add a "sent" message, then
 * the receiver's /recv returns the same payload shortly after. Deduplicate these
 * by a short-lived fingerprint.
 *
 * @type {Map<string, number>}
 */
const recentFingerprints = new Map()
const FINGERPRINT_TTL_MS = 4000

function fingerprint(from, to, text) {
  return `${from}->${to}:${text}`
}

function rememberFingerprint(key) {
  const now = Date.now()
  recentFingerprints.set(key, now)
  for (const [k, ts] of recentFingerprints) {
    if (now - ts > FINGERPRINT_TTL_MS) recentFingerprints.delete(k)
  }
}

function recentlySeenFingerprint(key) {
  const ts = recentFingerprints.get(key)
  if (!ts) return false
  return Date.now() - ts <= FINGERPRINT_TTL_MS
}

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(payload)
    } catch {
      sseClients.delete(res)
    }
  }
}

function addMessage(msg) {
  messages.push(msg)
  if (messages.length > 500) messages.splice(0, messages.length - 500)
  broadcast('message', msg)
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(t)
  }
}

async function discoverPeerIds() {
  try {
    const topoA = await fetchJson(`${axl.A.base}/topology`)
    axl.A.peerId = topoA.our_public_key
  } catch (e) {
    console.warn('[axl] topology A failed:', e?.message || e)
  }

  try {
    const topoB = await fetchJson(`${axl.B.base}/topology`)
    axl.B.peerId = topoB.our_public_key
  } catch (e) {
    console.warn('[axl] topology B failed:', e?.message || e)
  }
}

function resolveNodeFromPeerId(peerId) {
  if (peerId && axl.A.peerId && peerId === axl.A.peerId) return 'A'
  if (peerId && axl.B.peerId && peerId === axl.B.peerId) return 'B'
  return undefined
}

async function axlSend(from, toPeerId, text) {
  const base = axl[from].base
  const res = await fetch(`${base}/send`, {
    method: 'POST',
    headers: {
      'X-Destination-Peer-Id': toPeerId,
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: text,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AXL /send failed (${res.status}): ${body}`)
  }
}

async function axlRecvLoop(nodeName) {
  const base = axl[nodeName].base
  while (true) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), 15000)
    try {
      const res = await fetch(`${base}/recv`, { signal: controller.signal })

      if (res.status === 204) continue
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, 500))
        continue
      }

      const text = (await res.text()).trim()
      if (!text) continue

      const fromPeerId = res.headers.get('x-from-peer-id') || res.headers.get('X-From-Peer-Id')
      const fromNode = resolveNodeFromPeerId(fromPeerId) || (nodeName === 'A' ? 'B' : 'A')
      const toNode = nodeName

      const fp = fingerprint(fromNode, toNode, text)
      // If we already added this exact message as a local "send" a moment ago,
      // don't add a second copy when /recv delivers it.
      if (recentlySeenFingerprint(fp)) continue
      rememberFingerprint(fp)

      addMessage({
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        ts: Date.now(),
        from: fromNode,
        to: toNode,
        text,
      })
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    } finally {
      clearTimeout(t)
    }
  }
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    axl: {
      A: { base: axl.A.base, peerId: axl.A.peerId || null },
      B: { base: axl.B.base, peerId: axl.B.peerId || null },
    },
  })
})

app.get('/api/messages', (_req, res) => {
  res.json({ messages })
})

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')

  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
  sseClients.add(res)

  const ping = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`)
    } catch {
      // ignore
    }
  }, 15000)

  req.on('close', () => {
    clearInterval(ping)
    sseClients.delete(res)
  })
})

app.post('/api/sendMessage', async (req, res) => {
  const from = req.body?.from
  const text = (req.body?.text ?? '').toString()

  if (from !== 'A' && from !== 'B') {
    return res.status(400).json({ ok: false, error: '`from` must be "A" or "B"' })
  }
  if (!text.trim()) {
    return res.status(400).json({ ok: false, error: '`text` is required' })
  }

  if (!axl.A.peerId || !axl.B.peerId) {
    await discoverPeerIds()
  }
  if (!axl.A.peerId || !axl.B.peerId) {
    return res.status(503).json({
      ok: false,
      error:
        'AXL peer IDs not discovered yet. Ensure both AXL nodes are running on 9002 and 9012.',
    })
  }

  const to = from === 'A' ? 'B' : 'A'
  const toPeerId = to === 'A' ? axl.A.peerId : axl.B.peerId

  try {
    await axlSend(from, toPeerId, text)
    rememberFingerprint(fingerprint(from, to, text))
    addMessage({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      ts: Date.now(),
      from,
      to,
      text,
    })
    return res.json({ ok: true })
  } catch (e) {
    return res.status(502).json({ ok: false, error: e?.message || String(e) })
  }
})

await discoverPeerIds()
axlRecvLoop('A')
axlRecvLoop('B')

app.listen(BACKEND_PORT, () => {
  console.log(`[backend] listening on http://127.0.0.1:${BACKEND_PORT}`)
  console.log(`[backend] AXL A: ${axl.A.base} peerId=${axl.A.peerId || 'unknown'}`)
  console.log(`[backend] AXL B: ${axl.B.base} peerId=${axl.B.peerId || 'unknown'}`)
})

