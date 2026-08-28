$ErrorActionPreference = "Stop"
$PGBIN = "C:\Program Files\PostgreSQL\18\bin"
$TESTDIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$MIG = Join-Path $TESTDIR "..\..\migrations"
$SHIM = Join-Path $TESTDIR "..\market_sync\shim.sql"
$DATA = Join-Path $TESTDIR ".pgdata"
$PORT = 55472

& "$PGBIN\pg_ctl.exe" -D "$DATA" stop -m immediate 2>$null
if (Test-Path "$DATA") { Remove-Item -Recurse -Force "$DATA" }

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

    Get-ChildItem -Path "$MIG\*.sql" | Sort-Object Name | ForEach-Object {
        Write-Host "== $($_.Name)"
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
