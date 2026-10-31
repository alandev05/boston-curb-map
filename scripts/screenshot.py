import asyncio, sys
from playwright.async_api import async_playwright
S="/tmp/claude-0/-home-claude/c795e143-f5e1-5431-bf62-6e0464669514/scratchpad"
TILE=open(f"{S}/tile.png","rb").read()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"])
        async def shot(w,h,out,mobile=False,popup=True,hour=9):
            ctx = await b.new_context(viewport={"width":w,"height":h}, device_scale_factor=2, is_mobile=mobile, has_touch=mobile)
            page = await ctx.new_page()
            async def route(r):
                u=r.request.url
                if "cartocdn.com" in u and "only_labels" in u: await r.fulfill(status=200, content_type="image/png", body=b"")
                elif "cartocdn.com" in u: await r.fulfill(status=200, content_type="image/png", body=TILE)
                elif "fonts.g" in u: await r.abort()
                else: await r.continue_()
            await page.route("**/*", route)
            await page.goto("http://localhost:3000/#", wait_until="load")
            await page.wait_for_function("window.__map === undefined || true")
            await page.wait_for_timeout(1500)
            # set Tue 9am
            await page.select_option("#day","tue")
            await page.fill("#hour", str(hour)); await page.dispatch_event("#hour","input")
            # fly to Back Bay at z16 via maplibre instance isn't exposed; use URL-less approach: click +zoom
            await page.evaluate("""() => { const m = document.querySelector('.maplibregl-canvas'); }""")
            await page.wait_for_timeout(2500)
            if popup:
                # click near map center where zones are dense
                await page.mouse.click(w*0.62, h*0.45)
                await page.wait_for_timeout(600)
                if await page.locator("#popup.hidden").count():
                    for dx,dy in [(0.55,0.5),(0.7,0.4),(0.6,0.6),(0.5,0.35)]:
                        await page.mouse.click(w*dx,h*dy); await page.wait_for_timeout(400)
                        if not await page.locator("#popup.hidden").count(): break
            await page.screenshot(path=out)
            print("saved", out, await page.locator("#status").inner_text())
            await ctx.close()
        await shot(1440,900,f"{S}/preview-desktop.png")
        await shot(430,860,f"{S}/preview-mobile.png",mobile=True,popup=False,hour=17)
        await b.close()
asyncio.run(main())
