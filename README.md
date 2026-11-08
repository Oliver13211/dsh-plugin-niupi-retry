# 牛皮藓无限重试 (niupi-retry)

`@oliver13211/dsh-plugin-niupi-retry` — 模型请求失败后**无限重试**：不管错误码是什么
（鉴权失败、限流、超时、无效请求……），一直重试，直到成功、你手动停止会话，
或在设置里临时关闭。

## 安装

- **npm**：在 DeepSeek Harness 的插件管理器（或 `plugin_manager` 工具）里安装
  `@oliver13211/dsh-plugin-niupi-retry`；
- **源码**：克隆本仓库后，`plugin_manager install_bundle` 指向仓库目录即可
  （本地目录以链接方式安装，改动即时生效）；
- **git**：`install_bundle` 传入 `git+https://github.com/Oliver13211/dsh-plugin-niupi-retry.git`。

行 id 为 `niupi-retry`，设置命名空间与之一致；升级、换名不影响已保存的配置。

## 行为

两层覆盖，适用于任何模型调用：

1. **agent 循环步骤**（主对话、子代理、workflow 的全部模型调用）
   挂在 `agent/request-error` 瀑布上：失败后按配置的间隔等待，然后返回
   `{ kind: 'retry' }`，agent 循环会在同一个打开的 turn 里重跑该步（durable，
   与内置 `@deepseek-ai/dsh-llm-retry` 同一扩展点）。
2. **辅助模型调用**（带 `purpose` 的直接 `ctx.llm.stream()`：session 标题、
   压缩摘要、web 检索等）挂在 `llm/stream` 瀑布上：只重放"一个 chunk 都还没
   输出"的失败，避免给消费者重复投递内容。

与内置 `@deepseek-ai/dsh-llm-retry` 的组合：它先按供应商策略处理瞬态错误
（限流/超时等前几次）；策略耗尽或错误码不在其白名单时委托到本插件，无限接管。
重试决策同时写一条 `llm/retry` 词汇事件（复用内置类型，独立 policyKey，
不影响内置计数），会话里会出现"模型重试"行。

## 设置（侧边栏 → 设置 → 无限重试）

- **启用无限重试**：临时开关，volatile 字段即时生效，无需重启。
- **间隔方式**：固定间隔（默认 1000ms）/ 递增间隔（第 N 次等待 N × 基础间隔，
  受上限约束）/ 不间隔（失败后立即重试）。
- **不应用的供应商**：勾选活跃与可配置目录里的供应商，或手动添加
  （支持 `deepseek-*` 前缀通配）；排除的供应商按默认策略结束。
- **覆盖辅助模型调用**：开关第 2 层。

## 持久化

所有配置字段都是 `.volatile()`，通过 settings 命名空间（ns = 行 id
`niupi-retry`）写入，经 configEditor 落到 profile 的 `cordis.patch.yml`，
升级、重启后仍然生效；也可以直接手编该行的 config。

## 结构

- `index.js` — Host 半：重试引擎（两层瀑布监听）+ Config schema。
- `client.js` — Web 半：`settings.section` 设置页（手写控件 + 主题 token）。
- `vendor/` — 内嵌 `@deepseek-ai/schemastery` + `@deepseek-ai/cosmokit`
  （MIT，版本与应用一致 3.19.0 / 1.9.0）。工作区链接的 bundle 无法解析
  app 树内的包，这里内嵌一份以声明 volatile 配置字段。

## License

MIT — 见 [LICENSE](LICENSE)。`vendor/` 内的第三方包沿用其原许可（MIT）。

