import type { Task } from "@todo-mcp/core";
import { describe, expect, it } from "vitest";

import { AGENDA_HORIZON_DAYS, buildAgenda, buildSearchResult, openIdsAnchor } from "../src/todo-format";

/**
 * DB を触らない純関数のテスト。server の tsconfig は node 型を持たないため
 * node:sqlite の in-memory DB は使えないが（design-notes.md 参照）、
 * buildAgenda / buildSearchResult / openIdsAnchor はどれも Task の配列と
 * プリミティブしか受け取らないので、その制約は最初から関係ない。
 */

const TODAY = "2026-08-08";
/** today からちょうど AGENDA_HORIZON_DAYS(7) 日後。 */
const HORIZON = "2026-08-15";
/** horizon の 1 日先。「7日以内」からは外れるはずの境界値。 */
const AFTER_HORIZON = "2026-08-16";

let nextId = 1;

/** テスト用の最小 Task。上書きしたいフィールドだけ渡す。 */
function task(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? nextId++;
  return {
    workspace: "life",
    project: null,
    title: `タスク#${id}`,
    status: "todo",
    due: null,
    memo: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    closed_at: null,
    ...overrides,
    id,
  };
}

describe("buildAgenda", () => {
  it("セクション境界: 期限切れ / 今日 / horizon ちょうど(含む) / horizon+1(含まない) / someday の due は無視 / 進行中・待ち（期限なし）", () => {
    const overdue = task({ id: 1, due: "2026-08-07" });
    const dueToday = task({ id: 2, due: TODAY });
    const dueAtHorizon = task({ id: 3, due: HORIZON });
    const dueAfterHorizon = task({ id: 4, due: AFTER_HORIZON });
    const somedayWithDue = task({ id: 5, due: "2026-08-09", status: "someday" });
    const inProgressNoDue = task({ id: 6, status: "in_progress" });
    const waitingNoDue = task({ id: 7, status: "waiting" });

    const text = buildAgenda(
      "life",
      [
        overdue,
        dueToday,
        dueAtHorizon,
        dueAfterHorizon,
        somedayWithDue,
        inProgressNoDue,
        waitingNoDue,
      ],
      TODAY,
      HORIZON,
    );

    expect(text).toContain("## 期限切れ (1)");
    expect(text).toContain("#1 [todo] タスク#1");

    expect(text).toContain("## 今日が期限 (1)");
    expect(text).toContain("#2 [todo] タスク#2");

    // due === horizon はちょうど境界（<= horizon）なので「7日以内」に含まれる
    expect(text).toContain(`## ${AGENDA_HORIZON_DAYS}日以内 (1)`);
    expect(text).toContain("#3 [todo] タスク#3");

    // due === horizon + 1 はどのセクションにも出ない
    expect(text).not.toContain("#4 [todo]");

    // someday は due があっても due ベースのセクションに出ない（dated フィルタで除外）
    expect(text).not.toContain("#5 [someday]");

    expect(text).toContain("## 進行中（期限なし） (1)");
    expect(text).toContain("#6 [in_progress] タスク#6");

    expect(text).toContain("## 待ち（期限なし） (1)");
    expect(text).toContain("#7 [waiting] タスク#7");

    // フッターの内訳: rest = #4（期限なし or 7日より先）+ #5（someday）の 2 件
    expect(text).toContain(
      "_他に open 2 件（someday 1 件・期限なし or 7日より先 1 件）は含まれていない。見るには search_tasks。_",
    );
  });

  it("行動対象が 0 件のとき専用メッセージを出す", () => {
    const text = buildAgenda("work", [], TODAY, HORIZON);
    expect(text).toContain("今日の行動対象はありません。");
  });

  it("rest が 0 件のときはフッター行を出さない", () => {
    const only = task({ id: 1, due: TODAY });
    const text = buildAgenda("life", [only], TODAY, HORIZON);
    expect(text).not.toContain("_他に open");
  });

  it("someday に due がない場合もフッターの someday 件数に数える", () => {
    const somedayNoDue = task({ id: 1, status: "someday" });
    const text = buildAgenda("life", [somedayNoDue], TODAY, HORIZON);
    expect(text).toContain(
      "_他に open 1 件（someday 1 件・期限なし or 7日より先 0 件）は含まれていない。見るには search_tasks。_",
    );
  });
});

describe("buildSearchResult", () => {
  it("0 件・status 指定時は実効スコープを status で示し、include_closed の案内は出さない（SQL が status を優先し includeClosed を無視するため）", () => {
    const text = buildSearchResult("life", 0, [], { status: "done", includeClosed: false });
    expect(text).toContain('status: "done" のみ');
    expect(text).not.toContain("include_closed: true");
  });

  it("0 件・status 未指定 + include_closed: true のときは実際に検索した範囲（closed 含む）を示し、これ以上広げる案内は出さない", () => {
    const text = buildSearchResult("life", 0, [], { status: undefined, includeClosed: true });
    expect(text).toContain("closed 含む");
    expect(text).not.toContain("include_closed: true");
  });

  it("0 件・status 未指定 + include_closed: false のときは open のみと示し、include_closed の案内を出す", () => {
    const text = buildSearchResult("life", 0, [], { status: undefined, includeClosed: false });
    expect(text).toContain("open のみ");
    expect(text).toContain("include_closed: true");
  });

  it("total が表示件数を超えるとき絞り込み誘導行を出す", () => {
    const shown = [task({ id: 1 })];
    const text = buildSearchResult("life", 5, shown, { status: undefined, includeClosed: false });
    expect(text).toContain(
      "_4 件は表示していない。query / status / project で絞り込んで再検索すること。_",
    );
  });

  it("total === 表示件数のときは誘導行を出さない", () => {
    const shown = [task({ id: 1 })];
    const text = buildSearchResult("life", 1, shown, { status: undefined, includeClosed: false });
    expect(text).not.toContain("は表示していない");
  });
});

describe("openIdsAnchor", () => {
  it("0 件は (なし)", () => {
    expect(openIdsAnchor([])).toBe("(なし)");
  });

  it("20 件以下はすべて表示し、超過表記を出さない", () => {
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    const text = openIdsAnchor(ids);
    expect(text).toBe(ids.map((id) => `#${id}`).join(", "));
    expect(text).not.toContain("…他");
  });

  it("20 件超は先頭 20 件だけ表示し、残り件数を示す", () => {
    const ids = Array.from({ length: 23 }, (_, index) => index + 1);
    const text = openIdsAnchor(ids);
    expect(text).toContain(ids.slice(0, 20).map((id) => `#${id}`).join(", "));
    expect(text).toContain("…他3件");
  });
});
