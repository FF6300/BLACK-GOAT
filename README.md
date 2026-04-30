# BLACK-GOAT

BLACK-GOAT est une app de visualisation Polymarket en lecture seule.

Objectif actuel:

- afficher quelques marches publics Polymarket
- recevoir les prix en live via le WebSocket backend
- afficher LIVE / OFFLINE et la latence
- afficher les traders actifs visibles dans les trades publics
- afficher un live trading tape public
- ne faire aucun trading
- ne faire aucune simulation
- ne stocker aucune donnee en DB

## Stack

- Node.js 22
- TypeScript
- Express
- React + Vite
- WebSocket backend

## Installation

```bash
npm install
cp .env.example .env
```

Variables par defaut:

```env
MODE=TEST
HOST=0.0.0.0
PORT=4000
POLYMARKET_MARKET_LIMIT=8
POLYMARKET_TRADES_FETCH_LIMIT=500
POLYMARKET_TRADES_POLL_MS=5000
```

## Developpement

```bash
npm run dev
```

Le frontend Vite tourne sur:

```bash
http://127.0.0.1:5173
```

Le backend Express tourne sur:

```bash
http://127.0.0.1:4000
```

## Production

```bash
npm run build
npm start
```

Apres build, Express sert aussi le frontend React depuis le port `4000`.

## Endpoints

```bash
curl http://127.0.0.1:4000/health
curl http://127.0.0.1:4000/api/polymarket/status
curl http://127.0.0.1:4000/api/polymarket/markets
curl http://127.0.0.1:4000/api/polymarket/ws-test
curl "http://127.0.0.1:4000/api/polymarket/traders/active?period=15m&sort=volume"
curl "http://127.0.0.1:4000/api/polymarket/trades/live?period=15m"
curl "http://127.0.0.1:4000/api/polymarket/traders/<wallet>?period=24h"
```

WebSockets backend:

```text
ws://127.0.0.1:4000/ws/polymarket
ws://127.0.0.1:4000/ws/traders?period=15m
```

Le navigateur envoie:

```json
{
  "type": "subscribe",
  "assetIds": ["<clob_token_id>"]
}
```

`/ws/traders` utilise un polling backend de l'API publique Polymarket Data API `/trades`, puis pousse les nouveaux trades au navigateur. Les donnees non exposees par Polymarket restent `null` ou `unavailable`.

## Deploiement VPS avec PM2

```bash
npm install
cp .env.example .env
npm run build
pm2 start dist/index.js --name black-goat --update-env
pm2 status
pm2 logs black-goat
```

Commande PM2:

```bash
pm2 start dist/index.js --name black-goat --update-env
```
