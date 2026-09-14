---
name: alibaba-publish
description: 阿里国际站每日自动发品（工作流F）——只负责选品、定价、打包素材、登记队列、回收结果回写，不重新实现发品本身；实际发品动作由 Accio Work 内已装的官方 skill `alibaba-product-publish` 执行，两边通过磁盘 outbox/ 目录传递信号。触发词：跑一次阿里发品、阿里国际站发品、阿里发品队列、回收阿里发品结果。对应文档：schema/products-schema.md"工作流F：阿里国际站每日自动发品"（两者需保持一致）。
---

# 阿里国际站每日自动发品（工作流 F）

**系统边界**：本 skill 只做①结果回收 ②选品 ③定价 ④素材打包 ⑤登记队列——即"把素材备好、放进 outbox/queue/"。真正调用阿里开放接口发品的动作在另一个进程（Accio Work）里，由它已经装好的官方 skill `alibaba-product-publish` 完成，本 skill 不实现、也不能验证那部分是否成功——只能等 Accio 把结果写回 `outbox/alibaba-publish/done|failed/` 后，在下一轮①结果回收里读到。

**触发时机**：每日定时（`schedule`/`loop` skill 配置）或用户手动说"跑一次阿里发品"。**当前阶段（2026-09-14 起）：先手动单个型号试跑验证 Accio 侧真的吃得下这套 queue 格式，跑通并确认 `result.json` 正确回写之前，不要配置成每日定时。**

---

## 核心原则

1. **不生成新文案**——标题/长描述 100% 复用 `wiki/marketing/.../营销素材包/01-营销内容/[Model].md` 的 SEO Title/Meta/长描述，避免同一型号文案在两处漂移。
2. **图片素材优先级与独立站发布（工作流G）对齐**（2026-09-14 统一）：① 有实拍图（`raw/products/.../photos/` + `nameplate/`）优先用实拍图全部；② 无实拍图（Tier1，`photos: false`）兜底用 `营销素材包/02-营销图片/LinkedIn/[Model].png`（渲染好的营销卡片，合法素材，不是占位图）；③ 连兜底卡片都没有（说明工作流C还没跑完）→ 不打包，型号退回 `not_ready`。
3. **价格/规格不确定一律留空，不编造**——沿用全局"禁用词原则"，`procurement_cost_cny` 是唯一定价输入，缺失则跳过该型号，不臆测成本。
4. **`publishType` 当前固定为 `draft`**——先发草稿，观察一批质量分和详情页效果后再考虑切正式（`product`），这是业务决策不是技术开关，不要自作主张改。
5. **`alibaba_status: failed` 不自动重试**——必须人工确认问题已解决、手动把该型号 frontmatter 改回 `not_ready`，才会在下一轮选品里被重新选中。
6. **跨进程边界要保守**——outbox/ 是我们唯一能控制、也是唯一的调试入口。素材打包/队列格式的任何调整都必须同步更新 `meta.json`/`listing.md` 的约定字段，并同步反映到 `result.json` 的期望格式里，避免两边契约漂移到不可诊断的地步。

---

## 执行步骤

### 0. 结果回收（先做这步，处理上一轮遗留）

扫描 `outbox/alibaba-publish/done/` 与 `outbox/alibaba-publish/failed/`，每个子目录读取其中的 `result.json`：

- **成功**（含 `productId`）→
  - 型号页面 frontmatter：`alibaba_status: draft`、`alibaba_product_id`、`alibaba_url`（`alibaba_queued_date` 已有则不变）
  - 型号页面「阿里国际站发品」章节表格同步更新（发品状态/商品ID/链接/发布日期等）
  - `wiki/marketing/.../营销素材包/00-营销计划/plan.md` 分发矩阵「阿里国际站」行状态同步
  - `quality.lowScore: true` 时，把 `deductReasons` 记入型号页面备注，供人工复核
- **失败** →
  - `alibaba_status: failed`
  - 把 `errorCode`/`error` 摘要记入型号页面「阿里国际站发品」章节
  - 追加到 `wiki/products/_alibaba_needs_attention.md`（待人工处理清单，不静默丢弃；文件不存在则新建，格式：`| 型号 | 品牌 | 失败原因 | 发现日期 |` 表格）
- 处理完的子目录移动到 `outbox/alibaba-publish/archive/[日期]/`，避免下次重复回收
- 追加 log 条目：`## [YYYY-MM-DD] alibaba-sync | [ModelNumber] 状态回写（draft/failed）`

若 `outbox/alibaba-publish/done/` 和 `failed/` 都不存在或为空，跳过本步，直接进入①。

### 1. 选品

读取 `wiki/products/index.md` + 各型号 frontmatter，候选条件（**全部满足**才入选）：

- 营销内容已生成（`wiki/marketing/.../营销素材包/01-营销内容/[Model].md` 存在，SEO Title/Meta/长描述非空）
- 规格参数无 `[待确认]`（只看"规格参数"章节，忽略模板本身的提示文字"不确定的标注 `[待确认]`"这一行，那不是待确认项）
- `alibaba_status` 为空或 `not_ready`（`queued`/`draft`/`published`/`failed` 不重复处理；`failed` 要先人工改回 `not_ready`）
- `procurement_cost_cny` 非空（没有成本数据 → 跳过，记入 `_alibaba_needs_attention.md` 提示"缺定价数据"，不阻塞其他型号）
- 不设固定数量上限，当天满足条件的全部入选

### 2. 定价（仅对入选型号、`alibaba_price_cny` 为空时）

- `alibaba_price_cny = procurement_cost_cny × 1.5`（四舍五入到分）
- `alibaba_moq` 为空则给默认值 1
- 写回型号页面 frontmatter 与「阿里国际站发品」章节表格

### 3. 素材打包

为每个入选型号在 `outbox/alibaba-publish/queue/` 下创建子目录 `[YYYY-MM-DD]_[Brand]_[ModelNumber]/`：

```
[YYYY-MM-DD]_[Brand]_[ModelNumber]/
├── images/          ← 见上方核心原则2的优先级（实拍图 / LinkedIn卡片兜底 / 都无则不打包）
├── listing.md       ← 单文件汇总：标题(SEO Title)、长描述(SEO产品长描述)、规格参数表、
│                        价格(alibaba_price_cny)、MOQ、物流信息(重量/尺寸/包装，缺失则留空不编造)、
│                        海关信息(HS编码/认证)
└── meta.json        ← { "model", "brand", "category", "wikiPagePath", "decorationPlan": "standard",
                          "publishType": "draft" }
```

`decorationPlan` 固定 `standard`（经济简装版），`publishType` 固定 `draft`。若某型号连兜底图都凑不出，不创建该子目录，型号 frontmatter 保持/退回 `not_ready` 并记入待处理清单。

### 4. 登记队列

- 型号页面 frontmatter：`alibaba_status: queued`，`alibaba_queued_date` 填当天日期
- 型号页面「阿里国际站发品」章节（不存在则按下方模板新建）填入素材包路径
- 更新 `wiki/products/index.md`（如有该型号的发品状态列）
- 追加 log 条目：`## [YYYY-MM-DD] alibaba-queue | [ModelNumber] 已打包入队`

**「阿里国际站发品」章节模板**（插入型号页面「营销内容」章节之后）：

```markdown
## 阿里国际站发品

> 本章节由工作流 F（阿里国际站每日自动发品）维护，人工除排障外不直接改动。

| 字段 | 内容 |
|------|------|
| 发品状态 | ⚪ 未就绪 / 🔵 已入队 / 🟡 草稿待审 / 🟢 已正式上架 / 🔴 发品失败 |
| 挂牌价（¥）| |
| MOQ | |
| 商品 ID | |
| 链接 | |
| 入队日期 | |
| 发布/转正式日期 | |
| 素材包路径 | |
```

---

## Accio 侧（不在本仓库实现，供参考）

需要在 Accio Work 里配置一个 automation，扫描 `outbox/alibaba-publish/queue/` 下的新子目录，读 `meta.json` 后调用 `alibaba-product-publish` skill 的素材包发品链路，完成后把结果写成 `result.json` 放回该子目录，再把整个子目录移动到 `done/`（失败则 `failed/`）。`result.json` 约定格式：

```json
{
  "model": "SZR-LY4-N1-AC220V",
  "success": true,
  "productId": "1234567890",
  "publishType": "draft",
  "url": "https://post.alibaba.com/product/publish.htm?itemId=1234567890&pubAction=draft",
  "quality": { "finalScore": 82, "lowScore": true, "deductReasons": ["主图数量不足"] },
  "errorCode": null,
  "error": null
}
```

这一半是 Accio 端的编排，本 skill 不负责触发或验证，只保证读写的目录结构和字段与此约定一致。**当前阶段用户需要手动确认/触发 Accio 侧读取了 queue/ 里的测试型号**——本 skill 打包完队列后应明确告知用户"素材已就绪，需要去 Accio Work 那边确认/触发一次发品"，不要假设它会自动被处理。
