#!/usr/bin/env bash
# Deploys what is on GitHub (main) to the VPS: the server pulls and rebuilds.
# Refuses to run with uncommitted or unpushed changes, so production is always
# exactly a commit on GitHub. Secrets stay in /opt/name-song/.env on the server.
#   ./scripts/deploy.sh
#   VPS=root@1.2.3.4 KEY=~/.ssh/other ./scripts/deploy.sh
set -euo pipefail
VPS="${VPS:-root@103.215.216.51}"
KEY="${KEY:-$HOME/.ssh/namesong_vps}"
DIR=/opt/name-song
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes. Commit and push first."; exit 1
fi
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "Local main differs from origin/main. Push (or pull) first."; exit 1
fi

npm run -s typecheck
npm test >/dev/null

echo "deploying $(git log --oneline -1)"
ssh -i "$KEY" -o BatchMode=yes "$VPS" "cd $DIR && git pull --ff-only -q && $COMPOSE up -d --build && docker image prune -f >/dev/null"

# Checked inside the API container, so it works whatever domain Caddy serves.
ssh -i "$KEY" -o BatchMode=yes "$VPS" "cd $DIR && sleep 5 && echo \"live: \$(git log --oneline -1)\" && $COMPOSE exec -T api node -e \"fetch('http://localhost:8080/readyz').then(r=>r.text()).then(console.log)\""
