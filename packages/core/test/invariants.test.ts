import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `tasks.ts` 冒頭の不変条件を、prose ではなく実行できる形にしたもの。
 *
 * 元の言明は「tasks テーブルに対する SQL は全部ここにある」で、リポジトリ全体を
 * `FROM tasks` で grep すれば確認できるはずだった。ところが 10 で
 * `packages/migrate/src/legacy.ts` に**旧** todos.db の `FROM tasks` が 3 箇所入り
 * （旧スキーマもテーブル名が `tasks`）、grep の出力だけでは新旧を見分けられなくなった。
 *
 * 見分けの軸は「`TaskDb`（新 DB のハンドル）を受け取るか」。legacy.ts は
 * `node:sqlite` でローカルファイルを開くだけで `TaskDb` を import しないので、
 * 新 DB に文を送る手段を構造的に持たない。ここではその軸をそのまま検査している:
 *
 *   **`TaskDb` を受け取るファイルのうち、新 tasks への SQL を持つのは
 *   `packages/core/src/tasks.ts` ただ 1 つ。**
 *
 * 09 では「機械的な確認がテストより先に穴を見つけた」。その道具を鈍らせないために、
 * 確認自体をテストにしてある。
 */

const PACKAGES_DIR = fileURLToPath(new URL("../../", import.meta.url));

/** 新旧どちらの `tasks` にも当たる。新旧の判別は TaskDb の有無で行う。 */
const TASKS_STATEMENT = /\b(FROM|INTO|UPDATE)\s+tasks\b/;

/** 型として受け取っているか。prose での言及と区別するためコメントを落としてから見る。 */
const TASK_DB_REFERENCE = /\bTaskDb\b/;

const EXEMPT = "packages/core/src/tasks.ts";

/**
 * ブロックコメントと「行頭が //」の行を落とす。
 *
 * 行末コメントは残す —— 落とすと `https://` を含む文字列リテラルまで削れて、
 * 本物の違反を見逃す側に倒れるため。残す側の間違い（誤検出）はテストが赤くなるので気付ける。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

function collectSourceFiles(): { path: string; code: string }[] {
  const found: { path: string; code: string }[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules") continue;
      const full = `${dir}/${entry}`;
      const relative = `${rel}/${entry}`;
      if (statSync(full).isDirectory()) walk(full, relative);
      else if (entry.endsWith(".ts")) {
        found.push({ path: relative, code: stripComments(readFileSync(full, "utf8")) });
      }
    }
  };
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = `${PACKAGES_DIR}${pkg}/src`;
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    walk(src, `packages/${pkg}/src`);
  }
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

describe("tasks への SQL は core/src/tasks.ts に閉じている", () => {
  const files = collectSourceFiles();

  it("そもそも src を読めている（walk が空振りしていない）", () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.map((file) => file.path)).toContain(EXEMPT);
  });

  it("TaskDb を受け取るファイルで tasks への SQL を書いているのは tasks.ts だけ", () => {
    const offenders = files
      .filter((file) => file.path !== EXEMPT)
      .filter((file) => TASKS_STATEMENT.test(file.code) && TASK_DB_REFERENCE.test(file.code))
      .map((file) => file.path);

    expect(
      offenders,
      `TaskDb と tasks への SQL を同時に持つファイルがある: ${offenders.join(", ")}。` +
        "user_id スコープの確認が 1 ファイルの grep で済む、という不変条件が壊れている",
    ).toEqual([]);
  });

  it("tasks という語で書かれた SQL を持つファイルの一覧は、tasks.ts の doc コメントどおり", () => {
    // 増えたらここが落ちる。落ちたときは「新 DB か旧 DB か」を判断したうえで、
    // このリストと tasks.ts の確認手順を一緒に更新すること。
    expect(files.filter((file) => TASKS_STATEMENT.test(file.code)).map((file) => file.path)).toEqual(
      [EXEMPT, "packages/migrate/src/legacy.ts"],
    );
  });

  it("legacy.ts は TaskDb を受け取らない（旧 DB 専用であることが構造で分かる）", () => {
    const legacy = files.find((file) => file.path === "packages/migrate/src/legacy.ts");
    expect(legacy).toBeDefined();
    expect(TASK_DB_REFERENCE.test(legacy?.code ?? "")).toBe(false);
  });

  it("sequence.ts は TaskDb を受け取るが sqlite_sequence しか触らない", () => {
    const sequence = files.find((file) => file.path === "packages/migrate/src/sequence.ts");
    expect(sequence).toBeDefined();
    expect(TASK_DB_REFERENCE.test(sequence?.code ?? "")).toBe(true);
    expect(TASKS_STATEMENT.test(sequence?.code ?? "")).toBe(false);
  });
});
