import { Api } from "./api.ts";
import { sha256Hex } from "./bytes.ts";
import {
  cryptoRandom,
  fetchTransport,
  memoryCredentialStore,
  noFingerprint,
  silentLogger,
  systemClock,
  timerScheduler,
} from "./defaults.ts";
import { sdkError } from "./errors.ts";
import { ROUTES } from "./generated.ts";
import { LoginAttempt } from "./login.ts";
import {
  type DevicePage,
  type DeviceRelease,
  type Entitlement,
  type LicenseClaims,
  type Profile,
  readDeviceCode,
  readDevicePage,
  readDeviceRelease,
  readEntitlementResponse,
  readProfileResponse,
  readUpdateCheck,
  type UpdateCheck,
} from "./models.ts";
import type { Ports } from "./ports.ts";
import { type AppInfo, type DeviceInfo, LicenseSession } from "./session.ts";
import { TokenManager } from "./tokens.ts";
import { TokenVerifier } from "./verify.ts";

/** 명세 1절 — 설정 */
export interface LicenseClientConfig {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly productId: string;
  readonly scopes: readonly string[];
  /** 세션을 쓰면 필요하다 */
  readonly device?: DeviceInfo;
  /** 실행 중인 앱의 배포 대상 · 버전 — 세션을 쓰면 넣는다 (명세 1절 · ADR-0049) */
  readonly app?: AppInfo;
  readonly ports?: Partial<Ports>;
}

/**
 * 데브 라이선스 API 클라이언트. 로그인 · 갱신 · 세션 · 검증 · 업데이트를 명세(`sdks/spec`)대로 한다. 서버 응답 하나의 참/거짓으로 기능을 열지 않는다 —
 * 세션 상태(`session().state`)와 검증된 토큰의 클레임을 쓴다
 */
export class LicenseClient {
  readonly config: LicenseClientConfig;
  private readonly ports: Ports;
  private readonly api: Api;
  private readonly tokens: TokenManager;
  private readonly verifier: TokenVerifier;
  private login: LoginAttempt | null = null;
  private licenseSession: LicenseSession | null = null;

  constructor(config: LicenseClientConfig) {
    if (config.scopes.length === 0) throw sdkError("CONFIGURATION", "scopes가 비었다");
    this.config = config;
    this.ports = {
      transport: config.ports?.transport ?? fetchTransport(),
      store: config.ports?.store ?? memoryCredentialStore(),
      clock: config.ports?.clock ?? systemClock,
      scheduler: config.ports?.scheduler ?? timerScheduler,
      random: config.ports?.random ?? cryptoRandom,
      fingerprint: config.ports?.fingerprint ?? noFingerprint,
      logger: config.ports?.logger ?? silentLogger,
    };
    this.api = new Api(config.baseUrl, this.ports);
    this.tokens = new TokenManager(this.api, this.ports, config.clientId);
    this.verifier = new TokenVerifier(this.api, this.ports, config.clientId);
  }

  /** 5절 — 진행 중인 로그인은 취소한다 */
  async startLogin(): Promise<LoginAttempt> {
    this.login?.cancel();
    this.login = null;
    const discovery = await this.api.discovery();
    const res = await this.api.send({
      method: "POST",
      url: discovery.deviceAuthorizationEndpoint,
      body: { client_id: this.config.clientId, scope: this.config.scopes.join(" ") },
    });
    const attempt = new LoginAttempt(readDeviceCode(res.json), {
      api: this.api,
      ports: this.ports,
      tokens: this.tokens,
      clientId: this.config.clientId,
    });
    this.login = attempt;
    return attempt;
  }

  /** 저장된 로그인이 있는가 — 이용 가능 여부가 아니다 */
  async hasCredentials(): Promise<boolean> {
    return (await this.tokens.load()) !== null;
  }

  async entitlement(): Promise<Entitlement> {
    return readEntitlementResponse(await this.get(ROUTES.getMyEntitlement.path));
  }

  async devices(
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<DevicePage> {
    return readDevicePage(
      await this.get(
        ROUTES.listDevices.path,
        {},
        {
          cursor: options.cursor,
          limit: options.limit === undefined ? undefined : String(options.limit),
        },
      ),
    );
  }

  async releaseDevice(deviceId: string): Promise<DeviceRelease> {
    const key = this.ports.random.uuid();
    const res = await this.tokens.authed((bearer) =>
      this.api.send({
        method: "DELETE",
        url: this.api.url(ROUTES.releaseDevice.path, { deviceId }),
        bearer,
        idempotencyKey: key,
      }),
    );
    this.licenseSession?.noteLease(res.headers["x-lease-expires-at"]);
    return readDeviceRelease(res.json);
  }

  async profile(): Promise<Profile> {
    return readProfileResponse(await this.get(ROUTES.getProfile.path));
  }

  /** `update.status`가 `REQUIRED`면 업데이트 전까지 실행을 막는다. 받은 파일은 설치 전에 `verifyDownload` */
  async checkForUpdate(options: {
    readonly target: string;
    readonly currentVersion: string;
  }): Promise<UpdateCheck> {
    return readUpdateCheck(
      await this.get(
        ROUTES.getProductUpdates.path,
        { id: this.config.productId },
        {
          target: options.target,
          currentVersion: options.currentVersion,
        },
      ),
    );
  }

  async verifyDownload(data: Uint8Array<ArrayBuffer> | ArrayBuffer, sha256: string): Promise<void> {
    const actual = await sha256Hex(data);
    if (actual !== sha256.toLowerCase()) {
      throw sdkError("DOWNLOAD_INTEGRITY", "내려받은 파일의 SHA-256이 다르다 — 설치하지 않는다");
    }
  }

  /** 9절 — 앱이 기능 코드 여러 곳에서 다시 검증할 때 */
  async verifyToken(token: string): Promise<LicenseClaims> {
    return await this.verifier.verifyLicense(token);
  }

  async logout(): Promise<{ serverRevoked: boolean }> {
    this.login?.cancel();
    this.login = null;
    await this.licenseSession?.stop();
    return await this.tokens.logout();
  }

  session(): LicenseSession {
    if (this.licenseSession === null) {
      const device = this.config.device;
      if (device === undefined)
        throw sdkError("CONFIGURATION", "세션을 쓰려면 device { name, platform }을 준다");
      this.licenseSession = new LicenseSession({
        api: this.api,
        ports: this.ports,
        tokens: this.tokens,
        verifier: this.verifier,
        device,
        ...(this.config.app === undefined ? {} : { app: this.config.app }),
      });
    }
    return this.licenseSession;
  }

  private async get(
    path: string,
    params: Readonly<Record<string, string>> = {},
    query?: Readonly<Record<string, string | undefined>>,
  ): Promise<unknown> {
    const url = this.api.url(path, params, query);
    const res = await this.tokens.authed((bearer) => this.api.send({ method: "GET", url, bearer }));
    this.licenseSession?.noteLease(res.headers["x-lease-expires-at"]);
    return res.json;
  }
}
