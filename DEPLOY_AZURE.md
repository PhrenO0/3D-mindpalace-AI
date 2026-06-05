# Azure App Service 배포 가이드 (memory-palace-vworld)

작성: 2026-06-05 · 대상 앱: `memory-palace-vworld` (Node/Express + 정적 HTML)

> 이 앱은 **정적 사이트가 아니라 Node 서버**다. `/api/detect`(Azure Vision 프록시),
> `/api/client-config`(VWorld 키 중계)가 있어 **App Service (Linux, Node)** 가 맞다.
> Static Web Apps로 가려면 서버 프록시를 Functions로 분리해야 하므로, 현재는 App Service로 간다.

---

## 0. 현재 상태 (2026-06-05 확인)
- App Service **3D-mindpalace-AI** 생성됨: Linux · Node · **B1** · Canada Central · 리소스그룹 `9ai-final-team1`.
- 배포 소스 = GitHub 리포 **`PhrenO0/3D-mindpalace---AI`** (연속 배포, GitHub Actions).
- ⚠️ **리포 불일치**: 앱 코드(`memory-palace-vworld`)는 **`PhrenO0/3d`** 에 있는데, Azure가 보는 건
  **다른 리포**다. 그래서 그 리포에 앱이 없으면(또는 루트가 아니면) 사이트가 안 뜬다(라이브 URL 403/기본페이지).

---

## 1. 가장 중요한 함정 (먼저 읽기)

1. **호스트 바인딩** — 앱은 `0.0.0.0`에서 들어야 한다. `127.0.0.1`이면 Azure 프론트엔드가 못 닿아
   사이트가 죽는다. → `server.mjs`를 `WEBSITE_SITE_NAME`(App Service에서만 설정됨)일 때 `0.0.0.0`로
   바인딩하도록 이미 수정함. **이 수정이 배포 리포에 들어가야** 한다.
2. **PORT** — 플랫폼이 `process.env.PORT`로 포트를 준다. 코드가 이미 그걸 읽음(하드코딩 금지). ✅
3. **앱이 리포 루트여야 빌드가 쉽다** — Azure 빌드(Oryx)는 **리포 루트의 `package.json`** 을 보고
   `npm install` 후 `npm start`를 돌린다. 앱이 `memory-palace-vworld/` 하위면 루트에 package.json이
   없어 빌드가 헷갈린다. → **권장: 배포 리포의 루트 = 이 앱 폴더 내용.**
4. **환경변수는 커밋하지 말고 App Service에 넣는다**(아래 3절). `.env`는 로컬 전용.
5. **GLB 방 파일은 gitignore**(`public/assets/rooms/*.glb`) → git 배포엔 안 실린다. 데모 방이
   필요하면 몇 개를 강제로 커밋하거나(아래 4절), 스캐너는 `?glb=` 없이도 폴백은 되지만 방 형상이 없다.
6. **"실시간 공유"의 의미** — 배포하면 **URL을 아는 누구나 각자 브라우저로** 앱을 연다.
   단, 스캔/뷰는 **각자 독립 세션**이다(한 사람 화면이 남에게 실시간 중계되진 않음). 같은 화면을
   여럿이 동시에 보는 "공유 세션"을 원하면 WebSocket 상태동기화가 별도로 필요(지금 범위 밖).

---

## 2. 배포 방법 (세 갈래 — 하나 고르기)

### 방법 A — 배포 리포 루트에 앱 올리기 (권장: 연속배포 유지)
이미 GitHub→Azure가 연결돼 있으니, **`3D-mindpalace---AI` 리포의 루트에 앱을 두면** push마다 자동 배포된다.
1. 이 앱 폴더(`memory-palace-vworld/`)의 **내용물**(server.mjs, *.html, package.json, public/ 등)을
   `3D-mindpalace---AI` 리포 **루트**로 복사.
2. 커밋 & push → GitHub Actions가 `npm install` → `npm start`로 배포.
3. App Service **구성 → 애플리케이션 설정**에 환경변수 추가(3절) → **다시 시작**.
4. 라이브 URL 접속 확인. 루트(`/`)는 스캐너로 폴백(수정 반영됨), 직접 경로도 가능:
   - `…azurewebsites.net/personal-room-scanner-3d.html`
   - `…azurewebsites.net/room-viewer.html?glb=public/assets/rooms/diffuscene-room.glb`

### 방법 B — Azure CLI로 로컬에서 바로 배포 (가장 빠른 1회성)
GitHub 안 거치고 현재 폴더를 zip으로 올린다(노트북/데스크톱에서):
```bash
cd memory-palace-vworld
az login
# 기존 앱에 배포(이름/리소스그룹은 포털 값):
az webapp up --name 3D-mindpalace-AI --resource-group 9ai-final-team1 \
  --runtime "NODE:20-lts" --sku B1
# 또는 zip 배포:
az webapp deploy --name 3D-mindpalace-AI --resource-group 9ai-final-team1 \
  --type zip --src-path ./app.zip
```
> 주의: GitHub 연속배포와 수동 배포를 섞으면 다음 git push가 덮어쓴다. 한 방식만 쓰는 게 안전.

### 방법 C — 배포 소스를 `PhrenO0/3d`로 바꾸기
포털 → App Service → **배포 센터**에서 소스를 `PhrenO0/3d`로 바꾼다. 단 이 리포도 앱이
**하위폴더**라, 빌드가 루트를 보므로 **App Service 구성 → 일반 설정 → 시작 명령**에:
```
cd memory-palace-vworld && npm install && npm start
```
를 넣어야 한다(Oryx 하위폴더 빌드는 까다로워 방법 A를 더 권장).

---

## 3. 환경변수 (App Service "애플리케이션 설정")
| 키 | 값 | 없으면 |
|---|---|---|
| `AZURE_VISION_ENDPOINT` | `https://<리소스>.cognitiveservices.azure.com/` | 스캐너가 브라우저 OWL-ViT로 폴백 |
| `AZURE_VISION_KEY` | Computer Vision 키1 | 〃 |
| `VWORLD_API_KEY` | VWorld 키(쓰면) | VWorld 맵 비활성 |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | (zip배포 시 npm install 보장) |

- 넣은 뒤 **다시 시작**. 스캐너 상태표시줄이 "검출기: Azure AI Vision"으로 바뀌면 OK.
- 무료티어(F0) Vision은 **분당 20콜** 제한 → 스캔 샷 캡(MAX_SHOTS)이 이미 16.

---

## 4. 데모 방(GLB) 포함하기 (선택)
`public/assets/rooms/*.glb`는 gitignore라 git 배포에 안 실린다. 데모용 한두 개를 올리려면:
```bash
git add -f public/assets/rooms/diffuscene-room.glb   # -f로 강제 추가
```
또는 App Service **Kudu(고급 도구) → 디버그 콘솔**에서 `site/wwwroot/public/assets/rooms/`에 직접 업로드.
(B1은 디스크가 있으니 가능. 단 재배포 시 git에 없으면 사라질 수 있어 -f 커밋이 안전.)

---

## 5. 배포 후 점검 / 트러블슈팅
- **로그 스트림**: 포털 → App Service → **로그 스트림** 에서 `Memory Palace server: http://0.0.0.0:PORT` 가 떠야 정상.
- **403/기본 페이지가 뜬다**: 보통 (a) 배포 리포에 앱 코드가 없음, (b) 루트에 package.json 없음,
  (c) 127.0.0.1 바인딩(이번 수정 전 코드). → 1·2절 점검.
- **`/api/detect` 503**: 환경변수 미설정(정상 폴백). 키 넣고 재시작.
- **시작 명령 확인**: 구성 → 일반 설정 → 시작 명령이 비었으면 `npm start` 자동 사용(package.json에 있음). ✅
- **Node 버전**: 구성에서 `NODE|20-lts` 권장(express 5 동작).

---

## 6. 한 줄 요약
> App Service(Linux/Node)에 **앱을 리포 루트로** 올리고(방법 A), **0.0.0.0 바인딩**(수정됨) +
> **PORT 환경변수 사용**(됨) + **Azure 키는 앱 설정에**. 그러면 URL 아는 누구나 각자 브라우저로 본다
> (공유 세션이 아니라 각자 독립 세션).
