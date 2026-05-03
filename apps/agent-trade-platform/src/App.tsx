import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type UiMessage = {
  id: string;
  at: number;
  channel: string;
  fromKey: string;
  toKey: string;
  payload: {
    speaker?: string;
    text?: string;
    fromKeyPreview?: string;
    deliveredToInbox?: string;
  };
  rawPreview: string;
  source: string;
};

type ApiConfig = {
  demo: boolean;
  aliceApi: string;
  bobApi: string;
  alicePeerKeyPreview: string;
  bobPeerKeyPreview: string;
  alicePrivateKey: boolean;
  bobPrivateKey: boolean;
  aliceZeroG: boolean;
  bobZeroG: boolean;
  zeroGRouter: boolean;
  routerChatModel?: string | null;
  uniswapTradingApi: boolean;
  axlAutoReply?: boolean;
  chains?: string[];
};

type BubbleKind = 'sent' | 'received' | 'system';

function bubbleKind(speaker: string, channel: string): BubbleKind {
  if (channel === 'system' || speaker === 'system') return 'system';
  if (speaker === 'alice') return 'sent';
  /* bob, peer (unknown AXL sender), or fallback */
  return 'received';
}

function formatTime(at: number): string {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at));
  } catch {
    return '';
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchOkJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return (await r.json()) as T;
}

export function App() {
  const [msgs, setMsgs] = useState<UiMessage[]>([]);
  const [cfg, setCfg] = useState<ApiConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cue, setCue] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (kind: 'startup' | 'poll') => {
    const retries = kind === 'startup' ? 12 : 1;
    const baseDelay = kind === 'startup' ? 180 : 0;

    let lastErr: unknown;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const c = await fetchOkJson<ApiConfig>('/api/config');
        if (kind === 'poll' && !c.demo) {
          try {
            await fetch('/api/axl/ingest', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
            });
          } catch {
            /* AXL HTTP down — continue with stored messages */
          }
        }

        const m = await fetchOkJson<{ messages: UiMessage[] }>('/api/messages');
        setCfg(c);
        setMsgs(m.messages ?? []);
        setErr(null);
        return;
      } catch (e) {
        lastErr = e;
        if (attempt < retries - 1) {
          await sleep(baseDelay + attempt * 120);
        }
      }
    }

    if (kind === 'startup') {
      setErr(
        lastErr instanceof Error
          ? `Cannot reach the API (usually port 8787 — wait for “agent-trade-platform api…” in the server log). ${lastErr.message}`
          : 'Cannot load /api.',
      );
    }
  }, []);

  useEffect(() => {
    void load('startup');
    const t = window.setInterval(() => void load('poll'), 3000);
    return () => window.clearInterval(t);
  }, [load]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);

  const visible = useMemo(() => {
    return msgs.filter((m) => m.channel === 'conversation' || m.channel === 'system');
  }, [msgs]);

  async function call(path: string, body?: object) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const j = (await r.json()) as Record<string, unknown>;
      if (!r.ok) throw new Error((j.error as string | undefined) ?? JSON.stringify(j));

      if (path.endsWith('/api/axl/ingest')) {
        const skipped = j.skipped === true;
        const ingested = typeof j.ingested === 'number' ? j.ingested : undefined;
        const reason = typeof j.reason === 'string' ? j.reason : '';
        if (skipped) {
          setErr(
            reason === 'DEMO_MODE'
              ? 'Ingest skipped: DEMO_MODE is on. Set DEMO_MODE=false in apps/agent-trade-platform/.env and restart the API to pull from your Go nodes.'
              : `Ingest skipped (${reason || 'unknown'}).`,
          );
        } else if (ingested === 0) {
          setErr(
            'Ingest polled both AXL HTTP APIs — no queued /recv deliveries. If you already drained with curl /recv, send again; confirm AGENT_ALICE_API / AGENT_BOB_API match your node api_port.',
          );
        } else {
          setErr(null);
        }
      } else if (!path.endsWith('/api/demo/ping')) {
        setErr(null);
      }

      await load('poll');
      return j;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function speakerLabel(m: UiMessage): string {
    const s = m.payload?.speaker;
    if (s === 'alice' || s === 'bob' || s === 'system') return s.charAt(0).toUpperCase() + s.slice(1);
    if (s === 'peer') {
      const p = m.payload?.fromKeyPreview ?? '';
      const inbox = m.payload?.deliveredToInbox ?? '';
      return inbox ? `Peer → ${inbox} ${p}` : `Peer ${p}`.trim();
    }
    return m.channel === 'system' ? 'System' : 'Relay';
  }

  function bubbleText(m: UiMessage): string {
    const t = m.payload?.text;
    if (typeof t === 'string' && t.length) return t;
    return m.rawPreview ?? '';
  }

  return (
    <div className="app-shell">
      <header className="nav-bar">
        <div className="nav-avatar" aria-hidden>
          A
        </div>
        <div className="nav-title-block">
          <div className="nav-title">Pico</div>
        </div>
      </header>

      {cfg && (
        <div className="meta-strip">
          <span>
            Alice <code>{cfg.alicePeerKeyPreview}</code>
          </span>
          <span> · </span>
          <span>
            Bob <code>{cfg.bobPeerKeyPreview}</code>
          </span>
          <br />
          {cfg.zeroGRouter && (
            <>
              <span>Model {cfg.routerChatModel ?? '—'}</span>
            </>
          )}
          {(cfg.chains ?? []).length > 0 && (
            <>
              <span> · </span>
              <span>{cfg.chains?.join(' · ')}</span>
            </>
          )}
        </div>
      )}

      <div ref={listRef} className="message-list">
        {visible.length === 0 && (
          <div className="message-list-empty">No messages yet. Use the actions below to start a thread.</div>
        )}
        {visible.map((m) => {
          const label = speakerLabel(m);
          const sp = (m.payload?.speaker as string) || (m.channel === 'system' ? 'system' : 'bob');
          const kind = bubbleKind(sp, m.channel);
          const rowClass =
            kind === 'sent' ? 'bubble-row bubble-row--sent' : kind === 'received' ? 'bubble-row bubble-row--received' : 'bubble-row bubble-row--system';
          const bubbleClass =
            kind === 'sent' ? 'bubble bubble--sent' : kind === 'received' ? 'bubble bubble--received' : 'bubble bubble--system';

          return (
            <div key={m.id} className={rowClass}>
              <div className="bubble-name">
                {label} · {formatTime(m.at)}
              </div>
              <div className={bubbleClass}>{bubbleText(m)}</div>
            </div>
          );
        })}
      </div>

      {err && <div className="error-banner">{err}</div>}

      <nav className="composer">
        <input
          type="text"
          className="composer-input"
          value={cue}
          onChange={(e) => setCue(e.target.value)}
          placeholder={
            cfg?.demo
              ? 'Message…'
              : 'Send Alice/Bob = wire + peer 0G reply · LLM = draft locally first'
          }
        />
        <div className="composer-actions">
          {cfg?.demo && (
            <button disabled={busy} type="button" className="btn" onClick={() => void call('/api/demo/ping')}>
              Demo ping
            </button>
          )}
          {!cfg?.demo && (
            <>
              <button
                disabled={busy}
                type="button"
                className="btn btn--primary"
                title={"Plaintext over Alice's node \u2192 Bob's inbox \u2192 0G auto-reply over AXL"}
                onClick={() =>
                  void (async () => {
                    const t = cue.trim();
                    if (!t) {
                      setErr('Type a message above before sending.');
                      return;
                    }
                    await call('/api/axl/send', { agent: 'alice', text: t });
                  })()
                }
              >
                Send Alice
              </button>
              <button
                disabled={busy}
                type="button"
                className="btn btn--primary"
                title={"Plaintext over Bob's node \u2192 Alice's inbox \u2192 0G auto-reply over AXL"}
                onClick={() =>
                  void (async () => {
                    const t = cue.trim();
                    if (!t) {
                      setErr('Type a message above before sending.');
                      return;
                    }
                    await call('/api/axl/send', { agent: 'bob', text: t });
                  })()
                }
              >
                Send Bob
              </button>
            </>
          )}
          {/* <button disabled={busy} type="button" className="btn" onClick={() => void call('/api/axl/ingest')}>
            Pull AXL now
          </button>
          <button
            disabled={busy}
            type="button"
            className="btn"
            title="Run LLM as Alice locally, then AXL-send to Bob"
            onClick={() => void call('/api/agent/reply', { agent: 'alice', cue })}
          >
            LLM Alice→AXL
          </button>
          <button
            disabled={busy}
            type="button"
            className="btn"
            title="Run LLM as Bob locally, then AXL-send to Alice"
            onClick={() => void call('/api/agent/reply', { agent: 'bob', cue })}
          >
            LLM Bob→AXL
          </button> */}
        </div>
      </nav>
    </div>
  );
}
