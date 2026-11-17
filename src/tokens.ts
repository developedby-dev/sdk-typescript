import type { Api } from "./api.ts";
import { iso } from "./bytes.ts";
import { BydevError, sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import { readTokenResponse, type TokenSet } from "./models.ts";
import type { CredentialRecord, Ports } from "./ports.ts";
import { sleep } from "./timing.ts";

/** 메모리의 access_token — 디스크에 두지 않는다(명세 3.6) */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
}

/** 명세 3.5 · 3.6 · 6절 — 기록 보관 · 갱신 · 인증 요청 감싸기 */
export class TokenManager {
  private readonly api: Api;
  private readonly ports: Ports;
  private readonly clientId: string;
  private accessValue: AccessToken | null = null;
  private refreshing: Promise<string> | null = null;
  private readonly accessListeners = new Set<() => void>();

  constructor(api: Api, ports: Ports, clientId: string) {
    this.api = api;
    this.ports = ports;
    this.clientId = clientId;
  }

  private get access(): AccessToken | null {
    return this.accessValue;
  }

  private set access(value: AccessToken | null) {
    if (value === this.accessValue) return;
    this.accessValue = value;
    for (const listener of this.accessListeners) listener();
  }

  /**
   * 확장 서비스 워커가 내려갔다 다시 뜰 때 이어 쓰려고 — 메모리의 access_token을 꺼내고 다시 넣는다(`chrome.storage.session`은 메모리 저장소다 —
   * ADR-0040 확장 세션 기록). 바뀔 때마다 알린다
   */
  currentAccess(): AccessToken | null {
    return this.accessValue;
  }

  restoreAccess(value: AccessToken | null): void {
    this.access = value;
  }

  onAccessChange(listener: () => void): () => void {
    this.accessListeners.add(listener);
    return () => this.accessListeners.delete(listener);
  }

  async load(): Promise<CredentialRecord | null> {
    let record: CredentialRecord | null;
    try {
      record = await this.ports.store.load();
    } catch (error) {
      throw sdkError("STORAGE_FAILED", "보안 저장소를 읽지 못했다", { cause: error });
    }
    return record !== null && record.version === RULES.storage.recordVersion ? record : null;
  }

  /** 6절 3 · 5절 — 저장한 뒤에 쓴다 */
  async adopt(set: TokenSet): Promise<void> {
    const record: CredentialRecord = {
      version: 1,
      refreshToken: set.refreshToken,
      scope: set.scope,
      savedAt: iso(this.ports.clock.now()),
    };
    this.access = null;
    try {
      await this.ports.store.save(record);
    } catch (error) {
      throw sdkError(
        "STORAGE_FAILED",
        "새 로그인을 보안 저장소에 두지 못했다 — 새 토큰을 쓰지 않는다",
        { cause: error },
      );
    }
    this.access = {
      token: set.accessToken,
      expiresAt: this.ports.clock.now() + set.expiresIn * 1000,
    };
  }

  async accessToken(): Promise<string> {
    const access = this.access;
    if (
      access !== null &&
      access.expiresAt - RULES.token.refreshSkewSec * 1000 > this.ports.clock.now()
    ) {
      return access.token;
    }
    return await this.refresh();
  }

  /** 6절 1 — 한 번에 하나 */
  refresh(): Promise<string> {
    this.access = null;
    if (this.refreshing === null) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const record = await this.load();
    if (record === null) throw sdkError("NOT_SIGNED_IN", "로그인이 없다 — 먼저 로그인한다");
    const discovery = await this.api.discovery();
    const delays = RULES.token.refreshRetryDelaysSec;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.api.send({
          method: "POST",
          url: discovery.tokenEndpoint,
          body: {
            grant_type: "refresh_token",
            client_id: this.clientId,
            refresh_token: record.refreshToken,
          },
        });
        const set = readTokenResponse(res.json);
        await this.adopt(set);
        return set.accessToken;
      } catch (error) {
        if (!(error instanceof BydevError)) throw error;
        if (error.code === "INVALID_GRANT") {
          await this.forgetStored();
          throw error;
        }
        const delay = delays[attempt];
        if (!error.transient || delay === undefined) throw error;
        await sleep(this.ports, delay * 1000);
      }
    }
  }

  /** 3.5절 — 만료면 한 번만 갱신하고 다시 보낸다 */
  async authed<T>(send: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken();
    try {
      return await send(token);
    } catch (error) {
      if (!(error instanceof BydevError) || error.code !== "EXPIRED_TOKEN") throw error;
    }
    try {
      return await send(await this.refresh());
    } catch (error) {
      // 갓 받은 토큰도 거절됐다 — 다음 요청이 같은 토큰을 다시 쓰지 않게 버린다
      if (error instanceof BydevError && error.code === "EXPIRED_TOKEN") this.access = null;
      throw error;
    }
  }

  private async forgetStored(): Promise<void> {
    this.access = null;
    try {
      await this.ports.store.clear();
    } catch {
      this.ports.logger.warn("끝난 로그인의 기록을 지우지 못했다");
    }
  }

  /** 7절 — 폐기 요청은 한 번, 결과와 상관없이 지운다 */
  async logout(): Promise<{ serverRevoked: boolean }> {
    const record = await this.load();
    let serverRevoked = false;
    if (record !== null) {
      try {
        const discovery = await this.api.discovery();
        await this.api.send({
          method: "POST",
          url: discovery.revocationEndpoint,
          body: {
            client_id: this.clientId,
            token: record.refreshToken,
            token_type_hint: "refresh_token",
          },
        });
        serverRevoked = true;
      } catch {
        serverRevoked = false;
      }
    }
    this.access = null;
    try {
      await this.ports.store.clear();
    } catch (error) {
      throw sdkError("STORAGE_FAILED", "로그인 기록을 지우지 못했다", { cause: error });
    }
    return { serverRevoked };
  }
}
