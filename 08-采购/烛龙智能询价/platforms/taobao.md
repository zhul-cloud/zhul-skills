# 淘宝操作说明

本页记录淘宝页面特例；登录、验证及恢复按[执行协议](../references/execution.md#暂停与恢复)，helper注册和跨run加载按[准备协议](../references/browseros-setup.md#按域注册与核验-helper)。运行时使用`zhul_taobao_`前缀，不能绕过旧普通名内容核对。页面变化须现场核验，验证后记入[本机经验](../references/run-protocol.md#本机经验)。脚本不发消息；打开会话会清除未读状态。

| 站点 | 脚本 | 作用 |
|---|---|---|
| s.taobao.com | `helpers["zhul_taobao_searchCandidates"](browser, pageId, { items: [{ itemId, model }], mode: "current-dom" })` | 当前 DOM 的直达商品候选；每项 `legacy` 为 `[排名, 商品ID, 标价, 付款人数, 型号匹配, 疑似非全新, 广告]`，另带独立 `title`、`productUrl` 及逐明细 `matchItemIds` 提示 |
| market.m.taobao.com | `helpers["zhul_taobao_imPreviews"](browser, pageId, keys)` | 按完整列表名精确且唯一匹配的会话预览，不点开；不以预览文字匹配店铺 |
| market.m.taobao.com | `helpers["zhul_taobao_imOpenAndRead"](browser, pageId, key)` | 按完整列表名唯一打开，核对 active、标题、每条消息归属及富消息就绪后读取末尾最多 1500 字符；未就绪最多等 2200ms，缺可信绑定安全失败 |

## 1 登录

- 首页：`https://www.taobao.com`。
- 搜索页持续「加载中」时先核实登录、验证区域或页面故障，不能直接认定未登录；确需登录/验证时按[暂停与恢复](../references/execution.md#暂停与恢复)请求人助，核验后续原任务。

## 2 搜索

1. 在自己的标签页里用地址打开货源直达里的淘宝链接（`https://s.taobao.com/search?q=...`），不在 ERP 页面上点击。导航后核对实际搜索词、页面状态及本次结果归属；URL 已变或已有商品链接不足以证明新结果就绪。无法核实时保留未完成，不能记无货。
2. 用表中的批量对象调用，`items` 传本平台仍有缺口的 ERP 明细 ID 和原型号；一次获取同一 DOM 的共享候选、独立标题、商品 URL 及 `matchItemIds` 提示，按[共同候选规则](../references/inquiry-rules.md#找店与挑店)处理。标题来自卡片独立标题节点，不从店名猜取；当前适配 `item.taobao.com/item.htm`、`detail.tmall.com/item.htm` 直达路径，其他路径现场核验，不为补候选打开 `click.simba.taobao.com` 推广跳转。
3. 按第 3 节筛选，共享当前候选与同 run 的已核商品资料，并实际调用[覆盖规划工具](../references/inquiry-rules.md#覆盖规划工具)；按主代理[轮次计划](../references/run-protocol.md#询价轮次计划)给每个明细分配的本平台累计目标挑店，同商家只计一家；平台代理不自行加目标。达到本轮目标的明细立即停搜，剩余直达链接只补本轮缺口。已有商品页公共字段可复用，完整型号、后缀、规格与 SKU 状态仍逐 `itemId` 核验；仅搜索提示不能计覆盖。只有缺口确实未补足才继续下一条链接，确认全部相关链接/候选覆盖后仍不足按共同规则保存缺口并上报主代理；读取失败和未加载候选不能算无货。

## 3 挑店

按 [inquiry-rules.md](../references/inquiry-rules.md) 第 3 节，结合页面特点：

1. 先核 `matchItemIds` 命中当前明细的候选；该明细仍有缺口时，未命中候选按[共同后备核验规则](../references/inquiry-rules.md#找店与挑店)处理，不能直接丢弃或当无货。`matchItemIds` 也仅是当前文本命中的提示，两组都须在商品页核清任务原型号、完整后缀、规格和店铺身份，既有明确错型号及第 2–4 条排除条件保持。
2. 去掉广告位（`广告` 为 1）。
3. 去掉标题写「基本全新」「二手」「拆机」「翻新」「99新」的（`疑似非全新` 为 1）。
4. 去掉占位价：工控件常见 ¥18 至 ¥64 这类明显不可能的低价、标题以「议价」开头、0 人付款的挂牌。
5. 排名靠前、有付款记录的优先。
6. **搜索卡片上的店名读不准**（会读到「11年老店」「LS」这类标签），进商品页后再确认店名，同一家店只发一次首次询价，同一型号的不同链接搜到的也一样；补轮只联系新店，不向原已发店追加明细。
7. 商品页的店铺信息里有评分、「客服平均 N 秒回复」「平均 N 小时发货」「近期发货慢」：回复慢、发货慢的往后排。
8. 用 `browser.open` 打开商品页时可能多出重复标签；按[共享浏览器归属与清理规则](../references/execution.md#共享浏览器)记录并核实。

### 商品详情一次读取

当前任务商品页已就绪且归属明确后，在同一次 `page.evaluate` 中执行下面函数，参数 `{ itemId, model }` 均来自本任务已核候选和原型号。只读标题、独立 SKU 和店铺头部评分/发货原文，避免逐字段快照；相同标题可有重复可见节点，不能把用户评价里的标题算入。独立 SKU 可为纯型号、「完整原型号 | 非空规格说明」两段，或完整原型号后以空白分隔的电流/直流电压规格（如 `9A DC24V`、`5.5-8A`）。空白尾部仅接受数字加 `A`、两个数字以 ASCII 连字符分隔并以 `A` 结尾的有序电流区间，或 `DC` 加数字加 `V`；电流/区间与电压各最多一个，支持小数且全部内容须符合此格式。不接受未知词、第二型号、缺单位、反向区间或重复规格。型号段逐字匹配，`exactSku` 保留完整原文；不从标题或模糊描述补型号，不移除后缀或连字符。成功读取 `DC220V` 也不表示符合任务的 `24VDC`；返回字段不是最终规格或商家身份结论，后续核对仍按[共同挑店规则](../references/inquiry-rules.md#找店与挑店)。

```js
({ itemId, model }) => {
  // zhul-product-fields: taobao
  if (typeof itemId !== 'string' || !/^\d+$/.test(itemId) || typeof model !== 'string' || !model.trim()) return { ok: false, error: 'SKILL_INPUT' };
  const url = new URL(location.href);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return { ok: false, error: 'PRODUCT_IDENTITY' };
  if (url.hostname === 'huodong.taobao.com' && url.pathname === '/wow/z/app/default/safe-access-tips') return { ok: false, error: 'PRODUCT_PAGE_UNAVAILABLE' };
  if (url.hostname === 'login.taobao.com' && url.pathname === '/havanaone/login/login.htm') return { ok: false, error: 'PRODUCT_LOGIN_REQUIRED' };
  if (!['item.taobao.com', 'detail.tmall.com'].includes(url.hostname) || url.pathname !== '/item.htm' || url.searchParams.get('id') !== itemId) return { ok: false, error: 'PRODUCT_IDENTITY' };
  const pageText = document.body?.innerText;
  if (typeof pageText !== 'string' || !pageText.trim()) return { ok: false, error: 'PRODUCT_PAGE_UNCONFIRMED' };
  const visible = (e) => e.getClientRects().length > 0;
  if ([...document.querySelectorAll('.nc_scale,.nc_wrapper,[role=slider],[class*=captcha]')].some(visible)) return { ok: false, error: 'VISIBLE_VERIFICATION' };
  const titles = [...document.querySelectorAll('div[class^="ItemTitle--"]')].filter(visible).map((e) => e.innerText.split('\n')[0].trim());
  const shops = [...document.querySelectorAll('a[class*="detailWrap--"]')].filter(visible);
  const sku = [...document.querySelectorAll('span[class*="valueItemText--"]')].filter(visible).map((e) => e.textContent.trim());
  if (!titles.length || new Set(titles).size !== 1 || !titles[0] || shops.length !== 1 || !sku.length) return { ok: false, error: 'PRODUCT_FIELDS_UNAVAILABLE' };
  const shop = shops[0], shopName = shop.innerText.split('\n')[0].trim();
  let shopUrl;
  try { shopUrl = new URL(shop.href); } catch { return { ok: false, error: 'PRODUCT_FIELDS_UNAVAILABLE' }; }
  if (!shopName || !['http:', 'https:'].includes(shopUrl.protocol) || shopUrl.username || shopUrl.password || !/(^|\.)(taobao|tmall)\.com$/.test(shopUrl.hostname)) return { ok: false, error: 'PRODUCT_FIELDS_UNAVAILABLE' };
  const exactSku = sku.filter((s) => {
    const parts = s.split('|');
    if (parts.length === 2) return parts[0].trim() === model && !!parts[1].trim();
    if (parts.length !== 1) return false;
    if (s.replace(/\s/g, '') === model) return true;
    if (!s.startsWith(model) || !/^\s/.test(s.slice(model.length))) return false;
    const tokens = s.slice(model.length).trim().split(/\s+/);
    const currents = tokens.filter(token => {
      const range = token.match(/^(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?A$/);
      return !!range && Number.isFinite(Number(range[1])) && (range[2] === undefined
        || Number.isFinite(Number(range[2])) && Number(range[1]) <= Number(range[2]));
    }).length;
    const voltages = tokens.filter(token => /^DC\d+(?:\.\d+)?V$/.test(token)).length;
    return tokens.length <= 2 && currents <= 1 && voltages <= 1 && currents + voltages === tokens.length;
  });
  return { ok: exactSku.length > 0, ...(exactSku.length ? {} : { error: 'PRODUCT_MODEL_UNCONFIRMED' }), itemId, title: titles[0], exactSku,
    shopName, shopUrl: shopUrl.origin + shopUrl.pathname, shopHeader: shop.innerText.trim() };
}
```

`PRODUCT_PAGE_UNAVAILABLE` 表示已跳到提示页，原商品详情当前不可读；按[逐项检查](../references/execution.md#访问限制与逐项检查)确认实际受阻范围。`PRODUCT_LOGIN_REQUIRED` 按同节登录人助处理，不继续下一商品。正确商品页的风险提示文本、`pcResistDetail` / `pcIdentityRisk` 标记本身不使片段失败；原型号 SKU、商品与店铺字段可核且没有实际登录、验证或操作阻塞时，继续原询价流程。片段成功仅证明本次字段读取，仍须核当前店铺/会话身份及下一必要操作就绪；不要求其他关联风险提示页消失，不以换商品或反复刷新探测恢复。

缺 SKU、标题、唯一店铺或可核页面正文时不能成功选店；按当前页实际就绪状态诊断，缺字段本身不等于账号或访问限制。若未触发平台阻塞且可安全继续，保留未确认结果并按共同规则核其他候选，不把失败算无货或已完成覆盖。URL 的商品 ID 对应不单独证明旧 DOM 已更新，须核实当前商品与店铺入口对应，已有商家身份按下文具名来源交叉核对。验证命中按暂停与恢复分流；未命中这些 DOM 结构也不能排除验证，不固定等待或反复刷新。片段没有改价格/发货排序、店铺去重或发送守卫。

## 4 聊天页：始终只保留一个

淘宝同时开多个聊天页可能出现「连接断开，请刷新重试」。全程只保留一个聊天页，按下面的方法切换：

1. **给新的一家发询价**：在商品页点「客服」。链接文字前有一个图标字体字符，不是普通空格，按文字匹配时用 `link "[^"]{0,3}客服"`；页面刚加载时可能还没有这个链接，稍等再找。点击后会在新标签页打开 `https://market.m.taobao.com/app/im/chat/index.html?gid=<商品ID>&…`，自动带上「正在咨询的宝贝」。
2. 新聊天页出现后，按[共享浏览器规则](../references/execution.md#共享浏览器)核实并关闭本次自己打开的同平台旧聊天页。确认新页连接、会话列表及目标身份正常后再发送，并按第 5 节读回核对。
3. **查看回复**：发完后把这个聊天页导航到**不带参数**的 `https://market.m.taobao.com/app/im/chat/index.html`，它能看到完整会话列表；带 `gid` 参数的页面一刷新就只剩那一家的会话。
4. 点「客服」或 `browser.open` 带出的页面可能显示为用户标签；归属、清理及导航后的状态核对统一按[共享浏览器规则](../references/execution.md#共享浏览器)执行。

## 5 发送

1. 聊天内容在同源 iframe 里，用 `iframe.contentDocument` 可以直接读文字，不需要截图；无障碍树里看不到聊天文字。
2. 会话列表项是 `.conversation-item`（名称在 `.name`），当前会话的列表项带 `active`，聊天区标题是 `.conversation-header`。
3. **发送前核对当前对象**：`.conversation-header` 的身份须与目标完整聊天名或已核实的客服别名一致，当前 active 列表项须唯一且为目标完整列表名，不能用包含关系或整页文字放行。店铺名与客服名不同先依据本任务商品页进入的会话核实并记录映射，不猜别名。
4. 输入框是「发送」按钮前面的那个元素。引用编号随新消息变化，每次发送前重新定位。
5. 发送后读回：最后一条消息是刚发的内容，且标题仍是目标店。

## 6 查看回复

- 已核实的会话可按[当前账号身份映射](../references/identity-mapping.md)复用：先核当前 loginNick，再用已存 binding 精确只读；名称预览歧义或缺项时不当作无回复，可转已核 binding 的 ID 读取。首次和失效重绑均保留完整身份及就绪核验，不从客服 sender 或店铺域名推导商家 ID。
- 用 `zhul_taobao_imPreviews` 看这几家的预览；预览变了，用 `zhul_taobao_imOpenAndRead` 点开读取末尾消息；恢复、未知发送或完整报价证据不足时另行只读核对对应会话，不能把截取缺失当成未发或无报价。
- **只看预览不会把消息标为已读**，未读红点会一直留着。读到回复后，必须点开该会话一次。
- 会话列表显示店名，聊天对象可能是客服子账号。平台记录的 `shops[].contact` 记会话列表上显示的名字，按[记录协议](../references/run-protocol.md#受控保存与事件)保存后由主代理合并。
- 聊天 helper 的字符串 `key` / `keys` 必须是本任务完整列表名。已核实标题别名时，打开函数可传 `{ contact: "完整列表名", headerName: "已核实标题身份" }`；不接受空名，零匹配/多匹配或标题不符不读取消息。当前选择器须在真实页面核验；`CHAT_DOM` / `CHAT_MESSAGES_UNAVAILABLE` 等失败不表示无回复，转按当前快照核对目标区域，不能退回整页截取。
- 打开读取以页面变化触发核验：唯一 active 的非空会话 ID 必须与所有当前消息的 `conversationCode` 一致。当前适配仅从消息 DOM 的有限 React Fiber 链读取这一绑定；有 alternate 消息时也须一致，不读取全局会话存储。全部归属通过后，还检查消息是否有精确的「暂不支持的消息类型」占位节点；富消息可能稍后才显示机器人内容或客服评价，不能把占位当作完整正文。标题先切、旧消息残留、无消息、绑定缺失、冲突或富消息尚未渲染时继续等页面更新，最多 2200ms；到时返回 `timedOut:true` 及 `CHAT_IDENTITY`、`CHAT_MESSAGES_UNAVAILABLE`、`CHAT_BINDING_UNAVAILABLE`、`CHAT_MESSAGE_IDENTITY` 或 `CHAT_MESSAGES_RENDERING`，iframe 不可用为 `CHAT_DOM`。这些错误只表示未安全读到目标消息，不能当作店家无回复、无货或没有结束信号；按[暂停与恢复](../references/execution.md#暂停与恢复)诊断实际受阻范围并分流，仅适用的人助场景才转人工，不降低归属及完整性核验，也不退回整页截取。这里的等待只用于页面就绪，店家回复等待仍按业务规则和本次有效设置计时。
- 读整页文字时会带出账号的其他私人会话预览：只解析目标店铺的会话，其他内容不解析、不记录。

### 机器人回复

以下消息不算人工回复，继续等人工，计时不重置：

- 「亲，在的」「欢迎光临」这类欢迎语。
- 「您咨询的这款不是当前商品，麻烦发一下商品链接」：商品页默认规格和询问的型号不同时会出现；该自动提示不算人工回复。

### 结束信号

- **「您对客服的服务满意吗」**，后面带「很不满 / 不满 / 一般 / 满意 / 很满意」几个选项：店家客服结束了本次接待。由店家客服主动发出。这家立即结束，按已有信息记录，不再发送任何消息，也不点评价选项。
- 是否发出由店家客服决定，不一定会出现；没出现不代表聊天还在进行，这家照常按计时和信息是否齐全结束。

## 7 店家回复的特点

- 常只回一个数字（如「1650」），需要追问含税、货况、货期；一次追问问多项时，店家常只答其中一项。
- 有店家直接推「下单卡片」（规格、价格、以实际下单为准）：只从文字里取价格，不点卡片。
- 发票说法按[报价整理规则](../references/inquiry-rules.md#6-把回复整理成报价)处理。

## 8 已知风险

- 遇到登录、验证或访问限制时，按[暂停与恢复](../references/execution.md#暂停与恢复)分类处理；普通滑块只按该协议尝试一次。
- 聊天页断开时按[会话重连](../references/execution.md#browseros-会话失效或重连)核实归属和控制状态，不直接新建重复聊天页。

### 具名商家页证据

仅在本任务已核实的商品页、已核实店铺锚点上取有限 Fiber 的具名 `sellerId/itemId/storeCardVO`。当前可选 typed 身份为 `sellerId`，没有独立 shopId 证据；缺字段保持 `businessIdentity:null`。下面片段的参数对象来自刚通过身份守卫的聊天 identity，以及当前商品页已核实店铺 URL；不使用复合聊天 ID、hostname 数字或相似店名补值。返回值可附到 identity.businessIdentity 后交 `contacts remember/rebind`，独立 observedAt 不随聊天核验刷新。

```js
// zhul-business-observation: taobao；在已核实商品页 page.evaluate 中执行。
({ recipientId, verifiedShopUrl }) => {
  const sameEntry = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname === y.pathname; } catch { return false; } };
  const anchors = [...document.querySelectorAll('a[href]')].filter((a) => sameEntry(a.href, verifiedShopUrl));
  if (anchors.length !== 1) return null;
  const keys = Object.keys(anchors[0]).filter((key) => key.startsWith('__reactFiber$'));
  if (keys.length !== 1) return null;
  let fiber = anchors[0][keys[0]];
  for (let depth = 0; fiber && depth < 6; depth++, fiber = fiber.return) {
    const p = fiber.memoizedProps, a = fiber.alternate?.memoizedProps;
    if (!p?.sellerId && !a?.sellerId) continue;
    if (typeof p?.sellerId !== 'string' || p.sellerId !== recipientId || !p.itemId || !p.storeCardVO?.shopName || !sameEntry(p.storeCardVO.shopUrl, verifiedShopUrl)) return null;
    if (a && (a.sellerId !== p.sellerId || a.itemId !== p.itemId || a.storeCardVO?.shopName !== p.storeCardVO.shopName || !sameEntry(a.storeCardVO?.shopUrl, p.storeCardVO.shopUrl))) return null;
    const source = new URL(location.href);
    if (source.hostname !== 'item.taobao.com' || source.searchParams.get('id') !== String(p.itemId)) return null;
    return { type: 'sellerId', value: p.sellerId, source: 'seller-anchor.memoizedProps.sellerId', sourceUrl: source.href,
      shopUrl: p.storeCardVO.shopUrl, observedAt: new Date().toISOString(), itemId: String(p.itemId), shopName: p.storeCardVO.shopName };
  }
  return null;
}
```
