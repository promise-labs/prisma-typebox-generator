#!/usr/bin/env bash
BASEDIR=$(dirname "$0")
cd $BASEDIR
npm run build
node ./dist/cli.js
echo "Generated Prisma TypeBox Types successfully"