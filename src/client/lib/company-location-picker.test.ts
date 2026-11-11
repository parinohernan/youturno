import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const alias = { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };

test("slippy map Mercator helpers round-trip coordinates and world pixels", async () => {
  const result = await build({ entryPoints: [new URL("../components/company-location-picker.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false, alias });
  const { lngToWorldX, latToWorldY, worldXToLng, worldYToLat } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  for (const zoom of [2, 12, 15, 19]) {
    const size = 256 * 2 ** zoom;
    for (const [lat, lng] of [[0, 0], [-34.6037, -58.3816], [51.5074, -0.1278],
      [85, 179.99], [-85, -179.99], [0, 180], [0, -180]]) {
      const x = lngToWorldX(lng, zoom);
      const y = latToWorldY(lat, zoom);
      assert.ok(Math.abs(worldXToLng(x, zoom) - lng) < 1e-9);
      assert.ok(Math.abs(worldYToLat(y, zoom) - lat) < 1e-9);
      assert.ok(x >= 0 && x <= size && y >= 0 && y <= size);
      assert.ok(Math.abs(lngToWorldX(worldXToLng(x, zoom), zoom) - x) < 1e-7);
      assert.ok(Math.abs(latToWorldY(worldYToLat(y, zoom), zoom) - y) < 1e-7);
    }
    assert.equal(lngToWorldX(-180, zoom), 0);
    assert.equal(lngToWorldX(180, zoom), size);
    assert.equal(latToWorldY(0, zoom), size / 2);
    assert.ok(Math.abs(worldYToLat(0, zoom) - 85.05112878) < 1e-7);
    assert.ok(Math.abs(worldYToLat(size, zoom) + 85.05112878) < 1e-7);
  }
});
