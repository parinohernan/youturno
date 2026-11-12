import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("vite"))("esbuild");
const alias = { react: "preact/compat", "react-dom": "preact/compat", "react/jsx-runtime": "preact/jsx-runtime" };

function nodes(node: any): any[] {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}

test("public company details keep contact as text and allow only safe website/logo links", async () => {
  const result = await build({ entryPoints: [new URL("../components/company-public-details.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false, alias });
  const { CompanyPublicDetails, safeWebsite } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
  const company = { name: "Salon <script>", address: "<img onerror=bad()>", description: "About us", phone: "+123",
    public_email: "public@example.test", website: "https://example.test", logo_url: "/api/public/salon/logo?v=revision-1" };
  const tree = nodes(CompanyPublicDetails({ company }));
  assert.equal(tree.find((n) => n.type === "img").props.src, company.logo_url);
  for (const preview of [false, true]) {
    const details = CompanyPublicDetails({ company: { ...company,
      logo_url: preview ? "/api/company/logo?v=revision-1" : company.logo_url }, preview });
    const logo = nodes(details).find((n) => n.type === "img");
    const classes = logo.props.className.split(/\s+/);
    for (const name of ["mx-auto", "block", "h-28", "w-28", "object-contain", "object-center"])
      assert.ok(classes.includes(name), `public and preview logo retain ${name}`);
    assert.doesNotMatch(details.props.className, /text-center/, "only the image is centered");
  }
  assert.ok(tree.includes(company.address));
  assert.ok(tree.includes(company.phone));
  assert.ok(tree.includes(company.public_email));
  const addressQuery = encodeURIComponent(company.address);
  assert.ok(tree.find((n) => n.type === "iframe").props.src.includes(`q=${addressQuery}`));
  assert.ok(tree.find((n) => n.type === "a").props.href.includes(`query=${addressQuery}`));
  const located = nodes(CompanyPublicDetails({ company: { ...company, latitude: -34.6, longitude: -58.38 } }));
  assert.ok(located.find((n) => n.type === "iframe").props.src.includes("q=-34.6%2C-58.38"));
  assert.ok(located.find((n) => n.type === "a").props.href.includes("query=-34.6%2C-58.38"));
  assert.ok(located.includes(company.address), "the written address stays visible");
  const coordinatesOnly = nodes(CompanyPublicDetails({ company: { name: "Located", latitude: 0, longitude: 0 } }));
  assert.ok(coordinatesOnly.find((n) => n.type === "iframe").props.src.includes("q=0%2C0"));
  assert.ok(coordinatesOnly.find((n) => n.type === "a").props.href.includes("query=0%2C0"));
  const partial = nodes(CompanyPublicDetails({ company: { ...company, latitude: -34.6 } }));
  assert.ok(partial.find((n) => n.type === "iframe").props.src.includes(`q=${addressQuery}`));
  assert.ok(tree.every((n) => !n.props?.dangerouslySetInnerHTML));
  assert.equal(tree.find((n) => n.type === "a").props.rel, "noopener noreferrer");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "//example.test", "https://user:pass@example.test"])
    assert.equal(safeWebsite(value), null);
  assert.ok(safeWebsite("http://example.test"));
  const unsafe = nodes(CompanyPublicDetails({ company: { ...company, website: "javascript:bad()", logo_url: "data:image/svg+xml,x" } }));
  assert.equal(unsafe.some((n) => n.type === "img"), false);
  assert.ok(unsafe.filter((n) => n.type === "a").every((n) => n.props.href.startsWith("https://www.google.com/maps/")),
    "only the derived Maps link may render alongside an unsafe website/logo");
  const empty = nodes(CompanyPublicDetails({ company: { name: "Empty", social_links: {} } }));
  assert.equal(empty.some((n) => n.type === "a" || n.type === "nav"), false);
  const social = nodes(CompanyPublicDetails({ company: { name: "Salon", social_links: {
    instagram: "https://instagram.com/example", facebook: "https://m.facebook.com/example",
    tiktok: "https://vm.tiktok.com/example", youtube: "https://youtu.be/example", linkedin: "https://linkedin.com/company/example",
  } } }));
  assert.equal(social.filter((n) => n.type === "a").length, 5);
  for (const link of social.filter((n) => n.type === "a")) {
    assert.equal(link.props.rel, "noopener noreferrer"); assert.equal(link.props.target, "_blank");
    assert.match(link.props["aria-label"], /de Salon$/);
  }
  assert.equal(social.some((n) => ["img", "iframe", "script"].includes(n.type)), false);
  const badSocial = nodes(CompanyPublicDetails({ company: { social_links: { instagram: "javascript:bad()" } } }));
  assert.equal(badSocial.some((n) => n.type === "a" || n.type === "nav"), false);
});

test("tenant profile renders editable public fields, local raster chooser and shared UTC hours editor", async () => {
  const result = await build({ entryPoints: [new URL("../components/company-profile.tsx", import.meta.url).pathname],
    bundle: true, platform: "node", format: "esm", write: false, alias,
    plugins: [{ name: "profile-render", setup(builder: any) {
      builder.onResolve({ filter: /^preact\/hooks$/ }, (args: { importer: string }) =>
        args.importer.endsWith("/company-profile.tsx") ? { path: "hooks", namespace: "profile-render" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "profile-render" }, () => ({ contents: `
        let index = 0;
        export const useState = (initial) => [globalThis.__profileRender[index++] ?? initial, () => {}];
        export const useEffect = () => {};
      ` }));
    } }] });
  const globals = globalThis as any;
  const previous = globals.__profileRender;
  const hours = { mon: [["09:00", "18:00"]] };
  globals.__profileRender = [{ name: "Salon", description: "About", address: "Street", phone: "123",
    public_email: "public@example.test", website: "https://example.test", social_links: { instagram: "https://instagram.com/example" },
    logo_url: "/api/company/logo?v=1", business_hours: hours }, hours, false, ""];
  try {
    const { CompanyProfilePage } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    const tree = nodes(CompanyProfilePage({ refreshSession: async () => {} }));
    const inputs = tree.filter((n) => n.type === "input");
    assert.equal(inputs.length, 13);
    assert.equal(inputs.find((n) => n.props.type === "checkbox")?.props.checked, false);
    assert.ok(tree.includes("Permitir registros sin verificación"));
    assert.equal(inputs.find((n) => n.props.placeholder?.includes("instagram")).props.value, "https://instagram.com/example");
    assert.equal(inputs.find((n) => n.props.placeholder?.includes("facebook")).props.value, "");
    assert.ok(tree.includes("Redes sociales"));
    assert.equal(inputs.find((n) => n.props.type === "file").props.accept, "image/png,image/jpeg");
    assert.equal(inputs.find((n) => n.props.type === "email").props.value, "public@example.test");
    assert.ok(tree.some((n) => n.props?.hours === hours && typeof n.props.onChange === "function"), "reuse shared weekly editor");
    assert.ok(tree.includes("Horarios generales (UTC)"));
    assert.ok(tree.includes("Quitar logo"));
    assert.ok(tree.includes("Perfil de empresa"));
  } finally {
    if (previous === undefined) delete globals.__profileRender;
    else globals.__profileRender = previous;
  }
});
