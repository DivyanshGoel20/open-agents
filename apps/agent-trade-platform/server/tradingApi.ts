const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';

async function tradingRaw(path: `/check_approval` | `/quote` | `/swap`, body: unknown): Promise<Response> {
  const key = process.env.UNISWAP_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ detail: 'UNISWAP_API_KEY not set' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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
  if (!res.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data);
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
