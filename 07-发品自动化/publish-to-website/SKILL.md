---
name: publish-to-website
description: 把已归档的型号营销内容自动发布到独立站 fouwell.com（英文版+俄文版/ru/双语同步发布）——生成/更新独立站内容包、同步图片和视频、写入 js/data.js、翻译俄语spec写入 js/i18n-ru.js、重新构建EN+RU静态页、本地验证、部署到生产、更新 GSC/Bing/Yandex 三张索引追踪表和发布状态表。触发词：发布到独立站、独立站发布、上线fouwell.com、独立站待发布。对应文档：schema/products-schema.md"工作流G：独立站发布"（两者需保持一致）。
---

# 独立站发布（工作流 G）

把某个（或一批）已经完成营销内容归档（`营销素材包/01-营销内容/[Model].md` 存在）的型号，发布成 fouwell.com 上的正式商品页。

**触发时机**：型号的整个 `营销素材包` 流程跑完之后——工作流C全部步骤完成，若满足条件触发了工作流E（短视频生成）则要等E也跑完，即 `00-营销计划/01-营销内容/02-营销图片`（Tier2还有`03-营销视频`）该有的都已就绪，且该型号 `wiki/products/[Brand]/[Category]/[ModelNumber].md` frontmatter 的 `website_status` 不是 `published`。**不是"01-营销内容一归档就触发"**——2026-09-13最初就是这么定的，结果02/03还没就绪时就发布，出了图片只有1张、视频缺失的残缺页面，靠用户事后发现才补跑，当天已改成"等整个营销素材包流程跑完再触发"。

**代码所在**：`fouwell-website/` 是独立的 git 仓库（嵌套在 llm-wiki 目录下），部署直接影响生产环境（fouwell.com 真实线上站点）。

---

## 五条核心原则（全部来自 2026-09-13 实际踩过的坑，照做，不要凭直觉改）

1. **图片/视频只认 `营销素材包`，绝不直接读 `raw/products/`**——`raw/` 是不可变源层，`营销素材包/02-营销图片/产品素材图片/`（真实照片，nameplate+photos 已合并去重）才是策展过的成品，没有真实照片时兜底用 `营销素材包/02-营销图片/LinkedIn/*.png`（渲染好的营销卡片，是合法素材，不是占位图）。视频只认 `营销素材包/03-营销视频/*.mp4`，中英双版本时取文件名含 `_EN_` 的那个。
2. **图片/视频路径必须带开头的 `/`**（`/assets/products/...`、`/assets/videos/...`）。前端把这个字段当绝对路径处理，少了这个斜杠会被浏览器当成"相对当前页面"解析——2026-09-13 真实发生过：这个bug让**全站**（不只是新发布的型号）图库同时失效，用户强制刷新都无法恢复，因为路径本身就是错的，跟缓存无关。
3. **不确定的价格/参数一律留空，不编造**。价格按优先级走"AI价格解析流程"：① `04-独立站内容包`已有内部售价直接用；② **型号来源是询盘单（`source: inquiry_sheet`）且原始Excel带"②询价单"页时，优先级最高**——取该型号全部询价记录里最低的人民币单价，×1.05（5个点利润）后按当天真实汇率换算成USD，`price_source: procurement_quote_min`，同时把这个最低单价原样回填进 `wiki/products/[ModelNumber].md` frontmatter 的 `procurement_cost_cny`；③ 询价单没有价格数据/无货，或型号根本不是来自询盘单 → 退到eBay/网页搜索兜底（多个精确匹配取中位数，**排除已结束的拍卖、明显异常价格、404死链**）；④ 什么都查不到 → 留空，不编造。
4. **非正品/非单一品牌的SKU必须登记进 `js/data.js` 的 `NON_GENUINE_BRANDS`**。网站默认对所有品牌显示"100% genuine"信任条款和"Genuine [brand]..."meta description，对披露过"非原厂/无单一厂商"的品牌（如兼容板用的 `PWERUN`、无厂商可考的 `Generic`/`General`）这套话术是虚假宣传，必须显式排除。
5. **部署前必须本地真实浏览器渲染验证，curl 不够**。curl 只能确认文件在服务器上存在，测不出前端路径拼接错误（原则2那种bug），也测不出 SiteGround Dynamic Cache 是否让新内容真正生效。正确方法：本地起静态服务器 + 用 `ego-browser` **禁用缓存**加载页面，检查主图 `naturalWidth > 0`（真实加载出来，不是破图）、缩略图数量对得上、视频区块该显示的显示。
6. **型号里带真实斜杠（`/`）时，`build_photos.py`/`build_videos.py`的 `ALIASES` 字典必须补映射**（2026-09-13 OMRON `E6C2-CWZ6C 2500P/R` 实战踩到）。这两个脚本内部用文件系统安全的目录名（斜杠替换成下划线，如 `E6C2-CWZ6C-2500P_R`）当扫描时的 key，但 `js/data.js` 的 `p.model` 字段是带斜杠的原始型号字符串——两者对不上，`PRODUCT_PHOTOS[p.model]`/`PRODUCT_VIDEOS[p.model]` 查找会静默失败，页面主图直接破图。只要型号本身含 `/`，处理前先去两个脚本顶部的 `ALIASES = {...}` 里加一条 `"目录安全名": "真实型号（带斜杠）"`，这条不做原则5的本地验证也大概率测不出来（curl能返回200，因为URL里的斜杠恰好也能通过嵌套目录结构解析通，只有浏览器里查`PRODUCT_PHOTOS`这个JS对象查找会失败）。

---

## 输入解析

用户可能给：
- 一个具体型号（"把XXX发布到独立站"）
- "所有独立站待发布的"（批量）——先读 `wiki/marketing/发布状态.md` 的"独立站待发布"表格，取全部型号
- 隐式触发（工作流C刚归档完某型号的营销内容）——单个型号

批量时，第1-2步（内容包生成、品牌登记检查）、第6步（俄语翻译）逐个型号做；第3-5、7-10步（同步资产/构建/验证/部署/追踪表）合并成一轮跑完，减少重复部署次数。

---

## 执行步骤

### 1. 确认/生成 `04-独立站内容包/[ModelNumber].md`

若 `wiki/marketing/[Brand]/[Category]/[ModelNumber]/营销素材包/04-独立站内容包/[ModelNumber].md` 已存在，跳过本步，直接复用。否则新建，包含：

- **首屏定义块**（40-60词自包含答案）+ **规格参数表**：内容来自 `wiki/products/[Brand]/[Category]/[ModelNumber].md` 里已确认的字段（品牌/系列/型号/规格），标了 `[待确认]` 的字段不引用、不臆测
- **价格**：按上面原则3的优先级查——先看型号是不是来自询盘单且带"②询价单"页，有的话直接用询价单最低价×1.05换算USD（`procurement_quote_min`，同时回填 `procurement_cost_cny`），没有就退到eBay（WebSearch 搜 `site:ebay.com "<型号>" <品牌>`，用 `ego-browser` 打开候选listing核对真实成交价，剔除ended/异常/死链，多个精确匹配取中位数，全部换算成USD）；查不到就留空，`price_source` 留空
- 品牌若是disclosed非OEM/无单一厂商 → 文件顶部加一行注明，品牌字段填实际制造商（如"PWERUN"），不要填被兼容/影射的原厂品牌名

### 2. 检查 `fouwell-website/js/data.js` 的 `NON_GENUINE_BRANDS`

如果这批型号里有品牌本身就是"非正品/通用规格件"（第1步已经识别），确认它在 `NON_GENUINE_BRANDS` 这个 Set 里；不在就加进去。

### 3. 同步图片

```bash
cd /Users/mac/Documents/llm-wiki
python3 scripts/build_photos.py
```

全量重跑，幂等安全，会重新生成 `fouwell-website/js/photos.js` 和 `fouwell-website/assets/products/<model>/{photos,linkedin}/`。跑完看输出里 "using LinkedIn-card fallback" 那一行，确认走fallback的型号确实是没有真实照片的（不是产品素材图片路径拼错导致误判）。

### 4. 同步视频

```bash
python3 scripts/build_videos.py
```

全量重跑。如果输出里出现 `WARNING: no English translation registered for hook`，说明有新的中文故事钩子标题从未翻译过——打开 `scripts/build_videos.py`，在 `TITLES` 字典里补一条准确的英文翻译，然后重新跑这一步，**不要把中文占位标题带上线**。

### 5. 生成/更新独立站商品数据

```bash
cd fouwell-website
node scripts/generate-data-entry.js --dry-run
```

核对输出的每一条：brand（非正品SKU是不是用了正确的品牌名，不是原厂名）、spec（有没有被截断成半句话）、price（数字是否合理，是否标了正确的price_source）。确认无误后：

```bash
node scripts/generate-data-entry.js
```

去掉 `--dry-run` 正式写入 `js/data.js`。

### 6. 翻译俄语内容，写入 `js/i18n-ru.js`（2026-09-14新增——俄语站/ru/与英文站1:1对应，不是可选步骤）

fouwell.com 有一个完整的俄语镜像站（`/ru/products/<slug>/`、`/ru/products/<cat>/`、`/ru/brands/<slug>/`，跟EN站每一个页面一一对应），**每发布一个新SKU都要同步补上它的俄语版**，不是等积累一批再补。第5步 `generate-data-entry.js` 只会写入EN的`spec`一句话摘要，**永远不会**生成 `specs`/`applications`/`compatibility`/`faq` 这些"深度页"富字段（那是极少数SKU手工加的，见下方"深度页"说明）——所以走这条自动化流程发布的SKU，俄语这边要做的事很简单：

1. 把这一步新写入 `js/data.js` 的 `p.spec` 准确翻译成专业、自然的俄语技术文案（不是机翻腔——参考 `js/i18n-ru.js` 里已有的82条译文的用词/句式风格：型号本身、品牌名、系列代号一律不翻译，只翻译描述性文字；标准工控术语用已有译法，如"преобразователь частоты"=变频器/inverter、"сервопривод"=伺服驱动器、"датчик приближения"=接近传感器）
2. 打开 `fouwell-website/js/i18n-ru.js`，在 `PRODUCT_SPEC_RU` 这个对象里加一行 `"<型号>": "<俄语译文>",`（型号字符串必须跟 `js/data.js` 里 `p.model` 完全一致，包括大小写和空格——这个字段是按 `p.model` 做key查找的，查不到会静默回退显示英文，不会报错，容易漏查）
3. 品牌若已登记在 `NON_GENUINE_BRANDS`（第2步检查过）：这条不需要额外处理，`genericFaqFor_ru()` 会自动读同一个 `NON_GENUINE_BRANDS` 集合、跳过"正品/оригинал"话术，跟EN那边的 `genericFaqFor()` 逻辑保持一致，不用手动同步
4. 编辑完立刻跑 `node --check js/i18n-ru.js` 确认没有手滑破坏JS对象字面量语法（少个逗号/引号不匹配这类）
5. **"深度页"（specs/applications/compatibility/faq富字段）是例外情况，不是这条自动化流程要处理的**——如果这次要发布的SKU业务上判断值得投入深度页（比如主推爆款），那是营销侧单独决定后手工给 `js/data.js` 加字段的动作，加完之后按 `schema/products-schema.md`"俄语站 /ru/"章节里"新增俄语页面时要做的事"第5条，去 `js/i18n-ru.js` 的 `PRODUCT_DEEP_RU` 补完整的四个字段俄语翻译——这个不在本skill的常规范围内，遇到了另开一轮处理，不要为了赶发布进度就跳过

### 7. 重新构建静态页（EN + RU）

```bash
node scripts/build-product-pages.js
node scripts/build-hub-pages.js
node scripts/build-product-pages-ru.js
node scripts/build-hub-pages-ru.js
```

**顺序不能反**——RU脚本会读EN脚本已生成的 `products/index.html`/`ru/products/index.html` 当页面外壳（topbar/nav/footer）来源。四个脚本跑完后 `sitemap-v2.xml` 会包含新SKU的EN和RU两条URL（`build-hub-pages.js`最后一步统一重新生成）。

### 8. 本地验证（不可省略，EN + RU 都要测）

```bash
cd /Users/mac/Documents/llm-wiki/fouwell-website
(python3 -m http.server 8321 > /tmp/httpserver.log 2>&1 &)
sleep 1
```

用 `ego-browser` **分别**加载本次发布的型号页的EN版（`http://localhost:8321/products/<slug>/`）和RU版（`http://localhost:8321/ru/products/<slug>/`），关键代码（两个URL跑同一段）：

```js
await page.cdp('Network.enable', {});
await page.cdp('Network.setCacheDisabled', { cacheDisabled: true });
await page.goto("http://localhost:8321/ru/products/<slug>/", { timeout: 15000 });
await page.waitForTimeout(1500);
const result = await page.evaluate(() => {
  const mainImg = document.getElementById('pd-main-img');
  const section = document.getElementById('detail-video-section');
  const badges = document.getElementById('pd-badges');
  return {
    mainImgNaturalWidth: mainImg ? mainImg.naturalWidth : null,   // 必须 >0，等于0说明图片没真实加载
    thumbCount: document.querySelectorAll('#pd-thumbs > *').length, // 应等于该型号的实拍图/兜底图数量
    videoSectionVisible: section ? section.style.display !== 'none' : null, // 有视频的型号应为true
    badgesText: badges ? badges.textContent : null, // RU页面这里必须是俄语（如"В наличии"），不是英文
  };
});
```

**RU页面额外要核对的一点**：`js/main.js` 靠客户端JS对RU页面做二次渲染（补齐相册/相关商品等），如果这一层language分流哪里没接对（比如 `resolveProductFromURL()` 认不出 `/ru/...` 路径这种2026-09-14实际踩过的bug），静态HTML是对的、但JS跑完会用英文/空内容覆盖掉——只看静态HTML源码测不出来，**必须让JS真的在浏览器里跑一遍**才能验证，上面这段代码里 `badgesText` 就是专门用来抓这类问题的。任何一项不对就地排查修复，重新跑第3-7步，直到验证通过再继续。验证完：

```bash
pkill -f "http.server 8321"
```

### 9. 部署到生产

```bash
./scripts/deploy.sh
```

会自动把所有 `.js`/`.css` 的 `?v=` 缓存版本号统一换成新时间戳，再 rsync 到 SiteGround（`u1796-rxnrbib8x7ji@gcam1252.siteground.biz:www/fouwell.com/public_html/`，端口18765，密钥 `~/.ssh/fouwell_deploy_key`），并自动跑IndexNow把 `sitemap-v2.xml` 全量URL（含新SKU的EN+RU两条）推给Bing/Yandex。这一步会真实推送到生产环境——推送前如果当前会话的操作规范要求对生产部署做确认，按规范来，不要跳过。

### 10. 同步 GSC + Bing + Yandex 索引提交追踪表

```bash
node scripts/sync-indexing-tracker.js
```

读 `sitemap-v2.xml`，新SKU的EN URL会补进 `wiki/products/GSC索引提交追踪表.md`（"未提交"）和 `wiki/products/Bing索引提交追踪表.md`（"未确认"），RU URL会补进 `wiki/products/Yandex索引提交追踪表.md`（"未确认"）——三张表同一次脚本运行一起更新，按语种/引擎自动分流，不会混装（2026-09-14拆分，之前RU行曾错误追加进GSC/Bing表）。已修复过它在 Obsidian 重新格式化表格（列对齐加空格）后误判"这个URL还没出现过"导致重复插入的问题，正常情况下不需要干预。

**可选加分项**：如果 Yandex Webmaster Tools 已注册（2026-09-14已注册，见 `wiki/products/Yandex索引提交追踪表.md` 页头），可以把新SKU的RU URL顺手粘进 `webmaster.yandex.com/site/.../indexing/reindex/` 的"Reindex pages"工具（每天限额150个URL，个位数新增基本不会碰到这个上限）——这是一次性优先处理信号，不是必须步骤，跳过也不影响IndexNow的自动推送。

### 11. 回填型号页面 frontmatter

在 `wiki/products/[Brand]/[Category]/[ModelNumber].md` 里：

```yaml
website_status: published
website_url: <第7步构建出的真实EN URL，从 fouwell-website 里用 productUrl() 逻辑算出来的那个，不要手拼>
website_url_ru: <对应的RU URL，即 /ru + website_url，如 website_url 是 /products/foo/ 就是 /ru/products/foo/>
website_published_date: <今天日期，YYYY-MM-DD>
```

### 12. 重建发布状态表

重新生成 `wiki/marketing/发布状态.md` 全表（不要手工加一行了事——历史上手工加行出过 regex 匹配不到、字段对不齐的问题）。逻辑：扫描 `wiki/products/` 下每个型号的 `website_status`/`social_published` frontmatter，按"社媒已发布/内容已生成待发布/待生成"和"独立站已发布/待发布/型号待确认"分类统计，生成总表 + 需要关注清单。

> **2026-09-13新增"创建时间"字段+排序规则**：每行取该型号 `wiki/products/[Brand]/[Category]/[ModelNumber].md` 文件的本地文件系统创建时间戳（`stat`的`birthtime`，精确到分钟），全表（含"社媒待发布"子表）按这个字段**倒序排列，最新型号永远在第一行**。定位方式（Python）：`os.stat(path).st_birthtime`，格式化成 `YYYY-MM-DD HH:MM`。不要用 git log 的首次提交时间做这个字段——本仓库存在大量未提交/已修改文件，git 历史对这批文件不完整、不可靠。

### 13. 追加 log 条目

`wiki/log.md` 顶部插入：`## [YYYY-MM-DD] website | <型号列表> 独立站发布（图片N张、视频有/无、价格来源、EN+RU）`

### 14. 提醒用户

明确告诉用户：**SiteGround Dynamic Cache 需要人工去后台 Flush**（SITE TOOLS → SuperCacher → Dynamic Cache → fouwell.com 行 → Flush Cache 火箭图标）——没有命令行/curl PURGE方法，这是唯一必须由人完成、无法自动化的步骤，不清的话缓存会在3小时后自动失效兜底但不必等。
