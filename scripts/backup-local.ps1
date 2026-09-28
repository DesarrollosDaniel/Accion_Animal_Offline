param(
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$StorageRoot,
  [string]$PgBin
)

$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $StorageRoot).Path.TrimEnd('\')
$target = (Resolve-Path -LiteralPath $Destination).Path.TrimEnd('\')
if ($target.Equals($source, [StringComparison]::OrdinalIgnoreCase) -or
    $target.StartsWith($source + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'El destino no puede estar dentro de uploaded.'
}
$dumpTool = if ($PgBin) { Join-Path $PgBin 'pg_dump.exe' } else { (Get-Command pg_dump.exe).Source }
$restoreTool = if ($PgBin) { Join-Path $PgBin 'pg_restore.exe' } else { (Get-Command pg_restore.exe).Source }
$folder = Join-Path $target ('AccionAnimal-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
$dump = Join-Path $folder 'accion_animal_dev.dump'
$files = Join-Path $folder 'uploaded'

try {
  $env:PGPASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host 'Contraseña de postgres LOCAL para respaldo' -AsSecureString)).Password
  & $dumpTool -w -h 127.0.0.1 -p 5432 -U postgres -d accion_animal_dev -Fc -f $dump
  if ($LASTEXITCODE -ne 0) { throw 'Falló pg_dump; el respaldo está incompleto.' }
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
& $restoreTool --list $dump | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'El archivo PostgreSQL no se pudo leer.' }
& robocopy.exe $source $files /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /XJ /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw 'Falló la copia de uploaded; el respaldo está incompleto.' }
& robocopy.exe $source $files /MIR /L /COPY:DAT /DCOPY:DAT /R:0 /W:0 /XJ /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'La copia de uploaded no coincide con el origen; revisa el respaldo.' }
Set-Content -LiteralPath (Join-Path $folder 'COMPLETO.txt') -Value 'pg_dump y copia de uploaded verificados.'
Write-Host "Respaldo completado: $folder"
