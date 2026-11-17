import { BydevError, sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import { type Discovery, readDiscovery } from "./models.ts";
import type { HttpRequest, HttpResponse, Ports } from "./ports.ts";
import { object } from "./read.ts";
import { SDK_VERSION } from "./version.ts";

/** 명세 3 · 4절 — 요청 만들기 · 응답 읽기 · 발견 문서 */
export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly json: unknown;
}

export interface RequestOptions {
  readonly method: HttpRequest["method"];
  readonly url: string;
  readonly body?: unknown;
  readonly bearer?: string;
  readonly idempotencyKey?: string;
}

export const USER_AGENT = `bydev-typescript/${SDK_VERSION}`;

export class Api {
  readonly baseUrl: string;
  private readonly ports: Ports;
  private discovered: Discovery | null = null;
  private discovering: Promise<Discovery> | null = null;

  constructor(baseUrl: string, ports: Ports) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ports = ports;
  }

  url(
    path: string,
    params: Readonly<Record<string, string>> = {},
    query?: Readonly<Record<string, string | undefined>>,
  ): string {
    const filled = path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      const value = params[name];
      if (value === undefined) throw sdkError("CONFIGURATION", `경로 변수 ${name}가 없다`);
      return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) search.set(k, v);
    const qs = search.toString();
    return `${this.baseUrl}${filled}${qs === "" ? "" : `?${qs}`}`;
  }

  /** 4절 — 처음 한 번 받아 클라이언트 수명 동안 둔다. 실패하면 두지 않는다 */
  async discovery(): Promise<Discovery> {
    if (this.discovered !== null) return this.discovered;
    if (this.discovering === null) {
      this.discovering = (async () => {
        const res = await this.send({
          method: "GET",
          url: `${this.baseUrl}/.well-known/openid-configuration`,
        });
        const doc = readDiscovery(res.json);
        if (doc.issuer.replace(/\/+$/, "") !== this.baseUrl) {
          throw sdkError(
            "CONFIGURATION",
            `발견 문서의 issuer(${doc.issuer})가 baseUrl(${this.baseUrl})과 다르다`,
          );
        }
        this.discovered = doc;
        return doc;
      })().finally(() => {
        this.discovering = null;
      });
    }
    return await this.discovering;
  }

  async send(options: RequestOptions): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": USER_AGENT,
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.bearer !== undefined) headers.authorization = `Bearer ${options.bearer}`;
    if (options.idempotencyKey !== undefined) headers["idempotency-key"] = options.idempotencyKey;
    let response: HttpResponse;
    try {
      response = await this.ports.transport.send({
        method: options.method,
        url: options.url,
        headers,
        body: options.body === undefined ? null : JSON.stringify(options.body),
      });
    } catch (error) {
      if (error instanceof BydevError) throw error;
      throw sdkError("NETWORK_ERROR", "API에 연결하지 못했다", { cause: error });
    }
    const correlationId = response.headers["x-correlation-id"] ?? null;
    let json: unknown = null;
    let parsed = false;
    if (response.body !== "") {
      try {
        json = JSON.parse(response.body);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (response.status >= 200 && response.status < 300) {
      if (!parsed)
        throw sdkError("PROTOCOL_ERROR", "응답 본문이 JSON이 아니다", {
          httpStatus: response.status,
          correlationId,
        });
      return { status: response.status, headers: response.headers, json };
    }
    throw errorFrom(response, parsed ? json : null, correlationId);
  }
}

/** 3.2절 — 실패 응답 → BydevError */
function errorFrom(
  response: HttpResponse,
  json: unknown,
  correlationId: string | null,
): BydevError {
  const retryHeader = Number(response.headers["retry-after"]);
  const headerRetry = Number.isInteger(retryHeader) && retryHeader > 0 ? retryHeader : null;
  try {
    const e = object(json, "$");
    if (typeof e.code === "string" && typeof e.message === "string") {
      const retryAfterSec = typeof e.retryAfterSec === "number" ? e.retryAfterSec : headerRetry;
      const details =
        e.details !== null && typeof e.details === "object" && !Array.isArray(e.details)
          ? (e.details as Record<string, unknown>)
          : null;
      return new BydevError(e.code, e.message, {
        httpStatus: response.status,
        correlationId,
        retryAfterSec,
        details,
      });
    }
  } catch {
    // 아래로
  }
  const code =
    response.status >= 500
      ? "INTERNAL_ERROR"
      : response.status === 429
        ? "RATE_LIMITED"
        : "PROTOCOL_ERROR";
  return new BydevError(code, `HTTP ${response.status}`, {
    httpStatus: response.status,
    correlationId,
    retryAfterSec: headerRetry,
  });
}

export const TIMEOUT_MS = RULES.http.timeoutSec * 1000;
