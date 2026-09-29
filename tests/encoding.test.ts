/**
 * 编码解码测试 —— v0.1.3 曾在此静默损坏数据，这些用例是回归底线。
 *
 * 旧版实测缺陷（本文件逐条锁定）：
 * - `decodeBuffer(Buffer.from("璐璐的报告"))` → `"?????"`（硬编码乱码字表把合法汉字当线索，
 *   且 latin1/问号候选因 `countReplacementChars` 只认 U+FFFD 而胜出）；
 * - UTF-8 文本里个别坏字节 → 整段变 latin1 (`é¡...`)；
 * - 含合法 U+FFFD 的 UTF-8 → 被 latin1 候选淘汰。
 */
import iconv from "iconv-lite";
import {
  countInvalidControlChars,
  countReplacementChars,
  decodeSvnOutput,
  isLosslessUtf8,
} from "../src/index";

describe("decodeSvnOutput（v0.2.0 解码策略）", () => {
  test("合法 UTF-8 中文原样返回（含旧版字表误伤字「璐」「姹」）", () => {
    const samples = ["璐璐的报告", "姹紫嫣红", "璐", "产品/璐璐的报告.md", "需求评审邮件", "说明文件：需求"];
    for (const text of samples) {
      expect(decodeSvnOutput(Buffer.from(text, "utf8"))).toBe(text);
    }
  });

  test("GBK 中文正确解码（Windows svn 的实际输出编码）", () => {
    expect(decodeSvnOutput(iconv.encode("需求评审邮件", "gbk"))).toBe("需求评审邮件");
    expect(decodeSvnOutput(iconv.encode("产品需求/ZF03-跨境.md", "gbk"))).toBe("产品需求/ZF03-跨境.md");
    expect(decodeSvnOutput(iconv.encode("璐璐的报告.md", "gbk"))).toBe("璐璐的报告.md");
  });

  test("个别坏字节不会让整段退化为 latin1/GBK 乱码", () => {
    const healthy = "项目状态: 进行中".repeat(4);
    const broken = Buffer.concat([Buffer.from(healthy, "utf8"), Buffer.from([0xff])]);
    const out = decodeSvnOutput(broken);
    expect(out).toContain("项目状态: 进行中");
    expect(out).not.toContain("é¡");
    expect(out).not.toContain("ï¿½");
  });

  test("含合法 U+FFFD 的 UTF-8 仍按 UTF-8 返回（不选 latin1）", () => {
    const text = "项目\uFFFD状态";
    const buf = Buffer.from(text, "utf8");
    expect(isLosslessUtf8(buf)).toBe(true);
    expect(decodeSvnOutput(buf)).toBe(text);
  });

  test("显式 encoding 覆盖自动判定", () => {
    const gbk = iconv.encode("中文", "gbk");
    expect(decodeSvnOutput(gbk, { encoding: "gbk" })).toBe("中文");
    expect(decodeSvnOutput(Buffer.from("abc"), { encoding: "latin1" })).toBe("abc");
  });

  test("空输入与字符串输入", () => {
    expect(decodeSvnOutput(undefined)).toBe("");
    expect(decodeSvnOutput(null)).toBe("");
    expect(decodeSvnOutput(Buffer.alloc(0))).toBe("");
    expect(decodeSvnOutput("已解码")).toBe("已解码");
  });

  test("XML（UTF-8）输出无损返回", () => {
    const xml = '<?xml version="1.0"?><status><entry path="中文.md"/></status>';
    expect(decodeSvnOutput(Buffer.from(xml, "utf8"))).toBe(xml);
  });

  test("isLosslessUtf8 判定", () => {
    expect(isLosslessUtf8(Buffer.from("abc"))).toBe(true);
    expect(isLosslessUtf8(Buffer.alloc(0))).toBe(true);
    expect(isLosslessUtf8(iconv.encode("中文", "gbk"))).toBe(false);
    expect(isLosslessUtf8(Buffer.from([0xff]))).toBe(false);
  });

  test("控制字符计数覆盖 C0 与 C1（C1 是「选错编码」的强信号）", () => {
    expect(countInvalidControlChars("\u0001\u0002")).toBe(2);
    expect(countInvalidControlChars("\u0085\u009F")).toBe(2);
    expect(countInvalidControlChars("\t\n\r")).toBe(0);
    expect(countInvalidControlChars("\u0000")).toBe(0);
    expect(countInvalidControlChars("\u0000", true)).toBe(1);
  });

  test("替换字符计数", () => {
    expect(countReplacementChars("a\uFFFDb\uFFFD")).toBe(2);
    expect(countReplacementChars("abc")).toBe(0);
  });
});
