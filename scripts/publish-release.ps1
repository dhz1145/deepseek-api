# Release from a clean, committed main checkout. The Android signing key stays local.
[CmdletBinding()]
param([Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Notes)

$ErrorActionPreference = 'Stop'
$repo = 'dhz1145/deepseek-api'
$expectedRemote = "https://github.com/$repo.git"

function Invoke-Program([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $Program ($LASTEXITCODE)" }
}

function Get-AndroidVersionCode([string]$BuildGradle) {
    $m = [regex]::Match($BuildGradle, '(?m)^\s*versionCode\s*=\s*([1-9][0-9]*)\s*$')
    if (!$m.Success) { throw 'Missing Android versionCode.' }
    return [int]$m.Groups[1].Value
}

Push-Location -LiteralPath (Join-Path $PSScriptRoot '..')
try {
    if ((Invoke-Program git @('branch', '--show-current')) -ne 'main' -or
        (Invoke-Program git @('status', '--porcelain'))) { throw 'Commit your changes on main first.' }
    if ((Invoke-Program git @('remote', 'get-url', '--push', 'origin')) -cne $expectedRemote) {
        throw "The origin push URL must be $expectedRemote."
    }
    if (!(Test-Path -LiteralPath 'android/app/release.jks' -PathType Leaf) -or
        !(Test-Path -LiteralPath 'android/keystore.properties' -PathType Leaf)) {
        throw 'The original local Android release signing files are required.'
    }
    if (Invoke-Program git @('ls-files', '--', 'android/app/release.jks', 'android/keystore.properties')) {
        throw 'Release signing files must not be tracked by Git.'
    }
    $version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
    if ($version -cnotmatch '^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$') {
        throw 'Expected a stable major.minor.patch version in package.json.'
    }
    $tag = "v$version"
    $code = Get-AndroidVersionCode (Get-Content -LiteralPath 'android/app/build.gradle' -Raw)
    $latest = Invoke-Program gh @('release', 'list', '--repo', $repo, '--exclude-drafts',
        '--exclude-pre-releases', '--json', 'tagName,isLatest', '--jq', '.[] | select(.isLatest) | .tagName')
    if ($latest) {
        if ($latest -cnotmatch '^v\d+\.\d+\.\d+$' -or [version]$version -le [version]$latest.Substring(1)) {
            throw "Raise package.json version above $latest."
        }
        Invoke-Program git @('fetch', '--no-tags', 'origin', "refs/tags/$latest")
        if ($code -le (Get-AndroidVersionCode ((Invoke-Program git @('show', 'FETCH_HEAD:android/app/build.gradle')) -join "`n"))) {
            throw 'Increase the Android versionCode above the currently published release.'
        }
    }

    $sdk = $env:ANDROID_HOME
    if (!$sdk) { $sdk = $env:ANDROID_SDK_ROOT }
    if (!$sdk) { throw 'Set ANDROID_HOME to the Android SDK location.' }
    $tools = Get-ChildItem -LiteralPath (Join-Path $sdk 'build-tools') -Directory |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'apksigner.bat')) } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (!$tools) { throw 'Android build-tools with apksigner.bat are required.' }

    Invoke-Program '.\android\gradlew.bat' @('-p', 'android', ':app:assembleRelease', '--console=plain')
    $directory = (Resolve-Path -LiteralPath 'android/app/build/outputs/apk/release').Path
    $apk = Join-Path $directory "deepseek-api-$tag.apk"
    Copy-Item -LiteralPath (Join-Path $directory 'app-release.apk') -Destination $apk
    $signature = Invoke-Program (Join-Path $tools.FullName 'apksigner.bat') @('verify', '--print-certs', $apk)
    $digest = [regex]::Match(($signature -join "`n"), '(?m)^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})\r?$').Groups[1].Value
    $expected = (Get-Content -LiteralPath 'android/release-signing-cert.sha256' -Raw).Trim()
    if (!$digest -or $digest -ne $expected -or ($signature -match '^Signer #2 ')) {
        throw 'APK certificate does not match the pinned release signing certificate.'
    }
    $metadata = Invoke-Program (Join-Path $tools.FullName 'aapt.exe') @('dump', 'badging', $apk)
    $expectedPackage = "package: name='io.github.dhz1145.dsapi' versionCode='$code' versionName='$version'"
    if (!($metadata | Where-Object { $_.StartsWith($expectedPackage) }) -or
        $metadata -contains 'application-debuggable') { throw 'APK package, version or build type is incorrect.' }

    $head = Invoke-Program git @('rev-parse', 'HEAD')
    if (Invoke-Program git @('tag', '--list', $tag)) {
        if ((Invoke-Program git @('rev-list', '-n', '1', $tag)) -ne $head) {
            throw "Existing local tag $tag does not point to HEAD."
        }
    } else {
        Invoke-Program git @('tag', '-a', $tag, '-m', "DeepSeek API $tag")
    }
    Invoke-Program git @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
        'push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', "refs/tags/$tag`:refs/tags/$tag")
    Invoke-Program gh @('release', 'create', $tag, $apk, '--repo', $repo, '--verify-tag',
        '--latest', '--title', "DeepSeek API $tag", '--notes', $Notes)
} finally {
    Pop-Location
}
