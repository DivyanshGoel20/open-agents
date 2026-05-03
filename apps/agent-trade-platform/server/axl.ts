export type AxleAgentConfig = {
  name: string;
  apiBase: string;
  publicKey: string;
};

function trimBase(url: string): string {
  return url.replace(/\/$/, '');
}

export async function topology(base: string): Promise<{ our_public_key: string }> {
  const res = await fetch(`${trimBase(base)}/topology`);
  if (!res.ok) throw new Error(`topology ${res.status}`);
  return res.json();
}

export async function send(params: {
  fromApiBase: string;
  destPeerId: string;
  body: Uint8Array | string;
}): Promise<void> {
  const res = await fetch(`${trimBase(params.fromApiBase)}/send`, {
    method: 'POST',
    headers: {
      'X-Destination-Peer-Id': params.destPeerId,
      'Content-Type': 'application/octet-stream',
    },
    body: typeof params.body === 'string' ? params.body : Buffer.from(params.body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`send failed ${res.status}: ${t}`);
  }
}

export async function recv(base: string): Promise<{ from: string; body: string } | null> {
  const res = await fetch(`${trimBase(base)}/recv`);
  if (res.status === 204) return null;
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`recv failed ${res.status}: ${t}`);
  }
  const from = res.headers.get('X-From-Peer-Id');
  if (!from) throw new Error('recv missing X-From-Peer-Id');
  const buf = Buffer.from(await res.arrayBuffer());
  const body = buf.toString('utf8');
  return { from, body };
}
