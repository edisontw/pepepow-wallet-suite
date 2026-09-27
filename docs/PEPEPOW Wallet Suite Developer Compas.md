# Superseded Developer Compass

This historical file is retained only to avoid breaking old links.

**Do not use it as the current architecture or development authority.**

The canonical working guide is:

```text
docs/DEV_COMPASS.md
```

The authoritative Light API migration sequence is:

```text
docs/LIGHT_API_MIGRATION.md
```

Reason for supersession:

- the previous document described `pepew-api :9193` and direct `pepepowd` RPC as the permanent Telegram Wallet chain path;
- on 2026-09-27 the approved target changed to PEPEW Light API / ElectrumX for Wallet chain reads and signed raw transaction broadcast;
- `wallet-api :9194` is being reduced to Telegram/product control-plane responsibilities;
- runtime migration is incremental, so legacy paths may still exist until M1-M6 are complete.

Non-custodial and Trade-isolation rules remain unchanged.
