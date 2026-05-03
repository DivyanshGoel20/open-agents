import 'dotenv/config';
import crypto from 'node:crypto';
import cors from 'cors';
import express from 'express';
import { appendMessage, listMessages } from './store.js';
import * as axl from './axl.js';
import { inferenceRoutingDebug, routerChatConfigured, routerModelDisplay, runZeroGChat } from './ogChat.js';
import { uniswapQuote } from './tradingApi.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, formatUnits, http, isAddress } from 'viem';
import { baseSepolia } from 'viem/chains';
import { extractQuoteIntent } from './swapParse.js';
import { agentPrivateKeyHex, agentZeroGProviderAddress, isValidAgentPrivateKey } from './agentKeys.js';
import type { AgentSide } from './agentKeys.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 8787);
/** Real AXL by default; set DEMO_MODE=true to run without Go nodes / skip /send. */
const DEMO = ['1', 'true', 'yes'].includes((process.env.DEMO_MODE ?? '').toLowerCase());

/** Human-tagged AXL payloads (`origin:'human'`) trigger 0G from the node's inbox that `/recv`'d them. Set `AXL_AUTO_REPLY=false` to disable. */
const AXL_AUTO_REPLY = !['0', 'false', 'no'].includes((process.env.AXL_AUTO_REPLY ?? 'true').toLowerCase());

const ALICE_API = process.env.AGENT_ALICE_API || 'http://127.0.0.1:9002';
const BOB_API = process.env.AGENT_BOB_API || 'http://127.0.0.1:9012';

/** Normalize AXL/ed25519 hex peer ids (64 chars); strips optional `0x`, fixes casing mismatches vs topology. */
function normalizePeerKey(hex: string): string {
  let t = hex.trim();
  if (t.startsWith('0x') || t.startsWith('0X')) t = t.slice(2).trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  return t.trim();
}

let cachedAliceKey = normalizePeerKey(process.env.ALICE_PEER_KEY || '');
let cachedBobKey = normalizePeerKey(process.env.BOB_PEER_KEY || '');

async function refreshKeysFromTopology(): Promise<void> {
  if (DEMO) return;
  /* Prefer live topology (source of truth) when each node responds. */
  try {
    const t = await axl.topology(ALICE_API);
    cachedAliceKey = normalizePeerKey(t.our_public_key);
  } catch {
    /* keep env or previous cached */
  }
  try {
    const t = await axl.topology(BOB_API);
    cachedBobKey = normalizePeerKey(t.our_public_key);
  } catch {
    /* keep env or previous cached */
  }
}

function syntheticKey(side: AgentSide): string {
  return side === 'alice' ? 'demo-alice-key' : 'demo-bob-key';
}

function keyFor(side: AgentSide): string {
  return side === 'alice' ? cachedAliceKey || syntheticKey('alice') : cachedBobKey || syntheticKey('bob');
}

function apiFor(side: AgentSide): string {
  return side === 'alice' ? ALICE_API : BOB_API;
}

function speakerSideFromPubkey(from: string): AgentSide | null {
  const f = normalizePeerKey(from);
  if (cachedAliceKey && f === normalizePeerKey(cachedAliceKey)) return 'alice';
  if (cachedBobKey && f === normalizePeerKey(cachedBobKey)) return 'bob';
  if (DEMO) {
    if (from === syntheticKey('alice')) return 'alice';
    if (from === syntheticKey('bob')) return 'bob';
  }
  return null;
}

/**
 * Infer sender when `X-From-Peer-Id` does not match topology keys but we still have two-node keys:
 * a message polled from Alice's HTTP `/recv` is for Alice → if not from Alice, treat as Bob, and vice versa.
 */
function inferSpeakerTwoParty(inbox: AgentSide, fromRaw: string): AgentSide | null {
  const f = normalizePeerKey(fromRaw);
  const ak = cachedAliceKey ? normalizePeerKey(cachedAliceKey) : '';
  const bk = cachedBobKey ? normalizePeerKey(cachedBobKey) : '';
  if (!f || !ak || !bk) return null;

  if (inbox === 'alice') {
    if (f === bk) return 'bob';
    if (f === ak) return 'alice';
    return 'bob';
  }
  if (inbox === 'bob') {
    if (f === ak) return 'alice';
    if (f === bk) return 'bob';
    return 'alice';
  }
  return null;
}

function resolveIngestSpeaker(inbox: AgentSide, fromRaw: string, parsed: { agent?: AgentSide }): AgentSide | null {
  return (
    speakerSideFromPubkey(fromRaw) ??
    (parsed.agent === 'alice' || parsed.agent === 'bob' ? parsed.agent : null) ??
    inferSpeakerTwoParty(inbox, fromRaw)
  );
}

function envelope(text: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ v: 1, text, ...(extra ?? {}) });
}

function bodyOriginIsHuman(parsed: Record<string, unknown>): boolean {
  return parsed.origin === 'human' || parsed.human === true;
}

/** Outbound payloads carry `sid`; peer `/recv` mirrors the same envelope — suppress duplicate bubbles. */
const pendingAxlMirrorSids = new Set<string>();

function registerPendingAxlMirrorSid(sid: string): void {
  pendingAxlMirrorSids.add(sid);
}

function consumeMirrorSidIfTracked(sid: string): boolean {
  if (!sid || !pendingAxlMirrorSids.has(sid)) return false;
  pendingAxlMirrorSids.delete(sid);
  return true;
}

function newAxlEnvelopeSid(): string {
  return crypto.randomUUID();
}

function parseEnvelopeSid(parsed: Record<string, unknown>): string {
  const sid = parsed.sid;
  return typeof sid === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sid)
    ? sid
    : '';
}

function normalizeDedupeText(text: string): string {
  return text.trim().replace(/\r\n/g, '\n');
}

const ECHO_FALLBACK_WINDOW_MS = 180_000;

/** Fallback when peers send JSON without sid (manual curl etc.). */
function isInboundLikelyOutboundEcho(fromKeyNorm: string, bodyText: string): boolean {
  const t = normalizeDedupeText(bodyText);
  if (!t) return false;
  const now = Date.now();
  const msgs = listMessages();
  for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 160); i--) {
    const m = msgs[i]!;
    if (m.channel !== 'conversation' || m.direction !== 'out' || m.source !== 'axl') continue;
    if (normalizePeerKey(m.fromKey) !== fromKeyNorm) continue;
    const outText =
      typeof (m.payload as { text?: string }).text === 'string'
        ? (m.payload as { text: string }).text
        : m.rawPreview;
    if (normalizeDedupeText(outText) !== t) continue;
    if (now - m.at > ECHO_FALLBACK_WINDOW_MS) continue;
    return true;
  }
  return false;
}

const handledAutoRelayIds = new Set<string>();

async function transcriptForRelay(): Promise<string> {
  return (
    listMessages()
      .filter((m) => m.channel === 'conversation' || m.channel === 'system')
      .slice(-24)
      .map((m) => {
        const speaker = (m.payload as { speaker?: string }).speaker ?? 'system';
        const text =
          typeof (m.payload as { text?: string })?.text === 'string'
            ? (m.payload as { text: string }).text
            : m.rawPreview;
        return `- ${speaker}: ${text}`;
      })
      .join('\n') || '(none yet)'
  );
}

async function composeAutoRelayAnswer(responder: AgentSide, cueLine: string): Promise<
  | { ok: true; text: string; inferenceVia?: 'router' | 'broker' }
  | { ok: false; error: string }
> {
  const peer: AgentSide = responder === 'alice' ? 'bob' : 'alice';
  const selfName = responder === 'alice' ? 'Alice' : 'Bob';
  const peerName = peer === 'alice' ? 'Alice' : 'Bob';

  const inferenceLine = routerChatConfigured()
    ? `Completions use the OpenAI-compatible router (${routerModelDisplay()}). `
    : isValidAgentPrivateKey(responder)
      ? `Completions use the 0G serving-broker workflow. `
      : '';

  const system =
    `${selfName} is chatting with ${peerName} over the Agent Exchange Layer (AXL). ${inferenceLine}` +
    `Reply concisely. NEVER output SWAP_JSON, transaction payloads, EIP-712, hex calldata, or on-chain intents—plaintext only.`;

  const prior = await transcriptForRelay();

  const rg = await runZeroGChat(responder, [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `${cueLine}\n\nRecent transcript:\n${prior}`,
    },
  ]);

  if (!rg.ok) {
    return { ok: false, error: rg.error };
  }

  return { ok: true, text: rg.answer.trim(), inferenceVia: rg.via };
}

type AutoRelayJob = {
  dedupeRelayId: string;
  responder: AgentSide;
  cueLine: string;
};

async function runAutoRelayJobs(jobs: AutoRelayJob[]): Promise<void> {
  if (!AXL_AUTO_REPLY || DEMO || !jobs.length) return;

  for (const job of jobs) {
    if (handledAutoRelayIds.has(job.dedupeRelayId)) continue;

    const respName = job.responder === 'alice' ? 'Alice' : 'Bob';
    const composed = await composeAutoRelayAnswer(job.responder, job.cueLine);
    if (!composed.ok) {
      appendMessage({
        channel: 'system',
        direction: 'out',
        fromKey: 'system',
        toKey: 'ui',
        payload: {
          speaker: 'system',
          text: `Auto-relay (0G) failed as ${respName}: ${composed.error}`,
        },
        rawPreview: composed.error.slice(0, 4000),
        source: 'system',
      });

      handledAutoRelayIds.add(job.dedupeRelayId);
      continue;
    }

    const peerSide: AgentSide = job.responder === 'alice' ? 'bob' : 'alice';
    await refreshKeysFromTopology();
    const selfKey = keyFor(job.responder);
    const destKey = keyFor(peerSide);

    const replyText =
      composed.text.replace(/\bSWAP_JSON\s*:.*$/gim, '').trim() ||
      '[empty model reply after stripping intents]';

    const replySid = newAxlEnvelopeSid();
    registerPendingAxlMirrorSid(replySid);

    try {
      await axl.send({
        fromApiBase: apiFor(job.responder),
        destPeerId: destKey,
        body: envelope(replyText, { agent: job.responder, origin: 'auto', sid: replySid }),
      });

      appendMessage({
        channel: 'conversation',
        direction: 'out',
        fromKey: selfKey,
        toKey: destKey,
        payload: { speaker: job.responder, text: replyText, sid: replySid },
        rawPreview: replyText.slice(0, 2000),
        source: 'axl',
      });

      handledAutoRelayIds.add(job.dedupeRelayId);
    } catch (e) {
      pendingAxlMirrorSids.delete(replySid);
      const msg = e instanceof Error ? e.message : String(e);
      appendMessage({
        channel: 'system',
        direction: 'out',
        fromKey: 'system',
        toKey: 'ui',
        payload: {
          speaker: 'system',
          text: `auto-relay AXL send failed (${job.responder}→${peerSide}): ${msg}`,
        },
        rawPreview: msg,
        source: 'system',
      });

      handledAutoRelayIds.add(job.dedupeRelayId);
    }
  }
}

let autoRelayDrain: Promise<void> = Promise.resolve();

function enqueueAutoRelay(jobs: AutoRelayJob[]): void {
  if (!jobs.length || !AXL_AUTO_REPLY || DEMO) return;

  autoRelayDrain = autoRelayDrain
    .then(() => runAutoRelayJobs(jobs))
    .catch((err) => {
      console.error('[axl-auto-relay]', err);
    });
}

function peek(hex: string): string {
  if (hex.startsWith('demo-')) return hex;
  if (hex.length <= 16) return hex;
  return `${hex.slice(0, 10)}…${hex.slice(-6)}`;
}

app.get('/api/health', (_req, res) => {
  void res.json({ ok: true, demo: DEMO });
});

app.get('/api/debug/inference', (_req, res) => {
  void res.json(inferenceRoutingDebug());
});

app.get('/api/config', async (_req, res) => {
  await refreshKeysFromTopology();
  void res.json({
    demo: DEMO,
    aliceApi: ALICE_API,
    bobApi: BOB_API,
    alicePeerKeyPreview: peek(keyFor('alice')),
    bobPeerKeyPreview: peek(keyFor('bob')),
    alicePrivateKey: isValidAgentPrivateKey('alice'),
    bobPrivateKey: isValidAgentPrivateKey('bob'),
    zeroGRouter: routerChatConfigured(),
    routerChatModel: routerChatConfigured() ? routerModelDisplay() : null,
    aliceZeroG:
      routerChatConfigured() ||
      (isValidAgentPrivateKey('alice') && Boolean(agentZeroGProviderAddress('alice'))),
    bobZeroG:
      routerChatConfigured() ||
      (isValidAgentPrivateKey('bob') && Boolean(agentZeroGProviderAddress('bob'))),
    uniswapTradingApi: Boolean(process.env.UNISWAP_API_KEY),
    axlAutoReply: !DEMO && AXL_AUTO_REPLY,
    chains: ['Base Sepolia 84532'],
  });
});

app.get('/api/messages', (_req, res) => {
  void res.json({ messages: listMessages() });
});

app.post('/api/axl/ingest', async (_req, res) => {
  if (DEMO) {
    void res.json({ ingested: 0, skipped: true, reason: 'DEMO_MODE' });
    return;
  }

  await refreshKeysFromTopology();
  let n = 0;
  const autoRelayJobs: AutoRelayJob[] = [];

  async function drain(base: AgentSide): Promise<void> {
    const api = apiFor(base);
    const selfKey = keyFor(base);
    for (let i = 0; i < 40; i++) {
      const m = await axl.recv(api);
      if (!m) break;
      const parsedBody = parseJsonSafe(m.body) as Record<string, unknown>;
      const parsedForSpeaker: { text?: string; agent?: AgentSide } = {
        text: typeof parsedBody.text === 'string' ? parsedBody.text : undefined,
        agent:
          parsedBody.agent === 'alice' || parsedBody.agent === 'bob'
            ? (parsedBody.agent as AgentSide)
            : undefined,
      };

      const speaker: AgentSide | null = resolveIngestSpeaker(base, m.from, parsedForSpeaker);
      const text =
        typeof parsedForSpeaker.text === 'string' ? parsedForSpeaker.text : String(m.body);

      const envSid = parseEnvelopeSid(parsedBody);
      const fromNorm = normalizePeerKey(m.from);
      const suppressMirror =
        consumeMirrorSidIfTracked(envSid) ||
        (!envSid && isInboundLikelyOutboundEcho(fromNorm, typeof text === 'string' ? text : String(text)));

      if (!suppressMirror) {
        appendMessage({
          channel: base === 'alice' ? 'relay_alice' : 'relay_bob',
          direction: 'in',
          fromKey: fromNorm,
          toKey: selfKey,
          payload: { ...parsedBody, speaker },
          rawPreview: m.body.slice(0, 2000),
          source: 'axl',
        });
        appendMessage({
          channel: 'conversation',
          direction: 'in',
          fromKey: fromNorm,
          toKey: selfKey,
          payload: speaker
            ? { speaker, text }
            : {
                speaker: 'peer' as const,
                text,
                fromKeyPreview: peek(fromNorm),
                deliveredToInbox: base,
              },
          rawPreview: text.slice(0, 2000),
          source: 'axl',
        });
      }

      const humanRelay = bodyOriginIsHuman(parsedBody);
      const textTrim = typeof text === 'string' ? text.trim() : '';
      if (humanRelay && AXL_AUTO_REPLY && textTrim.length > 0) {
        const snd =
          speaker === 'alice'
            ? 'Alice'
            : speaker === 'bob'
              ? 'Bob'
              : speaker === 'peer'
                ? 'Peer'
                : 'Peer';
        const respName = base === 'alice' ? 'Alice' : 'Bob';
        const cueLine =
          snd === 'Peer'
            ? `(Human AXL payload addressed to ${respName}.) Peer writes:\n"${textTrim.slice(0, 4000)}"`
            : `(Human AXL payload addressed to ${respName}.) ${snd} writes:\n"${textTrim.slice(0, 4000)}"`;

        autoRelayJobs.push({
          dedupeRelayId: crypto.randomUUID(),
          responder: base,
          cueLine,
        });
      }
      n++;
    }
  }

  try {
    await drain('alice');
    await drain('bob');
    enqueueAutoRelay(autoRelayJobs);
    void res.json({ ingested: n });
  } catch (e) {
    void res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }


});

/** Deliver plaintext only over AXL; tags `origin: human` so the peer auto-relays through 0G. */
app.post('/api/axl/send', async (req, res) => {
  if (DEMO) {
    void res.status(400).json({ ok: false, error: 'DEMO_MODE blocks real send; unset DEMO_MODE' });
    return;
  }

  const agent = req.body?.agent as AgentSide | undefined;
  if (agent !== 'alice' && agent !== 'bob') {
    void res.status(400).json({ ok: false, error: 'agent must be alice or bob' });
    return;
  }

  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    void res.status(400).json({ ok: false, error: 'missing text' });
    return;
  }

  let outboundSid: string | undefined;
  try {
    await refreshKeysFromTopology();
    const peer: AgentSide = agent === 'alice' ? 'bob' : 'alice';
    const selfKey = keyFor(agent);
    const destKey = keyFor(peer);

    outboundSid = newAxlEnvelopeSid();
    registerPendingAxlMirrorSid(outboundSid);

    await axl.send({
      fromApiBase: apiFor(agent),
      destPeerId: destKey,
      body: envelope(text, { agent, origin: 'human', sid: outboundSid }),
    });

    appendMessage({
      channel: 'conversation',
      direction: 'out',
      fromKey: selfKey,
      toKey: destKey,
      payload: { speaker: agent, text, sid: outboundSid },
      rawPreview: text.slice(0, 2000),
      source: 'axl',
    });

    void res.json({ ok: true });
  } catch (e) {
    if (outboundSid) pendingAxlMirrorSids.delete(outboundSid);
    void res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

app.post('/api/uniswap/quote', async (req, res) => {
  const result = await uniswapQuote((req.body ?? {}) as Record<string, unknown>);
  if (!result.ok) {
    void res.status(result.error.startsWith('UNISWAP') ? 503 : 400).json(result);
    return;
  }
  void res.json(result.quote);
});

app.post('/api/demo/ping', (_req, res) => {
  const aKey = syntheticKey('alice');
  const bKey = syntheticKey('bob');

  appendMessage({
    channel: 'conversation',
    direction: 'out',
    fromKey: aKey,
    toKey: bKey,
    payload: { speaker: 'alice' as const, text: 'Hello from Alice (demo).' },
    rawPreview: 'Hello from Alice (demo).',
    source: 'demo',
  });

  void res.json({ ok: true });
});

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { text: raw };
  }
}

async function composeAgentReply(
  agent: AgentSide,
  userCue: string,
): Promise<{ text: string; zeroGOk: boolean; inferenceVia?: 'router' | 'broker' }> {
  const peer: AgentSide = agent === 'alice' ? 'bob' : 'alice';
  const selfName = agent === 'alice' ? 'Alice' : 'Bob';
  const peerName = peer === 'alice' ? 'Alice' : 'Bob';

  const prior = listMessages()
    .filter((m) => m.channel === 'conversation' || m.channel === 'system')
    .slice(-24)
    .map((m) => {
      const speaker = (m.payload as { speaker?: string }).speaker ?? 'system';
      const text =
        typeof (m.payload as { text?: string })?.text === 'string'
          ? (m.payload as { text: string }).text
          : m.rawPreview;
      return `- ${speaker}: ${text}`;
    })
    .join('\n');

  const system =
    `${selfName} is ${agent}'s autonomous testnet trader (distinct credentials from ${peerName}). ` +
    (routerChatConfigured()
      ? `LLM completions use your OpenAI-compatible router (API-key model ${routerModelDisplay()}). `
      : `LLM completions use 0G serving-broker (wallet + provider) with on-chain settlement. `) +
    `You message over Agent Exchange Layer (AXL — repo axl/). ` +
    `Swaps are disabled. Only generate Uniswap quotes on Base Sepolia (chainId 84532) via the Uniswap Trading API quote endpoint. ` +
    `When you want a quote, end your reply with ONE line containing ` +
    `QUOTE_JSON: followed by a single-line JSON object (no fences) like ` +
    `{"tokenIn":"0x...","tokenOut":"0x...","amount":"100000000000000000"} ` +
    `where amount is wei as a quoted integer string. Optional fields: slippageTolerance (number %), routingPreference (e.g. BEST_PRICE). ` +
    `Never output QUOTE_JSON unless you want the server to fetch a quote now.`;

  const userBlock =
    `${userCue || 'Discuss testnet liquidity or respond to thread concisely.'}\n\nRecent transcript:\n${prior || '(none yet)'}`;

  const rg = await runZeroGChat(agent, [
    { role: 'system', content: system },
    { role: 'user', content: userBlock },
  ]);

  if (!rg.ok) {
    const fallback =
      `[${selfName}] 0G offline (${rg.error}). Tell ${peerName} you cannot reach compute; suggest they retry.`;

    appendMessage({
      channel: 'system',
      direction: 'out',
      fromKey: 'system',
      toKey: 'ui',
      payload: { speaker: 'system', text: rg.error },
      rawPreview: rg.error.slice(0, 4000),
      source: 'system',
    });

    return { text: fallback, zeroGOk: false };
  }

  return { text: rg.answer, zeroGOk: true, inferenceVia: rg.via };
}

function quoteSwapperAddress(agent: AgentSide): `0x${string}` {
  const pk = agentPrivateKeyHex(agent);
  if (!pk || !/^0x[a-fA-F0-9]{64}$/.test(pk)) {
    throw new Error(
      `${agent}: set ${agent === 'alice' ? 'ALICE_PRIVATE_KEY' : 'BOB_PRIVATE_KEY'} (0x + 64 hex) so we can provide a swapper address for quoting`,
    );
  }
  return privateKeyToAccount(pk as `0x${string}`).address;
}

const ETH_ADDR = '0x0000000000000000000000000000000000000000' as const;
type TokenMeta = { address: `0x${string}`; symbol: string; decimals: number };

const tokenMetaCache = new Map<string, Promise<TokenMeta>>();

const erc20MetaAbi = [
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

function baseSepoliaRpcUrl(): string {
  return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
}

async function tokenMetaBaseSepolia(addr: string): Promise<TokenMeta> {
  const norm = String(addr || '').trim();
  if (!isAddress(norm)) throw new Error(`invalid token address: ${norm}`);
  const key = norm.toLowerCase();
  if (key === ETH_ADDR.toLowerCase()) {
    return { address: ETH_ADDR, symbol: 'ETH', decimals: 18 };
  }

  let p = tokenMetaCache.get(key);
  if (!p) {
    p = (async () => {
      const client = createPublicClient({
        chain: baseSepolia,
        transport: http(baseSepoliaRpcUrl()),
      });

      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: norm as `0x${string}`, abi: erc20MetaAbi, functionName: 'symbol' }),
        client.readContract({ address: norm as `0x${string}`, abi: erc20MetaAbi, functionName: 'decimals' }),
      ]);

      const sym = typeof symbol === 'string' && symbol.trim().length ? symbol.trim() : `${norm.slice(0, 6)}…`;
      const dec = typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : Number(decimals);
      return { address: norm as `0x${string}`, symbol: sym, decimals: Number.isFinite(dec) ? dec : 18 };
    })();
    tokenMetaCache.set(key, p);
  }
  return p;
}

function parseBigintLoose(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return null;
    if (/^[0-9]+$/.test(t)) return BigInt(t);
    if (/^0x[0-9a-f]+$/i.test(t)) return BigInt(t);
  }
  return null;
}

function formatAmt(raw: bigint, decimals: number, maxFracDigits = 6): string {
  const s = formatUnits(raw, decimals);
  const [i, f = ''] = s.split('.');
  const frac = f.replace(/0+$/, '').slice(0, maxFracDigits);
  return frac.length ? `${i}.${frac}` : i;
}

function formatQuoteSummary(q: Record<string, unknown>): string {
  const parts: string[] = [];
  const routing = typeof q.routing === 'string' ? q.routing : undefined;
  const amountOut = typeof q.amountOut === 'string' ? q.amountOut : undefined;
  const quote = typeof q.quote === 'string' ? q.quote : undefined;
  const gas = typeof q.estimatedGasUsed === 'string' ? q.estimatedGasUsed : undefined;
  if (routing) parts.push(`routing=${routing}`);
  if (amountOut) parts.push(`amountOut=${amountOut}`);
  if (quote) parts.push(`quote=${quote}`);
  if (gas) parts.push(`estimatedGasUsed=${gas}`);
  if (parts.length) return parts.join(' · ');

  // Fallback: keep it compact.
  const compact: Record<string, unknown> = {};
  for (const k of ['routing', 'amountOut', 'quote', 'methodParameters', 'gasUseEstimate', 'trade'] as const) {
    if (k in q) compact[k] = q[k];
  }
  const out = Object.keys(compact).length ? compact : q;
  return JSON.stringify(out).slice(0, 900);
}

async function formatQuotePretty(intent: { tokenIn: string; tokenOut: string; amount: string }, q: Record<string, unknown>) {
  const amountOutRaw =
    parseBigintLoose(q.amountOut) ??
    parseBigintLoose(q.quote) ??
    parseBigintLoose((q as { outputAmount?: unknown }).outputAmount) ??
    null;

  const gasRaw =
    parseBigintLoose(q.estimatedGasUsed) ??
    parseBigintLoose((q as { gasUseEstimate?: unknown }).gasUseEstimate) ??
    parseBigintLoose((q as { gasEstimate?: unknown }).gasEstimate) ??
    null;

  const [tin, tout] = await Promise.all([tokenMetaBaseSepolia(intent.tokenIn), tokenMetaBaseSepolia(intent.tokenOut)]);
  const amountInBig = parseBigintLoose(intent.amount) ?? BigInt(0);
  const amountIn = `${formatAmt(amountInBig, tin.decimals)} ${tin.symbol}`;
  const amountOut = amountOutRaw ? `${formatAmt(amountOutRaw, tout.decimals)} ${tout.symbol}` : null;

  const routing = typeof q.routing === 'string' && q.routing.trim().length ? q.routing.trim() : null;

  const metaParts: string[] = [];
  if (routing) metaParts.push(`routing ${routing}`);
  if (gasRaw) metaParts.push(`est gas ${gasRaw.toString()}`);

  if (amountOut) {
    return `${amountIn} → ${amountOut}${metaParts.length ? ` · ${metaParts.join(' · ')}` : ''}`;
  }
  return `${amountIn} → (see raw quote)${metaParts.length ? ` · ${metaParts.join(' · ')}` : ''}`;
}

app.post('/api/agent/reply', async (req, res) => {
  const agent = req.body?.agent as AgentSide;
  if (agent !== 'alice' && agent !== 'bob') {
    void res.status(400).json({ ok: false, error: 'agent must be alice|bob' });
    return;
  }

  const cue = typeof req.body?.cue === 'string' ? req.body.cue : '';
  await refreshKeysFromTopology();

  const peer: AgentSide = agent === 'alice' ? 'bob' : 'alice';
  const selfKey = keyFor(agent);
  const destKey = keyFor(peer);

  let outboundSid: string | undefined;
  try {
    const composed = await composeAgentReply(agent, cue);

    const quotePayload = extractQuoteIntent(composed.text);
    const publicText = quotePayload?.displayText ?? composed.text.trim();

    if (!DEMO) {
      outboundSid = newAxlEnvelopeSid();
      registerPendingAxlMirrorSid(outboundSid);
      await axl.send({
        fromApiBase: apiFor(agent),
        destPeerId: destKey,
        body: envelope(publicText, { agent, origin: 'human', sid: outboundSid }),
      });
    }

    appendMessage({
      channel: 'conversation',
      direction: 'out',
      fromKey: selfKey,
      toKey: destKey,
      payload:
        DEMO || !outboundSid
          ? { speaker: agent, text: publicText }
          : { speaker: agent, text: publicText, sid: outboundSid },
      rawPreview: publicText.slice(0, 2000),
      source: DEMO ? 'demo' : 'axl',
    });

    let quoteFetched: Record<string, unknown> | undefined;
    let quoteError: string | undefined;

    if (quotePayload && process.env.UNISWAP_API_KEY) {
      try {
        const swapper = quoteSwapperAddress(agent);
        const quoteBody: Record<string, unknown> = {
          swapper,
          tokenIn: quotePayload.intent.tokenIn,
          tokenOut: quotePayload.intent.tokenOut,
          tokenInChainId: '84532',
          tokenOutChainId: '84532',
          amount: quotePayload.intent.amount,
          type: 'EXACT_INPUT',
          slippageTolerance: quotePayload.intent.slippageTolerance ?? 1,
          routingPreference: quotePayload.intent.routingPreference ?? 'BEST_PRICE',
        };

        const q = await uniswapQuote(quoteBody);
        if (!q.ok) throw new Error(q.error);
        quoteFetched = q.quote as Record<string, unknown>;

        const pretty = await formatQuotePretty(
          { tokenIn: quotePayload.intent.tokenIn, tokenOut: quotePayload.intent.tokenOut, amount: quotePayload.intent.amount },
          quoteFetched,
        );

        appendMessage({
          channel: 'conversation',
          direction: 'out',
          fromKey: selfKey,
          toKey: destKey,
          payload: {
            speaker: agent,
            text: `Quote (Base Sepolia): ${pretty}`,
          },
          rawPreview: 'quote-fetched',
          source: DEMO ? 'demo' : 'axl',
        });
      } catch (e) {
        quoteError = e instanceof Error ? e.message : String(e);
        appendMessage({
          channel: 'system',
          direction: 'out',
          fromKey: 'system',
          toKey: 'ui',
          payload: { speaker: 'system', text: `Quote failed (${agent}): ${quoteError}` },
          rawPreview: quoteError.slice(0, 2000),
          source: 'system',
        });
      }
    } else if (quotePayload && !process.env.UNISWAP_API_KEY) {
      quoteError = 'UNISWAP_API_KEY missing — cannot fetch QUOTE_JSON';
      appendMessage({
        channel: 'system',
        direction: 'out',
        fromKey: 'system',
        toKey: 'ui',
        payload: { speaker: 'system', text: quoteError },
        rawPreview: quoteError,
        source: 'system',
      });
    }

    void res.json({
      ok: true,
      text: composed.text,
      publicText,
      zeroG: composed.zeroGOk,
      inferenceVia: composed.inferenceVia,
      quoteFetched,
      quoteError,
    });
  } catch (e) {
    if (outboundSid) pendingAxlMirrorSids.delete(outboundSid);
    void res.status(500).json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`agent-trade-platform api http://127.0.0.1:${PORT} (demo=${DEMO})`);
});
