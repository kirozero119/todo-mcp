/**
 * 旧 todos.db → Turso 移行スクリプト本体（wayfinder チケット 10）。
 *
 *   npm run migrate --workspace @todo-mcp/migrate -- --target dev --dry-run --only-open
 *
 * 設計上の要点は 3 つ。
 *
 * 1. **モードを既定値にしない**。`--dry-run` か `--execute` のどちらかを必ず書かせる。
 *    「どっちが既定だったか」を思い出す必要がある形にすると、思い出し間違いが
 *    そのまま書き込みになる。
 * 2. **接続先は `--target` で名指しし、資格情報も target ごとに別の環境変数から取る**。
 *    共通の `TURSO_DATABASE_URL` を読む形だと、シェルに残った値の向き先で
 *    書き込み先が決まってしまう。さらに URL のホスト名が `todo-mcp-<target>` で
 *    始まることを確認し、名前と実体の食い違いでも止める。
 * 3. **tasks への SQL は書かない**。INSERT は core の `importTask()`、投入後の
 *    件数確認は core の `searchTasks()` を通す。生 SQL を書いているのは
 *    `sqlite_sequence`（tasks ではない）だけで、理由は sequence.ts に書いた。
 */
import { homedir } from "node:os";

import {
  createTaskDb,
  importTask,
  searchTasks,
  workspaceSchema,
  type TaskDb,
  type Workspace,
} from "@todo-mcp/core";

import { readLegacy } from "./legacy";
import { raiseTaskSequence, readTaskSequence } from "./sequence";
import { formatInput, MigrationDataError, transformRows } from "./transform";

/** 08 で canonical identity として確定した松本さんの GitHub 数値 id。 */
const DEFAULT_USER_ID = "github:64899536";

/** 03 §2 の境界で、生存 8 件はすべて life（PKSHA 本業の生きタスクはゼロ）。 */
const DEFAULT_WORKSPACE: Workspace = "life";

const DEFAULT_SOURCE = `${homedir()}/life/todos/todos.db`;

const TARGETS = ["dev", "prod"] as const;
type Target = (typeof TARGETS)[number];

const USAGE = `使い方:
  npm run migrate --workspace @todo-mcp/migrate -- --target <dev|prod> <--dry-run|--execute> [options]

必須:
  --target <dev|prod>     接続先。資格情報は TURSO_DEV_* / TURSO_PROD_* から読む
  --dry-run               投入予定の行を全部出力して終わる（書き込みなし）
  --execute               実際に INSERT する（--dry-run と排他、既定なし）

options:
  --only-open             done 以外の行だけ移行する（既定: 全件）
  --source <path>         移行元 SQLite（既定: ${DEFAULT_SOURCE}）
  --user-id <id>          投入する user_id（既定: ${DEFAULT_USER_ID}）
  --workspace <work|life> 全行に付ける workspace（既定: ${DEFAULT_WORKSPACE}）

環境変数:
  TURSO_DEV_DATABASE_URL / TURSO_DEV_AUTH_TOKEN
  TURSO_PROD_DATABASE_URL / TURSO_PROD_AUTH_TOKEN`;

interface Options {
  target: Target;
  execute: boolean;
  onlyOpen: boolean;
  source: string;
  userId: string;
  workspace: Workspace;
}

class UsageError extends Error {}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} には値が要る`);
  }
  return value;
}

function parseArgs(argv: string[]): Options {
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
      case "--user-id":
        userId = requireValue(argv, (i += 1), "--user-id");
        break;
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
  return { target, execute, onlyOpen, source, userId, workspace };
}

/**
 * target 名から資格情報を引き、URL のホスト名が名前と一致することまで確認する。
 *
 * 環境変数名を target ごとに分けているので、prod を指定して dev の値が使われる
 * ことは起きない。それでも URL を照合するのは、環境変数の中身を貼り間違える
 * 事故（TURSO_PROD_DATABASE_URL に dev の URL）だけは名前の分離では防げないから。
 */
function resolveTarget(target: Target): { url: string; authToken: string; host: string } {
  const prefix = `TURSO_${target.toUpperCase()}_`;
  const url = process.env[`${prefix}DATABASE_URL`];
  const authToken = process.env[`${prefix}AUTH_TOKEN`];
  if (!url || !authToken) {
    throw new UsageError(
      `${prefix}DATABASE_URL / ${prefix}AUTH_TOKEN が未設定（--target ${target} はこの 2 つから接続先を決める）`,
    );
  }

  const host = new URL(url.replace(/^libsql:/, "https:")).host;
  const expected = `todo-mcp-${target}`;
  if (host !== expected && !host.startsWith(`${expected}-`)) {
    throw new UsageError(
      `--target ${target} なのに ${prefix}DATABASE_URL のホストが ${host}（${expected} で始まっていない）。環境変数の貼り間違いの可能性があるので中止する`,
    );
  }
  return { url, authToken, host };
}

/** この user_id・workspace の現在の行数。core のクエリ関数を通して読む。 */
async function countRows(db: TaskDb, userId: string, workspace: Workspace): Promise<number> {
  const { total } = await searchTasks(db, { userId, workspace, includeClosed: true, limit: 1 });
  return total;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const connection = resolveTarget(options.target);

  const legacy = readLegacy(options.source, { onlyOpen: options.onlyOpen });
  const { inputs, notes } = transformRows(legacy.rows, {
    userId: options.userId,
    workspace: options.workspace,
  });

  const statusCounts: Record<string, number> = {};
  let withDue = 0;
  for (const input of inputs) {
    statusCounts[input.status] = (statusCounts[input.status] ?? 0) + 1;
    if (input.due !== null && input.due !== undefined) withDue += 1;
  }

  console.log("=== 移行計画 ===");
  console.log(
    `モード          : ${options.execute ? "EXECUTE（書き込む）" : "DRY-RUN（書かない）"}`,
  );
  console.log(`移行元          : ${options.source}（読み取り専用で開いた）`);
  console.log(`移行先          : ${options.target} / ${connection.host}`);
  console.log(`user_id         : ${options.userId}`);
  console.log(`workspace       : ${options.workspace}（全行同じ）`);
  console.log(`絞り込み        : ${options.onlyOpen ? "--only-open（done を除く）" : "全件"}`);
  console.log(`旧 DB の全行数  : ${legacy.totalRows}`);
  console.log(`旧 DB の status : ${JSON.stringify(legacy.statusCounts)}`);
  console.log(`旧 DB の最大 id : ${legacy.maxId}`);
  console.log(`移行対象        : ${inputs.length} 件`);
  console.log(`  status 内訳   : ${JSON.stringify(statusCounts)}`);
  console.log(`  期限つき      : ${withDue} 件`);
  console.log(`正規化の発火    : ${notes.length} 件`);
  for (const note of notes) console.log(`  - #${note.id} [${note.kind}] ${note.detail}`);

  console.log("");
  console.log(`=== 投入される行（${inputs.length} 件・id 昇順） ===`);
  for (const input of inputs) console.log(formatInput(input));
  console.log("");

  const db = createTaskDb({ url: connection.url, authToken: connection.authToken });
  const existing = await countRows(db, options.userId, options.workspace);
  const sequence = await readTaskSequence(db);
  console.log("=== 移行先の現状 ===");
  console.log(`既存行（${options.userId} / ${options.workspace}）: ${existing} 件`);
  console.log(`sqlite_sequence(tasks): ${sequence ?? "(行なし)"}`);
  console.log("");

  if (!options.execute) {
    console.log("DRY-RUN のため書き込みは行っていない。");
    console.log(
      `--execute で実行すると ${inputs.length} 件を INSERT し、sqlite_sequence(tasks) を ${legacy.maxId} 以上へ引き上げる。`,
    );
    return;
  }

  console.log("=== 実行 ===");
  let inserted = 0;
  try {
    for (const input of inputs) {
      await importTask(db, input);
      inserted += 1;
      if (inserted % 25 === 0) console.log(`  ${inserted}/${inputs.length} 件`);
    }
  } catch (error) {
    // 途中で落ちた場合、ここまでの行は入ったまま残る（1 文ずつの INSERT で
    // トランザクションを張っていない）。何件入ったかを必ず出す —— 復旧は
    // 「入った分を消してやり直す」で、そのために件数が要る。
    console.error(`INSERT に失敗（${inserted}/${inputs.length} 件を投入済み）`);
    throw error;
  }
  console.log(`  ${inserted}/${inputs.length} 件 — 完了`);

  const sequenceResult = await raiseTaskSequence(db, legacy.maxId);
  console.log(
    `sqlite_sequence(tasks): ${sequenceResult.before ?? "(行なし)"} → ${sequenceResult.after}` +
      `${sequenceResult.changed ? "" : "（既に十分大きいので変更なし）"}`,
  );

  const after = await countRows(db, options.userId, options.workspace);
  console.log("");
  console.log("=== 投入後の確認（core の searchTasks で読み直した） ===");
  console.log(`${options.userId} / ${options.workspace} の行数: ${existing} → ${after}`);
  if (after - existing !== inputs.length) {
    throw new Error(
      `行数の増分が投入件数と一致しない（増分 ${after - existing} / 投入 ${inputs.length}）`,
    );
  }
  console.log("増分が投入件数と一致した。");
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`引数エラー: ${error.message}`);
    console.error("");
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (error instanceof MigrationDataError) {
    console.error(`移行元データが想定と違う: ${error.message}`);
    console.error("（1 行も書き込んでいない。変換は全行を作り終えてから投入する）");
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
