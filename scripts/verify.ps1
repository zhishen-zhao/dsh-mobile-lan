[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Assert-NativeSuccess {
    param([string]$Step)
    if ($LASTEXITCODE -ne 0) { throw "$Step failed with exit code $LASTEXITCODE" }
}

if ($IsWindows -and -not $env:JAVA_HOME) {
    $studioJbr = 'C:\Program Files\Android\Android Studio\jbr'
    if (Test-Path -LiteralPath (Join-Path $studioJbr 'bin\java.exe')) {
        $env:JAVA_HOME = $studioJbr
        $env:Path = "$env:JAVA_HOME\bin;$env:Path"
    }
}
if ($IsWindows -and -not $env:ANDROID_HOME) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    if (Test-Path -LiteralPath $defaultSdk) {
        $env:ANDROID_HOME = $defaultSdk
        $env:ANDROID_SDK_ROOT = $defaultSdk
    }
}

Push-Location (Join-Path $root 'plugin')
try {
    npm ci
    Assert-NativeSuccess 'plugin npm ci'
    node --check lib/index.js
    Assert-NativeSuccess 'plugin syntax check'
    node --check dist/app.js
    Assert-NativeSuccess 'mobile UI syntax check'
    node test/smoke.mjs
    Assert-NativeSuccess 'plugin smoke tests'
    npm audit --omit=dev
    Assert-NativeSuccess 'plugin dependency audit'
} finally { Pop-Location }

Push-Location (Join-Path $root 'optional\dsh-tool-ssh')
try {
    npm ci
    Assert-NativeSuccess 'SSH npm ci'
    node --check lib/index.js
    Assert-NativeSuccess 'SSH plugin syntax check'
    node --check lib/client.js
    Assert-NativeSuccess 'SSH client syntax check'
    node test/smoke.mjs
    Assert-NativeSuccess 'SSH smoke tests'
    npm audit --omit=dev
    Assert-NativeSuccess 'SSH dependency audit'
} finally { Pop-Location }

Push-Location (Join-Path $root 'android')
try {
    .\gradlew.bat testDebugUnitTest lintDebug assembleDebug
    Assert-NativeSuccess 'Android verification'
} finally { Pop-Location }

Write-Host 'All verification steps passed.' -ForegroundColor Green
