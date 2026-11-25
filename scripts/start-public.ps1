# Starts the public demo stack if any part is missing:
#   8787 API, 8791 static server (/api reverse proxy), cloudflared named tunnel.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/start-public.ps1
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-Url([string]$url) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return $r.StatusCode -eq 200
  } catch {
    return $false
  }
}

# 1) API server on 8787 (LLM env from desktop llm.txt when present; never printed)
if (-not (Test-Url "http://127.0.0.1:8787/api/health")) {
  $llmFile = "C:\Users\76827\Desktop\llm.txt"
  if (Test-Path $llmFile) {
    $c = Get-Content $llmFile
    if ($c.Count -ge 3) {
      $env:LLM_API_KEY = $c[0].Trim()
      $env:LLM_BASE_URL = $c[1].Trim()
      $env:LLM_MODEL = $c[2].Trim()
      $env:LLM_TIMEOUT_MS = "15000"
    }
  }
  Start-Process -FilePath "node" -ArgumentList "dist/server/app.js" `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "server.out.log") `
    -RedirectStandardError (Join-Path $logDir "server.err.log")
  Write-Output "started: API 8787"
} else {
  Write-Output "already running: API 8787"
}

# 2) Static production build + /api reverse proxy on 8791
if (-not (Test-Url "http://127.0.0.1:8791/")) {
  Start-Process -FilePath "node" -ArgumentList "scripts/serve-public.mjs" `
    -WorkingDirectory $root -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "public.out.log") `
    -RedirectStandardError (Join-Path $logDir "public.err.log")
  Write-Output "started: static 8791"
} else {
  Write-Output "already running: static 8791"
}

# 3) cloudflared named tunnel
$cf = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Where-Object { $_.CommandLine -match "steady-workbench" }
if (-not $cf) {
  Start-Process -FilePath "C:\Program Files (x86)\cloudflared\cloudflared.exe" `
    -ArgumentList @("tunnel", "--config", "C:\Users\76827\.cloudflared\steady-workbench.yml", "run", "steady-workbench") `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir "tunnel.out.log") `
    -RedirectStandardError (Join-Path $logDir "tunnel.err.log")
  Write-Output "started: cloudflared steady-workbench"
} else {
  Write-Output "already running: cloudflared steady-workbench"
}

Start-Sleep -Seconds 4
Write-Output "--- status ---"
Write-Output ("API health: " + (Test-Url "http://127.0.0.1:8787/api/health"))
Write-Output ("static:     " + (Test-Url "http://127.0.0.1:8791/"))
Write-Output ("public:     " + (Test-Url "https://hks.railvision.cloud/"))
Write-Output "public URL: https://hks.railvision.cloud/"
