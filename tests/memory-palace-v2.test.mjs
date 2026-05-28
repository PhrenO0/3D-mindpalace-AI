import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function readProjectFile(path) {
  return readFile(new URL(path, root), "utf8");
}

test("server is a share-ready VWorld exterior demo", async () => {
  const server = await readProjectFile("server.mjs");

  assert.match(server, /vworld_3d_map_live\.html/);
  assert.match(server, /vworld-exterior-palace/);
  assert.match(server, /\/api\/client-config/);
  assert.doesNotMatch(server, /multer|openai|analyze-pdf|suggest-mapping|chat-mapping/);
  assert.doesNotMatch(server, /CESIUM_ION_TOKEN|cesiumIonToken|cesiumTokenConfigured/);
});

test("package keeps only the dependencies needed to share and run the demo", async () => {
  const pkg = JSON.parse(await readProjectFile("package.json"));

  assert.equal(pkg.scripts.dev, "node server.mjs");
  assert.equal(pkg.scripts.test, "node --test tests/*.test.mjs");
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["dotenv", "express"]);
});

test("VWorld page maps five exterior pavilions by real geography", async () => {
  const html = await readProjectFile("vworld_3d_map_live.html");

  assert.match(html, /광화문 기억궁전 외관 루트/);
  assert.match(html, /PALACE_BUILDINGS/);
  assert.match(html, /lon:\s*126\.97686/);
  assert.match(html, /lat:\s*37\.57072/);
  assert.match(html, /room-03-sejong\.html/);
  assert.match(html, /대표 3D 방/);
  assert.match(html, /projectGeoToScreen/);
  assert.match(html, /syncBuildingPositions/);
  assert.match(html, /Cartesian3\.fromDegrees/);
  assert.match(html, /facility_build/);
  assert.doesNotMatch(html, /screen:\s*\{/);
  assert.doesNotMatch(html, /CesiumIonAuthPlugin|TilesRenderer|Google Photorealistic 3D Tiles/);
});

test("Sejong representative room is a real interactive Three.js memory room", async () => {
  const html = await readProjectFile("room-03-sejong.html");

  assert.match(html, /조선의 제도와 문화/);
  assert.match(html, /three\.module\.js/);
  assert.match(html, /ROOM_OBJECTS/);
  assert.match(html, /hunminjeongeum-book/);
  assert.match(html, /jiphyeonjeon-archive/);
  assert.match(html, /science-sundial/);
  assert.match(html, /law-stone-tablet/);
  assert.match(html, /state-map/);
  assert.match(html, /WASD/);
  assert.match(html, /Raycaster/);
  assert.match(html, /PointerEvent|pointermove|pointerdown/);
  assert.match(html, /clampPlayer/);
  assert.match(html, /memory-palace-spec\.mock\.json/);
});

test("mock MemoryPalaceSpec links concepts to room objects and placements", async () => {
  const spec = JSON.parse(await readProjectFile("public/memory-palace-spec.mock.json"));

  assert.equal(spec.title, "광화문 조선 기억궁전");
  assert.equal(spec.rooms.length, 1);
  assert.equal(spec.rooms[0].id, "room-03-sejong");
  assert.equal(spec.rooms[0].concepts.length, 5);
  assert.equal(spec.placements.length, 5);
  assert.deepEqual(
    spec.placements.map((placement) => placement.objectId).sort(),
    [
      "hunminjeongeum-book",
      "jiphyeonjeon-archive",
      "law-stone-tablet",
      "science-sundial",
      "state-map"
    ]
  );
});

test("project docs are readable Korean handoff documents", async () => {
  const readme = await readProjectFile("README.md");
  const checkpoints = await readProjectFile("PROJECT_CHECKPOINTS.md");

  assert.match(readme, /광화문 VWorld 기억궁전/);
  assert.match(readme, /1주차 3D 팀 데모/);
  assert.match(readme, /npm install/);
  assert.match(readme, /VWORLD_API_KEY/);
  assert.doesNotMatch(readme, /58278910-86B1-357A-861F-B07103B3C78E/);

  assert.match(checkpoints, /현재 적용된 것/);
  assert.match(checkpoints, /앞으로 해야 할 것/);
});
