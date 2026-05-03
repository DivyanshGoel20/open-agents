import { isAddress } from 'viem';

export type QuoteIntent = {
  chainId: 84532;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  slippageTolerance?: number;
  routingPreference?: string;
};

export type ParsedQuoteIntent = { intent: QuoteIntent; displayText: string };

/**
 * Parses a trailing line `QUOTE_JSON:{ ... }` from the model (single-line JSON payload).
 */
export function extractQuoteIntent(fullText: string): ParsedQuoteIntent | null {
  const marker = 'QUOTE_JSON:';
  const idx = fullText.lastIndexOf(marker);
  if (idx === -1) return null;
  const displayText = fullText.slice(0, idx).trim();
  const raw = fullText.slice(idx + marker.length).trim();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const tokenIn = String(payload.tokenIn ?? '');
  const tokenOut = String(payload.tokenOut ?? '');
  const amount = String(payload.amount ?? '');

  // Force Base Sepolia quoting for now (no other chains).
  const chainId = 84532 as const;
  if (!isAddress(tokenIn) || !isAddress(tokenOut)) return null;
  if (!/^[1-9]\d*$/.test(amount.trim())) return null;

  const slRaw = payload.slippageTolerance;
  const sl =
    typeof slRaw === 'number' && Number.isFinite(slRaw) ? slRaw : typeof slRaw === 'string' ? Number(slRaw) : undefined;

  const ru = typeof payload.routingPreference === 'string' ? payload.routingPreference : undefined;

  const intent: QuoteIntent = {
    chainId,
    tokenIn: tokenIn as `0x${string}`,
    tokenOut: tokenOut as `0x${string}`,
    amount: amount.trim(),
    ...(sl !== undefined && !Number.isNaN(sl) ? { slippageTolerance: sl } : {}),
    ...(ru ? { routingPreference: ru } : {}),
  };

  return { intent, displayText: displayText.length ? displayText : '(Quoting swap)' };
}
