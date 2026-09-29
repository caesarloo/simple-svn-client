<#
.SYNOPSIS
  @caesarloo/simple-svn-client 发布闸门与发布流程（自包含，不依赖本机任何技能/脚本）。

.DESCRIPTION
  把「定版本 → 过闸门 → 构建 → 打包验收 → 提交打 tag → 发布 → 发布后验收」固化成一条命令，
  并把两个容易踩的坑显式处理掉：

    1. registry 指向：本机 npm 默认 registry 可能是镜像站（如 registry.npmmirror.com），
       镜像站不接受发布 —— 脚本一律显式使用官方 registry（可用 -Registry 覆盖）。
    2. 发布前没有闸门：脚本在发布前依次跑类型检查、单元测试、环境指纹自检、构建与打包清单验收；
       任一步失败立即中止，不会带着问题发布。

  模式（默认 check，安全默认：不改动任何东西、不发布）：
    check    只跑闸门（类型检查 / 测试 / 指纹 / 构建 / 打包验收）
    tag      check + 提交 + 打 annotated tag + 推送（先拉取，禁用 rebase 与 force）
    publish  check + 发布到 npm + 发布后验收（远端 shasum 与本地比对）
    all      tag + publish

.EXAMPLE
  pwsh -File scripts/release.ps1 -Mode check
.EXAMPLE
  pwsh -File scripts/release.ps1 -Mode tag -Yes -Message "feat: 0.3.0 …"
.EXAMPLE
  pwsh -File scripts/release.ps1 -Mode publish -Registry https://registry.npmjs.org/
.EXAMPLE
  pwsh -File scripts/release.ps1 -Mode all -Yes -SkipTests   # 紧急修复时的最小闸门

.NOTES
  退出码：0 = 全部通过；1 = 某一步失败（会打印失败步骤与原因）；2 = 参数/前置条件错误。
#>
[CmdletBinding()]
param(
  # 目标版本；缺省取 package.json 的 version
  [string]$Version,

  # 执行模式
  [ValidateSet('check', 'tag', 'publish', 'all')]
  [string]$Mode = 'check',

  # 发布目标 registry（显式指定，避免落到本机默认的镜像站）
  [string]$Registry = 'https://registry.npmjs.org/',

  # 提交信息（仅 tag/all 模式需要；缺省自动生成）
  [string]$Message,

  # 跳过单元测试（其余闸门仍执行）
  [switch]$SkipTests,

  # 跳过环境指纹自检
  [switch]$SkipFingerprint,

  # 追加的指纹正则（本机专属词，如工作区根目录）
  [string[]]$ExtraPattern,

  # 只打 tag 不推送
  [switch]$NoPush,

  # 允许在工作区有未提交改动时继续（tag/all 模式）；不加则中止
  [switch]$Yes,

  # 只做 dry-run：npm publish 用 --dry-run，且不推送
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$script:StepIndex = 0
$script:Failures = New-Object System.Collections.ArrayList

function Write-Section([string]$Title) {
  Write-Host ''
  Write-Host ("=== " + $Title) -ForegroundColor Cyan
}

function Write-Step([string]$Title) {
  $script:StepIndex += 1
  Write-Host ("[{0}] {1}" -f $script:StepIndex, $Title) -ForegroundColor White
}

function Write-Ok([string]$Text) {
  Write-Host ("    PASS  " + $Text) -ForegroundColor Green
}

function Write-Warn2([string]$Text) {
  Write-Host ("    WARN  " + $Text) -ForegroundColor Yellow
}

function Stop-WithFailure([string]$Step, [string]$Reason) {
  [void]$script:Failures.Add("$Step：$Reason")
  Write-Host ("    FAIL  " + $Reason) -ForegroundColor Red
  Write-Host ''
  Write-Host "发布流程中止。失败项：" -ForegroundColor Red
  foreach ($f in $script:Failures) { Write-Host ("  - " + $f) -ForegroundColor Red }
  exit 1
}

function Invoke-Checked([string]$Step, [scriptblock]$Action) {
  Write-Step $Step
  & $Action
  if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) {
    Stop-WithFailure $Step "命令退出码 $LASTEXITCODE"
  }
}

# ---------------------------------------------------------------------------
# 内建环境指纹自检（自包含：规则从环境推导 + 通用形态，不含任何本机字面量）
# ---------------------------------------------------------------------------
function Get-FingerprintPatterns {
  $patterns = New-Object System.Collections.ArrayList

  if ($env:USERNAME) {
    [void]$patterns.Add(@{ Name = '本机用户名'; Pattern = [regex]::Escape($env:USERNAME) })
  }
  if ($env:USERPROFILE) {
    [void]$patterns.Add(@{ Name = '家目录路径'; Pattern = [regex]::Escape($env:USERPROFILE) })
  }
  if ($env:COMPUTERNAME) {
    [void]$patterns.Add(@{ Name = '计算机名'; Pattern = [regex]::Escape($env:COMPUTERNAME) })
  }
  if ($env:USERPROFILE) {
    $parent = Split-Path -Parent $env:USERPROFILE
    if ($parent) {
      [void]$patterns.Add(@{ Name = '用户目录父路径'; Pattern = [regex]::Escape($parent) })
    }
  }

  [void]$patterns.Add(@{ Name = '工作区绝对路径'; Pattern = '[A-Za-z]:\\workspace\\' })
  [void]$patterns.Add(@{ Name = '内网 IP'; Pattern = '\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b' })
  [void]$patterns.Add(@{ Name = '回环地址带端口'; Pattern = '127\.0\.0\.1:\d{2,5}' })
  # 说明：云盘/中转仓库目录名一类规则与「单机环境」强相关，其真源在本机的文档审计工具里，
  # 本脚本不复制一份（避免判据双源，也避免规则文本自指）；需要时用 -ExtraPattern 追加。
  [void]$patterns.Add(@{ Name = '疑似凭据'; Pattern = '(?i)(_authToken\s*=|npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)' })

  if ($ExtraPattern) {
    foreach ($p in $ExtraPattern) {
      if ($p) { [void]$patterns.Add(@{ Name = '自定义规则'; Pattern = $p }) }
    }
  }
  return $patterns
}

function Invoke-FingerprintScan([string]$RepoRoot) {
  $targets = @('src', 'tests', 'README.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json', 'tsconfig.build.json')
  $files = New-Object System.Collections.ArrayList
  foreach ($t in $targets) {
    $p = Join-Path $RepoRoot $t
    if (Test-Path -LiteralPath $p) {
      $item = Get-Item -LiteralPath $p
      if ($item.PSIsContainer) {
        foreach ($f in (Get-ChildItem -LiteralPath $p -Recurse -File)) {
          if ($f.FullName -notmatch '\\node_modules\\') { [void]$files.Add($f.FullName) }
        }
      } else {
        [void]$files.Add($item.FullName)
      }
    }
  }
  if ($files.Count -eq 0) {
    Write-Warn2 '没有可扫描的文件（跳过指纹自检）'
    return
  }

  $patterns = Get-FingerprintPatterns
  $hits = New-Object System.Collections.ArrayList
  foreach ($file in $files) {
    $text = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
    if (-not $text) { continue }
    foreach ($p in $patterns) {
      if ([regex]::IsMatch($text, $p.Pattern)) {
        [void]$hits.Add((Split-Path $file -Leaf) + ' ← ' + $p.Name)
      }
    }
  }
  if ($hits.Count -gt 0) {
    Write-Host "    命中 $($hits.Count) 处：" -ForegroundColor Red
    foreach ($h in ($hits | Select-Object -Unique)) { Write-Host ("      - " + $h) -ForegroundColor Red }
    throw "环境指纹自检未通过（$($hits.Count) 处命中）"
  }
  Write-Ok "扫描 $($files.Count) 个文件，无本机指纹命中"
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
  Write-Host "找不到 package.json：$repo" -ForegroundColor Red
  exit 2
}
$pkgPath = Join-Path $repo 'package.json'
$pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
$pkgName = $pkg.name

if (-not $Version) { $Version = $pkg.version }
if ($Version -ne $pkg.version) {
  Write-Host "版本不一致：package.json = $($pkg.version)，-Version = $Version" -ForegroundColor Red
  exit 2
}
$tag = 'v' + $Version

Write-Host ''
Write-Host "包：$pkgName    版本：$Version    tag：$tag" -ForegroundColor Cyan
Write-Host "模式：$Mode    registry：$Registry" -ForegroundColor Cyan
if ($DryRun) { Write-Host 'dry-run：不会真正发布、不会推送' -ForegroundColor Yellow }

# 0. 前置条件
Write-Section '0. 前置条件'
$changelogPath = Join-Path $repo 'CHANGELOG.md'
if (-not (Test-Path -LiteralPath $changelogPath)) {
  Stop-WithFailure '前置条件' 'CHANGELOG.md 不存在'
}
$changelog = Get-Content -LiteralPath $changelogPath -Raw
if ($changelog -notmatch [regex]::Escape("## [$Version]")) {
  Stop-WithFailure '前置条件' "CHANGELOG.md 缺少 [$Version] 条目"
}
Write-Ok "CHANGELOG 含 [$Version] 条目"

if ($Mode -eq 'tag' -or $Mode -eq 'all') {
  $existingTag = (& git -C $repo tag -l $tag) 2>$null
  if ($existingTag) {
    Stop-WithFailure '前置条件' "本地已存在 tag $tag（如需重来请先删除：git tag -d $tag）"
  }
  $remoteTag = (& git -C $repo ls-remote --tags origin $tag) 2>$null
  if ($remoteTag) {
    Stop-WithFailure '前置条件' "远端已存在 tag $tag"
  }
  Write-Ok "tag $tag 本地/远端均未占用"
}

if ($Mode -eq 'tag' -or $Mode -eq 'all') {
  $dirty = @(& git -C $repo status --porcelain) | Where-Object { $_ -ne '' }
  if ($dirty.Count -gt 0 -and -not $Yes) {
    Write-Host "    工作区有 $($dirty.Count) 项未提交改动：" -ForegroundColor Yellow
    foreach ($d in $dirty) { Write-Host ("      " + $d) -ForegroundColor Yellow }
    Stop-WithFailure '前置条件' '工作区不干净：确认清单无误后加 -Yes 继续'
  }
  if ($dirty.Count -gt 0) { Write-Ok "工作区有 $($dirty.Count) 项待提交改动（已用 -Yes 确认）" }
}

# 1. 闸门：类型检查
Push-Location $repo
try {
  Invoke-Checked '1. 类型检查（tsc --noEmit）' { & npx tsc --noEmit }
  Write-Ok '无类型错误'

  # 2. 闸门：单元测试
  Write-Step '2. 单元测试（jest）'
  if ($SkipTests) {
    Write-Warn2 '已按 -SkipTests 跳过'
  } else {
    $jestOut = & npx jest --coverage=false 2>&1
    $jestOut | Select-String -Pattern 'Test Suites:|Tests:|Snapshots:' | ForEach-Object { Write-Host ('    ' + $_.Line) }
    if ($LASTEXITCODE -ne 0) { Stop-WithFailure '2. 单元测试' "jest 退出码 $LASTEXITCODE" }
    Write-Ok '测试全部通过'
  }

  # 3. 闸门：环境指纹自检
  Write-Step '3. 环境指纹自检'
  if ($SkipFingerprint) {
    Write-Warn2 '已按 -SkipFingerprint 跳过'
  } else {
    Invoke-FingerprintScan $repo
  }

  # 4. 构建
  Invoke-Checked '4. 构建（npm run build）' { & npm run build }
  Write-Ok '构建完成'

  # 5. 打包验收
  Write-Step '5. 打包验收（npm pack）'
  $stage = Join-Path $env:TEMP ('ssc-release-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  try {
    & npm pack --ignore-scripts --pack-destination $stage | Out-Null
    if ($LASTEXITCODE -ne 0) { Stop-WithFailure '5. 打包验收' "npm pack 退出码 $LASTEXITCODE" }
    $tgz = Get-ChildItem -LiteralPath $stage -Filter '*.tgz' | Select-Object -First 1
    if (-not $tgz) { Stop-WithFailure '5. 打包验收' '未生成 tarball' }

    $entries = @(& tar -tzf $tgz.FullName)
    $required = @('package/dist/index.js', 'package/dist/index.d.ts', 'package/LICENSE', 'package/README.md', 'package/CHANGELOG.md')
    $missing = @()
    foreach ($need in $required) {
      if ($entries -notcontains $need) { $missing += $need }
    }
    if ($missing.Count -gt 0) {
      Stop-WithFailure '5. 打包验收' ('tarball 缺少必需文件：' + ($missing -join ', '))
    }
    $localSha1 = (Get-FileHash -LiteralPath $tgz.FullName -Algorithm SHA1).Hash.ToLower()
    Write-Ok ("tarball 含必需文件；{0} 个条目；sha1 = {1}" -f $entries.Count, $localSha1)

    # 6. 提交 / 打 tag / 推送
    if ($Mode -eq 'tag' -or $Mode -eq 'all') {
      Write-Section '6. 提交与 tag'
      $dirtyNow = @(& git -C $repo status --porcelain) | Where-Object { $_ -ne '' }
      if ($dirtyNow.Count -gt 0) {
        & git -C $repo add -A
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '6. 提交与 tag' 'git add 失败' }
        $commitMessage = $Message
        if (-not $commitMessage) { $commitMessage = "release: $Version" }
        & git -C $repo commit -m $commitMessage | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '6. 提交与 tag' 'git commit 失败' }
        Write-Ok "已提交：$commitMessage"
      } else {
        Write-Ok '工作区干净，无需提交'
      }

      & git -C $repo tag -a $tag -m "release $Version"
      if ($LASTEXITCODE -ne 0) { Stop-WithFailure '6. 提交与 tag' "打 tag $tag 失败" }
      Write-Ok "已创建 annotated tag $tag"

      if ($NoPush -or $DryRun) {
        Write-Warn2 '按 -NoPush/-DryRun 跳过推送'
      } else {
        & git -C $repo fetch --prune --tags origin | Out-Null
        # 先拉取再推送：无分叉时快进，真分叉时 merge（不使用 rebase、不使用 force）
        & git -C $repo pull --no-rebase origin master | Out-Null
        if ($LASTEXITCODE -ne 0) {
          & git -C $repo merge --abort 2>$null | Out-Null
          Stop-WithFailure '6. 提交与 tag' '拉取/合并失败（已尝试 merge --abort 回滚，请人工处理后重跑）'
        }
        & git -C $repo push origin master | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '6. 提交与 tag' 'push master 失败' }
        & git -C $repo push origin $tag | Out-Null
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '6. 提交与 tag' "push tag $tag 失败" }
        Write-Ok 'master 与 tag 已推送'
      }
    }

    # 7. 发布到 npm
    if ($Mode -eq 'publish' -or $Mode -eq 'all') {
      Write-Section '7. 发布到 npm'
      Write-Step "7.1 校验 $Registry 登录状态"
      $who = (& npm whoami --registry $Registry 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) {
        Stop-WithFailure '7.1 登录校验' "未登录 $Registry（请先执行：npm login --registry $Registry）"
      }
      Write-Ok "已登录：$who"

      Write-Step '7.2 发布'
      if ($DryRun) {
        & npm publish --dry-run --registry $Registry | Select-String -Pattern 'Publishing|total files|shasum|\+ ' | ForEach-Object { Write-Host ('    ' + $_.Line) }
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '7.2 发布' 'npm publish --dry-run 失败' }
        Write-Warn2 'dry-run：未真正发布'
      } else {
        & npm publish --registry $Registry | Select-String -Pattern 'Publishing|total files|shasum|\+ ' | ForEach-Object { Write-Host ('    ' + $_.Line) }
        if ($LASTEXITCODE -ne 0) { Stop-WithFailure '7.2 发布' "npm publish 退出码 $LASTEXITCODE" }
        Write-Ok "已发布 $pkgName@$Version"

        Write-Step '7.3 发布后验收'
        $remoteSha1 = (& npm view "$pkgName@$Version" dist.shasum --registry $Registry 2>&1 | Out-String).Trim()
        if ($remoteSha1 -ne $localSha1) {
          Write-Warn2 "远端 shasum ($remoteSha1) 与本地 tarball ($localSha1) 不一致 —— 请人工核对内容"
        } else {
          Write-Ok "远端 shasum 与本地一致：$remoteSha1"
        }
        $latest = (& npm view $pkgName dist-tags.latest --registry $Registry 2>&1 | Out-String).Trim()
        Write-Ok "dist-tags.latest = $latest"
      }
    }

    Write-Host ''
    Write-Host ("发布流程完成（模式 $Mode）。") -ForegroundColor Green
    if ($Mode -eq 'check' -or $Mode -eq 'tag') {
      Write-Host "提示：真正发布请用 -Mode publish（或 -Mode all）；首次需先 npm login --registry $Registry" -ForegroundColor Cyan
    }
    Write-Host '提示：本包被 Obsidian 插件以 esbuild 内联打包，发布后需在插件仓库重建 dist 才生效。' -ForegroundColor Cyan
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
} finally {
  Pop-Location
}
