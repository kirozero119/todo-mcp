/**
 * tasks テーブルに対する SQL は全部ここにある。MCP サーバーにも CLI にも生 SQL は書かない。
 *
 * ここに集めている最大の理由は user_id スコープの強制。この 1 ファイルを grep すれば
 * 「user_id を条件に持たない文が 1 つもない」ことを機械的に確認できる状態を保つ
 * （SELECT / UPDATE は `WHERE user_id = ?`、INSERT は user_id を必ず値として書く）。
 * user_id は必ず引数で受け取り、この層では認証コンテキストを一切見ない。
 */
import type { TaskDb } from "./db";
import {
  isClosedStatus,
  OPEN_STATUSES,
  taskFromRow,
  type Status,
  type Task,
  type TaskField,
  type Workspace,
} from "./schema";
import { nowIso } from "./time";

/** SELECT / RETURNING で取り出す列。user_id を含めない理由は schema.ts の Task を参照。 */
const TASK_COLUMNS =
  "id, workspace, project, title, status, due, memo, created_at, updated_at, closed_at";

/**
 * null 可の自由テキスト列（project / memo）について、「値なし」の正準表現を null に寄せる。
 *
 * `""` を保存すると、書けるのに読めない行ができる。表示側は `if (task.project)` /
 * `if (task.memo)` で空文字を落とすので一覧にも詳細にも出ず、`searchTasks` の
 * `if (params.project)` も空文字を無視するので project 絞り込みで永久にヒットしない。
 * つまり呼び出し側（MCP なら AI）が自力で気付けず復旧もできない不可視の値になる。
 * 書き込みの入口で潰しておけば、DB に入った値は必ずどこかの読み取り経路から見える。
 *
 * 拒否ではなく正規化にしているのは、`""` を送る意図が実質「消す」だから（[09/レビュー2] 参照）。
 * title には使わない —— 消す意図を表現できる列ではないので、空なら拒否が正しい（入口側の責務）。
 */
function nullIfEmpty(value: string | null | undefined): string | null | undefined {
  return value === "" ? null : value;
}

/** 期限が近い順 → 期限なしは最後 → 同着は id 順。一覧系は全部この並びで揃える。 */
const ORDER_BY = "ORDER BY CASE WHEN due IS NULL THEN 1 ELSE 0 END, due, id";

const OPEN_STATUS_PLACEHOLDERS = OPEN_STATUSES.map(() => "?").join(", ");

/** 全クエリ共通の第 1 引数。 */
export interface UserScope {
  /** `github:<数値id>`。認証コンテキスト由来の値だけを渡すこと。 */
  userId: string;
}

/** open なタスクを 1 workspace 分まとめて返す（agenda の材料）。 */
export async function listOpenTasks(
  db: TaskDb,
  params: UserScope & { workspace: Workspace },
): Promise<Task[]> {
  const rows = await db.all(
    `SELECT ${TASK_COLUMNS} FROM tasks
      WHERE user_id = ? AND workspace = ? AND status IN (${OPEN_STATUS_PLACEHOLDERS})
      ${ORDER_BY}`,
    [params.userId, params.workspace, ...OPEN_STATUSES],
  );
  return rows.map(taskFromRow);
}

/**
 * id 指定で 1 件取る。他人の行は「存在しない」として null になる。
 *
 * 「他人の行なので見せない」と「そんな id はない」を区別して返さないのは意図的。
 * 区別すると、id を総当たりすることで他人のタスクの存在有無が読み取れてしまう。
 */
export async function getTask(db: TaskDb, params: UserScope & { id: number }): Promise<Task | null> {
  const row = await db.get(`SELECT ${TASK_COLUMNS} FROM tasks WHERE user_id = ? AND id = ?`, [
    params.userId,
    params.id,
  ]);
  return row ? taskFromRow(row) : null;
}

/**
 * open なタスクの id 一覧。id を間違えたときのエラー文に載せるアンカー用。
 *
 * workspace を省略すると全 workspace。id しか引数がないツール（complete_task /
 * get_task）はどちらのレンズの話か分からないため。
 */
export async function listOpenTaskIds(
  db: TaskDb,
  params: UserScope & { workspace?: Workspace },
): Promise<number[]> {
  const rows = params.workspace
    ? await db.all(
        `SELECT id FROM tasks
          WHERE user_id = ? AND workspace = ? AND status IN (${OPEN_STATUS_PLACEHOLDERS})
          ORDER BY id`,
        [params.userId, params.workspace, ...OPEN_STATUSES],
      )
    : await db.all(
        `SELECT id FROM tasks
          WHERE user_id = ? AND status IN (${OPEN_STATUS_PLACEHOLDERS})
          ORDER BY id`,
        [params.userId, ...OPEN_STATUSES],
      );
  return rows.map((row) => Number(row.id));
}

export interface CreateTaskInput extends UserScope {
  workspace: Workspace;
  title: string;
  status?: Status;
  /** `""` は null（値なし）として保存される。理由は nullIfEmpty を参照。 */
  project?: string | null;
  due?: string | null;
  /** `""` は null（値なし）として保存される。理由は nullIfEmpty を参照。 */
  memo?: string | null;
  /** テストが時刻を固定するための注入点。通常は省略する。 */
  now?: string;
}

/** 1 件作る。status を最初から done/cancelled にした場合は closed_at も同時に入る。 */
export async function createTask(db: TaskDb, input: CreateTaskInput): Promise<Task> {
  const timestamp = input.now ?? nowIso();
  const status: Status = input.status ?? "todo";
  const rows = await db.all(
    `INSERT INTO tasks
       (user_id, workspace, project, title, status, due, memo, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${TASK_COLUMNS}`,
    [
      input.userId,
      input.workspace,
      nullIfEmpty(input.project) ?? null,
      input.title,
      status,
      input.due ?? null,
      nullIfEmpty(input.memo) ?? null,
      timestamp,
      timestamp,
      isClosedStatus(status) ? timestamp : null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("INSERT ... RETURNING が行を返さなかった");
  return taskFromRow(row);
}

export interface ImportTaskInput extends UserScope {
  /** 旧 DB の id をそのまま持ち込む（発番させない）。 */
  id: number;
  workspace: Workspace;
  /** `""` は null（値なし）として保存される。理由は nullIfEmpty を参照。 */
  project?: string | null;
  title: string;
  status: Status;
  /** `""` は null。値がある場合は YYYY-MM-DD であること（検証は呼び出し側）。 */
  due?: string | null;
  /** `""` は null（値なし）として保存される。理由は nullIfEmpty を参照。 */
  memo?: string | null;
  /** ISO 8601 UTC。移行元の値をそのまま持ち込むので「今」を使わない。 */
  createdAt: string;
  updatedAt: string;
  /** `""` は null。status と整合するかの判断は呼び出し側（移行元の値を尊重する）。 */
  closedAt?: string | null;
}

/**
 * 旧 todos.db の 1 行を、id とタイムスタンプを保ったまま INSERT する（チケット 10 の移行専用）。
 *
 * createTask と分けているのは、この関数が持つ 3 つの権限——id を指定する /
 * created_at・updated_at を過去の値にする / closed_at を status から導出せず
 * そのまま置く——が、日常の書き込み経路にあってはならないものだから。
 * createTask のオプション引数として足すと、MCP ツールから「作成日時を偽装した
 * タスク」や「他人の id を狙った INSERT」が書ける形になる。別関数にして
 * 移行スクリプトからだけ呼べば、その経路は生えない。
 *
 * 移行スクリプトがこの関数を呼ぶ（自前で INSERT を書かない）のは、このファイルの
 * 冒頭に書いた不変条件——tasks への SQL は全部ここにあり、user_id を条件・値に
 * 持たない文が 1 つも無いことを grep で確認できる——を移行でも壊さないため。
 */
export async function importTask(db: TaskDb, input: ImportTaskInput): Promise<Task> {
  const rows = await db.all(
    `INSERT INTO tasks
       (id, user_id, workspace, project, title, status, due, memo, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING ${TASK_COLUMNS}`,
    [
      input.id,
      input.userId,
      input.workspace,
      nullIfEmpty(input.project) ?? null,
      input.title,
      input.status,
      nullIfEmpty(input.due) ?? null,
      nullIfEmpty(input.memo) ?? null,
      input.createdAt,
      input.updatedAt,
      nullIfEmpty(input.closedAt) ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("INSERT ... RETURNING が行を返さなかった");
  return taskFromRow(row);
}

export interface UpdateTaskInput extends UserScope {
  id: number;
  /** undefined = 触らない。null 可の列では null = 消す。 */
  title?: string;
  workspace?: Workspace;
  /** `""` は null（＝消す）として扱われる。理由は nullIfEmpty を参照。 */
  project?: string | null;
  status?: Status;
  due?: string | null;
  /** `""` は null（＝消す）として扱われる。理由は nullIfEmpty を参照。 */
  memo?: string | null;
  now?: string;
}

export interface UpdateTaskResult {
  task: Task;
  /** 実際に値が変わった列だけ。同じ値を渡し直した場合は空になる。 */
  changed: TaskField[];
}

/**
 * 部分更新。渡された列のうち、現在値と違うものだけを書く。
 *
 * 先に SELECT するのは変更差分（changed）を出すため。「何も変わらなかった」を
 * 応答で言い切れることが、AI が同じ更新を繰り返したときに人間が気付ける条件になる。
 * その代償として通信は 2 往復（SELECT → UPDATE ... RETURNING）。
 */
export async function updateTask(
  db: TaskDb,
  input: UpdateTaskInput,
): Promise<UpdateTaskResult | null> {
  const current = await getTask(db, { userId: input.userId, id: input.id });
  if (!current) return null;

  const timestamp = input.now ?? nowIso();
  const assignments: string[] = [];
  const values: unknown[] = [];
  const changed: TaskField[] = [];

  const setIfChanged = <F extends TaskField>(field: F, next: Task[F] | undefined): void => {
    if (next === undefined || next === current[field]) return;
    assignments.push(`${field} = ?`);
    values.push(next);
    changed.push(field);
  };

  setIfChanged("title", input.title);
  setIfChanged("workspace", input.workspace);
  // project / memo は `""` を null に寄せてから比較する。現在値が null の行に `""` を
  // 渡しても「変更なし」になり、無意味な UPDATE と嘘の changed が出ない。
  setIfChanged("project", nullIfEmpty(input.project));
  setIfChanged("due", input.due);
  setIfChanged("memo", nullIfEmpty(input.memo));

  // status だけは closed_at と連動する。open に戻したら closed_at を消すのは、
  // 「終わった時刻」が残ったままだと done/cancelled の再判定材料として嘘になるため。
  if (input.status !== undefined && input.status !== current.status) {
    assignments.push("status = ?", "closed_at = ?");
    values.push(input.status, isClosedStatus(input.status) ? timestamp : null);
    changed.push("status");
  }

  if (assignments.length === 0) return { task: current, changed: [] };

  assignments.push("updated_at = ?");
  values.push(timestamp);

  const rows = await db.all(
    `UPDATE tasks SET ${assignments.join(", ")}
      WHERE user_id = ? AND id = ?
      RETURNING ${TASK_COLUMNS}`,
    [...values, input.userId, input.id],
  );
  const row = rows[0];
  return row ? { task: taskFromRow(row), changed } : null;
}

/**
 * complete_task の結末。返す `task` の実際の status と必ず一致する。
 *
 * - `completed`: この呼び出しの UPDATE が行を done にした（`task.status === "done"`）
 * - `already_done`: 既に done だったので何も書いていない（`task.status === "done"`、closed_at は最初の完了時刻）
 * - `reopened`: UPDATE が 0 行で、読み直したら done ではなかった（`task.status !== "done"`）
 *
 * `reopened` は「UPDATE と読み直しの間（本番では Turso 1 往復）に、別マシンが
 * done → open に戻した」ときにだけ起きる。boolean 1 個（旧 `alreadyDone`）では
 * この結末を表現できず、status が todo の行に「既に done です」という応答が付いていた。
 */
export type CompleteTaskOutcome = "completed" | "already_done" | "reopened";

export interface CompleteTaskResult {
  task: Task;
  outcome: CompleteTaskOutcome;
}

/**
 * done 専用。冪等 —— 既に done なら何も書かずに現状を返す。
 *
 * 「既に done か」の判定を UPDATE の WHERE 句自体（`AND status != 'done'`）に
 * 持たせている。事前の SELECT で確認してから UPDATE する形（先に読む→後で書く）
 * だと、2 台から同時に complete したとき両方が「まだ done ではない」を読み、
 * 後勝ちの UPDATE が先勝ちの closed_at を上書きしたうえで両方が「今回 done に
 * した」と応答してしまう（07 が定めた冪等性が同時実行下で破れる）。
 * `AND status != 'done'` により、2 本目の UPDATE は対象行 0 件で終わる
 * （1 本目が先にコミットして status を 'done' に変えているため）。
 *
 * 「今回 done にしたのか」は SELECT の結果ではなく「UPDATE が行を返したかどうか」で決める。
 * UPDATE が 0 行だった場合だけ、「そもそも存在しない（他人の行を含む）」のか
 * 「既に done だった」のかを区別するために getTask で読み直す。
 *
 * その読み直しの status を必ず見ること。UPDATE と読み直しの間（本番では Turso 1 往復）
 * に別マシンが done → open に戻すと、0 行だった理由が「既に done」ではなくなる。
 * ここで status を確認せず `already_done` を返すと、status が todo・closed_at が null の
 * 行に「既に done です」という応答が付き、応答本文と返す行の中身が食い違う。
 * 戻り値の outcome は読み直した行の status からその場で導出しており、両者は乖離できない。
 *
 * `reopened` のとき UPDATE をやり直さないのは意図的。open に戻した更新のほうが
 * 新しい意思表示なので、自動で done に上書きすると、後から来た変更を古い呼び出しが
 * 静かに巻き戻すことになる。事実（done にならなかった）を返し、判断は呼び出し側に渡す。
 */
export async function completeTask(
  db: TaskDb,
  params: UserScope & { id: number; now?: string },
): Promise<CompleteTaskResult | null> {
  const timestamp = params.now ?? nowIso();
  const rows = await db.all(
    `UPDATE tasks SET status = 'done', closed_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND status != 'done'
      RETURNING ${TASK_COLUMNS}`,
    [timestamp, timestamp, params.userId, params.id],
  );
  const row = rows[0];
  if (row) return { task: taskFromRow(row), outcome: "completed" };

  const current = await getTask(db, { userId: params.userId, id: params.id });
  if (!current) return null;
  return { task: current, outcome: current.status === "done" ? "already_done" : "reopened" };
}

export interface SearchTasksParams extends UserScope {
  workspace: Workspace;
  /** title / memo の部分一致。 */
  query?: string;
  status?: Status;
  project?: string;
  /** true で done / cancelled も対象にする（status 指定時はそちらが優先）。 */
  includeClosed?: boolean;
  /** 返す最大件数。打ち切ったことは total との差で分かる。 */
  limit: number;
}

export interface SearchTasksResult {
  /** limit を無視した該当総数。 */
  total: number;
  tasks: Task[];
}

/** LIKE のワイルドカードを検索語として扱うためのエスケープ。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * 絞り込み検索。
 *
 * `COUNT(*) OVER ()` を使って「総件数」と「先頭 limit 件」を 1 往復で取る。
 * COUNT 用のクエリを別に投げると往復が 2 倍になり、その間に件数と中身が
 * ずれる余地も生まれる。ウィンドウ関数は LIMIT より前に評価されるので、
 * 打ち切っても total は全件数のまま。
 */
export async function searchTasks(
  db: TaskDb,
  params: SearchTasksParams,
): Promise<SearchTasksResult> {
  // 絞り込み条件だけを組み立てる。`WHERE user_id = ?` を配列に混ぜて join すると、
  // 条件の並べ替え 1 つでスコープが消えても SQL 文字列を見ただけでは分からない。
  // 固定部分をリテラルに残しておけば、この 1 行を grep するだけで全文の
  // user_id スコープを機械的に確認できる。
  const filters: string[] = [];
  const values: unknown[] = [params.userId, params.workspace];

  if (params.status) {
    filters.push("status = ?");
    values.push(params.status);
  } else if (!params.includeClosed) {
    filters.push(`status IN (${OPEN_STATUS_PLACEHOLDERS})`);
    values.push(...OPEN_STATUSES);
  }

  if (params.project) {
    filters.push("project = ?");
    values.push(params.project);
  }

  if (params.query) {
    // memo が NULL の行を COALESCE で拾う。`NULL LIKE ?` は NULL になり OR で
    // 偽扱いされるので title 側のヒットは失われないが、意図を明示しておく。
    filters.push("(title LIKE ? ESCAPE '\\' OR COALESCE(memo, '') LIKE ? ESCAPE '\\')");
    const pattern = `%${escapeLike(params.query)}%`;
    values.push(pattern, pattern);
  }

  const extraConditions = filters.map((filter) => ` AND ${filter}`).join("");
  const rows = await db.all(
    `SELECT ${TASK_COLUMNS}, COUNT(*) OVER () AS total_count FROM tasks
      WHERE user_id = ? AND workspace = ?${extraConditions}
      ${ORDER_BY}
      LIMIT ?`,
    [...values, params.limit],
  );

  const first = rows[0];
  return {
    total: first ? Number(first.total_count) : 0,
    tasks: rows.map(taskFromRow),
  };
}
