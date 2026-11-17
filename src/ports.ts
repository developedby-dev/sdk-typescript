/**
 * 명세 2절 — 바꿔 끼울 수 있는 포트. 주지 않으면 그 런타임의 기본 구현을 쓴다. SDK 안에서 시계 · 타이머 · 난수를 직접 읽지 않는다 —
 * 모두 이 포트를 거친다(적합성 시험이 가상 시계로 몬다)
 */
export interface HttpRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export interface HttpResponse {
  readonly status: number;
  /** 이름은 소문자 */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** 연결 실패 · 시간 초과는 `NETWORK_ERROR` BydevError로 던진다. 3xx를 따라가지 않는다 */
export interface Transport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** 명세 3.6 — 보안 저장소에 두는 기록. access_token은 두지 않는다 */
export interface CredentialRecord {
  readonly version: 1;
  readonly refreshToken: string;
  readonly scope: string;
  readonly savedAt: string;
}

export interface CredentialStore {
  load(): Promise<CredentialRecord | null>;
  save(record: CredentialRecord): Promise<void>;
  clear(): Promise<void>;
}

export interface Clock {
  /** Unix 밀리초 */
  now(): number;
}

/** 취소 함수를 돌려준다. 작업은 비동기이고, 스케줄러는 작업이 끝날 때까지 기다릴 수 있다 */
export interface Scheduler {
  schedule(delayMs: number, task: () => Promise<void>): () => void;
}

export interface Random {
  /** [0, 1) */
  float(): number;
  /** UUID v4 */
  uuid(): string;
}

/** 운영체제의 기기 식별자 — 원본은 SDK 밖으로 나가지 않는다(해시만, 명세 10절) */
export interface FingerprintSource {
  read(): Promise<string | null>;
}

/** 토큰 · 지문 출처 값을 넘기지 않는다 */
export interface Logger {
  debug(message: string, data?: Readonly<Record<string, unknown>>): void;
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface Ports {
  readonly transport: Transport;
  readonly store: CredentialStore;
  readonly clock: Clock;
  readonly scheduler: Scheduler;
  readonly random: Random;
  readonly fingerprint: FingerprintSource;
  readonly logger: Logger;
}
