<#
.SYNOPSIS
Install sculkwire on Windows: the newest release into a managed folder (updated automatically), `sculk` on the user
PATH, then `sculk setup`. install.sh is the Linux and macOS twin: same options, prompts and output.

.DESCRIPTION
Run it from a clone (.\install.ps1 -Yes) or piped (irm <raw url>/install.ps1 | iex). A piped script takes no
parameters: set the SCULKWIRE_* environment variables listed by -Help, or run it as a script block:
& ([scriptblock]::Create((irm <raw url>/install.ps1))) -Yes -Register omp
Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [switch]$Yes,
  [string[]]$Register = @(),
  [string]$Channel = "",
  [string]$Repo = "",
  [switch]$NoPath,
  [switch]$Help
)

# Set only when this runs as a script file; piped through iex it runs in the caller's session, which must not exit.
$sculkwireInstallFile = if ($MyInvocation.MyCommand.CommandType -eq "ExternalScript") { $MyInvocation.MyCommand.Path } else { $null }

# A child scope, so a piped run leaves the caller's variables and $ErrorActionPreference alone.
$sculkwireInstallExit = & {
  # Not "Stop": Windows PowerShell 5.1 with redirected output turns a native command's stderr (git and npm progress)
  # into error records, which "Stop" would make fatal. Native commands are checked through $LASTEXITCODE instead.
  $ErrorActionPreference = "Continue"

  function Say([string]$Message) { [Console]::Error.WriteLine($Message) }
  function Fail([string]$Message) { throw "sculkwire install: $Message" }
  function Usage {
    Say @"
Usage: install.ps1 [-Yes] [-Register omp,claude] [-Channel release|main|off] [-Repo URL] [-NoPath]

  -Yes       ask nothing (no client registration unless -Register)
  -Register  MCP clients to register sculkwire with (omp, claude). The JSON for any other client is printed
  -Channel   update channel: release (default), main, or off for no automatic updates
  -Repo      git URL or local path to install from (default https://github.com/Sculkwire/sculkwire.git)
  -NoPath    do not put sculk on PATH (default: add `$env:SCULKWIRE_BIN_DIR with a sculk.cmd, else the managed
             bin folder, to the user PATH)

Every option can also come from the environment, which works when the script is piped: SCULKWIRE_YES=1,
SCULKWIRE_REGISTER, SCULKWIRE_CHANNEL, SCULKWIRE_REPO, SCULKWIRE_NO_PATH=1.
"@
  }

  try {
    if ($Help) { Usage; return 0 }

    # Parameters win over the environment variables a piped run uses instead.
    $yesOpt = $Yes.IsPresent -or ($env:SCULKWIRE_YES -eq "1")
    $noPathOpt = $NoPath.IsPresent -or ($env:SCULKWIRE_NO_PATH -eq "1")
    $registerOpt = if ($Register.Count) { $Register -join "," } else { "$env:SCULKWIRE_REGISTER" }
    $registerGiven = $registerOpt -ne ""
    $channelOpt = if ($Channel) { $Channel } else { "$env:SCULKWIRE_CHANNEL" }
    $repoOpt = if ($Repo) { $Repo } else { "$env:SCULKWIRE_REPO" }
    $repoGiven = $repoOpt -ne ""
    if (-not $repoGiven) { $repoOpt = "https://github.com/Sculkwire/sculkwire.git" }

    if ($channelOpt -notin "", "release", "main", "off") { Fail "-Channel must be release, main or off" }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is required: install it from https://git-scm.com" }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js 22.18 or newer is required: install it from https://nodejs.org" }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm is required (it comes with Node.js)" }
    node -e "const m=Number(process.versions.node.split('.')[0]); process.exit(m >= 22 && process.features.typescript ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) { Fail "Node.js $(node --version) cannot run sculkwire: install Node.js 22.18 or newer" }

    # Source of the installer code: the clone this script runs from, or a fresh shallow clone.
    $src = $null
    $tmp = $null
    if ($sculkwireInstallFile) {
      $dir = Split-Path -Parent $sculkwireInstallFile
      if (Test-Path (Join-Path $dir "src/update/bootstrap.ts")) { $src = $dir }
    }
    try {
      if (-not $src) {
        $tmp = Join-Path ([IO.Path]::GetTempPath()) ("sculkwire-" + [Guid]::NewGuid().ToString("N"))
        Say "Downloading sculkwire from $repoOpt"
        $env:GIT_TERMINAL_PROMPT = "0"
        git clone --quiet --depth 1 $repoOpt (Join-Path $tmp "sculkwire")
        if ($LASTEXITCODE -ne 0) { Fail "git clone $repoOpt failed. Check the network, the -Repo URL, or your git credentials for a private fork" }
        $src = Join-Path $tmp "sculkwire"
        $repoGiven = $true
      }
      $installArgs = @("--install")
      if ($channelOpt) { $installArgs += @("--channel", $channelOpt) }
      if ($repoGiven) { $installArgs += @("--repo", $repoOpt) }
      Say "Installing the newest sculkwire release (this runs npm ci, about a minute)"
      $launcher = node (Join-Path $src "src/update/bootstrap.ts") @installArgs
      if ($LASTEXITCODE -ne 0 -or -not $launcher) { Fail "installing sculkwire failed (see the message above)" }
      $launcher = "$($launcher | Select-Object -Last 1)".Trim()
    } finally {
      if ($tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }

    if ($noPathOpt) {
      Say "Left PATH unchanged (-NoPath). Run sculkwire as $launcher"
    } else {
      # Windows has no symlink without admin rights: SCULKWIRE_BIN_DIR gets a sculk.cmd that calls the launcher.
      $binDir = Split-Path -Parent $launcher
      if ($env:SCULKWIRE_BIN_DIR) {
        $binDir = $env:SCULKWIRE_BIN_DIR
        $shim = Join-Path $binDir "sculk.cmd"
        Say "Writing $shim -> $launcher (-NoPath skips this)"
        New-Item -ItemType Directory -Force -Path $binDir -ErrorAction Stop | Out-Null
        [IO.File]::WriteAllText($shim, "@`"$launcher`" %*`r`n")
      }
      $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
      $parts = @(if ($userPath) { $userPath -split ";" })
      if ($parts -notcontains $binDir) {
        Say "Adding $binDir to your user PATH, new terminals pick it up (-NoPath skips this)"
        [Environment]::SetEnvironmentVariable("Path", (@($parts + $binDir) | Where-Object { $_ }) -join ";", "User")
      }
      if (($env:Path -split ";") -notcontains $binDir) { $env:Path = "$env:Path;$binDir" }
    }

    # Questions need a console; a redirected stdin (CI, another program) answers nothing.
    $interactive = -not $yesOpt -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected

    if (-not $registerGiven -and $interactive) {
      $detected = @()
      if (Test-Path (Join-Path $HOME ".omp")) { $detected += "omp" }
      if (Get-Command claude -ErrorAction SilentlyContinue) { $detected += "claude" }
      $default = if ($detected.Count) { $detected -join "," } else { "none" }
      $answer = "$(Read-Host "Register sculkwire with which MCP clients? (omp, claude, comma separated, or none) [$default]")".Trim()
      $registerOpt = if ($answer) { $answer } else { $default }
    }

    $setupArgs = @("setup", "--yes")
    if ($registerOpt) { $setupArgs += @("--register", $registerOpt) }
    # The registration JSON goes to the console, not into this block's result.
    & $launcher @setupArgs | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "sculk setup failed" }

    Say ""
    Say "sculkwire is installed. Check it with: sculk doctor"
    return 0
  } catch {
    Say $_.Exception.Message
    return 2
  }
}

$sculkwireInstallExit = @($sculkwireInstallExit)[-1]
if ($sculkwireInstallFile) { exit $sculkwireInstallExit }
$global:LASTEXITCODE = $sculkwireInstallExit
# A piped run defined the parameters in the caller's session too.
Remove-Variable sculkwireInstallFile, sculkwireInstallExit, Yes, Register, Channel, Repo, NoPath, Help -ErrorAction SilentlyContinue
