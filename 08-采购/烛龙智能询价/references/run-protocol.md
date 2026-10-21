# 运行记录协议

所有执行者先读「受控保存与事件」「每日时间线与关键事件」。主代理或单代理再读任务记录、去重、ERP 输出与报告所需章节；平台代理再读「run.json」「平台记录与合并」并只保存自己的平台 scope。完整业务判断见 [inquiry-rules.md](inquiry-rules.md)，调度控制见 [execution.md](execution.md)。

以下历史查询与原 run 恢复仅适用于仍存在的本机数据。升级按[数据生命周期](data-lifecycle.md)保留个人数据并处理旧格式，先完成当前版本初始化；保留的 run 仍须核对真实业务状态。CLI 写入口版本不一致时拒绝并提示先 `init`，不自行清理。

## 受控保存与事件

`run.json` 和 `run-<平台>.json` 是权威断点；只读查看前先确认无 `.records-pending.json`，存在时不能把单个文件当一致状态。保存业务状态统一用 `checkpoint`；仅补充语义事件用 `event`。轮次授权仅由主代理调用 `plan-inquiry` 保存。不通过文本编辑器、脚本或复制文件直接覆盖权威 JSON，不手写版本、revision、inquiryPlan 或时间线。准备输入文件不表示断点已生效，只有命令成功才可按新进度继续。

```bash
node "<技能目录>/scripts/records.mjs" checkpoint "<本次目录>" "<输入JSON>"
node "<技能目录>/scripts/records.mjs" event "<本次目录>" "<输入JSON>"
```

输入使用 UTF-8 JSON 文件；`checkpoint` 示例中的任务、ID 和时刻均为虚构，`snapshot` 实际传本 scope 最新完整业务快照，不只传变化字段：

```json
{
  "runId": "从本次 run.json 取得",
  "eventId": "本次语义动作的唯一稳定标识",
  "actor": "main",
  "scope": "run",
  "expectedRevision": 0,
  "event": { "eventType": "task.read", "phase": "task", "occurredAt": "2026-01-01T08:58:00.000Z" },
  "snapshot": {
    "task": "IQ20260101001A", "taskId": 123, "status": "running",
    "items": [{ "itemId": 456, "model": "6ES7214-1AG40-0XB0" }],
    "platforms": ["淘宝"], "submitted": false
  }
}
```

此例演示输入结构；正式取任务时还须将同次 ERP 返回的完整型号、截止信息及 `erpSnapshot` 放入 snapshot，不用示例中的虚构或精简业务字段代替实际任务。

- `runId` 取 `open-run` 返回值或权威主记录；`actor` 为实际记录者的逻辑角色：主代理 `main` 或本平台名。主记录用 `scope:"run"`；平台用 `scope:"platform"` 并带 `platform`。平台代理只能保存与自己同名的平台；单代理仍以 `main` 为 actor 分别保存主/平台快照。平台 scope 自动固定并核对 `event.platform`；独立 `event` 中，main 记录平台事实须显式带 `event.platform`，平台代理缺省取自身平台，不能冒用别平台。事件不替代角色授权。
- `expectedRevision` 取刚读取的目标 scope 的 `revision`。主/平台分别计数，两个平台保存各自快照不共用 revision。冲突先重读最新文件、保留并合并新事实，再重新保存；不旧副本覆盖、不把失败当已保存。主记录的任务身份、已绑定型号 ID/型号及平台范围不可另换；主 scope 不能修改平台归并字段（shops、noStock、incompleteItems、skippedPlatforms、platformStages、platformStates、platformHumanHelp、platformInterruptions），这些字段保持最新主记录原值，通过平台快照及 `merge` 更新。`incidents` 中带 platform 的条目同样原样保留；main 可更新无 platform 的自身事件，例如 ERP 滑块意图/结果。`inquiryPlan` 即使是主 scope 也必须保留原值，只能通过下文 `plan-inquiry` 重算；恢复不重新导入 ERP 整包覆盖已有进度。
- `snapshot` 建议只包含业务字段。工具继承 `schemaVersion`、`runId`、`skillVersion`、`createdAt`，更新 `executionVersion`、`revision`、`updatedAt` 及主记录的 `eventSeq`；若输入包含这些元数据，必须与当前值完全一致，不能自行递增或伪造。
- `eventId` 在同一语义动作首次准备时生成，重试保留；命令响应丢失后，用完全相同的输入重试。工具返回 `{ runId, revision, seq, eventId, replayed }`，已成功的相同请求返回 `replayed:true`；新的事实使用新 eventId，不能改内容后冒用原 ID。
- `event` 命令输入仅带 `runId`、`eventId`、`actor`、`event`，不带快照或预期 revision；用于已有断点之外的真实事件。发送意图、确认、人助及 ERP 回执等需要更新断点时，用一次 `checkpoint` 同时保存事件和快照，不能只留事件而让恢复字段缺失。

本地写入先持久化 `<数据目录>/.records-pending.json`，再完成相应断点、时间线及归档；普通抛错释放短锁后，后续受控写入口可恢复未完成写入。强制终止进程可能遗留外置生命周期锁，写入口有限等待后报忙，不自动抢锁；先由维护者核实原执行者及其他写者均已停止后处理，再由受控写入口恢复，不承诺强制终止后自动恢复。只读入口遇到 pending 会明确报待恢复，不能继续把部分文件当一致状态。不要手删 pending、锁或临时文件绕过；命令未成功时先保留原输入并按错误处理，不开始依赖动作。records 写入口对锁作有限等待；持续占用报忙后核实原执行者，不另建 run 或清锁抢写。生命周期、settings 和 contacts 仍按各自锁协议处理。

多文件只读也复用生命周期短锁：`next` 在同一次短锁内读取任务历史和断点，`watch` 每轮读取时持锁、读完即释放，等待期间不占锁，stopAfterTask 取当轮主记录。只读锁不执行 `init`、不重建目录，也不因只查看而要求先初始化；读取已有 run 仍核验其身份和版本，pending/锁占用按实际错误停止读取。常驻 watch 读取报错会结束监控并非零退出，不输出伪 finished。单文件统计沿用原子文件读取，不作跨文件一致性承诺。

运行的 `skillVersion` 固定为创建版本；`executionVersion` 记录最近一次受控保存的执行版本。平台快照绑定同一 runId 和创建版本，各自保留最后保存的执行版本。事件及 pending 同样记录创建版本与实际执行版本，归档行和恢复输出也明确区分；无 run 的事件两者均取执行版本。创建于 `2.9`/`2.10` 且缺少 `executionVersion` 的原记录按其 `skillVersion` 理解，新写入会补执行版本，历史行不改写。兼容旧 run 可以续跑，低于基线、较新版本及损坏身份拒绝；目录升级和旧 pending 处理见[数据生命周期](data-lifecycle.md)。

## 每日时间线与关键事件

文件为 `<数据目录>/runs/timeline-YYYYMMDD.log`，扩展名是 `.log`，内容为 UTF-8 JSONL，每行一个事件。按实际落盘日期（UTC）分文件；跨日恢复仍用同一 runId，事件按本 run 的 `seq` 关联，不从文件名推断业务发生日期。

每行含 `schemaVersion`、`runId`、`skillVersion`、`executionVersion`、`task`、`taskId`、`seq`、`eventId`、`recordedAt`、`occurredAt`、`actor`、`platform`、`eventType`、`phase`、`itemIds`、`models`、`revision` 和幂等核对用的 `requestHash`，其余字段按事件需要提供。版本、任务及型号名称由权威断点补齐，不手工传一套独立型号文字；`itemIds` 必须属于当前任务且不重复。没有 run 的 skip/manual 事件不虚构运行身份、序号或型号。`recordedAt` 是落盘时刻；知道真实发生时刻才传 `occurredAt`，缺省为落盘时刻，不把缺省值当准确的业务起止。

`event` 只接受下表组合，不自行发明 eventType 或 phase。发生状态变化时优先随 `checkpoint` 一起记录；仅增加观察或信号事实时使用 `event`。

| eventType | phase | 何时记录及必填关联 |
|---|---|---|
| `task.read` | `task` | main 首次保存实际 ERP 任务、型号和基线 |
| `item.selected` | `selection` | 开始处理型号时；带 `itemIds` |
| `link.processed` | `selection` | 货源链接处理结果；带 `platform`、`itemIds`、稳定链接 `correlationId` 和实际 `outcome` |
| `shop.checked`、`shop.selected`、`shop.skipped` | `selection` | 候选核验、实际选定或跳过；带 `platform`、`shop`、`itemIds`。checked 必填 `outcome`，其中 excluded 必填 `reason`；skipped 必填 `reason`，不把失败算无货 |
| `message.intent`、`message.confirmed`、`message.unknown`、`message.cancelled` | `messaging` | 发送前意图、目标会话读回已发、结果未知、明确撤销未发消息；均带 `platform`、`shop`、`itemIds`、同一稳定 `messageId` 和 `messageKind`（initial/followUp/reply/thankYou/correction）。消息 checkpoint 必须用平台 scope，与店级或下文更正事件 pendingMessage 的 ID、kind、state 和型号范围一致；原文保存在业务记录，不复制到时间线 |
| `reply.received`、`quote.recorded`、`shop.ended` | `messaging` | 实际收到回复、保存报价、店家业务结束；带 `platform`、`shop`、`itemIds`，ended 必填 `reason`，店家原话和价格保存在业务快照 |
| `human.requested`、`human.returned`、`human.verified` | `human` | 实际请求、工具交回、目标核验；带同一 `correlationId`，有真实 requestId 才填 `requestId`，交回不冒充核验解除 |
| `slider.observed`、`slider.attempted`、`slider.verified` | `human` | 观察、一次尝试及实际核验；带同一 `correlationId` 和实际 `outcome`，意图/结果仍保存在 incidents |
| `control.signal` | `control` | 代理/业务控制信号；带下述完整 `signal`，分别记录 sent、received、applied |
| `erp.draft`、`erp.submit`、`erp.verify` | `erp` | main 记录原 payload 的写前意图、实际结果或核对；带同一 `correlationId` 和实际 `outcome`，涉及型号带 `itemIds`，不带电商 `platform`，不把收到回包记成核对成功 |
| `platform.completed`、`platform.interrupted` | `platform` | 平台业务真实结束或执行中断；带 `platform`，中断必填 `reason` |
| `run.resumed`、`run.interrupted`、`error` | `recovery` | 实际完成恢复核验、中断或错误；run 事件仅 main 记录，中断和错误必填 `reason` |
| `stage.measured` | `timing` | 已实测的阶段用时；必填非负 `elapsedMs`、`correlationId` 和下述 `stage`，可带非负整数 `toolCalls`，`outcome` 写实际结果 |

`signal` 仅用于 `control.signal`，固定为 `{ id, name, from, to, status }`。同一控制动作共用 `id`，`name` 说明派发/暂停/恢复/停止等动作，`from`/`to` 为实际角色；发送者以自身 actor 保存 `sent`，接收者保存 `received`，接收者实际执行并持久化对应状态后才保存 `applied`。每个状态使用各自 eventId，不把投递成功当已接收或已停止。

主代理代存一个平台的断点仍记实际 actor 和目标 platform，不能据此代记另一个代理已 received/applied。`stage` 仅用于 `stage.measured`，允许 `navigation`、`readiness`、`extraction`、`verification`、`selection`、`sending`、`waiting`、`reply`、`erp`、`recovery`；工具执行、业务等待和人工等待使用不同 correlationId 并在 outcome 说明实际范围，不把等待算作工具执行。

可选 `outcome`、`reason`、`requestId`、`messageId`、`correlationId`、`shop` 只写短摘要；`reason` 最多 500 字符，其余最多 200 字符。任务全量事件 `task.read`、`run.opened`、`run.archived` 未传 itemIds 时，工具从当前 run.items 补齐型号。时间线不记密码、验证码、令牌、完整网页、完整聊天或完整报价载荷；需要保留的商家原话仍按业务协议写到本 run 的对应字段。记录字段合法不证明外部事实已发生，执行者仍负责实际核验。

`open-run`/`new-run` 自动记录 `run.created` 或 `run.opened`，`skip`/`manual` 自动记录 `task.skipped`/`task.manual`，`beat` 自动记录 `heartbeat`，`merge` 自动记录 `platform.merged`（platform 为 null，outcome 列合并平台），`finish` 自动记录 `run.archived`，`plan-inquiry` 在实际保存首轮/策略变化/新增授权时记录 `inquiry.planned`（selection，correlationId 关联 round）；这些内部事件不通过 `event` 手工补造。心跳只证明打卡，合并只证明本地快照保存，归档不等于平台完成或 ERP 提交。

`stages`/`platformStages` 保留真实阶段结束时刻，`stage.measured` 记录实际工具执行、业务等待或人工等待用时；并行区间不简单相加。缺开始、结束或中断期间观察时，明确缺数据，不以最后心跳、进程退出或本次恢复时刻补造准确终止时间，也不据缺失区间下提速结论。

## 本地防重复

对每个型号执行 `node "<技能目录>/scripts/records.mjs" recent <型号>`，查 `dedupeDays` 天内问过的店家：

- 问过且报了价的：不再发消息，沿用那次报价及其备注、包邮信息，记一家：`reusedFrom` 填 `recent` 输出里那条记录的 `time`，`reply` 注明「沿用 x 月 x 日回复」。`finish` 写记录时保留这个原时间，过了 `dedupeDays` 天就会重新询价，不会一直沿用旧报价。
- 其他情况（没回复、只有机器人回复、无货、没报价就结束的，包括因店家提问停止聊天的）：这次不再问，挑店时跳过，不计入家数，按挑店顺序换下一家。

`recent` 先取各 run、平台、店铺、型号 ID 的最后纠正，再跨 run 为同平台、同店及标准化型号选择业务 `time` 最新的观察，最后检查天数窗口；业务时间相同依次取较晚 `recordedAt`、较后归档行。旧 run 迟归档不遮蔽新询价，同 run 已被纠正的旧价格也不复活；非法时间不覆盖有效观察，损坏 JSON 仍报错。

沿用的店计入该 ERP 明细在本平台的不同商家覆盖数（见 [inquiry-rules.md「找店与挑店」](inquiry-rules.md#找店与挑店)）。单代理与子代理都把沿用的店写进 `run-<平台>.json`；并行时主代理把各平台查询结果交给对应执行者。主代理仅通过合并更新 `run.json` 的平台结果，避免直接写入后被平台覆盖。

## 原 run 恢复与防重复

选定 IQ 后先执行 `node "<技能目录>/scripts/records.mjs" open-run <任务编号>`，返回 `{ runDir, runId, skillVersion, executionVersion, revision, resumed, needsErpReconcile, completedPlatforms, stopAfterTask }`；`new-run <任务编号>` 使用同一恢复逻辑但仅输出路径。唯一未提交的真实 run 优先复用；多份未完、坏记录或已提交冲突须停止核对，不随意挑最近一份、不覆盖旧目录。模拟记录不参与真实恢复。`next` 仍按传入的 ERP 待处理列表顺序，需恢复时返回 `resumeRun`；manual 记录不掩盖真实未完 run，但明确 skipped 优先于 manual，不因旧断点重新选中已跳过任务；submitted 始终优先，不被后续 manual/skipped 撤销。

新 run 创建时立即保存工具生成的元数据和 `{ task, status: "running", items: [], platforms: [], submitted: false }` 空骨架，并记录 `run.created`；打开原 run 记录 `run.opened`，只表示取得目录，不表示恢复核验已完成。仅未初始化且没有平台/消息事实的空骨架，恢复时允许首次补入 ERP task，不拿空 snapshot 对账；已有实际断点则不得覆盖。主代理首次读取 ERP 后通过 `checkpoint` 补齐任务信息和 `erpSnapshot`（见 [ERP 协议](erp-api.md#选任务与读取)）。恢复时读原 `run.json`、各平台文件、未决发送/人助、草稿回执和提交尝试；ERP 新读取不得覆盖原 `deadline`、会话进度或旧基线。先与旧基线核对现 ERP，冲突时不写；检查上轮执行者已停止并完成核验后，才记录实际恢复并明确恢复本轮。

- `completedPlatforms` 只用于避免重派询价；ERP 未写回的结果由主代理补写草稿。用户明确跳过也需平台文件 `status: "completed"` 和非空 `skipped` 原因。
- `interrupted` 恢复先按[逐项检查](execution.md#访问限制与逐项检查)核原受阻必要步骤恢复、登录及验证不再阻塞，再按原绑定只读停止期间新回复、未决人助及发送证据，保留原 `sentAt` / `followUpAt` / `replyAt` / `followUps` / `answeredTopics` / `thankYou` / `deadline`。本身真正业务结束的店不再联系；未知发送不得盲重发，已过消息时限的新回复只提取报价，不重开对话。
- 平台中断置 `stopAfterTask: true`；其他平台继续至结束，本轮不提交、不取下一 IQ。只有用户新一轮启动、核实断点及解除阻塞后，主代理才显式清除本轮停止标记；`merge` 不自动清除。中断不是后台恢复授权。
- 正常报价截止按原业务规则完成收尾的平台可记 `completed`，即使有 `incompleteItems`。全部平台完成后，有效报价仍可正式提交，缺价的未完成型号进 `skipItemIds`；不能把此情形混成执行中断。

## 发送意图与确认

首次询价、追问、答复和道谢发送前，平台执行者先将该店 `pendingMessage` 持久化：`{ messageId, kind, text, preparedAt, state: "pending" }`。`messageId` 是新意图生成的稳定短字符串，同一意图在核验、恢复和重试时保留；`kind` 分别为 `initial`、`followUp`、`reply` 或 `thankYou`；`correction`（发错更正）一律按下段保存到 `incidents[]`。用平台 checkpoint 同时保存对应 `message.intent` 后，确认准备内容和发送对象才操作 UI。发送后读回目标会话，明确出现该消息才经 checkpoint 保存 `message.confirmed`、`state:"confirmed"`、`confirmedAt` 和对应事实：首次询价 `sentAt`，追问 `followUps` / `followUpAt`，答复的 `answeredTopics` / `replyAt`，道谢的 `thankYou`。事件以店名、messageId、messageKind 唯一定位快照 pendingMessage，零个或多个匹配均拒绝；itemIds 对应目标店的型号范围。同名历史不同身份记录不会按第一行误配。答复不改变 `followUps` 或 `followUpAt`。多条消息逐条确认并保存，不覆盖尚未核实的意图；shops 及更正 incidents 的所有消息种类，同一 messageId 的 confirmed/cancelled 不得退回 pending，原未知 pending 仍可按证据确认。后续意图替换 pendingMessage 时仍保留店级 replyAt。

每次发错更正的意图均单独保存在本平台 `incidents[]`，无论误收店是否已属于正常询价店：`{ type:"message.correction", targetShop:"实际误收店", itemIds:[本任务型号ID], pendingMessage:{ messageId, kind:"correction", text:"不好意思发错了", preparedAt, state:"pending" } }`。事件 shop 必须为该 targetShop，messageKind 为 correction，messageId/state/型号关联与此意图一致；确认后在此保存 `state:"confirmed"` 和 confirmedAt。可用 detail 或事件 correlationId 关联同次误发及原目标。误收店原本不在 shops 时不为更正而新增；原本已在 shops 时保留其已有 pendingMessage，也不替换原目标尚未核实的发送意图。其余四类消息仍使用正常店级 pendingMessage。更正结果未知仍保留 pending 并先核证据，不重复发送；未决更正阻止平台 completed 和正式 ERP 输入。merge 保留此平台事件，finish 不因更正事件把误收店当询价店归档或加入防重复历史，已有真实询价事实仍按原规则保留。

`sentAt`、`followUpAt`、`replyAt` 保存经聊天证据确认的实际发送时刻；`confirmedAt` 只表示本次核验时刻，不作为等待起点。计时规则见 [inquiry-rules.md 第 5 节](inquiry-rules.md)。当前未完整断点已经答复但缺少 `replyAt` 时，先核原聊天发送证据，再按下段受控保存；无法确定则保留待核、不继续对外发消息，不用本次读取或恢复时刻重置计时。

当前断点若已有 `confirmed` 的 `reply` 意图但缺 `replyAt`，`open-run` / `check --partial` 会报缺字段。主代理按原命令目录和报错文件只读原平台记录及其最新 revision（`open-run` 错误含原记录路径），核原聊天发送证据；确认后以该 revision 为 expectedRevision，通过平台 scope 的 `checkpoint` 仅补真实 `replyAt`，保留原 `messageId`、`confirmedAt`、已答话题及其他进度，保存成功后重试 `open-run` / `check --partial`。不直写权威 JSON、不新建 run；原平台 JSON、元数据和身份必须仍可读取，新快照须完整通过校验。无法核实或结构/元数据损坏时保留原记录并停止该平台，按[合并与记录失败](execution.md#合并与记录失败)报告。仅有 `answeredTopics` 的未完整断点也必须先补证据才继续该店对话。

UI 报错、调用中断或看不清发送结果时保持 `pending`，记录待核事件，不当作未发而重试。恢复先核对目标店、消息内容与聊天时间；有证据已发才补确认，明确未发且仍获授权/未截止才可发送原意图，无法确认就继续待核并禁止最终提交。明确撤销未发消息才记 `cancelled`。跨平台目标已达成时，原首询意图仍先核实际发送：已发补确认，明确未发则撤销，未知继续保留；受控快照允许核验或撤销，不授权向未发送的新店继续操作 UI 发送。`check --partial` 可保留待核意图，completed 校验及正式 `erp-items` 拒绝未确认发送。

## 人助记录与解除

以下落盘规则用于已有本次目录的任务；取任务准备期间尚无本次目录时，按[取任务前的人助](execution.md#取任务前的人助)处理，不虚构任务记录。

人助前的[普通滑块一次尝试](execution.md#普通滑块仅尝试一次)使用现有 `incidents` 保存拖前意图和拖后结果；`detail` 保持字符串，包含同一阻塞事件标识及目标/时间。恢复须先检查意图，未知结果仍视为已尝试；事件保留不代表脚本强制防重，也不把自动失败计入人助核验失败次数。

平台人助保存在本平台文件 `humanHelp`，ERP 写回人助由主代理保存在 `run.json.humanHelp`。至少记录范围、owner、requestId、目标标签/网址、BrowserOS 标签组 ID（可取得时）、请求创建时刻、状态和同一阻塞事件核验失败次数；会话句柄只在工具要求时保留，不写登录令牌。原生回包有 requestId 则原样保存；错误回包未给 ID 时记 `requestId:null`，保留原始返回和分类来源，不虚构 ID、不 await 不存在的请求。`status` 是工作流分类，`nativeStatus` 保留工具实际状态，工具未返回状态时为 `null`，另记 `statusSource`；不得补造原生返回。

新请求及尚未核验的交回都记 `verified:false`。仅 owner 对原目标页实际核验解除后，当前事件才满足 `{ status: "resolved", verified: true, verifiedAt: "有效 ISO 时间" }`，继而清暂停；`resolved` 回包本身不等于解除。`waiting`、`pending`、`unknown`、失败、取消、超时或未核验交回都阻止平台 completed 和正式提交输入。无任何人助时此字段可缺省。`merge` 将平台当前事件保存在主文件 `platformHumanHelp.<平台>`，缺少字段不会清除已有阻塞；恢复必须明确写新的已核验事件，不能靠删除字段解除。

新一轮用户启动后，旧取消/超时等事件若经实际检查已解除，先把完整旧事件移入同文件 `humanHelpHistory`，保留原 requestId、原始返回和取消/超时分类；当前事件记 `{ status: "resolved", verified: true, verifiedAt, resolutionSource: "recovery-check", nativeStatus: null, requestId: null }`，并记录当前目标/归属和核验依据。该恢复检查没有当前请求 ID，原请求 ID 只留历史。这是恢复检查结果，不声称旧请求原生 resolved，不继续 await 已终态旧请求，也不凭恢复权限重发消息或提交。

运行中、部分合并和本地 draft payload 允许保留未决人助，以保存其他平台结果；ERP 人助未解除时仍禁止实际 ERP 写入，见 [ERP 协议](erp-api.md#草稿核对提交一次与再核对)。记录工具不负责调用或消费 BrowserOS 人助，也不能证明页面真实已解除。

## 询价轮次计划

只有主代理调用以下受控写入口，平台代理不调用、不自行增加店数：

```bash
node "<技能目录>/scripts/records.mjs" plan-inquiry "<本次目录>"
```

命令在生命周期短锁内恢复必要 pending，读取当前主记录和各平台最新快照，按[业务策略](inquiry-rules.md#有效可比报价与补轮)计算并保存 `run.inquiryPlan`。生产调用不接受自填时间或任意 target。每次从本次有效配置核对 policy，策略改变须由主代理生成新 round；已有 run 身份、店铺、消息及报价均保留。策略及授权都不变时不递增 round；候选耗尽、平台完成/中断、未解除人助、报价截止或用户全局停止时，不再向对应范围分配新店；`stopAfterTask` 本身只阻正式提交及下一 IQ，健康平台在当前 IQ 仍可有界补轮。

```json
{
  "inquiryPlan": {
    "policy": { "initialShopsPerPlatform": 2, "targetComparableQuotes": 3, "maxShopsPerPlatform": 4 },
    "round": 1,
    "plannedAt": "2026-10-19T10:00:00.000Z",
    "basedOn": { "淘宝": 2, "1688": 3 },
    "targets": [{ "itemId": 456, "platform": "淘宝", "totalShops": 2 }, { "itemId": 456, "platform": "1688", "totalShops": 2 }]
  }
}
```

`totalShops` 是该明细在该平台截至本轮累计授权的非负整数，不是本轮新增量；明确为 0 表示本条累计授权为零，缺少该明细/平台目标仍是错误，不能把缺项当 0。`round` 在首轮、策略或授权变化时推进。`basedOn` 保存生成计划所依据的各平台 revision（尚无平台快照为 0），平台保存仍使用自身最新 expectedRevision。每次补轮先扣有效报价、在等商家及已授权空位，仍不足才按每个明细/平台最多一家追加，且不超过累计上限；并发新回复可能使目标已满足，发送前仍要重核。达标、截止或用户全局停止时，主代理重算并撤回真正未发送的授权空位；实际已发、历史沿用及结果未知的 pending 保留，不假定未发。撤回授权后的真正未发候选可留档读回，但不计当前 selected/waiting，首次发送仍须符合当前计划。未经授权的新店或超过上限的首发由平台 checkpoint 拒绝。策略变化后，已有已发/待核事实超过新上限照实保留，只停止新增；不得以缩小配置删除进度。

输出包含 `plan`、`changed`、`allocations`、`policy`、`cutoffReached`、`stopped` 和逐明细 `items`。逐明细区分 `comparableCount`、`waitingCount`、`target`、`missing`；各平台另列 selectedCount、contactedCount、waitingCount、reservedCount、authorizedTotal、exhaustedReason、completed、interrupted。`missing` 不是可以立即联系的店数，先看等待/预留和真实 allocations，不据差值自行扩量。店已选、已联系、可比报价、等待及授权空位不能混成一个数量。

新建 run 进入平台挑店或首次询价前必须已有主计划，不能先保存实际 shops/searchCoverage 再补计划；纯任务骨架保存不强制。未完成旧 run 允许先只读核原断点，再由主代理创建计划后保存新策略，不能以迁移要求清空旧证据。完成平台不因报价目标或后改配置重新打开。已发/待核/沿用和超过当前上限的旧事实都保留，不能借升级或补轮补发旧店。旧 completed 平台保留原快照与旧目标，主代理只处理必要的 ERP 写回。

## 可比报价与商家主体证据

报价是否计入目标的业务条件以[有效可比报价与补轮](inquiry-rules.md#有效可比报价与补轮)为准，字段只保存实际证据，不是让执行者把布尔值勾满。示例为已核实的虚构证据：

```json
{
  "itemId": 456,
  "price": 2000,
  "taxIncluded": false,
  "condition": "全新原装",
  "leadTime": "现货",
  "freeShipping": true,
  "comparability": {
    "source": "merchant",
    "item": { "itemId": 456, "model": "6ES7214-1AG40-0XB0", "quantity": 1, "unit": "台", "description": "型号说明" },
    "sourceText": "商家明确对应原型号、数量和规格，确认全新原装现货、不含税且包邮的原话摘要",
    "verifiedAt": "2026-10-19T10:05:00.000Z",
    "requirementsMet": true,
    "taxConfirmed": true,
    "shippingConfirmed": true,
    "shippingAmount": 0
  }
}
```

`comparability.item` 绑定当前明细的 itemId、model、quantity、unit、description，原需求缺省项保持缺省，不跨同型号不同 ID 借证据。`source` 为 merchant 或 history；history 要有店级有效 reusedFrom，保留原商家原话和原报价时间；本轮实际重核其适配当前 itemId 及完整需求后，verifiedAt 记真实重核时刻，可以晚于 reusedFrom，但不刷新原价格时间。旧 itemId 证据不能未经重核直接改 ID 复用。`sourceText` 保留可追溯原话摘要，`verifiedAt` 为实际证据核验时刻。三个确认项可保存真实 false；只有齐全且金额/税率/货况/货期等满足计数条件时才可比。`shippingAmount` 是已知非负运费金额，明确包邮为 0；不能以 freeShipping 缺省为 true 代替来源确认。不完整报价仍保留，ERP 转换不以是否可比过滤。

店级可选主体证据为 `businessEntity:{ name, creditCode, sourceUrl, verifiedAt }`：企业资质全称、18 位统一社会信用代码、当前平台资质证据 URL 及实际核验时间。已有同一信用代码跨平台只计一家，同码全称冲突先核对，不能凭店名或平台 sellerId 推断跨平台主体。没有该证据时不强制额外查资质，省略即可。

店级 `noStockItemIds` 为本店明确回复无货的无重复明细 ID，必须属于该店 itemIds，`reply` 保留无货原话。部分无货仍保留其他明细报价，不能用一个店级 status 代替逐项证据；平台汇总 `noStock` 不替代本店证据。`merge` 和 `finish` 保留可比、主体和逐项无货证据；旧历史缺证据仍可按原规则沿用保存，但不能据默认值补成可比报价。

## run.json

本次询价的当前完整断点，边做边通过 `checkpoint` 保存，放在本次目录；以下为虚构格式示例，元数据实际由工具生成：

```json
{
  "schemaVersion": 1,
  "runId": "虚构运行标识",
  "skillVersion": "2.9.0",
  "executionVersion": "2.13.0",
  "revision": 1,
  "eventSeq": 2,
  "createdAt": "2026-01-01T08:57:50.000Z",
  "updatedAt": "2026-01-01T08:58:00.000Z",
  "task": "IQ20260101001A",
  "taskId": 123,
  "readAt": "2026-01-01T08:58:00.000Z",
  "deadline": "2026-01-02T09:00:00.000Z",
  "quoteDeadline": "2026-01-02",
  "reviewRequired": false,
  "platforms": ["淘宝", "1688"],
  "items": [{ "itemId": 456, "model": "6ES7214-1AG40-0XB0", "quantity": 1, "unit": "台", "description": "型号说明",
              "script": "系统话术", "links": { "淘宝": ["https://s.taobao.com/search?q=..."], "1688": ["https://s.1688.com/selloffer/offer_search.htm?charset=utf8&keywords=..."] },
              "existingQuotes": [] }],
  "lockedItems": [],
  "shops": [
    {
      "platform": "1688",
      "shop": "店铺或公司全称",
      "contact": "会话列表里显示的名字",
      "identity": null,
      "url": "https://detail.1688.com/offer/....html",
      "itemIds": [456],
      "reusedFrom": null,
      "inquiry": { "system": "系统原话术", "sent": "实际发出的话术", "added": ["问候", "是否全新原装"] },
      "answeredTopics": ["数量"],
      "stopQuestion": null,
      "sentAt": "2026-01-01T17:08:28+08:00",
      "firstHumanReplyAt": "2026-01-01T17:08:56+08:00",
      "followUps": 1,
      "followUpAt": "2026-01-01T17:11:21+08:00",
      "replyAt": "2026-01-01T17:10:00+08:00",
      "thankYou": "好的，谢谢！",
      "endedAt": "2026-01-01T17:11:50+08:00",
      "endReason": "信息齐全",
      "status": "已回复",
      "reply": "店家原话（摘要）",
      "quotes": [
        { "itemId": 456, "price": "2000", "taxIncluded": false, "taxRate": null, "condition": "全新原装", "leadTime": "现货", "freeShipping": true, "note": "备注全文" }
      ]
    }
  ],
  "noStock": [],
  "incompleteItems": [],
  "skippedPlatforms": [],
  "incidents": [],
  "stages": { "start": "", "taskRead": "", "shopsPicked": "", "allSent": "", "repliesDone": "", "submitted": "" },
  "status": "running",
  "platformStates": { "淘宝": "completed", "1688": "running" },
  "stopAfterTask": false,
  "userStopped": false,
  "submitted": false
}
```

- `schemaVersion`：记录结构版本，与技能语义版本分开。`runId` 唯一标识本次 run；`skillVersion` 固定为创建 run 的技能版本。恢复保留运行身份和创建版本，不把恢复时刻当新建；`executionVersion` 区分实际执行版本。仅旧格式清理后的数据不能续接。
- `revision`：主 scope 的快照修订号；`eventSeq`：本 run 时间线的事件序号。平台 scope 使用独立 revision，不自带 eventSeq。`createdAt`、`updatedAt` 为工具保存元数据，不替代业务阶段、实际消息时间或事件发生时间。
- `task` 到 `lockedItems`：取自 `erpApi` 的 `task` 结果（见 [erp-api.md「选任务与读取」](erp-api.md#选任务与读取)）。`deadline` 是报价截止时刻；`reviewRequired` 为 `true` 时提交后要审核；`items[].itemId` 是 ERP 型号 ID，所有报价的 `itemId` 都用它。主记录已绑定的任务及型号身份不得在后续快照中替换。
- `shops[].identity`：可选的[当前账号身份映射](identity-mapping.md)验证结果，未核实为 null 或缺省。来自当次 helper 的平台、具名账号、接收者、self 买家证据及 conversationId，独立商家页证据可选。`check` 验证结构、平台及已有 contact 一致；`merge`、恢复及 `finish` 归档保留。当前版本记录可缺省 identity；缺少此字段本身不使记录失效。它不改变原型号/店名防重复键，也不替代 pendingMessage、结束状态和计时事实。
- `platforms`：本次启用的平台；`skippedPlatforms` 记跳过的平台和原因。每家店的 `platform` 必填。所有执行方式下，这里的每个平台都要有 `run-<平台>.json`，否则默认完整 `merge` 报错；部分草稿合并仅要求指定平台存在可校验文件。
- `reusedFrom`：沿用以前报价的店填原记录的时间，其余为 `null`。
- `status`：已回复、无货、挂牌价、未回复、自动回复。有价格的「已回复」「挂牌价」填进 ERP；无货按型号汇总判断，后两种只进本地记录。多型号店只有全部询问型号都明确无货才记整店「无货」，否则有人工回复就记「已回复」，保留已有报价。
- `noStock`：主文件每条为 `{ itemId, platform, note }`，例如 `{ "itemId": 456, "platform": "淘宝", "note": "淘宝问了 3 家，均明确回复该型号无货" }`；`note` 写清渠道、问了几家、结果或明确无货原因，会作为 ERP 的无货说明。无货说明字段用 `note`，不能写成 `reason`（`reason` 只用于 `incompleteItems`）。只有实际联系店逐项明确无货且跨平台证据完整、没有真实报价或未确认项时才提交无货；新策略不能用没有有效可比报价推导无货，不能以一个平台的无货覆盖另一平台沉默或已有报价。
- `incompleteItems`：因子代理卡住、平台记录损坏，或报价截止时尚未完成挑店/发送的型号，主文件每条为 `{ itemId, platform, reason }`；`itemId` 必须属于本任务，`reason` 非空，截止未完成的写「报价截止，询价未完成」。其作用是防止未完成无价型号伪装无货；全部平台真实完成（含正常截止收尾）时，有效报价仍可提交，无价型号跳过并转人工。平台仍 running/interrupted 时只能保存草稿，不能因为有价格就正式提交。新策略下真实无价且无法确认无货的业务不足也须保留明确原因并转人工；用户主动跳过平台不据此虚构故障，不按原因文字猜测是否未完成。
- `endReason`：信息齐全、追问超时、答复后超时、追问次数用完、店家结束聊天、首次回复超时、仅机器人回复、店家无货、店家提问超出范围、店家重复提问、报价截止。工具不以 endReason 历史文字替代平台完成判断；本轮中断保存为平台 interruption，不借此结束尚未完成店家会话。
- `stopQuestion`：因店家提问停止聊天时填 `{ "type": "问题类型", "text": "店家原话" }`，类型按 [inquiry-rules.md 4.4](inquiry-rules.md#44-答复店家的提问)；其他店为 `null`。`finish` 会把它和 `endReason` 写进询价记录，供 `records.mjs stats` 统计。
- `answeredTopics`：已经答复过店家的话题（如「数量」「型号」「含税要求」「新旧要求」），用来判断店家是否重复提问；没答复过的为空数组。
- `replyAt`：最近一次已确认答复的实际发送时刻（有效 ISO 时间），未答复时可缺省；不随读回、恢复、道谢或更正更新。已确认的 `reply` 意图必须同时有此字段及非空 `answeredTopics`；`check --partial` 也校验，`merge`、`open-run` 和 `finish` 保留此事实。
- `inquiry`：`system` 是 ERP 给的原话术（多个型号时是填好型号的模板），`sent` 是实际发出的话术，`added` 是补充的内容（问候或必要信息项）；原样发送时 `added` 为空数组。
- `thankYou`：发出的道谢原文，没道谢的留空。
- `condition`、`leadTime`：用 ERP 下拉里的文字；没说的货况写「待确认」、货期留空。
- `freeShipping`：店家明确说不包邮时为 `false`，其余为 `true`（不写也按包邮）。`finish` 同时保存每条报价的 `note` 和包邮信息，沿用时保留这些已知信息。
- `stages`：每个业务阶段真正结束时记时间；轮次进展通过 inquiryPlan.round 和实际事件关联，补轮不清除原阶段和店级计时；执行中断不得补写 `repliesDone` 或未完店的 `endedAt`。已有自然结束店的时间保留。
- `platformStates`：`{ "淘宝": "completed", "1688": "interrupted" }`，来自平台合并；`platformInterruptions` 按平台保留中断信息。`stopAfterTask` 为本轮停止批次标记，合并中断只会设 `true`，不自动清除。
- `userStopped`：用户全局停止的布尔标记，可缺省为 false；true 阻止所有新首发和补轮，不能与仅停止批次/正式提交的 stopAfterTask 混用。open-run 不自动清除；保存与显式恢复条件统一见[停止或继续](execution.md#停止或继续)。
- `erpSnapshot`：首次 `task` 返回的完整快照，作为后续 `save.expectedSnapshot`；恢复必须用它对账。成功 verify 后仅按实际写入 itemIds 更新相应型号的基线，未写型号保留原值，见 [ERP 协议](erp-api.md#草稿核对提交一次与再核对)。
- `draftReceipt`：主代理准备草稿写入时，先保存 `{ state:"pending", at, payload:{ taskId, items, skipItemIds }, expectedSnapshot }`；payload 保存完整原输入，不能只留文件路径。`state` 为 `pending`、`unknown`、`failed`、`confirmed` 或 `not_sent`，`at` 为有效 ISO 时间；未知结果记 unknown，已发且确定失败可记 failed，仅 helper 明确返回 `writeAttempted:false` 时可记 not_sent 并保留该字段。pending/unknown/failed 阻止再次生成所有 `erp-items` 输入（含 `--draft`），只能用原 payload 和原 expectedSnapshot 做只读 verify。
- 草稿 confirmed 必须同时保存有效 `verifiedAt`、`verify:{ ok:true, mismatches:[] }`、无重复且覆盖原 payload 实际 items 的 `verifiedItemIds`，以及包含这些型号的同次 GET `snapshot.items`，才允许生成后续输入。save 实际写入 itemIds 可另存，丢回包时不伪造；缺少状态、原 payload/基线或完整核对凭据会被拒绝。尚未准备首次草稿写入时可无 draftReceipt。它不授权平台直接写 ERP，也不能把未核对成功的结果称为已保存。
- `submissionAttempt`：提交前先保存原 payload，再写 `{ state: "pending", at: "ISO 时间" }`；结果未知改 `unknown`，核对通过改 `confirmed`，已发 PUT 后确定失败可记 `failed`；仅 helper 明确 writeAttempted:false 时可记 `{ state: "not_sent", at, writeAttempted: false }`，缺少明确 false 不成立。已发或发送状态未知的尝试阻止重新生成最终输入/重复提交，只用原 payload 做 verify。明确未发时保留原 payload 修复后重试，调用前重新写 pending；不能根据错误名推断未发，没有实际提交动作不能伪造 attempt。
- `submitted`：提交回价并核对通过后为 `true`（见 [erp-api.md「草稿、核对、提交一次与再核对」](erp-api.md#草稿核对提交一次与再核对)），否则为 `false`。
- `humanHelp` / `platformHumanHelp` / `humanHelpHistory`：按[人助记录与解除](#人助记录与解除)保存当前 ERP/平台阻塞与历史事件，不以平台 completed 或删除字段掩盖未决人助。

## 平台记录与合并

`shops[].quotes` 的 `taxIncluded`、`freeShipping` 若提供必须为布尔值，不能写 `null` 或字符串 `"false"` 等非布尔值。省略时分别按 `false`、`true` 处理；`check`、`merge`、`erp-items` 和 `finish` 校验一致，拒绝时不改记录或归档。主记录的 `noStock` 仍为列表，不改为布尔值。

所有执行方式统一由本平台执行者通过平台 scope 的 `checkpoint` 保存 `run-<平台>.json`，主代理串行合并。平台元数据由工具生成并继承，含 `schemaVersion`、`runId`、`skillVersion`、`executionVersion`、独立的 `revision`、`createdAt`、`updatedAt`，不带 `eventSeq`。首次平台保存使用 `expectedRevision:0`；此后重读实际 revision。下面仅示意业务字段，`shops` 的 `"..."` 是省略示意：

```json
{
  "platform": "1688",
  "status": "running",
  "shops": [{ "shop": "店铺或公司全称", "status": "已回复", "...": "同 run.json 的 shops" }],
  "noStock": [],
  "incompleteItems": [],
  "incidents": [],
  "skipped": null,
  "stages": { "shopsPicked": "", "allSent": "" }
}
```

- 平台 `status` 为 `running`、`completed`、`interrupted`。全部已联系店按业务规则真正收尾、且主代理确认无待联系/可补轮目标后才写 completed 和 `stages.repliesDone`；正常截止收尾可带 `incompleteItems`。用户明确跳过写 completed 及 `skipped` 原因，无需伪造回复完成时间。status 缺省时，工具依据 skipped / stages.repliesDone 推断状态；执行者始终显式保存 status。
- 中断写 `status: "interrupted"` 和 `interruption: { reason: "原因" }`，不得有平台 `endedAt` 或 `repliesDone`；保留自然结束店的 `endedAt`，未完店保持原进度。人工失败、超时、取消、执行者卡住和记录损坏都不是用户主动跳过。
- `noStock` 每条 `{ itemId, note }`；`incompleteItems` 每条 `{ itemId, reason }`。`merge` 补上 platform。已确认无货才填前者，故障未完填后者，不能仅凭 skipped 原因推断。
- 人助状态与解除凭据按[人助记录与解除](#人助记录与解除)持续落盘；待决请求先续接而不新建。completed 校验拒绝未核验人助，partial 允许保留 running/interrupted 断点。
- 平台结束前执行 `check "<本次目录>" <平台>`；断点保存执行 `check "<本次目录>" <平台> --partial`。部分校验允许 running/interrupted/未决发送，但不省略业务字段合法性检查。
- 一个平台结果持久化后即通知主代理。主代理 `merge "<本次目录>" --partial <平台...>` 只合并指定快照，保留其他平台已有合并结果；随后 `erp-items "<本次目录>/run.json" --draft` 仅生成已有报价，不推断未完成无货。其余平台继续，所有 ERP 写入由主代理串行完成。
- 默认 `merge "<本次目录>"` 要求全部平台完成或明确跳过；按平台覆盖，不重复追加。空 incompleteItems 清除该平台旧未完标记。合并校验失败不改 run.json；中断合并设置 stopAfterTask。
- 正式 `erp-items` 要求全部平台完成/明确跳过、无本轮 stopAfterTask、无未知发送、无未解除平台/ERP 人助、无已发或发送状态未知的提交尝试。`incompleteItems` 单独存在不禁止提交：正常截止已完成收尾时，缺价跳 skipItemIds，有效报价照常保留。

### 搜索覆盖证据

平台 `searchCoverage` 随 checkpoint 保存，`check`/`merge` 同样校验。开始本轮挑店时保存主计划的 `policy` 为 `inquiryStrategy`，本轮逐明细累计目标直接取 `run.inquiryPlan.targets`，不得由平台改配置扩大。旧 completed 平台含旧 shopsPerItem 的历史快照保留，不重开或运行旧配额算法；未完成平台继续新挑店前先由主代理保存计划，再添加新策略与逐项证据；searchCoverage 中策略是当时快照，执行授权以当前主计划为准，策略更新不能阻断已有回复或抹除证据。既有已发、待核、沿用、结束与超上限事实都保留。

下面示意首轮挑店完成后的字段结构；实际 products 和 shops 须覆盖本轮所有明细，不能用示例中的单条商品代替完整快照。

```json
{
  "searchCoverage": {
    "runId": "工具生成的本次runId",
    "platform": "淘宝",
    "inquiryStrategy": { "initialShopsPerPlatform": 2, "targetComparableQuotes": 3, "maxShopsPerPlatform": 4 },
    "exhaustedItems": [],
    "pickedRound": 1,
    "products": [{
      "productId": "12345",
      "productUrl": "https://item.taobao.com/item.htm?id=12345",
      "skuState": "当前已核SKU型号/规格状态",
      "verifiedAt": "2026-10-19T10:00:00.000Z",
      "eligible": true,
      "merchant": { "idKind": "sellerId", "id": "已核具名sellerId", "name": "已核店铺全称", "sourceUrl": "https://item.taobao.com/item.htm?id=12345", "verifiedAt": "2026-10-19T10:00:00.000Z" },
      "matches": [{ "itemId": 456, "model": "ERP原型号", "quantity": 1, "unit": "台", "description": "ERP原描述", "skuState": "当前已核SKU型号/规格状态", "exactModel": true, "suffix": true, "specifications": true, "verifiedAt": "2026-10-19T10:00:00.000Z" }]
    }]
  }
}
```

- `pickedRound` 是已完成挑店的正整数轮次，不大于当前 `inquiryPlan.round`。补轮收集商品/候选证据时保留旧值，逐步 checkpoint，不删改首次 `stages.shopsPicked` 时刻。只有本轮所有明细已覆盖累计授权目标或有真实 exhaustedItems 依据后，才在同一次平台 checkpoint 原子保存完整 shops 和 `pickedRound=run.inquiryPlan.round`；此后才可准备新 initial 意图。单代理与平台代理相同。
- 完整选店检查只在 pickedRound 等于当前轮时生效，旧 `stages.shopsPicked` 不代表新轮已挑完。为兼容原首轮记录，已有 shopsPicked 且缺 pickedRound 时按 1 读取；新执行明确保存本轮值，不能借兼容省略。原已联系店的回复核验、计时和发送待核事实不因新轮挑店未完而清除。
- `products` 按候选处理顺序保存已实际核验的商品；每个 `productId` 仅一份当前快照。SKU或共享资料改变时替换对应条目、重核受影响 matches，不能追加旧/新状态并存来保留失效覆盖。`eligible:false` 或任一核验标记为 false 不计入新覆盖；搜索候选和 `matchItemIds` 不是核验，不写成合格证据。
- 每个 matches 必须原样绑定本任务 `itemId`、`model`、`quantity`、`unit`、`description`（ERP缺省字段也保持缺省），三项标记和 SKU 状态逐明细核清；相同型号不同 ID/数量不共用一份核验。SKU状态须与商品当前状态一致，需求描述改变亦须重新核规格。
- 商家 ID 当前只支持具名 `sellerId`，不能混用商品 ID、shopId、memberId 或从域名猜 ID；来源按[身份映射](identity-mapping.md)及平台具名证据核验。无可用稳定 ID 时省略 `idKind`/`id`，仅经核实全称唯一后记 `nameUnique:true`。同 ID 已核别名合并为一家；同全称出现多 ID 时禁止名称后备；受现有 ERP/历史店名键限制，本 run 同平台新选店仅保留其中一个身份，后一个候选不计覆盖并补下一店，不按明细分开绕过或改名。已固定的历史冲突保留并待核，不双计，也不允许新首发，未解决不能完成平台。
- 规划出的店使用 `merchantKey` 关联已核身份；所有尚未发送的同商家只保留一行并合并 `itemIds`。旧已发店可从原 `identity.businessIdentity` 或已核唯一具名绑定恢复身份，不为迁就新结构重开商品详情；无法确定身份时保留原记录、标记 `identityUnresolved`、禁首发且不计覆盖，先只读核原绑定。旧店 `sentAt`/待核消息/沿用/结束事实及原 itemIds 均不删除。
- `exhaustedItems` 为 `[{ itemId, reason, checkedAt }]`，只记录真正核完必要候选/链接后的耗尽依据；不得以加载失败或一句“没找到”代替。它不表示无货，也不阻止已联系店的正常回复。
- 工具输出只是平台本轮挑店建议；不填充实际发送时间、库存或报价。新选店保存时补齐原平台记录必填字段，消息仍遵守发送意图/核对协议。本轮 pickedRound 完成后校验完整计划，防同商家拆多条首发或漏 itemId；计划/证据不替代页面对象核对。

## 数据目录

个人配置的继承与修改规则见 [settings.md](settings.md)。

```
<数据目录>
├── .skill-version.json     初始化成功后最后写入的版本标记，生命周期规则见 data-lifecycle.md
├── settings.json           个人配置覆盖，首次保存时创建
├── config.json             ERP 地址
├── contacts.json           当前平台/买家账号内的已核实接收者及多会话映射；首次remember/rebind时创建
├── .records-pending.json   写入未完成时存在，由受控写入口恢复，不手工删除
├── records.jsonl           询价记录（每家店每个型号一行），用于防重复询价和统计
├── processed-tasks.jsonl   提交/跳过/转人工记录；未完真实 run 优先恢复，不重复询问
├── learnings\<平台>.md     本机新发现的页面事实，按平台分文件（见本文「本机经验」）
├── reports\<日期>-<任务编号>.md   每次运行的实跑报告（见本文「实跑报告」）
└── runs\
    ├── timeline-YYYYMMDD.log  每日事件时间线，内容为逐行 JSON（JSONL）
    └── <任务编号>-<时间>\
        ├── run.json            本次询价的完整记录
        ├── run-<平台>.json     所有模式的各平台断点与结果（由主代理合并）
        └── heartbeat-<平台>.jsonl  用子代理时，各平台的打卡记录（watch 据此判断有没有卡住）
```

## 任务汇报

向用户汇报：

   ```
   任务 IQxxxx 已提交回价（N 个型号，K 条报价）。
   （转人工时第一行改为：任务 IQxxxx 需人工处理：<原因>；按实际阶段写草稿已保存 / 未能保存草稿 / 提交动作已执行但核对失败 / 提交结果未确认 / 部分型号已提交，列出差异或未完成报价）
   淘宝：问了 N 家，回复 M 家（最低 ¥x，最高 ¥y）
   1688：问了 N 家，回复 M 家（最低 ¥x，最高 ¥y）
   （跳过的平台写明原因）
   系统推荐：平台 · 店铺X ¥x（需要审核的账号写「已提交，等待采购负责人审核」）
   未回复 / 自动回复：店铺A
   需要注意：价格异常、含税、未说明是否含税、待确认货况、替代型号、发错对象的更正、因店家提问而停止聊天的店（附商品链接）、对不上型号而没填的价格（附店家原话）、卡住或记录损坏的平台
   各阶段耗时：读任务 x 秒，找店 x 秒，询价与跟进 x 分，填报并提交 x 分
   ```

## 实跑报告

每个任务结束（包括中途停下的；按 [erp-api.md「选任务与读取」](erp-api.md#选任务与读取)跳过的任务不写）都写一份，存在本机 `<数据目录>/reports/<YYYY-MM-DD>-<任务编号>.md`（同一天重跑同一任务时在末尾加 `-2`、`-3`）。报告只留在本机，供用户和维护者分析效率、排查问题，不上传、不发给店家或其他人。内容依据 `run.json` 和本次实际经过，按以下几节写，没有内容的节写「无」：

1. **概况**：技能版本、日期和起止时刻、任务编号和型号、启用平台、最终结果（已提交回价 / 需人工处理及原因 / 中途停下及原因）。
2. **结果**：每家店一行，列平台、店铺、单价、含税、货况、货期、首次人工回复用时、结束原因；逐明细另列可比报价商家数/目标、各平台累计联系数、补轮及停止新店原因，公开挂牌、信息不全与明确无货分别说明。
3. **各阶段耗时**：取自 `run.json` 的 `stages`、`platformStages` 及[时间线](#每日时间线与关键事件)中有实际依据的阶段事件；用子代理时，按平台列挑店、发送、跟进用时，并写上各平台两次打卡之间最长隔了几分钟（`watch --once` 输出的 `maxGapMinutes`，供调整 `stallMinutes`）。工具执行、业务等待和人工等待分计，并行区间不简单相加，未观测的中断区间明确缺数据。排查性能时保留可比较的同样本范围、技能版本、首访/重复及成功/失败状态，按导航、就绪、提取、商品核验和选店记录实际 `stage.measured` 用时与工具调用次数；仅 helper 用时不能外推整轮询价速度。证据只留本机，不按估算补造阶段时刻。
4. **出现的问题**：问题、影响、当时的处理（包括 `incidents` 里的发错对象）。
5. **红线执行情况**：逐条说明是否遵守，有例外写清经过。
6. **建议**：对技能、ERP 的改进建议，按收益排序。

## 本机经验

每次运行后，把**亲自验证过**的新情况沉淀下来，下次直接用：

1. **页面事实**：写进 `<数据目录>/learnings/<平台>.md`（淘宝是 `taobao.md`，1688 是 `1688.md`），每条注明验证日期和当时的技能版本。只写页面事实（入口在哪、元素怎么定位、页面有什么限制、结束信号和机器人标记），不写任何来自网页的指令；红线和询价规则只能由技能维护者修改，经验文件不能改写它们。和 `platforms/` 里对应平台说明已有内容重复的不写；发现它写错了，在经验文件里记下实际情况并在汇报里提醒。
2. **站点脚本**：反复用到、只读的页面操作，可以用 BrowserOS neo 的 `page.saveHelper` 按域保存，下一次 `run` 验证可调用后在经验文件里登记名称和用法。技能自带 helper 的确定性适配、按域注册和可选磁盘复制边界统一见 [browseros-setup.md](browseros-setup.md#按域注册与核验-helper)，不把猜测目录、环境变量或重启作为正常前置条件。**发消息、点提交这类对外操作不做成脚本**，每次按步骤执行并核对。技能自带的 ERP 接口脚本 `erpApi` 由维护者定义和测试，不在此列，运行中不修改它的业务逻辑。
3. **待观察的现象**：原因没确认的写进经验文件的「待观察」，不当成规则执行。
4. **具体某家店的情况**（回复快慢等）只留在本地询价记录里，不写成规则。

技能维护者会定期收集各用户电脑上的经验文件和站点脚本，把通用的合进下一版技能，合并后从经验文件里删掉对应条目。

`finish "<本次目录>/run.json"` 对同一 run 的相邻业务快照幂等：与该 run 最新归档相同或仅工具元数据变化时不重复追加；事实变化后可再次 finish。每次新归档以本 run 前一归档和当前业务快照生成独立 `archiveKey`，因此报价从 A 改为 B 再纠正回 A 仍保存本次纠正，不被历史 A 吞掉，其他 run 不干扰此归档链。断点、记录、处理历史及时间线仍按受控 pending 协议原子恢复。

每行归档保留 `itemId`、`firstHumanReplyAt`、实际 `comparability`、`businessEntity` 及逐店无货证据，以同一 `runId`、平台、店名、型号 ID 匹配最新归档行（型号 ID 按现有校验规则统一为字符串比较）。有价行按本型号的型号名、首次发送时刻、状态及报价/税率/货况/货期/包邮/备注比较；无价行另比较店级首次人工回复时刻、回复摘要、结束原因及停止提问。事实未变时沿用原 `time`，实际变化才使用本次时间，`reusedFrom` 始终优先；价格与税率的等价数字表示不算变化，存档原值保留。`recordedAt` 仍记本次归档时刻；店级共享回复更新、另型号补价、另平台进度、ERP 提交、身份/别名核验及己方消息确认不刷新已有型号旧价时间，同文/同价回复缺少本型号新事实时也不猜测刷新。中断写本地记录不表示平台完成、ERP 已保存或已提交，不能绕过正式提交守卫。
