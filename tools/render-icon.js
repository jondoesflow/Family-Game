// Renders tools/icon.html to the 1024x1024 app icon PNG using the preinstalled Chromium.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(__dirname, 'icon.html'));
  await page.waitForTimeout(600);
  const out = path.resolve(__dirname, '..', 'ios/FamilyGame/Assets.xcassets/AppIcon.appiconset/AppIcon.png');
  await page.screenshot({ path: out, type: 'png', omitBackground: false });
  await browser.close();
  console.log('wrote', out);
})();
