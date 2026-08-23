/**
 * Agent orders are tagged with cloid prefix 0x48544149 ("HTAI") —
 * see workers/ai-agent `makeAgentCloid`.
 *
 * Layout: `0x` + `48544149` (HTAI) + sha256(agentId)[0:8] + 16 random hex.
 */
import * as Crypto from 'expo-crypto';

const HTAI_TAG = '0x48544149';

export function isAiAgentCloid(cloid: unknown): boolean {
  const s = String(cloid ?? '').toLowerCase();
  return s.startsWith(HTAI_TAG);
}

export async function aiAgentCloidPrefix(agentId: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    agentId,
    { encoding: Crypto.CryptoEncoding.HEX },
  );
  return `${HTAI_TAG}${digest.slice(0, 8).toLowerCase()}`;
}

export function matchAiAgentIdFromCloid(
  cloid: unknown,
  prefixes: Array<{ agentId: string; prefix: string }>,
): string | null {
  const s = String(cloid ?? '').toLowerCase();
  if (!s.startsWith(HTAI_TAG)) return null;
  for (const row of prefixes) {
    if (s.startsWith(row.prefix.toLowerCase())) return row.agentId;
  }
  return null;
}
