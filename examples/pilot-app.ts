/**
 * 자체 파일럿 앱 — 운영 API에서 planning §20의 5 ~ 8 · 12 · 13 · 14단계를 사람이 확인하려고 만든 작은 「데스크톱 앱」이다(launch-checklist E2 ·
 * 절차는 docs/runbooks/pilot.md). 공식 SDK(`../src`)만 쓰고 의존성이 없다 — 저장소를 받지 않아도 `src` 폴더와 이 파일만 복사해 Node 24로 돈다.
 *
 *   node examples/pilot-app.ts login    기기 로그인 — 코드와 주소를 보여 주고 브라우저 승인을 기다린다(기기마다 한 번)
 *   node examples/pilot-app.ts status   로그인 여부 · 이용권 · 등록 기기
 *   node examples/pilot-app.ts run      세션을 잡고 상태가 바뀔 때마다 한 줄씩 적는다. Ctrl+C면 세션을 반납하고 끝난다
 *   node examples/pilot-app.ts release <기기 ID>   등록 기기 하나를 해제한다(기기 수 한도에 걸렸을 때 — 목록은 status)
 *   node examples/pilot-app.ts logout   이 기기의 로그인을 폐기한다
 *
 * 설정은 환경 변수다 — `BYDEV_PILOT_CLIENT_ID` · `BYDEV_PILOT_PRODUCT_ID`(필수, 콘솔 제품 화면의 LIVE client와 제품 ID),
 * `BYDEV_PILOT_BASE_URL`(기본 https://api.developedby.dev), `BYDEV_PILOT_SCOPES`(기본 `entitlement.read session.write device.manage`).
 *
 * `run`의 선택:
 *   --decide ask|take-over|stop  다른 곳에서 쓰는 중일 때(DEVICE_IN_USE · INSTANCE_ALREADY_RUNNING) 어떻게 할지. 기본 ask — 터미널에서 묻는다.
 *                                기기 수 한도(DEVICE_LIMIT_EXCEEDED)는 인수할 수 없어 늘 끝낸다
 *   --offline-file <경로>         그 파일이 있는 동안 모든 요청을 닿지 않는 주소(127.0.0.1:9)로 보낸다 — 네트워크 단절(8단계). 지우면 연결이 돌아온다
 *   --exit-on-lock               잠기면(스스로 풀리는 OFFLINE_EXPIRED는 빼고) 종료 코드 2로 끝낸다
 *
 * 종료 코드: 0 Ctrl+C로 반납 · 2 잠김(--exit-on-lock) · 3 결정에서 인수하지 않고 끝냄 · 1 설정 · 실행 오류.
 *
 * 로컬 리허설에서만: `BYDEV_PILOT_DEVICE_SALT=<값>`이면 같은 컴퓨터를 다른 기기로 보이게 한다(기기 지문 앞에 붙이고 로그인 기록도 따로 둔다).
 * 운영 파일럿에서는 쓰지 않는다 — 5 · 8단계는 실제 다른 컴퓨터로 한다.
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  BydevError,
  type FingerprintSource,
  fetchTransport,
  LicenseClient,
  type Logger,
  type SessionState,
  type Transport,
} from "../src/index.ts";
import { defaultNodeCredentialStore, nodeDeviceInfo, nodeFingerprintSource } from "../src/node.ts";

const out = (line: string) => process.stdout.write(`${line}\n`);
const err = (line: string) => process.stderr.write(`${line}\n`);
const stamp = () => new Date().toISOString().slice(11, 19);

const DECISIONS = ["ask", "take-over", "stop"] as const;
type Decision = (typeof DECISIONS)[number];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`환경 변수 ${name}가 비었다`);
  return value;
}

/** 스위치 파일이 있는 동안 요청을 닿지 않는 주소로 보낸다 — SDK가 받는 것은 진짜 연결 실패(NETWORK_ERROR)다 */
function switchableTransport(offlineFile: string | undefined): Transport {
  const inner = fetchTransport();
  if (offlineFile === undefined) return inner;
  let offline = false;
  return {
    send(request) {
      const now = existsSync(offlineFile);
      if (now !== offline) {
        offline = now;
        out(
          `[${stamp()}] ${now ? "연결 끊김 — 스위치 파일이 있다" : "연결 돌아옴 — 스위치 파일이 없다"}`,
        );
      }
      if (!now) return inner.send(request);
      const path = new URL(request.url);
      return inner.send({ ...request, url: `http://127.0.0.1:9${path.pathname}${path.search}` });
    },
  };
}

function saltedFingerprint(base: FingerprintSource, salt: string | undefined): FingerprintSource {
  if (salt === undefined) return base;
  return {
    async read() {
      const value = await base.read();
      return value === null ? null : `${salt}:${value}`;
    },
  };
}

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message) => err(`SDK 경고: ${message}`),
};

async function buildClient(offlineFile?: string): Promise<LicenseClient> {
  const clientId = required("BYDEV_PILOT_CLIENT_ID");
  const productId = required("BYDEV_PILOT_PRODUCT_ID");
  const salt = process.env.BYDEV_PILOT_DEVICE_SALT?.trim() || undefined;
  const device = nodeDeviceInfo();
  return new LicenseClient({
    baseUrl: process.env.BYDEV_PILOT_BASE_URL?.trim() || "https://api.developedby.dev",
    clientId,
    productId,
    scopes: (
      process.env.BYDEV_PILOT_SCOPES?.trim() || "entitlement.read session.write device.manage"
    ).split(/\s+/),
    device: salt === undefined ? device : { ...device, name: `${device.name} (리허설 ${salt})` },
    ports: {
      transport: switchableTransport(offlineFile),
      // 제품(client)마다 · 리허설 기기마다 로그인 기록을 따로 둔다 — 다른 client의 refresh_token을 보내 기록이 지워지지 않게
      store: await defaultNodeCredentialStore({
        appName: `bydev-pilot-${clientId}${salt === undefined ? "" : `-${salt}`}`,
        account: clientId,
        logger,
      }),
      fingerprint: saltedFingerprint(nodeFingerprintSource(), salt),
      logger,
    },
  });
}

function describe(state: SessionState): string {
  switch (state.type) {
    case "Starting":
      return `획득 중 — 시도 ${state.attempt}${state.lastError ? ` · 직전 오류 ${state.lastError.code}` : ""}`;
    case "Active":
      return `사용 중 — 세션 ${state.session.id} · 세대 ${state.session.generation} · 리스 ${state.session.leaseExpiresAt}까지 · 하트비트 ${state.session.heartbeatSec}초 · 토큰 ${state.licenseToken.expiresAt}까지`;
    case "Degraded":
      return `연결 실패 중 — 연속 ${state.consecutiveFailures}회(${state.lastError.code}) · ${state.offlineUntil}까지는 계속 쓴다 · 세션 ${state.session.id} · 세대 ${state.session.generation}`;
    case "NeedsDecision": {
      const other = state.activeSession;
      return `결정 필요 — ${state.reason}${other ? ` · 사용 중인 기기 「${other.deviceName}」(마지막 ${other.lastSeenAt})` : ""}${state.maxDevices === null ? "" : ` · 최대 기기 ${state.maxDevices}`} · 추적 ID ${state.correlationId ?? "-"}`;
    }
    case "Locked":
      return `잠김 — ${state.code}: ${state.message} · 추적 ID ${state.correlationId ?? "-"}${state.retrying ? " · 연결이 돌아오면 스스로 풀린다" : ""}`;
    case "Stopped":
      return "멈춤";
  }
}

async function login(): Promise<number> {
  const client = await buildClient();
  if (await client.hasCredentials()) {
    out("이미 로그인돼 있다 — 다른 계정으로 하려면 먼저 logout");
    return 0;
  }
  const attempt = await client.startLogin();
  out(`브라우저에서 ${attempt.verificationUriComplete} 를 열어 승인한다`);
  out(`(또는 ${attempt.verificationUri} 에서 코드 ${attempt.userCode} — ${attempt.expiresAt}까지)`);
  const { scope } = await attempt.wait();
  out(`로그인했다 — 범위 ${scope}`);
  return 0;
}

function deviceLine(client: LicenseClient): string {
  const device = client.config.device;
  return device === undefined ? "기기 정보 없음" : `기기 ${device.name} · ${device.platform}`;
}

const errorText = (error: unknown) =>
  error instanceof BydevError ? `${error.code}: ${error.message}` : String(error);

async function status(): Promise<number> {
  const client = await buildClient();
  out(deviceLine(client));
  if (!(await client.hasCredentials())) {
    out("로그인 없음 — login부터");
    return 0;
  }
  try {
    const e = await client.entitlement();
    const term =
      e.term.type === "PERPETUAL"
        ? "영구"
        : `${e.term.type} · ${e.term.expiresAt ?? "-"}까지(남은 ${e.term.remainingDays ?? "-"}일)`;
    out(`이용권 ${e.id} · ${e.status} · ${term}`);
    out(`업데이트 범위 ${JSON.stringify(e.updateCoverage)}`);
    if (e.subscription) out(`구독 ${JSON.stringify(e.subscription)}`);
    out(`정책 기기 ${e.policy.maxDevices}대 · 동시 ${e.policy.maxConcurrent}`);
  } catch (error) {
    out(`이용권 — ${errorText(error)}`);
  }
  try {
    const page = await client.devices();
    if (page.items.length === 0) out("등록 기기 없음");
    for (const d of page.items)
      out(`등록 기기 ${d.id} · ${d.name} · ${d.platform} · 마지막 ${d.lastSeenAt}`);
  } catch (error) {
    out(`등록 기기 — ${errorText(error)}`);
  }
  return 0;
}

async function release(deviceId: string | undefined): Promise<number> {
  if (deviceId === undefined) throw new Error("release <기기 ID> — 기기 ID는 status에 나온다");
  const client = await buildClient();
  const result = await client.releaseDevice(deviceId);
  out(`해제했다 — ${result.id} · ${result.status} · ${result.releasedAt}`);
  return 0;
}

async function logout(): Promise<number> {
  const client = await buildClient();
  const { serverRevoked } = await client.logout();
  out(
    serverRevoked
      ? "로그아웃했다 — 서버에서도 폐기했다"
      : "이 기기의 기록은 지웠다 — 서버 폐기는 확인하지 못했다",
  );
  return 0;
}

async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      decide: { type: "string", default: "ask" },
      "offline-file": { type: "string" },
      "exit-on-lock": { type: "boolean", default: false },
    },
  });
  const decide = values.decide as Decision;
  if (!DECISIONS.includes(decide)) throw new Error(`--decide는 ${DECISIONS.join(" · ")} 중 하나`);
  const client = await buildClient(values["offline-file"]);
  if (!(await client.hasCredentials())) {
    out("로그인 없음 — login부터");
    return 1;
  }
  out(`[${stamp()}] 시작 — 프로세스 ${process.pid} · ${deviceLine(client)}`);
  const session = client.session();
  let finish: (code: number) => void = () => undefined;
  const finished = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const end = (code: number) => {
    void session.stop().finally(() => finish(code));
  };
  let deciding = false;
  const onDecision = async (reason: string) => {
    if (deciding) return;
    if (reason === "DEVICE_LIMIT_EXCEEDED") {
      out(
        `[${stamp()}] 기기 수 한도 — 인수할 수 없다. 다른 기기를 해제하려면 status로 목록을 보고 release <기기 ID>`,
      );
      end(3);
      return;
    }
    deciding = true;
    let take = decide === "take-over";
    if (decide === "ask") {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("여기서 사용할까요? y = 인수 · n = 끝내기 > ");
      rl.close();
      take = answer.trim().toLowerCase().startsWith("y");
    }
    deciding = false;
    if (take) {
      out(`[${stamp()}] 인수한다(force)`);
      session.takeOver();
    } else {
      out(`[${stamp()}] 인수하지 않고 끝낸다 — 이 기기는 막혔다`);
      end(3);
    }
  };
  let previous = "";
  session.subscribe((state) => {
    const line = describe(state);
    if (line !== previous) out(`[${stamp()}] ${line}`);
    previous = line;
    // 알림은 상태를 바꾼 작업 안에서 온다 — 세션 조작은 그 작업이 끝난 뒤에 한다
    if (state.type === "NeedsDecision") {
      const reason = state.reason;
      setImmediate(() => void onDecision(reason));
    }
    if (state.type === "Locked" && !state.retrying && values["exit-on-lock"])
      setImmediate(() => end(2));
  });
  process.once("SIGINT", () => {
    out(`[${stamp()}] Ctrl+C — 세션을 반납한다`);
    end(0);
  });
  session.start();
  return await finished;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "login":
      return await login();
    case "status":
      return await status();
    case "logout":
      return await logout();
    case "run":
      return await run(rest);
    case "release":
      return await release(rest[0]);
    default:
      out(
        "사용법: node examples/pilot-app.ts login | status | run [--decide ask|take-over|stop] [--offline-file 경로] [--exit-on-lock] | release <기기 ID> | logout",
      );
      return command === undefined ? 0 : 1;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    err(
      error instanceof BydevError
        ? `${error.code}: ${error.message}`
        : String(error instanceof Error ? error.message : error),
    );
    process.exit(1);
  },
);
