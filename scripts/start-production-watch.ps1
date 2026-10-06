param(
  [string]$PgIsReady = 'C:\Program Files\PostgreSQL\18\bin\pg_isready.exe'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$secretDir = Join-Path $env:APPDATA 'AccionAnimal'
$env:AA_DB_PASSWORD = [System.Net.NetworkCredential]::new('', (ConvertTo-SecureString (Get-Content (Join-Path $secretDir 'local-db-password.txt') -TotalCount 1))).Password
$env:AA_PROD_WORKER_PASSWORD = [System.Net.NetworkCredential]::new('', (ConvertTo-SecureString (Get-Content (Join-Path $secretDir 'production-worker-password.txt') -TotalCount 1))).Password

if (-not (Test-Path $PgIsReady)) { throw "No se encontró pg_isready.exe: $PgIsReady" }
for ($attempt = 0; $attempt -lt 60; $attempt++) {
  & $PgIsReady -h 127.0.0.1 -p 5432 -d accion_animal_produ *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 5
}
if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL local no estuvo disponible durante cinco minutos.' }

& 'C:\Program Files\nodejs\node.exe' --env-file=.env.production.local scripts/sync-production.mjs --watch
exit $LASTEXITCODE
