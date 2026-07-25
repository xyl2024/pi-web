/**
 * Unit tests for lib/parse-auto-name.ts.
 *
 * Usage:  npx tsx scripts/test-parse-auto-name.ts
 *
 * Exits 0 on success, 1 on any failed assertion.
 */

import { parseAutoName, MAX_TITLE_CHARS } from "@/lib/parse-auto-name";

let passed = 0;
let failed = 0;

function expect(label: string, actual: string | null, expected: string | null) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${JSON.stringify(expected)}`);
    console.error(`      actual:   ${JSON.stringify(actual)}`);
  }
}

function expectNumber(label: string, actual: number | null | undefined, expected: number) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`      expected: ${expected}`);
    console.error(`      actual:   ${actual}`);
  }
}

console.log("=== parseAutoName: clean inputs ===");
expect("simple Chinese title", parseAutoName("Python 报错排查"), "Python 报错排查");
expect("Chinese title with English", parseAutoName("重构 authentication 模块"), "重构 authentication 模块");
expect("plain English", parseAutoName("Refactor auth flow"), "Refactor auth flow");

console.log("\n=== parseAutoName: stray punctuation ===");
expect("trailing period", parseAutoName("Python 报错排查。"), "Python 报错排查");
expect("trailing exclamation", parseAutoName("Fix the bug!"), "Fix the bug");
expect("trailing question mark", parseAutoName("为什么报错?"), "为什么报错");
expect("surrounding ASCII quotes", parseAutoName('"Python 报错"'), "Python 报错");
expect("surrounding smart quotes", parseAutoName("「标题」"), "标题");
expect("surrounding Chinese brackets", parseAutoName("（标题）"), "标题");
expect("nested quotes", parseAutoName('""标题""'), "标题");

console.log("\n=== parseAutoName: meta-answers ===");
expect("null", parseAutoName("null"), null);
expect("None", parseAutoName("None"), null);
expect("N/A", parseAutoName("N/A"), null);
expect("无", parseAutoName("无"), null);
expect("无法判断", parseAutoName("无法判断"), null);
expect("不知道", parseAutoName("不知道"), null);
expect("抱歉", parseAutoName("抱歉"), null);
expect("no title", parseAutoName("no title"), null);

console.log("\n=== parseAutoName: garbage inputs ===");
expect("empty string", parseAutoName(""), null);
expect("only whitespace", parseAutoName("   \n\n  \t"), null);
expect("only punctuation", parseAutoName("。。"), null);
expect("only quotes", parseAutoName("\"\""), null);
expect("null literal", parseAutoName(null), null);
expect("undefined literal", parseAutoName(undefined), null);
expect("number", parseAutoName(42 as unknown as string), null);

console.log("\n=== parseAutoName: leading preamble ===");
// The system prompt instructs the model to only output the title; if the
// model emits a preamble, the parser intentionally takes the FIRST
// non-blank line. Callers can detect this by checking if the result starts
// with an English word / "Sure" / etc. — but the parser itself is dumb.
expect("preamble + title (first line wins)", parseAutoName("Sure! Here is a title:\nPython 报错排查"), "Sure! Here is a title");
expect("leading newline", parseAutoName("\n\n重构数据库"), "重构数据库");
expect("blank line then title (first line wins)", parseAutoName("随便说\nPython 报错排查"), "随便说");
expect("explanation after title (first line wins)", parseAutoName("Python 报错\n这是一个 Python 错误排查任务"), "Python 报错");

console.log("\n=== parseAutoName: truncation ===");
const longTitle = "a".repeat(MAX_TITLE_CHARS + 20);
const truncated = parseAutoName(longTitle);
expectNumber("long input is truncated", truncated?.length, MAX_TITLE_CHARS);
expectNumber("long Chinese input is truncated", parseAutoName("测".repeat(50))?.length, MAX_TITLE_CHARS);

console.log("\n=== parseAutoName: real-world model outputs ===");
expect("model wraps in quotes", parseAutoName('"实现用户认证系统"'), "实现用户认证系统");
expect("model says 'Title: ...'", parseAutoName("Title: 实现用户认证系统"), "Title: 实现用户认证系统");
expect("model has trailing newline", parseAutoName("实现用户认证系统\n"), "实现用户认证系统");
expect("model returns JSON-wrapped", parseAutoName('{"title": "实现用户认证系统"}'), "{\"title\": \"实现用户认证系统\"}"); // lenient — accepts as-is

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
