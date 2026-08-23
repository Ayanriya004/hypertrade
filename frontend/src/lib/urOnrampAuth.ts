/**
 * urOnrampAuth — client-side signing for the External-Mode cash-out (on-ramp).
 *
 * Mirrors `backend/ur_onramp_permit.py` EXACTLY (the canonical reference).
 * Two signatures are produced from the URID-owning Privy wallet:
 *
 *   1. buildFullAuth()  — Full-Auth header signature:
 *        personalSign("I agree to access my profile. " + keccak256(hash+deadline))
 *      The backend forwards {hash, deadline, sign} to UR; it never signs itself.
 *
 *   2. signOnrampPermit() — EIP-2612 permit (eth_signTypedData_v4) over the
 *      fiat token, authorising the BufferPool spender. The backend validated
 *      the EIP-712 domain against the token's on-chain DOMAIN_SEPARATOR, so the
 *      {name, version, chainId, verifyingContract} we sign is guaranteed to
 *      match — and the resulting v/r/s is what UR submits via
 *      /api/v1/onramp-with-permit.
 *
 * Both use the embedded wallet's standard RPC methods (personal_sign /
 * eth_signTypedData_v4) — NOT the raw secp256k1_sign used by the 7702 flows —
 * so the recovery byte is already the canonical {27,28}. We still normalise
 * v defensively.
 */
import { keccak256, toBytes, type Hex, type WalletClient } from 'viem';

import type { UrExtAuth } from './urApi';

/**
 * Sign the External-Mode Full-Auth headers. A single signed set is valid for
 * any call until `deadline` (default 20 min), so the caller can reuse it for
 * quote + submit.
 */
export async function buildFullAuth(
  walletClient: WalletClient,
  account: Hex,
  opts?: { businessHash?: string; deadlineSeconds?: number },
): Promise<UrExtAuth> {
  const businessHash = opts?.businessHash ?? 'OnrampReq';
  const deadline = Math.floor(Date.now() / 1000) + (opts?.deadlineSeconds ?? 1200);
  const base = `${businessHash}${deadline}`;
  // keccak256 of the UTF-8 bytes — matches Web3.keccak(text=base).hex() server-side.
  const intermediate = keccak256(toBytes(base));
  const finalMessage = `I agree to access my profile. ${intermediate}`;
  // EIP-191 personal_sign — matches eth_account encode_defunct(text=...).
  const sign = await walletClient.signMessage({ account, message: finalMessage });
  return { hash: businessHash, deadline, sign };
}

export interface SignOnrampPermitParams {
  account: Hex;
  token: Hex;          // fiat token (verifyingContract)
  spender: Hex;        // BufferPool contract
  value: bigint;       // permit value (>= amountIn), 2dp smallest-unit
  deadline: number;    // permit deadline (unix seconds)
  chainId: number;
  name: string;
  version: string;
  nonce: number;
}

export interface PermitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/** Sign an EIP-2612 permit via eth_signTypedData_v4; return split v/r/s. */
export async function signOnrampPermit(
  walletClient: WalletClient,
  p: SignOnrampPermitParams,
): Promise<PermitSignature> {
  const signature = await walletClient.signTypedData({
    account: p.account,
    domain: {
      name: p.name,
      version: p.version,
      chainId: p.chainId,
      verifyingContract: p.token,
    },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: p.account,
      spender: p.spender,
      value: p.value,
      nonce: BigInt(p.nonce),
      deadline: BigInt(p.deadline),
    },
  });
  return splitSignature(signature);
}

/** Split a 65-byte 0x signature into r/s/v, normalising v to {27,28}. */
export function splitSignature(signature: Hex): PermitSignature {
  const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (hex.length !== 130) {
    throw new Error(`Unexpected signature length ${hex.length} (want 130 hex chars)`);
  }
  const r = (`0x${hex.slice(0, 64)}`) as Hex;
  const s = (`0x${hex.slice(64, 128)}`) as Hex;
  let v = parseInt(hex.slice(128, 130), 16);
  if (v < 27) v += 27; // canonicalise {0,1} -> {27,28}
  return { v, r, s };
}
