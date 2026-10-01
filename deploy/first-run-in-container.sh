#!/bin/sh
# Once, inside the app's container on a new server (Coolify: the application's Terminal):
#   sh deploy/first-run-in-container.sh you@deskzo.com "Your Name"
# Makes the databases, migrates them, registers Deskzo's own workspace (deskzo.<domain>), loads the
# product catalogue and makes the first console owner — who gets a link to choose their own password.
set -eu
email="${1:?usage: sh deploy/first-run-in-container.sh <your email> \"<your name>\"}"
name="${2:?usage: sh deploy/first-run-in-container.sh <your email> \"<your name>\"}"

echo "── The databases"
node deploy/create-databases.mjs

echo "── Migrations"
npm run tenants:migrate

echo "── Deskzo's own workspace"
npm run platform:adopt

echo "── The product catalogue"
npm run platform:plans -- products

echo "── The first console owner"
npm run platform:staff -- create --email "$email" --name "$name" --role OWNER

echo
echo "Done. Open the setup link above to choose your password and turn on two-factor sign-in."
