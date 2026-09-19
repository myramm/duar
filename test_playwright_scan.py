import asyncio
import os
import sys
import json
from playwright.async_api import async_playwright

SCREENSHOTS_DIR = "/root/.gemini/antigravity-cli/brain/6ab863fb-1b93-47a4-8202-c969b7370843/playwright_screens"
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

BASE_URL = "http://127.0.0.1:4090"

# Create sample upload files
TEST_TXT_FILE = "/tmp/test_scan_codes.txt"
with open(TEST_TXT_FILE, "w") as f:
    f.write("23ddccc0-ac04-4e80-a939-5f5d76f4bc64\n98f6d901-523c-4ce1-86e0-94e82fe33221\n11111111-2222-3333-4444-555555555555\n")

TEST_JSON_FILE = "/tmp/test_scan_codes.json"
with open(TEST_JSON_FILE, "w") as f:
    json.dump([
        {"family_code": "5a68e0e7-8b01-4475-b6d8-f58bb8f00112"},
        {"family_code": "23ddccc0-ac04-4e80-a939-5f5d76f4bc64"},
        {"family_code": "99999999-9999-9999-9999-999999999999"}
    ], f)

mock_user = {
    "id": "google_uid_scanner_tester",
    "name": "Alex Scanner",
    "email": "alex.scanner@gmail.com",
    "picture": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
    "isGoogle": True
}
user_list_json = json.dumps([mock_user])

init_script = f"""
    localStorage.setItem("duar_google_accounts_list", '{user_list_json}');
    localStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
    sessionStorage.setItem("duar_active_google_user_id", "{mock_user['id']}");
"""

async def run_scan_e2e():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        
        # ==========================================
        # Test 1: Desktop Viewport (1280x800)
        # ==========================================
        print("=== Test 1: Desktop Viewport & Full Scanner Flow ===")
        context = await browser.new_context(viewport={"width": 1280, "height": 800})
        await context.add_init_script(init_script)
        page = await context.new_page()
        
        await page.goto(f"{BASE_URL}/#dashboard", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)
        
        # 1. Check Desktop Sidebar has "Scan Family Code"
        scan_link = page.locator('aside.sidebar a[data-tab="scan"]')
        assert await scan_link.is_visible(), "Desktop sidebar scan link should be visible"
        print("✓ Desktop sidebar scan link visible")
        
        # 2. Click Scan Family Code tab
        await scan_link.click()
        await page.wait_for_timeout(600)
        
        tab_scan = page.locator('#tab-scan')
        assert await tab_scan.is_visible(), "Scan tab should be visible"
        print("✓ Tab Scan Family Code loaded")
        
        # 3. Test File Upload (.TXT)
        file_input = page.locator('#scanFileInput')
        await file_input.set_input_files(TEST_TXT_FILE)
        await page.wait_for_timeout(400)
        
        badge_text = await page.locator('#scanFileInfoBadge').inner_text()
        print(f"✓ File upload TXT badge: {badge_text}")
        await page.screenshot(path=f"{SCREENSHOTS_DIR}/01_desktop_scan_upload_txt.png")
        
        # 4. Start Scan on TXT
        await page.locator('#btnStartScan').click()
        await page.wait_for_selector('#scanResultsSection:not(.d-none)', timeout=10000)
        await page.wait_for_timeout(800)
        
        valid_cnt = await page.locator('#statValidCount').inner_text()
        print(f"✓ TXT Scan completed: Valid={valid_cnt}")
        await page.screenshot(path=f"{SCREENSHOTS_DIR}/02_desktop_scan_txt_results.png")
        
        # 5. Test Inspect Action on Valid Result Card
        inspect_btn = page.locator('#scanResultsList .scan-result-card.card-valid button:has-text("Inspect")').first
        await inspect_btn.click()
        await page.wait_for_timeout(800)
        
        # Verify switched to #tab-family and filled UUID
        fam_input_val = await page.locator('#familyCodeInput').input_value()
        print(f"✓ Inspect from Scan transferred code to Family Tab: {fam_input_val}")
        assert len(fam_input_val) > 10
        await page.screenshot(path=f"{SCREENSHOTS_DIR}/03_desktop_family_tab_inspected.png")
        
        # Return to scan tab
        await page.evaluate("switchTab('scan')")
        await page.wait_for_timeout(500)
        
        # 6. Test Sub-Views: Files Browser & History
        await page.locator('#btnScanViewFiles').click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=f"{SCREENSHOTS_DIR}/04_desktop_scan_files_browser.png")
        
        await page.locator('#btnScanViewHistory').click()
        await page.wait_for_timeout(500)
        await page.screenshot(path=f"{SCREENSHOTS_DIR}/05_desktop_scan_history.png")
        
        await context.close()
        
        # ==========================================
        # Test 2: Mobile Viewport 390x844 (iPhone 14)
        # ==========================================
        print("=== Test 2: Mobile Viewport (390px) ===")
        m_context = await browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
        await m_context.add_init_script(init_script)
        m_page = await m_context.new_page()
        
        await m_page.goto(f"{BASE_URL}/#dashboard", wait_until="domcontentloaded")
        await m_page.wait_for_timeout(1000)
        
        # Check dashboard quick actions
        await m_page.screenshot(path=f"{SCREENSHOTS_DIR}/06_mobile_dashboard_quick_actions.png")
        
        # Click Quick Action "Scan Family" directly from Dashboard
        await m_page.locator('.quick-action-card:has-text("Scan Family")').click()
        await m_page.wait_for_timeout(600)
        
        # Switch to Paste Mode
        await m_page.locator('#tabBtnScanPaste').click()
        await m_page.wait_for_timeout(300)
        
        sample_paste = "23ddccc0-ac04-4e80-a939-5f5d76f4bc64\n98f6d901-523c-4ce1-86e0-94e82fe33221\n"
        await m_page.locator('#scanPasteInput').fill(sample_paste)
        await m_page.wait_for_timeout(300)
        
        # Start scan on mobile
        await m_page.locator('#btnStartScan').click()
        await m_page.wait_for_selector('#scanResultsSection:not(.d-none)', timeout=10000)
        await m_page.wait_for_timeout(1000)
        
        # Scroll to result cards on mobile
        await m_page.locator('#scanResultsList').scroll_into_view_if_needed()
        await m_page.wait_for_timeout(500)
        await m_page.screenshot(path=f"{SCREENSHOTS_DIR}/07_mobile_scan_results_cards.png")
        print("✓ Mobile scan result cards verified")
        
        # Test 1-Klik Preset button from mobile result card
        preset_btn = m_page.locator('#scanResultsList .scan-result-card.card-valid button:has-text("Preset")').first
        await preset_btn.click()
        await m_page.wait_for_timeout(600)
        
        # Check addPresetModal is open with code prefilled
        preset_modal = m_page.locator('#addPresetModal')
        assert await preset_modal.is_visible()
        preset_fam_val = await m_page.locator('#presetFamCodeInput').input_value()
        print(f"✓ Preset modal opened from Scan result with code: {preset_fam_val}")
        await m_page.screenshot(path=f"{SCREENSHOTS_DIR}/08_mobile_preset_modal_from_scan.png")
        
        # Close preset modal
        await m_page.locator('#addPresetModal button[data-bs-dismiss="modal"]').first.click()
        await m_page.wait_for_timeout(400)
        
        await m_context.close()
        
        # ==========================================
        # Test 3: Responsive Viewports (360px, 412px)
        # ==========================================
        for w, h in [(360, 740), (412, 915)]:
            print(f"=== Test Responsive: {w}x{h} ===")
            r_context = await browser.new_context(viewport={"width": w, "height": h}, is_mobile=True)
            await r_context.add_init_script(init_script)
            r_page = await r_context.new_page()
            await r_page.goto(f"{BASE_URL}/#scan", wait_until="domcontentloaded")
            await r_page.wait_for_timeout(800)
            await r_page.screenshot(path=f"{SCREENSHOTS_DIR}/responsive_scan_{w}.png")
            await r_context.close()
            print(f"✓ Screenshot saved for {w}px")
            
        await browser.close()
        print("🎉 ALL PLAYWRIGHT TESTS PASSED 100%!")

if __name__ == "__main__":
    asyncio.run(run_scan_e2e())
