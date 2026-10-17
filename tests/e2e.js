// End-to-end checks for Card profit, run in real headless Chromium.
//   npm install && npm test
// Set CHROMIUM=/path/to/chrome if Playwright's own browser is not installed.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { createServer } = require("./serve");

const SHOTS = path.join(__dirname, "screenshots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? "  PASS  " : "  FAIL  ") + name + (!ok && detail !== undefined ? "   -> " + detail : ""));
}
function eq(name, actual, expected) { check(name, actual === expected, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
function section(t) { console.log("\n" + t); }

const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  try {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const p = path.join(base, d, "chrome-linux", "chrome");
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* fall through to Playwright's default */ }
  return undefined;
}

// default live-rate mocks: frankfurter answers 1.1
async function mockRates(ctx, { frankfurter = 1.1, erapi = 1.2, failFrankfurter = false, failErapi = false } = {}) {
  await ctx.unroute("**/api.frankfurter.dev/**").catch(() => {});
  await ctx.unroute("**/open.er-api.com/**").catch(() => {});
  await ctx.route("**/api.frankfurter.dev/**", (r) =>
    failFrankfurter ? r.abort("failed") : r.fulfill({ json: { base: "EUR", date: "2026-10-16", rates: { USD: frankfurter } } }));
  await ctx.route("**/open.er-api.com/**", (r) =>
    failErapi ? r.abort("failed") : r.fulfill({ json: { result: "success", rates: { USD: erapi } } }));
}

const txt = async (page, sel) => (await page.textContent(sel)).trim();

async function fillCalc(page, card, sell) {
  await page.fill("#displayedPrice", card);
  await page.fill("#sellPrice", sell);
}
async function setSettings(page, { usdt, credit, currency, rate }) {
  const mobile = (await page.viewportSize()).width < 900;
  if (mobile && (await page.getAttribute("#app", "data-view")) !== "settings") await page.click("#settings-btn");
  if (usdt !== undefined) await page.fill("#usdtPrice", usdt);
  if (credit !== undefined) await page.fill("#creditPrice", credit);
  if (currency) await page.check(`input[name="currency"][value="${currency}"]`, { force: true });
  if (rate !== undefined) await page.fill("#eurUsdRate", rate);
  if (mobile) await page.click("#settings-btn");   // Done
}

async function main() {
  const { server, mutations } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = "http://localhost:" + server.address().port + "/";
  const browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });

  async function newPage(opts, ctxOpts = {}) {
    const ctx = await browser.newContext({ ...opts, ...ctxOpts });
    await mockRates(ctx);
    const page = await ctx.newPage();
    page.errors = [];
    page.on("pageerror", (e) => page.errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") page.errors.push("console: " + m.text()); });
    return { ctx, page };
  }

  /* ------------------------------------------------------------------ */
  section("Static checks");
  const pub = path.join(__dirname, "..", "public");
  const appJs = fs.readFileSync(path.join(pub, "app.js"), "utf8");
  const swJs = fs.readFileSync(path.join(pub, "sw.js"), "utf8");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  const appVer = /var APP_VERSION = "([^"]+)"/.exec(appJs)[1];
  const swVer = /const VERSION = "([^"]+)"/.exec(swJs)[1];
  eq("sw.js VERSION matches app.js APP_VERSION", swVer, appVer);
  check("index.html has no inline event handlers", !/\son[a-z]+\s*=\s*["']/i.test(html));
  const manifest = JSON.parse(fs.readFileSync(path.join(pub, "manifest.json"), "utf8"));
  eq("manifest display is standalone", manifest.display, "standalone");
  eq("manifest theme_color", manifest.theme_color, "#0b4a25");
  const pngSize = (f) => { const b = fs.readFileSync(f); return b.toString("ascii", 1, 4) === "PNG" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
  for (const ic of manifest.icons) {
    const s = pngSize(path.join(pub, ic.src));
    check(`manifest icon ${ic.src} (${ic.purpose}) is a real ${ic.sizes} PNG`, s && `${s[0]}x${s[1]}` === ic.sizes, JSON.stringify(s));
  }
  eq("apple-touch-icon is 180x180", pngSize(path.join(pub, "icons/apple-touch-icon.png")).join("x"), "180x180");
  check("manifest has a maskable icon", manifest.icons.some((i) => i.purpose === "maskable"));
  const refs = [...html.matchAll(/(?:href|src)="([^"#]+)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u));
  check("every file referenced by index.html exists", refs.every((u) => fs.existsSync(path.join(pub, u))), refs.filter((u) => !fs.existsSync(path.join(pub, u))).join(","));

  /* ------------------------------------------------------------------ */
  section("Number parsing + formulas (in the page)");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.goto(base);
    const P = (s) => page.evaluate((v) => window.CardProfit.parseNumber(v), s);
    const cases = [["18.84", 18.84], ["18,84", 18.84], [" 3 ", 3], ["1 234,5", 1234.5], ["1,234.56", 1234.56], ["1.234,56", 1234.56],
      [".5", 0.5], ["5.", 5], ["٣٫٣٨", 3.38]];
    for (const [i, o] of cases) { const r = await P(i); check(`parse ${JSON.stringify(i)} -> ${o}`, r.state === "ok" && Math.abs(r.value - o) < 1e-9, JSON.stringify(r)); }
    for (const bad of ["abc", "1e3", "1.2.3", "-5", "12a", "--"]) eq(`parse ${JSON.stringify(bad)} is invalid`, (await P(bad)).state, "invalid");
    for (const e of ["", "   ", null]) eq(`parse ${JSON.stringify(e)} is empty`, (await P(e)).state, "empty");
    const r = await page.evaluate(() => window.CardProfit.compute({ displayedPrice: 18.84, sellPrice: 80, usdtPrice: 3.38, creditPrice: 113, currency: "USD", eurUsdRate: 1 }));
    check("compute: costUSDT/costTND/profit", Math.abs(r.costUSDT - 21.2892) < 1e-9 && Math.abs(r.costTND - 71.957496) < 1e-6 && Math.abs(r.profitTND - 8.042504) < 1e-6);
    const r2 = await page.evaluate(() => window.CardProfit.compute({ displayedPrice: 10, sellPrice: 45, usdtPrice: 3.38, creditPrice: 100, currency: "EUR", eurUsdRate: 1.13 }));
    check("compute: EUR credit price uses the EUR/USD rate", Math.abs(r2.usdPer100Credit - 113) < 1e-9, r2.usdPer100Credit);
    await ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Mobile 390px: acceptance tests");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    eq("version label shown", await txt(page, "#version"), "v" + appVer);
    eq("title", await page.title(), "Card profit");
    eq("empty state asks for input", (await txt(page, "#result-msg-title")), "Enter the card price and your sell price to see your profit.");

    // settings for the acceptance tests
    await setSettings(page, { usdt: "3.38", credit: "113", currency: "USD" });

    // live: typed key by key, no button press
    await page.click("#displayedPrice");
    await page.keyboard.type("18.84");
    check("result hidden while sell price missing, message names it", (await txt(page, "#result-msg-list")).includes("Sell price (TND) is missing"), await txt(page, "#result-msg-list"));
    await page.click("#sellPrice");
    await page.keyboard.type("80");
    check("result appears live as I type (no Calculate press)", await page.isVisible("#result-ok"));

    // Test 1
    eq("T1 profit", await txt(page, "#out-profit"), "+8.04 TND");
    eq("T1 costUSDT", await txt(page, "#out-cost-usdt"), "21.29 USDT");
    eq("T1 costTND", await txt(page, "#out-cost-tnd"), "71.96 TND");
    eq("T1 margin on cost", await txt(page, "#out-margin-cost"), "11.2%");
    eq("T1 margin on sale", await txt(page, "#out-margin-sale"), "10.1%");
    eq("T1 chain", await txt(page, "#out-chain"), "18.84 EUR → 21.29 USDT → 71.96 TND");
    eq("T1 profit USDT", await txt(page, "#out-profit-usdt"), "+2.38 USDT");
    eq("T1 break-even", await txt(page, "#out-breakeven"), "71.96 TND");
    const sug = await page.$$eval("#out-suggest li", (lis) => lis.map((l) => l.textContent.replace(/\s+/g, " ").trim()));
    eq("T1 suggested prices", JSON.stringify(sug), JSON.stringify(["10%79.15 TND+7.20", "15%82.75 TND+10.79", "20%86.35 TND+14.39"]));
    eq("T1 profit is green (data-sign=1)", await page.getAttribute("#out-profit", "data-sign"), "1");
    const green = await page.$eval("#out-profit", (e) => getComputedStyle(e).color);
    const [gr, gg, gb] = green.match(/\d+/g).map(Number);
    check("T1 profit colour is green", gg > gr && gg > gb, green);

    // geometry: result visible without scrolling, tall inputs, no bottom nav, button top right
    const geo = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const fixed = [...document.querySelectorAll("body *")].filter((e) => ["fixed", "sticky"].includes(getComputedStyle(e).position))
        .map((e) => ({ id: e.id || e.className, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom }));
      return {
        vw: innerWidth, vh: innerHeight, scrollW: document.documentElement.scrollWidth,
        scrollY: scrollY,
        dispH: r("#displayedPrice").height, sellH: r("#sellPrice").height,
        dispFont: parseFloat(getComputedStyle(document.querySelector("#displayedPrice")).fontSize),
        sellFont: parseFloat(getComputedStyle(document.querySelector("#sellPrice")).fontSize),
        btnRight: r("#settings-btn").right, btnTop: r("#settings-btn").top, btnH: r("#settings-btn").height,
        calcBtnH: r("#calc-btn").height,
        formBottom: r("#calc-form").bottom, resultTop: r("#result").top,
        suggestBottom: r("#out-suggest").bottom, tilesBottom: r(".tiles").bottom, chainBottom: r("#out-chain").bottom,
        fixed
      };
    });
    check("inputs are >= 50px tall", geo.dispH >= 50 && geo.sellH >= 50, `${geo.dispH}/${geo.sellH}`);
    check("input font >= 16px (no iOS zoom)", geo.dispFont >= 16 && geo.sellFont >= 16, `${geo.dispFont}/${geo.sellFont}`);
    check("Calculate and Settings buttons have large tap targets", geo.calcBtnH >= 48 && geo.btnH >= 44, `${geo.calcBtnH}/${geo.btnH}`);
    check("Settings button is at the top right", geo.btnRight > geo.vw - 24 && geo.btnTop < 40, `right=${geo.btnRight} top=${geo.btnTop}`);
    check("nothing fixed/sticky near the bottom of the screen", geo.fixed.every((f) => f.bottom < geo.vh / 2), JSON.stringify(geo.fixed));
    check("result card sits directly below the inputs", geo.resultTop - geo.formBottom < 24, `gap ${geo.resultTop - geo.formBottom}`);
    check("profit, margins and chain visible without scrolling", geo.chainBottom <= geo.vh, `chain bottom ${geo.chainBottom} of ${geo.vh}`);
    check("no horizontal overflow", geo.scrollW <= geo.vw, `${geo.scrollW} > ${geo.vw}`);
    await page.screenshot({ path: path.join(SHOTS, "mobile-calc.png") });

    // Calculate button + Enter
    await page.fill("#sellPrice", "81");
    await page.click("#calc-btn");
    eq("Calculate button works", await txt(page, "#out-profit"), "+9.04 TND");
    await page.fill("#sellPrice", "82");
    await page.press("#sellPrice", "Enter");
    eq("Enter key works", await txt(page, "#out-profit"), "+10.04 TND");

    // Test 2
    await fillCalc(page, "10", "45");
    await page.click("#calc-btn");
    eq("T2 costUSDT", await txt(page, "#out-cost-usdt"), "11.30 USDT");
    eq("T2 costTND", await txt(page, "#out-cost-tnd"), "38.19 TND");
    eq("T2 profit", await txt(page, "#out-profit"), "+6.81 TND");

    // Test 3 (loss, red)
    await fillCalc(page, "18.84", "40");
    await page.click("#calc-btn");
    eq("T3 profit", await txt(page, "#out-profit"), "-31.96 TND");
    eq("T3 profit is red (data-sign=-1)", await page.getAttribute("#out-profit", "data-sign"), "-1");
    const red = await page.$eval("#out-profit", (e) => getComputedStyle(e).color);
    const [rr, rg, rb] = red.match(/\d+/g).map(Number);
    check("T3 profit colour is red", rr > rg + 60 && rr > rb + 60, red);
    check("T3 margins negative", (await txt(page, "#out-margin-cost")).startsWith("-"), await txt(page, "#out-margin-cost"));
    await page.screenshot({ path: path.join(SHOTS, "mobile-loss.png") });

    // Test 4 (comma)
    await fillCalc(page, "18,84", "80");
    eq("T4 comma: profit", await txt(page, "#out-profit"), "+8.04 TND");
    eq("T4 comma: costUSDT", await txt(page, "#out-cost-usdt"), "21.29 USDT");
    eq("T4 comma: margin on cost", await txt(page, "#out-margin-cost"), "11.2%");
    await fillCalc(page, "18,84", "80,5");
    eq("T4 comma in sell price", await txt(page, "#out-profit"), "+8.54 TND");
    check("inputs are type=text with decimal keyboard", await page.evaluate(() =>
      ["displayedPrice", "sellPrice", "usdtPrice", "creditPrice", "eurUsdRate"].every((id) => {
        const e = document.getElementById(id); return e.type === "text" && e.inputMode === "decimal"; })));

    // missing / invalid messages
    await fillCalc(page, "", "");
    await page.click("#calc-btn");
    const both = await txt(page, "#result-msg-list");
    check("Calculate with nothing entered lists what is missing", both.includes("Card price (EUR) is missing") && both.includes("Sell price (TND) is missing"), both);
    eq("empty fields are flagged after Calculate", await page.getAttribute("#displayedPrice", "aria-invalid"), "true");
    await fillCalc(page, "abc", "80");
    check("invalid text is called out", (await txt(page, "#result-msg-list")).includes("“abc” is not a number"), await txt(page, "#result-msg-list"));
    await fillCalc(page, "10", "0");
    check("zero sell price is rejected", (await txt(page, "#result-msg-list")).includes("Sell price (TND) must be greater than 0"));
    await fillCalc(page, "10", "45");
    check("flags clear again once valid", (await page.getAttribute("#displayedPrice", "aria-invalid")) === null && await page.isVisible("#result-ok"));

    check("no JS errors", page.errors.length === 0, page.errors.join(" | "));
    await ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Mobile: settings view, persistence, currency, live rate");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    eq("button says Settings", await txt(page, "#settings-btn"), "Settings");
    await page.click("#settings-btn");
    eq("button says Done in settings", await txt(page, "#settings-btn"), "Done");
    check("settings is a separate view (calculator hidden)", !(await page.isVisible("#calc-panel")) && (await page.isVisible("#settings-panel")));
    await page.screenshot({ path: path.join(SHOTS, "mobile-settings.png") });
    const sgeo = await page.evaluate(() => ["usdtPrice", "creditPrice", "eurUsdRate"].map((id) => document.getElementById(id).getBoundingClientRect().height));
    check("settings inputs >= 50px tall", sgeo.every((h) => h >= 50), sgeo.join(","));
    await page.click("#settings-btn");
    eq("Done returns to the calculator", await txt(page, "#settings-btn"), "Settings");
    check("calculator visible again, settings hidden", (await page.isVisible("#calc-panel")) && !(await page.isVisible("#settings-panel")));

    // the rate was pulled on load (mock returns 1.1)
    await page.click("#settings-btn");
    await page.waitForFunction(() => document.getElementById("eurUsdRate").value === "1.1000");
    check("rate pulled live on load", (await txt(page, "#rate-status")).startsWith("Live rate pulled"), await txt(page, "#rate-status"));
    check("last-pulled time is shown", /20\d\d/.test(await txt(page, "#rate-status")), await txt(page, "#rate-status"));
    await page.click("#settings-btn");

    // settings persist across reloads
    await setSettings(page, { usdt: "3,4", credit: "112", currency: "USD" });
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await page.click("#settings-btn");
    eq("usdtPrice persisted", await page.inputValue("#usdtPrice"), "3,4");
    eq("creditPrice persisted", await page.inputValue("#creditPrice"), "112");
    eq("currency persisted", await page.isChecked('input[name="currency"][value="USD"]'), true);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("cardProfit.settings.v1")));
    check("localStorage holds the settings", stored.usdtPrice === "3,4" && stored.creditPrice === "112" && stored.currency === "USD", JSON.stringify(stored));
    await page.click("#settings-btn");
    await fillCalc(page, "10", "45");
    // 10 * 1.12 * 3.4 = 38.08
    eq("comma in settings is honoured (usdt 3,4)", await txt(page, "#out-cost-tnd"), "38.08 TND");

    // EUR credit price with a hand-typed rate: 100 EUR * 1.13 = 113 USD -> identical to the acceptance numbers
    await setSettings(page, { usdt: "3.38", credit: "100", currency: "EUR", rate: "1,13" });
    await fillCalc(page, "18.84", "80");
    eq("EUR credit: costUSDT uses the rate", await txt(page, "#out-cost-usdt"), "21.29 USDT");
    eq("EUR credit: profit", await txt(page, "#out-profit"), "+8.04 TND");
    await page.click("#settings-btn");
    check("status says manual value", (await txt(page, "#rate-status")).startsWith("Manual value"), await txt(page, "#rate-status"));
    await page.screenshot({ path: path.join(SHOTS, "mobile-settings-eur.png") });
    await page.click("#settings-btn");

    // a hand-typed rate survives a reload (auto-pull must not overwrite it)
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await page.waitForTimeout(400);
    await page.click("#settings-btn");
    eq("manual rate not overwritten by the on-load pull", await page.inputValue("#eurUsdRate"), "1,13");

    // Pull live button
    await page.click("#rate-btn");
    await page.waitForFunction(() => document.getElementById("eurUsdRate").value === "1.1000");
    check("Pull live updates the rate + status", (await txt(page, "#rate-status")).startsWith("Live rate pulled"), await txt(page, "#rate-status"));
    await page.click("#settings-btn");
    await fillCalc(page, "18.84", "80");
    eq("calculation follows the pulled rate (18.84 * 1.10)", await txt(page, "#out-cost-usdt"), "20.72 USDT");

    // fallback source
    await mockRates(ctx, { failFrankfurter: true, erapi: 1.2 });
    await page.click("#settings-btn");
    await page.click("#rate-btn");
    await page.waitForFunction(() => document.getElementById("eurUsdRate").value === "1.2000");
    check("falls back to open.er-api.com", (await txt(page, "#rate-status")).includes("open.er-api.com"), await txt(page, "#rate-status"));
    check("no error shown when the fallback worked", !(await page.isVisible("#rate-error")));

    // both fail: keep the value, say so
    await mockRates(ctx, { failFrankfurter: true, failErapi: true });
    await page.click("#rate-btn");
    await page.waitForSelector("#rate-error:not([hidden])");
    const errMsg = await txt(page, "#rate-error");
    check("both sources failing: message shown, manual value kept", errMsg.includes("Keeping 1.2000") && (await page.inputValue("#eurUsdRate")) === "1.2000", errMsg);
    check("button usable again after failure", await page.isEnabled("#rate-btn"));
    check("failed pull did not raise a JS error", page.errors.every((e) => /Failed to load resource|net::ERR/.test(e)), page.errors.join(" | "));

    // invalid settings -> clear message in the calculator with a way to fix it
    await page.fill("#usdtPrice", "");
    await page.click("#settings-btn");
    await fillCalc(page, "10", "45");
    check("missing USDT price is explained", (await txt(page, "#result-msg-list")).includes("USDT price (Settings) is missing"), await txt(page, "#result-msg-list"));
    await page.click("#msg-settings-btn");
    eq("message button opens settings", await txt(page, "#settings-btn"), "Done");
    await ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Storage unavailable (blocked localStorage)");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("blocked", "SecurityError"); } });
    });
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await fillCalc(page, "18.84", "80");
    eq("still calculates with defaults", await txt(page, "#out-profit"), "+8.04 TND");
    check("no errors with storage blocked", page.errors.length === 0, page.errors.join(" | "));
    await ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Error banner");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await page.evaluate(() => {
      setTimeout(() => { throw new Error("boom one"); });
      setTimeout(() => { throw new Error("boom two"); });
      Promise.reject(new Error("rejected three"));
    });
    await page.waitForFunction(() => document.querySelectorAll("#error-banner li").length >= 3);
    const items = await page.$$eval("#error-banner li", (l) => l.map((x) => x.textContent));
    check("banner lists ALL errors, not just the last", items.some((i) => i.includes("boom one")) && items.some((i) => i.includes("boom two")) && items.some((i) => i.includes("rejected three")), JSON.stringify(items));
    check("banner shows the count", (await txt(page, "#error-banner strong")) === "3 errors", await txt(page, "#error-banner strong"));
    await page.screenshot({ path: path.join(SHOTS, "mobile-error-banner.png") });
    await page.click("#error-banner button");
    check("Dismiss removes the banner", (await page.$("#error-banner")) === null);
    check("app still works after errors", await page.isVisible("#calc-btn"));
    await ctx.close();

    // app.js missing
    const m = await newPage(MOBILE);
    await m.ctx.route("**/app.js", (r) => r.fulfill({ status: 404, body: "nope" }));
    await m.page.goto(base);
    await m.page.waitForSelector("#error-banner li");
    check("missing app.js is reported", (await m.page.$$eval("#error-banner li", (l) => l.map((x) => x.textContent).join("|"))).includes("Failed to load"), "");
    await m.page.waitForFunction(() => document.body.textContent.includes("did not start"), null, { timeout: 6000 });
    check("'app.js did not start' warning appears", true);
    await m.ctx.close();

    // app.js with a syntax error
    const s = await newPage(MOBILE);
    await s.ctx.route("**/app.js", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "function (" }));
    await s.page.goto(base);
    await s.page.waitForSelector("#error-banner li");
    check("syntax error in app.js is reported", /SyntaxError|Unexpected/.test(await s.page.textContent("#error-banner")), await s.page.textContent("#error-banner"));
    await s.ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Desktop 1280px");
  {
    const { ctx, page } = await newPage(DESKTOP);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    check("calculator and settings both visible", (await page.isVisible("#calc-panel")) && (await page.isVisible("#settings-panel")));
    const b = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return { calcRight: r("#calc-panel").right, setLeft: r("#settings-panel").left, setTop: r("#settings-panel").top, calcTop: r("#calc-panel").top, btnRight: r("#settings-btn").right, vw: innerWidth };
    });
    check("settings sits to the right of the calculator", b.setLeft >= b.calcRight && Math.abs(b.setTop - b.calcTop) < 40, JSON.stringify(b));
    check("button still top right", b.btnRight > b.vw - 40, String(b.btnRight));
    eq("button label when settings shown", await txt(page, "#settings-btn"), "Hide settings");
    await setSettings(page, { usdt: "3.38", credit: "113", currency: "USD" });
    await fillCalc(page, "18.84", "80");
    eq("desktop result", await txt(page, "#out-profit"), "+8.04 TND");
    await page.screenshot({ path: path.join(SHOTS, "desktop.png") });
    await page.click("#settings-btn");
    check("button collapses the settings panel", !(await page.isVisible("#settings-panel")) && (await page.isVisible("#calc-panel")));
    eq("button label when collapsed", await txt(page, "#settings-btn"), "Settings");
    await page.screenshot({ path: path.join(SHOTS, "desktop-collapsed.png") });
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true);
    check("collapsed state is remembered", !(await page.isVisible("#settings-panel")));
    await page.click("#settings-btn");
    check("button shows it again", await page.isVisible("#settings-panel"));
    check("desktop: no JS errors", page.errors.length === 0, page.errors.join(" | "));

    // resizing across the breakpoint: mobile 'settings' view must not hide the calculator on desktop
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#settings-btn");
    await page.setViewportSize({ width: 1280, height: 800 });
    check("resize to desktop shows both panels", (await page.isVisible("#calc-panel")) && (await page.isVisible("#settings-panel")));
    await ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("Dark mode");
  {
    const light = await newPage(MOBILE, { colorScheme: "light" });
    await light.page.goto(base);
    const lightBg = await light.page.$eval("body", (e) => getComputedStyle(e).backgroundColor);
    await light.ctx.close();
    const dark = await newPage(MOBILE, { colorScheme: "dark" });
    await dark.page.goto(base);
    await dark.page.waitForFunction(() => window.__cardProfitReady === true);
    const darkBg = await dark.page.$eval("body", (e) => getComputedStyle(e).backgroundColor);
    check("prefers-color-scheme: dark changes the theme", lightBg !== darkBg, `${lightBg} vs ${darkBg}`);
    const lum = darkBg.match(/\d+/g).slice(0, 3).map(Number).reduce((a, c) => a + c, 0) / 3;
    check("dark background is dark", lum < 60, darkBg);
    await fillCalc(dark.page, "18.84", "80");
    await dark.page.screenshot({ path: path.join(SHOTS, "mobile-dark.png") });
    await dark.ctx.close();
  }

  /* ------------------------------------------------------------------ */
  section("PWA: service worker, offline, updates");
  {
    const { ctx, page } = await newPage(MOBILE);
    await page.goto(base);
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await page.evaluate(() => navigator.serviceWorker.ready);
    const keys1 = await page.evaluate(() => caches.keys());
    eq("cache is versioned", JSON.stringify(keys1), JSON.stringify(["card-profit-v" + appVer]));
    const cached = await page.evaluate(async () => (await (await caches.open((await caches.keys())[0])).keys()).map((r) => new URL(r.url).pathname));
    check("app shell is precached", ["/", "/index.html", "/app.js", "/style.css", "/manifest.json", "/icons/icon-192.png"].every((p) => cached.includes(p)), cached.join(","));
    const mf = await page.evaluate(async () => (await fetch(document.querySelector('link[rel="manifest"]').href)).ok);
    check("manifest is served", mf);

    await setSettings(page, { usdt: "3.38", credit: "113", currency: "USD" });
    await page.reload();                       // now controlled by the SW
    await page.waitForFunction(() => window.__cardProfitReady === true);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true, null, { timeout: 10000 });
    check("opens offline", (await page.title()) === "Card profit");
    await fillCalc(page, "18,84", "80");
    eq("calculator works offline with saved settings", await txt(page, "#out-profit"), "+8.04 TND");
    await page.click("#settings-btn");
    await mockRates(ctx, { failFrankfurter: true, failErapi: true });   // mocks answer even when "offline", so make them fail
    await page.click("#rate-btn");
    await page.waitForSelector("#rate-error:not([hidden])");
    check("live rate fails gracefully offline", (await txt(page, "#rate-error")).includes("Couldn’t pull the live rate"), await txt(page, "#rate-error"));
    await page.click("#settings-btn");
    await ctx.setOffline(false);

    // 1) a deployed change to app.js shows up on the next load even though the SW still holds the old file
    mutations["/app.js"] = (t) => t.replace(`var APP_VERSION = "${appVer}"`, `var APP_VERSION = "9.9"`);
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true);
    eq("new app.js is used immediately (network first, no stale cache)", await txt(page, "#version"), "v9.9");

    // 2) a new sw.js replaces the old cache
    await page.evaluate(() => caches.open("card-profit-stale-old").then((c) => c.put("/x", new Response("old"))));
    mutations["/sw.js"] = (t) => t.replace(`const VERSION = "${swVer}"`, `const VERSION = "9.9"`);
    await page.reload();
    await page.waitForFunction(async () => JSON.stringify(await caches.keys()) === '["card-profit-v9.9"]', null, { timeout: 15000 })
      .then(() => check("new service worker deletes the old caches", true))
      .catch(async () => check("new service worker deletes the old caches", false, JSON.stringify(await page.evaluate(() => caches.keys()))));
    delete mutations["/app.js"]; delete mutations["/sw.js"];
    await page.reload();
    await page.waitForFunction(() => window.__cardProfitReady === true);
    eq("version label returns to the deployed version", await txt(page, "#version"), "v" + appVer);
    await ctx.close();
  }

  await browser.close();
  server.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("FAILED:\n" + failed.map((f) => " - " + f.name + (f.detail !== undefined ? "  -> " + f.detail : "")).join("\n"));
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
