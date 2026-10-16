# ERP 接口与填报

主代理或单代理执行任务读取、草稿、提交和核对前读本文。平台代理不调用 ERP。普通运行不需要读取 helper 源码；只有维护、接口同步或针对 helper 的排错时，才读 [erpApi 源码与 CONTRACT](../helpers/_erp/erpApi.md)。

## 调用接口

技能自带的 `erpApi`（[helpers/_erp/erpApi.md](../helpers/_erp/erpApi.md)）由 `install-helpers` 装进 ERP 域名。调用方式：先打开自己的 ERP 标签页，下一次 `run` 里 `await helpers.erpApi(browser, <ERP 标签页 id>, { op, ... })`。

| op | 参数 | 返回 |
|---|---|---|
| `ping` | — | 是否已登录、待处理任务数 |
| `list` | `done`：`false` 待处理，`true` 已回价 | `tasks`：`taskId`、任务编号、型号数、已填数、剩余分钟等 |
| `task` | `taskId` | `run` 及同级 `snapshot`：任务信息和首次持久化基线 |
| `snapshot` | `taskId` | 只读当前 ERP 的完整快照，用于与持久化基线对账 |
| `save` | `taskId`、`submit`、`items`、`skipItemIds`、必填 `expectedSnapshot`（完整持久化基线） | 存草稿或提交回价、返回实际写入 itemIds；对账冲突返回 ERP_CONFLICT，不发 PUT |
| `verify` | `taskId`、`submitted`、`items`、`skipItemIds`、原 `save` 的 `expectedSnapshot` | `mismatches`、`verifiedItemIds`、`inDoneList`、`filledCount`、同次 GET 的 `snapshot` |

- 请求在 ERP 标签页里发出：令牌取自页面的登录状态，不离开浏览器，不写进对话和任何记录；GET 遇 HTTP 401 或响应 `code:401` 时最多续期并重读一次，续不了返回 `ERP_LOGIN`。PUT 已进入发送后遇任一种授权失败都不续期重发，返回 `ERP_LOGIN` 和 `writeAttempted:true`，登录恢复后只读核对原 payload。
- 每次请求都按 `CONTRACT` 核对响应结构，对不上返回 `ERP_CONTRACT`（见本文「ERP 错误与重试边界」）；ERP 多出来的字段列在 `extraFields`。
- `skipItemIds` 是辅助脚本的跳过列表，不是发给 ERP 服务器的新字段；每个 ID 必须属于本任务、不得重复，也不得与 `items` 重叠，否则返回 `SKILL_INPUT`。`verify` 用原基线重建完整写入计划，核对新报价、保留旧报价、自动带入的草稿、无货说明、供应商及附件，并拒绝本次替换状态中的额外/重复行；跳过型号的旧草稿保持原状，审核流合法旧已通过版本仍可并存。
- `save` 的规则与 ERP 页面「提交回价」一致：同一型号上本人原有的报价行照带，同一平台同一店铺可合法补充或纠正，但首次发现已有人工同店内容须核对保留或有明确变更授权，不直接用新报价覆盖；基线未漂移后才按本次内容替换，并保留实际被替换版本上的原附件（同店草稿优先，不挪用未被替换版本的附件）；提交时其他型号上的草稿一并提交，`skipItemIds` 里的故障未完成型号除外；已报给客户的型号跳过。技能不新增上传附件。
- 内容较多时 `erpApi` 会分段读写，单次调用一般在几秒内；整个任务的报价放在一次 `save` 里即可。
- ERP 接口改了、技能还没同步时，维护者按[采购维护说明「ERP 接口改了怎么同步」](../../README.md#erp-接口改了怎么同步)更新 `CONTRACT` 并升版本。

## 选任务与读取

1. 选任务：`erpApi` 的 `{ op: "list", done: false }` 返回「待处理」任务（`taskId`、任务编号、型号数、已填数等，顺序与页面一致：系统已按超时、紧急、更新时间排好）。
   - 用户指定了任务编号就只做这个任务，完成后不再取下一个（按 [execution.md「停止或继续」](execution.md#停止或继续)直接进入总汇报）。指定的任务不在「待处理」里时，再查「已回价」（`done: true`）；都没有就停止并告诉用户找不到这个任务，不回退处理全部待处理任务。
   - 没指定时，主代理先按 [停止或继续](execution.md#停止或继续)检查本轮停止边界，从最新列表中过滤本轮已收尾的业务 `manual` 任务，再按剩余原顺序调用 `node "<技能目录>/scripts/records.mjs" next <任务编号1> <任务编号2> …`，取第一个本机未提交、未跳过且可继续的任务。输出的 `next` 为 `null` 表示没有要做的；过滤后无候选也直接结束。用户新一轮启动时清空该排除集合，重新传完整待处理列表；manual 若有真实未完 run 则恢复，无可恢复断点才跳过。next 返回 resumeRun 时复用其目录；用户指定编号不跳过恢复核验，已提交 run 仍会拒绝直接重开，需先核对 ERP 业务状态。
   - 需要审核的账号提交后，任务在审核通过前仍留在「待处理」里，`next` 会因为本机已提交过而跳过它。
2. 执行 `node "<技能目录>/scripts/records.mjs" open-run <任务编号>`，按 [原 run 恢复协议](run-protocol.md#原-run-恢复与防重复)取得 runDir。仅新任务初始化；同 IQ 原未完 run 优先复用，坏记录/多份未完不盲选。兼容 `new-run` 只输出路径。恢复前确认旧执行者已停止，completed 平台不重派询价。
3. 读任务：`erpApi` 的 `{ op: "task", taskId }`。返回的 `run` 就是 `run.json` 的开头部分：任务编号 `task`、ERP 任务 ID `taskId`、报价截止时刻 `deadline`、是否需要审核 `reviewRequired`，以及每个型号的 `itemId`、型号、数量和单位、描述、系统话术 `script`、各平台的货源直达链接 `links`。首次把它写进本次目录 `run.json`，补齐 platforms 等字段，并把同级完整 snapshot 保存为 `erpSnapshot`。snapshot 含任务身份、审核/可编辑状态、每型号锁定和全部本人报价字段/状态/附件。恢复未初始化且无平台/消息事实的空骨架时可补齐首次 task 和 snapshot；存在实际断点时读取当前 task/snapshot 仅用于与持久化基线比较，不能覆盖旧基线、deadline 或平台进度；外部变化须核对保留或明确授权变更，不用新读值静默重置 baseline。
   - `editable` 为 `false` 仅表示任务不可编辑、回价只能查看：不询价，执行 `node "<技能目录>/scripts/records.mjs" skip <任务编号> ERP不可编辑`，告诉用户；结合 `lockedItems` 说明已报给客户的型号，只有实际取消状态或证据才称询盘已取消。没指定任务编号时接着取下一个（见 [execution.md「停止或继续」](execution.md#停止或继续)）。
   - 每个型号的 `existingQuotes` 里都已有本人「已提交」或「待审核」的报价时，说明这个任务已经回过价（可能是在别的电脑上）：不再询价，执行 `records.mjs skip <任务编号> 已回过价`；没指定任务编号时接着取下一个。用户指定的任务也一样，告诉用户已回过价；明确要求重跑须先核实 ERP 业务状态与现有提交记录，当前入口拒绝直接重开已提交 run，不删除或伪造旧状态绕过。
   - 已提交或跳过的任务记进本机记录后，`next` 不再选中；需人工处理的任务有真实未完 run 时优先恢复原断点，没有可恢复断点时才跳过（见本文「ERP 错误与重试边界」）。
   - `lockedItems` 里是已报给客户（只读）的型号，跳过，汇报里说明。
   - **报价截止时刻**：ERP 的 `quoteDeadline` 只有日期，首次 `deadline` 由 `erpApi` 按读任务的时刻加上 `remainingMinutes`（剩余分钟）算出；恢复沿用原 deadline，不用重新读任务延长期限。
   - 返回的 `extraFields` 不为空时，记进实跑报告（ERP 新增了字段，不影响本次运行）。
4. 任务里已经有本人的草稿报价时（`existingQuotes` 里有「草稿」），原样保留：提交回价时 `erpApi` 会把它们一并提交，不告知用户、不等确认，保留已有人工内容；同店补充/纠正先核对，未经授权不能覆盖人工内容（草稿备注里有原话和链接，可供核对）。本轮因故障无价而列进 `skipItemIds` 的型号除外，原草稿保留在 ERP 中、不随本次提交。

## 草稿、核对、提交一次与再核对

所有 ERP 写入由主代理唯一、串行执行；平台代理先持久化本平台结果，再请求主代理代存，不自行调用 ERP。同一 IQ 只存在一个写入者。ERP 人助尚未按[人助记录](run-protocol.md#人助记录与解除)核验解除时，仅保存本地结果和 payload，不调用 save；平台人助不阻止其他已完成平台的草稿写回。helper 的 snapshot GET → 对账 → PUT 不是服务器原子锁，无法阻止读写间外部修改；不把它宣称为事务或分布式锁。

每个平台完成即部分合并、生成草稿并核对；其他平台继续。任何平台仍 running/interrupted、存在未知发送或 stopAfterTask 时只留草稿，禁止正式提交。全部平台真正 completed/用户明确跳过后才完整合并并正式提交。正常报价截止按业务完成收尾、带 incompleteItems 的情形仍保留原有有效报价提交和缺价跳过机制。

1. 整理每个型号要填的报价（`run.json` 里 `status` 为已回复、挂牌价且有报价的店），以及是否需要标无货：
   - 某个平台问过的店都没报价时，按 [inquiry-rules.md 第 3 节](inquiry-rules.md#3-店铺筛选标准手册第-2-节)「没有回价时」用公开挂牌价补救（货况「待确认」，备注「公开挂牌」）；所有启用平台一个价格都没有、且不在 `incompleteItems` 里的型号才勾「无货」，无货说明按平台写清问了几家、结果如何。同型号有有效报价时优先保留报价，不因另一个平台的 `noStock` 覆盖。报价截止时尚未完成挑店/发送的型号写 incompleteItems，无价不算无货；正常截止收尾完成后可提交其余有效报价。子代理卡住/记录损坏另将平台 interrupted，本轮仅代存草稿，不能借此按部分结果提交。
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

3. **平台结果即存草稿**：主代理部分合并指定持久快照后执行 `erp-items "<本次目录>/run.json" --draft`，输出已有报价 `{ taskId, items, skipItemIds }`，不把未完成平台推成无货。保存前持久化本次原 payload 和 `draftReceipt`，调用 `{ op: "save", taskId, submit: false, items, skipItemIds, expectedSnapshot: run.erpSnapshot }`。缺基线返回 SKILL_INPUT；对账发现实际写入范围的 ERP 变化返回 ERP_CONFLICT，不 PUT。没有报价则只保留本地结果，不空写草稿。
4. **草稿核对及基线**：用原 payload 调 `{ op: "verify", taskId, submitted: false, items, skipItemIds, expectedSnapshot }`；expectedSnapshot 必须是本次 save 前持久化的原基线。仅 `ok: true` 且 `mismatches` 为空算核对成功。将本次 save 返回的实际写入 itemIds、verify 的 verifiedItemIds 及同次 GET 的 snapshot 保存回执；只把这些 itemIds 对应的 snapshot.items 合并回持久化 erpSnapshot，其他型号保留原基线，防止吸收并发人工改动。不要另读 snapshot 后全量替换基线。恢复时若 save 回包丢失，先用原 draft payload 和原基线 verify，以 verifiedItemIds 确认完整范围；范围或结果不能确认则暂停写回、不盲吸收新值。草稿差异按第 7 条处理。
5. **完整提交输入**：所有平台真实完成/明确跳过且无提交阻塞时默认 merge，再执行 `erp-items "<本次目录>/run.json"`。全部调用原样传 items 和 skipItemIds；后者只含无有效报价的未完成型号，其旧草稿保留，不随本次提交。有效报价优先于其他平台无货；正常截止 completed 带 incompleteItems 不阻止其他报价提交。没有任何可提交项不调用 save，转人工并本地收尾。有内容时先持久化该完整 payload，执行 save submit:false（含 expectedSnapshot）和 verify submitted:false，按第 4 条核对并更新实际写入范围基线；包括最终无货项在内的完整草稿核对通过后才进入第 6 条。
6. **提交一次与核对**：提交前先把最终原 payload 持久化在个人 run 目录，写 `submissionAttempt: { state: "pending", at }`，再调用 `{ op: "save", taskId, submit: true, items, skipItemIds, expectedSnapshot: run.erpSnapshot }`。最终提交按完整持久化基线核对所有实际写入型号，包括自动带入的其他草稿，不换新基线绕过冲突。
   - 提交后用相同原 payload 调 `{ op: "verify", taskId, submitted: true, items, skipItemIds, expectedSnapshot }`，使用本次正式 PUT 前的原基线。核对包含保留报价和自动带入的其他型号草稿。只有 ok 且 mismatches 为空才确认本次实际写入范围，写 `submitted: true`、真实 stages.submitted 和 attempt.confirmed；需要审核账号的待审核也算本次提交成功。将 `inDoneList`、`filledCount` / `itemCount` 保存为任务汇总观察，不参与 helper 的 ok 判定：不能因仍在待处理、已填数不等于本次提交数或未满型号数判失败，也不能由汇总判成功。部分提交、skip 或 locked 型号可能使任务继续待处理；列表反映整个任务状态，本人已填数还可包含草稿、待审核、作废报价，不能等同已提交数或任务完成数。
   - 任何已发 PUT 或发送状态未知的尝试（pending/unknown/failed/confirmed）都不能再次 submit；请求中断、结果未知记 unknown，只用原 payload 只读 verify。仅 helper 明确返回 writeAttempted:false（确实未进入 PUT）时可记 state:not_sent；修复后用原 payload 重试，调用前再写 pending。错误名、登录恢复或推断均不能代替未发证据；ERP_BIZ 也必须区分 GET 与 PUT 阶段。明确失败/差异转人工，不把未知结果称为未提交草稿。

### ERP 错误与重试边界

7. `erpApi` 返回错误时：
   - `ERP_CONTRACT`：缺字段、类型变了、取值不认识或接口不存在时，立即停止 ERP 调用，不提交、不猜字段；独立平台可完成本地结果，本轮不取下一 IQ；告诉用户「ERP 接口已修改，烛龙智能询价没有同步，请更新技能」，把 `problems` 写进汇报和实跑报告。只有新增的 `extraFields` 可继续并记录；本节第 8 条记录收尾照常执行，已收集的报价列在汇报里。
   - `ERP_LOGIN`：按 [人助协议](execution.md#暂停与恢复)请求 ERP 登录；owned 目标页、唯一 owner、20 分钟总时限和两次核验失败边界同平台人助。仅暂停写回，其他平台继续保存本地结果。取消、超时或两次失败后本轮不取下一 IQ、不自动重试写回。
   - `ERP_CONFLICT`：持久化基线与当前实际写入范围不符，helper 不 PUT；停止写回，保留本地报价和差异，核对并保留人工改动或取得明确变更授权。不得用刚读的新 snapshot 静默覆盖旧 baseline。
   - `ERP_BIZ`（ERP 拒绝内容）和 `SKILL_INPUT`（本地取值错误）：只有本次 save 明确 `writeAttempted:false` 且无先前已发/未知写入时可纠错重试；草稿可改正 run.json 并重新生成 items/skipItemIds，同错最多改两次，正式提交须记 not_sent 并用原 payload 重试。已发或结果未知的 save（含草稿）只用原 payload 和原基线 verify，差异转人工，不纠错重放。
   - `ERP_HTTP`：只读请求或明确 `writeAttempted:false` 的 save 稍等后最多重试一次；已发或结果未知的 save（含草稿）只重试原 payload / 原基线的只读核对，登录恢复不授权重放。仍失败转人工并停止本轮写回与批次，其他平台可完成本地结果，不取下一任务。
   - **主代理解决不了就转人工**：允许纠错的同一个错误改了两次仍失败、任何已发 save 的 `verify` 有差异、`ERP_HTTP` 只读核对重试后仍失败时，不再重试，执行 `node "<技能目录>/scripts/records.mjs" manual <任务编号> <原因>`，把任务标记为**需人工处理**。还没执行提交、草稿已保存的，由用户在 ERP 页面核对后提交；草稿结果未确认的先核实当前 ERP，不称为未保存、不重放。未能保存草稿的，在汇报里列出已收集的报价（型号、平台、店铺、单价、含税、货况、货期、包邮），供用户手工填写。已经执行过提交但核对失败，或请求错误使提交结果不确定的，明确写「提交动作已执行但核对失败」或「提交结果未确认」，列出差异，请用户先核实 ERP 当前状态，不称为草稿待提交，不重复提交。正常截止收尾 completed 但尚有缺价 incompleteItems 时，其余有效报价可提交并标记任务需人工处理，说明提交/缺价范围；因子代理卡住、记录损坏或人助失败的平台是 interrupted，只留草稿，不正式提交，其他平台完成后本轮结束当前 IQ。
8. 写入本地记录：不管有没有提交成功，都执行 `node "<技能目录>/scripts/records.mjs" finish "<本次目录>/run.json"`。执行前排除仅挑中、未实际发送且非沿用报价/真实公开挂牌的候选店，不补造 `sentAt`，避免污染防重复记录。它把实际询问、沿用及真实公开挂牌的各型号写进询价记录（包括同店只给部分型号报价时其余已询问型号的无价记录，用于防重复），保留报价备注，下次能沿用已收到的报价，并按 submitted 记录提交事实。finish 按 run 目录及快照幂等；保存本地历史不是提交或完成证明，恢复继续原断点，不能据此重发。
