# 2D 사진 → 걸어다니는 3D 방 변환기 (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 방 사진 1장을 브라우저(서버리스)에서 깊이추정 → 엣지-인식 변위 메쉬로 변환해 걸어다니고 `.glb`로 내보내는 변환기를 만든다.

**Architecture:** 순수 지오메트리 로직(`scripts/depth-mesh.mjs`)은 Node에서 TDD로 검증한다. 브라우저 추론·렌더·내보내기(`image-to-3d-room.html`)는 transformers.js(Depth Anything V2) + three@0.160 + GLTFExporter로 구성하고, 자동 테스트는 마커 검증 + 수동 통합 검증으로 한다.

**Tech Stack:** Node `--test`(ESM), `@huggingface/transformers@3`(depth-estimation, WebGPU→WASM 폴백), `three@0.160`(GLTFExporter/OrbitControls), 순수 JS 모듈.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `scripts/depth-mesh.mjs` (신규) | 순수 함수: `percentile`, `normalizeDepth`, `resampleDepth`, `buildDepthMesh`(격자+엣지컬링+스캐폴드). DOM/THREE 의존 0 |
| `tests/depth-mesh.test.mjs` (신규) | 위 함수 단위 테스트 + HTML 마커 테스트 |
| `image-to-3d-room.html` (신규) | UI·DepthEstimator·RoomViewer·GlbExporter (서버리스) |
| `public/assets/generated/early-joseon-room/source-room.png` (기존) | 샘플 입력 |

규약: 정점 인덱스 `i = y*cols + x`. 깊이 격자도 동일 인덱싱(정점 인덱스 == 격자 인덱스). 삼각형 순서 `[a,c,b, b,c,d]` (a=좌상, b=우상, c=좌하, d=우하) — Python 선행본과 동일.

---

## Task 1: percentile + normalizeDepth

**Files:**
- Create: `scripts/depth-mesh.mjs`
- Test: `tests/depth-mesh.test.mjs`

- [ ] **Step 1: Write the failing test**

`tests/depth-mesh.test.mjs`:
```js
import assert from "node:assert/strict";
import test from "node:test";
import { percentile, normalizeDepth } from "../scripts/depth-mesh.mjs";

test("percentile: linear interpolation at bounds and middle", () => {
  const s = Float32Array.from({ length: 101 }, (_, i) => i); // 0..100 sorted
  assert.equal(percentile(s, 0), 0);
  assert.equal(percentile(s, 100), 100);
  assert.equal(percentile(s, 50), 50);
});

test("normalizeDepth: clips to [0,1] and is robust to one outlier", () => {
  const depth = Float32Array.from({ length: 100 }, (_, i) => i);
  depth[99] = 100000; // outlier should be clipped by p98, not blow the scale
  const out = normalizeDepth(depth, { loPct: 2, hiPct: 98 });
  assert.equal(out.length, depth.length);
  let min = Infinity, max = -Infinity;
  for (const v of out) { if (v < min) min = v; if (v > max) max = v; }
  assert.equal(min, 0);
  assert.equal(max, 1);
  // a value below p98 (e.g. index 50) must stay strictly between 0 and 1
  assert.ok(out[50] > 0 && out[50] < 1, `mid=${out[50]}`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: FAIL — `Cannot find module '../scripts/depth-mesh.mjs'`.

- [ ] **Step 3: Write minimal implementation**

`scripts/depth-mesh.mjs`:
```js
// 순수 지오메트리 로직 — DOM/THREE 의존 없음. 브라우저와 Node 테스트가 공유 import.

export function percentile(sortedAsc, p) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const frac = rank - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

export function normalizeDepth(depth, { loPct = 2, hiPct = 98 } = {}) {
  const sorted = Float32Array.from(depth).sort(); // 타입배열은 수치 정렬
  const lo = percentile(sorted, loPct);
  const hi = percentile(sorted, hiPct);
  const span = Math.max(hi - lo, 1e-6);
  const out = new Float32Array(depth.length);
  for (let i = 0; i < depth.length; i++) {
    let v = (depth[i] - lo) / span;
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/depth-mesh.mjs tests/depth-mesh.test.mjs
git commit -m "feat(depth-mesh): percentile + normalizeDepth 순수 함수 + 테스트"
```

---

## Task 2: resampleDepth (full-res → 격자 다운샘플)

**Files:**
- Modify: `scripts/depth-mesh.mjs`
- Test: `tests/depth-mesh.test.mjs`

- [ ] **Step 1: Write the failing test**

`tests/depth-mesh.test.mjs`에 추가 (상단 import에 `resampleDepth` 추가):
```js
import { percentile, normalizeDepth, resampleDepth } from "../scripts/depth-mesh.mjs";

test("resampleDepth: constant field stays constant", () => {
  const src = new Float32Array(16).fill(0.42); // 4x4
  const out = resampleDepth(src, 4, 4, 2, 2);
  assert.equal(out.length, 4);
  for (const v of out) assert.ok(Math.abs(v - 0.42) < 1e-6);
});

test("resampleDepth: corners preserved when resizing to same grid corners", () => {
  // 2x2 source: TL=0, TR=1, BL=2, BR=3
  const src = Float32Array.of(0, 1, 2, 3);
  const out = resampleDepth(src, 2, 2, 2, 2);
  assert.deepEqual([...out], [0, 1, 2, 3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: FAIL — `resampleDepth is not a function`.

- [ ] **Step 3: Write minimal implementation**

`scripts/depth-mesh.mjs`에 추가:
```js
export function resampleDepth(depth, width, height, cols, rows) {
  const out = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    const sy = rows === 1 ? 0 : (y / (rows - 1)) * (height - 1);
    const y0 = Math.floor(sy);
    const y1 = Math.min(y0 + 1, height - 1);
    const fy = sy - y0;
    for (let x = 0; x < cols; x++) {
      const sx = cols === 1 ? 0 : (x / (cols - 1)) * (width - 1);
      const x0 = Math.floor(sx);
      const x1 = Math.min(x0 + 1, width - 1);
      const fx = sx - x0;
      const a = depth[y0 * width + x0];
      const b = depth[y0 * width + x1];
      const c = depth[y1 * width + x0];
      const d = depth[y1 * width + x1];
      const top = a * (1 - fx) + b * fx;
      const bot = c * (1 - fx) + d * fx;
      out[y * cols + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/depth-mesh.mjs tests/depth-mesh.test.mjs
git commit -m "feat(depth-mesh): resampleDepth 양선형 다운샘플 + 테스트"
```

---

## Task 3: buildDepthMesh — 변위 격자 + 엣지-인식 컬링

**Files:**
- Modify: `scripts/depth-mesh.mjs`
- Test: `tests/depth-mesh.test.mjs`

- [ ] **Step 1: Write the failing test**

import에 `buildDepthMesh` 추가 후:
```js
import { percentile, normalizeDepth, resampleDepth, buildDepthMesh } from "../scripts/depth-mesh.mjs";

test("buildDepthMesh: flat 3x3 grid -> full vertices, no culling", () => {
  const depth = new Float32Array(9).fill(0.5);
  const m = buildDepthMesh({ depth, cols: 3, rows: 3, edgeThreshold: 1, scaffold: false });
  assert.equal(m.positions.length, 27); // 9 verts * 3
  assert.equal(m.uvs.length, 18);       // 9 verts * 2
  assert.equal(m.indices.length, 24);   // 4 quads * 2 tris * 3
  assert.equal(m.culledTriangles, 0);
});

test("buildDepthMesh: depth cliff -> boundary triangles are culled", () => {
  // 3x2 grid, left 2 cols near (0.1), right col far (0.9)
  const depth = Float32Array.of(0.1, 0.1, 0.9, 0.1, 0.1, 0.9);
  const culled = buildDepthMesh({ depth, cols: 3, rows: 2, edgeThreshold: 0.08, scaffold: false });
  assert.equal(culled.culledTriangles, 2);
  assert.equal(culled.indices.length, 6); // 4 tris total - 2 culled = 2 tris

  const kept = buildDepthMesh({ depth, cols: 3, rows: 2, edgeThreshold: 1, scaffold: false });
  assert.equal(kept.culledTriangles, 0);
  assert.equal(kept.indices.length, 12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: FAIL — `buildDepthMesh is not a function`.

- [ ] **Step 3: Write minimal implementation**

`scripts/depth-mesh.mjs`에 추가:
```js
export function buildDepthMesh(opts) {
  const {
    depth, cols, rows,
    depthScale = 2.15,
    edgeThreshold = 0.08,
    scaffold = false,
    worldWidth = 12.0,
    baseZ = -5.0,
    aspect = null, // height/width of source; null이면 rows/cols 사용
  } = opts;

  const worldHeight = worldWidth * (aspect ?? rows / cols);
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let y = 0; y < rows; y++) {
    const v = rows === 1 ? 0 : y / (rows - 1);
    const worldY = (0.5 - v) * worldHeight + 2.15;
    for (let x = 0; x < cols; x++) {
      const u = cols === 1 ? 0 : x / (cols - 1);
      const worldX = (u - 0.5) * worldWidth;
      const dd = depth[y * cols + x];
      const worldZ = baseZ + dd * depthScale;
      positions.push(worldX, worldY, worldZ);
      uvs.push(u, v);
    }
  }

  let culledTriangles = 0;
  const pushTri = (i0, i1, i2) => {
    const maxDiff = Math.max(
      Math.abs(depth[i0] - depth[i1]),
      Math.abs(depth[i1] - depth[i2]),
      Math.abs(depth[i0] - depth[i2]),
    );
    if (maxDiff > edgeThreshold) { culledTriangles++; return; }
    indices.push(i0, i1, i2);
  };

  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const a = y * cols + x;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      pushTri(a, c, b);
      pushTri(b, c, d);
    }
  }

  if (scaffold) {
    appendScaffold(positions, uvs, indices, { worldWidth, worldHeight, baseZ, depthScale });
  }

  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
    culledTriangles,
  };
}

// 바닥/뒷벽 평면을 추가해 "떠 있는 사진"이 아니라 "방" 골격을 만든다.
function appendScaffold(positions, uvs, indices, { worldWidth, worldHeight, baseZ, depthScale }) {
  const halfW = worldWidth / 2;
  const topY = 0.5 * worldHeight + 2.15;
  const botY = -0.5 * worldHeight + 2.15;
  const backZ = baseZ;
  const nearZ = baseZ + depthScale;
  const base = positions.length / 3;

  // 뒷벽 (TL, TR, BL, BR)
  positions.push(-halfW, topY, backZ, halfW, topY, backZ, -halfW, botY, backZ, halfW, botY, backZ);
  uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
  // 바닥 (back-L, back-R, near-L, near-R)
  positions.push(-halfW, botY, backZ, halfW, botY, backZ, -halfW, botY, nearZ, halfW, botY, nearZ);
  uvs.push(0, 1, 1, 1, 0, 1, 1, 1);

  indices.push(base + 0, base + 2, base + 1, base + 1, base + 2, base + 3); // 뒷벽
  indices.push(base + 4, base + 6, base + 5, base + 5, base + 6, base + 7); // 바닥
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/depth-mesh.mjs tests/depth-mesh.test.mjs
git commit -m "feat(depth-mesh): buildDepthMesh 변위 격자 + 엣지-인식 컬링 + 테스트"
```

---

## Task 4: 스캐폴드 정점 수 검증

**Files:**
- Test: `tests/depth-mesh.test.mjs` (구현은 Task 3에 이미 포함됨 — 본 태스크는 스캐폴드 동작을 못박는 테스트)

- [ ] **Step 1: Write the failing test**

```js
test("buildDepthMesh: scaffold adds floor+back-wall (8 verts, 12 indices)", () => {
  const depth = new Float32Array(9).fill(0.5);
  const off = buildDepthMesh({ depth, cols: 3, rows: 3, edgeThreshold: 1, scaffold: false });
  const on = buildDepthMesh({ depth, cols: 3, rows: 3, edgeThreshold: 1, scaffold: true });
  assert.equal(on.positions.length - off.positions.length, 24); // 8 verts * 3
  assert.equal(on.uvs.length - off.uvs.length, 16);             // 8 verts * 2
  assert.equal(on.indices.length - off.indices.length, 12);     // 4 tris * 3
  assert.equal(on.culledTriangles, off.culledTriangles);        // 스캐폴드는 컬링과 무관
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: PASS — Task 3에서 `appendScaffold`를 이미 구현했으므로 통과해야 한다. 실패하면 Task 3의 `appendScaffold` 정점/인덱스 개수를 점검한다.

- [ ] **Step 3: Commit**

```bash
git add tests/depth-mesh.test.mjs
git commit -m "test(depth-mesh): 스캐폴드 정점/인덱스 개수 회귀 테스트"
```

---

## Task 5: 변환기 HTML 페이지 + 마커 테스트

**Files:**
- Create: `image-to-3d-room.html`
- Test: `tests/depth-mesh.test.mjs` (마커 테스트 추가)

- [ ] **Step 1: Write the failing marker test**

`tests/depth-mesh.test.mjs`에 추가:
```js
import { readFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);

test("image-to-3d-room.html wires depth->mesh->glb pipeline", async () => {
  const html = await readFile(new URL("image-to-3d-room.html", root), "utf8");
  assert.match(html, /three@0\.160\.0\/build\/three\.module\.js/);
  assert.match(html, /GLTFExporter/);
  assert.match(html, /@huggingface\/transformers@3/);
  assert.match(html, /"depth-estimation"/);
  assert.match(html, /depth-anything-v2-small/);
  assert.match(html, /\.\/scripts\/depth-mesh\.mjs/);
  assert.match(html, /buildDepthMesh/);
  assert.match(html, /MeshBasicMaterial/);          // unlit (이중음영 방지)
  assert.match(html, /device:\s*"wasm"/);           // WebGPU->WASM 폴백
  assert.match(html, /depth-anything-v2-textured-room-mesh/); // 기존 뷰어 호환 네이밍
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: FAIL — `ENOENT image-to-3d-room.html`.

- [ ] **Step 3: Create the HTML page (전체)**

`image-to-3d-room.html`:
```html
<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>2D 사진 → 걸어다니는 3D 방 (Tier 1)</title>
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0d0a07; color: #fff8ea;
      font-family: "Malgun Gothic", system-ui, sans-serif; overflow: hidden; }
    #scene { position: fixed; inset: 0; }
    .panel { position: fixed; z-index: 5; background: rgba(18,12,6,.82);
      border: 1px solid rgba(255,236,197,.25); border-radius: 10px;
      backdrop-filter: blur(12px); padding: 14px 16px; }
    .left { left: 16px; top: 16px; width: min(330px, calc(100vw - 32px)); }
    h1 { margin: 0 0 6px; font-size: 18px; }
    p.sub { margin: 0 0 12px; font-size: 12px; color: #ddc8a5; line-height: 1.5; }
    label { display: block; font-size: 11px; margin: 10px 0 3px; color: #e5bb63; }
    input[type=range] { width: 100%; }
    button { height: 34px; padding: 0 12px; margin-top: 6px; font: inherit;
      font-weight: 800; font-size: 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid rgba(255,236,197,.3); background: rgba(255,255,255,.08);
      color: #fff8ea; }
    button:hover { border-color: #e5bb63; background: rgba(229,187,99,.18); }
    button:disabled { opacity: .5; cursor: default; }
    #status { font-size: 12px; color: #8fd0ad; margin-top: 10px; min-height: 16px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    #drop { border: 1px dashed rgba(255,236,197,.4); border-radius: 8px;
      padding: 12px; text-align: center; font-size: 12px; cursor: pointer; }
    .hint { position: fixed; right: 16px; bottom: 14px; z-index: 5; font-size: 11px;
      color: #ddc8a5; }
  </style>
</head>
<body>
  <main id="scene"></main>

  <section class="panel left">
    <h1>2D 사진 → 3D 방</h1>
    <p class="sub">사진 한 장을 브라우저에서 깊이추정 → 입체 메쉬로 바꿔 걸어다니고
      .glb로 내보냅니다. 외부 API·서버 없이 동작합니다.</p>

    <div id="drop">📷 사진을 드롭하거나 클릭해서 선택</div>
    <input id="file" type="file" accept="image/*" hidden />
    <div class="row">
      <button id="sampleBtn">샘플 방 쓰기</button>
      <button id="convertBtn" disabled>변환</button>
    </div>

    <label>깊이 스케일 <span id="vScale">2.15</span></label>
    <input id="depthScale" type="range" min="0.5" max="5" step="0.05" value="2.15" />
    <label>엣지 임계값(작을수록 잘 끊김) <span id="vEdge">0.08</span></label>
    <input id="edgeThreshold" type="range" min="0.02" max="0.5" step="0.01" value="0.08" />
    <label>격자 해상도 <span id="vRes">160</span></label>
    <input id="gridCols" type="range" min="80" max="320" step="20" value="160" />
    <label class="row" style="align-items:center;gap:6px;">
      <input id="scaffold" type="checkbox" checked /> 바닥/뒷벽 스캐폴드
    </label>

    <div class="row">
      <button id="exportBtn" disabled>.glb 내보내기</button>
    </div>
    <div id="status">대기 중 — 사진을 넣으세요.</div>
  </section>

  <div class="hint">WASD/방향키 이동 · 마우스 드래그 회전 · 휠 줌</div>

  <script type="importmap">
    {
      "imports": {
        "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
        "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
      }
    }
  </script>
  <script type="module">
    import * as THREE from "three";
    import { OrbitControls } from "three/addons/controls/OrbitControls.js";
    import { GLTFExporter } from "three/addons/exporters/GLTFExporter.js";
    import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";
    import { normalizeDepth, resampleDepth, buildDepthMesh } from "./scripts/depth-mesh.mjs";

    env.allowLocalModels = false;

    const $ = (id) => document.getElementById(id);
    const status = $("status");
    const setStatus = (t) => { status.textContent = t; };

    // ---- three 씬 ----
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0a07);
    const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000);
    camera.position.set(0, 2.1, 2.2);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    $("scene").appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 2.1, -3);
    controls.update();

    // 프레젠테이션 폴리시: 은은한 환경광 + 비네트 느낌의 배경 그라데이션은 CSS로 충분.
    scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    let currentMesh = null;
    let sourceImage = null; // HTMLImageElement
    let detector = null;

    addEventListener("resize", () => {
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(innerWidth, innerHeight);
    });

    // WASD 이동
    const keys = {};
    addEventListener("keydown", (e) => { keys[e.key.toLowerCase()] = true; });
    addEventListener("keyup", (e) => { keys[e.key.toLowerCase()] = false; });
    function moveCamera() {
      const sp = 0.05;
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
      if (keys["w"] || keys["arrowup"]) { camera.position.addScaledVector(fwd, sp); controls.target.addScaledVector(fwd, sp); }
      if (keys["s"] || keys["arrowdown"]) { camera.position.addScaledVector(fwd, -sp); controls.target.addScaledVector(fwd, -sp); }
      if (keys["a"] || keys["arrowleft"]) { camera.position.addScaledVector(right, -sp); controls.target.addScaledVector(right, -sp); }
      if (keys["d"] || keys["arrowright"]) { camera.position.addScaledVector(right, sp); controls.target.addScaledVector(right, sp); }
    }

    (function loop() {
      requestAnimationFrame(loop);
      moveCamera();
      controls.update();
      renderer.render(scene, camera);
    })();

    // ---- 이미지 로드 ----
    function loadImage(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      });
    }
    function setSource(img) {
      sourceImage = img;
      $("convertBtn").disabled = false;
      setStatus(`이미지 로드됨 (${img.naturalWidth}×${img.naturalHeight}). '변환'을 누르세요.`);
    }

    $("drop").onclick = () => $("file").click();
    $("file").onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      setSource(await loadImage(URL.createObjectURL(f)));
    };
    $("drop").ondragover = (e) => e.preventDefault();
    $("drop").ondrop = async (e) => {
      e.preventDefault();
      const f = e.dataTransfer.files[0]; if (!f) return;
      setSource(await loadImage(URL.createObjectURL(f)));
    };
    $("sampleBtn").onclick = async () => {
      try {
        setSource(await loadImage("./public/assets/generated/early-joseon-room/source-room.png"));
      } catch { setStatus("샘플 로드 실패 — file://에서는 같은 폴더 경로가 필요합니다."); }
    };

    // 슬라이더 표시
    for (const [id, out] of [["depthScale","vScale"],["edgeThreshold","vEdge"],["gridCols","vRes"]]) {
      $(id).oninput = () => { $(out).textContent = $(id).value; };
    }

    // ---- 깊이 추정 (WebGPU -> WASM 폴백) ----
    async function getDetector() {
      if (detector) return detector;
      setStatus("깊이 모델 다운로드 중… (최초 1회, 수십 MB)");
      detector = await pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", { device: "webgpu" })
        .catch(() => pipeline("depth-estimation", "onnx-community/depth-anything-v2-small", { device: "wasm" }));
      return detector;
    }

    // 최대변 1024로 다운스케일한 캔버스 반환
    function toScaledCanvas(img, maxEdge = 1024) {
      const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.round(img.naturalWidth * scale);
      const h = Math.round(img.naturalHeight * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      return c;
    }

    // ---- 변환 파이프라인 ----
    $("convertBtn").onclick = async () => {
      if (!sourceImage) return;
      try {
        const det = await getDetector();
        const canvas = toScaledCanvas(sourceImage);
        setStatus("깊이 추정 중…");
        const out = await det(canvas.toDataURL());
        // transformers.js depth-estimation: out.depth (RawImage) 또는 out.predicted_depth
        const raw = out.depth ?? out;
        const w = raw.width, h = raw.height;
        const data = raw.data; // Uint8/Float typed array, 1채널
        const depthFull = Float32Array.from(data, (v) => v);

        const cols = parseInt($("gridCols").value, 10);
        const rows = Math.max(40, Math.round(cols * h / w));
        const grid = resampleDepth(depthFull, w, h, cols, rows);
        const norm = normalizeDepth(grid, { loPct: 2, hiPct: 98 });
        const mesh = buildDepthMesh({
          depth: norm, cols, rows,
          depthScale: parseFloat($("depthScale").value),
          edgeThreshold: parseFloat($("edgeThreshold").value),
          scaffold: $("scaffold").checked,
          aspect: h / w,
        });

        renderMesh(mesh, canvas);
        $("exportBtn").disabled = false;
        setStatus(`변환 완료. 컬링된 삼각형 ${mesh.culledTriangles}개. 걸어보세요.`);
      } catch (err) {
        console.error(err);
        setStatus("변환 실패: " + err.message);
      }
    };

    function renderMesh(mesh, textureCanvas) {
      if (currentMesh) { scene.remove(currentMesh); currentMesh.geometry.dispose(); }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
      geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      geo.computeVertexNormals();

      const tex = new THREE.CanvasTexture(textureCanvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      // unlit: 사진에 이미 조명이 구워져 있어 lit이면 이중음영
      const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });

      currentMesh = new THREE.Mesh(geo, mat);
      currentMesh.name = "depth-anything-v2-textured-room-mesh";
      scene.add(currentMesh);
    }

    // ---- GLB 내보내기 ----
    $("exportBtn").onclick = () => {
      if (!currentMesh) return;
      new GLTFExporter().parse(currentMesh, (glb) => {
        const blob = new Blob([glb], { type: "model/gltf-binary" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "image-to-3d-room.glb";
        a.click();
        setStatus(".glb 내보내기 완료.");
      }, (e) => setStatus("내보내기 실패: " + e), { binary: true });
    };
  </script>
</body>
</html>
```

- [ ] **Step 4: Run marker test to verify it passes**

Run: `node --test tests/depth-mesh.test.mjs`
Expected: PASS (마커 테스트 포함 전체 통과).

- [ ] **Step 5: Commit**

```bash
git add image-to-3d-room.html tests/depth-mesh.test.mjs
git commit -m "feat(viewer): image-to-3d-room.html 변환기 페이지 + 마커 테스트"
```

---

## Task 6: 수동 통합 검증 (브라우저)

브라우저 추론은 CI로 못 돌리므로 사람이 확인한다.

- [ ] **Step 1: 서버 기동**

Run: `npm run dev`
Expected: `http://127.0.0.1:8765` 기동.

- [ ] **Step 2: 페이지 열기**

브라우저에서 `http://127.0.0.1:8765/image-to-3d-room.html` 접속.

- [ ] **Step 3: 샘플 변환**

`샘플 방 쓰기` → `변환` 클릭. 최초엔 모델 다운로드(상태표시줄 "깊이 모델 다운로드 중…").
Expected: 수 초~수십 초 후 입체 메쉬가 보이고 상태표시줄에 "변환 완료. 컬링된 삼각형 N개".

- [ ] **Step 4: 품질 레버 확인**

`엣지 임계값` 슬라이더를 낮춰 다시 `변환` → 가까운 사물과 배경이 더 깔끔히 끊기는지,
`바닥/뒷벽 스캐폴드` 끄고/켜고 다시 `변환` → "방" 골격 유무 확인. WASD로 걸어보며
시차(parallax)가 보이는지 확인.

- [ ] **Step 5: 내보내기·호환 확인**

`.glb 내보내기` → `image-to-3d-room.glb` 다운로드.
Run: `node scripts/inspect-glb.mjs <다운로드경로>/image-to-3d-room.glb`
Expected: 노드/메쉬에 `depth-anything-v2-textured-room-mesh` 존재, POSITION bbox 출력.

- [ ] **Step 6: 결과 기록 커밋 (선택)**

문제 없으면 스크린샷을 `public/screenshots/`에 저장하고 커밋. 실패 시
superpowers:systematic-debugging로 디버깅.

---

## Task 7 (Tier 1.5, 선택): LaMa 인페인팅으로 구멍 메우기

MVP(Task 1~6)는 이것 없이 동작한다. 시각적 구멍이 거슬릴 때만 추가한다.

**Files:**
- Modify: `image-to-3d-room.html`

- [ ] **Step 1: 의존성 추가**

`<script type="module">` 상단에 추가:
```js
import * as ort from "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.webgpu.min.mjs";
```

- [ ] **Step 2: 인페인팅 함수 추가 (graceful)**

```js
// 컬링으로 텍스처에 드러난 구멍을 LaMa로 채운다. 실패 시 원본 텍스처를 그대로 쓴다.
async function inpaintHoles(canvas, maskCanvas) {
  try {
    const session = await ort.InferenceSession.create(
      "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
      { executionProviders: ["webgpu", "wasm"] }
    );
    // 전처리/추론/후처리는 LaMa ONNX 규격(512 정규화 RGB + 1채널 마스크)을 따른다.
    // 상세 텐서 shape는 모델 카드 참조: https://huggingface.co/Carve/LaMa-ONNX
    // 반환: 인페인팅된 ImageData를 maskCanvas 영역에 합성한 canvas
    return canvas; // TODO 단계: 텐서 입출력 구현 후 합성 결과 반환
  } catch (e) {
    console.warn("LaMa 인페인팅 생략:", e);
    return canvas;
  }
}
```

> 주의: 이 태스크는 LaMa 텐서 입출력 구현이 필요하다(모델 카드의 입력 512×512 RGB
> 정규화 + 마스크 규격). 구현 전까지는 `inpaintHoles`가 원본을 그대로 반환하므로 안전하다.
> 마스크는 `buildDepthMesh`가 컬링한 quad 좌표에서 UV 기준으로 생성한다(별도 헬퍼).

- [ ] **Step 3: 수동 검증 후 커밋**

샘플 변환 시 구멍이 자연스럽게 메워지는지 육안 확인.
```bash
git add image-to-3d-room.html
git commit -m "feat(viewer): Tier 1.5 LaMa 인페인팅으로 가림 구멍 메우기"
```

---

## Self-Review 결과

- **Spec coverage:** §3 아키텍처→Task1~6, §4 컴포넌트(DepthEstimator/MeshBuilder/RoomViewer/GlbExporter/UI)→Task5 HTML + Task1~4 모듈, HoleFiller→Task7, §7 테스트→각 태스크 + Task5 마커, §8 파일 전부 생성됨. ✅
- **Placeholder scan:** Task7의 LaMa 텐서 입출력만 의도적으로 미완(선택 태스크, graceful no-op로 안전 명시). MVP(Task1~6)에는 플레이스홀더 없음. ✅
- **Type consistency:** `normalizeDepth/resampleDepth/buildDepthMesh` 시그니처가 모듈 정의와 HTML 호출부에서 일치. 반환 `{positions,uvs,indices,culledTriangles}` 일관. 메쉬 네이밍 `depth-anything-v2-textured-room-mesh` 일관. ✅
