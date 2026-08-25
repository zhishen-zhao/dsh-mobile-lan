[CmdletBinding()]
param(
    [string]$Profile = 'web',
    [switch]$SkipAutoStart,
    [switch]$StartHarness,
    # Deprecated compatibility switch. The installer now leaves Harness lifecycle ownership external by default.
    [switch]$DoNotStartHarness
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($StartHarness -and $DoNotStartHarness) {
    throw 'StartHarness and DoNotStartHarness cannot be used together.'
}

if (-not $IsWindows) {
    throw 'The guided installer currently supports Windows only. The plugin and LAN proxy remain cross-platform components.'
}

$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginPath = Join-Path $root 'plugin'
$startScript = Join-Path $PSScriptRoot 'start-mobile-lan.ps1'
$dsh = Get-Command dsh -ErrorAction Stop
[void](Get-Command node -ErrorAction Stop)
$pwsh = (Get-Process -Id $PID).Path

function Assert-NativeSuccess {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

function New-PairingToken {
    $bytes = New-Object byte[] 48
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

$token = [Environment]::GetEnvironmentVariable('DSH_MOBILE_PAIRING_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token) -or [Text.Encoding]::UTF8.GetByteCount($token) -lt 32) {
    $token = New-PairingToken
    [Environment]::SetEnvironmentVariable('DSH_MOBILE_PAIRING_TOKEN', $token, 'User')
    Write-Host 'Created a per-user DSH Mobile pairing secret.' -ForegroundColor Green
} else {
    Write-Host 'Reused the existing per-user DSH Mobile pairing secret.' -ForegroundColor Green
}
$env:DSH_MOBILE_PAIRING_TOKEN = $token

Write-Host "Installing the local plugin into the '$Profile' Harness profile ..." -ForegroundColor Cyan
& $dsh.Source plugin --profile $Profile add $pluginPath
Assert-NativeSuccess 'Harness plugin installation'

if (-not $SkipAutoStart) {
    $taskName = 'DSH Mobile LAN'
    $arguments = "-NoProfile -WindowStyle Hidden -File `"$startScript`""
    if ($StartHarness) { $arguments += ' -StartHarness' }
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument $arguments -WorkingDirectory $root
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the loopback-only DeepSeek Harness mobile TLS proxy attached to the current physical LAN address.' -Force | Out-Null
    Write-Host "Registered the per-user '$taskName' logon task." -ForegroundColor Green
}

$escapedStart = [Regex]::Escape($startScript)
$existingMonitors = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $escapedStart })
foreach ($monitor in $existingMonitors) {
    Stop-Process -Id $monitor.ProcessId -Force -ErrorAction SilentlyContinue
}

# A force-stopped PowerShell monitor cannot run its finally block. Stop only
# this installation's exact proxy script so the replacement can bind cleanly.
$proxyScript = Join-Path $pluginPath 'scripts\lan-proxy.mjs'
$escapedProxy = [Regex]::Escape($proxyScript)
$existingProxies = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match $escapedProxy })
foreach ($proxy in $existingProxies) {
    Stop-Process -Id $proxy.ProcessId -Force -ErrorAction SilentlyContinue
}
if ($existingMonitors.Count -gt 0 -or $existingProxies.Count -gt 0) { Start-Sleep -Milliseconds 500 }

$arguments = @('-NoProfile', '-File', $startScript)
if ($StartHarness) { $arguments += '-StartHarness' }
Start-Process -FilePath $pwsh -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden | Out-Null
Write-Host 'Started the DSH Mobile LAN monitor with the current lifecycle policy.' -ForegroundColor Green

Write-Host ''
Write-Host 'Installation prepared.' -ForegroundColor Green
Write-Host '1. Restart the running Harness once so it receives the new environment secret and browser plugin.'
Write-Host '   The LAN monitor will not start or restart Harness unless install.ps1 -StartHarness was requested.'
Write-Host '2. Open http://127.0.0.1:3080 and choose Settings -> 手机端.'
Write-Host '3. Install the release APK and scan the one-time QR code.'
Write-Host ''
Write-Warning 'The pairing secret, CA private key, and TLS private key stay on this computer and must never be committed or shared.'
