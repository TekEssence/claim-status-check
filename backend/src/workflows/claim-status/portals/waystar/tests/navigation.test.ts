import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { openWaystarClaimSearch } from "../navigation";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || (process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : chromium.executablePath());

test("Waystar navigation clicks the professional Claims link and waits for delayed search fields", {
  skip: !existsSync(executablePath),
}, async () => {
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    const visits: string[] = [];
    await page.route("https://waystar.test/**", async (route) => {
      const url = new URL(route.request().url());
      visits.push(url.pathname);
      let html = "";
      if (url.pathname === "/start") {
        html = `<a href="#" onmouseenter="document.querySelector('#products').style.display='block'"
          onclick="throw new Error('Menu must be hovered')">Claims Processing</a>
          <div id="products" style="display:none">
            <a href="#" onmouseenter="setTimeout(() => document.querySelector('#links').style.display='block', 150)">Professional Claims</a>
            <span>Professional Claims</span>
            <div id="links" style="display:none">
              <a href="/wrong">Claims Dashboard</a>
              <a href="/Claims/Listing/Index?appid=2">Claims</a>
              <a href="/Claims/Listing/Index?appid=1">Claims</a>
            </div>
          </div>`;
      } else if (url.pathname === "/Claims/Listing/Index") {
        assert.equal(url.searchParams.get("appid"), "1");
        html = `<a id="headerSearchLink" href="/Claims/ClaimSearch/Index?AppID=1"><i></i> Claim Search</a>`;
      } else if (url.pathname === "/Claims/ClaimSearch/Index") {
        html = `<div id="form"></div><script>setTimeout(() => {
          document.querySelector('#form').innerHTML = '<input id="patientName"><input id="dtFrom"><input id="dtTo"><button id="searchButton">Search</button>';
        }, 200);</script>`;
      } else {
        assert.fail(`Unexpected navigation: ${url}`);
      }
      await route.fulfill({ contentType: "text/html", body: html });
    });
    await page.goto("https://waystar.test/start");
    await openWaystarClaimSearch(page);
    assert.deepEqual(visits, ["/start", "/Claims/Listing/Index", "/Claims/ClaimSearch/Index"]);
    await page.locator("#patientName").fill("Test Patient");
    await page.locator("#dtFrom").fill("09/01/2026");
    await page.locator("#dtTo").fill("09/01/2026");
    // A second call on the search page must not reopen the menus or navigate away.
    await openWaystarClaimSearch(page);
    assert.equal(await page.locator("#patientName").inputValue(), "Test Patient");
    assert.equal(visits.length, 3);
    // Returning from a listing can use its search link without reopening the menu.
    await page.goto("https://waystar.test/Claims/Listing/Index?appid=1");
    await openWaystarClaimSearch(page);
    assert.equal(await page.locator("#dtTo").isVisible(), true);
  } finally {
    await browser.close();
  }
});
