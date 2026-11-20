import type { Api } from "./api.ts";
import { sha256Hex, utf8 } from "./bytes.ts";
import { BydevError, sdkError } from "./errors.ts";
import { ROUTES, RULES } from "./generated.ts";
import {
  type LicenseClaims,
  type LicenseTokenInfo,
  readSessionResponse,
  type SessionInfo,
} from "./models.ts";
import type { Ports } from "./ports.ts";
import { jittered } from "./timing.ts";
import type { AccessToken, TokenManager } from "./tokens.ts";
import type { TokenVerifier } from "./verify.ts";

/** 명세 8.1절 — 세션 상태(판별 유니온). 참/거짓 하나로 이용 가능을 알리지 않는다 */
export interface ActiveFields {
  readonly session: SessionInfo;
  readonly licenseToken: LicenseTokenInfo;
  readonly claims: LicenseClaims;
}

export interface ErrorView {
  readonly code: string;
  readonly message: string;
  readonly httpStatus: number | null;
  readonly correlationId: string | null;
  readonly retryAfterSec: number | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export type SessionState =
  | { readonly type: "Starting"; readonly attempt: number; readonly lastError: ErrorView | null }
  | ({ readonly type: "Active" } & ActiveFields)
  | ({
      readonly type: "Degraded";
      readonly consecutiveFailures: number;
      readonly offlineUntil: string;
      readonly lastError: ErrorView;
    } & ActiveFields)
  | {
      readonly type: "NeedsDecision";
      readonly reason: "DEVICE_IN_USE" | "INSTANCE_ALREADY_RUNNING" | "DEVICE_LIMIT_EXCEEDED";
      readonly activeSession: {
        readonly deviceId: string;
        readonly deviceName: string;
        readonly lastSeenAt: string;
      } | null;
      readonly maxDevices: number | null;
      readonly correlationId: string | null;
    }
  | {
      readonly type: "Locked";
      readonly code: string;
      readonly message: string;
      readonly correlationId: string | null;
      readonly details: Readonly<Record<string, unknown>> | null;
      readonly retrying: boolean;
    }
  | { readonly type: "Stopped" };

export interface DeviceInfo {
  readonly name: string;
  readonly platform: string;
}

/**
 * 실행 중인 앱 (명세 1절 · ADR-0049) — 배포 대상(업데이트 확인의 `target`과 같은 값)과 콘솔에 업로드한 버전 문자열. 세션 획득에 싣는다. 업데이트
 * 제공 기한이 있는 영구 이용권은 이 값이 없으면 획득이 `ENTITLEMENT_VERSION_NOT_COVERED`로 거절된다
 */
export interface AppInfo {
  readonly target: string;
  readonly version: string;
}

/** 예약된 다음 일 — 시각(Unix 밀리초)으로 둔다. 확장 서비스 워커가 다시 뜨면 이 시각으로 다시 예약한다 */
export type PendingWork =
  | {
      readonly kind: "acquire";
      readonly at: number;
      readonly force: boolean;
      /** 일시적 실패의 재시도는 같은 Idempotency-Key (8.2절) */
      readonly key: string;
      readonly attempt: number;
    }
  | { readonly kind: "heartbeat"; readonly at: number };

/**
 * 실행 중인 세션의 상태 — 브라우저 확장(MV3)의 서비스 워커는 쉬면 내려가 메모리가 사라진다. 이 값을 `chrome.storage.session`(메모리 저장소)에
 * 두었다가 다시 뜰 때 `restore`로 잇는다(`@bydev/sdk/extension`의 `resumeExtensionSession`). JSON으로 그대로 옮길 수 있는 값만 담는다
 */
export interface SessionSnapshot {
  readonly version: 1;
  /** 같은 instanceId로 다시 얻으면 서버가 같은 세션을 돌려준다 (ADR-0008 2절 3) */
  readonly instanceId: string;
  readonly state: SessionState;
  readonly held: ActiveFields | null;
  readonly failures: number;
  readonly pending: PendingWork | null;
  /** `Degraded`의 잠금 예약 시각 (8.4절) */
  readonly offlineAt: number | null;
  readonly fallbackSource: string | null;
  /** 처음 계산한 지문 해시 — 한 실행 동안 다시 쓴다(명세 10절, 1.2.0). 이 칸이 없는 앞 판의 스냅숏은 다음 획득 때 계산한다 */
  readonly fingerprint?: string | null;
  /** 메모리의 access_token — 다시 뜰 때마다 갱신(refresh_token 회전)하지 않게 */
  readonly access: AccessToken | null;
}

function view(error: BydevError): ErrorView {
  return {
    code: error.code,
    message: error.message,
    httpStatus: error.httpStatus,
    correlationId: error.correlationId,
    retryAfterSec: error.retryAfterSec,
    details: error.details,
  };
}

function toError(error: unknown): BydevError {
  return error instanceof BydevError ? error : sdkError("PROTOCOL_ERROR", String(error));
}

const DECISIONS = new Set<string>(RULES.needsDecisionReasons);

export class LicenseSession {
  private current: SessionState = { type: "Stopped" };
  private readonly listeners = new Set<(state: SessionState) => void>();
  /** 멈춤 · 다시 시작마다 올린다 — 앞 실행의 늦은 결과를 버린다 */
  private run = 0;
  private instanceId: string | null = null;
  private held: ActiveFields | null = null;
  private failures = 0;
  private heartbeatTimer: (() => void) | null = null;
  private offlineTimer: (() => void) | null = null;
  private pending: PendingWork | null = null;
  private offlineAt: number | null = null;
  private fallbackSource: string | null = null;
  /** 처음 계산한 지문 해시 — 획득마다 출처를 다시 읽으면 일시적인 읽기 실패 하나로 다른 기기가 된다(명세 10절) */
  private fingerprint: string | null = null;
  private readonly watchers = new Set<() => void>();
  private readonly api: Api;
  private readonly ports: Ports;
  private readonly tokens: TokenManager;
  private readonly verifier: TokenVerifier;
  private readonly device: DeviceInfo;
  private readonly app: AppInfo | undefined;

  constructor(deps: {
    api: Api;
    ports: Ports;
    tokens: TokenManager;
    verifier: TokenVerifier;
    device: DeviceInfo;
    app?: AppInfo;
  }) {
    this.api = deps.api;
    this.ports = deps.ports;
    this.tokens = deps.tokens;
    this.verifier = deps.verifier;
    this.device = deps.device;
    this.app = deps.app;
    // access_token이 바뀌면 스냅숏도 바뀐다 (이용권 조회 같은 다른 요청의 갱신)
    this.tokens.onAccessChange(() => {
      if (this.current.type !== "Stopped") this.changed();
    });
  }

  get state(): SessionState {
    return this.current;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 8.2절 — `Stopped`에서만 */
  start(): void {
    if (this.current.type !== "Stopped") return;
    this.run += 1;
    this.instanceId = this.ports.random.uuid();
    this.beginAcquire(false);
  }

  /** `NeedsDecision`(다른 기기 · 같은 기기 실행 중) 또는 `Locked`(SESSION_SUPERSEDED)에서 인수한다 — 새 Idempotency-Key */
  takeOver(): void {
    const s = this.current;
    const allowed =
      (s.type === "NeedsDecision" && s.reason !== "DEVICE_LIMIT_EXCEEDED") ||
      (s.type === "Locked" && s.code === "SESSION_SUPERSEDED");
    if (!allowed) return;
    this.run += 1;
    this.beginAcquire(true);
  }

  /** `NeedsDecision`(기기 수) 또는 스스로 풀리지 않는 `Locked`에서 다시 얻는다 */
  retry(): void {
    const s = this.current;
    const allowed =
      (s.type === "NeedsDecision" && s.reason === "DEVICE_LIMIT_EXCEEDED") ||
      (s.type === "Locked" && !s.retrying);
    if (!allowed) return;
    this.run += 1;
    this.beginAcquire(false);
  }

  /** 8.7절 — 예약을 모두 취소하고 반납을 한 번 보낸다 */
  async stop(): Promise<void> {
    if (this.current.type === "Stopped") return;
    this.run += 1;
    this.cancelTimers();
    const sid = this.held?.session.id ?? null;
    this.held = null;
    this.instanceId = null;
    if (sid !== null) {
      try {
        await this.tokens.authed((bearer) =>
          this.api.send({
            method: "DELETE",
            url: this.api.url(ROUTES.releaseSession.path, { sid }),
            bearer,
          }),
        );
      } catch {
        this.ports.logger.debug("세션 반납을 보내지 못했다 — 리스가 저절로 빈다");
      }
    }
    this.setState({ type: "Stopped" });
  }

  /** 실행 중이면 스냅숏, 멈췄으면 null */
  snapshot(): SessionSnapshot | null {
    if (this.current.type === "Stopped" || this.instanceId === null) return null;
    return {
      version: 1,
      instanceId: this.instanceId,
      state: this.current,
      held: this.held,
      failures: this.failures,
      pending: this.pending,
      offlineAt: this.offlineAt,
      fallbackSource: this.fallbackSource,
      fingerprint: this.fingerprint,
      access: this.tokens.currentAccess(),
    };
  }

  /**
   * `Stopped`인 새 세션에 스냅숏을 잇는다 — 상태를 알리고, 예약된 일은 그 시각에(지났으면 바로) 다시 예약한다. 나머지 동작은 명세 8절 그대로다
   * (지난 하트비트는 바로 보내고, 리스가 끝났으면 `SESSION_REVOKED` → 같은 instanceId로 다시 얻는다)
   */
  restore(snapshot: SessionSnapshot): void {
    if (this.current.type !== "Stopped" || snapshot.version !== 1) return;
    this.run += 1;
    const run = this.run;
    this.instanceId = snapshot.instanceId;
    this.held = snapshot.held;
    this.failures = snapshot.failures;
    this.fallbackSource = snapshot.fallbackSource;
    this.fingerprint = snapshot.fingerprint ?? null;
    if (snapshot.access !== null) this.tokens.restoreAccess(snapshot.access);
    if (snapshot.held !== null) this.verifier.noteGeneration(snapshot.held.claims);
    this.setState(snapshot.state);
    if (snapshot.pending !== null) this.arm(run, snapshot.pending);
    if (snapshot.offlineAt !== null) this.armOfflineAt(run, snapshot.offlineAt);
    this.changed();
  }

  /** 스냅숏이 바뀔 때마다 부른다(상태 · 예약 · access_token) — 확장 저장소가 쓴다 */
  watch(listener: () => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /** 8.5절 — 다른 인증 응답의 X-Lease-Expires-At */
  noteLease(leaseExpiresAt: string | undefined): void {
    if (leaseExpiresAt === undefined || this.held === null) return;
    const s = this.current;
    if (s.type !== "Active" && s.type !== "Degraded") return;
    if (s.session.leaseExpiresAt === leaseExpiresAt) return;
    this.held = { ...this.held, session: { ...this.held.session, leaseExpiresAt } };
    this.setState({ ...s, session: this.held.session });
  }

  private setState(next: SessionState): void {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        this.ports.logger.warn("세션 상태 구독자가 던졌다");
      }
    }
    this.changed();
  }

  private changed(): void {
    for (const watcher of this.watchers) {
      try {
        watcher();
      } catch {
        this.ports.logger.warn("세션 스냅숏 감시자가 던졌다");
      }
    }
  }

  private cancelTimers(): void {
    this.heartbeatTimer?.();
    this.heartbeatTimer = null;
    this.pending = null;
    this.offlineTimer?.();
    this.offlineTimer = null;
    this.offlineAt = null;
  }

  /** 다음 일을 그 시각에 예약한다 — 앞 예약은 지운다. 일이 도는 동안에도 기록은 남는다(도중에 내려가면 다시 뜰 때 다시 한다) */
  private arm(run: number, pending: PendingWork): void {
    this.heartbeatTimer?.();
    this.pending = pending;
    const delay = Math.max(0, pending.at - this.ports.clock.now());
    this.heartbeatTimer = this.ports.scheduler.schedule(delay, () =>
      pending.kind === "acquire"
        ? this.acquire(run, pending.force, pending.key, pending.attempt)
        : this.heartbeat(run),
    );
    this.changed();
  }

  private beginAcquire(force: boolean, lastError: BydevError | null = null): void {
    this.cancelTimers();
    this.held = null;
    this.failures = 0;
    this.setState({
      type: "Starting",
      attempt: 0,
      lastError: lastError === null ? null : view(lastError),
    });
    const key = this.ports.random.uuid();
    this.arm(this.run, { kind: "acquire", at: this.ports.clock.now(), force, key, attempt: 0 });
  }

  private async fingerprintHash(): Promise<string> {
    if (this.fingerprint !== null) return this.fingerprint;
    const hash = await this.computeFingerprintHash();
    this.fingerprint ??= hash; // 동시에 계산했으면 먼저 정한 값
    return this.fingerprint;
  }

  private async computeFingerprintHash(): Promise<string> {
    let source: string | null = null;
    try {
      source = await this.ports.fingerprint.read();
    } catch {
      source = null;
    }
    const value = source?.trim() ?? "";
    if (value === "") {
      if (this.fallbackSource === null) {
        this.fallbackSource = this.ports.random.uuid();
        this.ports.logger.warn(
          "기기 지문 출처를 읽지 못해 이번 실행 동안만 쓰는 ID를 쓴다 — 출처 포트를 준다(명세 10절)",
        );
      }
      return await sha256Hex(utf8(`${this.fallbackSource}${RULES.fingerprint.salt}`));
    }
    return await sha256Hex(utf8(`${value}${RULES.fingerprint.salt}`));
  }

  /** 8.2절 획득 — 일시적 실패의 재시도는 같은 키 */
  private async acquire(run: number, force: boolean, key: string, attempt: number): Promise<void> {
    if (run !== this.run) return;
    try {
      const body = {
        device: {
          fingerprintHash: await this.fingerprintHash(),
          name: this.device.name,
          platform: this.device.platform,
        },
        instanceId: this.instanceId,
        force,
        ...(this.app === undefined
          ? {}
          : { app: { target: this.app.target, version: this.app.version } }),
      };
      const res = await this.tokens.authed((bearer) =>
        this.api.send({
          method: "POST",
          url: this.api.url(ROUTES.acquireSession.path),
          body,
          bearer,
          idempotencyKey: key,
        }),
      );
      if (run !== this.run) return;
      await this.adopt(run, res.json);
    } catch (caught) {
      if (run !== this.run) return;
      const error = toError(caught);
      if (error.transient) {
        const delays = RULES.session.startRetryDelaysSec;
        const base = delays[Math.min(attempt, delays.length - 1)] ?? 60;
        this.setState({ type: "Starting", attempt: attempt + 1, lastError: view(error) });
        const delay = jittered(this.ports, base * 1000, RULES.session.heartbeatJitter);
        this.arm(run, {
          kind: "acquire",
          at: this.ports.clock.now() + delay,
          force,
          key,
          attempt: attempt + 1,
        });
      } else if (DECISIONS.has(error.code)) {
        this.cancelTimers();
        const active = error.details?.activeSession;
        const details = error.details ?? {};
        this.setState({
          type: "NeedsDecision",
          reason: error.code as "DEVICE_IN_USE",
          activeSession:
            active !== null && typeof active === "object"
              ? (active as { deviceId: string; deviceName: string; lastSeenAt: string })
              : null,
          maxDevices: typeof details.maxDevices === "number" ? details.maxDevices : null,
          correlationId: error.correlationId,
        });
      } else {
        this.lock(error, false);
      }
    }
  }

  /** 200 응답 → 검증(9절) → Active → 다음 하트비트 */
  private async adopt(run: number, json: unknown): Promise<void> {
    const { session, licenseToken } = readSessionResponse(json);
    const claims = await this.verifier.verifyLicense(licenseToken.token, {
      sid: session.id,
      deviceId: session.deviceId,
      generation: session.generation,
    });
    if (run !== this.run) return;
    this.held = { session, licenseToken, claims };
    this.failures = 0;
    this.offlineTimer?.();
    this.offlineTimer = null;
    this.offlineAt = null;
    this.setState({ type: "Active", session, licenseToken, claims });
    this.scheduleHeartbeat(run, session.heartbeatSec, null);
  }

  private scheduleHeartbeat(run: number, heartbeatSec: number, retryAfterSec: number | null): void {
    let delay = jittered(this.ports, heartbeatSec * 1000, RULES.session.heartbeatJitter);
    if (retryAfterSec !== null) delay = Math.max(delay, retryAfterSec * 1000);
    this.arm(run, { kind: "heartbeat", at: this.ports.clock.now() + delay });
  }

  /** 8.3절 */
  private async heartbeat(run: number): Promise<void> {
    if (run !== this.run || this.held === null) return;
    const held = this.held;
    try {
      const res = await this.tokens.authed((bearer) =>
        this.api.send({
          method: "POST",
          url: this.api.url(ROUTES.heartbeatSession.path, { sid: held.session.id }),
          body: { generation: held.session.generation },
          bearer,
        }),
      );
      if (run !== this.run) return;
      await this.adopt(run, res.json);
    } catch (caught) {
      if (run !== this.run) return;
      const error = toError(caught);
      if (error.transient) {
        this.failures += 1;
        const s = this.current;
        if (s.type === "Active" || s.type === "Degraded") {
          this.setState({
            type: "Degraded",
            ...held,
            consecutiveFailures: this.failures,
            offlineUntil: held.licenseToken.expiresAt,
            lastError: view(error),
          });
          this.armOfflineExpiry(run, held.licenseToken.expiresAt);
        }
        this.scheduleHeartbeat(
          run,
          held.session.heartbeatSec,
          error.code === "RATE_LIMITED" || error.httpStatus === 429 ? error.retryAfterSec : null,
        );
      } else if (error.code === "SESSION_REVOKED") {
        // 리스가 끝났을 때도 이 코드다 — 한 번 다시 얻는다(같은 instanceId, 새 키)
        this.beginAcquire(false, error);
      } else {
        this.lock(error, false);
      }
    }
  }

  /** 8.4절 — offlineUntil이 지나도록 성공하지 못하면 잠근다. 재시도는 그대로 */
  private armOfflineExpiry(run: number, offlineUntil: string): void {
    if (this.offlineTimer !== null) return;
    this.armOfflineAt(run, Date.parse(offlineUntil));
  }

  private armOfflineAt(run: number, at: number): void {
    this.offlineAt = at;
    const delay = Math.max(0, at - this.ports.clock.now());
    this.offlineTimer = this.ports.scheduler.schedule(delay, async () => {
      this.offlineTimer = null;
      this.offlineAt = null;
      if (run !== this.run || this.current.type !== "Degraded") return;
      this.setState({
        type: "Locked",
        code: "OFFLINE_EXPIRED",
        message: "하트비트에 성공하지 못한 채 licenseToken이 만료됐다",
        correlationId: null,
        details: null,
        retrying: true,
      });
    });
  }

  private lock(error: BydevError, retrying: boolean): void {
    this.cancelTimers();
    this.setState({
      type: "Locked",
      code: error.code,
      message: error.message,
      correlationId: error.correlationId,
      details: error.details,
      retrying,
    });
  }
}
