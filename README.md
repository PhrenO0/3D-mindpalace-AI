# 광화문 VWorld 기억궁전

VWorld 3D 광화문 지도 위에 5개의 기억궁전 외관 파빌리온을 실제 위경도 기반으로 배치하고, 세종대왕 동상 위치의 대표 방 1개를 Three.js로 구현한 **1주차 3D 팀 데모**입니다.

현재 범위는 3D 공간 구현입니다. PDF 분석, GraphRAG, Azure 연동, 퀴즈 생성은 포함하지 않고 `public/memory-palace-spec.mock.json`으로 연동 구조만 보여줍니다.

## 실행 방법

```bash
npm install
npm run dev
```

기본 주소:

```text
http://127.0.0.1:8765/
```

다른 포트로 실행:

```powershell
$env:PORT="8769"; npm run dev
```

## VWorld 키 설정

`.env` 파일에 아래 값을 둡니다.

```bash
VWORLD_API_KEY=발급받은_VWorld_API_Key
```

서버 환경 변수에 키가 없으면 브라우저 입력 패널에서 넣을 수 있습니다. 브라우저 입력 키는 `localStorage`에만 저장됩니다. 공개 저장소에는 `.env`를 올리지 마세요.

## 현재 구현

- VWorld WebGL 3D 지도를 광화문 외부 배경으로 사용합니다.
- 5개 파빌리온은 `lon`, `lat`, `altitude` 기반으로 배치합니다.
- VWorld viewer가 준비되면 WGS84 좌표를 화면 좌표로 투영해 overlay 위치를 동기화합니다.
- 세종대왕 동상 파빌리온에는 `대표 3D 방` 배지를 표시합니다.
- `room-03-sejong.html`은 Three.js 기반 대표 방입니다.
- 대표 방은 WASD 이동, 마우스 시점 회전, 사물 클릭 설명 패널을 지원합니다.
- 기억 사물 5개는 훈민정음 책, 집현전 문서함, 과학기술 해시계, 유교 정치/법제 비석, 국가 운영 지도로 구성했습니다.

## 팀 연동 구조

LLM/RAG 팀은 1주차에 실제 PDF 파이프라인 대신 mock JSON을 먼저 맞추면 됩니다.

```text
public/memory-palace-spec.mock.json
```

3D 쪽은 `conceptId`와 `objectId`가 연결되면 방 안의 사물 클릭 UI로 보여줄 수 있습니다.

## 공유 파일

공유할 때 포함할 파일:

```text
.env.example
.gitignore
README.md
PROJECT_CHECKPOINTS.md
package.json
package-lock.json
server.mjs
vworld_3d_map_live.html
room-01-sejong-daero.html
room-02-yi-sunsin.html
room-03-sejong.html
room-04-gwanghwamun.html
room-05-gyeongbokgung.html
tests/
public/
```

팀 내부에서 VWorld 키까지 같이 전달해야 할 때만 `.env`를 포함합니다.

## 점검

```bash
npm test
```

확인하는 내용:

- Cesium/Google Photorealistic Tiles 경로가 남아 있지 않은지
- 외부 건물이 실제 지리 좌표 기반인지
- 세종대왕 대표 방이 Three.js 인터랙티브 방인지
- mock MemoryPalaceSpec이 개념과 기억 사물을 연결하는지
- README에 실제 키가 직접 들어가지 않았는지

## 다음 작업

1. 대표 방의 시각 품질을 발표 화면 기준으로 polish
2. 방 입장 전환 애니메이션 추가
3. UI 팀의 사이드 대시보드 디자인과 결합
4. LLM/RAG 팀의 조선시대 개념 JSON과 실제 연결
5. 외부 파빌리온을 필요하면 경량 GLB 또는 Three.js overlay로 교체
