import asyncio
import os
import re
from playwright.async_api import async_playwright

OUTPUT_DIR = "/root/.gemini/antigravity-cli/brain/6ab863fb-1b93-47a4-8202-c969b7370843/playwright_screens"
os.makedirs(OUTPUT_DIR, exist_ok=True)

UUID_V4_STANDARD_REGEX = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
UUID_V4_UPPERCASE_REGEX = re.compile(r"^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$")
UUID_V4_NOHYPHEN_REGEX = re.compile(r"^[0-9a-f]{32}$")

TEST_ACCOUNT = {
    "id": "google_uid_test",
    "name": "DUAR QA Tester",
    "email": "tester@duar.id",
    "picture": "",
    "isGoogle": True
}

async def setup_authenticated_context(browser, width, height, is_mobile=False):
    context = await browser.new_context(
        viewport={"width": width, "height": height},
        is_mobile=is_mobile,
        has_touch=is_mobile
    )
    import json
    await context.add_init_script(f"""
        localStorage.setItem('duar_active_google_user_id', 'google_uid_test');
        sessionStorage.setItem('duar_active_google_user_id', 'google_uid_test');
        localStorage.setItem('duar_google_accounts_list', JSON.stringify([{json.dumps(TEST_ACCOUNT)}]));
    """)
    return context


async def run_tests():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        
        # Test 1: Desktop Viewport (1280x800)
        context = await setup_authenticated_context(browser, 1280, 800)
        page = await context.new_page()
        page.on("console", lambda msg: print(f"Browser Console [{msg.type}]: {msg.text}"))
        page.on("pageerror", lambda err: print(f"Browser Error: {err}"))
        
        print("Navigating to http://127.0.0.1:4090/#generate...")
        await page.goto("http://127.0.0.1:4090/#generate", wait_until="domcontentloaded")
        await asyncio.sleep(1)
        
        # Verify tab-generate is visible
        is_visible = await page.is_visible("#tab-generate")
        assert is_visible, "tab-generate is not visible"
        print("✓ Tab Generate Famcode loaded and visible")

        
        await page.screenshot(path=f"{OUTPUT_DIR}/01_desktop_generate_initial.png", full_page=True)
        
        # Test Format preview update
        print("Testing format select uppercase...")
        await page.select_option("#genFormatSelect", "uppercase")
        await asyncio.sleep(0.3)
        preview_text = await page.text_content("#genFormatPreview")
        print(f"Uppercase preview: {preview_text}")
        assert UUID_V4_UPPERCASE_REGEX.match(preview_text), f"Invalid uppercase preview: {preview_text}"
        
        print("Testing format select nohyphen...")
        await page.select_option("#genFormatSelect", "nohyphen")
        await asyncio.sleep(0.3)
        preview_text_nh = await page.text_content("#genFormatPreview")
        print(f"No-hyphen preview: {preview_text_nh}")
        assert UUID_V4_NOHYPHEN_REGEX.match(preview_text_nh), f"Invalid nohyphen preview: {preview_text_nh}"
        
        print("Testing format select standard...")
        await page.select_option("#genFormatSelect", "standard")
        await asyncio.sleep(0.3)
        
        # Test Preset selection: Click 50
        print("Clicking preset 50...")
        preset_50 = page.locator("button[onclick='setGenPresetCount(50)']")
        await preset_50.click()
        await asyncio.sleep(0.2)
        count_val = await page.input_value("#genCountInput")
        assert count_val == "50", f"Expected count 50, got {count_val}"
        print("✓ Preset 50 clicked successfully")
        
        # Click Generate Famcode
        print("Clicking generate button...")
        btn_gen = page.locator("#btnGenerateFamcode")
        await btn_gen.click()
        await asyncio.sleep(0.5)

        
        # Verify results
        output_val = await page.input_value("#genOutputText")
        lines = [line.strip() for line in output_val.strip().split("\n") if line.strip()]
        assert len(lines) == 50, f"Expected 50 UUIDs, got {len(lines)}"
        assert len(set(lines)) == 50, "Generated UUIDs must be 100% unique"
        for line in lines:
            assert UUID_V4_STANDARD_REGEX.match(line), f"Invalid UUID v4 standard format: {line}"
        print(f"✓ Successfully generated {len(lines)} unique standard UUID v4s")
        
        await page.screenshot(path=f"{OUTPUT_DIR}/02_desktop_generate_50_standard.png", full_page=True)
        
        # Test Preset 500 with Uppercase
        preset_500 = page.locator("button[onclick='setGenPresetCount(500)']")
        await preset_500.click()
        await page.select_option("#genFormatSelect", "uppercase")
        await btn_gen.click()
        await asyncio.sleep(0.8)
        
        output_500 = await page.input_value("#genOutputText")
        lines_500 = [line.strip() for line in output_500.strip().split("\n") if line.strip()]
        assert len(lines_500) == 500, f"Expected 500 UUIDs, got {len(lines_500)}"
        assert len(set(lines_500)) == 500, "500 UUIDs must be 100% unique"
        for line in lines_500[:20]: # Check sample
            assert UUID_V4_UPPERCASE_REGEX.match(line), f"Invalid uppercase UUID: {line}"
        print(f"✓ Successfully generated {len(lines_500)} unique uppercase UUID v4s")
        
        await page.screenshot(path=f"{OUTPUT_DIR}/03_desktop_generate_500_uppercase.png", full_page=True)
        
        # Test Clear Button
        btn_clear = page.locator("#tab-generate button:has-text('Clear')")
        await btn_clear.click()
        await asyncio.sleep(0.2)
        cleared_val = await page.input_value("#genOutputText")
        assert cleared_val == "", "Output text should be cleared"
        print("✓ Clear button cleared output text")
        
        # Test Bridge to Scan: Generate 100, then click "Buka di Scanner"
        preset_100 = page.locator("button[onclick='setGenPresetCount(100)']")
        await preset_100.click()
        await page.select_option("#genFormatSelect", "standard")
        await btn_gen.click()
        await asyncio.sleep(0.5)
        
        btn_scan_bridge = page.locator("#tab-generate button:has-text('Buka di Scanner')")
        await btn_scan_bridge.click()
        await asyncio.sleep(0.5)
        
        # Check that we are now on #tab-scan and paste area has the 100 UUIDs
        assert await page.is_visible("#tab-scan"), "Scanner tab should be visible after bridge"
        assert await page.is_visible("#scanModePaste"), "Paste mode should be visible"
        paste_val = await page.input_value("#scanPasteInput")
        paste_lines = [l.strip() for l in paste_val.strip().split("\n") if l.strip()]
        assert len(paste_lines) == 100, f"Expected 100 UUIDs in scanner paste area, got {len(paste_lines)}"
        print("✓ Bridge 'Buka di Scanner' passed 100 UUIDs successfully to Scanner tab")
        
        await page.screenshot(path=f"{OUTPUT_DIR}/04_desktop_bridge_to_scanner.png", full_page=True)
        
        await context.close()
        
        # Test 2: Mobile Viewport 390x844 (iPhone 12/13/14)
        print("\n--- Testing Mobile Viewport (390px) ---")
        mob_context = await setup_authenticated_context(browser, 390, 844, is_mobile=True)
        mob_page = await mob_context.new_page()
        await mob_page.goto("http://127.0.0.1:4090/#generate", wait_until="domcontentloaded")
        await asyncio.sleep(0.8)
        
        await mob_page.screenshot(path=f"{OUTPUT_DIR}/05_mobile_generate_390_initial.png", full_page=True)
        
        # Click 100 preset and generate
        mob_preset_100 = mob_page.locator("button[onclick='setGenPresetCount(100)']")
        await mob_preset_100.click()
        mob_btn_gen = mob_page.locator("#btnGenerateFamcode")
        await mob_btn_gen.click()
        await asyncio.sleep(0.5)
        
        await mob_page.screenshot(path=f"{OUTPUT_DIR}/06_mobile_generate_390_results.png", full_page=True)
        
        # Check offcanvas mobile navigation
        btn_nav_toggle = mob_page.locator("button.navbar-toggler, button[data-bs-toggle='offcanvas']").first
        if await btn_nav_toggle.is_visible():
            await btn_nav_toggle.click()
            await asyncio.sleep(0.5)
            await mob_page.screenshot(path=f"{OUTPUT_DIR}/07_mobile_offcanvas_menu_generate.png")
            # Close offcanvas
            close_btn = mob_page.locator(".offcanvas .btn-close")
            if await close_btn.is_visible():
                await close_btn.click()
                await asyncio.sleep(0.3)
        
        await mob_context.close()
        
        # Test 3: Responsive Viewport Checks (360px & 412px)
        print("\n--- Testing Responsive Viewports (360px & 412px) ---")
        for width in [360, 412]:
            resp_ctx = await setup_authenticated_context(browser, width, 800, is_mobile=True)
            resp_page = await resp_ctx.new_page()
            await resp_page.goto("http://127.0.0.1:4090/#generate", wait_until="domcontentloaded")
            await asyncio.sleep(0.5)
            await resp_page.locator("#btnGenerateFamcode").click()
            await asyncio.sleep(0.5)
            await resp_page.screenshot(path=f"{OUTPUT_DIR}/responsive_generate_{width}.png", full_page=True)
            print(f"✓ Generated responsive screenshot for {width}px")
            await resp_ctx.close()

            
        await browser.close()
        print("\n🎉 ALL GENERATE FAMCODE TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    asyncio.run(run_tests())
