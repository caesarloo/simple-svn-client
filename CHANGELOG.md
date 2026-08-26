# Changelog

## [0.1.2] - 2026-08-24

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

## [0.1.0] - 2026-08-23

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
