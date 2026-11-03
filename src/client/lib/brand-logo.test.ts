import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("brand logo preserves the complete local image with accessible and decorative variants", async () => {
  const result = await build({
    entryPoints: [new URL("../components/brand-logo.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
  });
  const { BrandLogo } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const logo = BrandLogo({ className: "h-40 w-40" });
  assert.equal(logo.type, "img");
  assert.equal(logo.props.src, "/brand/youturno-logo.jpg");
  assert.equal(logo.props.width, 1254);
  assert.equal(logo.props.height, 1254);
  assert.equal(logo.props.alt, "YouTurno · Gestión de turnos");
  assert.match(logo.props.className, /object-contain/);
  assert.match(logo.props.className, /h-40 w-40/);
  assert.equal(BrandLogo({ decorative: true }).props.alt, "");
});

test("favicon and catalog metadata point to the same local JPEG", () => {
  const root = new URL("../../../", import.meta.url);
  const metadata = JSON.parse(readFileSync(new URL("clawnify.json", root), "utf8"));
  assert.equal(metadata.icon, "public/brand/youturno-logo.jpg");
  const image = readFileSync(new URL(metadata.icon, root));
  assert.equal(image.subarray(0, 3).toString("hex"), "ffd8ff");
  assert.equal(image.subarray(-2).toString("hex"), "ffd9");
  assert.match(readFileSync(new URL("index.html", root), "utf8"), /rel="icon" type="image\/jpeg" href="\/brand\/youturno-logo.jpg"/);
});
