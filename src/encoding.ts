/**
 * SVN 输出编码解码（纯函数，零 I/O）
 *
 * v0.2.0 重写，修掉 v0.1.3 的静默数据损坏缺陷：
 *
 * 旧实现的策略是「先按 U+FFFD 替换字符计数取最小者，再在其中偏向 utf8」，但有三个漏洞：
 *   1. `iconv.decode(buf, "latin1")` 是 1:1 映射，永不产生 U+FFFD，因此恒为「最小替换字符」
 *      的优胜者 → 只要候选集里有 latin1，正常文本就可能被整体解成 latin1 乱码；
 *   2. iconv 对无法映射的字节输出的是 `?`（U+003F）而非 U+FFFD，旧计分完全不计 `?`
 *      → 「把整行字符替换成问号」这种最差候选反而得 0 分、胜出（实测 "璐璐的报告" → "?????"）；
 *   3. `hasMojibakeHint` 的硬编码字表里混进了合法汉字（璐/鍙/閭/姹/鎴），
 *      含这些字的正常中文也会被送进「修复」链。
 *
 * 新策略（可预测、不猜谜）：
 *   - 显式 `encoding` 优先；
 *   - `auto`：先做**无损 UTF-8 判定**（fatal decoder），合法 UTF-8 直接返回，绝不改写；
 *   - 非 UTF-8 时仅在 GBK / GB18030 之间按「替换字符 + 控制字符」计分择优（GBK 优先）；
 *   - latin1 只允许显式指定（避免成为兜底赢家）；
 *   - 不再做逐行 recode 猜谜，也不再使用乱码线索字表。
 */
import { TextDecoder } from "node:util";
import iconv from "iconv-lite";

/** 支持的输出编码；"auto" 表示无损 UTF-8 优先 + GBK 回退 */
export type SvnOutputEncoding = "auto" | "utf8" | "gbk" | "gb18030" | "latin1";

export interface DecodeSvnOutputOptions {
  /** 输出编码；默认 "auto" */
  encoding?: SvnOutputEncoding;
}

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** U+FFFD 替换字符计数（iconv 与 Node 解码器的统一失败标记） */
export function countReplacementChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) {
      count += 1;
    }
  }
  return count;
}

/**
 * 非法控制字符计数。
 * 统计 C0 控制符（除 \t \n \r）、NUL（可选）与 C1 控制符（U+0080-U+009F）。
 * C1 也计入是因为 latin1 解码会把 0x80-0x9F 字节映射成 C1 控制符——这是「选错编码」的强信号。
 */
export function countInvalidControlChars(text: string, includeNull = false): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0 && includeNull) {
      count += 1;
      continue;
    }
    if ((code >= 1 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      count += 1;
      continue;
    }
    if (code >= 0x80 && code <= 0x9f) {
      count += 1;
    }
  }
  return count;
}

/** 字节是否为无损 UTF-8（合法且不含替换字符） */
export function isLosslessUtf8(buf: Buffer): boolean {
  if (buf.length === 0) {
    return true;
  }
  try {
    UTF8_DECODER.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 候选编码的「错误分」：替换字符权重最高，其次非法控制字符 */
function decodeErrorScore(text: string): number {
  return countReplacementChars(text) * 100 + countInvalidControlChars(text) * 10;
}

/**
 * 解码 SVN 输出字节。
 *
 * @param input 原始字节（或已是字符串时原样返回）
 * @param options.encoding 显式编码；缺省 "auto"
 */
export function decodeSvnOutput(
  input: Buffer | string | undefined | null,
  options: DecodeSvnOutputOptions = {}
): string {
  if (input === undefined || input === null) {
    return "";
  }
  if (typeof input === "string") {
    return input;
  }
  if (input.length === 0) {
    return "";
  }

  const requested = options.encoding ?? "auto";
  if (requested !== "auto") {
    return iconv.decode(input, requested);
  }

  // 1) 合法 UTF-8 直接返回：中文（UTF-8 仓库）、ASCII、XML 输出都走这里，零风险
  if (isLosslessUtf8(input)) {
    return UTF8_DECODER.decode(input);
  }

  // 2) 少数字节损坏的 UTF-8：宽松解码后若损坏字节占比很低（≤ 10%），
  //    仍按 UTF-8 返回——保证偶发坏字节不会把整段中文拖成 GBK 乱码
  //    （旧版此处会切到 latin1，把整段变成 `é¡...`）。
  const utf8Loose = iconv.decode(input, "utf8");
  const utf8Bad = countReplacementChars(utf8Loose) + countInvalidControlChars(utf8Loose);
  if (utf8Bad > 0 && utf8Bad * 10 <= input.length) {
    return utf8Loose;
  }

  // 3) 非 UTF-8：只在 GBK / GB18030 之间择优（Windows svn 中文输出的实际编码）
  const gbk = iconv.decode(input, "gbk");
  const gbkScore = decodeErrorScore(gbk);
  if (gbkScore === 0) {
    return gbk;
  }
  const gb18030 = iconv.decode(input, "gb18030");
  const gb18030Score = decodeErrorScore(gb18030);
  if (gb18030Score < gbkScore) {
    return gb18030;
  }
  // 两者都有损时仍优先 GBK（目标场景），保证结果可预测；latin1 不在兜底候选内
  return gbk;
}
