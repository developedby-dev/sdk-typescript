import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RULES, SDK_VERSION, USER_AGENT } from "../src/index.ts";

describe("판", () => {
  it("SDK_VERSION은 package.json과 같고 User-Agent는 명세 형식이다", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(pkg.version);
    expect(USER_AGENT).toMatch(new RegExp(RULES.userAgent.pattern));
  });
});
