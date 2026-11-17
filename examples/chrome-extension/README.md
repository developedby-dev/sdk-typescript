# 예제: 크롬 확장(MV3)

데브 SDK로 로그인과 세션 리스를 구현하는 MV3 확장 예제입니다. 서비스 워커는 30초 동안 활동이 없으면 종료되어 메모리의 정보도 사라집니다.

`chromeAlarmScheduler()`는 하트비트 같은 긴 대기를 `chrome.alarms`로 예약합니다. `resumeExtensionSession()`은 `chrome.storage.session`에 저장한 세션을 복구합니다.

| 파일 | 무엇 |
|---|---|
| `background.ts` | 서비스 워커: 클라이언트 · 스케줄러 · 세션을 맨 위에서 동기로 만들고, 이어 받을 세션이 없으면 로그인(확인 주소를 새 탭으로) 뒤 시작 |
| `config.ts` | 판매자 콘솔의 제품 값(API 주소 · `clientId` · `productId`) |
| `manifest.json` | 권한 `storage` · `alarms`, `host_permissions`에 API 출처 |
| `check.ts` | 실제 브라우저 확인: 아래 |

판매자 앱에서는 esbuild, Vite, webpack 같은 번들러로 `background.ts`를 번들링해 `background.js`를 생성합니다.

## 실제 브라우저 확인

```sh
pnpm --filter @bydev/sdk check:extension
```

이 예제를 Chrome for Testing에 로드하고, 계약대로 답하는 가짜 API(127.0.0.1)에 로그인 → 세션 획득 → 첫 하트비트 → **서비스 워커를 강제로 내림** →
알람이 깨워 두 번째 하트비트까지 봅니다(5 ~ 6분: 하트비트 간격 150초를 그대로 씁니다). 통과 조건은 획득 한 번 · refresh_token 갱신 없음(다시 떠도
메모리의 access_token을 이어서 처리합니다) · 두 하트비트가 같은 세션 · 간격이 지터 범위 안 · 계약 위반 없음.

- 브라우저: `BYDEV_CHROME`(실행 파일 경로), 없으면 Playwright가 받아 둔 Chrome for Testing(`npx playwright install chromium`). 상표 Chrome은 137부터
  `--load-extension`을 받지 않습니다.
- `BYDEV_HEADLESS=0`이면 브라우저 창을 표시합니다.
- 번들러 없이 Node의 타입 제거(`module.stripTypeScriptTypes`)로 확장 폴더를 만듭니다: 임시 폴더에 만들고 끝나면 삭제합니다.
