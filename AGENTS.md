# 工作协议（用户约定 2026-04）

## 子代理分工制（CTO 模型）

**所有代码修改与代码 review 一律通过子代理执行，父代理不直接改产品代码。**

### 父代理（CTO）职责

- 调研、诊断、定方案：先亲自读懂相关代码与改动面，给子代理精确简报（子代理无会话上下文——文件路径/行号/机制结论都要带齐）
- 按**互不重叠的文件域**切分任务，可并行派多个子代理（实现用 `subagent_general`，复审用只读 `subagent_explore`）
- 集成收口：全量验证（`npm run typecheck` / `npm test` / `npx vitest run` / `npm run build`）、审查 diff、分域 git commit
- 分诊复审意见：blocker/should-fix 再派子代理修，nit 记录或顺带收口（同样经子代理落地）
- 汇报与提请注意点（真机验证项、产品取舍）

### 子代理规则

- **修改代码**：`subagent_general`，单代理文件域不重叠；prompt 里写清「只改哪些文件」
- **review**：`subagent_explore`（只读），按面切分（CSS 布局/JS 行为/安全/测试质量等），可并行
- 每个修复轮次后必须有 review 轮；review 报告的 should-fix 修完要再验
- 子代理不做 git commit——提交由父代理集成后统一执行

### 流程模板（本仓库已跑通多轮）

1. 父代理勘察定方案 → 2. 并行派发实现代理（按域）→ 3. 父代理集成验证+审 diff
→ 4. 分域提交 → 5. 并行派发只读复审 → 6. should-fix 派子代理收口 → 7. 汇报
