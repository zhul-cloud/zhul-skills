---
name: "searchCandidates"
host: "s.taobao.com"
lastVerified: 1792045942592
agent: "claude"
candidate: false
opensPage: true
description: "Saved helper for s.taobao.com"
inputs: {}
---

Saved helper for s.taobao.com

Call it:

`helpers["searchCandidates"](browser)`

```js
async (browser, pageId, model) => {
  // 返回淘宝搜索结果第一页的精简候选：[排名, 商品ID, 标价, 付款人数, 型号匹配, 疑似非全新, 广告]
  // 结果过大时 BrowserOS 会写入文件、只返回文件引用，所以只返回精简数组
  const page = browser.page(pageId);
  const res = await page.evaluate((model) => {
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = norm(model); const parts = model.split('-');
    const sel = 'a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]';
    const idOf = (h) => (h.match(/[?&]id=(\d+)/) || [])[1];
    const out = []; const seen = new Set();
    for (const a of document.querySelectorAll(sel)) {
      const id = idOf(a.href); if (!id || seen.has(id)) continue;
      let card = a;
      while (card.parentElement) { const ids = new Set([...card.parentElement.querySelectorAll(sel)].map(x => idOf(x.href))); if (ids.size > 1) break; card = card.parentElement; }
      seen.add(id);
      const t = card.innerText.replace(/\s+/g, ' ');
      const paidRaw = (t.match(/([\d+万]+)人付款/) || [])[1] || '0';
      const variant = parts.length >= 2 && norm(t).includes(norm(parts[0])) && t.toUpperCase().includes(parts[1].toUpperCase());
      out.push([out.length + 1, id, parseFloat(((t.match(/¥\s*([\d.]+)/) || [])[1]) || '0'), paidRaw.includes('万') ? 10000 : (parseInt(paidRaw, 10) || 0), norm(t).includes(key) || variant ? 1 : 0, /基本全新|二手|拆机|翻新|99新|九成新/.test(t) ? 1 : 0, /广告|掌柜热卖/.test(t) ? 1 : 0]);
    }
    return out;
  }, model);
  return res && res.value !== undefined ? res.value : res;
}
```
