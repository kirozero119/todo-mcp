/**
 * 旧 1 行 → 新 1 行の変換。チケット 10 の変換表をそのままコードにしたもの。
 *
 * ここは純粋関数だけにしてある（DB にも process にも触らない）。移行で本当に
 * 怖いのは接続まわりではなく「静かに値が変わること」なので、変換だけを
 * 取り出してテストできる形にした。
 *
 * 判断できない値は握りつぶさず `MigrationDataError` で止める。1 回きりの
 * スクリプトで一番まずいのは、想定外の値を既定値に丸めて完走してしまうこと。
 */
import { isCalendarDate, statusSchema, type ImportTaskInput, type Workspace } from "@todo-mcp/core";

import type { LegacyRow } from "./legacy";

/** 変換を続行できない行に当たったときの停止。message に id と列名を必ず入れる。 */
export class MigrationDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDataError";
  }
}

/**
 * 変換の過程で値が「そのままではない」形になった記録。
 *
 * 黙って直さない。件数と id を実行ログに出して、防御が発火したかどうかを
 * 後から言い切れるようにするためのもの。
 */
export interface TransformNote {
  id: number;
  kind: "empty_to_null" | "due_time_dropped" | "closed_at_inconsistent";
  detail: string;
}

export interface TransformOptions {
  /** `github:<数値id>`。全行に同じ値が入る。 */
  userId: string;
  /** 全行に同じ値が入る（チケット 10: 生存 8 件はすべて life）。 */
  workspace: Workspace;
}

export interface TransformResult {
  inputs: ImportTaskInput[];
  notes: TransformNote[];
}

/** 旧 DB で終端を意味する status。旧 CLI に cancelled は無い。 */
const LEGACY_CLOSED_STATUSES = new Set(["done"]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_SECONDS_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * 空文字を null に寄せる（09 の指摘への防御）。
 *
 * `""` のまま入れると、表示（`fmtLine` / `fmtDetail` はどれも真偽判定）にも
 * `search_tasks` の project 絞り込みにも現れない、書けるのに読めない行ができる。
 * 実データでの発火は 0 件（category / memo / due とも空文字なし）だが、
 * 「実データに無いから要らない」ではなく「入ってきたら壊れる」ので入り口で潰す。
 */
function textOrNull(
  value: string | null,
  context: { id: number; column: string },
  notes: TransformNote[],
): string | null {
  if (value === null) return null;
  if (value === "") {
    notes.push({
      id: context.id,
      kind: "empty_to_null",
      detail: `${context.column}: "" → null`,
    });
    return null;
  }
  return value;
}

/**
 * 日付のみ（`YYYY-MM-DD`）のタイムスタンプに `T00:00:00Z` を補って ISO 8601 UTC にする（03 §7）。
 *
 * 既に ISO 秒精度ならそのまま。どちらでもない値は丸めずに止める ——
 * created_at は NOT NULL かつ「塩漬け」判定の材料なので、壊れた値を入れると
 * 表示にも並び順にも効いてしまう。
 */
export function toIsoTimestamp(value: string, context: { id: number; column: string }): string {
  if (ISO_SECONDS_UTC.test(value)) return value;
  if (DATE_ONLY.test(value) && isCalendarDate(value)) return `${value}T00:00:00Z`;
  throw new MigrationDataError(
    `#${context.id} ${context.column}: ${JSON.stringify(value)} は YYYY-MM-DD でも ISO 8601 UTC（秒精度）でもない`,
  );
}

/**
 * 締切の正規化。`due` は「瞬間ではなく日」（03 §7）なので `YYYY-MM-DD` 以外は置けない。
 *
 * 旧 DB には `YYYY-MM-DD HH:MM` の行が実在する（実測 2 件、どちらも done）。
 * 時刻部分を落として日付だけにし、落としたことを note に残す。verbatim で
 * 通すと、ツール経由では二度と作れず編集もできない値が新 DB に残り、
 * `isCalendarDate` を前提にした表示・比較の外側に出てしまう。
 */
function normalizeDue(value: string | null, id: number, notes: TransformNote[]): string | null {
  const text = textOrNull(value, { id, column: "due" }, notes);
  if (text === null) return null;
  if (isCalendarDate(text)) return text;

  const head = text.slice(0, 10);
  if (DATE_ONLY.test(head) && isCalendarDate(head)) {
    notes.push({
      id,
      kind: "due_time_dropped",
      detail: `due: ${JSON.stringify(text)} → ${JSON.stringify(head)}（時刻部分を落とした）`,
    });
    return head;
  }
  throw new MigrationDataError(`#${id} due: ${JSON.stringify(text)} を YYYY-MM-DD にできない`);
}

/** 旧 1 行 → `importTask()` に渡す 1 件。 */
export function transformRow(
  row: LegacyRow,
  options: TransformOptions,
  notes: TransformNote[],
): ImportTaskInput {
  if (!row.title) {
    throw new MigrationDataError(`#${row.id} title が空。タイトルの無い行は移行しない`);
  }

  // status は core の Zod enum を通す。移行もまた「書き込みの入口」なので、
  // 語彙の検証を素通りさせない（03: 入口を全部 enum に通す構造で正しさを担保する）。
  const parsed = statusSchema.safeParse(row.status);
  if (!parsed.success) {
    throw new MigrationDataError(
      `#${row.id} status: ${JSON.stringify(row.status)} は新スキーマの 6 値に無い`,
    );
  }
  const status = parsed.data;

  const doneAt = textOrNull(row.done_at, { id: row.id, column: "done_at" }, notes);
  const closedAt =
    doneAt === null ? null : toIsoTimestamp(doneAt, { id: row.id, column: "done_at" });

  // 旧 DB の実測では done ⇔ done_at ありが完全に一致している。ずれていたら
  // 旧 DB の値をそのまま持ち込んだうえで note に残す（移行が履歴を作り変えない）。
  if (LEGACY_CLOSED_STATUSES.has(row.status) !== (closedAt !== null)) {
    notes.push({
      id: row.id,
      kind: "closed_at_inconsistent",
      detail: `status=${row.status} と done_at=${JSON.stringify(row.done_at)} が食い違う（旧 DB の値のまま移行した）`,
    });
  }

  const createdAt = toIsoTimestamp(row.created_at, { id: row.id, column: "created_at" });

  return {
    userId: options.userId,
    id: row.id,
    workspace: options.workspace,
    // 旧 category を verbatim 載せ替え（03 §3。中間 taxonomy は作らない）。
    project: textOrNull(row.category, { id: row.id, column: "category" }, notes),
    title: row.title,
    status,
    due: normalizeDue(row.due, row.id, notes),
    memo: textOrNull(row.memo, { id: row.id, column: "memo" }, notes),
    createdAt,
    // 旧 DB に更新履歴が無いので created_at と同値にする。理由は design-notes の
    // 「[10] updated_at に created_at をそのまま入れた」を参照。
    updatedAt: createdAt,
    closedAt,
  };
}

export function transformRows(
  rows: readonly LegacyRow[],
  options: TransformOptions,
): TransformResult {
  const notes: TransformNote[] = [];
  const inputs = rows.map((row) => transformRow(row, options, notes));
  return { inputs, notes };
}

/**
 * dry-run で 1 行に出す表現。INSERT される列を全部、列順で並べた JSON。
 *
 * 整形した表ではなく JSON にしているのは、`null` と `""` と `"null"` が
 * 見た目で区別できることが、この出力の唯一の仕事だから。
 */
export function formatInput(input: ImportTaskInput): string {
  return JSON.stringify({
    id: input.id,
    user_id: input.userId,
    workspace: input.workspace,
    project: input.project ?? null,
    title: input.title,
    status: input.status,
    due: input.due ?? null,
    memo: input.memo ?? null,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    closed_at: input.closedAt ?? null,
  });
}
