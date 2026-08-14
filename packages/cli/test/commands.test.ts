import { beforeEach, describe, expect, it } from "vitest";

import { createTask, getTask } from "@todo-mcp/core";
import {
  createInMemoryTaskDb,
  type InMemoryTaskDb,
} from "../../core/test/support/sqlite-task-db.ts";

import { executeCommand } from "../src/commands.ts";

const ME = "github:1";
const OTHER = "github:2";
let db: InMemoryTaskDb;

beforeEach(() => {
  db = createInMemoryTaskDb();
});

const deps = () => ({ db, config: { userId: ME, defaultWorkspace: "life" as const } });

describe("executeCommand", () => {
  it("add は端末既定 workspace と user_id を注入する", async () => {
    const lines = await executeCommand(
      { kind: "add", title: "新しいタスク", project: "開発", due: "2026-08-20" },
      deps(),
    );

    expect(lines[0]).toContain("追加しました");
    const task = await getTask(db, { userId: ME, id: 1 });
    expect(task).toEqual(
      expect.objectContaining({
        workspace: "life",
        title: "新しいタスク",
        project: "開発",
        due: "2026-08-20",
      }),
    );
  });

  it("list は既定 workspace だけを人間向けに表示する", async () => {
    await createTask(db, { userId: ME, workspace: "life", title: "私事" });
    await createTask(db, { userId: ME, workspace: "work", title: "仕事" });
    await createTask(db, { userId: OTHER, workspace: "life", title: "他人" });

    const lines = await executeCommand({ kind: "list", includeClosed: false }, deps());

    expect(lines.join("\n")).toContain("私事");
    expect(lines.join("\n")).not.toContain("仕事");
    expect(lines.join("\n")).not.toContain("他人");
  });

  it("status waiting はメモが無いときだけヒントを出す", async () => {
    const task = await createTask(db, { userId: ME, workspace: "life", title: "返答待ち" });

    const lines = await executeCommand(
      { kind: "status", id: task.id, status: "waiting" },
      deps(),
    );

    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("--memo");
  });

  it("edit は project / due / memo を消せる", async () => {
    const task = await createTask(db, {
      userId: ME,
      workspace: "life",
      title: "整理",
      project: "旧",
      due: "2026-08-20",
      memo: "旧メモ",
    });

    await executeCommand(
      { kind: "edit", id: task.id, project: null, due: null, memo: null },
      deps(),
    );

    expect(await getTask(db, { userId: ME, id: task.id })).toEqual(
      expect.objectContaining({ project: null, due: null, memo: null }),
    );
  });

  it("delete は自分の行だけを物理削除する", async () => {
    const mine = await createTask(db, { userId: ME, workspace: "life", title: "消す" });
    const theirs = await createTask(db, { userId: OTHER, workspace: "life", title: "他人" });

    expect(await executeCommand({ kind: "delete", id: mine.id }, deps())).toEqual([
      expect.stringContaining("物理削除しました"),
    ]);
    expect(await executeCommand({ kind: "delete", id: theirs.id }, deps())).toEqual([
      `タスクID ${theirs.id} が見つかりません`,
    ]);
    expect(await getTask(db, { userId: OTHER, id: theirs.id })).not.toBeNull();
  });
});
