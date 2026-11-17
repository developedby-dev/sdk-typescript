import { Api } from "./api.ts";
import { utf8 } from "./bytes.ts";
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
import { RULES } from "./generated.ts";
import type { AccessClaims, LicenseClaims } from "./models.ts";
import type { Clock, Ports, Transport } from "./ports.ts";
import { TokenVerifier } from "./verify.ts";

/**
 * 명세 12절 — 판매자 서버의 도우미. 웹훅 서명 검증과 토큰 검증. 앱 쪽 클라이언트와 상태를 나누지 않는다. 런타임 공통(WebCrypto) — Node · Deno ·
 * Cloudflare Workers에서 돈다
 */

function base64Decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 상수 시간 비교 — 길이가 다르면 바로 거짓(길이는 비밀이 아니다) */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function header(
  headers: Headers | Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name);
  const record = headers as Readonly<Record<string, string | string[] | undefined>>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export interface WebhookVerification {
  readonly id: string;
  readonly timestamp: number;
}

/**
 * 웹훅 서명 검증 (안내서 11장 · Standard Webhooks v1). `rawBody`는 받은 그대로의 본문이다 — JSON을 파싱했다가 다시 만든 문자열은 바이트가 달라
 * 서명이 맞지 않는다. 시크릿을 교체하는 중이면 둘 다 넘긴다
 */
export async function verifyWebhook(options: {
  readonly secrets: string | readonly string[];
  readonly headers: Headers | Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: string | Uint8Array;
  readonly clock?: Clock;
}): Promise<WebhookVerification> {
  const id = header(options.headers, "webhook-id");
  const timestamp = header(options.headers, "webhook-timestamp");
  const signatures = header(options.headers, "webhook-signature");
  if (id === null || timestamp === null || signatures === null) {
    throw sdkError(
      "WEBHOOK_INVALID",
      "웹훅 헤더(webhook-id · webhook-timestamp · webhook-signature)가 없다",
    );
  }
  const sent = Number(timestamp);
  const nowSec = (options.clock ?? systemClock).now() / 1000;
  if (!/^\d+$/.test(timestamp) || Math.abs(nowSec - sent) > RULES.webhook.toleranceSec) {
    throw sdkError("WEBHOOK_INVALID", "웹훅 시각이 허용 범위 밖이다 — 재전송 공격일 수 있다");
  }
  const body =
    typeof options.rawBody === "string"
      ? options.rawBody
      : new TextDecoder().decode(options.rawBody);
  const signed = utf8(`${id}.${timestamp}.${body}`);
  const candidates = signatures
    .split(" ")
    .map((entry) => entry.split(","))
    .filter(
      ([version, value]) =>
        version === RULES.webhook.signatureVersion && value !== undefined && value !== "",
    )
    .map(([, value]) => {
      try {
        return base64Decode(value as string);
      } catch {
        return null;
      }
    })
    .filter((v): v is Uint8Array<ArrayBuffer> => v !== null);
  const secrets = typeof options.secrets === "string" ? [options.secrets] : options.secrets;
  for (const secret of secrets) {
    if (!secret.startsWith(RULES.webhook.secretPrefix)) {
      throw sdkError("CONFIGURATION", `웹훅 시크릿은 ${RULES.webhook.secretPrefix}로 시작한다`);
    }
    const key = await crypto.subtle.importKey(
      "raw",
      base64Decode(secret.slice(RULES.webhook.secretPrefix.length)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
    if (candidates.some((candidate) => timingSafeEqual(candidate, expected)))
      return { id, timestamp: sent };
  }
  throw sdkError("WEBHOOK_INVALID", "웹훅 서명이 맞지 않는다");
}

export interface ServerVerifier {
  verifyAccessToken(token: string): Promise<AccessClaims>;
  /** `minGeneration` — 같은 sub · device_id에서 이미 본 가장 큰 세대번호(판매자 서버가 보관한 값) */
  verifyLicenseToken(
    token: string,
    options?: { readonly minGeneration?: number },
  ): Promise<LicenseClaims>;
}

/** 토큰 검증 (안내서 09장) — JWKS를 받아 캐시하고(9.1절) 서명 · typ · iss · aud · exp를 본다 */
export function createServerVerifier(config: {
  readonly baseUrl: string;
  readonly clientId: string;
  readonly transport?: Transport;
  readonly clock?: Clock;
}): ServerVerifier {
  const ports: Ports = {
    transport: config.transport ?? fetchTransport(),
    store: memoryCredentialStore(),
    clock: config.clock ?? systemClock,
    scheduler: timerScheduler,
    random: cryptoRandom,
    fingerprint: noFingerprint,
    logger: silentLogger,
  };
  const verifier = new TokenVerifier(new Api(config.baseUrl, ports), ports, config.clientId, {
    trackGenerations: false,
  });
  return {
    verifyAccessToken: (token) => verifier.verifyAccess(token),
    verifyLicenseToken: (token, options = {}) =>
      verifier.verifyLicense(token, undefined, options.minGeneration),
  };
}
