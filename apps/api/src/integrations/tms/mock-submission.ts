import { createHash } from 'node:crypto';

// Pure local adapter: no external write. Stable across transaction retries.
export function mockSubmission(requestId: string, confirmedAt: string) {
  return {
    status: 'confirmed' as const,
    reference:
      'BK-' + createHash('sha256').update(requestId).digest('hex').slice(0, 16).toUpperCase(),
    confirmed_at: confirmedAt,
    provider: 'demo' as const,
  };
}
