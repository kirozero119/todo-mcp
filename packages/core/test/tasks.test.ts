import { beforeEach, describe, expect, it } from "vitest";

import type { TaskDb } from "../src/db";
import {
  completeTask,
  createTask,
  getTask,
  listOpenTaskIds,
  listOpenTasks,
  searchTasks,
  updateTask,
} from "../src/tasks";
import { createInMemoryTaskDb } from "./support/sqlite-task-db";

const ME = "github:1";
const SOMEONE_ELSE = "github:2";
const T0 = "2026-08-01T00:00:00Z";
const T1 = "2026-08-02T00:00:00Z";

let db: TaskDb;

beforeEach(() => {
  db = createInMemoryTaskDb();
});

/** 引数を書かずに済ませるための最小の作成ヘルパー。 */
async function seed(overrides: Partial<Parameters<typeof createTask>[1]> = {}) {
  return createTask(db, {
    userId: ME,
    workspace: "life",
    title: "テストタスク",
    now: T0,
    ...overrides,
  });
}

// user_id スコープ。ここが破れると他人のタスクが見える／書き換わるので、
// 全クエリ関数について「他人の行に触れない」を個別に押さえる。
describe("user_id スコープ", () => {
  it("他人のタスクは listOpenTasks に出ない", async () => {
    await seed({ title: "自分の" });
    await seed({ userId: SOMEONE_ELSE, title: "他人の" });

    const mine = await listOpenTasks(db, { userId: ME, workspace: "life" });
    expect(mine.map((task) => task.title)).toEqual(["自分の"]);
  });

  it("他人のタスクは id を知っていても getTask で取れない", async () => {
    const theirs = await seed({ userId: SOMEONE_ELSE, title: "他人の" });

    expect(await getTask(db, { userId: ME, id: theirs.id })).toBeNull();
    // 存在しない id と同じ返り値であること（存在の有無を漏らさない）
    expect(await getTask(db, { userId: ME, id: 9999 })).toBeNull();
  });

  it("他人のタスクは updateTask で書き換えられない", async () => {
    const theirs = await seed({ userId: SOMEONE_ELSE, title: "他人の" });

    expect(
      await updateTask(db, { userId: ME, id: theirs.id, title: "乗っ取り", now: T1 }),
    ).toBeNull();
    const untouched = await getTask(db, { userId: SOMEONE_ELSE, id: theirs.id });
    expect(untouched?.title).toBe("他人の");
    expect(untouched?.updated_at).toBe(T0);
  });

  it("他人のタスクは completeTask で done にできない", async () => {
    const theirs = await seed({ userId: SOMEONE_ELSE, title: "他人の" });

    expect(await completeTask(db, { userId: ME, id: theirs.id, now: T1 })).toBeNull();
    expect((await getTask(db, { userId: SOMEONE_ELSE, id: theirs.id }))?.status).toBe("todo");
  });

  it("他人のタスクは searchTasks / listOpenTaskIds に出ない", async () => {
    await seed({ userId: SOMEONE_ELSE, title: "他人の秘密" });

    const found = await searchTasks(db, { userId: ME, workspace: "life", query: "秘密", limit: 20 });
    expect(found).toEqual({ total: 0, tasks: [] });
    expect(await listOpenTaskIds(db, { userId: ME })).toEqual([]);
  });
});

describe("workspace 絞り込み", () => {
  it("listOpenTasks は指定した workspace だけを返す", async () => {
    await seed({ workspace: "work", title: "仕事" });
    await seed({ workspace: "life", title: "私事" });

    expect(
      (await listOpenTasks(db, { userId: ME, workspace: "work" })).map((task) => task.title),
    ).toEqual(["仕事"]);
    expect(
      (await listOpenTasks(db, { userId: ME, workspace: "life" })).map((task) => task.title),
    ).toEqual(["私事"]);
  });

  it("listOpenTaskIds は workspace 省略時に全 workspace を返す", async () => {
    const work = await seed({ workspace: "work" });
    const life = await seed({ workspace: "life" });

    expect(await listOpenTaskIds(db, { userId: ME })).toEqual([work.id, life.id]);
    expect(await listOpenTaskIds(db, { userId: ME, workspace: "work" })).toEqual([work.id]);
  });
});

describe("status 遷移と closed_at", () => {
  it("createTask の既定は todo・closed_at なし", async () => {
    const task = await seed();
    expect(task.status).toBe("todo");
    expect(task.closed_at).toBeNull();
    expect(task.created_at).toBe(T0);
    expect(task.updated_at).toBe(T0);
  });

  it("cancelled への変更で closed_at が入る（物理削除しない）", async () => {
    const task = await seed();
    const result = await updateTask(db, { userId: ME, id: task.id, status: "cancelled", now: T1 });

    expect(result?.changed).toEqual(["status"]);
    expect(result?.task.status).toBe("cancelled");
    expect(result?.task.closed_at).toBe(T1);
    // 行は残っている
    expect((await getTask(db, { userId: ME, id: task.id }))?.title).toBe("テストタスク");
  });

  it("closed から open に戻すと closed_at が消える", async () => {
    const task = await seed({ status: "done" });
    expect(task.closed_at).toBe(T0);

    const result = await updateTask(db, { userId: ME, id: task.id, status: "todo", now: T1 });
    expect(result?.task.closed_at).toBeNull();
  });

  it("completeTask は done にして closed_at を入れる", async () => {
    const task = await seed();
    const result = await completeTask(db, { userId: ME, id: task.id, now: T1 });

    expect(result).toEqual({
      alreadyDone: false,
      task: expect.objectContaining({ status: "done", closed_at: T1, updated_at: T1 }),
    });
  });

  it("completeTask は冪等 —— 既に done なら closed_at を上書きしない", async () => {
    const task = await seed();
    await completeTask(db, { userId: ME, id: task.id, now: T0 });

    const again = await completeTask(db, { userId: ME, id: task.id, now: T1 });
    expect(again?.alreadyDone).toBe(true);
    expect(again?.task.closed_at).toBe(T0);
  });

  it("同時に complete_task しても両方が『今回完了した』と応答せず、closed_at は最初の完了時刻のまま", async () => {
    const task = await seed();
    const T2 = "2026-08-03T00:00:00Z";

    // このテストの TaskDb（node:sqlite 版）は db.all()/db.get() の中身が
    // 同期実行のうえで Promise.resolve() に包まれているだけ。そのため
    // Promise.all で並べた 2 本の completeTask は「両方の UPDATE 文が、
    // どちらの結果も読まれるより先に評価順で逐次実行される」形になり、
    // 2 台からの同時 complete_task で起きる read-then-write レースを
    // ここで決定的に再現できる。
    const [a, b] = await Promise.all([
      completeTask(db, { userId: ME, id: task.id, now: T1 }),
      completeTask(db, { userId: ME, id: task.id, now: T2 }),
    ]);

    const results = [a, b].filter((r): r is NonNullable<typeof r> => r !== null);
    expect(results).toHaveLength(2);

    const winners = results.filter((r) => !r.alreadyDone);
    const losers = results.filter((r) => r.alreadyDone);
    // ちょうど 1 本だけが「今回完了した」と応答する（両方が名乗ってはいけない）。
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // 既 done 応答側の closed_at は、勝った側が書いた時刻のまま
    // ——自分が渡した now では上書きされない。
    expect(losers[0]?.task.closed_at).toBe(winners[0]?.task.closed_at);

    const final = await getTask(db, { userId: ME, id: task.id });
    expect(final?.closed_at).toBe(winners[0]?.task.closed_at);
  });

  it("open なタスクだけが listOpenTasks に出る（someday は open 扱い）", async () => {
    await seed({ title: "someday のもの", status: "someday" });
    await seed({ title: "done のもの", status: "done" });
    await seed({ title: "cancelled のもの", status: "cancelled" });

    const open = await listOpenTasks(db, { userId: ME, workspace: "life" });
    expect(open.map((task) => task.title)).toEqual(["someday のもの"]);
  });
});

describe("updateTask の部分更新", () => {
  it("渡した列だけ変わり、渡さなかった列は保たれる", async () => {
    const task = await seed({ project: "家計", due: "2026-08-10", memo: "元のメモ" });

    const result = await updateTask(db, { userId: ME, id: task.id, due: "2026-08-20", now: T1 });

    expect(result?.changed).toEqual(["due"]);
    expect(result?.task).toMatchObject({
      title: "テストタスク",
      project: "家計",
      due: "2026-08-20",
      memo: "元のメモ",
      updated_at: T1,
    });
  });

  it("null を渡すと消える（undefined = 触らない と区別する）", async () => {
    const task = await seed({ project: "家計", due: "2026-08-10", memo: "メモ" });

    const result = await updateTask(db, { userId: ME, id: task.id, due: null, memo: null, now: T1 });

    expect(result?.changed).toEqual(["due", "memo"]);
    expect(result?.task.due).toBeNull();
    expect(result?.task.memo).toBeNull();
    expect(result?.task.project).toBe("家計");
  });

  it("同じ値を渡し直しても変更なし扱いで updated_at を動かさない", async () => {
    const task = await seed({ title: "テストタスク" });

    const result = await updateTask(db, { userId: ME, id: task.id, title: "テストタスク", now: T1 });

    expect(result?.changed).toEqual([]);
    expect(result?.task.updated_at).toBe(T0);
  });

  it("workspace も更新できる（レンズの移動）", async () => {
    const task = await seed({ workspace: "life" });

    const result = await updateTask(db, { userId: ME, id: task.id, workspace: "work", now: T1 });

    expect(result?.changed).toEqual(["workspace"]);
    expect(await listOpenTasks(db, { userId: ME, workspace: "life" })).toEqual([]);
    expect((await listOpenTasks(db, { userId: ME, workspace: "work" })).length).toBe(1);
  });
});

describe("searchTasks", () => {
  it("既定は open のみ・include_closed で閉じたものも含む", async () => {
    await seed({ title: "open のもの" });
    await seed({ title: "done のもの", status: "done" });

    const openOnly = await searchTasks(db, { userId: ME, workspace: "life", limit: 20 });
    expect(openOnly.tasks.map((task) => task.title)).toEqual(["open のもの"]);

    const withClosed = await searchTasks(db, {
      userId: ME,
      workspace: "life",
      includeClosed: true,
      limit: 20,
    });
    expect(withClosed.total).toBe(2);
  });

  it("query は title と memo の両方に当たる", async () => {
    await seed({ title: "OAuth の仕様を読む" });
    await seed({ title: "無関係", memo: "OAuth のリンクだけメモ" });
    await seed({ title: "当たらないもの" });

    const found = await searchTasks(db, {
      userId: ME,
      workspace: "life",
      query: "OAuth",
      limit: 20,
    });
    expect(found.total).toBe(2);
  });

  it("query の % は文字として扱う（LIKE のワイルドカードにしない）", async () => {
    await seed({ title: "進捗 50% のタスク" });
    await seed({ title: "関係ないタスク" });

    const found = await searchTasks(db, { userId: ME, workspace: "life", query: "50%", limit: 20 });
    expect(found.tasks.map((task) => task.title)).toEqual(["進捗 50% のタスク"]);
  });

  it("query の _ は文字として扱う（LIKE の単一文字ワイルドカードにしない）", async () => {
    await seed({ title: "under_score のタスク" });
    // "_" が単一文字ワイルドカードのままだと、無関係な "underXscore" にも
    // マッチしてしまう。
    await seed({ title: "underXscore のタスク" });

    const found = await searchTasks(db, {
      userId: ME,
      workspace: "life",
      query: "under_score",
      limit: 20,
    });
    expect(found.tasks.map((task) => task.title)).toEqual(["under_score のタスク"]);
  });

  it("query の \\ はエスケープ文字自体として扱う", async () => {
    await seed({ title: "パス C:\\temp のタスク" });
    await seed({ title: "関係ないタスク" });

    const found = await searchTasks(db, {
      userId: ME,
      workspace: "life",
      query: "C:\\temp",
      limit: 20,
    });
    expect(found.tasks.map((task) => task.title)).toEqual(["パス C:\\temp のタスク"]);
  });

  it("limit で打ち切っても total は全件数を返す", async () => {
    for (let index = 0; index < 5; index += 1) await seed({ title: `タスク${index}` });

    const found = await searchTasks(db, { userId: ME, workspace: "life", limit: 2 });
    expect(found.total).toBe(5);
    expect(found.tasks).toHaveLength(2);
  });

  it("期限が近い順・期限なしは最後", async () => {
    await seed({ title: "期限なし" });
    await seed({ title: "遅い", due: "2026-09-01" });
    await seed({ title: "早い", due: "2026-08-05" });

    const found = await searchTasks(db, { userId: ME, workspace: "life", limit: 20 });
    expect(found.tasks.map((task) => task.title)).toEqual(["早い", "遅い", "期限なし"]);
  });

  it("project 完全一致で絞れる", async () => {
    await seed({ title: "家計のもの", project: "家計" });
    await seed({ title: "学習のもの", project: "エンジニア学習" });

    const found = await searchTasks(db, {
      userId: ME,
      workspace: "life",
      project: "家計",
      limit: 20,
    });
    expect(found.tasks.map((task) => task.title)).toEqual(["家計のもの"]);
  });
});
