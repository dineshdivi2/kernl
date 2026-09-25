param(
  [string]$DshRepository = $env:DSH_SOURCE,
  [string]$PnpmCommand = 'pnpm.cmd',
  [string]$PnpmCli = '',
  [string]$NodeCommand = 'node.exe',
  [switch]$LiveDeepSeek,
  [switch]$KeepTemporaryHome
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:PnpmShimDirectory = $null

function Resolve-CommandPath([string]$CommandName) {
  return (Get-Command -Name $CommandName -ErrorAction Stop).Source
}

function Resolve-CompatibleNode([string]$CommandName, [string]$DshRoot) {
  $candidates = [System.Collections.Generic.List[string]]::new()
  try { $candidates.Add((Resolve-CommandPath $CommandName)) } catch { }

  $toolsRoot = Split-Path -Parent $DshRoot
  Get-ChildItem -LiteralPath $toolsRoot -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
    Sort-Object -Property Name -Descending |
    ForEach-Object {
      $candidate = Join-Path $_.FullName 'node.exe'
      if (Test-Path -LiteralPath $candidate) { $candidates.Add($candidate) }
    }

  foreach ($candidate in $candidates | Select-Object -Unique) {
    try {
      $versionText = (& $candidate --version 2>$null)
      if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(?<version>\d+\.\d+\.\d+)') { continue }
      if ([version]$Matches.version -ge [version]'22.19.0') {
        return [System.IO.Path]::GetFullPath($candidate)
      }
    } catch { }
  }
  throw 'Node.js >=22.19.0 is required; pass -NodeCommand or install a portable node-v22*-win-x64 sibling of the DSH checkout'
}

function Start-IsolatedChild(
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$DshHome,
  [bool]$AllowDeepSeekKey = $false,
  [hashtable]$EnvironmentOverrides = @{}
) {
  $start = [System.Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.WorkingDirectory = $WorkingDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $start.Environment['DSH_HOME'] = $DshHome
  if (-not $AllowDeepSeekKey) { [void]$start.Environment.Remove('DEEPSEEK_API_KEY') }
  foreach ($entry in $EnvironmentOverrides.GetEnumerator()) {
    $start.Environment[[string]$entry.Key] = [string]$entry.Value
  }
  if ($null -ne $script:PnpmShimDirectory) {
    $start.Environment['PATH'] = "$script:PnpmShimDirectory;$env:PATH"
  }

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "failed to start $FilePath" }
  return [pscustomobject]@{
    Process = $process
    Stdout = $process.StandardOutput.ReadToEndAsync()
    Stderr = $process.StandardError.ReadToEndAsync()
  }
}

function Invoke-IsolatedChild(
  [string]$FilePath,
  [string[]]$Arguments,
  [string]$WorkingDirectory,
  [string]$DshHome,
  [int]$TimeoutSeconds = 120,
  [bool]$AllowDeepSeekKey = $false,
  [hashtable]$EnvironmentOverrides = @{}
) {
  $child = Start-IsolatedChild $FilePath $Arguments $WorkingDirectory $DshHome $AllowDeepSeekKey $EnvironmentOverrides
  if (-not $child.Process.WaitForExit($TimeoutSeconds * 1000)) {
    $child.Process.Kill($true)
    $child.Process.WaitForExit()
    $stdout = Protect-Diagnostic $child.Stdout.GetAwaiter().GetResult()
    $stderr = Protect-Diagnostic $child.Stderr.GetAwaiter().GetResult()
    throw "$FilePath timed out after $TimeoutSeconds seconds`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
  }
  return [pscustomobject]@{
    ExitCode = $child.Process.ExitCode
    Stdout = $child.Stdout.GetAwaiter().GetResult()
    Stderr = $child.Stderr.GetAwaiter().GetResult()
  }
}

function Assert-Success($Result, [string]$Label) {
  if ($Result.ExitCode -ne 0) {
    throw "$Label failed with exit code $($Result.ExitCode)`nSTDOUT:`n$($Result.Stdout)`nSTDERR:`n$($Result.Stderr)"
  }
}

function Protect-Diagnostic([string]$Value) {
  if ([string]::IsNullOrEmpty($Value)) { return $Value }
  $protected = [regex]::Replace($Value, '(?i)(DEEPSEEK_API_KEY\s*[:=]\s*)[^\s''"]+', '$1[REDACTED]')
  return [regex]::Replace($protected, '(?i)\bsk-[A-Za-z0-9_-]{12,}\b', '[REDACTED_API_KEY]')
}

function Assert-SafeSuccess($Result, [string]$Label) {
  if ($Result.ExitCode -ne 0) {
    $stdout = Protect-Diagnostic $Result.Stdout
    $stderr = Protect-Diagnostic $Result.Stderr
    throw "$Label failed with exit code $($Result.ExitCode)`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
  }
}

if ($LiveDeepSeek -and $KeepTemporaryHome) {
  throw '-KeepTemporaryHome is unavailable with -LiveDeepSeek; live session data is always removed'
}
if ($LiveDeepSeek -and -not (Test-Path -LiteralPath 'Env:DEEPSEEK_API_KEY')) {
  throw 'DEEPSEEK_API_KEY is not present; live smoke was not started'
}

$packageRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dshRoot = [System.IO.Path]::GetFullPath($DshRepository)
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path $tempBase "kernl-dsh-smoke-$([guid]::NewGuid().ToString('N'))"))
if (-not $smokeRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'refusing to create a smoke directory outside the system temporary directory'
}

$required = @(
  (Join-Path $packageRoot 'package.json'),
  (Join-Path $packageRoot 'dist\index.js'),
  (Join-Path $packageRoot 'dist\tools.js'),
  (Join-Path $packageRoot 'dist\smoke.js'),
  (Join-Path $packageRoot 'dist\live-smoke-guard.js'),
  (Join-Path $dshRoot 'package.json')
)
foreach ($path in $required) {
  if (-not (Test-Path -LiteralPath $path)) { throw "required smoke input is missing: $path" }
}

$node = Resolve-CompatibleNode $NodeCommand $dshRoot
$git = Resolve-CommandPath 'git.exe'
$server = $null
New-Item -ItemType Directory -Path $smokeRoot | Out-Null

$dshManifest = Get-Content -Raw -LiteralPath (Join-Path $dshRoot 'package.json') | ConvertFrom-Json
$requiredPnpm = [string]$dshManifest.packageManager
if (-not $requiredPnpm.StartsWith('pnpm@')) {
  throw "the DSH checkout declares an unsupported package manager: $requiredPnpm"
}
$requiredPnpmVersion = $requiredPnpm.Substring('pnpm@'.Length)
if ([string]::IsNullOrWhiteSpace($PnpmCli)) {
  $cachedPnpm = Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$requiredPnpmVersion\bin\pnpm.cjs"
  if (Test-Path -LiteralPath $cachedPnpm) {
    $PnpmCli = $cachedPnpm
  }
}

if (-not [string]::IsNullOrWhiteSpace($PnpmCli)) {
  $resolvedPnpmCli = [System.IO.Path]::GetFullPath($PnpmCli)
  if (-not (Test-Path -LiteralPath $resolvedPnpmCli)) { throw "pnpm CLI is missing: $resolvedPnpmCli" }
  $script:PnpmShimDirectory = Join-Path $smokeRoot 'bin'
  New-Item -ItemType Directory -Path $script:PnpmShimDirectory | Out-Null
  $pnpm = Join-Path $script:PnpmShimDirectory 'pnpm.cmd'
  $shimText = "@echo off`r`n`"$node`" `"$resolvedPnpmCli`" %*`r`nexit /b %ERRORLEVEL%`r`n"
  [System.IO.File]::WriteAllText($pnpm, $shimText, [System.Text.UTF8Encoding]::new($false))
} else {
  $pnpm = Resolve-CommandPath $PnpmCommand
}

$tsxLoader = Join-Path $dshRoot 'node_modules\tsx\dist\esm\index.mjs'
$dshSourceCli = Join-Path $dshRoot 'apps\cli\src\bin.ts'
if (-not (Test-Path -LiteralPath $tsxLoader)) { throw "DSH source launcher is missing tsx: $tsxLoader" }
if (-not (Test-Path -LiteralPath $dshSourceCli)) { throw "DSH source CLI is missing: $dshSourceCli" }
$tsxLoaderUri = ([System.Uri]::new([System.IO.Path]::GetFullPath($tsxLoader))).AbsoluteUri
$dshPrefix = @('--import', $tsxLoaderUri, $dshSourceCli)

try {
  $profileName = if ($LiveDeepSeek) { 'headless' } else { 'kernl-smoke' }
  $safeDirectory = $dshRoot.Replace('\', '/')
  $safeDirectoryOption = "safe.directory=$safeDirectory"
  $beforeStatus = Invoke-IsolatedChild $git @('-c', $safeDirectoryOption, 'status', '--porcelain=v1', '--untracked-files=all') $dshRoot $smokeRoot
  Assert-Success $beforeStatus 'read upstream Git status'

  $readyFile = Join-Path $smokeRoot 'fake-api-ready.json'
  $server = Start-IsolatedChild $node @((Join-Path $packageRoot 'scripts\fake-api.mjs'), '--ready-file', $readyFile) $packageRoot $smokeRoot
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $readyFile)) {
    if ($server.Process.HasExited) {
      throw "fake API exited before readiness`nSTDOUT:`n$($server.Stdout.GetAwaiter().GetResult())`nSTDERR:`n$($server.Stderr.GetAwaiter().GetResult())"
    }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'fake API did not become ready within 15 seconds' }
    Start-Sleep -Milliseconds 100
  }
  $ready = Get-Content -Raw -LiteralPath $readyFile | ConvertFrom-Json
  $baseUrl = "http://127.0.0.1:$($ready.port)"

  # DSH 0.1.0-rc.7 invokes pnpm through cmd.exe on Windows. Stage only the
  # prebuilt install payload at a no-space temporary path so cmd cannot split
  # the original workspace path before pnpm receives it.
  $stagedBundle = Join-Path $smokeRoot 'bundle'
  New-Item -ItemType Directory -Path $stagedBundle | Out-Null
  Copy-Item -LiteralPath (Join-Path $packageRoot 'package.json') -Destination $stagedBundle
  Copy-Item -LiteralPath (Join-Path $packageRoot 'cordis.patch.yml') -Destination $stagedBundle
  Copy-Item -LiteralPath (Join-Path $packageRoot 'README.md') -Destination $stagedBundle
  Copy-Item -LiteralPath (Join-Path $packageRoot 'dist') -Destination $stagedBundle -Recurse

  $install = Invoke-IsolatedChild $node ($dshPrefix + @('plugin', '--profile', $profileName, 'add', $stagedBundle)) $dshRoot $smokeRoot 180
  Assert-Success $install 'install Kernl bundle into temporary profile'

  $dump = Invoke-IsolatedChild $node ($dshPrefix + @('--profile', $profileName, '--dump-config')) $dshRoot $smokeRoot 120
  Assert-Success $dump 'dump temporary profile config'
  if (-not $dump.Stdout.Contains('kernl-service') -or -not $dump.Stdout.Contains('kernl-tools')) {
    throw "composed DSH config omitted Kernl rows`n$($dump.Stdout)"
  }

  $overlay = Join-Path $smokeRoot 'smoke.patch.yml'
  if ($LiveDeepSeek) {
    $overlayText = @"
- id: kernl-service
  config:
    baseUrl: '$baseUrl'
    routePrefix: '/api/dsh'
    requestTimeoutMs: 5000
    maxResponseBytes: 1048576

- id: kernl-tools
  config:
    concludeTurnAfterSuccess: true

- id: session-title-llm
  disabled: true

- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-flash

- id: llm-deepseek
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    thinking: disabled
    reasoningEffort: off
    maxTokens: 512
    retryPolicy:
      mode: normal
      maxRetries: 0

- insert:
    - id: kernl-live-smoke-guard
      name: '@kernl/dsh-plugin/live-smoke-guard'
"@
  } else {
    $overlayText = @"
- id: kernl-service
  config:
    baseUrl: '$baseUrl'
    routePrefix: '/api/dsh'
    requestTimeoutMs: 5000
    maxResponseBytes: 1048576

- insert:
    - id: kernl-smoke-probe
      name: '@kernl/dsh-plugin/smoke'
      config:
        request:
          smoke: true
"@
  }
  [System.IO.File]::WriteAllText($overlay, $overlayText, [System.Text.UTF8Encoding]::new($false))

  if ($LiveDeepSeek) {
    $task = 'Call kernl_validate_change exactly once with request {"smoke":"live-deepseek"}. Do not call any other tool and do not answer in text. The successful tool result ends this bounded smoke turn.'
    $liveEnvironment = @{
      DSH_TOOLS_MODE = 'native'
      DSH_PERMISSION_MODE = 'read-only'
      DSH_TELEMETRY_DISABLED = '1'
    }
    $boot = Invoke-IsolatedChild $node ($dshPrefix + @('--profile', $profileName, '--patch', $overlay, $task)) $dshRoot $smokeRoot 180 $true $liveEnvironment
    Assert-SafeSuccess $boot 'boot bounded live Kernl DSH smoke profile'
    if (-not $boot.Stdout.Contains('KERNL_DSH_LIVE_SMOKE_OK modelRequests=1 toolAttempts=1 successfulResults=1')) {
      $stdout = Protect-Diagnostic $boot.Stdout
      $stderr = Protect-Diagnostic $boot.Stderr
      throw "bounded live smoke did not produce its exact count sentinel`nSTDOUT:`n$stdout`nSTDERR:`n$stderr"
    }
  } else {
    $boot = Invoke-IsolatedChild $node ($dshPrefix + @('--profile', $profileName, '--patch', $overlay)) $dshRoot $smokeRoot 120
    Assert-Success $boot 'boot Kernl DSH smoke profile'
    if (-not $boot.Stdout.Contains('KERNL_DSH_SMOKE_OK')) {
      throw "runtime smoke did not execute the Kernl tool`nSTDOUT:`n$($boot.Stdout)`nSTDERR:`n$($boot.Stderr)"
    }
    if (-not $boot.Stdout.Contains('KERNL_DSH_SMOKE_UNLOADED')) {
      throw "runtime smoke did not observe Cordis effect disposal`nSTDOUT:`n$($boot.Stdout)`nSTDERR:`n$($boot.Stderr)"
    }
  }

  $afterStatus = Invoke-IsolatedChild $git @('-c', $safeDirectoryOption, 'status', '--porcelain=v1', '--untracked-files=all') $dshRoot $smokeRoot
  Assert-Success $afterStatus 're-read upstream Git status'
  if ($afterStatus.Stdout -ne $beforeStatus.Stdout) {
    throw "the upstream DSH checkout changed during smoke execution`nBEFORE:`n$($beforeStatus.Stdout)`nAFTER:`n$($afterStatus.Stdout)"
  }

  if ($LiveDeepSeek) {
    Write-Host 'KERNL_LIVE_DEEPSEEK_SMOKE_OK modelRequests=1 toolAttempts=1 successfulResults=1 output=redacted'
  } else {
    Write-Host 'KERNL_REAL_DSH_SMOKE_OK'
  }
  Write-Host "Temporary DSH_HOME: $smokeRoot"
} finally {
  if ($null -ne $server -and -not $server.Process.HasExited) {
    $server.Process.Kill($true)
    $server.Process.WaitForExit()
  }
  if (-not $KeepTemporaryHome -and (Test-Path -LiteralPath $smokeRoot)) {
    $resolvedSmokeRoot = [System.IO.Path]::GetFullPath($smokeRoot)
    if (-not $resolvedSmokeRoot.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw 'refusing to remove a smoke directory outside the system temporary directory'
    }
    Remove-Item -LiteralPath $resolvedSmokeRoot -Recurse -Force
  }
}
