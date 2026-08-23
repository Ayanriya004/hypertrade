"""ur_onramp_permit — canonical signing helpers for External-Mode on-ramp.

Two signatures are needed for a gasless External Wallet Access on-ramp:

  1. Full-Auth header signature (`full_auth_sign`):
     personalSign("I agree to access my profile. " + keccak256(hash+deadline)).
     Proves wallet ownership for the API call. (Same scheme as the card probe.)

  2. EIP-2612 permit (`build_permit`):
     authorises the BufferPool contract to pull `value` of the fiat token.
     We validate the constructed digest against the token's on-chain
     DOMAIN_SEPARATOR so we never submit a permit the token would reject.

This module is the single source of truth shared by:
  - ur_probe_onramp_external.py (CLI proof)
  - server.py /ur/withdraw/_selftest (Railway-IP proof)
  - the frontend WithdrawBottomSheet replicates the SAME two signatures in TS.

No private keys are read here — callers pass them in.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from web3 import Web3

import ur_chain

# EIP-2612: keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)")
PERMIT_TYPEHASH = keccak(
    text="Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
)
# EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
_DOMAIN_TYPEHASH = keccak(
    text="EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
)

_ERC2612_ABI = [
    {"name": "nonces", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "owner", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "DOMAIN_SEPARATOR", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "bytes32"}]},
    {"name": "name", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "string"}]},
    {"name": "version", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "string"}]},
]


def _hx(b: bytes) -> str:
    h = b.hex()
    return h if h.startswith("0x") else "0x" + h


def _addr_word(addr: str) -> bytes:
    return bytes.fromhex(Web3.to_checksum_address(addr)[2:].rjust(64, "0"))


def full_auth_sign(privkey_hex: str, business_hash: str, deadline: int) -> str:
    """Return the External-Mode Full-Auth ``sign`` header value."""
    base_message = f"{business_hash}{deadline}"
    intermediate_hex = _hx(keccak(text=base_message))
    final_message = f"I agree to access my profile. {intermediate_hex}"
    signed = Account.sign_message(encode_defunct(text=final_message), private_key=privkey_hex)
    return _hx(signed.signature)


def build_full_auth(
    privkey_hex: str, *, business_hash: str = "OnrampReq", deadline_seconds: int = 1200,
) -> Dict[str, Any]:
    """Return {hash, deadline, sign} ready to forward as Full-Auth headers."""
    deadline = int(time.time()) + int(deadline_seconds)
    return {
        "hash": business_hash,
        "deadline": deadline,
        "sign": full_auth_sign(privkey_hex, business_hash, deadline),
    }


def recover_full_auth_signer(*, business_hash: str, deadline: int, sign: str) -> str:
    """Recover the EOA that signed External-Mode Full-Auth headers."""
    base_message = f"{business_hash}{int(deadline)}"
    intermediate_hex = _hx(keccak(text=base_message))
    final_message = f"I agree to access my profile. {intermediate_hex}"
    sig = (sign or "").strip()
    sig_bytes = bytes.fromhex(sig[2:] if sig.lower().startswith("0x") else sig)
    return Account.recover_message(
        encode_defunct(text=final_message), signature=sig_bytes
    ).lower()


def read_permit_domain(*, chain_id: int, token_addr: str, owner: str) -> Dict[str, Any]:
    """Read the EIP-712 permit domain + current nonce for `owner`.

    Returns {name, version, nonce, chain_id, verifying_contract} — everything
    the FRONTEND needs to build and sign EIP-712 typed data for the permit
    (the wallet signs typed data, not a raw digest). ``version`` defaults to
    "1" when the token doesn't expose ``version()`` (Fiat24 tokens). We also
    confirm our reconstructed domain separator matches the on-chain one and
    fail loudly if not, so the frontend never signs a domain the token rejects.
    """
    w3 = ur_chain.make_web3(chain_id)
    token = w3.eth.contract(address=Web3.to_checksum_address(token_addr), abi=_ERC2612_ABI)
    nonce = int(token.functions.nonces(Web3.to_checksum_address(owner)).call())
    onchain_domain = bytes(token.functions.DOMAIN_SEPARATOR().call())
    name = token.functions.name().call()
    try:
        version = token.functions.version().call()
    except Exception:  # noqa: BLE001
        version = "1"
    reconstructed = keccak(
        _DOMAIN_TYPEHASH
        + keccak(text=name)
        + keccak(text=version)
        + int(chain_id).to_bytes(32, "big")
        + _addr_word(token_addr)
    )
    if reconstructed != onchain_domain:
        raise ValueError(
            f"EIP-712 domain mismatch for {token_addr} on chain {chain_id}: "
            "reconstructed separator != on-chain DOMAIN_SEPARATOR"
        )
    return {
        "name": name,
        "version": version,
        "nonce": nonce,
        "chain_id": int(chain_id),
        "verifying_contract": Web3.to_checksum_address(token_addr),
    }


def build_permit(
    *, chain_id: int, token_addr: str, owner_pk: str, owner_addr: str,
    spender: str, value: int, deadline: int,
) -> Dict[str, Any]:
    """Sign an EIP-2612 permit; validate digest vs on-chain DOMAIN_SEPARATOR.

    Returns {v, r, s, nonce, domain_ok, name, version}. ``domain_ok`` is True
    when our reconstructed domain separator matches the token's on-chain one
    (i.e. the frontend can safely sign EIP-712 typed data with name/version).
    """
    w3 = ur_chain.make_web3(chain_id)
    token = w3.eth.contract(address=Web3.to_checksum_address(token_addr), abi=_ERC2612_ABI)
    nonce = int(token.functions.nonces(Web3.to_checksum_address(owner_addr)).call())
    onchain_domain = bytes(token.functions.DOMAIN_SEPARATOR().call())

    try:
        name = token.functions.name().call()
    except Exception:  # noqa: BLE001
        name = None
    try:
        version = token.functions.version().call()
    except Exception:  # noqa: BLE001
        version = None

    domain_ok: Optional[bool] = None
    if name is not None:
        ver = version if version is not None else "1"
        reconstructed = keccak(
            _DOMAIN_TYPEHASH
            + keccak(text=name)
            + keccak(text=ver)
            + int(chain_id).to_bytes(32, "big")
            + _addr_word(token_addr)
        )
        domain_ok = (reconstructed == onchain_domain)

    struct_hash = keccak(
        PERMIT_TYPEHASH
        + _addr_word(owner_addr)
        + _addr_word(spender)
        + int(value).to_bytes(32, "big")
        + int(nonce).to_bytes(32, "big")
        + int(deadline).to_bytes(32, "big")
    )
    digest = keccak(b"\x19\x01" + onchain_domain + struct_hash)

    try:
        signed = Account.unsafe_sign_hash(digest, owner_pk)
    except AttributeError:
        signed = Account._sign_hash(digest, owner_pk)  # type: ignore[attr-defined]

    r = signed.r.to_bytes(32, "big") if isinstance(signed.r, int) else bytes(signed.r)
    s = signed.s.to_bytes(32, "big") if isinstance(signed.s, int) else bytes(signed.s)
    return {
        "v": int(signed.v),
        "r": _hx(r),
        "s": _hx(s),
        "nonce": nonce,
        "domain_ok": domain_ok,
        "name": name,
        "version": version if version is not None else "1",
    }
