import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import type { CredentialRecord, CredentialStore, FingerprintSource, Logger } from "./ports.ts";

/**
 * Node · Electron(메인 프로세스) 포트 — 명세 2절 표의 운영체제별 기본 구현. 명령 실행 · 파일은 주입할 수 있다(단위 시험). 원본 지문 · 토큰을
 * 명령 줄 인자로 넘기지 않는다 — 비밀은 표준 입력으로만(다른 프로세스의 `ps`에 보이지 않게)
 */

export interface NodeDeps {
  readonly platform: NodeJS.Platform;
  exec(command: string, args: readonly string[], input?: string): Promise<string>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export const nodeDeps: NodeDeps = {
  platform: process.platform,
  exec: (command, args, input) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        command,
        [...args],
        { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 20 },
        (error, stdout, stderr) => {
          // 오류 출력을 실어 보낸다 — secret-tool은 "항목 없음"과 오류를 같은 종료 코드(1)로 내고 오류 출력으로만 가른다
          if (error) reject(Object.assign(error, { stderr }));
          else resolve(stdout);
        },
      );
      if (input !== undefined) child.stdin?.end(input);
    }),
  readFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  /** 사용자만 읽는 권한(0600) · 임시 파일 뒤 이름 바꾸기(반쯤 쓴 파일이 남지 않게) */
  writeFile: async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, path);
  },
  remove: async (path) => {
    await rm(path, { force: true });
  },
};

/** 운영체제 · 앱 이름별 데이터 폴더 */
export function appDataDir(appName: string, deps: Pick<NodeDeps, "platform"> = nodeDeps): string {
  if (deps.platform === "win32")
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), appName);
  if (deps.platform === "darwin") return join(homedir(), "Library", "Application Support", appName);
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), appName);
}

/** 기기 정보 — `device` 설정의 기본값 */
export function nodeDeviceInfo(deps: Pick<NodeDeps, "platform"> = nodeDeps): {
  name: string;
  platform: string;
} {
  const platform =
    deps.platform === "win32"
      ? "WINDOWS"
      : deps.platform === "darwin"
        ? "MACOS"
        : deps.platform === "linux"
          ? "LINUX"
          : "OTHER";
  return { name: hostname().slice(0, 64) || "PC", platform };
}

/** 명세 10절 · 2절 표 — Windows `MachineGuid` · macOS `IOPlatformUUID` · Linux `/etc/machine-id`, 읽지 못하면 앱 데이터 폴더의 설치 ID */
export function nodeFingerprintSource(
  options: { readonly installIdFile?: string } = {},
  deps: NodeDeps = nodeDeps,
): FingerprintSource {
  return {
    async read() {
      try {
        const value = await readMachineId(deps);
        if (value !== null && value.trim() !== "") return value.trim();
      } catch {
        // 아래 설치 ID로
      }
      if (options.installIdFile === undefined) return null;
      const existing = (await deps.readFile(options.installIdFile))?.trim();
      if (existing !== undefined && existing !== "") return existing;
      const created = randomUUID();
      await deps.writeFile(options.installIdFile, created);
      return created;
    },
  };
}

async function readMachineId(deps: NodeDeps): Promise<string | null> {
  if (deps.platform === "win32") {
    const out = await deps.exec("reg", [
      "query",
      "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
      "/v",
      "MachineGuid",
    ]);
    return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? null;
  }
  if (deps.platform === "darwin") {
    const out = await deps.exec("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
  }
  return (
    (await deps.readFile("/etc/machine-id")) ?? (await deps.readFile("/var/lib/dbus/machine-id"))
  );
}

function parseRecord(text: string | null): CredentialRecord | null {
  if (text === null || text.trim() === "") return null;
  const value = JSON.parse(text) as CredentialRecord;
  return value.version === RULES.storage.recordVersion && typeof value.refreshToken === "string"
    ? value
    : null;
}

function wrap<T>(what: string, run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    throw sdkError("STORAGE_FAILED", `보안 저장소 ${what} 실패`, { cause: error });
  });
}

/**
 * 사용자 전용 권한(0600) 파일 — **암호화하지 않는다.** 같은 사용자로 도는 프로그램은 읽을 수 있다. 운영체제 보안 저장소를 쓸 수 없을 때만(명세 2절 —
 * 경고 로그)
 */
export function fileCredentialStore(
  path: string,
  logger?: Logger,
  deps: NodeDeps = nodeDeps,
): CredentialStore {
  logger?.warn(
    "로그인 기록을 암호화하지 않은 사용자 전용 파일에 둔다 — 운영체제 보안 저장소를 쓸 수 없는 환경",
  );
  return {
    load: () => wrap("읽기", async () => parseRecord(await deps.readFile(path))),
    save: (record) => wrap("쓰기", () => deps.writeFile(path, JSON.stringify(record))),
    clear: () => wrap("지우기", () => deps.remove(path)),
  };
}

/**
 * secret-tool이 항목을 찾지 못했다 — 오류 출력 없이 1로 끝난다. 오류(D-Bus 없음 · 잠긴 모음 · 없는 모음)도 1이지만 `secret-tool: …`를 쓴다
 * (2026-10-17 Debian 12 libsecret 0.20에서 확인 — ADR-0040 Linux 실제 확인 기록)
 */
function secretToolFoundNothing(error: unknown): boolean {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  return code === 1 && (typeof stderr !== "string" || stderr.trim() === "");
}

/** Linux Secret Service(libsecret `secret-tool`) — 비밀은 표준 입력으로 넘긴다. 없는 항목을 지우는 것은 성공이다(로그아웃은 몇 번 해도 된다) */
export function secretToolCredentialStore(
  account: string,
  deps: NodeDeps = nodeDeps,
): CredentialStore {
  const attributes = ["service", RULES.storage.service, "account", account];
  return {
    load: () =>
      wrap("읽기", async () => {
        try {
          return parseRecord(await deps.exec("secret-tool", ["lookup", ...attributes]));
        } catch (error) {
          if (secretToolFoundNothing(error)) return null;
          throw error;
        }
      }),
    save: (record) =>
      wrap("쓰기", async () => {
        await deps.exec(
          "secret-tool",
          ["store", `--label=bydev ${account}`, ...attributes],
          JSON.stringify(record),
        );
      }),
    clear: () =>
      wrap("지우기", async () => {
        try {
          await deps.exec("secret-tool", ["clear", ...attributes]);
        } catch (error) {
          if (!secretToolFoundNothing(error)) throw error;
        }
      }),
  };
}

const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))";
const DPAPI_UNPROTECT =
  "Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))";

/** Windows DPAPI(사용자 범위)로 암호화한 파일 — PowerShell에 표준 입력으로 넘긴다. 다른 Windows 사용자는 풀 수 없다 */
export function dpapiCredentialStore(path: string, deps: NodeDeps = nodeDeps): CredentialStore {
  const ps = (script: string, input: string) =>
    deps.exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], input);
  return {
    load: () =>
      wrap("읽기", async () => {
        const sealed = await deps.readFile(path);
        if (sealed === null || sealed.trim() === "") return null;
        return parseRecord(await ps(DPAPI_UNPROTECT, sealed));
      }),
    save: (record) =>
      wrap("쓰기", async () => {
        await deps.writeFile(path, (await ps(DPAPI_PROTECT, JSON.stringify(record))).trim());
      }),
    clear: () => wrap("지우기", () => deps.remove(path)),
  };
}

/** Electron `safeStorage`(키체인 · DPAPI · libsecret)로 암호화한 파일 — Electron 데스크톱 앱의 권장 저장소. 메인 프로세스에서만 */
export function electronCredentialStore(
  safeStorage: {
    isEncryptionAvailable(): boolean;
    encryptString(plain: string): Buffer;
    decryptString(sealed: Buffer): string;
  },
  path: string,
  deps: NodeDeps = nodeDeps,
): CredentialStore {
  const ready = () => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("safeStorage를 쓸 수 없다");
  };
  return {
    load: () =>
      wrap("읽기", async () => {
        ready();
        const sealed = await deps.readFile(path);
        if (sealed === null || sealed.trim() === "") return null;
        return parseRecord(safeStorage.decryptString(Buffer.from(sealed.trim(), "base64")));
      }),
    save: (record) =>
      wrap("쓰기", async () => {
        ready();
        await deps.writeFile(
          path,
          safeStorage.encryptString(JSON.stringify(record)).toString("base64"),
        );
      }),
    clear: () => wrap("지우기", () => deps.remove(path)),
  };
}

/**
 * 운영체제에 맞는 기본 저장소 — Windows DPAPI 파일 · Linux Secret Service(없으면 0600 파일 + 경고) · macOS는 네이티브 모듈 없이 키체인을 안전하게
 * 쓸 길이 없어 0600 파일 + 경고(Electron 앱은 `electronCredentialStore`를 쓴다)
 */
export async function defaultNodeCredentialStore(
  options: { readonly appName: string; readonly account: string; readonly logger?: Logger },
  deps: NodeDeps = nodeDeps,
): Promise<CredentialStore> {
  const file = join(appDataDir(options.appName, deps), "bydev-credentials");
  if (deps.platform === "win32") return dpapiCredentialStore(file, deps);
  if (deps.platform === "linux") {
    try {
      await deps.exec("secret-tool", [
        "lookup",
        "service",
        RULES.storage.service,
        "account",
        options.account,
      ]);
    } catch (error) {
      // 설치되지 않았을 때만 파일로 — 항목이 없으면(종료 코드 1) 도구는 있다
      if ((error as { code?: unknown }).code === "ENOENT")
        return fileCredentialStore(file, options.logger, deps);
    }
    return secretToolCredentialStore(options.account, deps);
  }
  return fileCredentialStore(file, options.logger, deps);
}
