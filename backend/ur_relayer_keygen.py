"""ur_relayer_keygen — mint UR relayer EOAs locally.

Generates one or more fresh `eth_account` keypairs for the UR relayer pool
and writes the private keys into `backend/.env.local` under
`UR_RELAYER_PRIVKEY_TESTNET` (single) or `UR_RELAYER_PRIVKEYS_TESTNET`
(comma-separated, plural). Only the public address(es) are printed to stdout.

Usage
=====

    # Testnet: mint a single key (recommended for first integration)
    python backend/ur_relayer_keygen.py --env testnet

    # Mainnet: mint 4 keys to mirror Bridge2 anti-queue redundancy
    python backend/ur_relayer_keygen.py --env mainnet --count 4

The script refuses to overwrite an existing key — if you really want to
rotate, delete the relevant line from .env.local first. This avoids
accidental loss of a key whose address has been allowlisted by Adam.

After running, send the printed address(es) to UR so they can grant
DEPOSIT_OPERATOR_ROLE on the partner gateway.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from eth_account import Account


def _env_var_names(env_label: str) -> tuple[str, str]:
    """Return (singular_var, plural_var) for the requested env label."""
    suffix = env_label.upper()
    return f"UR_RELAYER_PRIVKEY_{suffix}", f"UR_RELAYER_PRIVKEYS_{suffix}"


def _existing_value(env_text: str, var_name: str) -> str | None:
    for line in env_text.splitlines():
        line = line.strip()
        if line.startswith(f"{var_name}="):
            return line.split("=", 1)[1].strip()
    return None


def _append_var(env_path: Path, var_name: str, value: str) -> None:
    existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
    suffix = "" if existing.endswith("\n") or not existing else "\n"
    with env_path.open("a", encoding="utf-8") as f:
        f.write(f"{suffix}{var_name}={value}\n")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--env",
        choices=["testnet", "mainnet"],
        default="testnet",
        help="Which UR environment this key is for (default: testnet).",
    )
    p.add_argument(
        "--count",
        type=int,
        default=1,
        help="How many keys to generate (default: 1; 4 is recommended for mainnet).",
    )
    p.add_argument(
        "--env-file",
        default="backend/.env.local",
        help="Path to env file (default: backend/.env.local). Resolved relative to repo root.",
    )
    args = p.parse_args()

    if args.count < 1:
        print("ERROR: --count must be >= 1", file=sys.stderr)
        return 2

    repo_root = Path(__file__).resolve().parent.parent
    env_path = (repo_root / args.env_file).resolve()
    env_text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""

    singular_var, plural_var = _env_var_names(args.env)

    if _existing_value(env_text, singular_var) or _existing_value(env_text, plural_var):
        print(
            f"REFUSING TO OVERWRITE: {singular_var} or {plural_var} already exists in "
            f"{env_path}. Delete the line manually if you intend to rotate.",
            file=sys.stderr,
        )
        return 1

    keys: list[str] = []
    addresses: list[str] = []
    for _ in range(args.count):
        acct = Account.create()
        pk = acct.key.hex()
        if not pk.startswith("0x"):
            pk = "0x" + pk
        keys.append(pk)
        addresses.append(acct.address)

    var_name = singular_var if args.count == 1 else plural_var
    value = ",".join(keys)
    _append_var(env_path, var_name, value)

    print(f"Generated {args.count} UR relayer EOA(s) for {args.env}.")
    print(f"  Wrote {var_name} to {env_path}")
    print(f"  Address(es) to send to UR (allowlist for DEPOSIT_OPERATOR_ROLE):")
    for i, addr in enumerate(addresses, 1):
        print(f"    {i}. {addr}")
    print()
    print("Next steps:")
    print("  1. Send the address(es) above to Adam at UR.")
    print("  2. Fund each address with a tiny bit of Arbitrum-Sepolia ETH + Mantle-Sepolia MNT.")
    print("  3. (Optional) Mirror the same line into Railway env vars when going live.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
