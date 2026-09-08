. (Join-Path $PSScriptRoot 'account-sid.ps1')
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.Name.StartsWith([Environment]::MachineName + '\', [StringComparison]::OrdinalIgnoreCase)) {
  @{localAccountFixture=$false} | ConvertTo-Json -Compress
  return
}
$shortName = '.\' + $identity.Name.Substring($identity.Name.IndexOf('\') + 1)
if ((Resolve-ServiceAccountSid $shortName) -ne $identity.User.Value -or
    (Resolve-ServiceAccountSid $identity.Name) -ne $identity.User.Value) { throw 'same_account_sid_mismatch' }
$other = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544').Translate([Security.Principal.NTAccount]).Value
if ((Resolve-ServiceAccountSid $other) -eq $identity.User.Value) { throw 'different_accounts_collapsed' }
$rejected = $false
try { [void](Resolve-ServiceAccountSid ('.\bridge-missing-' + [Guid]::NewGuid().ToString('N'))) }
catch { $rejected = $true }
if (-not $rejected) { throw 'unknown_account_accepted' }
@{localAccountFixture=$true; equivalentSid=$true; differentSidPreserved=$true; unknownAccountRejected=$true} | ConvertTo-Json -Compress
