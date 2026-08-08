/**
 * 引数と接続先の検査だけを集めた層。DB にも `process` にも触らない純粋関数。
 *
 * 分けてある理由は 1 つ。ここにあるのは**誤って本番に書くのを止める仕組みそのもの**で、
 * 判定が変わったら気付けなければならない。`main.ts` に private 関数として置いたままだと
 * テストから import できず、この 2 つだけがテスト無しで残っていた
 * （packages/server の `allowlist.ts` / `redirect-uri.ts` と同じ「純粋なガード + I/O シェル」の形に揃えた）。
 *
 * 設計上の要点は 4 つ。
 *
 * 1. **モードを既定値にしない**。`--dry-run` か `--execute` のどちらかを必ず書かせる。
 *    「どっちが既定だったか」を思い出す必要がある形にすると、思い出し間違いが
 *    そのまま書き込みになる。
 * 2. **接続先は `--target` で名指しし、資格情報も target ごとに別の環境変数から取る**。
 *    共通の `TURSO_DATABASE_URL` を読む形だと、シェルに残った値の向き先で
 *    書き込み先が決まってしまう。さらに URL のホスト名が `todo-mcp-<target>` で
 *    始まることを確認し、名前と実体の食い違いでも止める。
 * 3. **`--user-id` も形式を検証する**。名前空間を欠いた値や別ユーザーの値を渡すと
 *    全行が誰にも見えないスコープへ入るが、投入後の確認も同じ指定値で読み直すので
 *    「増分が一致した」と成功扱いになる —— 誤入力を検証が自分で追認してしまう。
 * 4. **`--only-open` を必須にする**。全件移行（done 140 件を含む）は旧 category を
 *    work / life のどちらに載せるかが未決なので、単一の `--workspace` 値で流せない。
 */
import { homedir } from "node:os";

import { workspaceSchema, type Workspace } from "@todo-mcp/core";

/** 08 で canonical identity として確定した松本さんの GitHub 数値 id。 */
export const DEFAULT_USER_ID = "github:64899536";

/** 03 §2 の境界で、生存 8 件はすべて life（PKSHA 本業の生きタスクはゼロ）。 */
export const DEFAULT_WORKSPACE: Workspace = "life";

export const DEFAULT_SOURCE = `${homedir()}/life/todos/todos.db`;

export const TARGETS = ["dev", "prod"] as const;
export type Target = (typeof TARGETS)[number];

/** 名前空間付きの識別子。`packages/server/src/allowlist.ts` の `githubUserId()` と同じ形。 */
const USER_ID_FORMAT = /^github:\d+$/;

export const USAGE = `使い方:
  npm run migrate --workspace @todo-mcp/migrate -- --target <dev|prod> <--dry-run|--execute> --only-open [options]

必須:
  --target <dev|prod>     接続先。資格情報は TURSO_DEV_* / TURSO_PROD_* から読む
  --dry-run               投入予定の行を全部出力して終わる（書き込みなし）
  --execute               実際に INSERT する（--dry-run と排他、既定なし）
  --only-open             done 以外の行だけ移行する。全件移行は保留中（下記）

options:
  --source <path>         移行元 SQLite（既定: ${DEFAULT_SOURCE}）
  --user-id <id>          投入する user_id。github:<数値> 形式（既定: ${DEFAULT_USER_ID}）
  --workspace <work|life> 全行に付ける workspace（既定: ${DEFAULT_WORKSPACE}）

環境変数:
  TURSO_DEV_DATABASE_URL / TURSO_DEV_AUTH_TOKEN
  TURSO_PROD_DATABASE_URL / TURSO_PROD_AUTH_TOKEN`;

export interface Options {
  target: Target;
  execute: boolean;
  /** 常に true。`--only-open` が必須なので false のまま返ることはない。 */
  onlyOpen: boolean;
  source: string;
  userId: string;
  workspace: Workspace;
}

export class UsageError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} には値が要る`);
  }
  return value;
}

export function parseArgs(argv: string[]): Options {
  let target: Target | undefined;
  let dryRun = false;
  let execute = false;
  let onlyOpen = false;
  let source = DEFAULT_SOURCE;
  let userId = DEFAULT_USER_ID;
  let workspace: Workspace = DEFAULT_WORKSPACE;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case "--target": {
        const value = requireValue(argv, (i += 1), "--target");
        if (!(TARGETS as readonly string[]).includes(value)) {
          throw new UsageError(`--target は dev か prod（受け取った値: ${JSON.stringify(value)}）`);
        }
        target = value as Target;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--execute":
        execute = true;
        break;
      case "--only-open":
        onlyOpen = true;
        break;
      case "--source":
        source = requireValue(argv, (i += 1), "--source");
        break;
      case "--user-id": {
        const value = requireValue(argv, (i += 1), "--user-id");
        // --workspace は Zod enum を通すのに --user-id だけ素通しだった（非対称）。
        // 誤った user_id で流すと全行が誰にも見えないスコープに入り、しかも
        // 投入後の確認が同じ値で読み直すので成功扱いになる。接続する前に止める。
        if (!USER_ID_FORMAT.test(value)) {
          throw new UsageError(
            `--user-id は github:<数値> の形（受け取った値: ${JSON.stringify(value)}）。` +
              `名前空間を欠いた値や別ユーザーの値で流すと、全行が誰にも見えないスコープに入る`,
          );
        }
        userId = value;
        break;
      }
      case "--workspace": {
        const value = requireValue(argv, (i += 1), "--workspace");
        const parsed = workspaceSchema.safeParse(value);
        if (!parsed.success) {
          throw new UsageError(
            `--workspace は work か life（受け取った値: ${JSON.stringify(value)}）`,
          );
        }
        workspace = parsed.data;
        break;
      }
      default:
        throw new UsageError(`知らない引数: ${JSON.stringify(flag)}`);
    }
  }

  if (target === undefined) throw new UsageError("--target が要る");
  if (dryRun === execute) {
    throw new UsageError("--dry-run か --execute のどちらか一方を必ず指定する（既定値は無い）");
  }
  if (!onlyOpen) {
    // 全件移行は「まだ決めていないこと」があるので、dry-run も含めて実行させない。
    // 旧 category は PKSHA 4 / work 5 / ラクス 5 / ナウキャスト 4 / Rox Products 2 が
    // 混ざっており、03 §2 の境界では work に落ちるものがある。しかも PKSHA でも
    // 2026-05-01 入社前の行は転職活動＝私事なので、単一の --workspace 値では割り切れない。
    throw new UsageError(
      "--only-open が要る（本番スコープは生存 8 件で確定・2026-08-08）。" +
        "全件移行には category → workspace のマッピング決定が先に要る —— " +
        "旧 category（PKSHA / work / ラクス / ナウキャスト / Rox Products）を work と life の" +
        "どちらに載せるかが未決で、全行を単一の --workspace 値で流すとその判断を機械的に間違える。" +
        "決めたうえで移行するなら、この停止を外すこと自体が判断の記録になる",
    );
  }
  return { target, execute, onlyOpen, source, userId, workspace };
}

/**
 * target 名から資格情報を引き、URL のホスト名が名前と一致することまで確認する。
 *
 * 環境変数名を target ごとに分けているので、prod を指定して dev の値が使われる
 * ことは起きない。それでも URL を照合するのは、環境変数の中身を貼り間違える
 * 事故（TURSO_PROD_DATABASE_URL に dev の URL）だけは名前の分離では防げないから。
 *
 * `env` を引数で受けるのは `process.env` を読まないため（テストから両方向の
 * 貼り間違いを直接与えられる）。
 */
export function resolveTarget(
  target: Target,
  env: Record<string, string | undefined>,
): { url: string; authToken: string; host: string } {
  const prefix = `TURSO_${target.toUpperCase()}_`;
  const url = env[`${prefix}DATABASE_URL`];
  const authToken = env[`${prefix}AUTH_TOKEN`];
  if (!url || !authToken) {
    throw new UsageError(
      `${prefix}DATABASE_URL / ${prefix}AUTH_TOKEN が未設定（--target ${target} はこの 2 つから接続先を決める）`,
    );
  }

  let host: string;
  try {
    host = new URL(url.replace(/^libsql:/, "https:")).host;
  } catch {
    throw new UsageError(
      `${prefix}DATABASE_URL が URL として読めない（受け取った値: ${JSON.stringify(url)}）`,
    );
  }
  const expected = `todo-mcp-${target}`;
  // `!==` と `!startsWith` の **両方**が成り立ったときだけ弾く。`||` にすると
  // ホスト名がちょうど `todo-mcp-prod` の DB を拒否してしまい、逆に
  // `startsWith(expected)` だけにすると `todo-mcp-prod2...` のような別 DB を通す。
  if (host !== expected && !host.startsWith(`${expected}-`)) {
    throw new UsageError(
      `--target ${target} なのに ${prefix}DATABASE_URL のホストが ${host}（${expected} で始まっていない）。環境変数の貼り間違いの可能性があるので中止する`,
    );
  }
  return { url, authToken, host };
}
