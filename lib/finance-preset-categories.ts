/**
 * Preset list of common daily-accounting categories for the FinancePanel
 * feature. Categories are direction-agnostic — the same name can be used for
 * either income or expense on a per-transaction basis (the `direction` field
 * on the transaction itself carries that).
 *
 * The list is hard-coded (per design decision) and shared by the server
 * (validation in `lib/finance-store.ts`) and the client (dropdown options in
 * `FinanceEntryModal` / `FinanceQuickEntry` / `FinancePanel` filter). Pure
 * module — no Node-only or browser-only deps, safe to import from both
 * sides. Mirror of the `lib/translate.ts` pattern.
 *
 * Order is significant: drop-downs render in this order so the user sees
 * expense categories first, then income, then the catch-all `其他`.
 */

import { FinanceValidationError, validateCategory } from "@/lib/finance-schema";

export const FINANCE_PRESET_CATEGORIES: readonly string[] = [
  // 支出
  "餐饮",
  "交通",
  "购物",
  "居家",
  "娱乐",
  "医疗",
  "教育",
  "通讯",
  "数码",
  "美容",
  "旅行",
  "人情",
  // 收入
  "工资",
  "兼职",
  "投资",
  "红包",
  "报销",
  // 通用
  "其他",
];

const FINANCE_PRESET_CATEGORY_SET: ReadonlySet<string> = new Set(
  FINANCE_PRESET_CATEGORIES,
);

export function isPresetCategory(name: string): boolean {
  return FINANCE_PRESET_CATEGORY_SET.has(name);
}

/**
 * Like `validateCategory` from `lib/finance-schema.ts` but additionally
 * rejects any name that is not in the preset list. Use this on every
 * transaction write path so the database can never accumulate free-text
 * category strings again.
 */
export function validatePresetCategory(
  value: unknown,
  field: string = "category",
): string {
  const trimmed = validateCategory(value, field);
  if (!isPresetCategory(trimmed)) {
    throw new FinanceValidationError(
      `${field} must be one of the preset categories`,
      field,
    );
  }
  return trimmed;
}

/**
 * Result of scanning a details string for an in-progress category token.
 *
 * - `category` is the matched preset name, or `null` if no valid `#xxx` was
 *   found (or none matched a preset).
 * - `cleanDetails` is the input with the matched `#xxx` token stripped (and
 *   whitespace collapsed). If the matched token wasn't a preset, it is
 *   still stripped — the user shouldn't see garbage `#xxx` strings in their
 *   saved details.
 *
 * Token rules:
 * - `#` must sit at the start of the input or be preceded by whitespace.
 * - The token body is a contiguous run of non-whitespace, non-`#`
 *   characters. Only the FIRST match in the string is used.
 */
export function parseCategoryFromDetails(rawDetails: string): {
  category: string | null;
  cleanDetails: string;
} {
  const re = /(^|\s)#(\S+)/;
  const m = rawDetails.match(re);
  if (!m || m.index === undefined) {
    return { category: null, cleanDetails: rawDetails.trim() };
  }
  const candidate = m[2];
  // Strip the matched "#xxx" (and any leading whitespace captured by m[1]).
  const start = m.index + (m[1] ? 1 : 0);
  const end = m.index + m[0].length;
  const before = rawDetails.slice(0, start);
  const after = rawDetails.slice(end);
  const cleanDetails = (before + after).replace(/\s+/g, " ").trim();
  if (!isPresetCategory(candidate)) {
    return { category: null, cleanDetails };
  }
  return { category: candidate, cleanDetails };
}
