# BLACK-GOAT

API Express minimale en TypeScript pour valider uniquement la connectivite publique Polymarket depuis un VPS Lightsail Irlande.

## Objectif

Mode TEST uniquement:

- pas de frontend
- pas de DB
- pas de wallet
- pas de trading reel
- pas de copy trading

## Prerequis

- Node.js 22
- npm
- PM2 sur le VPS

## Installation

```bash
npm install
cp .env.example .env
npm run build
```

Variables par defaut:

```env
MODE=TEST
HOST=0.0.0.0
PORT=4000
```

## Scripts

```bash
npm run dev
npm run build
npm start
```

## Endpoints

```bash
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/api/polymarket/status
curl http://127.0.0.1:4000/api/polymarket/markets
curl http://127.0.0.1:4000/api/polymarket/ws-test
```

## Deploiement VPS avec PM2

```bash
npm install
cp .env.example .env
npm run build
pm2 start dist/index.js --name black-goat --update-env
pm2 status
pm2 logs black-goat
```

Pour tester depuis le VPS:

```bash
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/api/polymarket/status
curl http://127.0.0.1:4000/api/polymarket/markets
curl http://127.0.0.1:4000/api/polymarket/ws-test
```
