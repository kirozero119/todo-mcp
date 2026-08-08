import { createTask, type ImportTaskInput, type TaskDb } from "@todo-mcp/core";
import { beforeEach, describe, expect, it } from "vitest";

import { executeImport, ImportVerificationError, SequenceRaiseError } from "../src/execute";
import {
  corruptTaskInsertColumn,
  createMigrateTestDb,
  failTaskInsertsAfter,
  type MigrateTestDb,
} from "./support/sqlite-task-db";

const ME = "github:64899536";

/** 旧 DB の生存 8 件と同じ id・同じ順で（値は合成）。旧 DB の最大 id は 153。 */
const LEGACY_MAX_ID = 153;
const OPEN_IDS = [1, 12, 13, 149, 150, 151, 152, 153];

function input(id: number, overrides: Partial<ImportTaskInput> = {}): ImportTaskInput {
  return {
    userId: ME,
    id,
    workspace: "life",
    project: null,
    title: `旧 #${id}`,
    status: "todo",
    due: null,
    memo: null,
    createdAt: "2026-08-02T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

const INPUTS: ImportTaskInput[] = OPEN_IDS.map((id) =>
  input(id, id === 150 ? { due: "2026-08-14", project: "移住", memo: "覚え書き" } : {}),
);

/** `sqlite_sequence` に触る文だけを、N 回目より後で失敗させる。 */
function failSequenceOpsAfter(db: TaskDb, skip: number): TaskDb {
  let seen = 0;
  const guard = (sql: string): boolean => {
    if (!sql.includes("sqlite_sequence")) return false;
    seen += 1;
    return seen > skip;
  };
  const refuse = (): Promise<never> =>
    Promise.reject(new Error("採番カウンタに触れない（テストの作り物）"));
  return {
    all: (sql: string, args?: unknown[]) => (guard(sql) ? refuse() : db.all(sql, args)),
    get: (sql: string, args?: unknown[]) => (guard(sql) ? refuse() : db.get(sql, args)),
  };
}

let db: MigrateTestDb;

beforeEach(() => {
  db = createMigrateTestDb();
});

/**
 * 採番カウンタの引き上げ位置。ここが INSERT ループの後ろに戻ると、
 * 途中で落ちた移行がアーカイブ済み id を新規タスクに配る DB を残す。
 */
describe("採番カウンタは書き込みより先に上がる", () => {
  it("成功した移行の後、カウンタは旧 DB の最大 id になっている", async () => {
    const result = await executeImport(db, { inputs: INPUTS, sequenceTarget: LEGACY_MAX_ID });
    expect(result.inserted).toBe(8);
    expect(db.sequence()).toBe(LEGACY_MAX_ID);
    expect(db.rows().map((row) => Number(row.id))).toEqual(OPEN_IDS);
  });

  it("INSERT ループが 3 件目で落ちても、カウンタは既に 153 になっている", async () => {
    const failing = failTaskInsertsAfter(db, 3);
    await expect(
      executeImport(failing, { inputs: INPUTS, sequenceTarget: LEGACY_MAX_ID }),
    ).rejects.toThrow(/ネットワーク断/);

    expect(db.rows()).toHaveLength(3);
    expect(db.sequence()).toBe(LEGACY_MAX_ID);
  });

  it("途中で落ちた後に作られるタスクは、旧 DB の id 範囲に入らない", async () => {
    const failing = failTaskInsertsAfter(db, 3);
    await expect(
      executeImport(failing, { inputs: INPUTS, sequenceTarget: LEGACY_MAX_ID }),
    ).rejects.toThrow();

    // 移行後に MCP 経由で作られる 1 件目。引き上げが後ろにあると 14 を取り、
    // それは実在するアーカイブ済みタスクの番号になる。
    const created = await createTask(db, { userId: ME, workspace: "life", title: "移行後の新規" });
    expect(created.id).toBe(LEGACY_MAX_ID + 1);
  });

  it("先にカウンタを上げても、明示 id の INSERT でカウンタが下がることはない", async () => {
    await executeImport(db, { inputs: [input(5)], sequenceTarget: LEGACY_MAX_ID });
    expect(db.sequence()).toBe(LEGACY_MAX_ID);
  });
});

describe("カウンタ操作の失敗は、汎用エラーと区別できる形で出る", () => {
  it("INSERT 前に失敗したら phase=before（行は 1 件も入っていない）", async () => {
    const failing = failSequenceOpsAfter(db, 0);
    const error = await executeImport(failing, {
      inputs: INPUTS,
      sequenceTarget: LEGACY_MAX_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SequenceRaiseError);
    expect((error as SequenceRaiseError).phase).toBe("before");
    expect((error as SequenceRaiseError).inserted).toBe(0);
    expect(db.rows()).toHaveLength(0);
  });

  it("全行を入れた後に失敗したら phase=after（DB を空にしてはいけない側）", async () => {
    // 空の DB では引き上げが get(読み) → all(INSERT) の 2 文。3 文目＝ループ後の読みで落とす。
    const failing = failSequenceOpsAfter(db, 2);
    const error = await executeImport(failing, {
      inputs: INPUTS,
      sequenceTarget: LEGACY_MAX_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SequenceRaiseError);
    expect((error as SequenceRaiseError).phase).toBe("after");
    expect((error as SequenceRaiseError).inserted).toBe(8);
    expect(db.rows()).toHaveLength(8);
  });
});

/**
 * 件数の増分だけを見る検証は、値がどれだけ壊れていても通ってしまう。
 * 下の 3 本はどれも「8 件入って増分も 8」だが、値が違う。
 */
describe("投入後の検証は値レベルで一致を見る", () => {
  it("全列一致なら verified が投入件数と揃う", async () => {
    const result = await executeImport(db, { inputs: INPUTS, sequenceTarget: LEGACY_MAX_ID });
    expect(result.verified).toBe(INPUTS.length);
  });

  it("created_at が 1 年ずれて書かれたら、id と列名を挙げて落ちる", async () => {
    const drifting = corruptTaskInsertColumn(db, "created_at", (value) =>
      String(value).replace("2026-", "2025-"),
    );
    const error = await executeImport(drifting, {
      inputs: INPUTS,
      sequenceTarget: LEGACY_MAX_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportVerificationError);
    expect((error as ImportVerificationError).problems).toHaveLength(8);
    expect((error as ImportVerificationError).message).toContain("created_at");
    expect((error as ImportVerificationError).message).toContain("#150");
    // 行数だけ見ていたら成功扱いになっていた形（そこは壊れていない）。
    expect(db.rows()).toHaveLength(8);
  });

  it("別の user_id で書かれたら「行が無い」として落ちる", async () => {
    const wrongUser = corruptTaskInsertColumn(db, "user_id", () => "github:1");
    const error = await executeImport(wrongUser, {
      inputs: INPUTS,
      sequenceTarget: LEGACY_MAX_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportVerificationError);
    expect((error as ImportVerificationError).message).toContain("読み直しても行が無い");
    expect(db.rows()).toHaveLength(8);
  });

  it("title が書き換わったら落ちる（1 行だけの食い違いでも検出する）", async () => {
    const rewriting = corruptTaskInsertColumn(db, "title", (value) =>
      String(value) === "旧 #150" ? "別のタイトル" : value,
    );
    const error = await executeImport(rewriting, {
      inputs: INPUTS,
      sequenceTarget: LEGACY_MAX_ID,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ImportVerificationError);
    expect((error as ImportVerificationError).problems).toEqual([
      '#150 title: 書いたはず="旧 #150" / DB の実際="別のタイトル"',
    ]);
  });
});
