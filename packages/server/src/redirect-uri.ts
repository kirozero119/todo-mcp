/**
 * 登録時・認可時共通の redirect_uri ポリシー。
 *
 * DCR 登録（`index.ts` の `clientRegistrationCallback`）と GET /authorize
 * （`github-handler.ts`）の両方から呼ぶことで、DCR と CIMD 双方の経路に
 * 同じポリシーを適用する。経緯は docs/design-notes.md 参照。
 */
import { isLoopbackRedirectUri } from "./approval";

/**
 * [M-4] 許可するのは https、またはループバックに限定した http のみ。
 * provider 自身の DCR は危険なスキームを少数ブロックするだけなので、
 * ここで MCP クライアントが実際に必要とする範囲まで絞り込む。
 * 詳細は docs/design-notes.md 参照。
 */
export function isAllowedRegistrationRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && isLoopbackRedirectUri(uri);
}
