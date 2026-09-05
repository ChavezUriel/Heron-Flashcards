#!/bin/bash
# Validates migration 0017 (market sync & proposals) end-to-end on a throwaway
# local Postgres cluster. Needs PostgreSQL bin dir (18 works) on PGBIN.
#
# What it does: init cluster -> Supabase auth shim -> migrations 0001..0016 ->
# legacy fixtures (pre-0017 clone, reproduces the mnemonic-loss bug) -> 0017
# (exercises the backfill) -> tests.sql (14 scenario blocks with asserts).
set -euo pipefail

PGBIN="${PGBIN:-/c/Program Files/PostgreSQL/18/bin}"
TESTDIR="$(cd "$(dirname "$0")" && pwd)"
MIG="$TESTDIR/../../migrations"
DATA="${DATA:-$TESTDIR/.pgdata}"
PORT="${PORT:-55442}"

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
run_psql -d appdb -f "$TESTDIR/shim.sql"

for f in "$MIG"/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ "$num" -lt 17 ]; then
    echo "== $base"
    run_psql -d appdb -f "$f"
  fi
done

echo "== fixtures (legacy world)"
run_psql -d appdb -f "$TESTDIR/fixtures_legacy.sql"

for f in "$MIG"/*.sql; do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ "$num" -ge 17 ]; then
    echo "== $base"
    run_psql -d appdb -f "$f"
  fi
done

echo "== tests"
run_psql -d appdb -f "$TESTDIR/tests.sql"

"$PGBIN/pg_ctl" -D "$DATA" stop >/dev/null 2>&1 || true
rm -rf "$DATA"
echo "HARNESS DONE"
