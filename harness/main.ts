import { createInterface } from "node:readline";
import {
  BydevError,
  type CredentialRecord,
  type CredentialStore,
  type HttpRequest,
  type HttpResponse,
  LicenseClient,
  type LoginAttempt,
  type Scheduler,
  SDK_VERSION,
  SPEC_VERSION,
} from "../src/index.ts";

/**
 * 적합성 하네스 (sdks/spec/harness-protocol.md) — 표준 입출력 JSON 줄로 실행기와 이야기하며 SDK를 가상 시계 · 가상 스케줄러 · 대리 전송으로 몬다
 */

type Json = unknown;

let activity = 0;
function emit(message: Record<string, Json>): void {
  activity += 1;
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function fatal(message: string): never {
  emit({ type: "fatal", message });
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  fatal(`처리되지 않은 거부: ${reason instanceof Error ? reason.stack : String(reason)}`);
});

// ── 가상 시계 · 스케줄러 ─────────────────────────────────────────
let now = 0;
interface Timer {
  readonly due: number;
  readonly seq: number;
  readonly task: () => Promise<void>;
  cancelled: boolean;
}
let timers: Timer[] = [];
let timerSeq = 0;

const scheduler: Scheduler = {
  schedule(delayMs, task) {
    const timer: Timer = {
      due: now + Math.max(0, Math.round(delayMs)),
      seq: timerSeq++,
      task,
      cancelled: false,
    };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  },
};

function nextTimer(limit: number): Timer | null {
  timers = timers.filter((t) => !t.cancelled);
  let best: Timer | null = null;
  for (const t of timers) {
    if (t.due > limit) continue;
    if (best === null || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
  }
  return best;
}

// ── 대리 전송 ─────────────────────────────────────────────────
let httpCounter = 0;
const pending = new Map<
  string,
  { resolve: (r: HttpResponse) => void; reject: (e: Error) => void }
>();
let replied: (() => void) | null = null;

function transportSend(request: HttpRequest): Promise<HttpResponse> {
  httpCounter += 1;
  const id = `h${httpCounter}`;
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  emit({
    type: "http.request",
    id,
    now,
    request: { method: request.method, url: request.url, headers, body: request.body },
  });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function onHttpResponse(message: { id: string; response?: HttpResponse; error?: string }): void {
  const entry = pending.get(message.id);
  if (entry === undefined) fatal(`모르는 http.response id ${message.id}`);
  pending.delete(message.id);
  if (message.error !== undefined) entry.reject(new Error(`대리 전송 실패: ${message.error}`));
  else if (message.response !== undefined) entry.resolve(message.response);
  else fatal("http.response에 response도 error도 없다");
  replied?.();
}

function waitForReply(): Promise<void> {
  return new Promise((resolve) => {
    replied = () => {
      replied = null;
      resolve();
    };
  });
}

// ── 저장소 ───────────────────────────────────────────────────
let record: CredentialRecord | null = null;
const failures = { load: false, save: false, clear: false };
/** set fingerprint.fail — 지문 출처를 읽지 못한다(하네스 규약 2절) */
let fingerprintFails = false;
const store: CredentialStore = {
  async load() {
    if (failures.load) throw new Error("저장소 읽기 실패(시험)");
    return record;
  },
  async save(next) {
    if (failures.save) throw new Error("저장소 쓰기 실패(시험)");
    record = next;
    emit({ type: "event", now, event: { kind: "storage", op: "save", record: next } });
  },
  async clear() {
    if (failures.clear) throw new Error("저장소 지우기 실패(시험)");
    record = null;
    emit({ type: "event", now, event: { kind: "storage", op: "clear" } });
  },
};

// ── WebCrypto — 스레드 풀에서 끝나므로 마이크로태스크로는 끝을 알 수 없다. 진행 중인 수를 센다 ──
let inflightCrypto = 0;
let cryptoSettled: (() => void) | null = null;
{
  const subtle = globalThis.crypto.subtle as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  for (const name of ["digest", "verify", "sign", "importKey"]) {
    const original = (subtle[name] as (...args: unknown[]) => Promise<unknown>).bind(
      globalThis.crypto.subtle,
    );
    Object.defineProperty(subtle, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        inflightCrypto += 1;
        return original(...args).finally(() => {
          inflightCrypto -= 1;
          activity += 1;
          cryptoSettled?.();
        });
      },
    });
  }
}

function waitForCrypto(): Promise<void> {
  return new Promise((resolve) => {
    cryptoSettled = () => {
      cryptoSettled = null;
      resolve();
    };
  });
}

// ── 정착 — 할 일이 없어질 때까지 ────────────────────────────────
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(): Promise<void> {
  for (;;) {
    const before = activity;
    await tick();
    await tick();
    if (inflightCrypto > 0) {
      await waitForCrypto();
      continue;
    }
    if (pending.size > 0) {
      await waitForReply();
      continue;
    }
    if (activity !== before) continue;
    const due = nextTimer(now);
    if (due === null) return;
    due.cancelled = true;
    // 끝까지 기다리지 않는다 — 작업이 sleep으로 미래 시각을 기다리면 그 시각은 advance가 와야 온다(기다리면 멈춘다).
    // 다음 바퀴의 정착이 돌 수 있는 일을 다 돌린다
    due.task().catch((error: unknown) => {
      process.stderr.write(
        `예약 작업이 던졌다: ${error instanceof Error ? error.stack : String(error)}\n`,
      );
    });
  }
}

async function advance(ms: number): Promise<void> {
  const target = now + ms;
  for (;;) {
    await settle();
    const t = nextTimer(target);
    if (t === null) break;
    now = t.due;
  }
  now = target;
  await settle();
}

// ── 호출 ─────────────────────────────────────────────────────
let client: LicenseClient | null = null;
let login: LoginAttempt | null = null;

function sdk(): LicenseClient {
  if (client === null) fatal("init 전에 호출했다");
  return client;
}

function str(args: Record<string, Json>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") fatal(`인자 ${key}가 문자열이 아니다`);
  return value;
}

async function invoke(method: string, args: Record<string, Json>): Promise<Json> {
  switch (method) {
    case "login.start": {
      login = await sdk().startLogin();
      return {
        userCode: login.userCode,
        verificationUri: login.verificationUri,
        verificationUriComplete: login.verificationUriComplete,
        expiresAt: login.expiresAt,
      };
    }
    case "login.wait":
      if (login === null) fatal("login.start 전에 login.wait");
      return await login.wait();
    case "login.cancel":
      login?.cancel();
      return null;
    case "hasCredentials":
      return await sdk().hasCredentials();
    case "entitlement":
      return await sdk().entitlement();
    case "devices":
      return await sdk().devices({
        ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
      });
    case "releaseDevice":
      return await sdk().releaseDevice(str(args, "deviceId"));
    case "profile":
      return await sdk().profile();
    case "checkForUpdate":
      return await sdk().checkForUpdate({
        target: str(args, "target"),
        currentVersion: str(args, "currentVersion"),
      });
    case "verifyDownload": {
      const bytes = Uint8Array.from(Buffer.from(str(args, "dataBase64"), "base64"));
      await sdk().verifyDownload(bytes, str(args, "sha256"));
      return null;
    }
    case "verifyToken":
      return await sdk().verifyToken(str(args, "token"));
    case "logout":
      return await sdk().logout();
    case "session.start":
      sdk().session().start();
      return null;
    case "session.takeOver":
      sdk().session().takeOver();
      return null;
    case "session.retry":
      sdk().session().retry();
      return null;
    case "session.stop":
      await sdk().session().stop();
      return null;
    case "session.state":
      return sdk().session().state;
    default:
      fatal(`모르는 호출 ${method}`);
  }
}

function errorJson(error: unknown): Json {
  if (error instanceof BydevError) return error.toJSON();
  return { code: "HARNESS_ERROR", message: error instanceof Error ? error.message : String(error) };
}

function startCall(id: string, method: string, args: Record<string, Json>): void {
  invoke(method, args).then(
    (value) =>
      emit({ type: "result", id, now, ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
    (error: unknown) => emit({ type: "result", id, now, ok: false, error: errorJson(error) }),
  );
}

// ── 명령 처리 ─────────────────────────────────────────────────
interface InitMessage {
  config: {
    baseUrl: string;
    clientId: string;
    productId: string;
    scopes: string[];
    device: { name: string; platform: string; fingerprintSource: string | null };
    app?: { target: string; version: string };
  };
  now: string;
  random: number[];
  storage: CredentialRecord | null;
}

const randoms: number[] = [];
let uuidCounter = 0;

function init(message: InitMessage): void {
  now = Date.parse(message.now);
  randoms.push(...message.random);
  record = message.storage;
  const device = message.config.device;
  client = new LicenseClient({
    baseUrl: message.config.baseUrl,
    clientId: message.config.clientId,
    productId: message.config.productId,
    scopes: message.config.scopes,
    device: { name: device.name, platform: device.platform },
    ...(message.config.app === undefined ? {} : { app: message.config.app }),
    ports: {
      transport: { send: transportSend },
      store,
      clock: { now: () => now },
      scheduler,
      random: {
        float: () => {
          const value = randoms.shift();
          if (value === undefined) fatal("시나리오의 random 값을 다 썼다 — random에 더 적는다");
          return value;
        },
        uuid: () => {
          uuidCounter += 1;
          return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
        },
      },
      fingerprint: { read: async () => (fingerprintFails ? null : device.fingerprintSource) },
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => process.stderr.write(`warn: ${m}\n`),
      },
    },
  });
  client.session().subscribe((state) => {
    emit({
      type: "event",
      now,
      event: { kind: "session.state", state: JSON.parse(JSON.stringify(state)) },
    });
  });
}

const queue: Record<string, Json>[] = [];
let wake: (() => void) | null = null;

createInterface({ input: process.stdin }).on("line", (line) => {
  let message: Record<string, Json>;
  try {
    message = JSON.parse(line) as Record<string, Json>;
  } catch {
    fatal(`JSON이 아닌 입력: ${line}`);
  }
  if (message.type === "http.response") {
    onHttpResponse(message as never);
    return;
  }
  queue.push(message);
  wake?.();
});

async function main(): Promise<void> {
  emit({ type: "ready", sdk: "typescript", version: SDK_VERSION, specVersion: SPEC_VERSION });
  for (;;) {
    const message = queue.shift();
    if (message === undefined) {
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
      continue;
    }
    switch (message.type) {
      case "init":
        init(message as unknown as InitMessage);
        await settle();
        break;
      case "call":
        for (const c of message.calls as {
          id: string;
          method: string;
          args: Record<string, Json>;
        }[]) {
          startCall(c.id, c.method, c.args ?? {});
        }
        await settle();
        break;
      case "advance":
        await advance(message.ms as number);
        break;
      case "set": {
        if (message.key === "fingerprint.fail") {
          fingerprintFails = message.value === true;
          await settle();
          break;
        }
        const key = String(message.key)
          .replace("storage.fail", "")
          .toLowerCase() as keyof typeof failures;
        failures[key] = message.value === true;
        await settle();
        break;
      }
      case "end":
        return process.exit(0);
      default:
        fatal(`모르는 명령 ${String(message.type)}`);
    }
    emit({ type: "idle", now });
  }
}

void main();
