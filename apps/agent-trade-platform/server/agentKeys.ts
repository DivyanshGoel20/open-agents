/**
 * One private key per agent: used for 0G Compute (broker / processResponse) and for
 * Uniswap swaps on Base Sepolia / Unichain Sepolia (viem).
 *
 * Optional `PRIVATE_KEY` + `PROVIDER_ADDRESS` apply to both agents when per-agent vars are unset (dev only).
 */
export type AgentSide = 'alice' | 'bob';

export function agentPrivateKeyHex(agent: AgentSide): string | undefined {
  if (agent === 'alice') {
    return process.env.ALICE_PRIVATE_KEY || process.env.PRIVATE_KEY;
  }
  return process.env.BOB_PRIVATE_KEY || process.env.PRIVATE_KEY;
}

export function agentZeroGProviderAddress(agent: AgentSide): string | undefined {
  if (agent === 'alice') {
    return process.env.ALICE_PROVIDER_ADDRESS || process.env.PROVIDER_ADDRESS;
  }
  return process.env.BOB_PROVIDER_ADDRESS || process.env.PROVIDER_ADDRESS;
}

export function isValidAgentPrivateKey(agent: AgentSide): boolean {
  const pk = agentPrivateKeyHex(agent);
  return Boolean(pk && /^0x[a-fA-F0-9]{64}$/.test(pk));
}
