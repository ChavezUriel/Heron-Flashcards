#!/bin/bash
# Validates database-level language-pair contracts and cards_legacy read-only behavior
# on a throwaway local Postgres cluster. Needs a PostgreSQL bin dir on PGBIN.
set -euo pipefail

if [ -z "${PGBIN:-}" ]; then
  if [ -d "/c/Program Files/PostgreSQL/18/bin" ]; then
    PGBIN="/c/Program Files/PostgreSQL/18/bin"
  elif [ -d "/mnt/c/Program Files/PostgreSQL/18/bin" ]; then
    PGBIN="/mnt/c/Program Files/PostgreSQL/18/bin"
  elif [ -d "/c/Program Files/PostgreSQL/17/bin" ]; then
    PGBIN="/c/Program Files/PostgreSQL/17/bin"
  elif [ -d "/mnt/c/Program Files/PostgreSQL/17/bin" ]; then
    PGBIN="/mnt/c/Program Files/PostgreSQL/17/bin"
  else
    PGBIN="C:/Program Files/PostgreSQL/18/bin"
  fi
fi
TESTDIR="$(cd "$(dirname "$0")" && pwd)"
MIG="$TESTDIR/../../migrations"
SHIM="$TESTDIR/../market_sync/shim.sql"
DATA="${DATA:-$TESTDIR/.pgdata}"
PORT="${PORT:-55478}"

"$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$DATA"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >/dev/null 2>&1
{
  echo "port = $PORT"
  echo "listen_addresses = '127.0.0.1'"
} >> "$DATA/postgresql.conf"

"$PGBIN/pg_ctl" -D "$DATA" -l "$TESTDIR/pg.log" -w start >/dev/null 2>&1

run_psql() {
  "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"
}

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$DATA"
}
trap cleanup EXIT

run_psql -d postgres -c "create database appdb;"
run_psql -d appdb -f "$SHIM"

for f in "$MIG"/*.sql; do
  echo "== $(basename "$f")"
  run_psql -d appdb -f "$f"
done

echo "== tests"
run_psql -d appdb -f "$TESTDIR/tests.sql"
echo "HARNESS DONE"
