import { systemClock } from "./defaults.ts";
import { sdkError } from "./errors.ts";
import { RULES } from "./generated.ts";
import type {
  Clock,
  CredentialRecord,
  CredentialStore,
  FingerprintSource,
  Scheduler,
} from "./ports.ts";
import type { LicenseSession, SessionSnapshot } from "./session.ts";

/**
 * 브라우저 확장(MV3) 포트 — 서비스 워커에서 쓴다. `chrome.storage.local`은 **암호화되지 않는다** — 다른 확장 · 웹 페이지는 못 읽지만 기기의 악성
 * 프로그램은 읽을 수 있다(명세 2절 표 · ADR-0040 정해야 할 것 6). `@types/chrome` 없이 쓰려고 필요한 모양만 적었다
 */
export interface ChromeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** `chrome.alarms` 중 쓰는 모양 */
export interface ChromeAlarms {
  create(name: string, info: { readonly when: number }): unknown;
  clear(name: string): unknown;
  getAll(): Promise<readonly { readonly name: string }[]>;
  readonly onAlarm: {
    addListener(listener: (alarm: { readonly name: string }) => void): void;
  };
}

/** `chrome.runtime` 중 쓰는 모양 — 확장 API를 한 번 불러 서비스 워커가 쉬는 시간(30초)을 처음부터 다시 센다 */
export interface ChromeRuntime {
  getPlatformInfo(): Promise<unknown>;
}

interface ChromeGlobal {
  readonly storage?: { readonly local?: ChromeStorageArea; readonly session?: ChromeStorageArea };
  readonly alarms?: ChromeAlarms;
  readonly runtime?: ChromeRuntime;
}

function chromeGlobal(): ChromeGlobal | undefined {
  return (globalThis as { chrome?: ChromeGlobal }).chrome;
}

function local(area?: ChromeStorageArea): ChromeStorageArea {
  if (area !== undefined) return area;
  const found = chromeGlobal()?.storage?.local;
  if (found === undefined)
    throw sdkError(
      "CONFIGURATION",
      "chrome.storage.local이 없다 — manifest의 permissions에 storage를 넣는다",
    );
  return found;
}

export function chromeStorageCredentialStore(
  options: { readonly key?: string; readonly area?: ChromeStorageArea } = {},
): CredentialStore {
  const key = options.key ?? `${RULES.storage.service}.credentials`;
  const run = async <T>(
    what: string,
    body: (area: ChromeStorageArea) => Promise<T>,
  ): Promise<T> => {
    try {
      return await body(local(options.area));
    } catch (error) {
      throw sdkError("STORAGE_FAILED", `chrome.storage ${what} 실패`, { cause: error });
    }
  };
  return {
    load: () =>
      run("읽기", async (area) => {
        const value = (await area.get(key))[key] as CredentialRecord | undefined;
        return value?.version === RULES.storage.recordVersion ? value : null;
      }),
    save: (record) => run("쓰기", (area) => area.set({ [key]: record })),
    clear: () => run("지우기", (area) => area.remove(key)),
  };
}

/** 설치 ID — 확장에는 기기 식별자가 없다. 처음 한 번 만들어 둔다. 확장을 지우고 다시 깔면 새 기기다(명세 10절) */
export function chromeInstallIdFingerprint(
  options: { readonly key?: string; readonly area?: ChromeStorageArea } = {},
): FingerprintSource {
  const key = options.key ?? `${RULES.storage.service}.installId`;
  return {
    async read() {
      const area = local(options.area);
      const existing = (await area.get(key))[key];
      if (typeof existing === "string" && existing !== "") return existing;
      const created = crypto.randomUUID();
      await area.set({ [key]: created });
      return created;
    },
  };
}

/** 서비스 워커는 이벤트 · 확장 API 호출이 30초 없으면 내려간다 — 그보다 넉넉히 짧은 대기만 타이머로 */
const SHORT_WAIT_MAX_MS = 25_000;
const ALARM_PREFIX = "bydev:";

/**
 * MV3 서비스 워커의 스케줄러 — 짧은 대기(25초 미만: 폴링 · 갱신 재시도 · 획득 재시도 앞쪽)는 `setTimeout`에 확장 API 한 번(쉬는 시간을 다시
 * 센다), 긴 대기(하트비트 · 오프라인 만료 · 획득 재시도 뒤쪽)는 `chrome.alarms`(서비스 워커가 내려가 있어도 깨운다 — Chrome 120부터 최소 30초라
 * 25 ~ 30초는 30초에 온다).
 *
 * **서비스 워커 맨 위에서 동기로 만든다** — `chrome.alarms.onAlarm` 구독은 첫 실행에서 동기로 해야 깨우는 알람을 받는다. 서비스 워커가 다시 뜨면
 * 앞 삶의 일은 메모리에 없다 — `resumeExtensionSession`이 세션을 잇고 다시 예약하며, 앞 삶의 알람은 지운다(깨우는 일만 하고 버린다).
 * manifest의 permissions에 `alarms`를 넣는다
 */
export function chromeAlarmScheduler(
  options: {
    readonly alarms?: ChromeAlarms;
    readonly runtime?: ChromeRuntime;
    /** 알람 시각을 잡는 시계 — 클라이언트에 시계 포트를 줬으면 같은 것 */
    readonly clock?: Clock;
    readonly timers?: {
      set(task: () => void, ms: number): unknown;
      clear(handle: unknown): void;
    };
  } = {},
): Scheduler {
  const alarms = options.alarms ?? chromeGlobal()?.alarms;
  const runtime = options.runtime ?? chromeGlobal()?.runtime;
  if (alarms === undefined)
    throw sdkError(
      "CONFIGURATION",
      "chrome.alarms가 없다 — manifest의 permissions에 alarms를 넣는다",
    );
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? {
    set: (task, ms) => setTimeout(task, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  /** 이 삶이 만든 알람 — 이름은 삶마다 다르다(다시 뜬 서비스 워커의 이름과 겹치지 않게) */
  const tasks = new Map<string, () => Promise<void>>();
  const life = crypto.randomUUID();
  let next = 0;
  const run = (task: () => Promise<void>) => {
    task().catch(() => undefined);
  };
  alarms.onAlarm.addListener((alarm) => {
    const task = tasks.get(alarm.name);
    if (task === undefined) return;
    tasks.delete(alarm.name);
    run(task);
  });
  // 앞 삶의 알람 — 서비스 워커를 깨우는 일은 끝났다. 세션은 저장한 시각으로 다시 예약한다
  void Promise.resolve(alarms.getAll())
    .then((all) => {
      for (const alarm of all)
        if (alarm.name.startsWith(ALARM_PREFIX) && !tasks.has(alarm.name)) alarms.clear(alarm.name);
    })
    .catch(() => undefined);
  return {
    schedule(delayMs, task) {
      if (delayMs < SHORT_WAIT_MAX_MS) {
        runtime?.getPlatformInfo().catch(() => undefined);
        const handle = timers.set(() => run(task), Math.max(0, delayMs));
        return () => timers.clear(handle);
      }
      next += 1;
      const name = `${ALARM_PREFIX}${life}:${next}`;
      tasks.set(name, task);
      alarms.create(name, { when: clock.now() + delayMs });
      return () => {
        if (tasks.delete(name)) alarms.clear(name);
      };
    },
  };
}

/**
 * 확장 세션을 서비스 워커의 삶 너머로 잇는다 (ADR-0040 ⚠ 11). 세션 스냅숏(instanceId · 리스 · licenseToken · 다음 일의 시각 · 메모리의
 * access_token)을 바뀔 때마다 `chrome.storage.session`에 두고, 서비스 워커가 다시 뜨면 이어 받는다. 이어 받았으면 true — 아니면 앱이 필요할 때
 * `start()`한다. `stop()`하면 지운다.
 *
 * `chrome.storage.session`은 메모리에만 있고(브라우저를 닫으면 사라진다) 확장 페이지 · 서비스 워커만 읽는다 — 콘텐츠 스크립트에 열지 않는다
 * (`setAccessLevel`을 바꾸지 않는다). 서비스 워커 맨 위에서 클라이언트 · `chromeAlarmScheduler`를 만든 다음 부른다
 */
export async function resumeExtensionSession(
  session: LicenseSession,
  options: { readonly area?: ChromeStorageArea; readonly key?: string } = {},
): Promise<boolean> {
  const area = options.area ?? chromeGlobal()?.storage?.session;
  if (area === undefined)
    throw sdkError(
      "CONFIGURATION",
      "chrome.storage.session이 없다 — Chrome 102 이상 · storage 권한",
    );
  const key = options.key ?? `${RULES.storage.service}.session`;
  let stored: SessionSnapshot | null = null;
  try {
    const value = (await area.get(key))[key] as SessionSnapshot | undefined;
    stored = value?.version === 1 ? value : null;
  } catch (error) {
    throw sdkError("STORAGE_FAILED", "chrome.storage.session 읽기 실패", { cause: error });
  }
  // 쓰기는 차례대로 — 늦게 끝난 앞 쓰기가 새 스냅숏을 덮지 않게
  let writing: Promise<unknown> = Promise.resolve();
  session.watch(() => {
    const snapshot = session.snapshot();
    writing = writing
      .then(() => (snapshot === null ? area.remove(key) : area.set({ [key]: snapshot })))
      .catch(() => undefined);
  });
  if (stored === null || session.state.type !== "Stopped") return false;
  session.restore(stored);
  return true;
}
