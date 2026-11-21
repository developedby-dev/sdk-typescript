# 데브 SDK: TypeScript / JavaScript

데브 라이선스 API의 공식 TypeScript SDK입니다. Node 24, Electron(메인 프로세스), 브라우저 확장(MV3 서비스 워커)에서 동작합니다.

의존성은 없고
`fetch`와 WebCrypto(Ed25519)만 씁니다. [공통 동작 명세](https://github.com/developedby-dev/sdk-spec/blob/main/spec/README.md)를 따르며, [적합성 시험 시나리오](https://github.com/developedby-dev/sdk-spec/tree/main/conformance/scenarios)를 모두 통과합니다.

| 지원 | 버전 |
|---|---|
| 동작 명세 | 1.2.0 |
| API | v1 |
| 런타임 | Node 24, Chrome과 Edge 137 이상(WebCrypto Ed25519를 지원하는 버전, 2025년 5월 출시), Electron 메인 프로세스(해당 Electron의 Node가 WebCrypto Ed25519를 지원해야 합니다) |
| 타입 | TypeScript 5.7 이상(`Uint8Array<…>` 표기를 씁니다). `@bydev/sdk/node`를 쓰려면 `@types/node`도 필요합니다. 패키지에는 JS와 타입 정의(`dist`)가 들어 있습니다. |

패키지 이름은 `@bydev/sdk`입니다. 1.0.0부터는 판 규칙(SemVer)을 지켜, 호환되지 않는 변경은 주 판(2.0.0 등)을 올릴 때만 합니다. 0.x 판은 이름을
먼저 등록하려고 낸 미리보기이니 1.0.0 이상을 써 주세요.

## 빠른 시작

```ts
import { LicenseClient } from "@bydev/sdk";

const client = new LicenseClient({
  baseUrl: "https://api.developedby.dev",
  clientId: "cli_01J9M0Y6X4N3Q8ZD5R2KT7VCPW", // 판매자 콘솔에서 제품마다 발급받습니다
  productId: "prod_01J9KZ3F7W2X8YQ4N6M5R1TBCD",
  scopes: ["entitlement.read", "session.write", "version.read"],
  device: { name: os.hostname(), platform: "WINDOWS" },
  app: { target: "WINDOWS_X64", version: "1.4.0" }, // 콘솔에 업로드한 빌드의 버전과 같게
  ports: { store: mySecureStore, fingerprint: myMachineIdSource }, // 아래 「포트」를 참고하세요
});

if (!(await client.hasCredentials())) {
  const login = await client.startLogin();
  showCode(login.userCode, login.verificationUriComplete); // 화면에 코드와 QR 코드를 보여 줍니다
  await login.wait(); // 사용자가 브라우저에서 승인할 때까지 기다립니다
}

const session = client.session();
session.subscribe((state) => {
  switch (state.type) {
    case "Active":
    case "Degraded": // offlineUntil까지는 계속 쓸 수 있습니다
      enableFeatures(state.claims); // exp와 sid는 기능 코드에서 쓰고, 참/거짓 하나로만 판단하지 마세요
      break;
    case "NeedsDecision":
      askUser(state); // DEVICE_IN_USE: "여기서 사용할까요?"에 동의하면 session.takeOver()를 부릅니다
      break;
    case "Locked":
      lockApp(state.code, state.correlationId); // 오류 화면에 correlationId를 보여 주세요
      break;
  }
});
session.start();
// 앱을 끌 때
await session.stop();
```

## 포트

| 포트 | 기본 구현 | 직접 구현하거나 설정할 항목 |
|---|---|---|
| `transport` | `fetch` (시간 초과 30초) | 프록시나 인증서 고정이 필요할 때 |
| `store` | **메모리**. 앱을 끄면 로그인이 사라집니다. | 운영체제 보안 저장소(Electron `safeStorage`, 키체인, DPAPI) |
| `fingerprint` | 없음. 실행할 때마다 새 기기로 보일 수 있습니다(경고 로그를 남깁니다) | `MachineGuid`, `IOPlatformUUID`, `/etc/machine-id`. 확장은 설치 ID |
| `clock`, `scheduler`, `random` | 시스템 시계, `setTimeout`, `crypto` | 확장은 `chromeAlarmScheduler()`를 주세요. 서비스 워커가 쉬면 타이머가 사라지므로 긴 대기에는 `chrome.alarms`를 씁니다. |
| `logger` | 로그 기록 없음 | 토큰과 기기 지문 원본은 로그로 넘어오지 않습니다. |

운영체제별 포트는 별도 진입점에서 가져옵니다. 앱 번들에 Node 모듈이 섞이지 않게 하려는 것입니다.

| 가져오기 | 들어 있는 것 |
|---|---|
| `@bydev/sdk/node` | `nodeFingerprintSource()`(MachineGuid, IOPlatformUUID, machine-id를 읽고, 없으면 설치 ID 파일), `nodeDeviceInfo()`, `electronCredentialStore(safeStorage, 경로)`(Electron에 권장), `dpapiCredentialStore`, `secretToolCredentialStore`, `fileCredentialStore`(권한 0600, 암호화 없음), `defaultNodeCredentialStore({ appName, account })` |
| `@bydev/sdk/extension` | `chromeStorageCredentialStore()`, `chromeInstallIdFingerprint()`, `chromeAlarmScheduler()`, `resumeExtensionSession(session)` |
| `@bydev/sdk/server` | `verifyWebhook({ secrets, headers, rawBody })`, `createServerVerifier({ baseUrl, clientId })`. 판매자 서버(Node, Deno, Workers)에서 씁니다. |

macOS의 순수 Node 앱은 네이티브 모듈 없이는 키체인을 안전하게 쓸 방법이 없습니다. 그래서 기본 저장소는 권한 0600 파일이며, 이때 경고 로그를 남깁니다.

Electron 앱은 `electronCredentialStore`를 사용해 주세요. SDK는 비밀 값(refresh_token)을 명령줄 인자로 넘기지 않고, `secret-tool`이나 PowerShell에 표준 입력으로만 전달합니다.

**Linux용 배포 패키지에는 `secret-tool`을 의존성으로 걸어 주세요.** 기본 저장소는 이 명령으로 Secret Service에 접근하는데, Debian과 Ubuntu 데스크톱의
기본 설치에는 이 명령이 없습니다.

Ubuntu 26.04.1에서 확인했으며, Secret Service 자체는 실행되고 있었습니다. .deb 패키지는 `libsecret-tools`를 `Depends`나
`Recommends`에 넣고, RPM(Fedora 등)과 Arch 패키지는 `libsecret`을 넣어 주세요.

의존성을 지정할 수 없는 AppImage나 tar.gz 배포본에는 `secret-tool` 설치 방법을 안내해 주세요.
이 명령이 없으면 0600 파일에 대신 저장하고 경고 로그를 남깁니다.

Electron 앱의 `electronCredentialStore`는 이 도구를 쓰지 않습니다.

## 사용 조건

- **업데이트**: `checkForUpdate({ target, currentVersion })`가 반환한 `update.status`가 `REQUIRED`이면, 업데이트하기 전까지 앱 실행을 막아 주세요. 받은 파일은
  설치하기 전에 `verifyDownload(bytes, install.sha256)`로 확인해 주세요.
  업데이트 제공 기한이 있는 구매자는 결과에 `entitled`가 들어 있습니다. 그때는 최상위 대신 `entitled.release`를 따라 주세요.
  최상위 최신 버전은 그 구매자가 실행할 수 없는 버전일 수 있고, `entitled.release`가 비어 있으면 그 대상에 제공 범위 안의 버전이 없습니다.
- **오류**: `BydevError.code`로 분기해 주세요. 코드 값은 생성된 상수 `API_ERROR_CODES`와 `SDK_ERROR_CODES`에 있습니다. `message`는 화면에 보여 주는 용도로만 사용해 주세요.
- **Electron**: SDK는 메인 프로세스에서 사용해 주세요. 렌더러 프로세스에는 토큰을 두지 마세요.
- **브라우저 확장**: 서비스 워커에서만 사용해 주세요. `manifest.json`의 `permissions`에는 `storage`와 `alarms`를, `host_permissions`에는 API 출처를 넣고, 로그인 확인
  주소는 `chrome.tabs.create`로 엽니다. `chrome.storage.local`은 암호화되지 않습니다. 확장 밖에서는 읽을 수 없지만, 기기에 있는 악성 프로그램은 읽을 수 있습니다.

  서비스 워커는 30초 동안 쉬면 내려가고, 그때 메모리도 사라집니다. 그래서 스케줄러로는 `chromeAlarmScheduler()`를 사용해 주세요.

  이 스케줄러는 짧은 대기는 타이머로,
  하트비트처럼 긴 대기는 `chrome.alarms`로 처리합니다. 세션은 `resumeExtensionSession()`이 `chrome.storage.session`에 두었다가, 서비스 워커가 다시 뜰 때 이어 갑니다.
  `chrome.storage.session`은 메모리 저장소라 브라우저를 닫으면 사라집니다.

  이 둘은 **서비스 워커 코드 맨 위에서** 만들어야 합니다. 알람 구독을 첫 실행 때
  동기로 해 두어야 서비스 워커를 깨우는 알람을 받을 수 있기 때문입니다.

  예를 들면 다음과 같습니다.

  ```ts
  import { LicenseClient } from "@bydev/sdk";
  import {
    chromeAlarmScheduler,
    chromeInstallIdFingerprint,
    chromeStorageCredentialStore,
    resumeExtensionSession,
  } from "@bydev/sdk/extension";

  const client = new LicenseClient({
    baseUrl: "https://api.developedby.dev",
    clientId: "cli_01J9M0Y6X4N3Q8ZD5R2KT7VCPW",
    productId: "prod_01J9KZ3F7W2X8YQ4N6M5R1TBCD",
    scopes: ["entitlement.read", "session.write"],
    device: { name: "Chrome", platform: "OTHER" },
    ports: {
      store: chromeStorageCredentialStore(),
      fingerprint: chromeInstallIdFingerprint(),
      scheduler: chromeAlarmScheduler(),
    },
  });
  const session = client.session();
  session.subscribe(onState); // 서비스 워커가 다시 뜰 때마다 이어 받은 상태부터 다시 알려 줍니다
  // 이어 받을 세션이 없으면(브라우저를 새로 켠 경우) 로그인돼 있을 때 세션을 시작합니다
  if (!(await resumeExtensionSession(session)) && (await client.hasCredentials())) session.start();
  ```

  세션 스냅숏에는 리스(서버가 이 기기에 잡아 둔 세션 자리), licenseToken, 다음 작업을 할 시각, 메모리에 있던 access_token이 들어갑니다. 서비스 워커가 다시 뜰
  때마다 refresh_token을 회전하지 않으려고 이 스냅숏을 `chrome.storage.session`에 둡니다.

  이 저장소는 디스크에 쓰지 않고, 콘텐츠 스크립트도 읽을 수 없습니다.
  디스크에 남는 것은 지금처럼 refresh_token 기록 하나뿐입니다.

  전체 예제는 [`examples/chrome-extension`](examples/chrome-extension)에 있습니다. 실제
  브라우저에서 서비스 워커를 내렸다가 다시 시작하는 확인 스크립트도 함께 들어 있습니다.
- 라이선스: MIT 또는 Apache-2.0.

## 출처 확인

이 꾸러미는 공개 저장소 `developedby-dev/sdk-typescript`의 GitHub Actions가 판 태그에서 짓고 올립니다. npm에 올린 꾸러미에는 출처 증명(provenance)이 있습니다. 설치한 프로젝트에서 `npm audit signatures`로 확인할 수 있고, npm 꾸러미 화면의 「Provenance」에서 지은 저장소와 워크플로를 볼 수 있습니다.
0.x 미리보기(0.1.0 · 0.1.1)는 예외입니다. npm의 신뢰 게시는 꾸러미가 생긴 뒤에만 걸 수 있어 손으로 올렸고, 출처 증명이 없습니다. 0.1.0은 진입점이 빌드 파일을 가리키지 않아 불러올 수 없으니 0.1.1 이상을 써 주세요.
