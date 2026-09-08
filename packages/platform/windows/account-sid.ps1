function Resolve-ServiceAccountSid([string]$Account) {
  if ($Account.StartsWith('.\', [StringComparison]::Ordinal)) {
    $Account = [Environment]::MachineName + $Account.Substring(1)
  }
  return [Security.Principal.NTAccount]::new($Account).Translate([Security.Principal.SecurityIdentifier]).Value
}
