import { createHash } from 'node:crypto';
import xxhash from 'xxhash-wasm';

// ── Constants (from reverse-engineered Claude Code binary) ───────────────────
// These change with Claude Code releases. Current as of v2.1.37.

const CCH_SEED = 0x6E52736AC806831En;  // xxHash64 seed (BigInt for 64-bit)
const VERSION = '2.1.37';
const SALT = '59cf53e54c78';            // 12-char hex salt for version suffix

// Lazy-init xxhash WASM module
let xxhashModule: Awaited<ReturnType<typeof xxhash>> | null = null;

async function getXxhash() {
  if (!xxhashModule) {
    xxhashModule = await xxhash();
  }
  return xxhashModule;
}

// ── Version Suffix ──────────────────────────────────────────────────────────

/**
 * Compute the 3-char hex version suffix.
 * Takes characters at indices 4, 7, 20 from the first user message,
 * hashes with salt + version via SHA-256, returns first 3 hex chars.
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

// ── cch Body Hash ───────────────────────────────────────────────────────────

/**
 * Compute the 5-char hex cch hash.
 * xxHash64(body_with_placeholder, seed) & 0xFFFFF
 *
 * The body must contain "cch=00000" as a placeholder.
 * This function computes the hash and returns the body with the placeholder replaced.
 */
export async function computeCch(bodyWithPlaceholder: string): Promise<{
  cch: string;
  signedBody: string;
}> {
  const h = await getXxhash();

  // Compute xxHash64 of the body (with placeholder still in place)
  const hash64 = h.h64Raw(Buffer.from(bodyWithPlaceholder), CCH_SEED);

  // Mask to 20 bits (0xFFFFF) and format as 5-char hex
  const cch = (hash64 & 0xFFFFFn).toString(16).padStart(5, '0');

  // Replace placeholder with computed hash
  const signedBody = bodyWithPlaceholder.replace('cch=00000', `cch=${cch}`);

  return { cch, signedBody };
}

// ── Build Billing Header ────────────────────────────────────────────────────

/**
 * Build the x-anthropic-billing-header system block.
 * This is injected as the first element of the system array.
 */
export function buildBillingHeader(firstUserMessage: string): string {
  const suffix = computeVersionSuffix(firstUserMessage);
  return `x-anthropic-billing-header: cc_version=${VERSION}.${suffix}; cc_entrypoint=cli; cch=00000;`;
}

export { VERSION };
