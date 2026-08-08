import { describe, expect, it } from "vitest";

import { parseArgs, resolveTarget, UsageError } from "../src/cli";

/**
 * 誤って本番に書くのを止める仕組みそのもののテスト。
 *
 * ここが 1 本も無いまま本番投入に向かっていた。実 DB に触らないので
 * （`parseArgs` / `resolveTarget` はどちらも純粋関数）、テストしない理由も無かった。
 */

const DEV_URL = "libsql://todo-mcp-dev-fumiya-matsumoto.aws-ap-northeast-1.turso.io";
const PROD_URL = "libsql://todo-mcp-prod-fumiya-matsumoto.aws-ap-northeast-1.turso.io";

/** 最小の正しい引数列。個々のテストはここから 1 つだけ崩す。 */
const OK = ["--target", "dev", "--dry-run", "--only-open"];

describe("parseArgs: モード指定（既定値を置かない）", () => {
  it("--dry-run と --execute の両方を指定したら止まる", () => {
    expect(() => parseArgs(["--target", "dev", "--dry-run", "--execute", "--only-open"])).toThrow(
      UsageError,
    );
  });

  it("モードを 1 つも指定しなければ止まる", () => {
    expect(() => parseArgs(["--target", "dev", "--only-open"])).toThrow(UsageError);
  });

  it("--execute だけなら execute=true で通る", () => {
    expect(parseArgs(["--target", "prod", "--execute", "--only-open"]).execute).toBe(true);
  });

  it("--dry-run だけなら execute=false で通る", () => {
    expect(parseArgs(OK).execute).toBe(false);
  });
});

describe("parseArgs: 引数そのものの形", () => {
  it("--target が無ければ止まる", () => {
    expect(() => parseArgs(["--dry-run", "--only-open"])).toThrow(UsageError);
  });

  it("--target が dev / prod 以外なら止まる", () => {
    expect(() => parseArgs(["--target", "staging", "--dry-run", "--only-open"])).toThrow(UsageError);
  });

  it("知らないフラグで止まる（黙って無視しない）", () => {
    expect(() => parseArgs([...OK, "--force"])).toThrow(/知らない引数/);
  });

  it("値の要るフラグに値が無ければ止まる", () => {
    expect(() => parseArgs(["--target", "--dry-run", "--only-open"])).toThrow(/値が要る/);
    expect(() => parseArgs([...OK, "--source"])).toThrow(/値が要る/);
  });
});

// --workspace は Zod enum を通すのに --user-id だけ素通しだった。誤った値で流すと
// 全行が誰にも見えないスコープに入り、投入後の確認も同じ値で読み直すので成功扱いになる。
describe("parseArgs: --user-id の形式（github:<数値>）", () => {
  it("名前空間を欠いた値を拒否する", () => {
    expect(() => parseArgs([...OK, "--user-id", "64899536"])).toThrow(UsageError);
  });

  it("数値以外の id を拒否する", () => {
    expect(() => parseArgs([...OK, "--user-id", "github:fumiya"])).toThrow(UsageError);
  });

  it("別 IdP の名前空間を拒否する", () => {
    expect(() => parseArgs([...OK, "--user-id", "google:64899536"])).toThrow(UsageError);
  });

  it("前後に余計な文字があるものを拒否する（部分一致で通さない）", () => {
    expect(() => parseArgs([...OK, "--user-id", " github:64899536"])).toThrow(UsageError);
    expect(() => parseArgs([...OK, "--user-id", "github:64899536\n"])).toThrow(UsageError);
    expect(() => parseArgs([...OK, "--user-id", "xgithub:64899536"])).toThrow(UsageError);
  });

  it("github:<数値> は通る", () => {
    expect(parseArgs([...OK, "--user-id", "github:583231"]).userId).toBe("github:583231");
  });

  it("既定値も同じ形式（08 で確定した canonical identity）", () => {
    expect(parseArgs(OK).userId).toMatch(/^github:\d+$/);
  });
});

// 全件移行は done 140 件を含み、旧 category を work / life のどちらに載せるかが未決。
// 単一の --workspace 値では割り切れないので、判断が決まるまで実行させない。
describe("parseArgs: --only-open が無ければ実行前に止まる", () => {
  it("--execute で外したら止まる", () => {
    expect(() => parseArgs(["--target", "prod", "--execute"])).toThrow(UsageError);
  });

  it("--dry-run でも止まる（全件の下見も workspace 判断が要る）", () => {
    expect(() => parseArgs(["--target", "dev", "--dry-run"])).toThrow(UsageError);
  });

  it("停止メッセージが category → workspace のマッピング決定を要求している", () => {
    expect(() => parseArgs(["--target", "dev", "--dry-run"])).toThrow(
      /category → workspace のマッピング決定/,
    );
  });

  it("--only-open を付ければ通る", () => {
    expect(parseArgs(OK).onlyOpen).toBe(true);
  });
});

describe("resolveTarget: 資格情報の解決", () => {
  it("target ごとの環境変数が揃っていなければ止まる", () => {
    expect(() => resolveTarget("dev", {})).toThrow(UsageError);
    expect(() => resolveTarget("dev", { TURSO_DEV_DATABASE_URL: DEV_URL })).toThrow(UsageError);
    expect(() => resolveTarget("dev", { TURSO_DEV_AUTH_TOKEN: "t" })).toThrow(UsageError);
  });

  it("共通の TURSO_DATABASE_URL は読まない（シェルに残った値で行き先が決まらない）", () => {
    expect(() =>
      resolveTarget("prod", { TURSO_DATABASE_URL: PROD_URL, TURSO_AUTH_TOKEN: "t" }),
    ).toThrow(UsageError);
  });

  it("--target prod の環境変数に dev の URL が入っていたら止まる", () => {
    expect(() =>
      resolveTarget("prod", { TURSO_PROD_DATABASE_URL: DEV_URL, TURSO_PROD_AUTH_TOKEN: "t" }),
    ).toThrow(/todo-mcp-prod で始まっていない/);
  });

  it("--target dev の環境変数に prod の URL が入っていたら止まる", () => {
    expect(() =>
      resolveTarget("dev", { TURSO_DEV_DATABASE_URL: PROD_URL, TURSO_DEV_AUTH_TOKEN: "t" }),
    ).toThrow(/todo-mcp-dev で始まっていない/);
  });

  it("正しい組み合わせは通り、host を返す", () => {
    expect(
      resolveTarget("prod", { TURSO_PROD_DATABASE_URL: PROD_URL, TURSO_PROD_AUTH_TOKEN: "t" }),
    ).toEqual({
      url: PROD_URL,
      authToken: "t",
      host: "todo-mcp-prod-fumiya-matsumoto.aws-ap-northeast-1.turso.io",
    });
  });

  // ホスト照合は「完全一致 または `<expected>-` で始まる」。`&&` を `||` に変えると
  // この 1 本目が落ち、`startsWith` だけにすると 2 本目が落ちる。
  it("ホスト名がちょうど todo-mcp-prod の DB を受け入れる", () => {
    expect(
      resolveTarget("prod", {
        TURSO_PROD_DATABASE_URL: "libsql://todo-mcp-prod",
        TURSO_PROD_AUTH_TOKEN: "t",
      }).host,
    ).toBe("todo-mcp-prod");
  });

  it("todo-mcp-prod2.turso.io のような別 DB は拒否する（前方一致だけでは通ってしまう）", () => {
    expect(() =>
      resolveTarget("prod", {
        TURSO_PROD_DATABASE_URL: "libsql://todo-mcp-prod2.turso.io",
        TURSO_PROD_AUTH_TOKEN: "t",
      }),
    ).toThrow(/todo-mcp-prod で始まっていない/);
  });

  it("file: URL は拒否する（ホストが空なので照合に通らない）", () => {
    expect(() =>
      resolveTarget("dev", {
        TURSO_DEV_DATABASE_URL: "file:///Users/fumiya/life/todos/todos.db",
        TURSO_DEV_AUTH_TOKEN: "t",
      }),
    ).toThrow(UsageError);
  });

  it("URL として読めない値は UsageError にする（TypeError を素通ししない）", () => {
    expect(() =>
      resolveTarget("dev", { TURSO_DEV_DATABASE_URL: "todo-mcp-dev", TURSO_DEV_AUTH_TOKEN: "t" }),
    ).toThrow(/URL として読めない/);
  });
});
