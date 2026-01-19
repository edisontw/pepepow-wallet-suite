# Telegram Troubleshooting and initData Testing

This guide is for developers and operators. It focuses on Telegram WebApp `initData` issues, bot connectivity, and Mini App login problems.

## Quick Checks

1. Confirm the Mini App is opened inside Telegram (not a regular browser).
2. Verify `BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` is set in wallet-api env.
3. Check `CORS_ORIGINS` includes the wallet domain (e.g., `https://wallet.pepepow.net`).
4. Use `/wallet/readyz` to confirm Telegram connectivity and dependencies.

## initData Testing (Mini App)

### Method A: Built-in debug view
Open the Mini App with debug enabled:

- `https://wallet.pepepow.net/mini?debug=1`

Expected debug output:
- `hasTelegram: true`
- `initDataLen: > 0`
- `userId: <telegram id>`
- `platform: <android|ios|tdesktop|web>`

If `hasTelegram` is true but `initDataLen` is 0:
- You are not in a supported Telegram WebApp context.
- Test on Telegram mobile app (Android/iOS).

### Method B: API-only check (server)
`wallet-api` returns clear errors for `POST /auth/telegram`:

- `400 missing initData`: the client did not send Telegram `initData`.
- `401 invalid hash`: bot token mismatch or corrupted initData.
- `401 auth_date expired`: initData too old.
- `500 Telegram bot token not configured`: `BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` is missing.

Avoid copying `initData` into external tools or logs. Treat it as sensitive auth material.

## Common Errors and Fixes

### 1) Missing initData
**Symptom**: Mini App shows "Missing Telegram initData" or `/auth/telegram` returns `missing initData`.

**Causes**:
- App opened outside Telegram.
- Telegram desktop/web client does not provide `initData` in that context.

**Fix**:
- Open via the bot menu button on Telegram mobile.
- Avoid using a browser tab for Mini App auth.

### 2) invalid hash
**Symptom**: `/auth/telegram` returns `invalid hash`.

**Causes**:
- `BOT_TOKEN`/`TELEGRAM_BOT_TOKEN` mismatch with the bot that issued `initData`.
- Using initData from a different bot or environment.

**Fix**:
- Ensure `TELEGRAM_BOT_TOKEN` (or fallback `BOT_TOKEN`) matches the BotFather token.
- Re-open the Mini App to regenerate initData.

### 3) auth_date expired
**Symptom**: `/auth/telegram` returns `auth_date expired`.

**Causes**:
- `TELEGRAM_INITDATA_MAX_AGE_SEC` too low.
- Old initData reused across sessions.

**Fix**:
- Open the Mini App again to refresh initData.
- Adjust `TELEGRAM_INITDATA_MAX_AGE_SEC` only if required by policy.

### 4) Unauthorized (JWT)
**Symptom**: `/v1/*` returns `401 Unauthorized`.

**Causes**:
- Client did not store JWT after auth.
- Token expired (JWT lifetime is 30 minutes).

**Fix**:
- Re-authenticate by reopening the Mini App.
- Confirm the client stores and sends `Authorization: Bearer <token>`.

### 5) Bot webhook 403
**Symptom**: Telegram webhook responds 403.

**Causes**:
- `BOT_SECRET_TOKEN` mismatch.

**Fix**:
- Update the webhook secret with `setWebhook`.
- Ensure wallet-api `BOT_SECRET_TOKEN` matches the webhook secret.

### 6) Telegram API unreachable
**Symptom**: `/wallet/readyz` shows Telegram check failed.

**Causes**:
- Outbound HTTPS blocked to `api.telegram.org:443`.
- Invalid bot token format.

**Fix**:
- Allow outbound HTTPS to Telegram.
- Verify bot token format `<bot_id>:<token>`.

## Safe Logging and Debugging

- Do not log `initData` or raw JWTs.
- If needed, enable `WALLET_API_DEBUG_AUTH=1` to log a short token hash and user id (no secrets).
- Use `/wallet/readyz` and `journalctl -u pepepow-wallet-api` for service health.

## Related Docs
- `docs/telegram-architecture.md`
- `docs/telegram-botfather-setup.md`
- `docs/wallet-api.md`
- `docs/runtime.md`
