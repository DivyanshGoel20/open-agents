import crypto from 'node:crypto';

export type ChannelMessage = {
  id: string;
  at: number;
  /** Logical thread: use `conversation` for UI; endpoints may mirror `relay` internally */
  channel: 'conversation' | 'relay_alice' | 'relay_bob' | 'system';
  direction: 'in' | 'out';
  /** Public key hex (64 chars) when from AXL; may be synthetic in demo */
  fromKey: string;
  toKey: string;
  payload: unknown;
  rawPreview: string;
  source: 'demo' | 'axl' | 'system';
};

const messages: ChannelMessage[] = [];

export function appendMessage(m: Omit<ChannelMessage, 'id' | 'at'>): ChannelMessage {
  const full: ChannelMessage = {
    ...m,
    id: crypto.randomUUID(),
    at: Date.now(),
  };
  messages.push(full);
  return full;
}

export function listMessages(): ChannelMessage[] {
  return [...messages].sort((a, b) => a.at - b.at);
}
