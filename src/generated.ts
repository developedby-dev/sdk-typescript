// 생성된 파일 — 고치지 않는다. 원천: packages/contracts · sdks/spec/rules.json
// 다시 만들기: pnpm --filter @bydev/sdk-codegen generate

export const SPEC_VERSION = "1.2.0";

/** RFC 8628 디바이스 코드 grant_type */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** contracts ERROR_CODES — 분기는 이 값으로 한다 */
export const API_ERROR_CODES = [
  "INVALID_CLIENT",
  "AUTHORIZATION_PENDING",
  "SLOW_DOWN",
  "EXPIRED_TOKEN",
  "INVALID_GRANT",
  "SCOPE_INSUFFICIENT",
  "ENTITLEMENT_NOT_FOUND",
  "ENTITLEMENT_EXPIRED",
  "ENTITLEMENT_REVOKED",
  "ENTITLEMENT_SUSPENDED",
  "DEVICE_IN_USE",
  "INSTANCE_ALREADY_RUNNING",
  "DEVICE_LIMIT_EXCEEDED",
  "SESSION_REVOKED",
  "SESSION_SUPERSEDED",
  "TAKEOVER_LIMIT_EXCEEDED",
  "DEVICE_NOT_FOUND",
  "DEVICE_RELEASE_LIMIT_EXCEEDED",
  "PRODUCT_NOT_FOUND",
  "PRODUCT_SUSPENDED",
  "RATE_LIMITED",
  "IDEMPOTENCY_KEY_CONFLICT",
  "VALIDATION_FAILED",
  "TEST_MODE_ONLY",
  "INTERNAL_ERROR",
  "ENTITLEMENT_VERSION_NOT_COVERED",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  INVALID_CLIENT: 401,
  AUTHORIZATION_PENDING: 400,
  SLOW_DOWN: 400,
  EXPIRED_TOKEN: 401,
  INVALID_GRANT: 400,
  SCOPE_INSUFFICIENT: 403,
  ENTITLEMENT_NOT_FOUND: 404,
  ENTITLEMENT_EXPIRED: 403,
  ENTITLEMENT_REVOKED: 403,
  ENTITLEMENT_SUSPENDED: 403,
  DEVICE_IN_USE: 409,
  INSTANCE_ALREADY_RUNNING: 409,
  DEVICE_LIMIT_EXCEEDED: 409,
  SESSION_REVOKED: 401,
  SESSION_SUPERSEDED: 401,
  TAKEOVER_LIMIT_EXCEEDED: 429,
  DEVICE_NOT_FOUND: 404,
  DEVICE_RELEASE_LIMIT_EXCEEDED: 429,
  PRODUCT_NOT_FOUND: 404,
  PRODUCT_SUSPENDED: 403,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  VALIDATION_FAILED: 400,
  TEST_MODE_ONLY: 403,
  INTERNAL_ERROR: 500,
  ENTITLEMENT_VERSION_NOT_COVERED: 403,
};

/** 명세 3.3 — SDK가 만드는 에러 코드 */
export const SDK_ERROR_CODES = [
  "NETWORK_ERROR",
  "PROTOCOL_ERROR",
  "STORAGE_FAILED",
  "NOT_SIGNED_IN",
  "TOKEN_INVALID",
  "GENERATION_REGRESSED",
  "OFFLINE_EXPIRED",
  "DOWNLOAD_INTEGRITY",
  "LOGIN_CANCELLED",
  "CONFIGURATION",
  "WEBHOOK_INVALID",
] as const;
export type SdkErrorCode = (typeof SDK_ERROR_CODES)[number];

export const ENTITLEMENT_STATUS_VALUES = ["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED"] as const;
export type KnownEntitlementStatus = (typeof ENTITLEMENT_STATUS_VALUES)[number];

export const SUBSCRIPTION_STATUS_VALUES = [
  "ACTIVE",
  "PAST_DUE",
  "CANCEL_SCHEDULED",
  "UNPAID",
  "EXPIRED",
] as const;
export type KnownSubscriptionStatus = (typeof SUBSCRIPTION_STATUS_VALUES)[number];

export const GRANT_TYPE_VALUES = [
  "PURCHASE",
  "RENEWAL",
  "TRIAL",
  "COMPENSATION",
  "MANUAL",
  "TEST",
] as const;
export type KnownGrantType = (typeof GRANT_TYPE_VALUES)[number];

export const UPDATE_STATUS_VALUES = ["UP_TO_DATE", "AVAILABLE", "REQUIRED"] as const;
export type KnownUpdateStatus = (typeof UPDATE_STATUS_VALUES)[number];

export const INSTALL_MODE_VALUES = ["HOSTED", "EXTERNAL"] as const;
export type KnownInstallMode = (typeof INSTALL_MODE_VALUES)[number];

export const UPDATE_COVERAGE_TYPE_VALUES = ["ALL", "UNTIL"] as const;
export type KnownUpdateCoverageType = (typeof UPDATE_COVERAGE_TYPE_VALUES)[number];

export const DISTRIBUTION_TARGET_VALUES = [
  "WINDOWS_X64",
  "WINDOWS_ARM64",
  "MACOS_UNIVERSAL",
  "MACOS_ARM64",
  "MACOS_X64",
  "LINUX_X64",
  "LINUX_ARM64",
  "BROWSER_EXTENSION",
  "ANDROID",
  "IOS",
  "SOURCE_ARCHIVE",
] as const;
export type KnownDistributionTarget = (typeof DISTRIBUTION_TARGET_VALUES)[number];

export const DEVICE_PLATFORM_VALUES = [
  "WINDOWS",
  "MACOS",
  "LINUX",
  "ANDROID",
  "IOS",
  "OTHER",
] as const;
export type KnownDevicePlatform = (typeof DEVICE_PLATFORM_VALUES)[number];

export const SCOPE_VALUES = [
  "entitlement.read",
  "session.write",
  "device.manage",
  "profile.read",
  "profile.email",
  "version.read",
] as const;
export type KnownScope = (typeof SCOPE_VALUES)[number];

export const SESSION_STATE_TYPE_VALUES = [
  "Starting",
  "Active",
  "Degraded",
  "NeedsDecision",
  "Locked",
  "Stopped",
] as const;
export type KnownSessionStateType = (typeof SESSION_STATE_TYPE_VALUES)[number];

export const NEEDS_DECISION_REASON_VALUES = [
  "DEVICE_IN_USE",
  "INSTANCE_ALREADY_RUNNING",
  "DEVICE_LIMIT_EXCEEDED",
] as const;
export type KnownNeedsDecisionReason = (typeof NEEDS_DECISION_REASON_VALUES)[number];

/** 공개 API 경로 (contracts routes) */
export const ROUTES = {
  acquireSession: { method: "POST", path: "/v1/sessions" },
  exchangeToken: { method: "POST", path: "/v1/oauth/token" },
  getJwks: { method: "GET", path: "/.well-known/jwks.json" },
  getLatestRelease: { method: "GET", path: "/v1/products/{id}/latest" },
  getMyEntitlement: { method: "GET", path: "/v1/entitlements/me" },
  getOpenIdConfiguration: { method: "GET", path: "/.well-known/openid-configuration" },
  getProductUpdates: { method: "GET", path: "/v1/products/{id}/updates" },
  getProfile: { method: "GET", path: "/v1/profile" },
  heartbeatSession: { method: "POST", path: "/v1/sessions/{sid}/heartbeat" },
  issueDeviceCode: { method: "POST", path: "/v1/oauth/device_code" },
  listDevices: { method: "GET", path: "/v1/devices" },
  releaseDevice: { method: "DELETE", path: "/v1/devices/{deviceId}" },
  releaseSession: { method: "DELETE", path: "/v1/sessions/{sid}" },
  revokeToken: { method: "POST", path: "/v1/oauth/revoke" },
} as const;

/** sdks/spec/rules.json */
export const RULES = {
  specVersion: "1.2.0",
  api: "v1",
  userAgent: {
    languages: ["typescript", "dotnet", "swift", "kotlin", "python", "go", "rust", "c"],
    pattern:
      "^bydev-(typescript|dotnet|swift|kotlin|python|go|rust|c)/[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?( .+)?$",
  },
  http: {
    timeoutSec: 30,
  },
  login: {
    pollJitter: {
      min: 1,
      max: 1.15,
    },
    slowDownIncrementSec: 5,
  },
  token: {
    refreshSkewSec: 60,
    refreshRetryDelaysSec: [1, 3, 7],
    clockLeewaySec: 60,
  },
  session: {
    heartbeatJitter: {
      min: 0.85,
      max: 1.15,
    },
    startRetryDelaysSec: [2, 5, 10, 30, 60],
  },
  jwks: {
    defaultMaxAgeSec: 300,
    unknownKidRefetchMinIntervalSec: 60,
  },
  fingerprint: {
    algorithm: "SHA-256",
    salt: "bydev-device-v1",
    encoding: "hex-lower",
    sourceReadAttempts: 3,
    sourceReadRetryDelayMs: 300,
  },
  storage: {
    service: "dev.developedby.sdk",
    recordVersion: 1,
  },
  transient: {
    codes: ["NETWORK_ERROR", "RATE_LIMITED", "INTERNAL_ERROR"],
    unknownCodeStatuses: [429],
    unknownCodeStatusRanges: [[500, 599]],
  },
  webhook: {
    signatureVersion: "v1",
    secretPrefix: "whsec_",
    toleranceSec: 300,
  },
  sdkErrorCodes: [
    "NETWORK_ERROR",
    "PROTOCOL_ERROR",
    "STORAGE_FAILED",
    "NOT_SIGNED_IN",
    "TOKEN_INVALID",
    "GENERATION_REGRESSED",
    "OFFLINE_EXPIRED",
    "DOWNLOAD_INTEGRITY",
    "LOGIN_CANCELLED",
    "CONFIGURATION",
    "WEBHOOK_INVALID",
  ],
  sessionStates: ["Starting", "Active", "Degraded", "NeedsDecision", "Locked", "Stopped"],
  needsDecisionReasons: ["DEVICE_IN_USE", "INSTANCE_ALREADY_RUNNING", "DEVICE_LIMIT_EXCEEDED"],
} as const;
