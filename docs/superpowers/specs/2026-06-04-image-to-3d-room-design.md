# 2D 사진 → 걸어다니는 3D 방 변환기 (Tier 1) — 설계

작성: 2026-06-04 · 프로젝트: `memory-palace-vworld` (3차 프로젝트)
관련 선행 자산: `scripts/generate_depth_anything_room.py`(Python 오프라인 깊이메쉬→GLB), `personal-room-scanner-3d.html`(transformers.js 브라우저 추론 패턴), `IMAGE_BLASTER_INTEGRATION_REVIEW.md`

---

## 0. 한 문단 요약

사용자가 방 사진 한 장을 올리면 **브라우저(서버리스)** 에서 깊이를 추정하고, 깊이맵을
**엣지-인식 변위 메쉬**로 만들어 시차(parallax)를 두고 걸어다니는 "꽤 예쁜 디오라마"로
바꾼다. 결과는 **`.glb`로 내보내** 기존 image-blaster 뷰어·스캐너·기억궁전에 그대로 꽂힌다.
비용 0, `file://` 더블클릭 동작. 이것이 **Tier 1**이며, 향후 **Tier 2**(Azure GPU에
MoGe/Flash3D를 얹어 World-Labs급 splat 방)로 확장한다 — 이번 범위는 Tier 1만.

## 1. 목표와 비목표

### 목표 (Tier 1)
- 방 사진 1장 → 브라우저에서 깊이추정 → 걸어다니는 텍스처 메쉬.
- **"깔끔함"의 핵심 레버 = 엣지-인식 컬링**: 가까운 사물과 먼 배경이 늘어지지 않게 분리.
- **"예쁨"의 보강**: 바닥/뒷벽 스캐폴드 + 조명·톤·비네트 프레젠테이션 폴리시 + (단계적으로)
  LaMa 인페인팅으로 가림 구멍 메우기.
- `.glb` 내보내기 — Python 선행본과 **동일 GLB 구조·메쉬 네이밍**으로 호환.
- 완전 서버리스: 외부 API·세션·Claude 의존 0. 모든 추론은 브라우저 transformers.js.

### 비목표 (이번 범위 밖)
- Tier 2(Azure GPU 호스팅 MoGe/Flash3D/Pano2Room, splat 렌더) — 다음 spec.
- 완전 360° 방 복원 / metric(절대) 스케일 — 상대깊이 + 휴리스틱 스케일로 충분.
- 기억궁전 핫스팟·개념 매핑 자동 연결 — Tier 1은 변환기 + GLB 출력까지.

## 2. 합의된 한계 (정직)

- 사진 1장 → **부조(relief) 메쉬**: 정면 반구는 시차 있게 걸어다니지만, **완전히 뒤돌면
  빈 공간**. 이것은 단일시점 깊이메쉬의 본질적 한계이며 Tier 2에서만 근본 해결된다.
- 깊이는 **상대/역깊이** → 절대 스케일은 슬라이더로 튜닝하는 휴리스틱(metric 아님).
- 엣지 컬링은 가까운 사물 뒤에 **구멍(disocclusion)**을 남긴다 — 의도된 동작. LaMa
  인페인팅으로 시각적으로 메우되, 기하적 복원은 아니다.
- Sketchfab 전문 모델링 GLB(예: `the_smoking_room.glb`, 40MB·14메쉬)의 "깨끗한
  토폴로지"에는 못 미친다. 목표는 "떠 있는 사진"이 아니라 "꽤 예쁜 디오라마".

## 3. 아키텍처

```
[새 페이지] image-to-3d-room.html  (서버리스, file:// 동작)
  ① 사진 업로드 / 샘플(source-room.png)
        │  (최대변 1024로 다운스케일)
        ▼
  ② DepthEstimator ── transformers.js + WebGPU (→WASM 폴백)
        │  Depth Anything V2 Small → 깊이맵(상대)
        ▼
  ③ MeshBuilder ── scripts/depth-mesh.mjs (순수 모듈, 테스트됨)
        │  percentile[2,98] 정규화 → 변위 격자
        │  ★엣지-인식 컬링★ + 바닥/뒷벽 스캐폴드
        ▼
  ④ (단계적) HoleFiller ── LaMa ONNX (onnxruntime-web)
        │  컬링이 남긴 마스크 → 인페인팅 텍스처
        ▼
  ⑤ RoomViewer ── three@0.160 (기존 importmap)
        │  1인칭 워크 + 조명/톤/비네트 폴리시
        ▼
  ⑥ GlbExporter ── GLTFExporter{binary} → .glb 다운로드
```

## 4. 컴포넌트 (각각 독립·계약)

### DepthEstimator (HTML 내 모듈)
- `pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", {device})`,
  `.catch(() => pipeline(..., {device:"wasm"}))` — 기존 스캐너의 OWL-ViT 폴백과 동일.
- 입력: `HTMLImageElement`/canvas. 출력: `{ depth: Float32Array, width, height }`.
- 모델 다운로드(수십 MB)는 1회 캐시. **진행률 콜백** 노출.

### MeshBuilder — `scripts/depth-mesh.mjs` (순수 함수, import 가능, 테스트 대상)
- 입력: `{ depth, width, height, params }`, 출력: `{ positions, uvs, indices, culledCount }`.
- 순수 로직:
  1. **percentile [2,98] 정규화 → [0,1]** (Python 선행본 `estimate_depth`와 동일 공식).
  2. 격자 생성(캡 ~320×240): 깊이를 격자로 다운샘플, 각 정점을 변위.
  3. **엣지-인식 컬링**: quad의 두 삼각형 각각에서 정점 깊이 최대차 > `edgeThreshold`이면
     그 삼각형을 인덱스에서 **제외**. (Python본엔 없는, 접근 A의 핵심 추가.)
  4. **바닥/뒷벽 스캐폴드**: 정규화 깊이 하위 N%(바닥)·최원거리(뒷벽)에 평면 추가로
     "방" 골격 부여(떠 있는 사진 방지). 파라미터로 on/off.
- 부수효과·DOM·THREE 의존 없음 → Node 헤드리스 테스트 가능.

### HoleFiller (단계적, Tier 1.5) — LaMa ONNX
- `onnxruntime-web`로 LaMa(51M) 브라우저 실행. 컬링 마스크 → 인페인팅된 텍스처 반환.
- 실패/미지원 시 **건너뛰고 원본 텍스처 사용**(graceful). MVP는 이것 없이도 동작.

### RoomViewer (HTML 내)
- three@0.160 씬·1인칭/오빗 컨트롤(기존 스캐너 패턴 재사용).
- **재질은 `MeshBasicMaterial`(unlit)** — 사진에 조명이 구워져 있어 lit이면 이중음영.
- 폴리시: 환경광/톤매핑/비네트(기존 image-blaster HTML 스타일 차용), 텍스처 이방성 필터.

### GlbExporter (HTML 내)
- `GLTFExporter` `{ binary:true }`. 텍스처 임베드. 노드/메쉬 이름
  **`depth-anything-v2-textured-room-mesh`** 유지 → 기존 image-blaster 뷰어가 인식.

### UI 셸 (HTML 내)
- 드롭존 + 샘플 선택 + 모델 다운로드 진행률 + 슬라이더(깊이 스케일 / **엣지 임계값** /
  격자 해상도 / 스캐폴드 on-off) + "걸어보기" + "**.glb 내보내기**".

## 5. 데이터 흐름

```
photo
  → DepthEstimator → { depth, w, h }
  → MeshBuilder(depth, w, h, params) → { positions, uvs, indices }
  → [HoleFiller(texture, mask)] → texture'
  → RoomViewer.render(geometry, texture')
  → GlbExporter.export() → roomId.glb
```

## 6. 에러 처리 (기존 철학 미러링)

- WebGPU 없음 → WASM 폴백 + 안내(Azure→브라우저 폴백 철학과 동일).
- 모델 다운로드 실패/오프라인 → 명확한 메시지, 샘플로 데모 유지.
- 초대형 이미지 → 최대변 1024 다운스케일 후 추론.
- 파일 없음 → `public/assets/generated/early-joseon-room/source-room.png` 샘플.
- LaMa 미지원/실패 → 인페인팅 생략, 원본 텍스처로 진행.

## 7. 테스트 (`node --test` + `assert.match`, 기존 패턴)

- **`tests/depth-mesh.test.mjs`** (순수 MeshBuilder 단위):
  - (a) 합성 깊이배열 → 기대 정점 수.
  - (b) **깊이 절벽(cliff) 합성 입력 → 엣지 컬링이 해당 삼각형을 버리는지** (핵심 동작).
  - (c) 정규화 결과가 [0,1] 범위.
  - (d) 스캐폴드 on 시 바닥/뒷벽 정점이 추가되는지.
- **HTML 마커 테스트**(기존 home-study 스타일): `image-to-3d-room.html`에 importmap,
  `GLTFExporter`, `depth-estimation`, `depth-mesh.mjs`, `MeshBasicMaterial` 참조가 있는지.
- DepthEstimator·LaMa 추론은 모델 다운로드 필요 → CI 단위테스트 제외, 수동 통합 검증.

## 8. 파일

| 파일 | 상태 | 역할 |
|---|---|---|
| `image-to-3d-room.html` | 신규 | 페이지·UI·뷰어·내보내기(서버리스) |
| `scripts/depth-mesh.mjs` | 신규 | 순수 MeshBuilder(정규화·격자·엣지컬링·스캐폴드), HTML+테스트 공유 |
| `tests/depth-mesh.test.mjs` | 신규 | MeshBuilder 단위 + HTML 마커 |
| `public/assets/generated/early-joseon-room/source-room.png` | 기존 | 샘플 입력 재사용 |

## 9. 향후 (Tier 2, 별도 spec)

- Azure ML/Foundry GPU에 **MoGe-2**(깨끗한 포인트맵+FOV+법선) 또는 **Flash3D**
  (피드포워드 단일이미지→층상 3DGS) 또는 **Pano2Room**(360° 복원) 호스팅.
- 산출물(`.glb`/`.spz`/`.ply`)을 브라우저 splat 뷰어(antimatter15/splat, Visionary WebGPU,
  SuperSplat)로 서버리스 렌더 → World-Labs급 "예쁜 걸어다니는 방".
- Claude: 인페인팅/장면 프롬프트, 캡션, 개념→사물 매핑(픽셀 생성 아님).

## 10. 참고 출처

- Depth Anything V2 — https://github.com/DepthAnything/Depth-Anything-V2
- MoGe / MoGe-2 (Microsoft, CVPR'25 Oral) — https://github.com/microsoft/MoGe
- Flash3D — https://github.com/eldar/flash3d
- Pano2Room (SIGGRAPH Asia'24) — https://github.com/TrickyGo/Pano2Room
- LaMa 브라우저 ONNX — https://huggingface.co/opencv/inpainting_lama
- 브라우저 splat 뷰어 — https://github.com/antimatter15/splat
