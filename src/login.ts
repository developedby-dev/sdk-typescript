import type { Api } from "./api.ts";
import { iso } from "./bytes.ts";
import { BydevError, sdkError } from "./errors.ts";
import { DEVICE_CODE_GRANT_TYPE, RULES } from "./generated.ts";
import { type DeviceCode, readTokenResponse } from "./models.ts";
import type { Ports } from "./ports.ts";
import { jittered } from "./timing.ts";
import type { TokenManager } from "./tokens.ts";

/** 명세 5절 — 디바이스 플로우 하나. 코드를 받은 순간부터 폴링하고, `wait()`는 그 결과를 기다린다 */
export class LoginAttempt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: string;
  private readonly expiresAtMs: number;
  private intervalSec: number;
  private settled = false;
  private cancelTimer: (() => void) | null = null;
  private readonly done: Promise<{ scope: string }>;
  private resolve!: (value: { scope: string }) => void;
  private reject!: (error: BydevError) => void;
  private readonly code: DeviceCode;
  private readonly api: Api;
  private readonly ports: Ports;
  private readonly tokens: TokenManager;
  private readonly clientId: string;

  constructor(
    code: DeviceCode,
    deps: { api: Api; ports: Ports; tokens: TokenManager; clientId: string },
  ) {
    this.code = code;
    this.api = deps.api;
    this.ports = deps.ports;
    this.tokens = deps.tokens;
    this.clientId = deps.clientId;
    this.userCode = code.userCode;
    this.verificationUri = code.verificationUri;
    this.verificationUriComplete = code.verificationUriComplete;
    this.expiresAtMs = deps.ports.clock.now() + code.expiresIn * 1000;
    this.expiresAt = iso(this.expiresAtMs);
    this.intervalSec = code.interval;
    this.done = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // 앱이 wait()를 부르지 않아도 처리되지 않은 거부가 되지 않게
    this.done.catch(() => undefined);
    this.schedulePoll();
  }

  wait(): Promise<{ scope: string }> {
    return this.done;
  }

  cancel(): void {
    this.finish(sdkError("LOGIN_CANCELLED", "로그인을 취소했다"));
  }

  private finish(outcome: BydevError | { scope: string }): void {
    if (this.settled) return;
    this.settled = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    if (outcome instanceof BydevError) this.reject(outcome);
    else this.resolve(outcome);
  }

  /** 폴링 지터는 위로만 — interval보다 이르게 보내면 SLOW_DOWN이다. 429면 retryAfterSec보다 이르게 묻지 않는다(명세 5절) */
  private schedulePoll(retryAfterSec: number | null = null): void {
    let delay = jittered(this.ports, this.intervalSec * 1000, RULES.login.pollJitter);
    if (retryAfterSec !== null) delay = Math.max(delay, retryAfterSec * 1000);
    if (this.ports.clock.now() + delay > this.expiresAtMs) {
      this.finish(new BydevError("EXPIRED_TOKEN", "로그인 코드가 만료됐다 — 처음부터 다시"));
      return;
    }
    this.cancelTimer = this.ports.scheduler.schedule(delay, () => this.poll());
  }

  private async poll(): Promise<void> {
    if (this.settled) return;
    try {
      const discovery = await this.api.discovery();
      const res = await this.api.send({
        method: "POST",
        url: discovery.tokenEndpoint,
        body: {
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: this.clientId,
          device_code: this.code.deviceCode,
        },
      });
      if (this.settled) return;
      const set = readTokenResponse(res.json);
      await this.tokens.adopt(set);
      this.finish({ scope: set.scope });
    } catch (error) {
      if (this.settled) return;
      if (!(error instanceof BydevError)) {
        this.finish(sdkError("PROTOCOL_ERROR", String(error)));
        return;
      }
      if (error.code === "AUTHORIZATION_PENDING") {
        this.schedulePoll();
      } else if (error.transient) {
        this.schedulePoll(
          error.code === "RATE_LIMITED" || error.httpStatus === 429 ? error.retryAfterSec : null,
        );
      } else if (error.code === "SLOW_DOWN") {
        this.intervalSec =
          error.retryAfterSec ?? this.intervalSec + RULES.login.slowDownIncrementSec;
        this.schedulePoll();
      } else {
        this.finish(error);
      }
    }
  }
}
