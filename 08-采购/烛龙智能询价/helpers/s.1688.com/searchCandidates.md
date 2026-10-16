---
name: "searchCandidates"
host: "s.1688.com"
lastVerified: 1792067650292
agent: "claude"
candidate: false
opensPage: true
description: "烛龙智能询价：Saved helper for s.1688.com"
inputs: {}
---

烛龙智能询价：Saved helper for s.1688.com

Call it:

`helpers["searchCandidates"](browser, pageId, model)`

```js
async (browser, pageId, model) => {
  // 返回 1688 搜索结果第一页前 20 条的精简候选：[排名, 商品ID, 标价, 公司名, 型号匹配, 疑似非全新, 广告]
  // 广告位的商品 ID 读不到时为空字符串；结果过大时 BrowserOS 会写入文件，所以只返回精简数组
  const page = browser.page(pageId);
  const res = await page.evaluate((model) => {
    const norm = (x) => x.toUpperCase().replace(/O/g, '0').replace(/[^A-Z0-9]/g, '');
    const key = norm(model);
    const links = [...document.querySelectorAll('a[href]')].filter((a) => /detail\.1688\.com\/offer\/\d+|dj\.1688\.com/.test(a.href));
    const out = []; const seen = new Set();
    for (const a of links) {
      let card = a;
      for (let i = 0; i < 8 && card.parentElement && !/offerCard|ad-common/.test(card.className.toString()); i++) card = card.parentElement;
      if (seen.has(card)) continue;
      seen.add(card);
      const t = card.innerText.replace(/\s+/g, ' ');
      const id = (a.href.match(/offer\/(\d+)\.html/) || [])[1] || '';
      const ad = /dj\.1688\.com/.test(a.href) || /ad-common/.test(card.className.toString()) ? 1 : 0;
      const company = (t.match(/[一-龥()（）A-Za-z0-9]{2,30}(有限公司|商行|经营部|商贸部|工作室)/) || [])[0] || '';
      out.push([out.length + 1, id, parseFloat(((t.match(/¥\s*([\d.]+)/) || [])[1]) || '0'), company,
        norm(t).includes(key) ? 1 : 0, /基本全新|二手|拆机|翻新|99新|九成新/.test(t) ? 1 : 0, ad]);
    }
    return out.slice(0, 20);
  }, model);
  return res && res.value !== undefined ? res.value : res;
}
```
