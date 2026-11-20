import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES } from "../src/generated.ts";
import {
  defaultNodeCredentialStore,
  dpapiCredentialStore,
  electronCredentialStore,
  fileCredentialStore,
  type NodeDeps,
  nodeDeps,
  nodeFingerprintSource,
  secretToolCredentialStore,
} from "../src/node.ts";

const RECORD = {
  version: 1 as const,
  refreshToken: "rt_node_test_00000000001",
  scope: "entitlement.read",
  savedAt: "2026-10-06T13:00:00Z",
};

/** 명령 · 파일을 기록하는 가짜 — 운영체제 명령이 없는 곳에서 명령 모양과 해석을 본다 */
function fakeDeps(
  platform: NodeJS.Platform,
  answers: Record<string, string | Error | (string | Error)[]>,
): NodeDeps & {
  calls: { command: string; args: readonly string[]; input?: string }[];
  files: Map<string, string>;
  slept: number[];
} {
  const calls: { command: string; args: readonly string[]; input?: string }[] = [];
  const files = new Map<string, string>();
  const slept: number[] = [];
  return {
    platform,
    calls,
    files,
    slept,
    exec: async (command, args, input) => {
      calls.push({ command, args, ...(input === undefined ? {} : { input }) });
      const key =
        answers[`${command} ${args[0] ?? ""}`] !== undefined
          ? `${command} ${args[0] ?? ""}`
          : command;
      let answer = answers[key];
      if (Array.isArray(answer)) {
        // 차례로 — 마지막 값을 되풀이
        const [head, ...rest] = answer;
        if (rest.length > 0) answers[key] = rest;
        answer = head;
      }
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    remove: async (path) => {
      files.delete(path);
    },
  };
}

describe("지문 출처 (명세 10절)", () => {
  it("운영체제별 식별자를 읽는다", async () => {
    const win = fakeDeps("win32", {
      reg: "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    3f1e9a2b-1111-2222-3333-444455556666\r\n",
    });
    expect(await nodeFingerprintSource({}, win).read()).toBe(
      "3f1e9a2b-1111-2222-3333-444455556666",
    );
    const mac = fakeDeps("darwin", {
      ioreg: '  |   "IOPlatformUUID" = "A1B2C3D4-0000-1111-2222-333344445555"\n',
    });
    expect(await nodeFingerprintSource({}, mac).read()).toBe(
      "A1B2C3D4-0000-1111-2222-333344445555",
    );
    const linux = fakeDeps("linux", {});
    linux.files.set("/etc/machine-id", "0f1e2d3c4b5a69788796a5b4c3d2e1f0\n");
    expect(await nodeFingerprintSource({}, linux).read()).toBe("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  });

  it("읽지 못하면 설치 ID를 만들어 두고 다음에도 같은 값", async () => {
    const linux = fakeDeps("linux", {});
    const source = nodeFingerprintSource({ installIdFile: "/app/install-id" }, linux);
    const first = await source.read();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await source.read()).toBe(first);
    expect(await nodeFingerprintSource({}, fakeDeps("linux", {})).read()).toBeNull();
  });

  // 1.2.0 — 2026-11-20 Windows에서 MachineGuid 읽기가 한 번 실패해 설치 ID로 등록됐다(같은 PC가 다른 기기)
  it("한 번 실패해도 설치 ID로 물러나기 전에 다시 읽는다", async () => {
    const guid = "    MachineGuid    REG_SZ    3f1e9a2b-1111-2222-3333-444455556666\r\n";
    const win = fakeDeps("win32", { reg: [new Error("잠시 실패"), "", guid] });
    const source = nodeFingerprintSource({ installIdFile: "/app/install-id" }, win);
    expect(await source.read()).toBe("3f1e9a2b-1111-2222-3333-444455556666");
    expect(win.files.has("/app/install-id")).toBe(false);
    expect(win.calls).toHaveLength(3);
    expect(win.slept).toEqual([
      RULES.fingerprint.sourceReadRetryDelayMs,
      RULES.fingerprint.sourceReadRetryDelayMs,
    ]);
    const all = fakeDeps("win32", { reg: new Error("계속 실패") });
    const fallback = await nodeFingerprintSource({ installIdFile: "/app/install-id" }, all).read();
    expect(fallback).toMatch(/^[0-9a-f-]{36}$/);
    expect(all.calls).toHaveLength(RULES.fingerprint.sourceReadAttempts);
  });

  it("이 기기(macOS)의 실제 IOPlatformUUID", async () => {
    if (process.platform !== "darwin") return;
    expect(await nodeFingerprintSource().read()).toMatch(/^[0-9A-F-]{36}$/);
  });
});

describe("저장소", () => {
  it("파일 저장소 — 사용자 전용 권한(0600) · 쓰고 읽고 지운다", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bydev-sdk-"));
    const path = join(dir, "nested", "credentials");
    const store = fileCredentialStore(path, undefined, nodeDeps);
    expect(await store.load()).toBeNull();
    await store.save(RECORD);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(RECORD);
    expect(await store.load()).toEqual(RECORD);
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it("secret-tool — 비밀은 표준 입력으로만, 항목이 없으면(오류 출력 없이 종료 1) 없음", async () => {
    const missing = Object.assign(new Error("no item"), { code: 1, stderr: "" });
    const deps = fakeDeps("linux", { "secret-tool lookup": missing });
    const store = secretToolCredentialStore("cli_test", deps);
    expect(await store.load()).toBeNull();
    await store.save(RECORD);
    const save = deps.calls.find((c) => c.args[0] === "store");
    expect(save?.input).toBe(JSON.stringify(RECORD));
    expect(save?.args.join(" ")).not.toContain(RECORD.refreshToken);
  });

  it("secret-tool — 없는 항목 지우기는 성공, 오류 출력이 있으면(D-Bus 없음 등) STORAGE_FAILED", async () => {
    const missing = Object.assign(new Error("no item"), { code: 1, stderr: "" });
    const broken = Object.assign(new Error("dbus"), {
      code: 1,
      stderr: "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n",
    });
    await secretToolCredentialStore(
      "cli_test",
      fakeDeps("linux", { "secret-tool clear": missing }),
    ).clear();
    const down = secretToolCredentialStore(
      "cli_test",
      fakeDeps("linux", { "secret-tool clear": broken, "secret-tool lookup": broken }),
    );
    await expect(down.clear()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
    await expect(down.load()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("DPAPI — PowerShell에 표준 입력으로 넘기고 봉한 값만 파일에", async () => {
    const deps = fakeDeps("win32", { "powershell.exe -NoProfile": "U0VBTEVE\r\n" });
    const store = dpapiCredentialStore("C:/app/cred", deps);
    await store.save(RECORD);
    expect(deps.files.get("C:/app/cred")).toBe("U0VBTEVE");
    expect(deps.calls[0]?.input).toBe(JSON.stringify(RECORD));
    expect(deps.calls[0]?.args.join(" ")).not.toContain(RECORD.refreshToken);
  });

  it("Electron safeStorage — 쓸 수 없으면 STORAGE_FAILED", async () => {
    const deps = fakeDeps("darwin", {});
    const safe = {
      available: true,
      isEncryptionAvailable() {
        return this.available;
      },
      encryptString: (plain: string) => Buffer.from(`sealed:${plain}`),
      decryptString: (sealed: Buffer) => sealed.toString().replace(/^sealed:/, ""),
    };
    const store = electronCredentialStore(safe, "/app/cred", deps);
    await store.save(RECORD);
    expect(deps.files.get("/app/cred")).not.toContain(RECORD.refreshToken);
    expect(await store.load()).toEqual(RECORD);
    safe.available = false;
    await expect(store.load()).rejects.toMatchObject({ code: "STORAGE_FAILED" });
  });

  it("기본 저장소 고르기 — Linux에 secret-tool이 없으면(ENOENT) 파일", async () => {
    const noTool = fakeDeps("linux", {
      "secret-tool lookup": Object.assign(new Error("spawn"), { code: "ENOENT" }),
    });
    const store = await defaultNodeCredentialStore({ appName: "App", account: "cli_x" }, noTool);
    await store.save(RECORD);
    expect([...noTool.files.keys()][0]).toMatch(/App\/bydev-credentials$/);
  });
});
