import { chromium, webkit } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(".auto/diag", { recursive: true });

const scenarios = [
  { id: "spec_off", state: { glow: 0, edgeHighlight: 0, specular: 0 } },
  { id: "chroma_off", state: { chroma: 0 } },
  { id: "all_off", state: { glow: 0, edgeHighlight: 0, specular: 0, chroma: 0 } },
  { id: "no_outline_or_frost_glow_0", state: { glow: 0, edgeHighlight: 0, specular: 0, frost: 0 } },
];

for (const [name, type] of [["chromium", chromium], ["webkit", webkit]]) {
  const b = await type.launch();
  const p = await (await b.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
  await p.goto("http://127.0.0.1:8132/index.html");
  await p.waitForFunction("window.__ready === true");
  await p.evaluate(() => window.__glass.setTheme("light"));
  for (const s of scenarios) {
    await p.evaluate((s) => window.__glass.set({ posX: 0.5, posY: 0.5, ...s.state }), s);
    await p.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const buf = await (await p.$("#stage")).screenshot();
    writeFileSync(`.auto/diag/${name}_${s.id}.png`, buf);
  }
  await b.close();
}
console.log("diagnostic shots in .auto/diag/");
