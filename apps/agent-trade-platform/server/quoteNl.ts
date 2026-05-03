import { isAddress, parseUnits } from 'viem';
import { loadTokenRegistry, resolveToken, type ChainTokenRegistry } from './tokenRegistry.js';

export type QuoteNlRequest = {
  text: string;
  chainId?: number;
  slippageTolerance?: number;
  routingPreference?: string;
  /**
   * Optional swapper address to pass through to Trading API.
   * If omitted, caller must fill it (or use a dummy for quote-only testing).
   */
  swapper?: `0x${string}`;
};

export type QuoteNlIntent = {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string; // raw integer units for tokenIn
  slippageTolerance?: number;
  routingPreference?: string;
  tokenInSymbol?: string;
  tokenOutSymbol?: string;
};

const DEFAULT_CHAIN_ID = 84532; // Base Sepolia

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function pickChainId(text: string, fallback: number): number {
  const t = text.toLowerCase();
  // Prefer explicit networks first.
  if (/\bunichain\b/.test(t)) return 1301;
  // Base: default to mainnet unless "sepolia" is mentioned.
  if (/\bbase\b/.test(t)) return /\bsepolia\b/.test(t) ? 84532 : 8453;
  if (/\b84532\b/.test(t)) return 84532;
  if (/\b8453\b/.test(t)) return 8453;
  if (/\b1301\b/.test(t)) return 1301;
  return fallback;
}

function parsePair(text: string): { amount: string; tokenIn: string; tokenOut: string } | null {
  const t = normalizeText(text);

  // Examples supported:
  // - "quote 0.01 ETH to WETH"
  // - "0.01 ETH -> WETH"
  // - "swap 1 weth for eth" (quote-only; we still parse)
  const reArrow =
    /(?:quote|swap)?\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z0-9]{2,12}|0x[a-fA-F0-9]{40})\s*(?:to|for|->|→)\s*([A-Za-z0-9]{2,12}|0x[a-fA-F0-9]{40})/i;
  const m1 = t.match(reArrow);
  if (m1) return { amount: m1[1]!, tokenIn: m1[2]!, tokenOut: m1[3]! };

  // - "1 ETH in USDC"
  // - "0.5 WETH into ETH"
  const reIn =
    /(?:quote|swap)?\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z0-9]{2,12}|0x[a-fA-F0-9]{40})\s*(?:in|into)\s*([A-Za-z0-9]{2,12}|0x[a-fA-F0-9]{40})/i;
  const m2 = t.match(reIn);
  if (m2) return { amount: m2[1]!, tokenIn: m2[2]!, tokenOut: m2[3]! };

  return null;
}

function parseSlippage(text: string): number | undefined {
  const t = text.toLowerCase();
  const m = t.match(/\bslippage\s*([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return undefined;
  return n;
}

export function buildQuoteFromNaturalLanguage(
  req: QuoteNlRequest,
  registryOverride?: ChainTokenRegistry,
): { ok: true; intent: QuoteNlIntent; tradingApiBody: Record<string, unknown> } | { ok: false; error: string } {
  const text = normalizeText(req.text || '');
  if (!text) return { ok: false, error: 'Missing text' };

  const chainId = pickChainId(text, Number.isInteger(req.chainId) ? (req.chainId as number) : DEFAULT_CHAIN_ID);
  if (chainId !== 8453 && chainId !== 84532 && chainId !== 1301) {
    return {
      ok: false,
      error: `Unsupported chainId ${chainId}. Allowed: 8453 (Base), 84532 (Base Sepolia), 1301 (Unichain Sepolia).`,
    };
  }

  const pair = parsePair(text);
  if (!pair) {
    return {
      ok: false,
      error: 'Could not parse request. Try: "quote 0.01 ETH to WETH on Base Sepolia" or "quote 10 USDC to ETH on Unichain Sepolia".',
    };
  }

  const registry = registryOverride ?? loadTokenRegistry();
  const tokenInSpec = resolveToken(registry, chainId, pair.tokenIn);
  const tokenOutSpec = resolveToken(registry, chainId, pair.tokenOut);
  if (!tokenInSpec) {
    const isAddr = isAddress(pair.tokenIn);
    return {
      ok: false,
      error: isAddr
        ? `TokenIn address ${pair.tokenIn} is not in TOKEN_REGISTRY_JSON (need decimals). Add it to the registry for chainId ${chainId}.`
        : `Unknown tokenIn symbol "${pair.tokenIn}" for chainId ${chainId}. Add it to TOKEN_REGISTRY_JSON.`,
    };
  }
  if (!tokenOutSpec) {
    const isAddr = isAddress(pair.tokenOut);
    return {
      ok: false,
      error: isAddr
        ? `TokenOut address ${pair.tokenOut} is not in TOKEN_REGISTRY_JSON (need decimals). Add it to the registry for chainId ${chainId}.`
        : `Unknown tokenOut symbol "${pair.tokenOut}" for chainId ${chainId}. Add it to TOKEN_REGISTRY_JSON.`,
    };
  }

  const amountRaw = pair.amount;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(amountRaw)) return { ok: false, error: `Invalid amount "${amountRaw}"` };

  let amount: bigint;
  try {
    amount = parseUnits(amountRaw, tokenInSpec.decimals);
  } catch {
    return { ok: false, error: `Could not convert amount "${amountRaw}" using ${tokenInSpec.symbol} decimals=${tokenInSpec.decimals}` };
  }
  if (amount <= 0n) return { ok: false, error: 'Amount must be > 0' };

  const sl =
    typeof req.slippageTolerance === 'number' && Number.isFinite(req.slippageTolerance)
      ? req.slippageTolerance
      : parseSlippage(text);

  const routingPreference =
    typeof req.routingPreference === 'string' && req.routingPreference.trim().length
      ? req.routingPreference.trim()
      : /\bfast\b/i.test(text)
        ? 'FASTEST'
        : 'BEST_PRICE';

  const intent: QuoteNlIntent = {
    chainId,
    tokenIn: tokenInSpec.address,
    tokenOut: tokenOutSpec.address,
    amount: amount.toString(),
    ...(sl !== undefined ? { slippageTolerance: sl } : {}),
    ...(routingPreference ? { routingPreference } : {}),
    tokenInSymbol: tokenInSpec.symbol,
    tokenOutSymbol: tokenOutSpec.symbol,
  };

  const swapper = req.swapper;
  if (swapper && !isAddress(swapper)) return { ok: false, error: `Invalid swapper address ${String(swapper)}` };

  const tradingApiBody: Record<string, unknown> = {
    swapper: swapper ?? '0x0000000000000000000000000000000000000001',
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    tokenInChainId: String(chainId),
    tokenOutChainId: String(chainId),
    amount: intent.amount,
    type: 'EXACT_INPUT',
    slippageTolerance: intent.slippageTolerance ?? 1,
    routingPreference: intent.routingPreference ?? 'BEST_PRICE',
  };

  return { ok: true, intent, tradingApiBody };
}

