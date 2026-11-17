import type { Api } from "./api.ts";
import { base64urlDecode, fromUtf8, utf8 } from "./bytes.ts";
import { type BydevError, sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import {
  type AccessClaims,
  type LicenseClaims,
  readAccessClaims,
  readLicenseClaims,
} from "./models.ts";
import type { Ports } from "./ports.ts";
import { array, object } from "./read.ts";

/** 명세 9절 — licenseToken 검증 · JWKS 캐시 · 세대번호 단조 확인 */
interface KeySet {
  readonly keys: ReadonlyMap<string, CryptoKey>;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

export interface SessionExpectation {
  readonly sid: string;
  readonly deviceId: string;
  readonly generation: number;
}

function invalid(message: string): BydevError {
  return sdkError("TOKEN_INVALID", message);
}

export class TokenVerifier {
  private readonly api: Api;
  private readonly ports: Ports;
  private readonly clientId: string;
  private keySet: KeySet | null = null;
  private fetching: Promise<KeySet> | null = null;
  /** (sub, device_id) → 본 가장 큰 세대번호 */
  private readonly generations = new Map<string, number>();

  private readonly trackGenerations: boolean;

  constructor(
    api: Api,
    ports: Ports,
    clientId: string,
    options: { trackGenerations?: boolean } = {},
  ) {
    this.api = api;
    this.ports = ports;
    this.clientId = clientId;
    this.trackGenerations = options.trackGenerations ?? true;
  }

  /** 9절 1 ~ 4 — 서명된 JWT의 공통 검증. 페이로드를 돌려준다 */
  private async verifySigned(token: string, typ: "license+jwt" | "at+jwt"): Promise<unknown> {
    const parts = token.split(".");
    if (parts.length !== 3) throw invalid("JWT 형식이 아니다");
    const [head, body, sig] = parts as [string, string, string];
    let header: Record<string, unknown>;
    let payload: unknown;
    let signature: Uint8Array<ArrayBuffer>;
    try {
      header = object(JSON.parse(fromUtf8(base64urlDecode(head))), "header") as Record<
        string,
        unknown
      >;
      payload = JSON.parse(fromUtf8(base64urlDecode(body)));
      signature = base64urlDecode(sig);
    } catch {
      throw invalid("JWT를 읽지 못했다");
    }
    if (header.alg !== "EdDSA") throw invalid(`alg ${String(header.alg)}`);
    if (header.typ !== typ) throw invalid(`typ ${String(header.typ)}`);
    if (typeof header.kid !== "string") throw invalid("kid가 없다");
    const key = await this.keyFor(header.kid);
    const ok = await crypto.subtle.verify("Ed25519", key, signature, utf8(`${head}.${body}`));
    if (!ok) throw invalid("서명이 맞지 않는다");
    const claims = object(payload, "claims");
    const discovery = await this.api.discovery();
    if (claims.iss !== discovery.issuer) throw invalid("iss가 다르다");
    if (claims.aud !== this.clientId) throw invalid("aud가 이 client_id가 아니다");
    const nowSec = this.ports.clock.now() / 1000;
    if (typeof claims.exp !== "number" || claims.exp <= nowSec - RULES.token.clockLeewaySec) {
      throw invalid("만료된 토큰");
    }
    return payload;
  }

  /**
   * licenseToken — 세션 응답이면 `expect`로 세션과 대조한다. 세대번호: 클라이언트는 본 값을 메모리에 두고 비교하고(9절 6), 서버 도우미는 앱이 넘긴
   * `minGeneration`과 비교한다(12절)
   */
  async verifyLicense(
    token: string,
    expect?: SessionExpectation,
    minGeneration?: number,
  ): Promise<LicenseClaims> {
    const payload = await this.verifySigned(token, "license+jwt");
    let claims: LicenseClaims;
    try {
      claims = readLicenseClaims(payload);
    } catch {
      throw invalid("클레임 모양이 다르다");
    }
    if (expect !== undefined) {
      if (claims.sid !== expect.sid) throw invalid("sid가 세션과 다르다");
      if (claims.device_id !== expect.deviceId) throw invalid("device_id가 세션과 다르다");
      if (claims.generation !== expect.generation) throw invalid("generation이 세션과 다르다");
    }
    if (minGeneration !== undefined && claims.generation < minGeneration) {
      throw sdkError(
        "GENERATION_REGRESSED",
        `세대번호 ${claims.generation} < 이미 본 ${minGeneration}`,
      );
    }
    if (this.trackGenerations) {
      const slot = `${claims.sub}|${claims.device_id}`;
      const seen = this.generations.get(slot);
      if (seen !== undefined && claims.generation < seen) {
        throw sdkError("GENERATION_REGRESSED", `세대번호 ${claims.generation} < 이미 본 ${seen}`);
      }
      this.generations.set(slot, Math.max(seen ?? 0, claims.generation));
    }
    return claims;
  }

  /** 다시 이어 받은 세션(확장 서비스 워커 재시작)의 이미 본 세대번호를 심는다 — 메모리 기록이 사라져도 9절 6이 이어진다 */
  noteGeneration(claims: LicenseClaims): void {
    if (!this.trackGenerations) return;
    const slot = `${claims.sub}|${claims.device_id}`;
    this.generations.set(slot, Math.max(this.generations.get(slot) ?? 0, claims.generation));
  }

  /** access_token (`at+jwt`) — 판매자 서버가 앱이 보낸 토큰으로 사용자를 알아볼 때 */
  async verifyAccess(token: string): Promise<AccessClaims> {
    const payload = await this.verifySigned(token, "at+jwt");
    try {
      return readAccessClaims(payload);
    } catch {
      throw invalid("클레임 모양이 다르다");
    }
  }

  /** 9.1절 — 지난 캐시는 쓰지 않는다 · 모르는 kid는 1분에 한 번만 다시 받는다 */
  private async keyFor(kid: string): Promise<CryptoKey> {
    const now = this.ports.clock.now();
    let set = this.keySet;
    if (set === null || now >= set.expiresAt) set = await this.fetchKeys();
    let key = set.keys.get(kid);
    if (key !== undefined) return key;
    if (now - set.fetchedAt < RULES.jwks.unknownKidRefetchMinIntervalSec * 1000) {
      throw invalid(`모르는 kid ${kid}`);
    }
    set = await this.fetchKeys();
    key = set.keys.get(kid);
    if (key === undefined) throw invalid(`모르는 kid ${kid}`);
    return key;
  }

  private async fetchKeys(): Promise<KeySet> {
    if (this.fetching === null) {
      this.fetching = (async () => {
        const discovery = await this.api.discovery();
        const res = await this.api.send({ method: "GET", url: discovery.jwksUri });
        const keys = new Map<string, CryptoKey>();
        for (const value of array(object(res.json, "$").keys, "keys")) {
          if (value === null || typeof value !== "object") continue;
          const jwk = value as Record<string, unknown>;
          if (
            jwk.kty !== "OKP" ||
            jwk.crv !== "Ed25519" ||
            typeof jwk.kid !== "string" ||
            typeof jwk.x !== "string"
          )
            continue;
          try {
            keys.set(
              jwk.kid,
              await crypto.subtle.importKey(
                "jwk",
                { kty: "OKP", crv: "Ed25519", x: jwk.x },
                { name: "Ed25519" },
                false,
                ["verify"],
              ),
            );
          } catch {
            this.ports.logger.warn("JWKS 키를 읽지 못했다", { kid: jwk.kid });
          }
        }
        const fetchedAt = this.ports.clock.now();
        const maxAge = /max-age=(\d+)/.exec(res.headers["cache-control"] ?? "")?.[1];
        const ageSec = maxAge === undefined ? RULES.jwks.defaultMaxAgeSec : Number(maxAge);
        const set = { keys, fetchedAt, expiresAt: fetchedAt + ageSec * 1000 };
        this.keySet = set;
        return set;
      })().finally(() => {
        this.fetching = null;
      });
    }
    return await this.fetching;
  }
}
