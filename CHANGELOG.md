# Changelog

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
