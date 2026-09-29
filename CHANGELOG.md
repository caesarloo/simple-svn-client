# Changelog

## [0.2.0] - 2026-09-29

### Fixed（正确性）

- **编码不再损坏文本**：解码改为「无损 UTF-8 优先 → GBK/GB18030 择优 → 显式编码」，删除旧版
  「最小替换字符计数」策略与硬编码乱码字表。旧版实测会把 `璐璐的报告` 变成 `?????`、
  把含个别坏字节的正常文本整段变成 latin1 乱码（`latin1` 解码永不产生 U+FFFD，
  而 iconv 的 `?` 替换符又完全不计分，导致最差候选胜出）。
- **中文报错与中文路径不再乱码**：`runRawUtf8` 会把 svn 的 stderr 也强制按 UTF-8 解读，
  中文 Windows 上任何 svn 报错都会变成 `���ǹ�������`；`getWorkingCopyRoot()` 走同一通道，
  中文工作副本路径会得到含 U+FFFD 的不可用路径，进而让 `runSync` 误报「本机未检测到 svn」。
  现统一走同一解码器。
- **update 不再丢冲突**：解析真实的 4 个状态列（内容 / 属性 / 锁 / 树冲突），覆盖
  `C`(冲突) `G`(合并) `R`(替换) `E`(已存在) `B`(阻塞) 与属性-only 修改、shadowed 行；
  旧版只认 `A/U/D`，而 **svn 有冲突时退出码仍是 0**，因此冲突会彻底静默。
- **diff 不再丢内容行**：`---` / `+++` 的 header 判定移入 hunk 之外；旧版会把 hunk 内
  「删除的内容以 `--` 开头」（diff 行 `---x`）与「新增的内容以 `++` 开头」整行丢弃。
- **log 的 XML 实体统一解码**（含数字实体）：旧版只对 status 的路径解码，提交信息里的
  `&`/`<` 原样显示，且含 `&` 的路径无法与变更清单匹配，**提交者归属静默丢失**。
- **status 不再误映射或丢弃**：`external` 不再被当成 `added`（独立为 `external`）；
  `obstructed` / `incomplete` / `replaced` / `ignored` 不再静默消失；
  `props="modified"`（属性-only 修改）与 `tree-conflicted="true"`（树冲突）现在可见；
  截断的 `<entry>` 不再吞掉紧随其后的条目。
- **collectChanges 不再吞点文件**：旧版 `startsWith(".")` 会把 `.obsidian/app.json` 这类
  点文件当作目录项丢掉；目录变更项（`M  dir/`）也不再产生 `file: ""` 的伪条目。
- **diff() 不再用错误信息掩盖真因**：svn 不可用时旧版报的是「未配置文件内容读取器」，
  现同时带出原始 svn 错误；降级为内容预览也不再吞掉认证/超时/超限类错误。
- **`@` 路径转义**：含 `@` 的文件名会被 svn 当作 peg revision（`E205000`），现在补尾部 `@`。
- **输入校验不再误伤合法文件名**：命令通过 `execFile` 执行（无 shell），`& ; | $ \`` 不构成注入，
  旧版一律拒绝会让 `a&b.md`、`a;b.md` 无法提交；现只拒绝控制字符（NUL/CR/LF），
  参数注入由 `safePathArg`（`-` 前缀与 `@` 转义）负责。
- **`execSvn` 的 `code` 类型**：二进制缺失时旧版返回字符串 `"ENOENT"`（类型却声明为 `number`）
  且丢弃诊断；现归一为数字 `127`，并新增可选 `error` 字段。
- **`runSync`**：`repoDir` 传绝对路径时不再拼成 `cwd/C:/abs/repo`（旧版静默回退且无提示）；
  update 带出冲突时 `ok=false` 并在 message 说明冲突数；`snapshot.date` 改用**本地时区**
  ISO（旧版是 UTC，而注释写「最近同步时间」）。
- **frontmatter 解析**：带引号的值不再保留引号；缩进嵌套不再冒充顶层键
  （旧版 `nested:\n  k: v` 会产出 `{nested: null, k: "v"}`）。
- **其他**：输出缓冲上限统一为 64 MiB 且可配（旧版 executor 64 MiB / client 10 MiB 不一致）；
  `add` 去掉 `--force`（旧版会把 ignored 文件一并加入）；`log(limit)` 与 `cat(rev)` 增加参数校验；
  空文件预览返回 0 行（旧版产出 1 行空行）。

### Added

- **冲突守卫**：`SvnClient.findConflicts()` / `hasConflicts()` / `assertNoConflicts()`，
  以及 `commit(..., { assertNoConflicts: true })` 与 `SvnClientOptions.assertNoConflictsOnCommit`。
  判据为「`svn status` 状态位 + 文件内容冲突标记」双保险（跨机同步的脏 `wc.db` 会骗过前者）。
- **`SvnClient.diffSummarizeEntries()`**：保留变更类型字符与目录标记；`diffSummarize()` 改为返回纯路径。
- **新选项**：`logger`（可注入，默认静默）、`outputEncoding`、`maxBufferBytes`、`signal`（可取消）、
  `normalizeDiff`、`legacyStatusMapping`。
- **`SvnError.kind`** 失败分类（`notFound` / `notWorkingCopy` / `conflict` / `auth` / `timeout` /
  `outputLimit` / `aborted` / `unknown`）与 `name`（旧版是 `"Error"`，日志无法区分）。
- **纯函数解析器与编码器已导出**（`parseStatusXml` / `parseUpdateOutput` / `parseDiffOutput` /
  `parseLogXml` / `parseSummarizeOutput` / `decodeSvnOutput` …），便于用真实 svn 输出 fixture 直接单测。
  源码拆分为 `encoding.ts` / `errors.ts` / `exec.ts` / `parsers.ts` + 门面 `svnClient.ts`。
- **返回结构扩展**：`runSync` 新增 `conflicts`；`UpdateResult` 新增 `conflicts` 与
  `summary.conflicted|merged|replaced|propertyModified`；`SvnStatusEntry` 新增
  `propertyModified` / `treeConflicted` / `revision` / `rawItem`。
- `SvnStatusKind` 新增 `replaced` / `obstructed` / `incomplete` / `external` / `ignored`。
- 二进制候选探测结果按「配置路径 + 平台」缓存（旧版每条命令都 spawn 一次 `where svn`）。

### Changed（升级需注意）

- `diff()` 默认**不再**归并「仅空白不同」的改动 —— 旧版会把 `-const a = f(x, y);` /
  `+const a=f(x,y);` 报告为「无差异」。需要旧行为请设 `normalizeDiff: true`。
- `diffSummarize()` 返回纯路径（旧版返回 `"M       path"` 形式的整行）。
- `resolve()` 默认策略仍是 `--accept working`，但已在文档中写明它会**保留冲突标记**，
  并支持 `options.accept` 指定其他策略。
- `SvnStatusKind` 取值集合变化见上；需要旧映射请设 `legacyStatusMapping: true`。
- `UpdateResult.summary` 新增 4 个计数字段：对旧结构做 `toEqual` 的调用方需同步更新。
- `execSvn` 现在也做候选探测（与 `SvnClient` 一致），ENOENT 归一为 `127`。

### Tests

- 39 → **115** 个用例；新增 `parsers` / `encoding` / `frontmatter` 纯函数测试（真实 svn 输出形态
  fixture：属性列、树冲突列、`--` 开头的内容行、XML 实体、自闭合 `<path/>`、GBK 中文）
  与 `svnClient.v2` 端到端修复用例。
- 覆盖率：语句 76.93% → **87.83%**，分支 57.81% → **72.94%**。

### Docs & build

- README 重写为中英双语（结构：它做什么 / 安装 / 使用 / 配置 / 错误处理 / 边界 / License）。
- `CHANGELOG.md` 现在随包发布；新增 `prepublishOnly` 发布闸门（typecheck + test）；
  `build` 先清理 `dist`（避免源文件重命名后旧产物残留进发布物）；
  `tsconfig.build.json` 改为显式 `files` 白名单并开启 `inlineSources`（旧 `.js.map` 指向包内不存在的
  `src/`，是死引用）。
- 修正历史条目日期与实际提交/发布时间不符的问题（0.1.0 → 2026-08-24，0.1.2 / 0.1.3 → 2026-08-26）。

## [0.1.3] - 2026-08-26

### Fixed
- `runSync(cwd, repoDir)` 的 `repoDir` 参数生效：自动探测真实工作副本根
  （`svn info --show-item wc-root`）——先探测 `cwd`，失败再探测 `cwd/repoDir`，以真实根为基准执行
  update/collectChanges。修复「SVN 工作副本位于 vault 子目录」时在非工作副本位置同步失败的问题；
  cwd 本身是工作副本根时行为与旧版完全一致（探测返回 cwd，零行为变化）。
- 新增 `SvnClient.getWorkingCopyRoot(): Promise<string | null>`（svn 1.8+；非工作副本返回 null）。

### Tests
- 新增 1 个用例：工作副本位于 cwd 子目录（vault 根非 SVN）时自动以真实仓库根同步（39 用例全绿）。

## [0.1.2] - 2026-08-26

### Fixed
- `diff()` 行号解析：`parseDiffOutput` 现在解析 hunk 头（`@@ -a,b +c,d @@`）的新文件起始行号，
  不再恒从 1 累计——当 hunk 不从文件第 1 行开始时（如 frontmatter 无变更、hunk 直接从正文开始），
  `DiffLine.lineNumber` 与实际文件行号一致（消费方可正确用行号判定 frontmatter 区块）；
  多 hunk 各自重置行号，兼容省略 `,count` 的单行 hunk 头（`@@ -4 +4 @@`）。

### Tests
- 新增 3 个用例：hunk 非首行起始的行号、多 hunk 行号重置、省略 `,count` 的 hunk 头（38 用例全绿）。

## [0.1.1] - 2026-08-24

### Changed
- 移除对 Node 内置 `fs` 模块的全部依赖（Obsidian 社区审核合规）：
  - svn 二进制候选不再做文件存在性预探测——缺失二进制由 `execFile` 的 ENOENT 回退依次尝试下一候选；
  - 未版本化/新增文件的 diff 预览改为经注入的 `SvnClientOptions.fileContentReader(relativePath) => Promise<Buffer | null>` 读取，
    未配置该回调时预览抛明确错误（`diff()` 的已版本化路径不受影响）。

### Fixed
- ENOENT 诊断增强：Node `spawn` 对「cwd 无效」与「二进制缺失」返回相同的 ENOENT（无法从 error 对象区分），
  最终「未找到 svn 可执行文件」错误消息补充候选路径与当前工作副本路径提示，便于区分两类原因
  （保持零 fs 依赖与「child_process 仅剩 svn」的合规承诺，不额外探测 cwd）。

### Tests
- 新增 5 个用例：`fileContentReader` 未配置抛错 / 配置后正常返回 / 返回 null 抛读取失败、
  首个候选 ENOENT 回退下一候选成功、全部候选 ENOENT 时错误含 cwd 提示（35 用例全绿）。

## [0.1.0] - 2026-08-24

### Added
- `SvnClient` unified implementation merged from the vault-svn (`obsidian-svn`) and `ai-pm-tool`
  plugins: status/update/diff/add/delete/revert/resolve/commit + log/logRange/diffSummarize/cat.
- Windows GBK output decoding with multi-encoding heuristic and mojibake repair.
- Automatic svn binary discovery (configured path → PATH → common install locations).
- Input validation (command injection / path traversal) and `--password` masking.
- `execSvn` low-level executor (never throws), `SvnError`, `isSvnWorkingCopy`, `runSync`.
- `diffFrontmatterFields` / `collectChanges` frontmatter-aware change collection.
- `parseFrontmatter` / `extractFrontmatterBlock` simplified YAML frontmatter parsing.
- `generateSummaryWithFallback` natural-language change summary (from vault-svn's summaryService).
- Jest test suite covering parsing, decoding, validation, commit auto-add, and full sync flow.
