import { describe, expect, it } from "vitest";
import { BydevError } from "../src/errors.ts";

describe("일시적 실패 분류 (명세 3.4)", () => {
  it("RATE_LIMITED · INTERNAL_ERROR · NETWORK_ERROR만 일시적", () => {
    expect(new BydevError("RATE_LIMITED", "", { httpStatus: 429 }).transient).toBe(true);
    expect(new BydevError("INTERNAL_ERROR", "", { httpStatus: 503 }).transient).toBe(true);
    expect(new BydevError("NETWORK_ERROR", "").transient).toBe(true);
  });

  it("429인 한도 초과 코드는 끝난 실패다", () => {
    expect(new BydevError("TAKEOVER_LIMIT_EXCEEDED", "", { httpStatus: 429 }).transient).toBe(
      false,
    );
    expect(new BydevError("DEVICE_RELEASE_LIMIT_EXCEEDED", "", { httpStatus: 429 }).transient).toBe(
      false,
    );
  });

  it("모르는 코드만 HTTP 상태로 — 429 · 5xx는 일시적, 그 밖은 끝난 실패", () => {
    expect(new BydevError("FUTURE_THROTTLE", "", { httpStatus: 429 }).transient).toBe(true);
    expect(new BydevError("FUTURE_OUTAGE", "", { httpStatus: 502 }).transient).toBe(true);
    expect(new BydevError("FUTURE_FORBIDDEN", "", { httpStatus: 403 }).transient).toBe(false);
  });
});
