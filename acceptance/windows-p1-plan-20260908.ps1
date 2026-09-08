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
    [ValidateSet('Plan', 'Run', 'Cleanup')][string]$Mode = 'Plan',
    [string]$BridgeRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$NodeExecutable,
    [string]$CodexExecutable,
    [string]$ExpectedIdentitySid,
    [string]$ConfirmServiceName,
    [switch]$ServiceLogonRightConfirmed
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'windows_required' }
$serviceName = 'codex-channel-bridge-p1-20260908'
$runtimeCommit = '3348e3de0990d0be26d192fe22bab05a03deb4c1'
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
$resultPath = Join-Path $testRoot 'result.json'
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
    $start.ArgumentList.Add($entry)
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
        if ($process.ExitCode -ne 0) { throw ('bridge_command_failed_exit_{0}' -f $process.ExitCode) }
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
    $serviceSid = [Security.Principal.NTAccount]::new($service.StartName).Translate([Security.Principal.SecurityIdentifier]).Value
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

$configuration = @{ schemaVersion = 1; supervisor = @{ drainTimeoutMs = 10000; childExitTimeoutMs = 5000 }; profiles = @{} }
$configuration.profiles[$profileId] = @{ workspace = $workspace; codexHome = $codexHome; stateDirectory = $stateDirectory; codexExecutable = $codexPath; channelAccounts = @{} }
$preview = [ordered]@{
    mode = $Mode; serviceName = $serviceName; sourceRuntimeCommit = $runtimeCommit
    backend = 'windows-scm'; startupPolicy = 'automatic at system boot'; installStartsImmediately = $false
    currentIdentity = $identity.Name; currentIdentitySid = $identity.User.Value; elevatedAdministrator = $isAdministrator
    bridgeRoot = $BridgeRoot; bridgeEntry = $entry; bridgeBuilt = (Test-Path -LiteralPath $entry -PathType Leaf); reviewedSourceMatches = $sourceMatches
    node = $nodePath; nodeVersion = $nodeVersion; codex = $codexPath; codexVersion = $codexVersion; codexSha256 = $codexDigest
    testRoot = $testRoot; configuration = $configPath; workspace = $workspace; codexHome = $codexHome; state = $stateDirectory
    configurationPreview = $configuration
    controlPipe = $endpoint; serviceExecutable = $registrationPath; serviceMetadata = $metadataPath; retainedServiceLog = $logPath
    existingTestService = ($null -ne (Get-TestService)); existingTestData = (Test-Path -LiteralPath $testRoot); existingServiceLog = (Test-Path -LiteralPath $logPath)
    requirements = @('Same reviewed identity in an already elevated local terminal', 'SC_MANAGER_CREATE_SERVICE and service start/query/stop/delete rights',
        'File symbolic-link creation permission; no junction/hardlink substitute', 'Administrator confirmation of SeServiceLogonRight and absence of effective SeDenyServiceLogonRight',
        'Existing built reviewed Bridge and administrator-supplied Node/Codex', 'Account password only in the existing CLI hidden terminal prompt')
    steps = @('Explicit authorization and identity checks', 'Create fresh owner-only isolated data and no-Channel configuration', 'Create and verify a real file symlink',
        'Config check, native capability probe and exact CLI service install preview', 'Install without starting', 'Start and wait for SCM/Supervisor/Profile readiness',
        'Stop and verify original process tree exited', 'Restart and verify readiness', 'Uninstall only the owned test registration and verify process exit', 'Preserve all test data and service log')
}
if ($Mode -eq 'Plan') { $preview | ConvertTo-Json -Depth 8; return }
if ($ConfirmServiceName -cne $serviceName -or $ExpectedIdentitySid -cne $identity.User.Value -or $identity.IsSystem -or -not $isAdministrator) {
    throw 'explicit_confirmation_and_same_identity_elevated_terminal_required'
}
if (-not $sourceMatches -or -not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'built_reviewed_bridge_required' }
if ($env:BRIDGE_CONFIG_OVERRIDES_JSON) { throw 'transient_bridge_overrides_not_allowed' }
if ($Mode -eq 'Cleanup') { Remove-OwnedRegistration; [pscustomobject]@{ serviceRemoved = $true; testDataPreserved = $true } | ConvertTo-Json; return }
if (-not $ServiceLogonRightConfirmed) { throw 'service_logon_right_and_deny_policy_must_be_confirmed_without_granting_rights' }
if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { throw 'direct_local_terminal_required_for_hidden_password_entry' }
& $nodePath -e "if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'node_child_requires_a_real_terminal' }
if ($null -ne (Get-TestService) -or (Test-Path -LiteralPath $testRoot) -or (Test-Path -LiteralPath $metadataPath) -or (Test-Path -LiteralPath $registrationPath) -or (Test-Path -LiteralPath $logPath)) {
    throw 'existing_test_service_or_data_preserved_do_not_overwrite'
}
$preview | ConvertTo-Json -Depth 8 | Write-Host
$phase = 'prepare'
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $aclHelper -Action secure -Path $testRoot -Kind directory | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'isolated_directory_acl_failed' }
    foreach ($path in @($workspace, $codexHome, $stateDirectory)) {
        New-Item -ItemType Directory -Path $path | Out-Null
        & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $aclHelper -Action secure -Path $path -Kind directory | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'new_directory_acl_failed' }
        Assert-OwnerOnly $path 'directory'
    }
    Write-NewJson $configPath $configuration
    Write-NewJson $markerPath @{ serviceName = $serviceName; identitySid = $identity.User.Value; sourceCommit = $runtimeCommit; configPath = $configPath; configDigest = (Get-FileHash -LiteralPath $configPath -Algorithm SHA256).Hash }
    $phase = 'file_symlink'
    $target = Join-Path $workspace 'symlink-target.txt'
    $link = Join-Path $workspace 'symlink-link.txt'
    [IO.File]::WriteAllText($target, 'synthetic p1 fixture')
    New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
    $linkInfo = Get-Item -LiteralPath $link -Force
    if ($linkInfo.PSIsContainer -or $linkInfo.LinkType -ne 'SymbolicLink') { throw 'real_file_symlink_not_verified' }
    [void](Invoke-BridgeJson @('config', 'check', '--config', $configPath))
    $nativeProbe = Invoke-BridgeJson @('codex', 'probe', '--codex', $codexPath)
    $phase = 'install'
    $install = Invoke-BridgeJson @('service', 'install', '--name', $serviceName, '--config', $configPath, '--endpoint', $endpoint)
    if ($install.name -ne $serviceName -or $install.identity -ne $identity.Name -or $install.backend -ne 'windows-scm' -or $install.startsImmediately -ne $false -or
        -not (Same-Path $install.registrationPath $registrationPath) -or -not (Same-Path $install.metadataPath $metadataPath)) { throw 'unexpected_install_plan' }
    # Deliberately inherit the terminal. No assignment, pipeline, password argument, or transcript.
    & $nodePath $entry service install --name $serviceName --config $configPath --endpoint $endpoint --confirm $install.confirmationRequired
    if ($LASTEXITCODE -ne 0) { throw 'service_install_failed_registration_may_remain' }
    if ((Assert-OwnedRegistration).State -ne 'Stopped') { throw 'install_started_service_unexpectedly' }
    $phase = 'start_ready'
    [void](Invoke-BridgeJson @('service', 'start', '--name', $serviceName))
    Wait-Ready
    $processes = @(Get-TestProcessSnapshot)
    if ($processes.Count -lt 2) { throw 'test_process_tree_not_observed' }
    $phase = 'stop'
    [void](Assert-OwnedRegistration)
    [void](Invoke-BridgeJson @('service', 'stop', '--name', $serviceName))
    Wait-TestProcessesStopped $processes
    if ((Get-TestService).State -ne 'Stopped') { throw 'service_stop_unverified' }
    $phase = 'restart_ready'
    [void](Assert-OwnedRegistration)
    [void](Invoke-BridgeJson @('service', 'restart', '--name', $serviceName))
    Wait-Ready
    $phase = 'uninstall'
    Remove-OwnedRegistration
    if ($codexDigest -ne (Get-FileHash -LiteralPath $codexPath -Algorithm SHA256).Hash) { throw 'codex_changed_during_acceptance' }
    Write-NewJson $resultPath @{ sourceCommit = $runtimeCommit; nodeVersion = $nodeVersion; codexVersion = $codexVersion; schemaSha256 = $nativeProbe.schemaSha256;
        completed = $true; fileSymlinkVerified = $true; nativeScmLifecycleVerified = $true; testDataPreserved = $true; activeTurnDrainTested = $false; codexUnchanged = $true }
    [pscustomobject]@{ completed = $true; serviceRemoved = $true; testDataPreserved = $true } | ConvertTo-Json
} catch {
    if ((Test-Path -LiteralPath $testRoot) -and -not (Test-Path -LiteralPath $resultPath)) {
        Write-NewJson $resultPath @{ sourceCommit = $runtimeCommit; completed = $false; failedPhase = $phase; nativeScmLifecycleVerified = $false; testDataPreserved = $true; cleanupRequired = ($null -ne (Get-TestService)) }
    }
    throw "p1_failed_at_${phase}; data retained; use ownership-checked Cleanup only if test registration remains"
}
