import { describe, expect, it } from "vitest";
import {
  type ChromeStorageArea,
  chromeInstallIdFingerprint,
  chromeStorageCredentialStore,
} from "../src/extension.ts";

function area(): ChromeStorageArea & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? { [key]: data.get(key) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    remove: async (key) => {
      data.delete(key);
    },
  };
}

describe("확장 포트", () => {
  it("chrome.storage.local 저장소 — 쓰고 읽고 지운다", async () => {
    const a = area();
    const store = chromeStorageCredentialStore({ area: a });
    expect(await store.load()).toBeNull();
    const record = {
      version: 1 as const,
      refreshToken: "rt_ext_000000000000000001",
      scope: "entitlement.read",
      savedAt: "2026-10-06T13:00:00Z",
    };
    await store.save(record);
    expect(await store.load()).toEqual(record);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("chrome.storage가 없으면 STORAGE_FAILED(원인 CONFIGURATION)", async () => {
    await expect(chromeStorageCredentialStore().load()).rejects.toMatchObject({
      code: "STORAGE_FAILED",
    });
  });

  it("설치 ID는 처음 한 번 만들고 같은 값을 준다", async () => {
    const a = area();
    const source = chromeInstallIdFingerprint({ area: a });
    const first = await source.read();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await source.read()).toBe(first);
  });
});
