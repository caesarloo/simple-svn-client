/**
 * frontmatter 解析工具（简化 YAML，支持 键:值 / 键: 列表 / 键: 块标量 / 键: 嵌套键值）
 * 从 ai-pm-tool 的 notes/parser.ts 迁出，供 svn 文件内容对比（diffFrontmatterFields）等场景共用。
 *
 * v0.2.0 修正两处会误导字段对比的解析缺陷：
 * - 带引号的值不再保留引号（`desc: "a: b"` 的值应是 `a: b`，而非 `"a: b"`）；
 * - 缩进嵌套不再被当作顶层键（旧版 `nested:\n  k: v` 会产出 `{nested: null, k: "v"}`，
 *   凭空多出一个顶层 `k`，与真正名为 `k` 的字段混淆）。
 */

/** 从 Markdown 文本提取 frontmatter 区块（不含 --- 行），无则返回 null */
export function extractFrontmatterBlock(text: string): string | null {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

/** 去除成对的单/双引号（双引号内支持 \" 与 \\ 转义） */
function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (first === "'" && last === "'") {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** 标量类型转换：布尔 / 数字 / 日期字符串 / 其余字符串 */
function parseScalar(raw: string): string | number | boolean {
  const value = stripQuotes(raw.trim());
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value; // 日期保持字符串，避免 Number() 产生 NaN
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return value;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

const KEY_LINE_RE = /^([^:#][^:]*):\s*(.*)$/;
const BLOCK_SCALAR_RE = /^\s*[|>][+-]?\s*$/;
const LIST_ITEM_RE = /^\s*-\s+/;
const INLINE_LIST_RE = /^\[[\s\S]*\]$/;

/** 解析一段「键: 值」行（可递归用于嵌套块） */
function parseKeyValueLines(lines: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = KEY_LINE_RE.exec(line);
    if (!keyMatch) {
      i += 1;
      continue;
    }
    const key = keyMatch[1].trim();
    const inlineValue = keyMatch[2].trim();
    i += 1;

    if (inlineValue === "" || inlineValue === "null" || inlineValue === "~") {
      // 空值：可能是列表、块标量、嵌套键值，或真正的空
      if (i < lines.length && LIST_ITEM_RE.test(lines[i])) {
        const items: Array<string | number | boolean> = [];
        while (i < lines.length && LIST_ITEM_RE.test(lines[i])) {
          items.push(parseScalar(lines[i].replace(LIST_ITEM_RE, "")));
          i += 1;
        }
        out[key] = items;
        continue;
      }
      if (i < lines.length && BLOCK_SCALAR_RE.test(lines[i])) {
        i += 1;
        const chunk: string[] = [];
        while (i < lines.length && (indentOf(lines[i]) > 0 || lines[i].trim() === "")) {
          chunk.push(lines[i].trim());
          i += 1;
        }
        out[key] = chunk.join("\n");
        continue;
      }
      if (i < lines.length && indentOf(lines[i]) > 0 && KEY_LINE_RE.test(lines[i].trim())) {
        // 嵌套键值块：按缩进收集，递归解析（不再冒充顶层键）
        const indent = indentOf(lines[i]);
        const nested: string[] = [];
        while (i < lines.length) {
          if (lines[i].trim() === "") {
            nested.push("");
            i += 1;
            continue;
          }
          if (indentOf(lines[i]) < indent) {
            break;
          }
          nested.push(lines[i].slice(indent));
          i += 1;
        }
        out[key] = parseKeyValueLines(nested);
        continue;
      }
      out[key] = null;
      continue;
    }

    if (BLOCK_SCALAR_RE.test(inlineValue)) {
      const chunk: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) > 0 || lines[i].trim() === "")) {
        chunk.push(lines[i].trim());
        i += 1;
      }
      out[key] = chunk.join("\n");
      continue;
    }

    if (INLINE_LIST_RE.test(inlineValue)) {
      const inner = inlineValue.slice(1, -1);
      out[key] = inner
        .split(",")
        .map((item) => parseScalar(item))
        .filter((item) => item !== "");
      continue;
    }

    out[key] = parseScalar(inlineValue);
  }

  return out;
}

/** 简化 YAML 解析：返回扁平/一层嵌套对象（键 -> string | number | boolean | string[] | object | null） */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const block = extractFrontmatterBlock(text);
  if (!block) {
    return {};
  }
  return parseKeyValueLines(block.split(/\r?\n/));
}
