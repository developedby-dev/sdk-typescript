import type {
  KnownDevicePlatform,
  KnownDistributionTarget,
  KnownEntitlementStatus,
  KnownInstallMode,
  KnownSubscriptionStatus,
  KnownUpdateCoverageType,
  KnownUpdateStatus,
} from "./generated.ts";
import { array, boolean, enumValue, integer, nullable, object, string } from "./read.ts";

/**
 * 공개 API 응답의 SDK 모델 — 모양은 contracts와 같고(필드 이름 그대로), 모르는 필드는 버리며 모르는 열거 값은 문자열로 둔다(명세 0절 5)
 */
type Open<K extends string> = K | (string & {});

export type EntitlementTerm =
  | {
      readonly type: "DURATION";
      readonly expiresAt: string;
      readonly remainingDays: number;
      readonly remainingSeconds: number;
    }
  | {
      readonly type: "PERPETUAL";
      readonly expiresAt: null;
      readonly remainingDays: null;
      readonly remainingSeconds: null;
    }
  /** 앞으로 늘 수 있는 기간 유형 — `type`을 먼저 분기한다 */
  | {
      readonly type: string & {};
      readonly expiresAt: string | null;
      readonly remainingDays: number | null;
      readonly remainingSeconds: number | null;
    };

export interface EntitlementSubscription {
  readonly id: string;
  readonly status: Open<KnownSubscriptionStatus>;
  readonly willRenew: boolean;
  readonly nextBillingAt: string | null;
  readonly graceEndsAt: string | null;
}

export interface LicensePolicy {
  readonly maxDevices: number;
  readonly maxConcurrent: number;
  readonly heartbeatSec: number;
  readonly offlineGraceHours: number;
}

/**
 * 업데이트 제공 범위 (ADR-0049) — `type`을 먼저 분기한다. `UNTIL`이면 `until` 전에 출시된 버전을 실행할 수 있다. 모르는 `type`은 문자열 그대로 둔다
 */
export type UpdateCoverage =
  | { readonly type: "ALL" }
  | { readonly type: "UNTIL"; readonly until: string }
  | { readonly type: Exclude<string, KnownUpdateCoverageType> & {} };

export interface Entitlement {
  readonly id: string;
  readonly productId: string;
  readonly status: Open<KnownEntitlementStatus>;
  readonly term: EntitlementTerm;
  readonly updateCoverage: UpdateCoverage;
  readonly subscription: EntitlementSubscription | null;
  readonly policy: LicensePolicy;
  readonly evaluatedAt: string;
}

export function readEntitlementResponse(json: unknown): Entitlement {
  const e = object(object(json, "$").entitlement, "entitlement");
  const t = object(e.term, "entitlement.term");
  const type = string(t.type, "entitlement.term.type");
  const term =
    type === "PERPETUAL"
      ? { type, expiresAt: null, remainingDays: null, remainingSeconds: null }
      : {
          type,
          expiresAt: nullable(t.expiresAt, "entitlement.term.expiresAt", string),
          remainingDays: nullable(t.remainingDays, "entitlement.term.remainingDays", integer),
          remainingSeconds: nullable(
            t.remainingSeconds,
            "entitlement.term.remainingSeconds",
            integer,
          ),
        };
  const p = object(e.policy, "entitlement.policy");
  const c = object(e.updateCoverage, "entitlement.updateCoverage");
  const coverageType = string(c.type, "entitlement.updateCoverage.type");
  const updateCoverage =
    coverageType === "ALL"
      ? { type: coverageType }
      : coverageType === "UNTIL"
        ? { type: coverageType, until: string(c.until, "entitlement.updateCoverage.until") }
        : { type: coverageType };
  return {
    id: string(e.id, "entitlement.id"),
    productId: string(e.productId, "entitlement.productId"),
    status: enumValue<KnownEntitlementStatus>(e.status, "entitlement.status"),
    term: term as EntitlementTerm,
    updateCoverage: updateCoverage as UpdateCoverage,
    subscription: nullable(e.subscription, "entitlement.subscription", (v, path) => {
      const s = object(v, path);
      return {
        id: string(s.id, `${path}.id`),
        status: enumValue<KnownSubscriptionStatus>(s.status, `${path}.status`),
        willRenew: boolean(s.willRenew, `${path}.willRenew`),
        nextBillingAt: nullable(s.nextBillingAt, `${path}.nextBillingAt`, string),
        graceEndsAt: nullable(s.graceEndsAt, `${path}.graceEndsAt`, string),
      };
    }),
    policy: {
      maxDevices: integer(p.maxDevices, "entitlement.policy.maxDevices"),
      maxConcurrent: integer(p.maxConcurrent, "entitlement.policy.maxConcurrent"),
      heartbeatSec: integer(p.heartbeatSec, "entitlement.policy.heartbeatSec"),
      offlineGraceHours: integer(p.offlineGraceHours, "entitlement.policy.offlineGraceHours"),
    },
    evaluatedAt: string(e.evaluatedAt, "entitlement.evaluatedAt"),
  };
}

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly platform: Open<KnownDevicePlatform>;
  readonly registeredAt: string;
  readonly lastSeenAt: string;
}

export interface DevicePage {
  readonly items: readonly Device[];
  readonly nextCursor: string | null;
}

export function readDevicePage(json: unknown): DevicePage {
  const page = object(json, "$");
  return {
    items: array(page.items, "items").map((v, i) => {
      const d = object(v, `items[${i}]`);
      return {
        id: string(d.id, `items[${i}].id`),
        name: string(d.name, `items[${i}].name`),
        platform: enumValue<KnownDevicePlatform>(d.platform, `items[${i}].platform`),
        registeredAt: string(d.registeredAt, `items[${i}].registeredAt`),
        lastSeenAt: string(d.lastSeenAt, `items[${i}].lastSeenAt`),
      };
    }),
    nextCursor: nullable(page.nextCursor, "nextCursor", string),
  };
}

export interface DeviceRelease {
  readonly id: string;
  readonly status: string;
  readonly releasedAt: string;
}

export function readDeviceRelease(json: unknown): DeviceRelease {
  const d = object(object(json, "$").device, "device");
  return {
    id: string(d.id, "device.id"),
    status: string(d.status, "device.status"),
    releasedAt: string(d.releasedAt, "device.releasedAt"),
  };
}

export interface Profile {
  readonly pseudonymousId: string;
  readonly nickname: string;
  readonly email: string | null;
}

export function readProfileResponse(json: unknown): Profile {
  const p = object(object(json, "$").profile, "profile");
  return {
    pseudonymousId: string(p.pseudonymousId, "profile.pseudonymousId"),
    nickname: string(p.nickname, "profile.nickname"),
    email: nullable(p.email, "profile.email", string),
  };
}

export type ProductInstall =
  | {
      readonly mode: "HOSTED";
      readonly buildId: string;
      readonly downloadUrl: string;
      readonly downloadUrlExpiresAt: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    }
  | {
      readonly mode: "EXTERNAL";
      readonly channels: readonly { readonly channel: string; readonly locator: string }[];
    }
  /** 앞으로 늘 수 있는 방식 — 이 SDK가 모르는 방식이면 설치 안내를 하지 않는다 */
  | { readonly mode: Exclude<string, KnownInstallMode> & {} };

/** 최신 버전 · 업데이트 판정 · 설치 방법 — 업데이트 확인의 최상위와 `entitled.release`가 같은 모양이다 */
export interface UpdateRelease {
  readonly latest: {
    readonly version: string;
    readonly releasedAt: string;
    readonly notes: string | null;
  };
  readonly update: { readonly status: Open<KnownUpdateStatus> };
  readonly install: ProductInstall;
}

/**
 * 업데이트 제공 기한이 있는 구매자에게만 오는 값 (ADR-0049 4절). 있으면 앱은 최상위 대신 `release`를 따른다 — 최상위 최신은 그 구매자가 실행할 수
 * 없는 버전일 수 있다. 이 대상에 범위 안 버전이 없으면 `release`는 null
 */
export interface EntitledUpdate {
  readonly coveredUntil: string;
  readonly release: UpdateRelease | null;
}

export interface UpdateCheck extends UpdateRelease {
  readonly product: { readonly id: string };
  readonly target: Open<KnownDistributionTarget>;
  /** 업데이트 제공 기한이 있는 구매자에게만 */
  readonly entitled?: EntitledUpdate;
}

function readInstall(json: unknown, path: string): ProductInstall {
  const install = object(json, path);
  const mode = string(install.mode, `${path}.mode`);
  if (mode === "HOSTED") {
    return {
      mode,
      buildId: string(install.buildId, `${path}.buildId`),
      downloadUrl: string(install.downloadUrl, `${path}.downloadUrl`),
      downloadUrlExpiresAt: string(install.downloadUrlExpiresAt, `${path}.downloadUrlExpiresAt`),
      sha256: string(install.sha256, `${path}.sha256`),
      sizeBytes: integer(install.sizeBytes, `${path}.sizeBytes`),
    };
  }
  if (mode === "EXTERNAL") {
    return {
      mode,
      channels: array(install.channels, `${path}.channels`).map((v, i) => {
        const c = object(v, `${path}.channels[${i}]`);
        return {
          channel: string(c.channel, `${path}.channels[${i}].channel`),
          locator: string(c.locator, `${path}.channels[${i}].locator`),
        };
      }),
    };
  }
  return { mode } as ProductInstall;
}

function readRelease(r: Record<string, unknown>, prefix: string): UpdateRelease {
  const latest = object(r.latest, `${prefix}latest`);
  return {
    latest: {
      version: string(latest.version, `${prefix}latest.version`),
      releasedAt: string(latest.releasedAt, `${prefix}latest.releasedAt`),
      notes: nullable(latest.notes, `${prefix}latest.notes`, string),
    },
    update: {
      status: enumValue<KnownUpdateStatus>(
        object(r.update, `${prefix}update`).status,
        `${prefix}update.status`,
      ),
    },
    install: readInstall(r.install, `${prefix}install`),
  };
}

export function readUpdateCheck(json: unknown): UpdateCheck {
  const r = object(json, "$");
  const entitled =
    r.entitled === undefined || r.entitled === null
      ? undefined
      : (() => {
          const e = object(r.entitled, "entitled");
          return {
            coveredUntil: string(e.coveredUntil, "entitled.coveredUntil"),
            release: nullable(e.release, "entitled.release", (v, path) =>
              readRelease(object(v, path), `${path}.`),
            ),
          };
        })();
  return {
    product: { id: string(object(r.product, "product").id, "product.id") },
    target: enumValue<KnownDistributionTarget>(r.target, "target"),
    ...readRelease(r, ""),
    ...(entitled === undefined ? {} : { entitled }),
  };
}

export interface TokenSet {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly scope: string;
}

export function readTokenResponse(json: unknown): TokenSet {
  const t = object(json, "$");
  return {
    accessToken: string(t.access_token, "access_token"),
    expiresIn: integer(t.expires_in, "expires_in"),
    refreshToken: string(t.refresh_token, "refresh_token"),
    scope: string(t.scope, "scope"),
  };
}

export interface DeviceCode {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export function readDeviceCode(json: unknown): DeviceCode {
  const d = object(json, "$");
  return {
    deviceCode: string(d.device_code, "device_code"),
    userCode: string(d.user_code, "user_code"),
    verificationUri: string(d.verification_uri, "verification_uri"),
    verificationUriComplete: string(d.verification_uri_complete, "verification_uri_complete"),
    expiresIn: integer(d.expires_in, "expires_in"),
    interval: integer(d.interval, "interval"),
  };
}

export interface SessionInfo {
  readonly id: string;
  readonly productId: string;
  readonly deviceId: string;
  readonly generation: number;
  readonly leaseExpiresAt: string;
  readonly heartbeatSec: number;
}

export interface LicenseTokenInfo {
  readonly token: string;
  readonly expiresAt: string;
}

export function readSessionResponse(json: unknown): {
  session: SessionInfo;
  licenseToken: LicenseTokenInfo;
} {
  const r = object(json, "$");
  const s = object(r.session, "session");
  const t = object(r.licenseToken, "licenseToken");
  return {
    session: {
      id: string(s.id, "session.id"),
      productId: string(s.productId, "session.productId"),
      deviceId: string(s.deviceId, "session.deviceId"),
      generation: integer(s.generation, "session.generation"),
      leaseExpiresAt: string(s.leaseExpiresAt, "session.leaseExpiresAt"),
      heartbeatSec: integer(s.heartbeatSec, "session.heartbeatSec"),
    },
    licenseToken: {
      token: string(t.token, "licenseToken.token"),
      expiresAt: string(t.expiresAt, "licenseToken.expiresAt"),
    },
  };
}

export interface Discovery {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly deviceAuthorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint: string;
}

export function readDiscovery(json: unknown): Discovery {
  const d = object(json, "$");
  return {
    issuer: string(d.issuer, "issuer"),
    jwksUri: string(d.jwks_uri, "jwks_uri"),
    deviceAuthorizationEndpoint: string(
      d.device_authorization_endpoint,
      "device_authorization_endpoint",
    ),
    tokenEndpoint: string(d.token_endpoint, "token_endpoint"),
    revocationEndpoint: string(d.revocation_endpoint, "revocation_endpoint"),
  };
}

/** 명세 9절 — 검증된 licenseToken 클레임 */
export interface LicenseClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly product_id: string;
  readonly device_id: string;
  readonly sid: string;
  readonly generation: number;
  readonly iat: number;
  readonly exp: number;
  /** 세션을 얻을 때 앱이 보낸 대상 · 버전으로 서버가 확정한 빌드 (ADR-0049). 확정하지 못했으면 없다 */
  readonly build_id?: string;
}

export function readLicenseClaims(json: unknown): LicenseClaims {
  const c = object(json, "claims");
  return {
    iss: string(c.iss, "claims.iss"),
    sub: string(c.sub, "claims.sub"),
    aud: string(c.aud, "claims.aud"),
    product_id: string(c.product_id, "claims.product_id"),
    device_id: string(c.device_id, "claims.device_id"),
    sid: string(c.sid, "claims.sid"),
    generation: integer(c.generation, "claims.generation"),
    iat: integer(c.iat, "claims.iat"),
    exp: integer(c.exp, "claims.exp"),
    ...(c.build_id === undefined || c.build_id === null
      ? {}
      : { build_id: string(c.build_id, "claims.build_id") }),
  };
}

/** 12절 — 검증된 access_token 클레임 */
export interface AccessClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly client_id: string;
  readonly scope: string;
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
}

export function readAccessClaims(json: unknown): AccessClaims {
  const c = object(json, "claims");
  return {
    iss: string(c.iss, "claims.iss"),
    sub: string(c.sub, "claims.sub"),
    aud: string(c.aud, "claims.aud"),
    client_id: string(c.client_id, "claims.client_id"),
    scope: string(c.scope, "claims.scope"),
    iat: integer(c.iat, "claims.iat"),
    exp: integer(c.exp, "claims.exp"),
    jti: string(c.jti, "claims.jti"),
  };
}
