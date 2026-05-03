import { isAddress } from 'viem';

export type TokenSpec = {
  symbol: string;
  address: `0x${string}`; // use 0x000..0000 for native gas token
  decimals: number;
};

export type ChainTokenRegistry = Record<number, TokenSpec[]>;

const ETH_ADDR = '0x0000000000000000000000000000000000000000' as const;

/**
 * Minimal defaults so NL quoting works out of the box for ETH/WETH.
 * Extend via TOKEN_REGISTRY_JSON env var (see `loadTokenRegistry()`).
 */
const DEFAULT_REGISTRY: ChainTokenRegistry = {
  // Base (mainnet)
  8453: [
    { symbol: 'ETH', address: ETH_ADDR, decimals: 18 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  ],
  // Base Sepolia
  84532: [
    { symbol: 'ETH', address: ETH_ADDR, decimals: 18 },
    // OP-stack WETH9 is typically the 0x4200..0006 predeploy
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    { symbol: 'USDC', address: '0xAF33ADd7918F685B2A82C1077bd8c07d220FFA04', decimals: 6 },
  ],
  // Unichain Sepolia
  1301: [
    { symbol: 'ETH', address: ETH_ADDR, decimals: 18 },
    { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  ],
};

function parseTokenSpec(raw: unknown): TokenSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const symbol = typeof r.symbol === 'string' ? r.symbol.trim() : '';
  const address = typeof r.address === 'string' ? r.address.trim() : '';
  const decimalsRaw = r.decimals;
  const decimals =
    typeof decimalsRaw === 'number' && Number.isFinite(decimalsRaw)
      ? decimalsRaw
      : typeof decimalsRaw === 'string'
        ? Number(decimalsRaw)
        : NaN;
  if (!symbol) return null;
  if (!isAddress(address)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
  return { symbol, address: address as `0x${string}`, decimals };
}

function normalizeSymbol(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, '');
}

export function loadTokenRegistry(): ChainTokenRegistry {
  const env = process.env.TOKEN_REGISTRY_JSON;
  if (!env || !env.trim()) return DEFAULT_REGISTRY;
  try {
    const parsed = JSON.parse(env) as unknown;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_REGISTRY;
    const obj = parsed as Record<string, unknown>;
    const out: ChainTokenRegistry = {};
    for (const [k, v] of Object.entries(obj)) {
      const chainId = Number(k);
      if (!Number.isInteger(chainId) || chainId <= 0) continue;
      if (!Array.isArray(v)) continue;
      const specs = v.map(parseTokenSpec).filter(Boolean) as TokenSpec[];
      if (specs.length) out[chainId] = specs;
    }
    const merged: ChainTokenRegistry = { ...DEFAULT_REGISTRY, ...out };
    return merged;
  } catch {
    return DEFAULT_REGISTRY;
  }
}

export function resolveToken(
  registry: ChainTokenRegistry,
  chainId: number,
  tokenRef: string,
): { symbol: string; address: `0x${string}`; decimals: number } | null {
  const t = tokenRef.trim();
  if (!t) return null;

  // Address literal
  if (isAddress(t)) {
    // If it’s native sentinel, treat as ETH.
    if (t.toLowerCase() === ETH_ADDR.toLowerCase()) return { symbol: 'ETH', address: ETH_ADDR, decimals: 18 };
    // Otherwise, unknown decimals — caller must supply via registry or handle separately.
    // We return null here so the caller can error with a clear message.
    return null;
  }

  const sym = normalizeSymbol(t);
  const list = registry[chainId] ?? [];
  for (const spec of list) {
    if (normalizeSymbol(spec.symbol) === sym) return { symbol: spec.symbol, address: spec.address, decimals: spec.decimals };
  }
  return null;
}

