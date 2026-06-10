import { chromium, webkit } from "playwright";
for (const [name, t] of [["chromium", chromium], ["webkit", webkit]]) {
  const b = await t.launch();
  const p = await (await b.newContext()).newPage();
  await p.goto("http://127.0.0.1:8132/index.html");
  await p.waitForFunction("window.__ready === true");
  const r = await p.evaluate(() => ({
    ua: navigator.userAgent,
    safariLike: /Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/i.test(navigator.userAgent),
  }));
  console.log(name, JSON.stringify(r));
  await b.close();
}
