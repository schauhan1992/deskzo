#!/usr/bin/env bash
# Once, after the first ./deploy.sh: registers Deskzo's own workspace, loads the product catalogue
# (Deskzo One, each product, the add-ons) and makes the first console owner, who gets a link to
# choose their own password — nobody else ever sees it.
#   ./first-run.sh you@deskzo.com "Your Name"
set -euo pipefail
cd "$(dirname "$0")"

email="${1:?usage: ./first-run.sh <your email> \"<your name>\"}"
name="${2:?usage: ./first-run.sh <your email> \"<your name>\"}"
ops() { docker compose run --rm ops "$@"; }

echo "── Deskzo's own workspace (deskzo.<domain>)"
ops npm run platform:adopt

echo "── The product catalogue"
ops npm run platform:plans -- products

echo "── The first console owner"
ops npm run platform:staff -- create --email "$email" --name "$name" --role OWNER

cat <<'DONE'

Done. Open the setup link above (it is also emailed, once mail is set up) to choose your password
and turn on two-factor sign-in at https://admin.<your domain>.
DONE
