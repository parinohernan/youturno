import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");

test("professional avatar reserves geometry and falls back accessibly for missing or failed images", async () => {
  const result = await build({ entryPoints: [new URL("../components/professional-avatar.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "avatar-hooks", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, () => ({ path: "hooks", namespace: "avatar-hooks" }));
      builder.onLoad({ filter: /.*/, namespace: "avatar-hooks" }, () => ({ contents:
        "export const useState = initial => [globalThis.__avatarFailed ?? initial, value => { globalThis.__avatarFailed = value; }];" }));
    } }],
  });
  const { ProfessionalAvatar } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const globals = globalThis as any;
  try {
    let node = ProfessionalAvatar({});
    assert.equal(node.props["aria-hidden"], "true", "adjacent name labels the identity without duplicate speech");
    assert.deepEqual(node.props.style, { width: 44, height: 44 });
    assert.notEqual(node.props.children.type, "img", "missing photo uses a local person icon, not initials");
    node = ProfessionalAvatar({ src: "/api/public/fixture/staff/1/photo?v=one" });
    assert.equal(node.props.children.type, "img");
    assert.equal(node.props.children.props.alt, "");
    assert.equal(node.props.children.props.loading, "lazy");
    assert.equal(node.props.children.props.width, 44); assert.equal(node.props.children.props.height, 44);
    node.props.children.props.onError();
    assert.notEqual(ProfessionalAvatar({ src: "/api/public/fixture/staff/1/photo?v=one" }).props.children.type, "img");
    node = ProfessionalAvatar({ src: "/api/public/fixture/staff/1/photo?v=two", eager: true });
    assert.equal(node.props.children.type, "img", "replacement URL retries a previously failed photo");
    assert.equal(node.props.children.props.loading, "eager");
  } finally { delete globals.__avatarFailed; }
});
