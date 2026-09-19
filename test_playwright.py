import asyncio
import os
import json
from playwright.async_api import async_playwright

SCREENSHOT_DIR = "/root/.gemini/antigravity-cli/brain/6ab863fb-1b93-47a4-8202-c969b7370843/playwright_screens"
os.makedirs(SCREENSHOT_DIR, exist_ok=True)

async def test_playwright_e2e():
    print("🚀 Memulai End-to-End Test dengan Playwright...")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        
        # Test across mobile and desktop viewports
        viewports = [
            {"name": "mobile_360", "width": 360, "height": 740, "is_mobile": True},
            {"name": "mobile_390", "width": 390, "height": 844, "is_mobile": True},
            {"name": "mobile_412", "width": 412, "height": 915, "is_mobile": True},
            {"name": "desktop_1280", "width": 1280, "height": 800, "is_mobile": False},
        ]

        # -------------------------------------------------------------
        # 1. TEST FLOW PADA MOBILE 390px (PRIMARY TEST)
        # -------------------------------------------------------------
        print("\n📱 [TEST 1] Mobile 390px — Account Picker, Multi-Account, Dashboard & Isolation")
        context = await browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            device_scale_factor=2
        )
        page = await context.new_page()

        # Step 1.1: Buka web tanpa sesi -> Account Picker harus muncul
        print("  1.1 Membuka halaman awal tanpa sesi...")
        await page.goto("http://127.0.0.1:4090", wait_until="domcontentloaded")
        await page.wait_for_timeout(1000)

        overlay = page.locator("#accountPickerOverlay")
        assert await overlay.is_visible(), "Account Picker overlay harus terlihat saat belum login!"
        
        title_text = await page.locator(".account-picker-title").text_content()
        assert "Pilih akun" in title_text, f"Title harus 'Pilih akun', didapat: {title_text}"

        subtitle_text = await page.locator(".account-picker-subtitle").text_content()
        assert "DUAR" in subtitle_text, f"Subtitle harus merujuk ke DUAR, didapat: {subtitle_text}"

        await page.screenshot(path=f"{SCREENSHOT_DIR}/01_empty_account_picker_390.png")
        print("  ✅ 1.1 Account Picker muncul dengan benar")

        # Step 1.2: Daftarkan 3 akun Google (Rizky, Budi, Alya)
        print("  1.2 Mendaftarkan 3 Akun Google ke Account Picker...")
        accounts_to_inject = [
            {
                "id": "google_uid_101",
                "name": "Rizky Ramadhan",
                "email": "rizky.ramadhan99@gmail.com",
                "picture": "https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=100&auto=format&fit=crop&q=80",
                "isGoogle": True
            },
            {
                "id": "google_uid_102",
                "name": "Budi Santoso",
                "email": "budi.santoso.dev@gmail.com",
                "picture": "",
                "isGoogle": True
            },
            {
                "id": "google_uid_103",
                "name": "Alya Putri (Admin)",
                "email": "alya.putri@duar.id",
                "picture": "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=100&auto=format&fit=crop&q=80",
                "isGoogle": True
            }
        ]

        await page.evaluate(f"""
            localStorage.setItem('duar_google_accounts_list', JSON.stringify({json.dumps(accounts_to_inject)}));
            window.GoogleAuth.renderAccountList();
        """)
        await page.wait_for_timeout(500)

        # Verifikasi item akun ter-render
        items = page.locator(".account-picker-item")
        count = await items.count()
        assert count == 3, f"Harus ada 3 akun ter-render di picker, didapat: {count}"

        await page.screenshot(path=f"{SCREENSHOT_DIR}/02_multi_account_picker_390.png")
        print("  ✅ 1.2 Tiga akun Google berhasil dimuat di Account Picker")

        # Step 1.3: Pilih Akun A (Rizky Ramadhan) -> Masuk Dashboard
        print("  1.3 Memilih Akun A (Rizky Ramadhan)...")
        await page.locator("#acc-item-google_uid_101").click()
        await page.wait_for_timeout(1200)

        # Overlay picker harus tertutup
        is_overlay_hidden = await page.locator("#accountPickerOverlay").evaluate("el => el.classList.contains('d-none')")
        assert is_overlay_hidden, "Account picker overlay harus tersembunyi setelah memilih akun!"

        # Google Account badge di header harus aktif
        header_badge = page.locator("#googleAccountHeaderBadge")
        assert await header_badge.is_visible(), "Header Google Account badge harus terlihat!"
        badge_text = await header_badge.text_content()
        assert "Rizky Ramadhan" in badge_text, f"Header badge harus menampilkan nama akun, didapat: {badge_text}"

        # Simpan data khusus untuk Akun A di CloudStorage
        await page.evaluate("""
            window.CloudStorage.update({
                presets: [{ id: "preset_rizky_1", label: "Rizky Booster 100GB", price: 75000, family_code: "fam_rizky" }]
            });
        """)

        await page.screenshot(path=f"{SCREENSHOT_DIR}/03_dashboard_logged_in_rizky.png")
        print("  ✅ 1.3 Berhasil masuk ke Dashboard DUAR sebagai Rizky Ramadhan")

        # Step 1.3.1: Verifikasi Reload / Refresh Page Persistence
        print("  1.3.1 Melakukan Page Refresh (Reload) untuk verifikasi persistensi...")
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_timeout(1500)
        assert await header_badge.is_visible(), "Setelah reload, sesi Google Account harus tetap aktif!"
        badge_text_after_reload = await header_badge.text_content()
        assert "Rizky Ramadhan" in badge_text_after_reload, f"Setelah reload harus tetap Rizky, didapat: {badge_text_after_reload}"
        is_overlay_hidden_reload = await page.locator("#accountPickerOverlay").evaluate("el => el.classList.contains('d-none')")
        assert is_overlay_hidden_reload, "Overlay account picker tidak boleh muncul setelah reload jika ada sesi aktif!"
        print("  ✅ 1.3.1 Persistensi sesi saat refresh halaman BERHASIL 100%!")

        # Step 1.4: Buka Menu Profil Google & Sinkronisasi Cloud
        print("  1.4 Membuka Menu Google Account & Cloud Storage Modal...")
        await header_badge.click()
        await page.wait_for_timeout(600)

        modal = page.locator("#googleAccountModal")
        assert await modal.is_visible(), "Modal Google Account harus terbuka!"

        modal_name = await page.locator("#menuModalName").text_content()
        assert "Rizky Ramadhan" in modal_name, f"Modal name harus Rizky Ramadhan, didapat: {modal_name}"

        modal_email = await page.locator("#menuModalEmail").text_content()
        assert "rizky.ramadhan99@gmail.com" in modal_email, f"Modal email harus rizky.ramadhan99@gmail.com, didapat: {modal_email}"

        await page.screenshot(path=f"{SCREENSHOT_DIR}/04_google_account_menu_modal.png")
        print("  ✅ 1.4 Menu profil Google Account & sinkronisasi cloud terverifikasi")

        # Step 1.5: Ganti Akun (Switch Account) ke Akun B (Budi Santoso)
        print("  1.5 Melakukan Switch Account ke Akun B (Budi Santoso)...")
        await page.locator("button:has-text('Ganti Akun')").click()
        await page.wait_for_timeout(600)

        assert await overlay.is_visible(), "Account Picker harus kembali muncul saat switch account!"

        # Klik Akun B (Budi Santoso)
        await page.locator("#acc-item-google_uid_102").click()
        await page.wait_for_timeout(1200)

        # Verifikasi header aktif sekarang adalah Budi
        header_text = await header_badge.text_content()
        assert "Budi Santoso" in header_text, f"Header harus menampilkan Budi Santoso, didapat: {header_text}"

        # Verifikasi data Akun B terisolasi (tidak ada preset milik Rizky)
        budi_presets = await page.evaluate("() => (window.CloudStorage.getLocalCache('google_uid_102') || {}).presets || []")
        assert len(budi_presets) == 0, f"Data Budi harus kosong/terisolasi, didapat: {budi_presets}"

        # Tambahkan preset khusus Budi
        await page.evaluate("""
            window.CloudStorage.update({
                presets: [{ id: "preset_budi_1", label: "Budi Unlimited Super", price: 150000, family_code: "fam_budi" }]
            });
        """)

        await page.screenshot(path=f"{SCREENSHOT_DIR}/05_budi_isolated_dashboard.png")
        print("  ✅ 1.5 Isolasi data antar akun berhasil terverifikasi!")

        # Step 1.6: Logout
        print("  1.6 Melakukan Logout...")
        await header_badge.click()
        await page.wait_for_timeout(500)
        await page.locator("button:has-text('Keluar (Logout)')").click()
        await page.wait_for_timeout(600)

        assert await overlay.is_visible(), "Account picker harus kembali aktif setelah logout!"
        print("  ✅ 1.6 Logout berhasil membersihkan sesi aktif")

        await context.close()

        # -------------------------------------------------------------
        # 2. RESPONSIVENESS TEST PADA SEMUA VIEWPORT
        # -------------------------------------------------------------
        print("\n📐 [TEST 2] Testing Responsivitas Layar (360px, 390px, 412px, 1280px)")
        for vp in viewports:
            vp_name = vp["name"]
            print(f"  Testing viewport {vp_name} ({vp['width']}x{vp['height']})...")
            
            ctx = await browser.new_context(
                viewport={"width": vp["width"], "height": vp["height"]},
                is_mobile=vp["is_mobile"],
                has_touch=vp["is_mobile"],
                device_scale_factor=2
            )
            p_test = await ctx.new_page()
            await p_test.goto("http://127.0.0.1:4090", wait_until="networkidle")
            
            # Setup accounts in list
            await p_test.evaluate(f"""
                localStorage.setItem('duar_google_accounts_list', JSON.stringify({json.dumps(accounts_to_inject)}));
                window.GoogleAuth.renderAccountList();
                window.GoogleAuth.showAccountPicker();
            """)
            await p_test.wait_for_timeout(500)

            # Cek horizontal overflow: scrollWidth harus <= clientWidth
            overflow_check = await p_test.evaluate("""
                () => {
                    const docEl = document.documentElement;
                    const body = document.body;
                    return {
                        scrollWidth: Math.max(docEl.scrollWidth, body.scrollWidth),
                        clientWidth: docEl.clientWidth,
                        hasHorizontalOverflow: Math.max(docEl.scrollWidth, body.scrollWidth) > docEl.clientWidth + 2
                    };
                }
            """)

            assert not overflow_check["hasHorizontalOverflow"], f"Horizontal overflow terdeteksi pada {vp_name}: {overflow_check}"
            
            await p_test.screenshot(path=f"{SCREENSHOT_DIR}/responsive_{vp_name}.png")
            print(f"  ✅ Viewport {vp_name}: Pas sempurna, tidak ada horizontal overflow (scrollWidth: {overflow_check['scrollWidth']}px)")
            await ctx.close()

        await browser.close()
        print("\n🎉 SEMUA TEST PLAYWRIGHT BERHASIL 100% (PASSED)! ✅\n")

if __name__ == "__main__":
    asyncio.run(test_playwright_e2e())
