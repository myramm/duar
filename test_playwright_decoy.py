import asyncio
import os
import json
from playwright.async_api import async_playwright

ARTIFACTS_DIR = "/root/.gemini/antigravity-cli/brain/6ab863fb-1b93-47a4-8202-c969b7370843"
SCREENSHOT_DIR = os.path.join(ARTIFACTS_DIR, "playwright_screens")
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

async def test_decoy_features():
    print("🚀 Memulai Test E2E DEC0Y Multi-Decoy Entitlement...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        
        # 1. Test Mobile View (390 x 844 - iPhone 14 / modern Android)
        context = await browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=2
        )

        mock_user = {
            "id": "google_uid_101",
            "name": "Rizky Ramadhan",
            "email": "rizky.ramadhan99@gmail.com",
            "picture": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
            "isGoogle": True
        }

        user_list_json = json.dumps([mock_user])

        # Set localStorage before navigation
        await context.add_init_script(f"""
            localStorage.setItem("duar_google_accounts_list", '{user_list_json}');
            localStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
            sessionStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
        """)

        page = await context.new_page()

        # Step 1: Open dashboard and reset to clean premium state
        await page.goto("http://localhost:4090/#dashboard", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)

        # Reset package to Premium with Main active via API
        await page.evaluate("""async () => {
            await fetch('/api/decoy/set-package', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'X-User-Id': 'google_uid_101'},
                body: JSON.stringify({package_id: 'premium', is_expired: false})
            });
            await fetch('/api/decoy/switch', {
                method: 'POST',
                headers: {'Content-Type': 'application/json', 'X-User-Id': 'google_uid_101'},
                body: JSON.stringify({decoy_id: 'main'})
            });
            if (typeof refreshStatus === 'function') await refreshStatus();
            if (typeof loadDecoyEntitlements === 'function') await loadDecoyEntitlements();
        }""")
        await page.wait_for_timeout(800)

        # Capture Screenshot 01: Mobile Dashboard
        await page.screenshot(path=f"{SCREENSHOT_DIR}/01_mobile_dashboard_decoy.png")
        print("✓ Screenshot 01: Mobile Dashboard with Decoy Card captured.", flush=True)

        # Check Dashboard Decoy Card elements
        dash_decoy_title = await page.text_content("#dashActiveDecoyTitle")
        dash_pkg_name = await page.text_content("#dashActivePackageName")
        dash_avail_count = await page.text_content("#dashDecoyAvailableCount")
        print(f"  Dashboard active decoy: {dash_decoy_title} | Package: {dash_pkg_name} | {dash_avail_count}", flush=True)
        assert "Decoy Utama" in dash_decoy_title
        assert "Premium" in dash_pkg_name

        # Step 2: Switch to DEC0Y Management Tab
        await page.evaluate("switchTab('decoy')")
        await page.wait_for_timeout(800)

        # Capture Screenshot 02: Mobile Decoy Tab (Main Active)
        await page.screenshot(path=f"{SCREENSHOT_DIR}/02_mobile_decoy_tab_main_active.png")
        print("✓ Screenshot 02: Mobile Decoy Tab (Main Active) captured.", flush=True)

        # Step 3: Switch Decoy to Decoy 2 (Fast Proxy)
        print("  Switching to Decoy 2 (Fast Proxy)...", flush=True)
        await page.locator("#decoy-card-decoy2 button").click(force=True)
        await page.wait_for_timeout(1200)

        # Capture Screenshot 03: Mobile Decoy Tab (Decoy 2 Active)
        await page.screenshot(path=f"{SCREENSHOT_DIR}/03_mobile_decoy_tab_decoy2_active.png")
        print("✓ Screenshot 03: Mobile Decoy Tab (Decoy 2 Active) captured.", flush=True)

        # Step 4: Verify Badge States
        decoy2_badge = await page.text_content("#decoy-card-decoy2 .badge-decoy-active")
        main_badge = await page.text_content("#decoy-card-main .badge-decoy-available")
        decoy4_badge = await page.text_content("#decoy-card-decoy4 .badge-decoy-locked")
        
        print(f"  Decoy 2 status: {decoy2_badge.strip()}")
        print(f"  Main status: {main_badge.strip()}")
        print(f"  Decoy 4 status: {decoy4_badge.strip()}")
        assert "ACTIVE" in decoy2_badge
        assert "AVAILABLE" in main_badge
        assert "LOCKED" in decoy4_badge

        # Step 5: Test Reload Persistence
        print("  Testing persistence across page reload...", flush=True)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)

        dash_reloaded_title = await page.text_content("#dashActiveDecoyTitle")
        print(f"  Dashboard title after reload: {dash_reloaded_title.strip()}", flush=True)
        assert "Decoy 2" in dash_reloaded_title
        print("✅ Persistence verified: Decoy 2 persisted after full reload.", flush=True)

        # Step 6: Test Desktop Viewport (1280 x 800)
        print("\n💻 Testing Desktop Viewport (1280px)...", flush=True)
        desktop_context = await browser.new_context(viewport={"width": 1280, "height": 800})
        await desktop_context.add_init_script(f"""
            localStorage.setItem("duar_google_accounts_list", '{user_list_json}');
            localStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
            sessionStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
        """)
        desktop_page = await desktop_context.new_page()
        await desktop_page.goto("http://localhost:4090/#decoy", wait_until="domcontentloaded")
        await desktop_page.wait_for_timeout(1000)

        await desktop_page.screenshot(path=f"{SCREENSHOT_DIR}/04_desktop_decoy_management.png")
        print("✓ Screenshot 04: Desktop Decoy Management captured.", flush=True)

        # Step 7: Test Enterprise Upgrade Simulator
        print("  Testing Enterprise tier simulation...", flush=True)
        await desktop_page.click("#btnPkgSimEnterprise", force=True)
        await desktop_page.wait_for_timeout(1200)

        # Decoy 4 should now be AVAILABLE
        decoy4_ent_badge = await desktop_page.text_content("#decoy-card-decoy4 .badge-decoy-available")
        print(f"  Decoy 4 on Enterprise: {decoy4_ent_badge.strip()}", flush=True)
        assert "AVAILABLE" in decoy4_ent_badge

        await desktop_page.screenshot(path=f"{SCREENSHOT_DIR}/05_desktop_enterprise_all_unlocked.png")
        print("✓ Screenshot 05: Desktop Enterprise All 4 Decoys Unlocked captured.", flush=True)

        await browser.close()
        print("\n🎉 ALL DEC0Y E2E TESTS PASSED PERFECTLY!", flush=True)

if __name__ == "__main__":
    asyncio.run(test_decoy_features())
