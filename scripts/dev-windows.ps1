# Lance OpenCare en developpement sur Windows SANS Docker:
# utilise le PostgreSQL embarque de l'installateur (installer/windows/app/runtime/pgsql).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\dev-windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\dev-windows.ps1 -Port 5544
#
# Ce script: initialise une base de developpement la premiere fois, demarre
# PostgreSQL, ecrit un fichier .env a la racine si absent, puis lance npm run dev
# (interface sur http://localhost:5173, API sur http://localhost:3001).
param(
    [int]$Port = 5544
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pgBin = Join-Path $root 'installer\windows\app\runtime\pgsql\bin'
$dataDir = Join-Path $root '.devdata\pgsql'
$logFile = Join-Path $root '.devdata\pgsql.log'
$pgCtl = Join-Path $pgBin 'pg_ctl.exe'
$initdb = Join-Path $pgBin 'initdb.exe'
$psql = Join-Path $pgBin 'psql.exe'
$createdb = Join-Path $pgBin 'createdb.exe'
$pgReady = Join-Path $pgBin 'pg_isready.exe'

function Info($m) { Write-Host "[OpenCare] $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "[OpenCare] $m" -ForegroundColor Green }
function Die($m)  { Write-Host "[OpenCare] $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $pgCtl)) {
    Die "PostgreSQL embarque introuvable ($pgBin). Lancez plutot 'docker-compose up -d postgres' puis 'npm run dev', ou installez PostgreSQL 14+."
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die "Node.js introuvable dans le PATH. Installez Node.js 20+ puis relancez."
}

New-Item -ItemType Directory -Force (Join-Path $root '.devdata') | Out-Null

# --- 1. Initialiser le cluster la premiere fois (auth trust en local) --------
if (-not (Test-Path (Join-Path $dataDir 'PG_VERSION'))) {
    Info "Initialisation de la base de developpement (premiere fois)..."
    # -A trust: pas de mot de passe en local (poste de dev uniquement).
    & $initdb -D $dataDir -U opencare -A trust -E UTF8 --locale=C *>> $logFile
    if ($LASTEXITCODE -ne 0) { Die "L'initialisation de PostgreSQL a echoue. Voir $logFile" }
}

# --- 2. Demarrer PostgreSQL --------------------------------------------------
& $pgReady -h 127.0.0.1 -p $Port *> $null
if ($LASTEXITCODE -ne 0) {
    Info "Demarrage de PostgreSQL sur le port $Port..."

    # On lance le postmaster directement, dans une fenetre cachee detachee, et
    # on sonde le port nous-memes. On evite ainsi pg_ctl: son option -w combinee
    # a une console partagee fait attendre indefiniment le processus parent
    # (et 'pg_ctl -o "-p N"' casse les guillemets sous Windows PowerShell 5.1).
    $postgres = Join-Path $pgBin 'postgres.exe'
    $errLog = Join-Path $root '.devdata\pgsql.err.log'
    Start-Process -FilePath $postgres `
        -ArgumentList @('-D', "$dataDir", '-p', "$Port") `
        -WindowStyle Hidden `
        -RedirectStandardOutput $logFile `
        -RedirectStandardError $errLog

    $up = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        & $pgReady -h 127.0.0.1 -p $Port *> $null
        if ($LASTEXITCODE -eq 0) { $up = $true; break }
    }
    if (-not $up) { Die "PostgreSQL ne repond pas sur le port $Port. Voir $logFile et $errLog" }
}
Ok "PostgreSQL pret sur 127.0.0.1:$Port"

# --- 3. Creer la base si absente --------------------------------------------
$dbExists = & $psql -h 127.0.0.1 -p $Port -U opencare -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='opencare'"
if ("$dbExists".Trim() -ne '1') {
    & $createdb -h 127.0.0.1 -p $Port -U opencare opencare
    if ($LASTEXITCODE -ne 0) { Die "La creation de la base 'opencare' a echoue." }
    Ok "Base 'opencare' creee (le schema s'installera au premier demarrage du serveur)."
}

# --- 4. Ecrire un .env racine si absent (pour 'npm run dev' seul ensuite) -----
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) {
    Info "Generation du fichier .env de developpement..."
    $jwt = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
    @(
        '# Configuration de developpement OpenCare (generee par scripts\dev-windows.ps1).',
        '# Poste de developpement local uniquement: ne pas utiliser en production.',
        'POSTGRES_HOST=127.0.0.1',
        "POSTGRES_PORT=$Port",
        'POSTGRES_DB=opencare',
        'POSTGRES_USER=opencare',
        'POSTGRES_PASSWORD=dev-local',
        'NODE_ENV=development',
        "JWT_SECRET=$jwt"
    ) | Set-Content -Path $envFile -Encoding UTF8
    Ok "Fichier .env cree a la racine."
}

# --- 5. Variables pour la session courante (le .env prend le relais ensuite) -
$env:POSTGRES_HOST = '127.0.0.1'
$env:POSTGRES_PORT = "$Port"
$env:POSTGRES_DB = 'opencare'
$env:POSTGRES_USER = 'opencare'
$env:POSTGRES_PASSWORD = 'dev-local'
# Secret JWT de session genere aleatoirement (jamais de secret code en dur dans
# le depot). Normalement le .env cree a l'etape 4 fournit deja le secret.
if (-not $env:JWT_SECRET) {
    $env:JWT_SECRET = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
}

Ok "Lancement de l'application: interface http://localhost:5173, API http://localhost:3001"
Write-Host "[OpenCare] Laissez cette fenetre ouverte. Ctrl+C pour arreter." -ForegroundColor Yellow
Set-Location $root
npm run dev
