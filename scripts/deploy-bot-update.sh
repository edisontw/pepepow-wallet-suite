#!/bin/bash
# Deployment script for PEPEPOW Wallet API (Bot Commands Update)
# Usage: ./deploy-bot-update.sh

set -e

echo "========================================="
echo "PEPEPOW Wallet API - Bot Commands Update"
echo "========================================="
echo ""

# Step 1: Build
echo "[1/4] Building wallet-api..."
cd /home/ubuntu/pepepow-wallet-suite/services/wallet-api
npm run build
echo "✓ Build complete"
echo ""

# Step 2: Sync to production
echo "[2/4] Syncing to /var/www/pepepow-wallet/..."
cd /home/ubuntu/pepepow-wallet-suite
rsync -av --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'logs' \
  --exclude '*.db' \
  services/wallet-api/ \
  /var/www/pepepow-wallet/services/wallet-api/
echo "✓ Sync complete"
echo ""

# Step 3: Restart service
echo "[3/4] Restarting pepepow-wallet-api.service..."
sudo systemctl restart pepepow-wallet-api.service
sleep 3
echo "✓ Service restarted"
echo ""

# Step 4: Verify
echo "[4/4] Verifying deployment..."
echo ""

echo "Service status:"
systemctl status pepepow-wallet-api.service --no-pager -l | head -n 15
echo ""

echo "Health check:"
curl -s http://127.0.0.1:9194/healthz | jq '.' || curl -s http://127.0.0.1:9194/healthz
echo ""

echo "Readiness check:"
curl -s http://127.0.0.1:9194/readyz | jq '.' || curl -s http://127.0.0.1:9194/readyz
echo ""

echo "Recent logs (last 10 lines):"
journalctl -u pepepow-wallet-api.service -n 10 --no-pager
echo ""

echo "========================================="
echo "✅ Deployment Complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "1. Test bot commands in Telegram:"
echo "   - /start"
echo "   - /help"
echo "   - /balance"
echo "   - /deposit"
echo "   - /send"
echo "   - /history"
echo ""
echo "2. Monitor logs for any errors:"
echo "   journalctl -u pepepow-wallet-api.service -f | grep '\[telegram\]'"
echo ""
echo "3. Check specific command logs:"
echo "   journalctl -u pepepow-wallet-api.service -n 100 --no-pager | grep '\[telegram\]'"
echo ""
