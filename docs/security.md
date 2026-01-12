# Security Statement: PEPEPOW Wallet Suite

The PEPEPOW Wallet Suite is designed with a **Non-Custodial** security model at its core. This document outlines the security principles, threat model, and best practices for users and developers.

## Core Security Principles

1. **Client-Side Sovereignty**: Private keys and mnemonics are generated, encrypted, and stored ONLY on the user's device. 
2. **Zero-Knowledge Backend**: The backend servers (Wallet API and PEPEW API) never see, receive, or store mnemonics, private keys, or unencrypted wallet data.
3. **No Backend Signing**: All transactions must be signed locally on the client before being sent to the server for broadcasting.
4. **Transparent Communication**: The bridge between the client and the node is minimal, primarily used for broadcasting and fetching indexed chain data.

## Threat Model

### 1. Phishing (High Risk)
Attackers may create fake versions of the wallet to steal mnemonics.
- **Mitigation**: Users must verify the domain name (`wallet.pepepow.net`). Developers should never encourage users to enter seeds on untrusted platforms.

### 2. XSS & Client-Side Attacks (Medium Risk)
Malicious scripts could potentially intercept user input.
- **Mitigation**: Strict Content Security Policies (CSP), minimal dependencies, and regular audits of client-side code.

### 3. Server Compromise (Low Risk to Funds)
If the backend server is hacked:
- **Impact**: The service may go down, or fake data (balances) could be shown.
- **Safety**: Since the server holds no private keys, an attacker **CANNOT** steal user funds directly from the server.

## User Best Practices

- **Backup Offline**: Save your 12/24-word mnemonic on paper. Never store it in cleartext on a cloud service.
- **Official Sources**: Only use the official web wallet or Telegram Mini App link.
- **Hardware Isolation**: For large amounts, consider using a dedicated offline device to generate and store keys.

## Developer Guidelines

- **No Logging of Sensitive Data**: Never log `initData`, `headers` containing auth tokens, or any user-specific identifiers in production.
- **Audit Dependencies**: Regularly check `npm audit` and avoid including unnecessary libraries in the frontend.
- **Environmental Safety**: Use `EnvironmentFile` in systemd to manage secrets on the host, never hardcode them in the repo.
