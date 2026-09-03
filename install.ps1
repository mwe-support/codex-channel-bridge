$ErrorActionPreference = "Stop"

$Repository = "mwe-support/codex-channel-bridge"
$Version = $env:CODEX_CHANNEL_BRIDGE_VERSION
$InstallRoot = if ($env:CODEX_CHANNEL_BRIDGE_INSTALL_ROOT) {
  $env:CODEX_CHANNEL_BRIDGE_INSTALL_ROOT
} else {
  Join-Path $env:LOCALAPPDATA "CodexChannelBridge"
}
$BinDirectory = if ($env:CODEX_CHANNEL_BRIDGE_BIN_DIR) {
  $env:CODEX_CHANNEL_BRIDGE_BIN_DIR
} else {
  Join-Path $InstallRoot "bin"
}

foreach ($Command in @("node", "npm.cmd", "tar.exe")) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Command is required"
  }
}
$NodeMajor = [int](& node -p "Number(process.versions.node.split('.')[0])")
if ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required" }

$CodexExecutable = if ($env:CODEX_EXECUTABLE) { $env:CODEX_EXECUTABLE } else { "codex.exe" }
if (-not (Get-Command $CodexExecutable -ErrorAction SilentlyContinue)) {
  throw "Codex CLI is required and must be installed by the host administrator"
}

if (-not $Version) {
  try {
    $Version = (Invoke-RestMethod "https://api.github.com/repos/$Repository/releases/latest").tag_name
  } catch {
    throw "No stable release is available; set CODEX_CHANNEL_BRIDGE_VERSION to an exact prerelease"
  }
}
$Version = $Version -replace '^v', ''
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$') {
  throw "CODEX_CHANNEL_BRIDGE_VERSION must be an exact semantic version"
}

foreach ($Path in @($InstallRoot, $BinDirectory)) {
  if (Test-Path $Path) {
    $Item = Get-Item $Path -Force
    if (-not $Item.PSIsContainer -or $Item.LinkType) {
      throw "$Path must be a real directory"
    }
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path $InstallRoot "versions"), $BinDirectory | Out-Null

$Temporary = Join-Path ([IO.Path]::GetTempPath()) ("codex-channel-bridge-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Temporary | Out-Null
$Staging = $null
try {
  $Archive = "codex-channel-bridge-$Version.tar.gz"
  $Checksum = "$Archive.sha256"
  $ReleaseBase = if ($env:CODEX_CHANNEL_BRIDGE_RELEASE_BASE_URL) {
    $env:CODEX_CHANNEL_BRIDGE_RELEASE_BASE_URL.TrimEnd('/')
  } else {
    "https://github.com/$Repository/releases/download/v$Version"
  }
  Invoke-WebRequest "$ReleaseBase/$Archive" -OutFile (Join-Path $Temporary $Archive)
  Invoke-WebRequest "$ReleaseBase/$Checksum" -OutFile (Join-Path $Temporary $Checksum)
  $Expected = ((Get-Content (Join-Path $Temporary $Checksum) -First 1) -split '\s+')[0]
  if ($Expected -notmatch '^[0-9A-Fa-f]{64}$') { throw "Published checksum is malformed" }
  $Actual = (Get-FileHash (Join-Path $Temporary $Archive) -Algorithm SHA256).Hash
  if ($Actual -ne $Expected) { throw "Release archive checksum does not match" }

  & tar.exe -xzf (Join-Path $Temporary $Archive) -C $Temporary
  if ($LASTEXITCODE -ne 0) { throw "Could not extract the release archive" }
  $SourceDirectory = Join-Path $Temporary "codex-channel-bridge-$Version"
  if (-not (Test-Path $SourceDirectory -PathType Container)) {
    throw "Release archive has an unexpected layout"
  }
  Push-Location $SourceDirectory
  try { $ManifestVersion = & node -p "require('./package.json').version" } finally { Pop-Location }
  if ($ManifestVersion -ne $Version) { throw "Release archive version does not match" }

  $Target = Join-Path (Join-Path $InstallRoot "versions") $Version
  if (Test-Path $Target) {
    Push-Location $Target
    try { $InstalledVersion = & node -p "require('./package.json').version" } finally { Pop-Location }
    if ($InstalledVersion -ne $Version -or -not (Test-Path (Join-Path $Target "packages/cli/dist/main.js"))) {
      throw "Target version directory already exists but is incomplete"
    }
  } else {
    $Staging = Join-Path (Join-Path $InstallRoot "versions") ".$Version.staging.$PID"
    Move-Item $SourceDirectory $Staging
    Push-Location $Staging
    try {
      & npm.cmd ci
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) { throw "Bridge build failed" }
    } finally {
      Pop-Location
    }
    if (-not (Test-Path (Join-Path $Staging "packages/cli/dist/main.js"))) {
      throw "Bridge CLI was not built"
    }
    Move-Item $Staging $Target
    $Staging = $null
  }

  $RootFile = Join-Path $BinDirectory "bridge.root"
  $RootTemporary = "$RootFile.tmp.$PID"
  Set-Content -Path $RootTemporary -Value $InstallRoot -Encoding utf8NoBOM
  Move-Item -Force $RootTemporary $RootFile
  $Launcher = Join-Path $BinDirectory "bridge.cmd"
  $LauncherTemporary = "$Launcher.tmp.$PID"
  @'
@echo off
setlocal
set /p "BRIDGE_ROOT="<"%~dp0bridge.root"
set /p "BRIDGE_VERSION="<"%BRIDGE_ROOT%\current"
node "%BRIDGE_ROOT%\versions\%BRIDGE_VERSION%\packages\cli\dist\main.js" %*
'@ | Set-Content -Path $LauncherTemporary -Encoding ascii
  Move-Item -Force $LauncherTemporary $Launcher

  $Current = Join-Path $InstallRoot "current"
  $CurrentTemporary = "$Current.tmp.$PID"
  Set-Content -Path $CurrentTemporary -Value $Version -Encoding ascii
  Move-Item -Force $CurrentTemporary $Current

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $PathEntries = if ($UserPath) { $UserPath -split ';' } else { @() }
  if ($PathEntries -notcontains $BinDirectory) {
    [Environment]::SetEnvironmentVariable("Path", (($PathEntries + $BinDirectory) -join ';'), "User")
    Write-Host "Added $BinDirectory to the user PATH. Open a new terminal before running bridge."
  }
  Write-Host "Codex Channel Bridge $Version is installed."
  Write-Host "Command: $Launcher"
} finally {
  if ($Staging -and (Test-Path $Staging)) { Remove-Item -Recurse -Force $Staging }
  if (Test-Path $Temporary) { Remove-Item -Recurse -Force $Temporary }
}
