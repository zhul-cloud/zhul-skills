# ERP 接口与填报

主代理或单代理执行任务读取、草稿、提交和核对前读本文。平台代理不调用 ERP。普通运行不需要读取 helper 源码；只有维护、接口同步或针对 helper 的排错时，才读 [erpApi 源码与 CONTRACT](../helpers/_erp/erpApi.md)。

## 调用接口

技能自带的 `erpApi`（[helpers/_erp/erpApi.md](../helpers/_erp/erpApi.md)）由 `install-helpers` 装进 ERP 域名。调用方式：先打开自己的 ERP 标签页，下一次 `run` 里 `await helpers.erpApi(browser, <ERP 标签页 id>, { op, ... })`。

| op | 参数 | 返回 |
|---|---|---|
| `ping` | — | 是否已登录、待处理任务数 |
| `list` | `done`：`false` 待处理，`true` 已回价 | `tasks`：`taskId`、任务编号、型号数、已填数、剩余分钟等 |
| `task` | `taskId` | `run`：写进 `run.json` 的任务和型号信息（见 [erp-api.md「选任务与读取」](erp-api.md#选任务与读取)） |
| `save` | `taskId`、`submit`、`items`、`skipItemIds`（`items` 和 `skipItemIds` 从 `erp-items` 原样传入） | 存草稿或提交回价，跳过指定型号及其旧草稿 |
| `verify` | `taskId`、`submitted`、`items`、`skipItemIds`（与 `save` 相同） | `mismatches`、`inDoneList`、`filledCount` |

- 请求在 ERP 标签页里发出：令牌取自页面的登录状态，不离开浏览器，不写进对话和任何记录；过期时按 ERP 前端同样的方式续期，续不了返回 `ERP_LOGIN`。
- 每次请求都按 `CONTRACT` 核对响应结构，对不上返回 `ERP_CONTRACT`（见本文「ERP 错误与重试边界」）；ERP 多出来的字段列在 `extraFields`。
- `skipItemIds` 是辅助脚本的跳过列表，不是发给 ERP 服务器的新字段；每个 ID 必须属于本任务、不得重复，也不得与 `items` 重叠，否则返回 `SKILL_INPUT`。`verify` 核对本次 `items`，允许跳过型号保留旧草稿。
- `save` 的规则与 ERP 页面「提交回价」一致：同一型号上本人原有的报价行照带，同一平台同一店铺的以本次为准，并保留实际被替换版本上的原附件（同店草稿优先，不挪用未被替换版本的附件）；提交时其他型号上的草稿一并提交，`skipItemIds` 里的故障未完成型号除外；已报给客户的型号跳过。技能不新增上传附件。
- 内容较多时 `erpApi` 会分段读写，单次调用一般在几秒内；整个任务的报价放在一次 `save` 里即可。
- ERP 接口改了、技能还没同步时，维护者按[采购维护说明「ERP 接口改了怎么同步」](../../README.md#erp-接口改了怎么同步)更新 `CONTRACT` 并升版本。

## 选任务与读取

1. 选任务：`erpApi` 的 `{ op: "list", done: false }` 返回「待处理」任务（`taskId`、任务编号、型号数、已填数等，顺序与页面一致：系统已按超时、紧急、更新时间排好）。
   - 用户指定了任务编号就只做这个任务，完成后不再取下一个（按 [execution.md「停止或继续」](execution.md#停止或继续)直接进入总汇报）。指定的任务不在「待处理」里时，再查「已回价」（`done: true`）；都没有就停止并告诉用户找不到这个任务，不回退处理全部待处理任务。
   - 没指定时，按顺序取第一个**本机没提交过回价、没跳过、也没标记为需人工处理**的任务：`node "<技能目录>/scripts/records.mjs" next <任务编号1> <任务编号2> …`（按列表顺序列出全部编号），输出的 `next` 就是要做的任务，为 `null` 表示没有要做的。用户明确要求重跑某个任务时不受这条限制。
   - 需要审核的账号提交后，任务在审核通过前仍留在「待处理」里，`next` 会因为本机已提交过而跳过它。
2. 建本次的任务文件夹：`node "<技能目录>/scripts/records.mjs" new-run <任务编号>`，输出就是文件夹路径（下文称「本次目录」）。
3. 读任务：`erpApi` 的 `{ op: "task", taskId }`。返回的 `run` 就是 `run.json` 的开头部分：任务编号 `task`、ERP 任务 ID `taskId`、报价截止时刻 `deadline`、是否需要审核 `reviewRequired`，以及每个型号的 `itemId`、型号、数量和单位、描述、系统话术 `script`、各平台的货源直达链接 `links`。把它原样写进本次目录的 `run.json`，再补上 `platforms` 等其余字段（格式见 [run-protocol.md「run.json」](run-protocol.md#runjson)）。
   - `editable` 为 `false` 表示询盘单已取消、回价只能查看：不询价，执行 `node "<技能目录>/scripts/records.mjs" skip <任务编号> 询盘已取消`，告诉用户；没指定任务编号时接着取下一个（见 [execution.md「停止或继续」](execution.md#停止或继续)）。
   - 每个型号的 `existingQuotes` 里都已有本人「已提交」或「待审核」的报价时，说明这个任务已经回过价（可能是在别的电脑上）：不再询价，执行 `records.mjs skip <任务编号> 已回过价`；没指定任务编号时接着取下一个。用户指定的任务也一样，告诉用户它已经回过价，用户要求重跑时再做。
   - 跳过的任务记进本机记录后，`next` 不会再选中它；标记为需人工处理的任务也一样（见本文「ERP 错误与重试边界」）。
   - `lockedItems` 里是已报给客户（只读）的型号，跳过，汇报里说明。
   - **报价截止时刻**：ERP 的 `quoteDeadline` 只有日期，`deadline` 由 `erpApi` 按读任务的时刻加上 `remainingMinutes`（剩余分钟）算出。
   - 返回的 `extraFields` 不为空时，记进实跑报告（ERP 新增了字段，不影响本次运行）。
4. 任务里已经有本人的草稿报价时（`existingQuotes` 里有「草稿」），原样保留：提交回价时 `erpApi` 会把它们一并提交，不告知用户、不等确认，也不修改草稿的内容（草稿备注里有店家原话和链接，用户按备注查聊天记录核对）。本轮因故障无价而列进 `skipItemIds` 的型号除外，原草稿保留在 ERP 中、不随本次提交。

## 草稿、核对、提交一次与再核对

由主代理完成。用子代理时，先确认已执行 `merge`，`run.json` 里有各平台的店。

1. 整理每个型号要填的报价（`run.json` 里 `status` 为已回复、挂牌价且有报价的店），以及是否需要标无货：
   - 某个平台问过的店都没报价时，按 [inquiry-rules.md 第 3 节](inquiry-rules.md#3-店铺筛选标准手册第-2-节)「没有回价时」用公开挂牌价补救（货况「待确认」，备注「公开挂牌」）；所有启用平台一个价格都没有、且不在 `incompleteItems` 里的型号才勾「无货」，无货说明按平台写清问了几家、结果如何。同型号有有效报价时优先保留报价，不因另一个平台的 `noStock` 覆盖。因子代理卡住、平台记录损坏，或报价截止时尚未完成挑店/发送的型号写进 `incompleteItems`，无价时不算无货。
   - 价格异常按 `priceOutlierPercent` 判断（同型号各平台的报价放在一起比），写进该条备注。
2. 每家店的报价在 `run.json` 里按下表写好（`erpApi` 按 ERP 字典把文字换成码值，不认识的取值会被拦下）：

   | ERP 字段 | `run.json` 里写什么 |
   |---|---|
   | 渠道 | 这家店的 `platform`（淘宝、1688） |
   | 店铺名称 | `shop`：店铺或公司全称 |
   | 单价 | `quotes[].price`：店家报的单价（人民币数值或可解析的数字字符串）；`100元`、非数字或非有限值会被本机记录工具拒绝，不能转成 `null` 或 0 提交 |
   | 含税 / 税率 | `taxIncluded`、`taxRate`：不含税为 `false`；含税时按临时规则填 3 或 13；店家没说是否含税的按不含税（见 [inquiry-rules.md 第 6 节](inquiry-rules.md#6-把回复整理成报价)） |
   | 货况、货期 | `condition`、`leadTime`：按 [inquiry-rules.md 第 6 节](inquiry-rules.md#6-把回复整理成报价)对照，用 ERP 下拉里的文字；店家没说的货况写「待确认」、货期留空 |
   | 备注 | `note`：店家原话摘要 + 商品链接（只留商品 ID）+ 需要提醒的情况（价格异常、票种未说明、沿用、公开挂牌、推荐替代型号等），300 字以内 |
   | 包邮 | `quotes[].freeShipping`：店家明确说不包邮（运费另计、到付等）时为 `false`，其余按包邮（写 `true` 或不写）；不主动问店家是否包邮（见 [inquiry-rules.md 第 6 节](inquiry-rules.md#6-把回复整理成报价)） |

3. 生成提交内容：`node "<技能目录>/scripts/records.mjs" erp-items "<本次目录>/run.json"`，输出 `{ taskId, items, skipItemIds }`，`items` 按型号列出要填的报价和无货。有报价的型号照常输出；无报价且在 `incompleteItems` 里的型号不输出无货，放进 `skipItemIds`（无跳过型号时为空数组），另有提示说明需人工处理。下面三步都原样传这同一份 `items` 和 `skipItemIds`，不能遗漏后者，否则 ERP 可能把这些型号的旧草稿也提交；重新整理时二者一起更新。没有任何可提交内容时，不调用 `save`，直接按第 7 条转人工，再执行第 8 条。
4. **先存草稿再核对**：`erpApi` 的 `{ op: "save", taskId, submit: false, items, skipItemIds }`，再 `{ op: "verify", taskId, submitted: false, items, skipItemIds }`。`verify` 返回 `mismatches` 时，按提示改正 `run.json`，重新生成提交内容后再存一次。
5. **提交回价**：`{ op: "save", taskId, submit: true, items, skipItemIds }`，只提交一次。`erpApi` 会带上本人在这些型号上原有的报价行，并把其他型号上的草稿一并提交，`skipItemIds` 里的型号除外；这些型号的旧草稿保留、不提交。
6. **提交后核对**：`{ op: "verify", taskId, submitted: true, items, skipItemIds }`：
   - `mismatches` 为空才算提交成功：把 `run.json` 的 `submitted` 设为 `true`，`stages.submitted` 记下时间（`finish` 按它把任务记为已提交，`next` 才不会再选中这个任务）。不为空时不重复提交，`submitted` 保持 `false`，按第 7 条转人工，差异列进汇报。
   - 需要审核的账号（`reviewRequired` 为 `true`）提交后状态是「待审核」，这是 ERP 的正常流程，算提交成功；任务要审核通过后才进「已回价」，`inDoneList` 为 `false` 不算失败。
   - 不需要审核、且每个型号都填了价格或无货时，`inDoneList` 应为 `true`；`filledCount` 应等于本次填报的型号数（加上原来就有报价的型号）。对不上的在汇报里说明。

### ERP 错误与重试边界

7. `erpApi` 返回错误时：
   - `ERP_CONTRACT`：缺字段、类型变了、取值不认识或接口不存在时，立即整体停止，不提交、不猜字段、不再调用 ERP；告诉用户「ERP 接口已修改，烛龙智能询价没有同步，请更新技能」，把 `problems` 写进汇报和实跑报告。只有新增的 `extraFields` 可继续并记录；本节第 8 条记录收尾照常执行，已收集的报价列在汇报里。
   - `ERP_LOGIN`：请用户重新登录 ERP 后再试。
   - `ERP_BIZ`（ERP 拒绝了内容，如「货期不在可选值内」）和 `SKILL_INPUT`（`run.json` 的取值不对）：仅正式提交前草稿阶段按提示改正 run.json，重新生成并同传 items、skipItemIds 后再试；同错最多改两次。正式提交已执行或结果未知只读核对并转人工，不重复 save submit:true。
   - `ERP_HTTP`：稍等后最多重试一次；已经执行过提交或提交结果不确定时，重试只读核对，不重复 `save submit:true`。仍失败转人工并整体停止，不取下一个任务。
   - **主代理解决不了就转人工**：同一个错误改了两次仍失败、存草稿后 `verify` 的差异改了两次仍在、提交后 `verify` 有差异、`ERP_HTTP` 重试后仍失败时，不再重试，执行 `node "<技能目录>/scripts/records.mjs" manual <任务编号> <原因>`，把任务标记为**需人工处理**。还没执行提交、草稿已保存的，由用户在 ERP 页面核对后提交；未能保存草稿的，在汇报里列出已收集的报价（型号、平台、店铺、单价、含税、货况、货期、包邮），供用户手工填写。已经执行过提交但核对失败，或请求错误使提交结果不确定的，明确写「提交动作已执行但核对失败」或「提交结果未确认」，列出差异，请用户先核实 ERP 当前状态，不称为草稿待提交，不重复提交。因子代理卡住、平台记录损坏，或报价截止未完成挑店/发送而无价的型号，其余正常型号照常提交后也标记任务需人工处理，说明哪些型号已提交、哪些尚缺价格。
8. 写入本地记录：不管有没有提交成功，都执行 `node "<技能目录>/scripts/records.mjs" finish "<本次目录>/run.json"`。执行前排除仅挑中、未实际发送且非沿用报价的候选店，不补造 `sentAt`，避免污染防重复记录。它把每家实际询问的店的各型号写进询价记录（包括同店只给部分型号报价时其余已询问型号的无价记录，用于防重复），保留报价备注，下次能沿用已收到的报价，并按 `submitted` 把任务记为已提交或未提交。
