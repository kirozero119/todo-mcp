import { describe, expect, it } from "vitest";

import {
  githubGrantUserId,
  githubUserId,
  isGitHubUserAllowed,
  parseAllowedGitHubUsers,
  resolveGrantedScopes,
} from "../src/allowlist";

describe("parseAllowedGitHubUsers", () => {
  it("splits, trims, and lowercases", () => {
    expect(parseAllowedGitHubUsers(" Octocat , HUBOT ")).toEqual(["octocat", "hubot"]);
  });

  it("drops empty entries left by stray commas", () => {
    expect(parseAllowedGitHubUsers("octocat,,  ,hubot,")).toEqual(["octocat", "hubot"]);
  });

  it("returns an empty list for unset or blank values", () => {
    expect(parseAllowedGitHubUsers(undefined)).toEqual([]);
    expect(parseAllowedGitHubUsers(null)).toEqual([]);
    expect(parseAllowedGitHubUsers("")).toEqual([]);
    expect(parseAllowedGitHubUsers("   ")).toEqual([]);
    expect(parseAllowedGitHubUsers(",")).toEqual([]);
  });
});

describe("isGitHubUserAllowed", () => {
  const allowlist = "octocat, hubot";

  it("allows a listed user", () => {
    expect(isGitHubUserAllowed("octocat", 1, allowlist)).toBe(true);
    expect(isGitHubUserAllowed("hubot", 2, allowlist)).toBe(true);
  });

  it("compares case-insensitively, as GitHub logins are", () => {
    expect(isGitHubUserAllowed("OctoCat", 1, allowlist)).toBe(true);
    expect(isGitHubUserAllowed(" octocat ", 1, allowlist)).toBe(true);
  });

  it("denies an unlisted user", () => {
    expect(isGitHubUserAllowed("mallory", 99, allowlist)).toBe(false);
  });

  it("does not treat a substring or prefix as a match", () => {
    expect(isGitHubUserAllowed("octo", 1, allowlist)).toBe(false);
    expect(isGitHubUserAllowed("octocat2", 1, allowlist)).toBe(false);
  });

  // The security-relevant case: a deploy that forgets the secret must lock
  // everybody out rather than admit every GitHub account.
  it("fails closed when the allowlist is missing or blank", () => {
    expect(isGitHubUserAllowed("octocat", 1, undefined)).toBe(false);
    expect(isGitHubUserAllowed("octocat", 1, null)).toBe(false);
    expect(isGitHubUserAllowed("octocat", 1, "")).toBe(false);
    expect(isGitHubUserAllowed("octocat", 1, "   ")).toBe(false);
    expect(isGitHubUserAllowed("octocat", 1, ",,")).toBe(false);
  });

  it("denies a missing login", () => {
    expect(isGitHubUserAllowed(undefined, 1, allowlist)).toBe(false);
    expect(isGitHubUserAllowed("", 1, allowlist)).toBe(false);
  });
});

// [M-3/P2-1] `github:<numeric id>` entries let the allowlist survive a login
// rename: GitHub frees a renamed login for anyone else to register.
describe("isGitHubUserAllowed: github:<numeric id> entries", () => {
  it("matches by numeric id regardless of the current login", () => {
    const allowlist = "github:583231";
    expect(isGitHubUserAllowed("octocat", 583231, allowlist)).toBe(true);
    // Renamed login, same immutable id: still allowed.
    expect(isGitHubUserAllowed("renamed-octocat", 583231, allowlist)).toBe(true);
  });

  it("denies a numeric id that does not match", () => {
    const allowlist = "github:583231";
    expect(isGitHubUserAllowed("octocat", 1, allowlist)).toBe(false);
  });

  it("does not let a login string match a github:<id> entry as literal text", () => {
    const allowlist = "github:583231";
    expect(isGitHubUserAllowed("github:583231", 1, allowlist)).toBe(false);
  });

  it("mixes login and id entries in the same allowlist", () => {
    const allowlist = "octocat, github:583231";
    expect(isGitHubUserAllowed("octocat", 1, allowlist)).toBe(true);
    expect(isGitHubUserAllowed("someone-else", 583231, allowlist)).toBe(true);
    expect(isGitHubUserAllowed("someone-else", 999, allowlist)).toBe(false);
  });

  it("never matches a github:<id> entry when numericId is missing", () => {
    expect(isGitHubUserAllowed("octocat", undefined, "github:583231")).toBe(false);
    expect(isGitHubUserAllowed("octocat", null, "github:583231")).toBe(false);
  });
});

describe("identity naming", () => {
  it("namespaces props identity with the numeric id", () => {
    expect(githubUserId(583231)).toBe("github:583231");
  });

  // workers-oauth-provider mints tokens as `${userId}:${grantId}:${secret}` and
  // validates by splitting on ':' expecting 3 parts. A colon here would make
  // every issued token unverifiable.
  it("keeps the grant userId free of colons", () => {
    const grantUserId = githubGrantUserId(583231);
    expect(grantUserId).toBe("github-583231");
    expect(grantUserId).not.toContain(":");
    expect(`${grantUserId}:grant123:secret456`.split(":")).toHaveLength(3);
  });

  it("rejects ids that are not positive integers", () => {
    expect(() => githubUserId(0)).toThrow();
    expect(() => githubUserId(-1)).toThrow();
    expect(() => githubUserId(1.5)).toThrow();
    expect(() => githubGrantUserId(Number.NaN)).toThrow();
  });
});

describe("resolveGrantedScopes", () => {
  const supported = ["todo"];

  it("grants everything supported when the client asks for nothing", () => {
    expect(resolveGrantedScopes([], supported)).toEqual(["todo"]);
    expect(resolveGrantedScopes(undefined, supported)).toEqual(["todo"]);
  });

  it("intersects with the supported set so a client cannot widen its grant", () => {
    expect(resolveGrantedScopes(["todo"], supported)).toEqual(["todo"]);
    expect(resolveGrantedScopes(["todo", "admin"], supported)).toEqual(["todo"]);
    expect(resolveGrantedScopes(["admin"], supported)).toEqual([]);
  });

  it("never returns offline_access, which this resource does not advertise", () => {
    expect(resolveGrantedScopes(["todo", "offline_access"], supported)).toEqual(["todo"]);
  });
});
