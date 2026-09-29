# Security Statement: PEPEPOW Wallet Suite

The PEPEPOW Wallet Suite uses a **non-custodial** security model. Recovery material and transaction signing stay on the client; backend services provide only product metadata and blockchain data/broadcast services.

## Core security principles

1. **Client-side key custody** — wallet creation/import, mnemonic/private-key handling, HD derivation, transaction construction, and signing happen on the client.
2. **No backend recovery material** — Wallet API, PEPEW Light API, and other backend services must never receive or store mnemonics, seeds, WIFs, xprvs, or private keys.
3. **No backend signing** — blockchain transactions are signed locally. The chain API may receive only an already-signed raw transaction for broadcast.
4. **Separated control and data planes** — Wallet API handles Telegram/product state; PEPEW Light API handles Wallet chain reads and signed broadcast.
5. **No direct Wallet node RPC** — Wallet API must not regain direct pepepowd RPC or legacy Wallet chain-proxy dependencies.
6. **Trade isolation** — Trade may use CEX API keys but must never access Wallet recovery material, wallet-core signing, or pepepowd RPC.

## Wallet trust boundaries

```text
CLIENT SECRET DOMAIN
  mnemonic / seed / private key / WIF / xprv / signing

WALLET CONTROL PLANE
  wallet-api :9194
  Telegram identity / public address bindings / payment metadata

WALLET CHAIN DATA PLANE
  PEPEW Light API
  public address/history/UTXO/tx data + already-signed broadcast
```

ElectrumX and pepepowd are infrastructure behind the Light API and must not be exposed directly to browser clients.

## Threat model

### Phishing and fake clients

A fake wallet can ask users for a recovery phrase or substitute a malicious destination address.

Mitigations:

- verify the official Wallet domain and Telegram Mini App entry point;
- never enter a mnemonic into an untrusted page, bot, support chat, or backend form;
- make recovery-phrase warnings explicit in UI and support material.

### XSS / malicious frontend delivery

Because signing is client-side, a compromised frontend is a serious risk: malicious code could alter transaction details or capture recovery material before signing.

Mitigations:

- strict CSP and security headers;
- minimize frontend dependencies;
- review dependency and build-chain changes;
- verify destination address and amount before signing;
- keep production deployment paths and source SHA auditable.

### Backend / API compromise

A Wallet API or Light API compromise cannot directly use server-held Wallet private keys because the architecture stores none. However, an attacker may disrupt service, return misleading chain data, manipulate product metadata, or attempt to influence client behavior.

Mitigations:

- client-side verification of transaction destination/amount before signing;
- bounded API trust and clear service separation;
- rate limits, validation, and monitoring;
- no server-side signing fallback;
- no mnemonic/private-key logging.

### Broadcast uncertainty

A broadcast POST may succeed upstream even if the client does not receive a definitive success response.

Mitigation:

- do not automatically retry an uncertain broadcast POST;
- reconcile via tx/UTXO/history before deciding whether to rebroadcast.

## User practices

- Keep the recovery phrase offline and private.
- Do not send a mnemonic/private key to support staff, bots, APIs, or websites other than the trusted local wallet UI when importing.
- Verify address and amount before signing.
- For substantial holdings, consider stronger device isolation and independent backups.

## Developer requirements

- Never add backend mnemonic/private-key storage or transaction signing.
- Never log recovery material, JWTs, Telegram `initData`, or authorization headers.
- Use integer atomic units internally: `1 PEPEW = 100000000 atomic`.
- Keep the canonical HD path `m/44'/5'/0'/0/x`.
- Use PEPEW Light API for new Wallet chain access.
- Treat `pepew-api :9193` as separate legacy infrastructure, not a Wallet dependency.
- Keep Trade isolated from Wallet signing and node RPC.
- Keep production secrets in host-managed environment files, not in Git.
