export interface Cursor {
  createdAt: number;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): Cursor {
  try {
    const json = Buffer.from(s, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Cursor;
    if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor shape');
    }
    return parsed;
  } catch {
    throw new Error('invalid cursor');
  }
}
