/**
 * Shared EIP-7702 + AmbireAccount signing helpers.
 *
 * Used by:
 *   - DigitalDepositBottomSheet (Add Money on Arbitrum Sepolia)
 *   - ConvertBottomSheet (FX on Mantle Sepolia)
 *   - any future flow that batches calls through a 7702-delegated EOA
 *
 * All functions are pure / RPC-free — they take primitives and produce
 * hashes/signatures or normalisation. RPC reads (nonce, code) and the
 * actual `secp256k1_sign` call must be done by the caller.
 *
 * Why this file exists (do NOT inline these into bottom sheets):
 * The Ambire batch hash + signature normalisation rules are subtle and
 * were derived by forensic decoding of a UR reference tx on
 * Arb Sepolia (0x87f7e974…). Drift between sheets would silently
 * produce invalid signatures that ecrecover to a random address —
 * a class of bug we never want to debug twice.
 */
import {
  encodeAbiParameters,
  keccak256,
  recoverAddress,
  stringToHex,
  type Hex,
} from 'viem';

// AmbireAccount.nonce() — readable from the 7702-delegated EOA.
export const AMBIRE_NONCE_ABI = [
  {
    type: 'function',
    name: 'nonce',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// AmbireAccount7702 EIP-712 typehashes (precomputed at module load).
const AMBIRE_DOMAIN_TYPEHASH = keccak256(
  stringToHex(
    'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)',
  ),
);
const AMBIRE_TXN_TYPEHASH = keccak256(
  stringToHex('Transaction(address to,uint256 value,bytes data)'),
);
const AMBIRE_EXEC_TYPEHASH = keccak256(
  stringToHex(
    'AmbireExecuteAccountOp(address account,uint256 chainId,uint256 nonce,Transaction[] calls,bytes32 hash)Transaction(address to,uint256 value,bytes data)',
  ),
);
const AMBIRE_NAME_HASH = keccak256(stringToHex('Ambire'));
const AMBIRE_VERSION_HASH = keccak256(stringToHex('1'));
const ZERO_BYTES32 =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

export interface AmbireBatchCall {
  to: string;
  value: string;
  data: string;
}

/**
 * Compute the digest the deployed AmbireAccount7702 actually passes to
 * ecrecover inside `execute()`. NOT the same as the public v2 source —
 * confirmed via debug_traceTransaction on Arb Sepolia tx 0x87f7e974…
 *
 *   inner       = keccak(abi.encode(eoa, chainId, nonce, calls))
 *   txnHash[i]  = keccak(abi.encode(TxnTypehash, to[i], value[i], keccak(data[i])))
 *   callsHash   = keccak(packed(txnHash[0..n]))
 *   domainSep   = keccak(abi.encode(DomainTypehash, "Ambire", "1", chainId, eoa, 0))
 *   structHash  = keccak(abi.encode(ExecTypehash, eoa, chainId, nonce, callsHash, inner))
 *   finalHash   = keccak("\x19\x01" || domainSep || structHash)
 *
 * Pass `finalHash` to `secp256k1_sign` directly (no EIP-191 prefix).
 */
export function computeAmbireBatchHash({
  eoa,
  chainId,
  nonce,
  calls,
}: {
  eoa: Hex;
  chainId: bigint;
  nonce: bigint;
  calls: AmbireBatchCall[];
}): Hex {
  const callTuples = calls.map(
    (c) => [c.to as Hex, BigInt(c.value || '0'), c.data as Hex] as const,
  );

  const inner = keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        {
          type: 'tuple[]',
          components: [
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'data', type: 'bytes' },
          ],
        },
      ],
      [
        eoa,
        chainId,
        nonce,
        callTuples as unknown as readonly { to: Hex; value: bigint; data: Hex }[],
      ],
    ),
  );

  const callHashes: Hex[] = callTuples.map(([to, value, data]) =>
    keccak256(
      encodeAbiParameters(
        [
          { type: 'bytes32' },
          { type: 'address' },
          { type: 'uint256' },
          { type: 'bytes32' },
        ],
        [AMBIRE_TXN_TYPEHASH, to, value, keccak256(data)],
      ),
    ),
  );
  const callsConcat = ('0x' + callHashes.map((h) => h.slice(2)).join('')) as Hex;
  const callsHash = keccak256(callsConcat);

  // EIP-712 domain separator. verifyingContract = the EOA itself
  // (the Ambire account lives at the EOA's address via 7702 delegation).
  const domainSep = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'bytes32' },
      ],
      [
        AMBIRE_DOMAIN_TYPEHASH,
        AMBIRE_NAME_HASH,
        AMBIRE_VERSION_HASH,
        chainId,
        eoa,
        ZERO_BYTES32,
      ],
    ),
  );

  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [AMBIRE_EXEC_TYPEHASH, eoa, chainId, nonce, callsHash, inner],
    ),
  );

  const prefixed = ('0x1901' + domainSep.slice(2) + structHash.slice(2)) as Hex;
  return keccak256(prefixed);
}

/** Parse a 65-byte hex signature into r / s / v. */
export function splitSignature(sig: Hex): { r: string; s: string; v: number } {
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (clean.length !== 130) {
    throw new Error(`Unexpected signature length: ${clean.length}`);
  }
  const r = '0x' + clean.slice(0, 64);
  const s = '0x' + clean.slice(64, 128);
  const v = parseInt(clean.slice(128, 130), 16);
  return { r, s, v };
}

/**
 * Recover the signer of an EIP-7702 authorization digest and return the
 * canonical `{ r, s, yParity }` tuple — verified to recover to the given
 * authority EOA. Throws if neither y_parity candidate recovers correctly.
 *
 * Why this exists:
 *   Privy's `secp256k1_sign` returns the recovery byte in inconsistent
 *   conventions across chains. Empirically:
 *     - Arb Sepolia: v ∈ {0, 1}   (raw yParity)
 *     - Mantle Sepolia: v ∈ {27, 28}   (legacy ECDSA)
 *   A naive `v % 2` mapping silently produces an INVERTED yParity on
 *   chains using the legacy convention, which makes the auth signature
 *   recover to a random address. The EVM then drops the SetCode part
 *   while still mining the outer tx (gasUsed ~51k, zero logs, "success").
 *
 *   Forensically observed on Mantle Sepolia tx
 *   0x9404d5e548dd48e220442c641593dab3f1b245fae5aab90c2cbd31dd8ef9fa44
 *   — yParity 1 (as sent) recovered to 0xdef822cc…, but the actual
 *   authority was 0xfa029dab… (matched with yParity 0).
 *
 *   This helper recovers locally and refuses to return mismatched data,
 *   so we never broadcast a fundamentally invalid 7702 auth again.
 */
export async function normaliseAuth7702Signature(args: {
  authHash: Hex;
  signature: Hex;
  authority: Hex;
}): Promise<{ r: Hex; s: Hex; yParity: 0 | 1 }> {
  const { r, s, v } = splitSignature(args.signature);
  const rHex = r as Hex;
  const sHex = s as Hex;
  // Canonical mapping: drop legacy 27/28 offset if present.
  const canonical = v >= 27 ? v - 27 : v;
  const candidates: (0 | 1)[] =
    canonical === 0 || canonical === 1
      ? [canonical, (1 - canonical) as 0 | 1]
      : [0, 1];
  for (const yp of candidates) {
    try {
      const recovered = await recoverAddress({
        hash: args.authHash,
        signature: { r: rHex, s: sHex, yParity: yp },
      });
      if (recovered.toLowerCase() === args.authority.toLowerCase()) {
        return { r: rHex, s: sHex, yParity: yp };
      }
    } catch {
      // Try the other candidate.
    }
  }
  throw new Error(
    `EIP-7702 auth signature does not recover to authority ${args.authority}`,
  );
}

/**
 * Ensure a 65-byte signature ends with v ∈ {27,28}. Privy / viem occasionally
 * return v as {0,1} (yParity). Ambire's signature coercion requires the
 * trailing byte to be ≥ LastUnused (6) to drop into Unprotected mode —
 * v=0 or v=1 would be misinterpreted as a signature mode.
 */
export function normaliseSig65(sig: Hex): Hex {
  const clean = sig.startsWith('0x') ? sig.slice(2) : sig;
  if (clean.length !== 130) {
    throw new Error(`Expected 65-byte signature, got ${clean.length / 2}`);
  }
  let v = parseInt(clean.slice(128, 130), 16);
  if (v < 27) v += 27;
  return ('0x' + clean.slice(0, 128) + v.toString(16).padStart(2, '0')) as Hex;
}
