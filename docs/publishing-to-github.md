# Publishing to GitHub Checklist

Follow this checklist to safely publish the `pepepow-wallet-suite` to a public GitHub repository.

## 1. Safety Check (Dry Run)

Run the following command in the repository root to ensure no secrets are present in the files:

```bash
rg -n "BEGIN PRIVATE KEY|mnemonic|seed|JWT_SECRET|TELEGRAM|API_KEY|password=" -S . --glob '!node_modules/*' --glob '!package-lock.json'
```

> [!CAUTION]
> If any real secrets appear in the output (not placeholders like `CHANGEME`), DO NOT PUSH to GitHub. Edit the files to remove the secrets first.

## 2. Verify `.gitignore`

Ensure `.gitignore` is present and covers all sensitive files:
- `.env` files
- `node_modules/`
- `dist/` and `build/`
- `logs/`
- Release tarballs (`*.tar.gz`)
- Certificates (`*.pem`, `*.key`)

## 3. Deployment separation

Remember that production configuration remains on the server:
- Systemd EnvironmentFiles: `/etc/pepepow/*.env`
- Actual Nginx configs: `/etc/nginx/sites-available/`

The repo only contains **examples** and **templates**.

## 4. Pushing to GitHub

1. Initialize a new git repo:
   ```bash
   git init
   ```
2. Add files:
   ```bash
   git add .
   ```
3. Check what will be committed:
   ```bash
   git status
   ```
   **Ensure no `.env`, logs, or large binaries are listed.**
4. Commit:
   ```bash
   git commit -m "initial release: pepepow-wallet-suite"
   ```
5. Push to your public remote:
   ```bash
   git remote add origin https://github.com/USERNAME/pepepow-wallet-suite.git
   git branch -M main
   git push -u origin main
   ```

## 5. Continuous Deployment

When updating code, push to GitHub first, then pull/deploy on your server using the existing `scripts/deploy_release.sh` or your preferred method. See `docs/deploy_layout.md` for details.
