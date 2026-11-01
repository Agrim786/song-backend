#!/usr/bin/env bash
# Ships this folder to the VPS and rebuilds there. Secrets stay on the server
# (/opt/name-song/.env is never overwritten).
#   ./scripts/deploy.sh                 # uses the defaults below
#   VPS=root@1.2.3.4 KEY=~/.ssh/other ./scripts/deploy.sh
set -euo pipefail
VPS="${VPS:-root@103.215.216.51}"
KEY="${KEY:-$HOME/.ssh/namesong_vps}"
DIR=/opt/name-song

cd "$(dirname "$0")/.."
npm run -s typecheck
npm test >/dev/null

rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" \
  --exclude node_modules --exclude dist --exclude data --exclude .env --exclude '.env.*' \
  --exclude .git --exclude experiments --exclude .DS_Store --exclude CONTEXT.md --exclude '*.log' \
  ./ "$VPS:$DIR/"

ssh -i "$KEY" -o BatchMode=yes "$VPS" "cd $DIR && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build && docker image prune -f >/dev/null"
echo "deployed; checking health..."
# Checked inside the API container, so it works whatever domain Caddy serves.
ssh -i "$KEY" -o BatchMode=yes "$VPS" "cd $DIR && sleep 5 && docker compose exec -T api node -e \"fetch('http://localhost:8080/readyz').then(r=>r.text()).then(console.log)\""
