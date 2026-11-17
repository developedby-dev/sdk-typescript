import {
  API_ERROR_CODES,
  type ApiErrorCode,
  RULES,
  SDK_ERROR_CODES,
  type SdkErrorCode,
} from "./generated.ts";

const KNOWN = new Set<string>([...API_ERROR_CODES, ...SDK_ERROR_CODES]);

/** 명세 3.3 — SDK의 에러 하나. `code`로 분기하고 `message`는 보여 주기만 한다. 앱의 오류 화면에 `correlationId`를 보이면 문의를 바로 찾는다 */
export class BydevError extends Error {
  override readonly name = "BydevError";
  readonly code: ApiErrorCode | SdkErrorCode | (string & {});
  readonly httpStatus: number | null;
  readonly correlationId: string | null;
  readonly retryAfterSec: number | null;
  readonly details: Readonly<Record<string, unknown>> | null;

  constructor(
    code: ApiErrorCode | SdkErrorCode | (string & {}),
    message: string,
    extra: {
      readonly httpStatus?: number | null;
      readonly correlationId?: string | null;
      readonly retryAfterSec?: number | null;
      readonly details?: Readonly<Record<string, unknown>> | null;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.code = code;
    this.httpStatus = extra.httpStatus ?? null;
    this.correlationId = extra.correlationId ?? null;
    this.retryAfterSec = extra.retryAfterSec ?? null;
    this.details = extra.details ?? null;
  }

  /**
   * 명세 3.4 — 일시적 실패면 참. 아는 코드는 그 뜻대로(`RATE_LIMITED` · `INTERNAL_ERROR` · `NETWORK_ERROR`만 일시적 — 429인 한도 초과
   * 코드는 끝난 실패다), 모르는 코드만 HTTP 상태로 나눈다
   */
  get transient(): boolean {
    if ((RULES.transient.codes as readonly string[]).includes(this.code)) return true;
    if (KNOWN.has(this.code)) return false;
    const status = this.httpStatus;
    if (status === null) return false;
    return (
      (RULES.transient.unknownCodeStatuses as readonly number[]).includes(status) ||
      RULES.transient.unknownCodeStatusRanges.some(([low, high]) => status >= low && status <= high)
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      httpStatus: this.httpStatus,
      correlationId: this.correlationId,
      retryAfterSec: this.retryAfterSec,
      details: this.details,
    };
  }
}

export function sdkError(
  code: SdkErrorCode,
  message: string,
  extra: ConstructorParameters<typeof BydevError>[2] = {},
): BydevError {
  return new BydevError(code, message, extra);
}

export function asBydevError(error: unknown): BydevError {
  if (error instanceof BydevError) return error;
  return sdkError("PROTOCOL_ERROR", error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}
