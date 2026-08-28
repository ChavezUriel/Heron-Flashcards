#!/bin/bash
set -euo pipefail

PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
TESTDIR="$(cd "$(dirname "$0")" && pwd)"
MIG="$TESTDIR/../../migrations"
SHIM="$TESTDIR/../market_sync/shim.sql"
DATA="${DATA:-$TESTDIR/.pgdata}"
PORT="${PORT:-55472}"

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
