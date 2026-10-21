# 当前账号内的接收者与会话映射

映射用于重新找到已核实会话，不授权发送，也不替代发送前核对、未知发送对账和已结束店不再联系的规则。每次使用仍核当前账号、接收者、消息归属及页面就绪；不是永久商家标识，也不承诺账号改名或重新登录后继续有效。

## 身份与范围

- 范围为 `platform + account`。淘宝 `account` 为 `{ type: "loginNick", value, source: "site-nav-login-info-nick" }`，值来自聊天外层唯一当前登录昵称节点；1688 为 `{ type: "loginId", value, source: "conversation-list.currentLoginId" }`，值来自 iframe 内唯一会话列表的有限 Fiber 具名字段，current/alternate 须一致。它们都不是不可变数字 UID，不能混用。无法确认当前账号时，只可走原字符串只读路径，不用或写跨运行映射。
- `recipient` 只表示聊天接收者，来自目标列表项有限 Fiber 的 `conversation.conversationIdentifier.target`。保留 `targetId`、`targetType`、`entityType`、`bizType`、`channelType` 及来源；不拆复合会话 ID。淘宝已核实 `targetType: "3" / bizType: "11001"`，1688 为 `"8" / "11152"`，两平台均为 `entityType: "U" / channelType: 3`。
- `buyer` 来自目标会话 self 消息的具名 sender、完整 UID 和 `.nick` 显示名。显示名须与独立当前账号一致；具名 sender.targetId 与独立 uid 须符合已核实关系 `uid === targetId + "@cntaobao"`，current/alternate 及本次全部 self 证据须一致。不能只用旧 self 消息推断当前登录账号，也不能把商家回复中的客服子账号 sender 当接收者。
- `conversationId` 原样取已核实 row.id，且须等于 row 的具名 `conversationCode`。一个接收者可有多条会话，不能只保留最后一条或按同名自动合并。
- 独立商家页证据为可选 `businessIdentity`；缺少时为 `null`，不把 recipient 冒充 shopId/memberId，不从店铺域名数字推导 ID。当前只支持已核实的 typed `sellerId` 来源，见平台说明。`observedAt` 是商家页独立观察时间，不随聊天读回改写。

## helper 调用

两个平台的 `imOpenAndRead` 保留字符串和 `{ contact, headerName }` 原调用及原结果。下列新模式仅使用本任务目标页，第三参必须明确传入：

| 第三参 | 行为 |
|---|---|
| `{ op: "account" }` | 未选会话也可只读当前具名账号，返回 `{ ok, platform, account }`；不点击、不读消息正文 |
| `{ op: "read", contact: "完整列表名", headerName: "已核实完整标题" }` | 首次按完整名称唯一选择，完成全部核验后在原结果中附 `identity` |
| `{ op: "read", binding: 已存identity }` | 当前账号核对后精确按 ID 找目标，重试时也重取当前 ID 对象；已唯一 active 时免重复点击，仍检查全部就绪条件 |
| `{ op: "rebind", binding: 旧identity }` | 旧 ID 失效时，仅按同一已核实 recipient 重新发现唯一会话；正文读取前核账号、目标及已存 self UID，成功才返回新 identity |

新身份模式不取消消息 current/alternate 归属、富消息占位、1688 公司档案的守卫。初次和返回前都重读当前账号，等待重试时也重新核验当前对象。缺 self、昵称不符、未知 UID 域或绑定冲突时不产生可持久身份。可以按原协议对明确目标作旧字符串只读核对，不能据此把未验证身份提升成有效映射。

身份字段与消息合并后可能超过页面单次返回预算。长结果由 helper 内部分段取回完整结果，调用方不手工截断，也不把工具生成的文件引用当消息内容。分段通信失败不能称为完整读取成功；这不扩大聊天发送或业务等待范围。

缓存 ID 缺失或名称漂移为 `CHAT_BINDING_STALE`；同接收者多匹配为 `CHAT_BINDING_AMBIGUOUS`；身份冲突为 `CHAT_BINDING_CONFLICT`。账号不可得、不一致或等待中变化分别为 `CHAT_ACCOUNT_UNAVAILABLE`、`CHAT_ACCOUNT_MISMATCH`、`CHAT_ACCOUNT_CHANGED`；接收者字段或 self 交叉证据不足分别为 `CHAT_RECIPIENT_UNAVAILABLE`、`CHAT_SELF_UNAVAILABLE`，self 矛盾为 `CHAT_SELF_IDENTITY`。这些都不表示无回复或无货，不触发消息重发。

`CHAT_IDENTITY` 或加载超时不等于 ID 失效或无回复。先按 [暂停与恢复](execution.md#暂停与恢复)诊断实际页面和可能的验证阻塞；仅确证 ID 失效后才执行受约束重绑。

`imPreviews` 仍只接受完整名称数组，不支持 binding。预览因同名歧义或缺项失败时，可对已有且仍可核验的 binding 精确只读；不能把预览失败当无回复，也不能改成未实现的 binding 预览调用。

## 持久接口

`scripts/contacts.mjs` 独立于业务配置读取，不控制浏览器、不联网、不调用 ERP、不发消息。文件固定在个人数据目录的 `contacts.json`，不进入公开仓库。`lookup` 只读；其余写入口要求当前版本已初始化，版本不一致时拒绝，不顺带清理。升级时映射的保留/旧格式清理统一见[数据生命周期](data-lifecycle.md)。调用均从 UTF-8 JSON 文件读入，避免手工拼接命令中的账号或店名：

```bash
node "<技能目录>/scripts/contacts.mjs" lookup --file "<请求JSON>"
node "<技能目录>/scripts/contacts.mjs" remember --file "<请求JSON>"
node "<技能目录>/scripts/contacts.mjs" invalidate --file "<请求JSON>"
node "<技能目录>/scripts/contacts.mjs" rebind --file "<请求JSON>"
```

| 命令 | JSON 字段 | 结果和边界 |
|---|---|---|
| `lookup` | 当前 `platform`、`account`，以及已核实的 `recipient` 或 `entryUrl` | 返回 `revision` 与本账号范围的 `matches`；缺文件不创建目录，空结果只表示需只读发现 |
| `remember` | 当前 scope、刚核实的 `identity`、`expectedRevision`，可选 `entryUrl` | 首次持久化；无文件的 revision 为 `null`。不接受旧 `bindingId`，不覆盖已有有效同会话项 |
| `invalidate` | 当前 scope、`bindingId`、`expectedRevision`、明确 `reason` | 只将本范围指定项标失效，保留旧内容，不删除历史 |
| `rebind` | 当前 scope、旧 `bindingId`、`expectedRevision`、新核实的 `identity`，可选 `entryUrl` | 必须同 recipient、同已存买家 UID；旧项标失效，新项另存。仅同名或仅同 sellerId 均不允许换 recipient |

`platform/account` 取当次账号 helper；`identity` 必须取当次通过全部守卫的 helper 结果，不凭记忆或相似名称补造。`bindingId` 是 lookup 返回的本地行 ID，和平台 conversationId 不同。首次绑定后无需每次轮询都写缓存；每次读取仍现场核验，最新身份可保存在本次 run。

写入使用 `expectedRevision`、短排他锁及原子替换；revision 与解析数据来自同一次文件字节读取。`CONTACT_CONFLICT` 时重读并合并，不能旧副本覆盖；`CONTACT_BUSY` 时保留锁，不自动删锁恢复。数据损坏、未知版本/字段或冲突有效会话均拒绝，保留原字节，不能清空文件当修复。未知或矛盾身份字段拒绝持久化。

`rebind` 不会因为传入相同商家 ID 就降低 helper 的现场核验。必须先调用受旧 recipient 约束的只读重绑模式，成功取得新 identity 后再执行本地 rebind；禁止先用无约束旧名称读完正文、事后才比较对象。没有唯一同 recipient 链时，保留旧证据并重新核实已验证入口或转人工，不猜新客服。旧商家页证据在同 recipient 重绑时可保留，独立 observedAt 不刷新；新旧证据冲突时拒绝。

## 运行及恢复顺序

1. 平台准备时先核当前账号；已验证商品/店铺入口可用于 lookup，不能只拿同名查映射。没有独立商家 ID 时保留已验证入口和名称回退，不伪造商家 ID。
2. 缓存命中后用该行 identity 精确只读；多会话保留多行，按本任务明确会话选择，不能凭“最近”静默挑一条。初次发现成功后 remember；已 active 的缓存目标仍须全部核验，不能把免 click 当免检查。
3. 已核实 ID 失效时，先对本账号旧绑定执行受约束的 helper rebind。成功后以原 lookup revision 执行 contacts rebind；失败则明确标记/报告失效及原因，不能盲发送。
4. 平台记录的 `shops[].identity` 为可选字段，未核实时可缺省；`check` 验证已提供字段的结构、平台及 contact 一致性，`merge` 保留，`finish` 随实际归档报价保留。它不重置 sentAt、追问、结束状态或 pendingMessage，也不改变原 recent 防重复键。
5. 恢复未知发送先按[逐项检查](execution.md#访问限制与逐项检查)核原受阻必要步骤恢复、登录及验证不再阻塞，再按原断点核聊天证据；已结束店只按恢复协议只读核证据，不能以 rebind 或缓存失效授权重新联系。任何消息仍按既有发送前核对象及发送后读回规则执行，本接口不提供发送批处理。
