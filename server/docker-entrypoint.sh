#!/bin/sh
set -e
# Applies pending migrations against whatever DATABASE_URL points at (a
# fresh Docker volume has no schema yet) before the server starts.
npx prisma migrate deploy
exec node server.js
