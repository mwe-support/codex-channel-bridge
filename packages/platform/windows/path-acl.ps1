param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("secure", "verify")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$Path,
  [Parameter(Mandatory = $true)]
  [ValidateSet("file", "directory")]
  [string]$Kind,
  [switch]$Recursive
)

$current = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier("S-1-5-18")
$administrators = New-Object Security.Principal.SecurityIdentifier("S-1-5-32-544")
$allowed = @($current.Value, $system.Value, $administrators.Value)

function Assert-Acl([string]$Target, [string]$ExpectedKind) {
  $isDirectory = [IO.Directory]::Exists($Target)
  $isFile = [IO.File]::Exists($Target)
  if (($ExpectedKind -eq "directory" -and -not $isDirectory) -or
      ($ExpectedKind -eq "file" -and -not $isFile)) { throw "wrong_path_kind" }
  if (([IO.File]::GetAttributes($Target) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "reparse_point"
  }
  $acl = if ($isDirectory) {
    [IO.Directory]::GetAccessControl($Target)
  } else {
    [IO.File]::GetAccessControl($Target)
  }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $current.Value) {
    throw "unexpected_owner"
  }
  $found = @{}
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $allowed -notcontains $sid -or
        (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne
          [Security.AccessControl.FileSystemRights]::FullControl)) { throw "unexpected_acl" }
    $found[$sid] = $true
  }
  foreach ($sid in $allowed) { if (-not $found[$sid]) { throw "incomplete_acl" } }
}

try {
  if ($Action -eq "secure") {
    if ($Kind -eq "directory") {
      $acl = New-Object Security.AccessControl.DirectorySecurity
      $inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
        [Security.AccessControl.InheritanceFlags]::ObjectInherit
      foreach ($sid in @($current, $system, $administrators)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
          $sid,
          [Security.AccessControl.FileSystemRights]::FullControl,
          $inheritance,
          [Security.AccessControl.PropagationFlags]::None,
          [Security.AccessControl.AccessControlType]::Allow
        )))
      }
    } else {
      $acl = New-Object Security.AccessControl.FileSecurity
      foreach ($sid in @($current, $system, $administrators)) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
          $sid,
          [Security.AccessControl.FileSystemRights]::FullControl,
          [Security.AccessControl.AccessControlType]::Allow
        )))
      }
    }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($current)
    if ($Kind -eq "directory") {
      [IO.Directory]::SetAccessControl($Path, $acl)
    } else {
      [IO.File]::SetAccessControl($Path, $acl)
    }
  }

  Assert-Acl $Path $Kind
  if ($Recursive) {
    $pending = New-Object "Collections.Generic.Stack[string]"
    $pending.Push($Path)
    while ($pending.Count -gt 0) {
      $directory = $pending.Pop()
      foreach ($file in [IO.Directory]::EnumerateFiles($directory)) {
        Assert-Acl $file "file"
      }
      foreach ($child in [IO.Directory]::EnumerateDirectories($directory)) {
        Assert-Acl $child "directory"
        $pending.Push($child)
      }
    }
  }
} catch {
  [Console]::Error.WriteLine("windows_path_acl_failed")
  exit 1
}
