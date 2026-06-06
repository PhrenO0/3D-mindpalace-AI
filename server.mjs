import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8765);
const entryFile = path.join(__dirname, "vworld_3d_map_live.html");

const app = express();

app.use(express.json({ limit: "256kb" }));

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

app.get("/", (_req, res) => {
  res.sendFile(entryFile);
});

// GLB 모델 파일 서빙 (프로젝트 상위 model/ 디렉토리)
const modelDir = path.join(path.dirname(__dirname), "model");
app.use("/models", express.static(modelDir));

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

// Azure App Service 등 호스팅 환경의 리버스 프록시가 닿을 수 있도록 0.0.0.0에 바인딩한다.
// (127.0.0.1에만 바인딩하면 플랫폼 프론트엔드가 못 닿아 503이 난다.)
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`Memory Palace server: http://${HOST}:${PORT}`);
});
