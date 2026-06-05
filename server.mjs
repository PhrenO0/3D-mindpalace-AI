import "dotenv/config";
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8765);
// 루트(/) 진입 파일. VWorld 라이브맵이 있으면 그걸, 없으면(배포본엔 gitignore로 빠질 수 있음)
// 방 스캐너로 폴백한다. → 배포 후 루트 URL이 빈 파일을 열려다 500나는 사고 방지.
const ENTRY_CANDIDATES = ["vworld_3d_map_live.html", "personal-room-scanner-3d.html", "room-viewer.html"];
const entryFile = path.join(__dirname,
  ENTRY_CANDIDATES.find(f => existsSync(path.join(__dirname, f))) || ENTRY_CANDIDATES[0]);

const app = express();

// 스캐너가 렌더 PNG(수 MB)를 /api/detect 로 보내므로 본문 한도를 넉넉히.
// (전역 파서가 먼저 돌기 때문에, 작게 두면 큰 본문이 413→500으로 막힌다.)
app.use(express.json({ limit: "20mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "memory-palace-vworld",
    mode: "vworld-exterior-palace",
    vworldKeyConfigured: Boolean(process.env.VWORLD_API_KEY)
  });
});

app.get("/api/client-config", (_req, res) => {
  res.json({
    vworldApiKey: process.env.VWORLD_API_KEY || ""
  });
});

// ── 방 스캐너: Azure AI Vision 객체검출 프록시 ──────────────────────
// 키를 브라우저에 노출하지 않으려고 서버가 중계한다.
// AZURE_VISION_* 가 비어 있으면 azure:false → 클라이언트는 브라우저 OWL-ViT로 폴백.
const AZURE_ENDPOINT = (process.env.AZURE_VISION_ENDPOINT || "").replace(/\/+$/, "");
const AZURE_KEY = process.env.AZURE_VISION_KEY || "";
const AZURE_READY = Boolean(AZURE_ENDPOINT && AZURE_KEY);

app.get("/api/vision-config", (_req, res) => {
  res.json({ azure: AZURE_READY });
});

// 이미지는 base64라 크다 → 이 라우트만 16MB까지 허용(전역 256KB는 그대로 둠).
app.post("/api/detect", express.json({ limit: "16mb" }), async (req, res) => {
  if (!AZURE_READY) return res.status(503).json({ configured: false, objects: [] });
  try {
    const { imageBase64, width, height } = req.body || {};
    if (!imageBase64) return res.status(400).json({ error: "imageBase64 누락" });
    const bytes = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ""), "base64");

    // Azure AI Vision 4.0 Image Analysis
    //  - objects: 주요 가구 바운딩 박스(보수적, 소수)
    //  - denseCaptions: 영역별 설명 ~10개(화분·조명·창문 등 더 많이) → 박스 + 문장
    const url = `${AZURE_ENDPOINT}/computervision/imageanalysis:analyze?api-version=2024-02-01&features=objects,denseCaptions`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Ocp-Apim-Subscription-Key": AZURE_KEY, "Content-Type": "application/octet-stream" },
      body: bytes
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      return res.status(502).json({ error: `Azure ${r.status}`, detail });
    }
    const data = await r.json();
    const W = width || data.metadata?.width || 1;
    const H = height || data.metadata?.height || 1;
    // 픽셀 박스(x,y,w,h) → 0~1 비율로 정규화. 라벨은 가장 확신 높은 태그.
    const norm = (bb) => ({ xmin: bb.x / W, ymin: bb.y / H, xmax: (bb.x + bb.w) / W, ymax: (bb.y + bb.h) / H });
    const objects = (data.objectsResult?.values || []).map((o) => {
      const tag = (o.tags || [])[0] || {};
      return { label: tag.name || "object", score: tag.confidence ?? 0, box: norm(o.boundingBox || {x:0,y:0,w:0,h:0}) };
    });
    // 첫 캡션[0]은 보통 "전체 이미지" 설명이라 제외. 라벨 추출은 클라이언트가 문장에서 함.
    const captions = (data.denseCaptionsResult?.values || []).slice(1).map((c) => ({
      text: c.text || "", score: c.confidence ?? 0, box: norm(c.boundingBox || {x:0,y:0,w:0,h:0})
    }));
    res.json({ configured: true, source: "azure", objects, captions });
  } catch (error) {
    res.status(500).json({ error: error.message || "detect 실패" });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(entryFile);
});

app.use(express.static(__dirname, {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  }
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error.message || "서버 오류가 발생했습니다."
  });
});

// Azure App Service 등 클라우드는 플랫폼이 PORT를 주고, 앱이 "모든 인터페이스(0.0.0.0)"에서
// 듣기를 기대한다. 로컬 dev는 보안상 localhost만 듣게 유지(WEBSITE_SITE_NAME은 App Service에서만 설정됨).
const HOST = process.env.WEBSITE_SITE_NAME ? "0.0.0.0" : "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`Memory Palace server: http://${HOST}:${PORT}`);
});
