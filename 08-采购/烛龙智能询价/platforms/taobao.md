# 淘宝操作说明

本页聊天读取、消息归属及 helper 运行于 2026-10-18 复核；搜索、发送及其余页面事实仍为 2026-10-15 核对范围；标「未实测」的条目是按已核对页面行为推定的做法，首次照做时要核对结果，验证后去掉标记。淘宝改版后某条失效时，按实际情况操作，并在本机经验文件里记下（见 [run-protocol.md「本机经验」](../references/run-protocol.md#本机经验)）。

技能自带的站点脚本在 `<技能目录>/helpers/`，按[按域注册与核验 helper](../references/browseros-setup.md#按域注册与核验-helper)同时检查普通名和前缀名、比较并保留本机改进，确定性适配后在对应域 `saveHelper`，下一次 `run` 核验后调用。运行时名称带 `zhul_taobao_` 前缀，避免与 1688 同名 helper 相互覆盖；不能以新前缀绕过旧普通名的内容差异。连接故障由主代理恢复，平台代理不启动浏览器。脚本不发消息、不提交；搜索和预览只读，打开会话会清除未读状态。

| 站点 | 脚本 | 作用 |
|---|---|---|
| s.taobao.com | `helpers["zhul_taobao_searchCandidates"](browser, pageId, model)` | 搜索结果第一页的精简候选：`[排名, 商品ID, 标价, 付款人数, 型号匹配, 疑似非全新, 广告]` |
| market.m.taobao.com | `helpers["zhul_taobao_imPreviews"](browser, pageId, keys)` | 按完整列表名精确且唯一匹配的会话预览，不点开；不以预览文字匹配店铺 |
| market.m.taobao.com | `helpers["zhul_taobao_imOpenAndRead"](browser, pageId, key)` | 按完整列表名唯一打开，核对 active、标题、每条消息归属及富消息就绪后读取末尾最多 1500 字符；未就绪最多等 2200ms，缺可信绑定安全失败 |

站点脚本只在 `run` 开始时、按当时已打开页面的域名加载：先打开搜索页或聊天页，**下一次** `run` 才能调用对应脚本。

点「客服」打开的本任务聊天页可能显示为用户页，先核实来源和归属；热加载不可用时的安全恢复及已保存源码调用见[域注册流程](../references/browseros-setup.md#按域注册与核验-helper)。不能只凭 `not a function` 判断脚本未安装，也不靠重复重启解决。

登录、验证、账号设置等阻塞统一按 [执行协议「暂停与恢复」](../references/execution.md#暂停与恢复)处理；普通滑块仅可先尝试一次，失败或其他验证申请并消费 BrowserOS 人助。只中断受影响平台，不能记成无货。每次发送含更正先保存意图，读回确认后落盘；结果未知先查聊天证据。恢复先读停止期间的新回复，不重问已完成平台或真正业务结束的店。

## 1 登录

- 首页：`https://www.taobao.com`。
- 未登录时搜索页一直停在「加载中」。遇到就停下，请用户在 BrowserOS neo 里登录淘宝。

## 2 搜索

1. 在自己的标签页里用地址打开货源直达里的淘宝链接（`https://s.taobao.com/search?q=...`），不在 ERP 页面上点击，等商品列表出现。
2. 调用 `zhul_taobao_searchCandidates` 读第一页候选，第三参传原型号字符串。不要把整页文字或大段结果直接返回：结果太大时 BrowserOS 会写进文件、只给文件引用。
3. 按第 3 节从这条链接的结果里挑店，家数按 `shopsPerLink`。挑完在同一个标签页打开下一条淘宝链接，同样挑店，直到所有淘宝链接都做完（见 [inquiry-rules.md「找店与挑店」](../references/inquiry-rules.md#找店与挑店)）；前面链接里判断过的商品 ID 直接跳过。所有链接都没有型号匹配的店，该型号在淘宝按无货处理。

## 3 挑店

按 [inquiry-rules.md](../references/inquiry-rules.md) 第 3 节，结合页面特点：

1. 去掉 `型号匹配` 为 0 的；为 1 仅表示脚本按规范化文本或型号片段找到了候选，仍须在商品页逐字核对完整型号及后缀，不能当作精确匹配结论。
2. 去掉广告位（`广告` 为 1）。
3. 去掉标题写「基本全新」「二手」「拆机」「翻新」「99新」的（`疑似非全新` 为 1）。
4. 去掉占位价：工控件常见 ¥18 至 ¥64 这类明显不可能的低价、标题以「议价」开头、0 人付款的挂牌。
5. 排名靠前、有付款记录的优先。
6. **搜索卡片上的店名读不准**（会读到「11年老店」「LS」这类标签），进商品页后再确认店名，同一家店只问一次，同一型号的不同链接搜到的也一样。
7. 商品页的店铺信息里有评分、「客服平均 N 秒回复」「平均 N 小时发货」「近期发货慢」：回复慢、发货慢的往后排。
8. 用 `browser.open` 打开商品页时可能多出重复标签；按[共享浏览器归属与清理规则](../references/execution.md#共享浏览器)记录并核实。

## 4 聊天页：始终只保留一个

淘宝同时开多个聊天页可能出现「连接断开，请刷新重试」；较早的聊天页有时会被淘宝自动关掉，有时不会。全程只保留一个聊天页，按下面的方法切换：

1. **给新的一家发询价**：在商品页点「客服」。链接文字前有一个图标字体字符，不是普通空格，按文字匹配时用 `link "[^"]{0,3}客服"`；页面刚加载时可能还没有这个链接，稍等再找。点击后会在新标签页打开 `https://market.m.taobao.com/app/im/chat/index.html?gid=<商品ID>&…`，自动带上「正在咨询的宝贝」。
2. 新聊天页出现后，**立刻关掉本次自己打开的同平台旧聊天页**（已被淘宝自动关掉的就不用关），在新页里发送。关掉旧页后，新页保持连接、会话列表正常（已实测）；关掉旧页后在新页发送还未实测，首次照做时发送后读回核对。
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
- **只看预览不会把消息标为已读**，未读红点会一直留着，用户会以为 AI 漏看了。读到回复后，必须点开该会话一次。
- 会话列表显示店名，聊天对象常是客服子账号（如 `tb485899055`、「yeshiwu:五佳电气批发」）。`run.json` 的 `contact` 记会话列表上显示的名字。
- 聊天 helper 的字符串 `key` / `keys` 必须是本任务完整列表名。已核实标题别名时，打开函数可传 `{ contact: "完整列表名", headerName: "已核实标题身份" }`；不接受空名，零匹配/多匹配或标题不符不读取消息。当前选择器须在真实页面核验；`CHAT_DOM` / `CHAT_MESSAGES_UNAVAILABLE` 等失败不表示无回复，转按当前快照核对目标区域，不能退回整页截取。
- 打开读取以页面变化触发核验：唯一 active 的非空会话 ID 必须与所有当前消息的 `conversationCode` 一致。当前适配仅从消息 DOM 的有限 React Fiber 链读取这一绑定；有 alternate 消息时也须一致，不读取全局会话存储。全部归属通过后，还检查消息是否有精确的「暂不支持的消息类型」占位节点；富消息可能稍后才显示机器人内容或客服评价，不能把占位当作完整正文。标题先切、旧消息残留、无消息、绑定缺失、冲突或富消息尚未渲染时继续等页面更新，最多 2200ms；到时返回 `timedOut:true` 及 `CHAT_IDENTITY`、`CHAT_MESSAGES_UNAVAILABLE`、`CHAT_BINDING_UNAVAILABLE`、`CHAT_MESSAGE_IDENTITY` 或 `CHAT_MESSAGES_RENDERING`，iframe 不可用为 `CHAT_DOM`。这些错误只表示未安全读到目标消息，不能当作店家无回复、无货或没有结束信号；转人工定位目标区域，不降低归属及完整性核验。这里的等待只用于页面就绪，店家回复等待仍按业务规则和本次有效设置计时。
- 读整页文字时会带出账号的其他私人会话预览：只解析目标店铺的会话，其他内容不解析、不记录。

### 机器人回复

以下消息不算人工回复，继续等人工，计时不重置：

- 「亲，在的」「欢迎光临」这类欢迎语。
- 「您咨询的这款不是当前商品，麻烦发一下商品链接」：商品页默认规格和询问的型号不同时会出现，随后人工客服通常仍会报价。

### 结束信号

- **「您对客服的服务满意吗」**，后面带「很不满 / 不满 / 一般 / 满意 / 很满意」几个选项：店家客服结束了本次接待。由店家客服主动发出，是会话的最后一条，曾在店家最后一次回复约 6 分钟后出现。这家立即结束，按已有信息记录，不再发送任何消息，也不点评价选项。
- 是否发出由店家客服决定，不一定会出现；没出现不代表聊天还在进行，这家照常按计时和信息是否齐全结束。

## 7 店家回复的特点

- 人工客服大多 1 分钟内首次回复，个别要几分钟；追问多在 1 分钟内回答。
- 常只回一个数字（如「1650」），需要追问含税、货况、货期；一次追问问多项时，店家常只答其中一项。
- 有店家直接推「下单卡片」（规格、价格、以实际下单为准）：只从文字里取价格，不点卡片。
- 「含普票」指价格含普通发票，按临时规则记含税 3%。

## 8 已知风险

- 操作过快可能触发滑块验证。按[共享验证规则](../references/execution.md#普通滑块仅尝试一次)处理；解除后放慢节奏。
- 聊天页偶尔断开：确认只开了一个聊天页，重新打开不带参数的聊天首页。

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
