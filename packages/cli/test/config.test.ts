import { describe, expect, it } from "vitest";

import { ConfigError, resolveConfig } from "../src/config.ts";

const VALID = {
  TODO_DATABASE_URL: "libsql://todo-mcp-prod.example.turso.io",
  TODO_AUTH_TOKEN: "secret",
  TODO_USER_ID: "github:64899536",
  TODO_WORKSPACE: "life",
};

describe("resolveConfig", () => {
  it("4 変数を接続設定へ変換する", () => {
    expect(resolveConfig(VALID)).toEqual({
      url: VALID.TODO_DATABASE_URL,
      authToken: "secret",
      userId: "github:64899536",
      defaultWorkspace: "life",
    });
  });

  it("不足をまとめて報告する", () => {
    expect(() => resolveConfig({})).toThrow(
      "TODO_DATABASE_URL, TODO_AUTH_TOKEN, TODO_USER_ID, TODO_WORKSPACE",
    );
  });

  it("名前空間のない user id と不正 workspace を拒否する", () => {
    expect(() => resolveConfig({ ...VALID, TODO_USER_ID: "64899536" })).toThrow(ConfigError);
    expect(() => resolveConfig({ ...VALID, TODO_WORKSPACE: "private" })).toThrow(ConfigError);
  });
});
