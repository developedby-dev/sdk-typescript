/**
 * MV3 확장의 서비스 워커 — bydev SDK로 로그인 · 세션 리스를 잇는 가장 작은 예. 서비스 워커는 30초 쉬면 내려가 메모리가 사라진다 — 클라이언트 ·
 * 스케줄러 · 세션은 **맨 위에서 동기로** 만들고(알람 구독은 첫 실행에서 해야 깨우는 알람을 받는다), 다시 뜨면 `resumeExtensionSession`이 앞 삶의
 * 세션을 잇는다(ADR-0040 확장 세션 기록)
 */
import { LicenseClient, type SessionState } from "@bydev/sdk";
import {
  chromeAlarmScheduler,
  chromeInstallIdFingerprint,
  chromeStorageCredentialStore,
  resumeExtensionSession,
} from "@bydev/sdk/extension";
import { config } from "./config.ts";

/** 이 예가 쓰는 확장 API의 모양 — `@types/chrome` 없이 */
declare const chrome: {
  readonly tabs: { create(options: { url: string }): Promise<unknown> };
};

const client = new LicenseClient({
  ...config,
  scopes: ["entitlement.read", "session.write"],
  device: { name: "Chrome", platform: "OTHER" },
  ports: {
    store: chromeStorageCredentialStore(),
    fingerprint: chromeInstallIdFingerprint(),
    scheduler: chromeAlarmScheduler(),
  },
});
const session = client.session();

let usable = false;

/** 기능을 켜고 끄는 곳 — Active · Degraded(offlineUntil까지)면 쓸 수 있다. 상태는 서비스 워커가 다시 뜰 때마다 이어 받은 값부터 다시 알린다 */
function onState(state: SessionState): void {
  usable = state.type === "Active" || state.type === "Degraded";
}

/** 확장의 다른 이벤트 처리기(메시지 · 명령)가 기능을 쓰기 전에 묻는다 */
export function canUseFeatures(): boolean {
  return usable;
}

/** 로그인돼 있지 않으면 확인 주소를 새 탭으로 열고 기다린 뒤 세션을 시작한다 */
async function signInAndStart(): Promise<void> {
  if (!(await client.hasCredentials())) {
    const login = await client.startLogin();
    await chrome.tabs.create({ url: login.verificationUriComplete });
    await login.wait();
  }
  session.start();
}

session.subscribe(onState);
// 이어 받을 세션이 없으면(브라우저를 새로 켰다 · 처음 깔았다) 시작한다
void resumeExtensionSession(session).then((resumed) => (resumed ? undefined : signInAndStart()));
