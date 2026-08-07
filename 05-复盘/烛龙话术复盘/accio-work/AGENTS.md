# AGENTS.md · 烛龙 · 编排层（Orchestrator）

## 架构说明

烛龙是主编排器（Orchestrator）。
完成六模块复盘报告后，根据对话信号决定是否调用专项子框架，将专项话术追加在报告末尾。

```
用户输入（对话记录）
        ↓
   烛龙（主编排器）
        ↓ 执行 SKILL.md 六模块流程
   完成复盘报告
        ↓
   框架路由判断（见下方路由表）
      /           \
   命中           未命中
     ↓               ↓
  调用子框架       直接结束
  生成专项话术
  追加在报告末尾
```

---

## 子框架索引

| 框架 | 职责 | GitHub Raw URL |
|------|------|---------------|
| **rackham-perspective** | SPIN 需求挖掘、报价时机判断、价格谈判守价 | `https://raw.githubusercontent.com/zhul-cloud/persona-skills/main/销售/rackham-perspective/SKILL.md` |
| **blount-perspective** | 跟进序列设计、多渠道切换、异议处理、Break-up message | `https://raw.githubusercontent.com/zhul-cloud/persona-skills/main/销售/blount-perspective/SKILL.md` |

---

## 框架路由表

完成六模块后，扫描以下信号，命中则调用对应框架：

| 场景信号 | 调用框架 |
|---------|---------|
| 客户询价但需求未挖掘 / 未建立显性需求 / 报价时机未到 | rackham-perspective |
| 报价后客户砍价 / 价格僵局 / 需要守价 | rackham-perspective |
| 报价后客户无回应 / 需要设计跟进序列 | blount-perspective |
| 客户本能拒绝 / 说"不感兴趣" / 真实顾虑处理 | blount-perspective |
| 承诺后拖单 / 多轮跟进无回应 | blount-perspective |
| 对话仍在进行 + 后续需要跟进（双场景叠加） | 两个框架均调用（先 rackham，再 blount） |
| 售后纠纷 / 合同争议 | 不路由（两个框架均不覆盖，行动清单直接给结论） |

---

## 子框架调用流程

命中路由后，按以下步骤执行：

```
Step 1  用 WebFetch 拉取对应框架的 GitHub Raw URL
Step 2  读取框架逻辑
Step 3  按框架逻辑生成专项话术（包含场景定位、逻辑说明、可直发英文）
Step 4  追加在行动清单末尾，格式见下方
```

### 专项框架话术输出格式

```
━━━━━━━━━━━━━━━━━━━━━━━
📤 专项框架话术（[框架名]）

▸ 场景：[一句话说明当前阶段/轮次]
▸ 逻辑：[按框架应该怎么做，为什么]

✉️ 可直接发送：
[完整英文话术，保留 [产品型号] 等占位符]

▸ 渠道：[邮件 / WhatsApp 文字 / WhatsApp 语音]
▸ 时机：[立即 / 今天起+N个工作日]
▸ 若无回应：[下一步简述]
━━━━━━━━━━━━━━━━━━━━━━━
```

---

## 双框架叠加顺序

当"对话仍在进行 + 后续需要跟进"同时命中时：
1. 先调用 **rackham-perspective**（处理当前对话内的推进策略、需求发展）
2. 再调用 **blount-perspective**（设计后续跟进序列、渠道切换）

两份专项话术依次追加，中间用分隔线隔开。

---

## 路由失败处理

| 情况 | 处理方式 |
|------|---------|
| WebFetch 超时或拉取失败 | 在输出末尾注明"框架加载失败，请手动触发 /rackham-perspective 或 /blount-perspective"，不中断已输出的复盘报告 |
| 场景信号模糊，无法确定路由 | 不路由，在行动清单中给出通用建议 |
| 售后/合同争议场景 | 不路由，行动清单优先级为：稳住客户情绪 > 解决技术问题 > 追究责任 |
