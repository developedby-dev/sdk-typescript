import { sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import type {
  Clock,
  CredentialRecord,
  CredentialStore,
  FingerprintSource,
  HttpRequest,
  HttpResponse,
  Logger,
  Random,
  Scheduler,
  Transport,
} from "./ports.ts";

/** 명세 2절 — 런타임 공통 기본 구현(Node 24 · 브라우저 · 확장 · Electron). 운영체제별 저장소 · 지문 출처는 앱이 준다 */

/** 시스템 시계 — SDK에서 시계를 직접 읽는 유일한 곳 */
export const systemClock: Clock = {
  now: () => Date.now(),
};

export const timerScheduler: Scheduler = {
  schedule(delayMs, task) {
    const handle = setTimeout(() => {
      task().catch(() => undefined);
    }, delayMs);
    return () => clearTimeout(handle);
  },
};

export const cryptoRandom: Random = {
  float: () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 2 ** 32,
  uuid: () => crypto.randomUUID(),
};

export function fetchTransport(timeoutMs: number = RULES.http.timeoutSec * 1000): Transport {
  return {
    async send(request: HttpRequest): Promise<HttpResponse> {
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body === null ? {} : { body: request.body }),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw sdkError("NETWORK_ERROR", "API에 연결하지 못했다", { cause: error });
      }
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      let body: string;
      try {
        body = await response.text();
      } catch (error) {
        throw sdkError("NETWORK_ERROR", "응답을 끝까지 받지 못했다", { cause: error });
      }
      return { status: response.status, headers, body };
    },
  };
}

/** 메모리 저장소 — 앱을 끄면 로그인이 사라진다. 시험 · 짧은 CLI용 */
export function memoryCredentialStore(initial: CredentialRecord | null = null): CredentialStore {
  let record = initial;
  return {
    load: async () => record,
    save: async (next) => {
      record = next;
    },
    clear: async () => {
      record = null;
    },
  };
}

/** 지문 출처가 없음 — SDK가 실행 동안의 ID로 물러나고 경고한다(명세 10절) */
export const noFingerprint: FingerprintSource = { read: async () => null };

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};
