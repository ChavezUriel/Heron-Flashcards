#!/bin/bash
# Validates migration 0026 (AI card patch) on a throwaway local Postgres
# cluster. Needs a PostgreSQL bin dir (18 works) on PGBIN.
#
# Follows supabase/tests/market_sync/run.sh and bulk_visibility/run.sh:
# applies 0001..0026 in order on top of the Supabase auth shim, then runs
# tests.sql: asserting authorization, partial-patch semantics, server-side
# examples mirroring, generation_metadata merge, and content_updated_at trigger.
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
    PGBIN="/c/Program Files/PostgreSQL/18/bin"
  fi
fi
TESTDIR="$(cd "$(dirname "$0")" && pwd)"
MIG="$TESTDIR/../../migrations"
SHIM="$TESTDIR/../market_sync/shim.sql"
DATA="${DATA:-$TESTDIR/.pgdata}"
PORT="${PORT:-55475}"

"$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$DATA"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >"$TESTDIR/initdb.log" 2>&1
{
  echo "port = $PORT"
  echo "listen_addresses = '127.0.0.1'"
} >> "$DATA/postgresql.conf"

"$PGBIN/pg_ctl" -D "$DATA" -l "$TESTDIR/pg.log" -w start >"$TESTDIR/pgctl_start.log" 2>&1

run_psql() { "$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

run_psql -d postgres -c "create database appdb" >/dev/null

echo "== shim"
run_psql -d appdb -f "$SHIM" >/dev/null

for f in "$MIG"/*.sql; do
  echo "== $(basename "$f")"
  run_psql -d appdb -f "$f" >/dev/null
done

echo "== tests"
run_psql -d appdb -f "$TESTDIR/tests.sql"

"$PGBIN/pg_ctl" -D "$DATA" stop >/dev/null 2>&1 || true
rm -rf "$DATA"
echo "HARNESS DONE"
