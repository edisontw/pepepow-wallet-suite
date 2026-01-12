# Web Wallet Deploy (Static SPA)

## Deploy steps (fixed order)
```bash
npm run build
rsync -a --delete --delay-updates apps/web/dist/ /var/www/pepepow-wallet/
sudo systemctl reload nginx
```

Notes:
- If you build only the web app, run `npm --prefix apps/web run build` and keep the same `rsync` target.
- Do not run `vite preview` in production.

## Verification checklist (copy/paste)
```bash
# 1) HTTP 200 for / and /mini
curl -I https://wallet.pepepow.net/
curl -I https://wallet.pepepow.net/mini

# 2) index.html asset references are 200
curl -sS https://wallet.pepepow.net/ | rg -o "assets/[^\"']+" | sort -u | \
  xargs -I{} curl -I https://wallet.pepepow.net/{}

# 3) wasm content-type is correct
curl -sS https://wallet.pepepow.net/ | rg -o "assets/[^\"']+\\.wasm" | sort -u | \
  xargs -I{} curl -I https://wallet.pepepow.net/{}
```

Expected:
- `200 OK` for `/` and `/mini`.
- All `assets/*` referenced by `index.html` return `200`.
- `.wasm` responses include `Content-Type: application/wasm`.
