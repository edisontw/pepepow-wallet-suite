# Build and Release

## Node version
This repo pins Node via `.nvmrc` (currently `20.19.6`).

```bash
nvm install
nvm use
```

## Reproducible builds
Each package ships its own `package-lock.json`. Use `npm ci` for clean, pinned installs.

```bash
# wallet-core
cd packages/wallet-core
npm ci
npm run build

# wallet-api
cd ../../services/wallet-api
npm ci
npm run build

# web
cd ../../apps/web
npm ci
npm run build

# pepew-api (optional)
cd ../../pepew-api/pepew-api
npm ci
npm run build
```

## Build verification
Once deps are installed for each package, run the top-level build:

```bash
npm run build
```

Expected artifacts:
- `packages/wallet-core/dist/index.js`
- `packages/wallet-core/dist/index.d.ts`
- `services/wallet-api/dist/server.js`
- `pepew-api/pepew-api/dist/index.js`
- `apps/web/dist/index.html`
- `apps/web/dist/assets/`

## Production-only dependencies
For runtime installs (services), prune dev dependencies after building:

```bash
cd services/wallet-api
npm prune --omit=dev

cd ../../packages/wallet-core
npm prune --omit=dev

cd ../../pepew-api/pepew-api
npm prune --omit=dev
```

## Release tarball
Use the packaging script to build, prune, bundle assets, and run a smoke test:

```bash
bash scripts/pack_release.sh
```

The script creates `release_<version>_<timestamp>.tar.gz` in the repo root and includes:
- built outputs (`dist/`)
- `package.json` + `package-lock.json` for each runtime package
- production `node_modules`
- `systemd/` and `scripts/`
- `.env.example` (no secrets)
