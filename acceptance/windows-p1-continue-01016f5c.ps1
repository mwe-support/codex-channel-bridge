#Requires -Version 7.0
<#
Preparation artifact. Plan is read-only; Run/Cleanup require separate authorization.
Use an existing pwsh terminal. This script never elevates or installs prerequisites.
Plan prints local identity/paths: do not commit its unredacted console output.
After approval, use the SID shown by the original Plan with ExpectedIdentitySid.
The account password is read only by the existing Bridge CLI's hidden TTY prompt.
Do not redirect the Run invocation or enable terminal transcription/recording.
Failure retains data and registration for explicit, ownership-checked Cleanup.
#>
[CmdletBinding()]
param(
    [ValidateSet('Plan', 'Continue')][string]$Mode = 'Plan',
    [string]$BridgeRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeExecutable,
    [string]$CodexExecutable,
    [Parameter(Mandatory)][string]$AdministrationRoot,
    [string]$ExpectedIdentitySid,
    [string]$ConfirmServiceName,
    [switch]$ServiceLogonRightConfirmed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'windows_required' }
$serviceName = 'codex-channel-bridge-p1-20260908'
$runtimeCommit = 'b40f69dd1625a7a790cab361da01ad0599590520'
$profileId = 'p1-20260908'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$BridgeRoot = (Resolve-Path -LiteralPath $BridgeRoot).ProviderPath
$entry = Join-Path $BridgeRoot 'packages/cli/dist/main.js'
$aclHelper = Join-Path $BridgeRoot 'packages/platform/windows/path-acl.ps1'
$windowsPowerShell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) $serviceName))
$configPath = Join-Path $testRoot 'config.yaml'
$workspace = Join-Path $testRoot 'workspace'
$codexHome = Join-Path $testRoot 'codex-home'
$stateDirectory = Join-Path $testRoot 'state'
$markerPath = Join-Path $testRoot 'ownership.json'
$resultPath = Join-Path $testRoot 'continuation-01016f5c-result.json'
$endpoint = '\\.\pipe\' + $serviceName

function Resolve-Application([string]$Value, [string]$Fallback) {
    if ([string]::IsNullOrWhiteSpace($Value)) {
        return (Get-Command $Fallback -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    }
    $resolved = (Resolve-Path -LiteralPath $Value -ErrorAction Stop).ProviderPath
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw 'executable_file_required' }
    return $resolved
}
$nodePath = Resolve-Application $NodeExecutable 'node'
$nodeVersion = (& $nodePath --version).Trim()
if ($LASTEXITCODE -ne 0) { throw 'node_version_unavailable' }
$codexPath = $null
$codexVersion = 'not_required_for_cleanup'
$codexDigest = $null
if ($Mode -ne 'Cleanup') {
    $codexPath = Resolve-Application $CodexExecutable 'codex'
    $codexVersion = (& $codexPath --version).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'codex_version_unavailable' }
    $codexDigest = (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash
}
$userHome = (& $nodePath -p "require('node:os').homedir()").Trim()
if ($LASTEXITCODE -ne 0) { throw 'current_home_unavailable' }
$metadataPath = Join-Path $userHome ".config/codex-channel-bridge/services/$serviceName.json"
$registrationPath = Join-Path $userHome ".config/codex-channel-bridge/services/$serviceName.exe"
$logPath = Join-Path $userHome ".config/codex-channel-bridge/services/$serviceName.jsonl"
$gitPath = (Get-Command git -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $gitPath -C $BridgeRoot diff --quiet $runtimeCommit -- packages
$sourceMatches = ($LASTEXITCODE -eq 0)
$untrackedSource = @(& $gitPath -C $BridgeRoot ls-files --others --exclude-standard -- packages)
if ($LASTEXITCODE -ne 0) { $sourceMatches = $false }
$sourceMatches = $sourceMatches -and $untrackedSource.Count -eq 0

function Get-TestService {
    return Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction Stop
}
function Same-Path([string]$Left, [string]$Right) {
    return [string]::Equals([IO.Path]::GetFullPath($Left), [IO.Path]::GetFullPath($Right), [StringComparison]::OrdinalIgnoreCase)
}
function Assert-RegularPath([string]$Path, [bool]$Directory) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer -ne $Directory -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unexpected_path_kind' }
}
function Assert-OwnerOnly([string]$Path, [string]$Kind) {
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $aclHelper -Action verify -Path $Path -Kind $Kind | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'owner_only_verification_failed' }
}
function Write-NewJson([string]$Path, [object]$Value) {
    if (Test-Path -LiteralPath $Path) { throw 'refusing_existing_file' }
    [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $aclHelper -Action secure -Path $Path -Kind file | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'new_file_acl_failed' }
    Assert-OwnerOnly $Path 'file'
}
function Invoke-BridgeJson([string[]]$ArgumentList, [int]$TimeoutMs = 120000) {
    $start = [Diagnostics.ProcessStartInfo]::new($nodePath)
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.ArgumentList.Add($adminEntry)
    foreach ($argument in $ArgumentList) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) { throw 'bridge_process_start_failed' }
        $process.StandardInput.Close()
        $output = $process.StandardOutput.ReadToEndAsync()
        $diagnostic = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            $process.Kill($true)
            [void]$process.WaitForExit(5000)
            throw 'bridge_command_timeout_registration_may_remain'
        }
        if ($process.ExitCode -ne 0) {
            $stderr = $diagnostic.GetAwaiter().GetResult()
            $match = [regex]::Match($stderr, 'windows_service_operation_failed_(identity|install|start|stop|status|uninstall|manifest|compile|adapter_acl|credential|create|recovery)_(win32|hresult|exit)_-?\d{1,10}(?!\d)')
            if ($match.Success) { throw $match.Value }
            if ($stderr -match '\(service_registration_changed\)') { throw 'service_registration_changed' }
            throw ('bridge_command_failed_exit_{0}' -f $process.ExitCode)
        }
        return $output.GetAwaiter().GetResult() | ConvertFrom-Json
    } finally { $process.Dispose() }
}
function Assert-OwnedRegistration {
    Assert-RegularPath $testRoot $true
    Assert-OwnerOnly $testRoot 'directory'
    Assert-OwnerOnly $markerPath 'file'
    Assert-OwnerOnly $metadataPath 'file'
    Assert-OwnerOnly $registrationPath 'file'
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($marker.serviceName -ne $serviceName -or $marker.identitySid -ne $identity.User.Value -or
        $marker.sourceCommit -ne $runtimeCommit -or -not (Same-Path $marker.configPath $configPath) -or
        $marker.configDigest -ne (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash) { throw 'test_ownership_marker_mismatch' }
    if ($metadata.name -ne $serviceName -or $metadata.identity -ne $identity.Name -or $metadata.backend -ne 'windows-scm' -or
        $metadata.endpoint -ne $endpoint -or -not (Same-Path $metadata.configPath $configPath) -or
        -not (Same-Path $metadata.entry $entry) -or -not (Same-Path $metadata.node $nodePath) -or
        -not (Same-Path $metadata.registrationPath $registrationPath)) { throw 'service_metadata_mismatch' }
    $service = Get-TestService
    if ($null -eq $service) { throw 'test_service_not_registered' }
    $serviceSid = Resolve-ServiceAccountSid $service.StartName
    if ($serviceSid -ne $identity.User.Value -or -not (Same-Path $service.PathName.Trim('"') $registrationPath)) { throw 'native_service_ownership_mismatch' }
    return $service
}
function Get-TestProcessSnapshot {
    $service = Assert-OwnedRegistration
    if ($service.ProcessId -eq 0) { return @() }
    $queue = [Collections.Generic.Queue[uint32]]::new()
    $seen = [Collections.Generic.HashSet[uint32]]::new()
    $queue.Enqueue([uint32]$service.ProcessId)
    while ($queue.Count -gt 0) {
        $processId = $queue.Dequeue()
        if (-not $seen.Add($processId)) { continue }
        if ($seen.Count -gt 128) { throw 'unexpected_test_process_tree_size' }
        $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
        if ($null -ne $process) { [pscustomobject]@{ Id = $process.ProcessId; Created = $process.CreationDate } }
        foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$processId")) { $queue.Enqueue([uint32]$child.ProcessId) }
    }
}
function Wait-Ready {
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    do {
        [void](Assert-OwnedRegistration)
        $status = Invoke-BridgeJson @('service', 'status', '--name', $serviceName, '--json') 15000
        if ($status.registered -and $status.serviceRunning -and $null -ne $status.supervisor -and $status.supervisor.liveness -eq 'live') {
            $profiles = @($status.supervisor.profiles | Where-Object profileId -eq $profileId)
            if ($profiles.Count -eq 1 -and $profiles[0].readiness -eq 'ready') { return }
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'service_or_profile_readiness_unverified'
}
function Wait-TestProcessesStopped([object[]]$Snapshot) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $remaining = @($Snapshot | Where-Object {
            $observed = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)"
            $null -ne $observed -and $observed.CreationDate -eq $_.Created
        })
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'owned_test_processes_still_running'
}
function Remove-OwnedRegistration {
    [void](Assert-OwnedRegistration)
    $logExisted = Test-Path -LiteralPath $logPath
    $processes = @(Get-TestProcessSnapshot)
    $removal = Invoke-BridgeJson @('service', 'uninstall', '--name', $serviceName)
    if (-not (Same-Path $removal.registrationPath $registrationPath) -or -not (Same-Path $removal.metadataPath $metadataPath) -or
        $removal.confirmationRequired -notmatch '^[a-f0-9]{64}$') { throw 'unexpected_uninstall_plan' }
    [void](Invoke-BridgeJson @('service', 'uninstall', '--name', $serviceName, '--confirm', $removal.confirmationRequired))
    Wait-TestProcessesStopped $processes
    if ($null -ne (Get-TestService) -or (Test-Path -LiteralPath $metadataPath) -or (Test-Path -LiteralPath $registrationPath)) { throw 'uninstall_not_verified' }
    foreach ($path in @($configPath, $workspace, $codexHome, $stateDirectory, $markerPath)) {
        if (-not (Test-Path -LiteralPath $path)) { throw 'test_data_was_not_preserved' }
    }
    if ($logExisted -and -not (Test-Path -LiteralPath $logPath)) { throw 'service_log_was_not_preserved' }
    $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($marker.configDigest -ne (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash) { throw 'configuration_changed_during_cleanup' }
}

$administrationCommit = '01016f5c730c3c96e42ed1aa0ac32b1ad78cb729'
$AdministrationRoot = (Resolve-Path -LiteralPath $AdministrationRoot).ProviderPath
$adminEntry = Join-Path $AdministrationRoot 'packages/cli/dist/main.js'
if ((& $gitPath -C $AdministrationRoot rev-parse HEAD).Trim() -cne $administrationCommit) { throw 'administration_revision_mismatch' }
& $gitPath -C $AdministrationRoot diff --quiet $administrationCommit -- packages
if ($LASTEXITCODE -ne 0 -or @(& $gitPath -C $AdministrationRoot ls-files --others --exclude-standard -- packages).Count -ne 0 -or -not (Test-Path -LiteralPath $adminEntry)) { throw 'administration_source_or_build_mismatch' }
$changes = @(& $gitPath -C $AdministrationRoot diff --name-only $runtimeCommit $administrationCommit -- packages)
if (@($changes | Where-Object { $_ -notin @('packages/platform/platform.test.mjs','packages/platform/windows/account-sid.ps1','packages/platform/windows/account-sid.contract.ps1','packages/platform/windows/service.ps1') }).Count) { throw 'service_runtime_change_not_authorized' }
. (Join-Path $AdministrationRoot 'packages/platform/windows/account-sid.ps1')
if (-not $sourceMatches -or -not (Test-Path -LiteralPath $entry)) { throw 'original_runtime_changed' }
$observed = Assert-OwnedRegistration
if ($observed.State -ne 'Stopped' -or $observed.ProcessId -ne 0) { throw 'existing_registration_must_be_stopped' }
$preview = @{ administrationCommit=$administrationCommit; serviceRuntimeCommit=$runtimeCommit; ownedRegistrationVerified=$true; state='Stopped'; installsService=$false; requiresPassword=$false }
if ($Mode -eq 'Plan') { $preview | ConvertTo-Json; return }
if ($identity.User.Value -cne $ExpectedIdentitySid -or -not $isAdministrator -or $ConfirmServiceName -cne $serviceName -or -not $ServiceLogonRightConfirmed) { throw 'authorized_same_identity_prerequisites_required' }
if (Test-Path -LiteralPath $resultPath) { throw 'continuation_already_has_result' }
$phase = 'postinstall_verified'
try {
    Write-NewJson (Join-Path $testRoot 'continuation-01016f5c-postinstall.json') $preview
    $phase = 'start_ready'
    [void](Invoke-BridgeJson @('service', 'start', '--name', $serviceName))
    Wait-Ready
    Write-NewJson (Join-Path $testRoot 'continuation-01016f5c-start-ready.json') @{ serviceRunning=$true;supervisorLive=$true;profileReady=$true }
    $processes = @(Get-TestProcessSnapshot)
    if ($processes.Count -lt 2) { throw 'test_process_tree_not_observed' }
    $phase = 'stop'
    [void](Assert-OwnedRegistration)
    [void](Invoke-BridgeJson @('service', 'stop', '--name', $serviceName))
    Wait-TestProcessesStopped $processes
    if ((Get-TestService).State -ne 'Stopped') { throw 'service_stop_unverified' }
    Write-NewJson (Join-Path $testRoot 'continuation-01016f5c-stop.json') @{ serviceStopped=$true;originalProcessTreeExited=$true }
    $phase = 'restart_ready'
    [void](Assert-OwnedRegistration)
    [void](Invoke-BridgeJson @('service', 'restart', '--name', $serviceName))
    Wait-Ready
    Write-NewJson (Join-Path $testRoot 'continuation-01016f5c-restart-ready.json') @{ serviceRunning=$true;supervisorLive=$true;profileReady=$true }
    $phase = 'uninstall'
    Remove-OwnedRegistration
    Write-NewJson (Join-Path $testRoot 'continuation-01016f5c-uninstall.json') @{ registrationRemoved=$true;processTreeExited=$true;testDataPreserved=$true }
    if ($codexDigest -ne (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash) { throw 'codex_changed_during_acceptance' }
    Write-NewJson $resultPath @{ completed=$true;administrationCommit=$administrationCommit;serviceRuntimeCommit=$runtimeCommit;nativeScmLifecycleVerified=$true;testDataPreserved=$true;activeTurnDrainTested=$false;codexUnchanged=$true }
} catch {
    $reason = if ($_.Exception.Message -match '^[a-z][a-z0-9_-]{0,150}$') { $_.Exception.Message } else { 'continuation_assertion_failed' }
    $native = $null
    if ($reason -match '^windows_service_operation_failed_([a-z_]+)_(win32|hresult|exit)_(-?\d{1,10})$') { $native=@{stage=$Matches[1];kind=$Matches[2];code=[long]$Matches[3]} }
    if (-not (Test-Path -LiteralPath $resultPath)) { Write-NewJson $resultPath @{ completed=$false;administrationCommit=$administrationCommit;serviceRuntimeCommit=$runtimeCommit;failedPhase=$phase;reason=$reason;nativeFailure=$native;cleanupRequired=($null -ne (Get-TestService));testDataPreserved=$true } }
    Write-Host ('Stopped at ' + $phase + ': ' + $reason)
    return
}
Get-Content -LiteralPath $resultPath -Raw | Write-Host