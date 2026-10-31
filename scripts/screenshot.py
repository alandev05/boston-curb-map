#!/usr/bin/env python3
"""Screenshot the app with headless Chrome. Needs: pip install playwright; mock + dev server running.
Offline mode injects stand-in buildings/streets because OpenFreeMap tiles can't load without network."""
import asyncio, sys, os, time
T0 = time.time()
log = lambda *a: print(f"[{time.time()-T0:5.1f}s]", *a, flush=True)
from playwright.async_api import async_playwright
OUT = sys.argv[1] if len(sys.argv) > 1 else "docs"
BASE = os.environ.get("APP", "http://localhost:3000")
CHROME = os.environ.get("CHROME", "/usr/bin/google-chrome")

INJECT = """() => new Promise(res => {
  const map = window.__map; const run = () => {
    // Deterministic stand-in city: blocks of extruded boxes + a street grid around downtown.
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const bld = [], st = [];
    const [cx, cy] = [-71.0589, 42.3601];
    const R = map.getZoom() < 13 ? 40 : 14;
    for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
      const x = cx + i * 0.0025, y = cy + j * 0.0025;
      // street grid
      if (i === -R) st.push({ type: "Feature", properties: { major: j % 4 === 0 }, geometry: { type: "LineString", coordinates: [[cx - R * 0.0025, y], [cx + R * 0.0025, y]] } });
      if (j === -R) st.push({ type: "Feature", properties: { major: i % 5 === 0 }, geometry: { type: "LineString", coordinates: [[x, cy - R * 0.0025], [x, cy + R * 0.0025]] } });
      // 2-4 buildings per block
      const n = R > 14 ? 1 : 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const w = 0.0005 + rnd() * 0.0009, h = 0.0005 + rnd() * 0.0009;
        const ox = x + 0.0003 + rnd() * (0.0025 - w - 0.0006), oy = y + 0.0003 + rnd() * (0.0025 - h - 0.0006);
        const dist = Math.hypot(i, j); const height = Math.max(8, (160 - dist * 9) * (0.3 + rnd() * 0.9));
        bld.push({ type: "Feature", properties: { render_height: height, render_min_height: 0 }, geometry: { type: "Polygon", coordinates: [[[ox, oy], [ox + w, oy], [ox + w, oy + h], [ox, oy + h], [ox, oy]]] } });
      }
    }
    map.addSource("demo-bld", { type: "geojson", data: { type: "FeatureCollection", features: bld } });
    map.addSource("demo-st", { type: "geojson", data: { type: "FeatureCollection", features: st } });
    const b3d = map.getLayer("buildings-3d");
    const paint = {}; for (const k of ["fill-extrusion-color","fill-extrusion-height","fill-extrusion-base","fill-extrusion-opacity","fill-extrusion-vertical-gradient"]) paint[k] = map.getPaintProperty("buildings-3d", k);
    const rc = (id) => map.getPaintProperty(id, "line-color");
    const z = map.getZoom(), big = z >= 15;
    map.addLayer({ id: "demo-st-outline", type: "line", source: "demo-st", layout: { "line-cap": "round" }, paint: { "line-color": rc("road-outline"), "line-width": ["case", ["get","major"], big ? 22 : 3, big ? 12 : 1.5] } }, "buildings-3d");
    map.addLayer({ id: "demo-st", type: "line", source: "demo-st", layout: { "line-cap": "round" }, paint: { "line-color": ["case", ["get","major"], rc("road-major"), rc("road-minor")], "line-width": ["case", ["get","major"], big ? 18 : 2, big ? 9 : 0.8] } }, "buildings-3d");
    map.addLayer({ id: "demo-bld", type: "fill-extrusion", source: "demo-bld", paint }, "buildings-3d");
    map.once("idle", res);
  };
  const tick = () => (map.getLayer && map.getLayer("buildings-3d") && map.isStyleLoaded()) ? run() : setTimeout(tick, 100);
  tick();
})"""

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"])
        async def shot(w, h, out, mobile=False, popup=True, day="tue", hour=9, offline=True, view=None, theme=None):
            ctx = await b.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile)
            page = await ctx.new_page()
            if offline:
                # Offline: answer the TileJSON so MapLibre still fires "load", then serve empty tiles.
                async def tilejson(r): await r.fulfill(status=200, content_type="application/json", body='{"tilejson":"3.0.0","tiles":["' + BASE + '/__notile/{z}/{x}/{y}.pbf"],"minzoom":0,"maxzoom":14,"bounds":[-180,-85,180,85]}')
                async def empty(r): await r.fulfill(status=204, body=b"")
                async def block(r): await r.abort()
                await page.route("**/tiles.openfreemap.org/planet*", tilejson)
                await page.route("**/__notile/**", empty)
                await page.route("**/tiles.openfreemap.org/fonts/**", empty)
                await page.route("**/fonts.g*", block)
            await page.goto(BASE + "/", wait_until="load")
            await page.wait_for_timeout(1200)
            await page.select_option("#day", day)
            await page.fill("#hour", str(hour)); await page.dispatch_event("#hour", "input")
            if theme:
                cur = await page.evaluate("document.documentElement.dataset.theme")
                if cur != theme: await page.click("#themeBtn"); await page.wait_for_timeout(800)
            if view: await page.evaluate("v => window.__map.jumpTo(v)", view); await page.wait_for_timeout(600)
            if offline: log("inject"); await page.evaluate(INJECT); log("injected")
            await page.wait_for_timeout(3000)
            if popup:
                for dx, dy in [(0.62, 0.45), (0.55, 0.5), (0.7, 0.4), (0.6, 0.6), (0.5, 0.35), (0.66, 0.52)]:
                    await page.mouse.click(w * dx, h * dy); await page.wait_for_timeout(500)
                    if not await page.locator("#popup.hidden").count(): break
            log("shooting"); await page.screenshot(path=out)
            print("saved", out, "|", await page.locator("#status").inner_text())
            await ctx.close()
        os.makedirs(OUT, exist_ok=True)
        BLOCK = {"center": [-71.0589, 42.3601], "zoom": 15.6, "pitch": 55, "bearing": -17}
        CITY = {"center": [-71.07, 42.33], "zoom": 11.6, "pitch": 0, "bearing": 0}
        await shot(1440, 900, f"{OUT}/preview-desktop.png", view=BLOCK, theme="dark")
        await shot(1440, 900, f"{OUT}/preview-city.png", view=CITY, theme="dark", popup=False)
        await shot(1440, 900, f"{OUT}/preview-light.png", view=BLOCK, theme="light")
        await shot(430, 860, f"{OUT}/preview-mobile.png", mobile=True, popup=False, hour=17, view={"center": [-71.0589, 42.3601], "zoom": 15.2, "pitch": 55, "bearing": -17}, theme="dark")
        await b.close()
asyncio.run(main())
