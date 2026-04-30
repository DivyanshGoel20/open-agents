import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

function shortPeerId(peerId) {
  if (!peerId) return '…'
  const s = String(peerId)
  return s.length <= 14 ? s : `${s.slice(0, 6)}…${s.slice(-6)}`
}

function App() {
  const [from, setFrom] = useState('A')
  const [text, setText] = useState('')
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('connecting')
  const [peers, setPeers] = useState({ A: null, B: null })
  const leftRef = useRef(null)
  const rightRef = useRef(null)
  const seenIdsRef = useRef(new Set())

  const to = useMemo(() => (from === 'A' ? 'B' : 'A'), [from])
  const sorted = useMemo(() => {
    const copy = messages.slice()
    copy.sort((a, b) => (a?.ts || 0) - (b?.ts || 0))
    return copy
  }, [messages])

  useEffect(() => {
    let cancelled = false

    fetch('/api/health')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        setPeers({
          A: data?.axl?.A?.peerId || null,
          B: data?.axl?.B?.peerId || null,
        })
      })
      .catch(() => {
        // ignore
      })

    fetch('/api/messages')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return
        const incoming = Array.isArray(data?.messages) ? data.messages : []
        const deduped = []
        for (const m of incoming) {
          if (!m?.id) continue
          if (seenIdsRef.current.has(m.id)) continue
          seenIdsRef.current.add(m.id)
          deduped.push(m)
        }
        setMessages(deduped)
      })
      .catch(() => {
        // ignore
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/events')
    es.addEventListener('ready', () => setStatus('connected'))
    es.addEventListener('message', (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (!msg?.id) return
        if (seenIdsRef.current.has(msg.id)) return
        seenIdsRef.current.add(msg.id)
        setMessages((prev) => prev.concat(msg))
      } catch {
        // ignore
      }
    })
    es.onerror = () => setStatus('reconnecting')

    return () => es.close()
  }, [])

  useEffect(() => {
    const l = leftRef.current
    if (l) l.scrollTop = l.scrollHeight
    const r = rightRef.current
    if (r) r.scrollTop = r.scrollHeight
  }, [sorted.length])

  async function send() {
    const body = { from, text }
    const t = text.trim()
    if (!t) return
    setText('')
    try {
      const res = await fetch('/api/sendMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        alert(err?.error || 'Send failed')
      }
    } catch {
      alert('Send failed')
    }
  }

  return (
    <>
      <div className="chatShell">
        <header className="chatHeader">
          <div className="title">
            <h1>AXL Chat</h1>
            <p>
              {status === 'connected' ? 'Connected' : 'Connecting…'} • sending{' '}
              <strong>{from}</strong> → <strong>{to}</strong>
            </p>
          </div>

          <div className="controls">
            <label className="select">
              Send as
              <select value={from} onChange={(e) => setFrom(e.target.value)}>
                <option value="A">A (api_port 9002)</option>
                <option value="B">B (api_port 9012)</option>
              </select>
            </label>
          </div>
        </header>

        <main className="chatMain">
          <section className="pane">
            <div className="paneHeader">
              <div className="paneTitle">Node A</div>
              <div className="paneSub">{shortPeerId(peers.A)}</div>
            </div>
            <div className="paneBody" ref={leftRef}>
              {sorted.length === 0 ? (
                <div className="empty">No messages yet.</div>
              ) : (
                sorted.map((m) => (
                  <div
                    key={m.id}
                    className={`msg ${m?.from === 'A' ? 'outgoing' : 'incoming'}`}
                  >
                    <div className="meta">
                      <span className="who">
                        {m.from} → {m.to}
                      </span>
                      <span className="time">
                        {new Date(m.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="bubble">{m.text}</div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="pane">
            <div className="paneHeader">
              <div className="paneTitle">Node B</div>
              <div className="paneSub">{shortPeerId(peers.B)}</div>
            </div>
            <div className="paneBody" ref={rightRef}>
              {sorted.length === 0 ? (
                <div className="empty">No messages yet.</div>
              ) : (
                sorted.map((m) => (
                  <div
                    key={m.id}
                    className={`msg ${m?.from === 'B' ? 'outgoing' : 'incoming'}`}
                  >
                    <div className="meta">
                      <span className="who">
                        {m.from} → {m.to}
                      </span>
                      <span className="time">
                        {new Date(m.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="bubble">{m.text}</div>
                  </div>
                ))
              )}
            </div>
          </section>
        </main>

        <footer className="chatFooter">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send()
            }}
            placeholder="Type a message…"
          />
          <button type="button" onClick={send}>
            Send
          </button>
        </footer>
      </div>
    </>
  )
}

export default App
