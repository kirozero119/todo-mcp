import { describe, expect, it } from "vitest";

import { parseArgs, UsageError } from "../src/args.ts";

describe("parseArgs", () => {
  it("旧 add の速い形を保ち、category を project として受ける", () => {
    expect(parseArgs(["add", "資料作成", "--category", "PKSHA", "--due", "2026-08-20"])).toEqual({
      kind: "add",
      title: "資料作成",
      project: "PKSHA",
      due: "2026-08-20",
    });
  });

  it("list は既定で closed を含めず、新しい status 全値を受ける", () => {
    expect(parseArgs(["list", "--status", "cancelled", "--workspace", "work"])).toEqual({
      kind: "list",
      includeClosed: false,
      status: "cancelled",
      workspace: "work",
    });
  });

  it("edit は値を null に戻す操作を明示できる", () => {
    expect(parseArgs(["edit", "12", "--clear-project", "--clear-due", "--clear-memo"])).toEqual({
      kind: "edit",
      id: 12,
      project: null,
      due: null,
      memo: null,
    });
  });

  it("実在しない日付を接続前に拒否する", () => {
    expect(() => parseArgs(["add", "タスク", "--due", "2026-02-30"])).toThrow(UsageError);
  });

  it("project の重複指定を拒否する", () => {
    expect(() =>
      parseArgs(["add", "タスク", "--project", "A", "--category", "B"]),
    ).toThrow("同時に指定できない");
    expect(() => parseArgs(["list", "--project", ""])).toThrow("空にできない");
  });

  it("変更のない edit と余計な delete 引数を拒否する", () => {
    expect(() => parseArgs(["edit", "1"])).toThrow("変更項目");
    expect(() => parseArgs(["delete", "1", "2"])).toThrow("todo delete <id>");
  });
});
