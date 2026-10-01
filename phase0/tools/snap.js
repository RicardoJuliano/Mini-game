// Headless screenshots of the host page, driven by the autopilot (?autopilot=1&skipLobby=1).
// Requires the server to already be running (npm start, in a separate terminal/process).
// Usage: npm run snap
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SHOTS_DIR = path.join(__dirname, "..", "shots");
const URL = "https://localhost:8443/host.html?autopilot=1&skipLobby=1&debug=1";

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    args: [
      "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-certificate-errors",
      // Without these, headless Chromium throttles requestAnimationFrame on an
      // unfocused page — the autopilot (which injects input inside the rAF loop)
      // would barely run, and the kart would sit still the whole time.
      "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.error("[page]", m.text()); });
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  await page.goto(URL);

  const moments = [["start", 1500], ["accel", 4000], ["corner", 9000], ["topspeed", 14000]];
  for (const [name, ms] of moments) {
    await page.waitForTimeout(ms);
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await page.screenshot({ path: file });
    console.log("saved", file);
  }

  await context.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
