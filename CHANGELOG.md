# Changelog

## [0.1.1] - 2026-08-24

### Changed
- 移除对 Node 内置 `fs` 模块的全部依赖（Obsidian 社区审核合规）：
  - svn 二进制候选不再做文件存在性预探测——缺失二进制由 `execFile` 的 ENOENT 回退依次尝试下一候选；
  - 未版本化/新增文件的 diff 预览改为经注入的 `SvnClientOptions.fileContentReader(relativePath) => Promise<Buffer | null>` 读取，
    未配置该回调时预览抛明确错误（`diff()` 的已版本化路径不受影响）。

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
