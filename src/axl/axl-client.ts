import { AxlMessageSchema, type AxlMessage } from './axl-message';

export interface AxlTopology {
  ourPeerId: string;
}

export interface ReceivedAxlMessage {
  fromPeerId: string;
  message: AxlMessage;
}

export class AxlClient {
  constructor(private readonly baseUrl: string) {}

  async getTopology(): Promise<AxlTopology> {
    const res = await fetch(`${this.baseUrl}/topology`);
    if (!res.ok) throw new Error(`AXL topology failed: ${res.status}`);
    const body = await res.json() as { our_public_key: string };
    return { ourPeerId: body.our_public_key };
  }

  async send(peerId: string, message: AxlMessage): Promise<void> {
    const body = Buffer.from(JSON.stringify(message), 'utf-8');
    const res = await fetch(`${this.baseUrl}/send`, {
      method: 'POST',
      headers: { 'X-Destination-Peer-Id': peerId },
      body,
    });
    if (!res.ok) throw new Error(`AXL send failed: ${res.status} ${await res.text()}`);
  }

  async recv(): Promise<ReceivedAxlMessage | null> {
    const res = await fetch(`${this.baseUrl}/recv`);
    if (res.status === 204) return null;
    if (!res.ok) throw new Error(`AXL recv failed: ${res.status}`);
    const fromPeerId = res.headers.get('X-From-Peer-Id') ?? '';
    const raw = await res.arrayBuffer();
    const text = Buffer.from(raw).toString('utf-8');
    const parsed = AxlMessageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`AXL recv bad payload: ${text}`);
    return { fromPeerId, message: parsed.data };
  }
}
