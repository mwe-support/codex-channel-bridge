param([string]$Helper = (Join-Path $PSScriptRoot 'path-acl.ps1'))
$ErrorActionPreference = 'Stop'
$directory = Join-Path ([IO.Path]::GetTempPath()) ('bridge-acl-contract-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
  $file = Join-Path $directory 'fixture.txt'
  [IO.File]::WriteAllText($file, 'fixture')
  foreach ($target in @(@{path=$directory; kind='directory'}, @{path=$file; kind='file'})) {
    foreach ($action in @('secure', 'verify')) {
      foreach ($previous in @($null, 23)) {
        $LASTEXITCODE = $previous
        & $Helper -Action $action -Path $target.path -Kind $target.kind | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'acl_success_exit_code_missing' }
      }
    }
  }
  $LASTEXITCODE = 0
  & $Helper -Action verify -Path (Join-Path $directory 'missing.txt') -Kind file | Out-Null
  if ($LASTEXITCODE -ne 1) { throw 'acl_failure_exit_code_missing' }
  & $Helper -Action verify -Path $file -Kind file | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'acl_stale_failure_exit_code' }
  @{explicitExitCodes=$true; serviceRegistered=$false} | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $directory -Recurse -Force
}
