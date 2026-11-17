import { sdkError } from "./errors.ts";

/**
 * 관대한 읽기 (명세 0절 5) — 필요한 필드는 확인하고, 모르는 필드는 버리고, 모르는 열거 값은 문자열 그대로 둔다. 어긋나면 `PROTOCOL_ERROR`
 */
type Json = unknown;

function fail(path: string, want: string, got: Json): never {
  throw sdkError(
    "PROTOCOL_ERROR",
    `응답의 ${path}가 ${want}가 아니다 (${JSON.stringify(got) ?? "없음"})`,
  );
}

export function object(value: Json, path: string): Readonly<Record<string, Json>> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(path, "객체", value);
  return value as Record<string, Json>;
}

export function string(value: Json, path: string): string {
  if (typeof value !== "string") fail(path, "문자열", value);
  return value;
}

export function integer(value: Json, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(path, "정수", value);
  return value;
}

export function boolean(value: Json, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "참/거짓", value);
  return value;
}

export function array(value: Json, path: string): readonly Json[] {
  if (!Array.isArray(value)) fail(path, "배열", value);
  return value;
}

export function nullable<T>(value: Json, path: string, read: (v: Json, p: string) => T): T | null {
  return value === null || value === undefined ? null : read(value, path);
}

/** 열거 — 알려진 값이든 모르는 값이든 문자열로 둔다 */
export function enumValue<K extends string>(value: Json, path: string): K | (string & {}) {
  return string(value, path);
}

export function field(record: Readonly<Record<string, Json>>, key: string): Json {
  return record[key];
}
