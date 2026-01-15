import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    console.log('📱 Navigating to http://localhost:4321/...');
    await page.goto('http://localhost:4321/', { waitUntil: 'networkidle' });

    console.log('📸 Taking screenshot...');
    await page.screenshot({ path: 'main-page.png', fullPage: true });

    console.log('🔍 Searching for TypeORM blog post...');
    const content = await page.content();

    // Check if the blog post title exists
    const hasTitleKo = content.includes('TypeORM과 NestJS에서 커넥션 풀');
    const hasTitleEn = content.includes('Proper Connection Pool Configuration');
    const hasConnectionPool = content.includes('Connection Pool') || content.includes('커넥션 풀');

    console.log('\n📊 Results:');
    console.log('- Korean title found:', hasTitleKo);
    console.log('- English title found:', hasTitleEn);
    console.log('- "Connection Pool" keyword found:', hasConnectionPool);

    // Get all blog post titles on the page
    const titles = await page.$$eval('article a h3, article h2, .post-title, [class*="title"]',
      elements => elements.map(el => el.textContent?.trim()).filter(t => t)
    );

    console.log('\n📝 Found blog post titles:');
    titles.forEach((title, i) => {
      console.log(`${i + 1}. ${title}`);
    });

    if (!hasTitleKo && !hasTitleEn && !hasConnectionPool) {
      console.log('\n❌ TypeORM connection pool post NOT found on main page');

      // Check all links on the page
      const allLinks = await page.$$eval('a', links =>
        links.map(link => ({ href: link.href, text: link.textContent?.trim() }))
          .filter(l => l.text && l.text.length > 0)
      );

      console.log('\n🔗 All links on page:');
      allLinks.slice(0, 20).forEach(link => {
        console.log(`- ${link.text} (${link.href})`);
      });
    } else {
      console.log('\n✅ TypeORM connection pool post FOUND on main page!');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
})();
