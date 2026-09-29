<#
.SYNOPSIS
  本仓库的发布入口：转发到通用发布闸门脚本 `npm-release.ps1`。

.DESCRIPTION
  通用的发布判据与流程（发布前闸门、显式官方 registry、发布时扫描导致的可见延迟、
  shasum 三方一致验收、tag 与 CI 的版本一致性校验）集中维护在**通用发布脚本**里，
  本文件只固定「本仓库」的默认值并原样透传其余参数——同一套判据在仓库内不再存第二份
  （判据只应有一个真源；本仓库只多一个"入口"）。

  通用脚本的定位顺序（自上而下，命中即用）：
    1. 参数 -GenericScript <路径>；
    2. 环境变量 NPM_RELEASE_SCRIPT 指向该脚本；
    3. 技能根（环境变量 DSH_SKILLS_ROOT，缺省 ~/.dsh/skills）下任一技能目录里的
       scripts/npm-release.ps1。
  三处都找不到时打印获取方式并以退出码 2 结束（不会静默什么都不做）。

.EXAMPLE
  # 只跑闸门（最安全，不改动任何东西、不发布）
  pwsh -File scripts/release.ps1 -Mode check

.EXAMPLE
  # 提交 + 打 annotated tag + 推送
  pwsh -File scripts/release.ps1 -Mode tag -Yes -Message "feat: 0.3.0 …"

.EXAMPLE
  # 发布并做发布后验收（等待可见 + shasum 三方比对）
  pwsh -File scripts/release.ps1 -Mode publish

.NOTES
  退出码直接沿用通用脚本：0 = 全部通过；1 = 某一步失败；2 = 参数或前置条件错误。
#>
[CmdletBinding()]
param(
  [ValidateSet('check', 'tag', 'publish', 'all')]
  [string]$Mode = 'check',

  [string]$Registry = 'https://registry.npmjs.org/',

  [string]$Version,

  [string]$Message,

  [switch]$SkipTests,

  [switch]$SkipFingerprint,

  [switch]$SkipBomCheck,

  [string[]]$ExtraPattern,

  [switch]$NoPush,

  [switch]$Yes,

  [switch]$DryRun,

  [int]$VisibilityTimeoutSec = 300,

  # 显式指定通用发布脚本（优先级最高）
  [string]$GenericScript
)

$ErrorActionPreference = 'Stop'

# 本仓库默认值：包目录 = 仓库根（本文件位于 <仓库>/scripts/ 下）
$packageRoot = Split-Path -Parent $PSScriptRoot

function Resolve-GenericReleaseScript {
  param([string]$Explicit)

  if ($Explicit) {
    if (Test-Path -LiteralPath $Explicit) { return (Resolve-Path -LiteralPath $Explicit).Path }
    throw "指定的通用发布脚本不存在：$Explicit"
  }

  $fromEnv = $env:NPM_RELEASE_SCRIPT
  if ($fromEnv -and (Test-Path -LiteralPath $fromEnv)) {
    return (Resolve-Path -LiteralPath $fromEnv).Path
  }

  $skillsRoot = $env:DSH_SKILLS_ROOT
  if (-not $skillsRoot) { $skillsRoot = Join-Path $env:USERPROFILE '.dsh\skills' }
  if (Test-Path -LiteralPath $skillsRoot) {
    $found = @(Get-ChildItem -LiteralPath $skillsRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName 'scripts\npm-release.ps1' } |
      Where-Object { Test-Path -LiteralPath $_ })
    if ($found.Count -gt 0) { return $found[0] }
  }

  return $null
}

$generic = Resolve-GenericReleaseScript -Explicit $GenericScript
if (-not $generic) {
  Write-Host '未找到通用发布脚本 npm-release.ps1。' -ForegroundColor Red
  Write-Host '获取方式（任选其一）：' -ForegroundColor Yellow
  Write-Host '  1) 先从技能备份仓库同步「npm 包发布」技能，再重试；' -ForegroundColor Yellow
  Write-Host '  2) 用 -GenericScript <路径> 显式指定该脚本；' -ForegroundColor Yellow
  Write-Host '  3) 设置环境变量 NPM_RELEASE_SCRIPT 指向该脚本。' -ForegroundColor Yellow
  exit 2
}

$forward = @{
  PackageRoot          = $packageRoot
  Mode                 = $Mode
  Registry             = $Registry
  VisibilityTimeoutSec = $VisibilityTimeoutSec
}
if ($Version) { $forward.Version = $Version }
if ($Message) { $forward.Message = $Message }
if ($SkipTests) { $forward.SkipTests = $true }
if ($SkipFingerprint) { $forward.SkipFingerprint = $true }
if ($SkipBomCheck) { $forward.SkipBomCheck = $true }
if ($ExtraPattern) { $forward.ExtraPattern = $ExtraPattern }
if ($NoPush) { $forward.NoPush = $true }
if ($Yes) { $forward.Yes = $true }
if ($DryRun) { $forward.DryRun = $true }

Write-Host "本仓库发布入口 → 通用脚本：$generic" -ForegroundColor Cyan
& $generic @forward
exit $LASTEXITCODE
