const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';

type UniswapTrace = {
  at: number;
  path: `/check_approval` | `/quote` | `/swap`;
  requestBody: unknown;
  httpStatus?: number;
  responseBody?: unknown;
  error?: string;
};

let lastUniswapTrace: UniswapTrace | null = null;

export function getLastUniswapTrace(): UniswapTrace | null {
  return lastUniswapTrace;
}

function shouldDebug(): boolean {
  return ['1', 'true', 'yes'].includes((process.env.DEBUG_UNISWAP ?? '').toLowerCase());
}

function safeLog(obj: unknown): void {
  if (!shouldDebug()) return;
  try {
    // Keep it single-line to be readable in concurrently logs.
    console.log('[uniswap]', JSON.stringify(obj));
  } catch {
    console.log('[uniswap]', obj);
  }
}

async function tradingRaw(path: `/check_approval` | `/quote` | `/swap`, body: unknown): Promise<Response> {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) {
    const respBody = { detail: 'UNISWAP_API_KEY not set' };
    lastUniswapTrace = {
      at: Date.now(),
      path,
      requestBody: body,
      httpStatus: 503,
      responseBody: respBody,
      error: respBody.detail,
    };
    safeLog({ event: 'error', path, status: 503, data: respBody });
    return new Response(JSON.stringify({ detail: 'UNISWAP_API_KEY not set' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  lastUniswapTrace = { at: Date.now(), path, requestBody: body };
  safeLog({ event: 'request', path, body });

  return fetch(`${UNISWAP_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'x-universal-router-version': '2.0',
    },
    body: JSON.stringify(body),
  });
}

export async function tradingPost(path: `/check_approval` | `/quote` | `/swap`, body: unknown): Promise<unknown> {
  const res = await tradingRaw(path, body);
  const data = (await res.json()) as Record<string, unknown>;
  lastUniswapTrace = {
    at: Date.now(),
    path,
    requestBody: body,
    httpStatus: res.status,
    responseBody: data,
  };
  safeLog({ event: 'response', path, status: res.status, data });
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data);
    lastUniswapTrace = {
      at: Date.now(),
      path,
      requestBody: body,
      httpStatus: res.status,
      responseBody: data,
      error: detail,
    };
    throw new Error(`${path}: ${detail}`);
  }
  return data;
}

/** Back-compat helper for callers that tolerate missing API keys. */
export async function uniswapQuote(body: Record<string, unknown>) {
  if (!process.env.UNISWAP_API_KEY) {
    return { ok: false as const, error: 'UNISWAP_API_KEY not set (Uniswap Trading API)' };
  }
  try {
    const quote = await tradingPost('/quote', body);
    return { ok: true as const, quote };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
