/**
 * 운영체제 포트 실제 확인 — Windows · Linux 기기에서 돌린다(launch-checklist A31 · ADR-0040 ⚠ 20 · 27 · 31). 사용자 보안 저장소를 건드리므로
 * `BYDEV_KEYCHAIN_CHECK=1`일 때만 — `BYDEV_KEYCHAIN_CHECK=1 node examples/os-check.ts`(의존성 없음 — 저장소 받기 · 설치가 필요 없다).
 *
 * - 기본 저장소(`defaultNodeCredentialStore` — Windows DPAPI 파일 · Linux Secret Service)에 항목 하나(계정 `bydev-keychain-check`)를 넣고 · 고치고 ·
 *   읽고 · 지운다. 보안 저장소 대신 0600 파일로 떨어지면(경고 로그) 실패다 — Linux는 `secret-tool`과 잠금 풀린 기본 모음이 있어야 한다
 * - 지문 출처(`nodeFingerprintSource` — MachineGuid · machine-id)가 설치 ID 파일 없이 운영체제 값을 읽고, 두 번 읽어도 같다
 */
import { rm } from "node:fs/promises";
import type { CredentialRecord, Logger } from "../src/index.ts";
import {
  appDataDir,
  defaultNodeCredentialStore,
  nodeDeviceInfo,
  nodeFingerprintSource,
} from "../src/node.ts";

const out = (line: string) => process.stdout.write(`${line}\n`);
const APP = "bydev-os-check";
const ACCOUNT = "bydev-keychain-check";

async function main(): Promise<number> {
  if (process.env.BYDEV_KEYCHAIN_CHECK !== "1") {
    out("BYDEV_KEYCHAIN_CHECK=1이 아니라 건너뛴다 — 사용자 보안 저장소를 건드린다");
    return 0;
  }
  if (process.platform !== "linux" && process.platform !== "win32") {
    out(`${process.platform}는 대상이 아니다 — Windows · Linux에서 돌린다`);
    return 0;
  }
  const failures: string[] = [];
  const device = nodeDeviceInfo();
  out(`기기 ${device.name} · ${device.platform}`);

  const fingerprint = nodeFingerprintSource();
  const first = await fingerprint.read();
  const again = await fingerprint.read();
  if (first === null) failures.push("지문 — 운영체제 값을 읽지 못했다(설치 ID 없이)");
  else if (first !== again) failures.push("지문 — 두 번 읽은 값이 다르다");
  else out(`✓ 지문 출처 — 운영체제 값(길이 ${first.length})을 읽었고 두 번 같다`);

  const warnings: string[] = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message) => warnings.push(message),
  };
  const store = await defaultNodeCredentialStore({ appName: APP, account: ACCOUNT, logger });
  const record: CredentialRecord = {
    version: 1,
    refreshToken: "rt_node_test_00000000001",
    scope: "entitlement.read",
    savedAt: "2026-10-06T13:00:00Z",
  };
  const rotated: CredentialRecord = { ...record, refreshToken: "rt_keychain_rotated_000001" };
  const same = (a: CredentialRecord | null, b: CredentialRecord | null) =>
    JSON.stringify(a) === JSON.stringify(b);
  try {
    await store.clear();
    if ((await store.load()) !== null) failures.push("저장소 — 지운 뒤에도 항목이 있다");
    await store.save(record);
    if (!same(await store.load(), record)) failures.push("저장소 — 넣은 것을 읽지 못했다");
    await store.save(rotated);
    if (!same(await store.load(), rotated)) failures.push("저장소 — 고친 것을 읽지 못했다");
    await store.clear();
    if ((await store.load()) !== null) failures.push("저장소 — 지운 항목이 남았다");
    if (warnings.length > 0)
      failures.push(`저장소 — 보안 저장소가 아니라 파일로 떨어졌다: ${warnings.join(" / ")}`);
    else
      out(
        `✓ 기본 저장소(${process.platform === "win32" ? "DPAPI 파일" : "Secret Service"}) — 넣기 · 고치기 · 읽기 · 지우기`,
      );
  } catch (error) {
    failures.push(`저장소 — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await store.clear().catch(() => undefined);
    await rm(appDataDir(APP), { recursive: true, force: true });
  }
  for (const failure of failures) out(`✗ ${failure}`);
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main();
