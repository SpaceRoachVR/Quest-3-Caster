[CmdletBinding()]
param(
    [string] $CacheRoot,
    [string] $WslDistribution
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Executable,
        [Parameter(Mandatory = $true)]
        [string[]] $Arguments,
        [Parameter(Mandatory = $true)]
        [string] $Operation
    )

    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Operation failed with exit code $LASTEXITCODE."
    }
}

function ConvertTo-WslPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $WindowsPath,
        [Parameter(Mandatory = $true)]
        [string] $Distribution
    )

    $normalizedPath = $WindowsPath.Replace('\', '/')
    $converted = & wsl.exe -d $Distribution -- wslpath -a $normalizedPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($converted)) {
        throw "Could not convert Windows path for WSL: $WindowsPath"
    }
    return $converted.Trim()
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The native client build requires 64-bit Windows.'
}
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($architecture -ne [System.Runtime.InteropServices.Architecture]::X64) {
    throw "The native client build requires Windows x64; detected $architecture."
}

foreach ($requiredCommand in @('git.exe', 'node.exe', 'wsl.exe')) {
    if (-not (Get-Command $requiredCommand -ErrorAction SilentlyContinue)) {
        throw "Required Windows tool is unavailable: $requiredCommand"
    }
}

# A running adb server keeps adb.exe and its DLLs open, and the staging step
# clears the bundle directory before copying. Windows refuses to delete a
# mapped executable, so the build fails part-way and leaves the bundle
# unusable. Stop the server (and any scrcpy holding it) before staging.
foreach ($lockingProcess in @('scrcpy', 'adb')) {
    Get-Process -Name $lockingProcess -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$dependencyManifestPath = Join-Path $repositoryRoot 'native\dependencies.json'
$dependencyManifest = Get-Content -LiteralPath $dependencyManifestPath -Raw |
    ConvertFrom-Json

if ([string]::IsNullOrWhiteSpace($WslDistribution)) {
    $WslDistribution = [string] $dependencyManifest.toolchain.wslDistribution
}
if ([string]::IsNullOrWhiteSpace($CacheRoot)) {
    $CacheRoot = Join-Path $repositoryRoot '.native-cache'
}
$CacheRoot = [IO.Path]::GetFullPath($CacheRoot)
$finalStageRoot = [IO.Path]::GetFullPath(
    (Join-Path $repositoryRoot 'resources\native\win32-x64')
)
# Build into a sibling directory and swap only once everything succeeded. The
# staging step deletes its target before it has a replacement, so writing
# straight into the live bundle leaves the app unusable whenever a build fails
# part-way -- and a failure part-way is the normal case while iterating.
$stageRoot = "$finalStageRoot.incoming"
if (Test-Path -LiteralPath $stageRoot) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
}
$buildScriptPath = Join-Path $repositoryRoot 'native\build-windows.sh'
$validationScriptPath = Join-Path $repositoryRoot 'scripts\validate-native-dependencies.js'
$manifestScriptPath = Join-Path $repositoryRoot 'scripts\create-native-bundle-manifest.js'
$verificationScriptPath = Join-Path $repositoryRoot 'scripts\verify-native-bundle.js'

$timer = [Diagnostics.Stopwatch]::StartNew()
$validationArguments = @(
    $validationScriptPath,
    $dependencyManifestPath
)
Invoke-CheckedCommand -Executable 'node.exe' -Arguments $validationArguments -Operation 'Native dependency manifest validation'

$availabilityArguments = @(
    '-d',
    $WslDistribution,
    '--',
    'true'
)
Invoke-CheckedCommand -Executable 'wsl.exe' -Arguments $availabilityArguments -Operation "WSL2 distribution '$WslDistribution' availability check"

$aptPackages = [string[]] $dependencyManifest.toolchain.aptPackages
$updateArguments = @(
    '-d',
    $WslDistribution,
    '-u',
    'root',
    '--',
    'env',
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get',
    'update'
)
Invoke-CheckedCommand -Executable 'wsl.exe' -Arguments $updateArguments -Operation 'WSL apt-get update'
$installArguments = @(
    '-d',
    $WslDistribution,
    '-u',
    'root',
    '--',
    'env',
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get',
    'install',
    '-y'
) + $aptPackages
Invoke-CheckedCommand -Executable 'wsl.exe' -Arguments $installArguments -Operation 'WSL native build package installation'

$repositoryRootWsl = ConvertTo-WslPath `
    -WindowsPath $repositoryRoot `
    -Distribution $WslDistribution
$cacheRootWsl = ConvertTo-WslPath `
    -WindowsPath $CacheRoot `
    -Distribution $WslDistribution
$stageRootWsl = ConvertTo-WslPath `
    -WindowsPath $stageRoot `
    -Distribution $WslDistribution
$dependencyManifestWsl = ConvertTo-WslPath `
    -WindowsPath $dependencyManifestPath `
    -Distribution $WslDistribution
$buildScriptWsl = ConvertTo-WslPath `
    -WindowsPath $buildScriptPath `
    -Distribution $WslDistribution

$buildArguments = @(
    '-d',
    $WslDistribution,
    '--',
    'bash',
    $buildScriptWsl,
    $repositoryRootWsl,
    $cacheRootWsl,
    $stageRootWsl,
    $dependencyManifestWsl
)
Invoke-CheckedCommand -Executable 'wsl.exe' -Arguments $buildArguments -Operation 'Pinned WSL2/MinGW native build'

$manifestArguments = @(
    $manifestScriptPath,
    $stageRoot,
    $dependencyManifestPath
)
Invoke-CheckedCommand -Executable 'node.exe' -Arguments $manifestArguments -Operation 'Native bundle manifest creation'
$verificationArguments = @(
    $verificationScriptPath,
    $stageRoot
)
Invoke-CheckedCommand -Executable 'node.exe' -Arguments $verificationArguments -Operation 'Native bundle verification'

# Only now, with a fully built and verified bundle in hand, replace the live
# one. The previous bundle is kept until the swap succeeds so a failure here
# still leaves a working app rather than an empty directory.
$previousStageRoot = "$finalStageRoot.previous"
if (Test-Path -LiteralPath $previousStageRoot) {
    Remove-Item -LiteralPath $previousStageRoot -Recurse -Force
}
if (Test-Path -LiteralPath $finalStageRoot) {
    Move-Item -LiteralPath $finalStageRoot -Destination $previousStageRoot
}
try {
    Move-Item -LiteralPath $stageRoot -Destination $finalStageRoot
} catch {
    # Put the working bundle back before surfacing the failure.
    if ((Test-Path -LiteralPath $previousStageRoot) -and -not (Test-Path -LiteralPath $finalStageRoot)) {
        Move-Item -LiteralPath $previousStageRoot -Destination $finalStageRoot
    }
    throw
}
Remove-Item -LiteralPath $previousStageRoot -Recurse -Force -ErrorAction SilentlyContinue

$timer.Stop()
Write-Output (
    'Native build completed in {0:N1} seconds. Bundle: {1}' -f
        $timer.Elapsed.TotalSeconds,
        $finalStageRoot
)
