import { createHash } from 'node:crypto';

// ── Constants (from reverse-engineered Claude Code binary) ───────────────────
// These change with Claude Code releases. Update VERSION when Claude Code updates.
// Salt verified unchanged in 2.1.92 (same as 2.1.37).

const VERSION = '2.1.92';
const SALT = '59cf53e54c78';

// ── Version Suffix ──────────────────────────────────────────────────────────

/**
 * Compute the 3-char hex version suffix.
 * Takes characters at indices 4, 7, 20 from the first user message,
 * hashes with salt + version via SHA-256, returns first 3 hex chars.
 *
 * Matches Claude Code's KA7 function.
 */
export function computeVersionSuffix(firstUserMessage: string): string {
  const indices = [4, 7, 20];
  const chars = indices
    .map(i => (i < firstUserMessage.length ? firstUserMessage[i] : '0'))
    .join('');

  const input = `${SALT}${chars}${VERSION}`;
  const hash = createHash('sha256').update(input).digest('hex');
  return hash.slice(0, 3);
}

// ── Build Billing Header ────────────────────────────────────────────────────

/**
 * Build the x-anthropic-billing-header system block.
 * Injected as the first element of the system array for OAuth mode.
 *
 * cch=00000 is a LITERAL constant — Claude Code 2.1.92 does NOT compute
 * a replacement hash. Previous versions of this file computed an xxHash64
 * which caused Anthropic to reject the billing header and fall back to
 * API credit billing.
 */
export function buildBillingHeader(firstUserMessage: string): string {
  const suffix = computeVersionSuffix(firstUserMessage);
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;`;
}

export { VERSION };
