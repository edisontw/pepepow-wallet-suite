# Non-Docker Deployment (Ubuntu)

## Prereqs
- Node.js 18+ (recommend 20 LTS)
- nginx
- systemd
- certbot (optional)

## 1) Env
Create `/etc/pepepow/pepepow-wallet-api.env` and fill secrets.

## 2) Build + deploy
From project root:
```bash
sudo bash infra/nodocker/deploy.sh /opt/pepepow-wallet-suite
```

## 3) systemd
Copy:
- `systemd/pepepow-wallet-api.service` -> `/etc/systemd/system/pepepow-wallet-api.service`

Enable/start:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pepepow-wallet-api.service
```

## 4) nginx
Copy:
- `infra/nginx/api.conf` -> `/etc/nginx/sites-available/api.pepepow.net`
- `infra/nginx/wallet.conf` -> `/etc/nginx/sites-available/wallet.pepepow.net`

Symlink and reload:
```bash
sudo ln -sf /etc/nginx/sites-available/api.pepepow.net /etc/nginx/sites-enabled/api.pepepow.net
sudo ln -sf /etc/nginx/sites-available/wallet.pepepow.net /etc/nginx/sites-enabled/wallet.pepepow.net
sudo nginx -t
sudo systemctl reload nginx
```

## 5) Telegram webhook
```bash
curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook"   -d "url=https://api.pepepow.net/tg/webhook"   -d "secret_token=$BOT_SECRET_TOKEN"
```
