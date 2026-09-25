param(
  [switch]$Offline,
  [int]$Port = 43120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workspaceRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..\..'))
$portableNodeRoot = Join-Path $workspaceRoot 'tools\node-v22.23.1-win-x64'
$node = Get-Command node.exe -ErrorAction SilentlyContinue

if ($null -eq $node -or [int](& $node.Source -p "process.versions.node.split('.')[0]") -lt 22) {
  $portableNode = Join-Path $portableNodeRoot 'node.exe'
  if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Kernl requires Node.js 22.19 or newer. Install Node 22, or place the verified portable runtime under tools\node-v22.23.1-win-x64.'
  }
  $env:PATH = "$portableNodeRoot;$env:PATH"
}

$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
$installArgs = @('pnpm', 'install', '--frozen-lockfile')
if ($Offline) {
  $store = Join-Path $workspaceRoot '.pnpm-store\v11'
  $installArgs += @('--offline', '--store-dir', $store)
}

Push-Location $projectRoot
try {
  & $corepack @installArgs
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
  & $corepack pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit code $LASTEXITCODE" }
  $env:KERNL_PORT = [string]$Port
  if (-not $env:KERNL_DB) { $env:KERNL_DB = Join-Path $projectRoot 'data\product-alpha.sqlite' }
  & $corepack pnpm start
  if ($LASTEXITCODE -ne 0) { throw "Kernl server exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
