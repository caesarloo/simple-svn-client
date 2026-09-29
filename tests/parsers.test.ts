/**
 * 纯函数解析器测试 —— 全部输入为「真实 svn 输出形态」的 fixture 文本。
 *
 * 这些用例是 v0.2.0 的回归底线：旧版只能用 jest.mock("node:child_process") 间接测解析器，
 * 真实输出形态（属性列、树冲突列、`--` 开头的内容行、XML 实体、自闭合 path）从未被覆盖。
 *
 * 形态依据：Apache Subversion `subversion/svn/notify.c`（update 输出列）与
 * `subversion/svn/schema/status.rnc`（status XML）；SVN Book「svn update」输出图例。
 */
import {
  decodeXmlEntities,
  normalizeDiffLines,
  parseDiffOutput,
  parseLogXml,
  parseStatusXml,
  parseSummarizeOutput,
  parseUpdateLine,
  parseUpdateOutput,
} from "../src/index";

describe("parseStatusXml（svn status --xml）", () => {
  const buildXml = (entries: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<status>\n<target path=".">\n${entries}</target>\n</status>`;

  test("全部 wc-status item 取值都被映射（v0.1.3 会丢弃或错映射冷门取值）", () => {
    const xml = buildXml(
      [
        '<entry path="a.md"><wc-status item="added" props="none"/></entry>',
        '<entry path="m.md"><wc-status item="modified" props="none"/></entry>',
        '<entry path="d.md"><wc-status item="deleted" props="none"/></entry>',
        '<entry path="c.md"><wc-status item="conflicted" props="none"/></entry>',
        '<entry path="u.md"><wc-status item="unversioned" props="none"/></entry>',
        '<entry path="x.md"><wc-status item="missing" props="none"/></entry>',
        '<entry path="r.md"><wc-status item="replaced" props="none"/></entry>',
        '<entry path="o.md"><wc-status item="obstructed" props="none"/></entry>',
        '<entry path="i.md"><wc-status item="incomplete" props="none"/></entry>',
        '<entry path="e.md"><wc-status item="external" props="none"/></entry>',
        '<entry path="g.md"><wc-status item="ignored" props="none"/></entry>',
        '<entry path="n.md"><wc-status item="normal" props="none"/></entry>',
      ].join("\n")
    );
    const byPath = new Map(parseStatusXml(xml).map((e) => [e.path, e.status]));
    expect(byPath.get("a.md")).toBe("added");
    expect(byPath.get("m.md")).toBe("modified");
    expect(byPath.get("d.md")).toBe("deleted");
    expect(byPath.get("c.md")).toBe("conflict");
    expect(byPath.get("u.md")).toBe("untracked");
    expect(byPath.get("x.md")).toBe("missing");
    // 旧版：replaced/obstructed/incomplete/ignored 被静默丢弃
    expect(byPath.get("r.md")).toBe("replaced");
    expect(byPath.get("o.md")).toBe("obstructed");
    expect(byPath.get("i.md")).toBe("incomplete");
    expect(byPath.get("g.md")).toBe("ignored");
    // 旧版：external 被错误映射为 added
    expect(byPath.get("e.md")).toBe("external");
    // item=normal 且无属性/树冲突变更 → 不产生条目
    expect(byPath.has("n.md")).toBe(false);
  });

  test("item=normal 但 props=modified（属性-only 修改）不再被丢弃", () => {
    const xml = buildXml('<entry path="p.md"><wc-status item="normal" props="modified" revision="7"/></entry>');
    const entries = parseStatusXml(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("modified");
    expect(entries[0].propertyModified).toBe(true);
    expect(entries[0].revision).toBe("7");
  });

  test("item=normal 但 tree-conflicted=true（树冲突）映射为 conflict 并标记", () => {
    const xml = buildXml('<entry path="t.md"><wc-status item="normal" props="none" tree-conflicted="true"/></entry>');
    const entries = parseStatusXml(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("conflict");
    expect(entries[0].treeConflicted).toBe(true);
  });

  test("路径中的 XML 实体与反斜杠均被正确还原", () => {
    const xml = buildXml(
      '<entry path="a&amp;b.md"><wc-status item="modified"/></entry>\n' +
        '<entry path="dir\\sub\\c.md"><wc-status item="modified"/></entry>'
    );
    const paths = parseStatusXml(xml).map((e) => e.path);
    expect(paths).toContain("a&b.md");
    expect(paths).toContain("dir/sub/c.md");
    const entry = parseStatusXml(xml).find((e) => e.path === "dir/sub/c.md");
    expect(entry?.fileName).toBe("c.md");
    expect(entry?.folderPath).toBe("dir/sub");
  });

  test("截断的 entry（缺 </entry>）不会吞掉紧随其后的 entry", () => {
    const xml = buildXml(
      '<entry path="trunc.md"><wc-status item="modified" props="none"/>\n' +
        '<entry path="after.md"><wc-status item="added" props="none"/></entry>'
    );
    const entries = parseStatusXml(xml);
    expect(entries.map((e) => e.path)).toEqual(["trunc.md", "after.md"]);
    expect(entries[1].status).toBe("added");
  });

  test("legacyStatusMapping: true 恢复 v0.1.3 映射", () => {
    const xml = buildXml(
      '<entry path="e.md"><wc-status item="external"/></entry>\n' +
        '<entry path="r.md"><wc-status item="replaced"/></entry>\n' +
        '<entry path="p.md"><wc-status item="normal" props="modified"/></entry>'
    );
    const entries = parseStatusXml(xml, { legacyStatusMapping: true });
    expect(entries).toEqual([
      { path: "e.md", fileName: "e.md", folderPath: "", status: "added", rawItem: "external" },
    ]);
  });

  test("空 XML 返回空数组", () => {
    expect(parseStatusXml("")).toEqual([]);
  });
});

describe("parseUpdateOutput（svn update 真实输出列）", () => {
  /** svn 1.7+ 的 4 列格式：内容列 / 属性列 / 锁列 / 树冲突列，形态取自 notify.c */
  const REAL_OUTPUT = [
    "Updating '.':",
    "A    added.md",
    "U    updated.md",
    "D    deleted.md",
    "G    merged.md",
    "C    conflicted.md",
    "R    replaced.md",
    "E    existed.md",
    " U   props-only.md",
    "   C tree-conflict.md",
    "   A shadowed.md",
    "Updated to revision 42.",
    "Summary of conflicts:",
    "  Text conflicts: 1",
  ].join("\n");

  test("内容列 A/U/D/G/C/R/E 全部被识别（旧版只认 A/U/D）", () => {
    const { entries } = parseUpdateOutput(REAL_OUTPUT);
    const byPath = new Map(entries.map((e) => [e.path, e.status]));
    expect(byPath.get("added.md")).toBe("added");
    expect(byPath.get("updated.md")).toBe("modified");
    expect(byPath.get("deleted.md")).toBe("deleted");
    expect(byPath.get("merged.md")).toBe("merged");
    expect(byPath.get("conflicted.md")).toBe("conflicted");
    expect(byPath.get("replaced.md")).toBe("replaced");
    expect(byPath.get("existed.md")).toBe("existed");
  });

  test("属性列（第二列）与树冲突列（第四列）不再被整行丢弃", () => {
    const { entries } = parseUpdateOutput(REAL_OUTPUT);
    const propsOnly = entries.find((e) => e.path === "props-only.md");
    expect(propsOnly?.status).toBe("modified");
    expect(propsOnly?.propertyModified).toBe(true);

    const tree = entries.find((e) => e.path === "tree-conflict.md");
    expect(tree?.status).toBe("conflicted");
    expect(tree?.treeConflicted).toBe(true);

    expect(entries.find((e) => e.path === "shadowed.md")?.status).toBe("added");
  });

  test("冲突明细被汇总（文本/属性/树），这是「冲突时 svn 仍返回 0」时唯一的信号", () => {
    const { conflicts } = parseUpdateOutput(REAL_OUTPUT);
    expect(conflicts).toEqual([
      { path: "conflicted.md", kind: "text", raw: "C    conflicted.md" },
      { path: "tree-conflict.md", kind: "tree", raw: "   C tree-conflict.md" },
    ]);
  });

  test("summary 计数覆盖全部状态类别", () => {
    const { summary } = parseUpdateOutput(REAL_OUTPUT);
    expect(summary).toEqual({
      total: 10,
      added: 2, // added.md + shadowed.md
      modified: 2, // updated.md + props-only.md
      deleted: 1,
      conflicted: 2, // conflicted.md + tree-conflict.md
      merged: 1,
      replaced: 1,
      propertyModified: 1,
      totalSize: 0,
    });
  });

  test("非状态行（Updating/Updated to/Summary of conflicts）不被误认", () => {
    const { entries } = parseUpdateOutput("Updating '.':\nUpdated to revision 42.\nSummary of conflicts:\n  Text conflicts: 1");
    expect(entries).toEqual([]);
  });

  test("兼容窄格式（单空格）与无变化输出", () => {
    const { entries, summary } = parseUpdateOutput("A 新增.md\nU 修改.md\nD 删除.md");
    expect(entries.map((e) => e.path)).toEqual(["新增.md", "修改.md", "删除.md"]);
    expect(summary.total).toBe(3);
    expect(summary.conflicted).toBe(0);
  });

  test("parseUpdateLine 解析单行的四列语义", () => {
    expect(parseUpdateLine(" U   x.md")).toEqual({ col1: " ", col2: "U", col3: " ", col4: " ", path: "x.md" });
    expect(parseUpdateLine("   C y.md")).toEqual({ col1: " ", col2: " ", col3: " ", col4: "C", path: "y.md" });
    expect(parseUpdateLine("A    z.md")).toEqual({ col1: "A", col2: " ", col3: " ", col4: " ", path: "z.md" });
    expect(parseUpdateLine("Updated to revision 1.")).toBeNull();
  });
});

describe("parseDiffOutput（svn diff）", () => {
  const buildDiff = (body: string[]): string =>
    ["Index: a.md", "=".repeat(67), "--- a.md\t(revision 5)", "+++ a.md\t(working copy)", ...body].join("\n");

  test("hunk 内以 -- / ++ 开头的内容行不再被当 header 丢弃（旧版整行消失）", () => {
    const diff = buildDiff(["@@ -1,4 +1,4 @@", " keep", "---x", "+++y", " tail"]);
    const { lines } = parseDiffOutput("a.md", diff, "working-copy");
    expect(lines.map((l) => [l.type, l.content])).toEqual([
      ["unchanged", "keep"],
      ["deleted", "--x"],
      ["added", "++y"],
      ["unchanged", "tail"],
    ]);
  });

  test("CSS 自定义属性样式的删除行（---main-color）保留", () => {
    const diff = buildDiff(["@@ -1,2 +1,2 @@", " body {", "---main-color: red;", "++main-color: blue;"]);
    const { lines } = parseDiffOutput("a.md", diff, "working-copy");
    expect(lines.filter((l) => l.type !== "unchanged")).toEqual([
      { lineNumber: 2, content: "--main-color: red;", type: "deleted" },
      { lineNumber: 2, content: "+main-color: blue;", type: "added" },
    ]);
  });

  test("header 行本身仍被跳过；hunk 行号按 +c 起始", () => {
    const diff = buildDiff(["@@ -10,2 +10,3 @@", " ctx", "+new", " ctx2"]);
    const { lines } = parseDiffOutput("a.md", diff, "working-copy");
    expect(lines.map((l) => l.lineNumber)).toEqual([10, 11, 12]);
    expect(lines.some((l) => l.content.includes("revision 5"))).toBe(false);
  });

  test("多文件 diff：第二个 Index 结束前一个 hunk", () => {
    const output = [
      "Index: a.md",
      "=".repeat(67),
      "--- a.md\t(revision 1)",
      "+++ a.md\t(working copy)",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "Index: b.md",
      "=".repeat(67),
      "--- b.md\t(revision 1)",
      "+++ b.md\t(working copy)",
      "@@ -1 +1 @@",
      "-b-old",
      "+b-new",
    ].join("\n");
    const { lines } = parseDiffOutput("a.md", output, "working-copy");
    expect(lines.map((l) => l.content)).toEqual(["old", "new", "b-old", "b-new"]);
  });

  test("\\ No newline at end of file 被忽略", () => {
    const diff = buildDiff(["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"]);
    const { lines } = parseDiffOutput("a.md", diff, "working-copy");
    expect(lines.map((l) => l.content)).toEqual(["a", "b"]);
  });

  test("normalizeDiffLines（仅供显式开启）恢复旧的「忽略空白/分隔线」语义", () => {
    const raw = parseDiffOutput(
      "a.md",
      buildDiff(["@@ -1,2 +1,2 @@", "-const a = f(x, y);", "+const a=f(x,y);"]),
      "working-copy"
    );
    // 默认解析保留真实修改
    expect(raw.lines.filter((l) => l.type !== "unchanged")).toHaveLength(2);
    // 显式归零化后合并为 unchanged（v0.1.3 的默认行为）
    const normalized = normalizeDiffLines(raw.lines);
    expect(normalized.filter((l) => l.type !== "unchanged")).toHaveLength(0);
  });
});

describe("parseLogXml（svn log --xml）", () => {
  test("author/message/path 的 XML 实体被解码（含数字实体）", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<log>
<logentry revision="101">
<author>a&amp;b</author>
<date>2026-01-01T00:00:00.000000Z</date>
<paths>
<path kind="file" action="M">/x/需求&amp;A.md</path>
</paths>
<msg>修复 &amp; &lt;tag&gt; 的 &quot;问题&quot; &#39;引号&#39;</msg>
</logentry>
</log>`;
    const [entry] = parseLogXml(xml);
    expect(entry.author).toBe("a&b");
    expect(entry.message).toBe(`修复 & <tag> 的 "问题" '引号'`);
    expect(entry.paths).toEqual(["/x/需求&A.md"]);
  });

  test("自闭合 <path/> 不再吞掉紧随其后的 <path>", () => {
    const xml = `<log><logentry revision="7"><author>z</author><paths>
<path kind="file" action="D"/>
<path kind="file" action="M">/real.md</path>
</paths><msg>m</msg></logentry></log>`;
    const [entry] = parseLogXml(xml);
    expect(entry.paths).toEqual(["/real.md"]);
  });

  test("无 revision 的 logentry 被丢弃；空 XML 返回空数组", () => {
    expect(parseLogXml("<log><logentry><msg>x</msg></logentry></log>")).toEqual([]);
    expect(parseLogXml("")).toEqual([]);
  });

  test("多 logentry 分段解析（截断条目不影响后续）", () => {
    const xml = `<log>
<logentry revision="9"><author>甲</author><msg>九</msg></logentry>
<logentry revision="8"><author>乙</author><msg>八</msg></logentry>
</log>`;
    const entries = parseLogXml(xml);
    expect(entries.map((e) => e.revision)).toEqual(["9", "8"]);
    expect(entries.map((e) => e.author)).toEqual(["甲", "乙"]);
  });
});

describe("parseSummarizeOutput（svn diff --summarize）", () => {
  test("区分文件项与目录项，并归一化分隔符", () => {
    const output = ["M       产品目录/需求A.md", "M       产品目录/", "M       .", "A       b\\c.md", ""].join("\n");
    const entries = parseSummarizeOutput(output);
    expect(entries).toEqual([
      { action: "M", path: "产品目录/需求A.md", isDirectory: false },
      { action: "M", path: "产品目录", isDirectory: true },
      { action: "M", path: ".", isDirectory: false },
      { action: "A", path: "b/c.md", isDirectory: false },
    ]);
  });

  test("非状态行被忽略", () => {
    expect(parseSummarizeOutput("Updating '.':\nRevision: 5\n")).toEqual([]);
  });
});

describe("decodeXmlEntities", () => {
  test("&amp; 最后解码，避免二次解码嵌套实体", () => {
    expect(decodeXmlEntities("&amp;quot;")).toBe("&quot;");
    expect(decodeXmlEntities("&amp;")).toBe("&");
    expect(decodeXmlEntities("&#65;&#x42;")).toBe("AB");
  });
});
