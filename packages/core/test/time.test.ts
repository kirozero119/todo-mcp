import { describe, expect, it } from "vitest";

import { isCalendarDate, jstDateOffset, nowIso, todayInJst, weekdayIndex } from "../src/time";

describe("nowIso", () => {
  it("秒精度の ISO 8601 UTC を返す（ミリ秒を落とす）", () => {
    expect(nowIso(new Date("2026-08-08T05:14:22.987Z"))).toBe("2026-08-08T05:14:22Z");
  });
});

describe("todayInJst", () => {
  // UTC で日付を切ると、日本時間の朝は「昨日」になってしまう。
  it("UTC ではまだ前日でも JST の日付を返す", () => {
    expect(todayInJst(new Date("2026-08-07T23:30:00Z"))).toBe("2026-08-08");
  });

  it("JST の日付が変わる直前は当日のまま", () => {
    expect(todayInJst(new Date("2026-08-07T14:59:59Z"))).toBe("2026-08-07");
  });
});

describe("jstDateOffset", () => {
  it("月をまたぐ加算・減算ができる", () => {
    const base = new Date("2026-08-08T05:00:00Z");
    expect(jstDateOffset(7, base)).toBe("2026-08-15");
    expect(jstDateOffset(-9, base)).toBe("2026-07-30");
  });
});

describe("isCalendarDate", () => {
  it("実在する日付だけを受理する", () => {
    expect(isCalendarDate("2026-08-09")).toBe(true);
    // 形式は合っているが存在しない日
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("8/9")).toBe(false);
    expect(isCalendarDate("明日")).toBe(false);
  });
});

describe("weekdayIndex", () => {
  it("日曜を 0 として曜日を返す", () => {
    expect(weekdayIndex("2026-08-08")).toBe(6);
    expect(weekdayIndex("2026-08-09")).toBe(0);
  });
});
