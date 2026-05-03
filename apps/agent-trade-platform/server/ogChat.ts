import { ethers } from 'ethers';
import OpenAI from 'openai';
import { createRequire } from 'node:module';
import { agentPrivateKeyHex, agentZeroGProviderAddress } from './agentKeys.js';

const RPC_DEFAULT_TESTNET = 'https://evmrpc-testnet.0g.ai';

/** Narrow surface we use — avoids `typeof import('@0glabs/…')` so tsx never pre-resolves the broken ESM build. */
type InferenceBroker = {
  getServiceMetadata: (provider: string) => Promise<{ endpoint: string; model: string }>;
  getRequestHeaders: (provider: string) => Promise<Record<string, string>>;
  processResponse: (provider: string, chatId: string, usageJson: string) => Promise<unknown>;
};

type BrokerSdk = {
  createZGComputeNetworkBroker: (wallet: ethers.Wallet) => Promise<{ inference: InferenceBroker }>;
};

/** Load broker via CommonJS so Node uses `exports.require` (Node 24+ safe). */
let cachedBrokerSdk: BrokerSdk | null = null;

function getBrokerModule(): BrokerSdk {
  if (!cachedBrokerSdk) {
    const req = createRequire(import.meta.url);
    cachedBrokerSdk = req('@0glabs/0g-serving-broker') as BrokerSdk;
  }
  return cachedBrokerSdk;
}

/** OpenAI-compatible 0G / Integrate testnet router (API key billing; no broker `processResponse`). */
const DEFAULT_ROUTER_MODEL = 'qwen/qwen-2.5-7b-instruct';

function trimmedEnv(v: string | undefined): string | undefined {
  const t = typeof v === 'string' ? v.trim() : '';
  return t.length ? t : undefined;
}

/** Model id shipped to router `chat/completions` (defaults to Integrate-hosted Qwen). */
export function routerModelDisplay(): string {
  return (
    trimmedEnv(process.env.ZERO_G_ROUTER_MODEL) ||
    trimmedEnv(process.env.ZERO_G_CHAT_MODEL) ||
    DEFAULT_ROUTER_MODEL
  );
}

export function routerChatConfigured(): boolean {
  const apiKey =
    trimmedEnv(process.env['0G_API_KEY']) ||
    trimmedEnv(process.env.ZERO_G_ROUTER_API_KEY);
  const baseURL =
    trimmedEnv(process.env.ZERO_G_ROUTER_BASE_URL) ||
    trimmedEnv(process.env['0G_ROUTER_BASE_URL']);
  return Boolean(apiKey && baseURL);
}

function rpcUrl(): string {
  return process.env.ZERO_G_RPC_URL || process.env.RPC_URL || RPC_DEFAULT_TESTNET;
}

/** OpenAI client posts to `{baseURL}/chat/completions`. Base must include `/v1` (omit only if hostname root serves that route). */
function normalizeOpenAiRouterBase(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  try {
    const u = new URL(s);
    if (/\/v1$/i.test(u.pathname)) {
      return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
    }
    const path = u.pathname === '/' ? '/v1' : `${u.pathname.replace(/\/+$/, '')}/v1`;
    u.pathname = path.replace(/\/{2,}/g, '/');
    return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  } catch {
    /* relative or odd string — fallback */
    return /\/v1$/i.test(s) ? s : `${s}/v1`;
  }
}

/** Build candidate OpenAI roots; Integrate Network commonly serves …/openapi/v1 while bare …/v1 404s. */
export function routerBaseCandidates(rawEnv: string | undefined): string[] {
  const raw = trimmedEnv(rawEnv);
  if (!raw) return [];

  const normalized = normalizeOpenAiRouterBase(raw);
  const out: string[] = [];

  try {
    const u = new URL(normalized);
    const host = u.hostname.toLowerCase();
    const path = u.pathname.replace(/\/+$/, '') || '/';

    const openApiRoot = `${u.origin}/openapi/v1`.replace(/\/+$/, '');
    const slashV1Root = `${u.origin}/v1`.replace(/\/+$/, '');

    const push = (s: string) => {
      const t = s.replace(/\/+$/, '');
      if (!out.includes(t)) out.push(t);
    };

    /* Only remap bare /v1 on Integrate-style hosts — custom …/foo/v1 stays as-is. */
    if (host.includes('integratenetwork') && path === '/v1') {
      push(openApiRoot);
      push(slashV1Root);
      return out;
    }

    push(normalized);
    if (host.includes('integratenetwork') && path !== '/openapi/v1' && openApiRoot !== normalized) {
      push(openApiRoot);
    }
    return out;
  } catch {
    return [normalized];
  }
}

/** Non-secret diagnostics for configuring router URLs. */
export function inferenceRoutingDebug(): {
  routerConfigured: boolean;
  forceRouter: boolean;
  forceBroker: boolean;
  willUse: 'router' | 'broker' | 'unset';
  model: string;
  envZERO_G_ROUTER_BASE_URL_raw: string | null;
  candidateRouterBases: string[];
  completionsUrls: string[];
} {
  const forceBroker = trimmedEnv(process.env.ZERO_G_CHAT_BACKEND)?.toLowerCase() === 'broker';
  const forceRouter = trimmedEnv(process.env.ZERO_G_CHAT_BACKEND)?.toLowerCase() === 'router';
  const rc = routerChatConfigured();
  const raw =
    trimmedEnv(process.env.ZERO_G_ROUTER_BASE_URL) || trimmedEnv(process.env['0G_ROUTER_BASE_URL']) || '';

  let willUse: 'router' | 'broker' | 'unset' = 'unset';
  if (forceBroker) willUse = 'broker';
  else if (forceRouter) willUse = rc ? 'router' : 'unset';
  else if (rc) willUse = 'router';
  else willUse = 'broker';

  const bases = routerBaseCandidates(raw || undefined);

  return {
    routerConfigured: rc,
    forceRouter,
    forceBroker,
    willUse,
    model: routerModelDisplay(),
    envZERO_G_ROUTER_BASE_URL_raw: raw.length ? raw : null,
    candidateRouterBases: bases,
    completionsUrls: bases.map((b) => `${b}/chat/completions`),
  };
}

async function chatViaRouter(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const apiKey =
    trimmedEnv(process.env['0G_API_KEY']) ||
    trimmedEnv(process.env.ZERO_G_ROUTER_API_KEY);
  const baseURLRaw =
    trimmedEnv(process.env.ZERO_G_ROUTER_BASE_URL) ||
    trimmedEnv(process.env['0G_ROUTER_BASE_URL']);
  if (!apiKey) {
    return { ok: false, error: 'Router mode: missing 0G_API_KEY (or ZERO_G_ROUTER_API_KEY)' };
  }
  if (!baseURLRaw) {
    return {
      ok: false,
      error:
        'Router mode: set ZERO_G_ROUTER_BASE_URL to your OpenAI-compat root (Integrate-hosted routers commonly need …/openapi/v1).',
    };
  }

  const variants = routerBaseCandidates(baseURLRaw);
  const model = routerModelDisplay();

  let lastErr = '';
  for (let i = 0; i < variants.length; i++) {
    const baseURL = variants[i]!;
    const client = new OpenAI({ apiKey, baseURL });
    try {
      const completion = await client.chat.completions.create({
        model,
        messages,
        stream: false,
      });
      const answer = completion.choices[0]?.message?.content ?? '';
      return { ok: true, answer };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;

      const is404 = /\b404\b/i.test(msg);
      const triesLeft = i < variants.length - 1;
      if (!is404 || !triesLeft) {
        const tried = variants.map((b) => `${b}/chat/completions`).join(' | ');
        const normalizedHint =
          baseURLRaw !== variants[0]
            ? `Env "${baseURLRaw}" expands to normalized/alternate bases (see GET /api/debug/inference). `
            : '';

        let hint = `Attempted completions URL(s): ${tried}. Last error (${baseURL}/chat/completions): ${lastErr}.`;

        if (is404) {
          hint +=
            ' HTTP 404: wrong OpenAI-compat path — copy the documented OpenAI `/v1` root from Integrate exactly (often …/openapi/v1).';
        }

        return {
          ok: false,
          error: normalizedHint + hint,
        };
      }
    }
  }

  return { ok: false, error: lastErr || 'router: unknown failure' };
}

async function chatViaServingBroker(
  agent: 'alice' | 'bob',
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ ok: true; answer: string } | { ok: false; error: string }> {
  const pk = agentPrivateKeyHex(agent);
  const providerAddress = agentZeroGProviderAddress(agent);

  if (!pk || !providerAddress) {
    return {
      ok: false,
      error: `Serving-broker inference disabled for ${agent}: set ALICE_PROVIDER_ADDRESS / BOB_PROVIDER_ADDRESS and ALICE_PRIVATE_KEY / BOB_PRIVATE_KEY (fallback: PRIVATE_KEY + PROVIDER_ADDRESS), or configure 0G_API_KEY + ZERO_G_ROUTER_BASE_URL for router mode. See .0g-compute-skills/SKILL.md.`,
    };
  }

  const wallet = new ethers.Wallet(pk, new ethers.JsonRpcProvider(rpcUrl()));
  const { createZGComputeNetworkBroker } = getBrokerModule();
  const broker = await createZGComputeNetworkBroker(wallet);

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  const headers = await broker.inference.getRequestHeaders(providerAddress);

  const ep = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const response = await fetch(ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ messages, model }),
  });

  const rawBody = await response.text();
  let data: {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: unknown;
    id?: string;
    detail?: string;
  };
  try {
    data = JSON.parse(rawBody) as typeof data;
  } catch {
    data = {};
  }

  if (!response.ok) {
    const snippet = rawBody.replace(/\s+/g, ' ').slice(0, 280);
    const detail =
      typeof data.detail === 'string'
        ? data.detail
        : snippet || `(empty body)`;
    return {
      ok: false,
      error: `[broker POST ${response.status}] ${detail} — endpoint=${ep}`,
    };
  }

  const answer = data.choices?.[0]?.message?.content ?? '';

  let chatID = response.headers.get('ZG-Res-Key') || response.headers.get('zg-res-key');
  if (!chatID && data.id) chatID = data.id;

  await broker.inference.processResponse(
    providerAddress,
    chatID ?? '',
    JSON.stringify(data.usage ?? {}),
  );

  return { ok: true, answer };
}

/**
 * Inference order:
 * 1. If `0G_API_KEY` + `ZERO_G_ROUTER_BASE_URL` are set → OpenAI-compatible router (your Qwen endpoint).
 * 2. Else → decentralized 0G serving broker wallet + provider + mandatory `processResponse`.
 */
export async function runZeroGChat(
  agent: 'alice' | 'bob',
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
): Promise<{ ok: true; answer: string; via: 'router' | 'broker' } | { ok: false; error: string }> {
  const forceBroker = trimmedEnv(process.env.ZERO_G_CHAT_BACKEND)?.toLowerCase() === 'broker';
  const forceRouter = trimmedEnv(process.env.ZERO_G_CHAT_BACKEND)?.toLowerCase() === 'router';

  if (forceRouter || (!forceBroker && routerChatConfigured())) {
    const out = await chatViaRouter(messages);
    if (!out.ok) return out;
    return { ok: true, answer: out.answer, via: 'router' };
  }

  const out = await chatViaServingBroker(agent, messages);
  if (!out.ok) return out;
  return { ok: true, answer: out.answer, via: 'broker' };
}
