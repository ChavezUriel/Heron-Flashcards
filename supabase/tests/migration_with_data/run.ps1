$ErrorActionPreference = "Stop"
# Applies 0001-0032, SEEDS REAL ROWS, then applies 0033+ on top.
#
# Every other harness migrates an empty database, which is why 0034 shipped with
# its examples UPDATE ordered before the content-trigger helpers were repaired:
# with no rows the UPDATE matched nothing and the trigger never fired. This
# harness exists to make that class of bug impossible to miss again.
$PGBIN = if ($env:PGBIN) { $env:PGBIN } else { "C:\Program Files\PostgreSQL\18\bin" }
$TESTDIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$MIG = Join-Path $TESTDIR "..\..\migrations"
$SHIM = Join-Path $TESTDIR "..\market_sync\shim.sql"
$DATA = Join-Path $TESTDIR ".pgdata"
$PORT = 55481

if (Test-Path "$DATA") {
    & "$PGBIN\pg_ctl.exe" -D "$DATA" stop -m immediate 2>$null
    Remove-Item -Recurse -Force "$DATA"
}

& "$PGBIN\initdb.exe" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale
Add-Content "$DATA\postgresql.conf" "`nport = $PORT`nlisten_addresses = '127.0.0.1'"

& "$PGBIN\pg_ctl.exe" -D "$DATA" -l "$TESTDIR\pg.log" -w start

function Run-Psql($argsList) {
    & "$PGBIN\psql.exe" -h 127.0.0.1 -p $PORT -U postgres -v ON_ERROR_STOP=1 -q @argsList
    if ($LASTEXITCODE -ne 0) { throw "psql failed with exit code $LASTEXITCODE" }
}

try {
    Run-Psql @("-d", "postgres", "-c", "create database appdb;")
    Write-Host "== shim"
    Run-Psql @("-d", "appdb", "-f", "$SHIM")

    # Phase 1: the schema as it stood before the language-agnostic work
    Get-ChildItem -Path "$MIG\*.sql" | Sort-Object Name | Where-Object {
        [int]($_.Name.Substring(0, 4)) -le 32
    } | ForEach-Object {
        Write-Host "== $($_.Name)"
        Run-Psql @("-d", "appdb", "-f", $_.FullName)
    }

    # Phase 2: put real rows in, using the pre-0034 column names
    Write-Host "== seed (pre-0033 data)"
    Run-Psql @("-d", "appdb", "-f", "$TESTDIR\seed_pre_0033.sql")

    # Phase 3: migrate a database that has data in it
    Get-ChildItem -Path "$MIG\*.sql" | Sort-Object Name | Where-Object {
        [int]($_.Name.Substring(0, 4)) -ge 33
    } | ForEach-Object {
        Write-Host "== $($_.Name) (on seeded data)"
        Run-Psql @("-d", "appdb", "-f", $_.FullName)
    }

    Write-Host "== tests"
    Run-Psql @("-d", "appdb", "-f", "$TESTDIR\tests.sql")
    Write-Host "HARNESS DONE"
}
finally {
    & "$PGBIN\pg_ctl.exe" -D "$DATA" stop 2>$null
    if (Test-Path "$DATA") { Remove-Item -Recurse -Force "$DATA" }
}
