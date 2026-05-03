import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  isHex,
  type Chain,
  type Hash,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, unichainSepolia } from 'viem/chains';
import { tradingPost } from './tradingApi.js';
import { agentPrivateKeyHex, type AgentSide } from './agentKeys.js';

export type { AgentSide };

export type SwapIntent = {
  chainId: number;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  amount: string;
  slippageTolerance?: number;
  routingPreference?: string;
};

const ETH_ADDR = '0x0000000000000000000000000000000000000000' as const;

const ALLOWED_SWAP_CHAINS = new Set<number>([84532, 1301]);

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function chainById(id: number): Chain {
  if (id === baseSepolia.id) return baseSepolia;
  if (id === unichainSepolia.id) return unichainSepolia;
  throw new Error(`Unsupported chainId ${id}; allowed: 84532 (Base Sepolia), 1301 (Unichain Sepolia)`);
}

export function rpcForSwapChain(chainId: number): string {
  if (chainId === 84532)
    return process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  if (chainId === 1301)
    return process.env.UNICHAIN_SEPOLIA_RPC_URL || 'https://sepolia.unichain.org';
  throw new Error(`No RPC configured for chainId ${chainId}`);
}

export function swapPrivateKey(agent: AgentSide): `0x${string}` {
  const raw = agentPrivateKeyHex(agent);
  if (!raw || !/^0x[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error(
      `${agent}: set ${agent === 'alice' ? 'ALICE_PRIVATE_KEY' : 'BOB_PRIVATE_KEY'} (0x + 64 hex); same key is used for 0G Compute and swaps`,
    );
  }
  return raw as `0x${string}`;
}

function inferPrimaryType(types: Record<string, unknown>): string {
  const keys = Object.keys(types).filter((k) => k !== 'EIP712Domain');
  if (keys.length < 1) throw new Error('permitData.types has no signing root');
  return keys[0];
}

function prepareSwapRequest(quoteResponse: Record<string, unknown>, signature?: string): Record<string, unknown> {
  const { permitData, permitTransaction, ...cleanQuote } = quoteResponse;
  void permitTransaction;
  const request: Record<string, unknown> = { ...cleanQuote };

  const isUniswapX =
    quoteResponse.routing === 'DUTCH_V2' ||
    quoteResponse.routing === 'DUTCH_V3' ||
    quoteResponse.routing === 'PRIORITY';

  if (isUniswapX) {
    if (signature) request.signature = signature;
  } else {
    if (signature && permitData && typeof permitData === 'object') {
      request.signature = signature;
      request.permitData = permitData;
    }
  }
  return request;
}

function validateSwap(swap: { data?: string; to?: string; from?: string; value?: string }): void {
  if (!swap?.data || swap.data === '' || swap.data === '0x') {
    throw new Error('swap.data is empty — quote may have expired');
  }
  if (!isHex(swap.data)) throw new Error('swap.data must be hex');
  if (!swap.to || !isAddress(swap.to)) throw new Error('swap.to invalid');
  if (!swap.from || !isAddress(swap.from)) throw new Error('swap.from invalid');
  if (swap.value === undefined || swap.value === null) throw new Error('swap.value missing');
}

async function signPermitIfNeeded(walletClient: WalletClient, quoteResponse: Record<string, unknown>): Promise<string | undefined> {
  const pdRaw = quoteResponse.permitData;
  if (!pdRaw || typeof pdRaw !== 'object' || pdRaw === null) return undefined;

  const pd = pdRaw as Record<string, unknown>;
  const domain = pd.domain as Record<string, unknown> | undefined;
  const typesRaw = pd.types as Record<string, unknown> | undefined;
  if (!domain || !typesRaw) return undefined;

  const typesForViem = { ...typesRaw } as Record<string, Array<{ name: string; type: string }>>;
  delete typesForViem.EIP712Domain;

  const primaryType =
    typeof pd.primaryType === 'string' && pd.primaryType ? pd.primaryType : inferPrimaryType(typesRaw);

  const message = (pd.message ?? pd.values) as Record<string, unknown>;
  const account = walletClient.account;
  if (!account) throw new Error('walletClient.account missing');

  return walletClient.signTypedData({
    account,
    domain: domain as never,
    primaryType,
    types: typesForViem,
    message,
  });
}

type ApprovalResp = {
  approval: { to: string; data: string; value: string; chainId?: number } | null;
};

type SwapResp = {
  swap: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId?: number;
    gasLimit?: string;
  };
};

export async function executeSwap(
  agent: AgentSide,
  intent: SwapIntent,
): Promise<{
  routing: unknown;
  approvalTxHashes: Hash[];
  swapTxHash: Hash;
  agent: AgentSide;
  chainId: number;
}> {
  if (!ALLOWED_SWAP_CHAINS.has(intent.chainId)) throw new Error(`chainId ${intent.chainId} not allowed`);
  if (!isAddress(intent.tokenIn) || !isAddress(intent.tokenOut)) throw new Error('tokenIn/tokenOut must be checksummable addresses');

  const chain = chainById(intent.chainId);
  const pk = swapPrivateKey(agent);
  const transport = http(rpcForSwapChain(intent.chainId));
  const account = privateKeyToAccount(pk);
  const walletClient = createWalletClient({ account, chain, transport });
  const publicClient = createPublicClient({ chain, transport });

  const swapper = account.address;
  const approvalTxHashes: Hash[] = [];

  if (intent.tokenIn.toLowerCase() !== ETH_ADDR.toLowerCase()) {
    const approvalJSON = (await tradingPost('/check_approval', {
      walletAddress: swapper,
      token: intent.tokenIn,
      amount: intent.amount,
      chainId: intent.chainId,
    })) as ApprovalResp;
    await sleep(180);

    if (approvalJSON.approval?.data) {
      const appr = approvalJSON.approval;
      const ah = await walletClient.sendTransaction({
        to: appr.to as `0x${string}`,
        data: appr.data as `0x${string}`,
        value: BigInt(appr.value || '0'),
      });
      approvalTxHashes.push(ah);
      await publicClient.waitForTransactionReceipt({ hash: ah });
      await sleep(180);
    }
  }

  const quoteResponse = (await tradingPost('/quote', {
    swapper,
    tokenIn: intent.tokenIn,
    tokenOut: intent.tokenOut,
    tokenInChainId: String(intent.chainId),
    tokenOutChainId: String(intent.chainId),
    amount: intent.amount,
    type: 'EXACT_INPUT',
    slippageTolerance: intent.slippageTolerance ?? 1,
    routingPreference: intent.routingPreference ?? 'BEST_PRICE',
  })) as Record<string, unknown>;

  const routing = quoteResponse.routing;
  await sleep(180);

  const signature = await signPermitIfNeeded(walletClient, quoteResponse);
  const swapBody = prepareSwapRequest(quoteResponse, signature);
  await sleep(180);

  const swapData = (await tradingPost('/swap', swapBody)) as SwapResp;
  validateSwap(swapData.swap);

  const swapTxHash = await walletClient.sendTransaction({
    to: swapData.swap.to as `0x${string}`,
    data: swapData.swap.data as `0x${string}`,
    value: BigInt(swapData.swap.value || '0'),
    ...(swapData.swap.gasLimit ? { gas: BigInt(swapData.swap.gasLimit) } : {}),
  });

  await publicClient.waitForTransactionReceipt({ hash: swapTxHash });

  return { routing, approvalTxHashes, swapTxHash, agent, chainId: intent.chainId };
}

export function explorerTxUrl(chainId: number, hash: Hash): string {
  if (chainId === 84532) return `https://sepolia.basescan.org/tx/${hash}`;
  if (chainId === 1301) return `https://sepolia.uniscan.xyz/tx/${hash}`;
  return hash;
}
