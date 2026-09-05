$ErrorActionPreference = 'Stop'
$directory = Join-Path ([IO.Path]::GetTempPath()) ('bridge-service-contract-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $directory | Out-Null
try {
  $assembly = Join-Path $directory 'bridge-contract.exe'
  Add-Type -Path (Join-Path $PSScriptRoot 'ServiceHost.cs') -OutputAssembly $assembly -OutputType WindowsApplication -ReferencedAssemblies System.ServiceProcess,System.Web.Extensions
  $loaded = [Reflection.Assembly]::Load([IO.File]::ReadAllBytes($assembly))
  $quote = $loaded.GetType('BridgeServiceHost').GetMethod('Quote', [Reflection.BindingFlags]'NonPublic,Static')
  foreach ($pair in @(@('a b','"a b"'), @('a"b','"a\"b"'), @('C:\end\','"C:\end\\"'))) {
    if ($quote.Invoke($null, @($pair[0])) -cne $pair[1]) { throw 'windows_argument_quote_failed' }
  }
  @{compiled=$true; windowsArgumentQuoting=$true; serviceRegistered=$false} | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $directory -Recurse -Force
}
