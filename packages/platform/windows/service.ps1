param(
  [Parameter(Mandatory=$true)][ValidateSet('identity','install','start','stop','status','uninstall')][string]$Action,
  [string]$Name,
  [string]$Manifest
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if ($Action -eq 'identity') { @{name=$identity.Name; sid=$identity.User.Value; elevated=(New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Compress; exit 0 }
  if ($Name -notmatch '^[a-z][a-z0-9-]{0,63}$') { throw 'invalid_name' }
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($Action -eq 'status') { @{registered=($null -ne $service); running=($null -ne $service -and $service.Status -eq 'Running')} | ConvertTo-Json -Compress; exit 0 }
  if ($Action -eq 'install') {
    if ($null -ne $service) { throw 'service_already_registered' }
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'administrator_required' }
    $plan = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($plan.name -ne $Name -or $plan.identity -ne $identity.Name) { throw 'selected_identity_mismatch' }
    & (Join-Path $PSScriptRoot 'path-acl.ps1') -Action verify -Path $Manifest -Kind file | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'unsafe_manifest' }
    if (Test-Path -LiteralPath $plan.registrationPath) { throw 'service_adapter_already_exists' }
    Add-Type -Path (Join-Path $PSScriptRoot 'ServiceHost.cs') -OutputAssembly $plan.registrationPath -OutputType WindowsApplication -ReferencedAssemblies System.ServiceProcess,System.Web.Extensions
    & (Join-Path $PSScriptRoot 'path-acl.ps1') -Action secure -Path $plan.registrationPath -Kind file | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'unsafe_adapter' }
    $inputRecord = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ([string]::IsNullOrEmpty($inputRecord.password)) { throw 'service_password_required' }
    $secure = ConvertTo-SecureString $inputRecord.password -AsPlainText -Force
    $credential = New-Object Management.Automation.PSCredential($plan.identity, $secure)
    New-Service -Name $Name -BinaryPathName ('"' + $plan.registrationPath + '"') -StartupType Automatic -Credential $credential | Out-Null
    & sc.exe failure $Name reset= 86400 actions= restart/5000 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'service_recovery_configuration_failed' }
    @{registered=$true; running=$false} | ConvertTo-Json -Compress
    exit 0
  }
  if ($null -eq $service) { throw 'service_not_registered' }
  $registered = Get-CimInstance Win32_Service -Filter ("Name='" + $Name + "'")
  $plan = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($registered.PathName.Trim('"') -ne $plan.registrationPath -or $registered.StartName -ne $plan.identity) { throw 'service_registration_changed' }
  if ($Action -eq 'start') { Start-Service -Name $Name }
  if ($Action -eq 'stop') { Stop-Service -Name $Name }
  if ($Action -eq 'uninstall') {
    if ($service.Status -ne 'Stopped') { throw 'service_must_be_stopped' }
    & sc.exe delete $Name | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'service_delete_failed' }
  }
  @{completed=$true} | ConvertTo-Json -Compress
} catch {
  # Never return PowerShell exceptions containing credentials, raw native config or process arguments.
  $safe = @('administrator_required','selected_identity_mismatch','service_already_registered','service_not_registered','service_registration_changed','service_password_required','service_must_be_stopped','service_adapter_already_exists','unsafe_manifest','unsafe_adapter')
  $reason = if ($safe -contains $_.Exception.Message) { $_.Exception.Message } else { 'windows_service_operation_failed' }
  [Console]::Error.WriteLine($reason)
  exit 1
}
