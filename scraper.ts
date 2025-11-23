import fs from "fs";

async function initStealthPuppeteer() {
  const puppeteerExtra = (await import("puppeteer-extra")).default;
  const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
  puppeteerExtra.use(StealthPlugin());
  return puppeteerExtra;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ✅ get Arc'teryx  slug
function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function fetchAllProducts(url: string) {
  const puppeteer = await initStealthPuppeteer();
  let products: any[] = [];

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
    defaultViewport: { width: 1366, height: 900 },
  });

  try {
    const page = await browser.newPage();

    // 慢网速：统一加大默认超时时间
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    // 拦截请求，禁用图片/媒体/字体，减轻 1M 带宽压力
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return req.abort();
      }
      req.continue();
    });

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    });

    // 🍪 get cookies.json  or .env
    if (fs.existsSync("cookies.json")) {
      try {
        let cookies = JSON.parse(fs.readFileSync("cookies.json", "utf-8"));
        cookies = cookies.map((c: any) => {
          const fixed = { ...c };

          // 移除 Puppeteer 不支持的 SameSite 组合
          if (!["Strict", "Lax", "None"].includes(fixed.sameSite)) {
            delete fixed.sameSite;
          }

          // 修正 expires 字段类型
          if (fixed.expires && typeof fixed.expires !== "number")
            delete fixed.expires;

          return fixed;
        });

        await page.setCookie(...cookies);
        console.log("🍪 已从 cookies.json 注入 Cookie");
      } catch (e) {
        console.error("⚠️ 读取 cookies.json 失败:", e);
      }
    } else if (process.env.ARCTERYX_COOKIE) {
      const cookiePairs = process.env.ARCTERYX_COOKIE.split(";").map((c) => {
        const [name, ...rest] = c.trim().split("=");
        return { name, value: rest.join("="), domain: ".arcteryx.com" };
      });
      await page.setCookie(...cookiePairs);
      console.log("🍪 已从 .env 注入自定义 Cookie");
    }

    console.log("🔗 打开页面:", url);
    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 120000,
    });

    // 首屏再多等一会儿，给慢网速足够时间
    await delay(5000);
    await page.screenshot({ path: "page_debug.png", fullPage: true });
    console.log("📸 已保存截图 page_debug.png");

    // === 滚动懒加载（针对慢网速优化）===
    let scrollTimes = 0;
    let stableRounds = 0;
    let lastCount = 0;

    while (true) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 0.8);
      });

      // 1M 带宽下，每次滚动后多等一会儿（可视情况调成 3000~6000）
      await delay(4000);
      scrollTimes++;

      const count = await page.evaluate(
        () => document.querySelectorAll("a.qa--product-tile__link").length
      );
      console.log(`↕️ 滚动第 ${scrollTimes} 次，当前商品数: ${count}`);

      if (count === lastCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastCount = count;
      }

      // 连续 3 轮商品数量没变，或者滚动次数过多，则认为到底了
      if (stableRounds >= 3 || scrollTimes > 80) {
        break;
      }
    }

    // 滚动结束后，再额外等几秒，确保最后一屏加载完成
    await delay(3000);

    // === 抓取数据（适配 Outlet 结构） ===
    products = await page.evaluate(() => {
      const list: any[] = [];
      document.querySelectorAll("a.qa--product-tile__link").forEach((el) => {
        const nameEl = el.querySelector(".sc-c100b712-307") as HTMLElement;
        const priceEl =
          (el.querySelector(".qa--product-tile__price") as HTMLElement) ||
          (el.querySelector(
            ".qa--product-tile__original-price"
          ) as HTMLElement);

        const name = nameEl?.innerText?.trim();
        const price = priceEl?.innerText?.trim();
        const href = (el as HTMLAnchorElement)?.getAttribute("href");

        if (name && price && href)
          list.push({
            name,
            price,
            link: `https://arcteryx.com${href}`,
          });
      });
      return list;
    });

    console.log(`✅ 共抓取到 ${products.length} 个商品`);

    //   save cookie
    const newCookies = await page.cookies();
    fs.writeFileSync("cookies.json", JSON.stringify(newCookies, null, 2));
    console.log(` saved cookie (${newCookies.length}  )  in  cookies.json`);
  } catch (e) {
    console.error("抓取失败:", e);
  } finally {
    await browser.close();
  }

  // get  product info
  return products.map((p) => ({
    ...p,
    slug: slugify(p.name),
  }));
}
