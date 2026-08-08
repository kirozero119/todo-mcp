import { describe, expect, it } from "vitest";

import type { LegacyRow } from "../src/legacy";
import { formatInput, MigrationDataError, transformRows } from "../src/transform";

const OPTIONS = { userId: "github:64899536", workspace: "life" as const };

/** 旧 tasks の 1 行。上書きしたい列だけ渡す。値はすべて合成。 */
function legacyRow(overrides: Partial<LegacyRow> = {}): LegacyRow {
  return {
    id: 1,
    title: "テストタスク",
    category: null,
    status: "todo",
    due: null,
    created_at: "2026-08-02",
    done_at: null,
    memo: null,
    ...overrides,
  };
}

function transformOne(row: LegacyRow) {
  const { inputs, notes } = transformRows([row], OPTIONS);
  const input = inputs[0];
  if (!input) throw new Error("1 件も変換されなかった");
  return { input, notes };
}

describe("変換表（チケット 10）", () => {
  it("旧 id をそのまま持ち込む（発番し直さない）", () => {
    const { input } = transformOne(legacyRow({ id: 153 }));
    expect(input.id).toBe(153);
  });

  it("user_id と workspace は全行同じ値になる", () => {
    const { inputs } = transformRows([legacyRow({ id: 1 }), legacyRow({ id: 12 })], OPTIONS);
    expect(inputs.map((input) => input.userId)).toEqual(["github:64899536", "github:64899536"]);
    expect(inputs.map((input) => input.workspace)).toEqual(["life", "life"]);
  });

  it("category を project へ verbatim で載せ替える（中間 taxonomy を作らない）", () => {
    const { input } = transformOne(legacyRow({ category: "エンジニア学習" }));
    expect(input.project).toBe("エンジニア学習");
  });

  it("due は YYYY-MM-DD のまま（日付を動かさない）", () => {
    const { input, notes } = transformOne(legacyRow({ due: "2026-08-14" }));
    expect(input.due).toBe("2026-08-14");
    expect(notes).toEqual([]);
  });

  it("created_at に T00:00:00Z を補い、updated_at を同値にする", () => {
    const { input } = transformOne(legacyRow({ created_at: "2026-08-02" }));
    expect(input.createdAt).toBe("2026-08-02T00:00:00Z");
    expect(input.updatedAt).toBe("2026-08-02T00:00:00Z");
  });

  it("done_at を closed_at へ（同じく T00:00:00Z 補完）", () => {
    const { input, notes } = transformOne(
      legacyRow({ status: "done", created_at: "2026-03-30", done_at: "2026-03-31" }),
    );
    expect(input.status).toBe("done");
    expect(input.closedAt).toBe("2026-03-31T00:00:00Z");
    expect(notes).toEqual([]);
  });

  it("open な行の closed_at は null", () => {
    const { input } = transformOne(legacyRow({ status: "waiting" }));
    expect(input.closedAt).toBeNull();
  });

  it("旧 5 値の status はすべて新 6 値に収まる", () => {
    const statuses = ["todo", "in_progress", "waiting", "someday", "done"];
    const rows = statuses.map((status, index) =>
      legacyRow({ id: index + 1, status, done_at: status === "done" ? "2026-08-02" : null }),
    );
    const { inputs, notes } = transformRows(rows, OPTIONS);
    expect(inputs.map((input) => input.status)).toEqual(statuses);
    expect(notes).toEqual([]);
  });
});

describe("防御（発火すると note が残る）", () => {
  it("category / memo / due の空文字を null に寄せる", () => {
    const { input, notes } = transformOne(legacyRow({ category: "", memo: "", due: "" }));
    expect(input.project).toBeNull();
    expect(input.memo).toBeNull();
    expect(input.due).toBeNull();
    expect(notes.map((note) => note.kind)).toEqual([
      "empty_to_null",
      "empty_to_null",
      "empty_to_null",
    ]);
  });

  it("空文字が 1 つも無ければ note は出ない（実データはこちら）", () => {
    const { notes } = transformOne(
      legacyRow({ category: "移住", memo: "領収書は改札で回収される", due: "2026-08-10" }),
    );
    expect(notes).toEqual([]);
  });

  it("due の時刻部分を落として日付だけにする（旧 DB に実在する形式）", () => {
    const { input, notes } = transformOne(legacyRow({ due: "2026-03-30 18:00" }));
    expect(input.due).toBe("2026-03-30");
    expect(notes).toEqual([
      {
        id: 1,
        kind: "due_time_dropped",
        detail: 'due: "2026-03-30 18:00" → "2026-03-30"（時刻部分を落とした）',
      },
    ]);
  });

  // 丸めるのは旧形式として確認済みの `YYYY-MM-DD HH:MM` だけ。先頭 10 文字を
  // 切り出す実装だと、下のような「有効な日付で始まる不正値」が正常な due として通る。
  it("有効な日付で始まる未知の形式は丸めずに止める", () => {
    expect(() => transformOne(legacyRow({ due: "2026-03-30oops" }))).toThrow(MigrationDataError);
    expect(() => transformOne(legacyRow({ due: "2026-03-30T18:00:00Z" }))).toThrow(
      MigrationDataError,
    );
    expect(() => transformOne(legacyRow({ due: "2026-03-30 18:00:00" }))).toThrow(
      MigrationDataError,
    );
    expect(() => transformOne(legacyRow({ due: "2026-03-30 18:00 JST" }))).toThrow(
      MigrationDataError,
    );
  });

  it("止まるときは id と値を挙げる", () => {
    expect(() => transformOne(legacyRow({ id: 91, due: "2026-03-30oops" }))).toThrow(
      /#91 due: "2026-03-30oops"/,
    );
  });

  it("時刻つきでも日付部分が実在しなければ止まる（2 月 31 日 18:00）", () => {
    expect(() => transformOne(legacyRow({ due: "2026-02-31 18:00" }))).toThrow(MigrationDataError);
  });

  it("status と done_at の食い違いは値を保ったまま note にする", () => {
    const { input, notes } = transformOne(legacyRow({ status: "todo", done_at: "2026-08-02" }));
    expect(input.status).toBe("todo");
    expect(input.closedAt).toBe("2026-08-02T00:00:00Z");
    expect(notes.map((note) => note.kind)).toEqual(["closed_at_inconsistent"]);
  });
});

describe("止まるべきところで止まる", () => {
  it("新スキーマに無い status", () => {
    expect(() => transformOne(legacyRow({ status: "blocked" }))).toThrow(MigrationDataError);
  });

  it("空のタイトル", () => {
    expect(() => transformOne(legacyRow({ title: "" }))).toThrow(MigrationDataError);
  });

  it("日付にならない created_at", () => {
    expect(() => transformOne(legacyRow({ created_at: "2026/08/02" }))).toThrow(MigrationDataError);
  });

  it("存在しない日付（2 月 31 日）", () => {
    expect(() => transformOne(legacyRow({ created_at: "2026-02-31" }))).toThrow(MigrationDataError);
  });

  it("日付として読めない due", () => {
    expect(() => transformOne(legacyRow({ due: "来週の金曜" }))).toThrow(MigrationDataError);
  });
});

describe("dry-run の 1 行表現", () => {
  it("null と空文字を見分けられる形で全列を出す", () => {
    const { input } = transformOne(
      legacyRow({ id: 12, category: "エンジニア学習", memo: "塩漬け", status: "someday" }),
    );
    expect(JSON.parse(formatInput(input))).toEqual({
      id: 12,
      user_id: "github:64899536",
      workspace: "life",
      project: "エンジニア学習",
      title: "テストタスク",
      status: "someday",
      due: null,
      memo: "塩漬け",
      created_at: "2026-08-02T00:00:00Z",
      updated_at: "2026-08-02T00:00:00Z",
      closed_at: null,
    });
  });
});
