import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Generate a single-session bearer token.
 * - 24 random bytes, url-safe base64 (~32 chars).
 * - Regenerated on every process start: there's no persistent secret on disk.
 */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Constant-time token comparison. Returns false for length mismatch, empty
 * inputs, or mismatched bytes. Guards against accidental timing leaks even
 * on this tiny surface.
 */
export function checkToken(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const AUTH_COOKIE_NAME = 'pa_token';
