import type { Ports } from "./ports.ts";

/** 스케줄러로 기다린다 — SDK는 스스로 타이머를 만들지 않는다(명세 0절 3) */
export function sleep(ports: Ports, ms: number): Promise<void> {
  return new Promise((resolve) => {
    ports.scheduler.schedule(ms, async () => {
      resolve();
    });
  });
}

/** `round(base × (min + (max − min) × Random.float()))` ms — 명세 5 · 8.3절 */
export function jittered(
  ports: Ports,
  baseMs: number,
  range: { readonly min: number; readonly max: number },
): number {
  return Math.round(baseMs * (range.min + (range.max - range.min) * ports.random.float()));
}
