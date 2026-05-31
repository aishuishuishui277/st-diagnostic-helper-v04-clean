
ST Diagnostic Helper v0.4.2

SillyTavern 本地生成链路诊断插件。

A lightweight diagnostic helper for SillyTavern generation troubleshooting.

---

项目简介 | Overview

ST Diagnostic Helper 用于帮助用户分析生成链路状态、流式响应情况、手动停止行为以及常见 HTTP 错误。

本插件不会自动修复问题，也不会修改模型配置。

它的目标是将：

"不能生成"
"卡住了"
"回复不完整"

转换为可读、可共享、可排查的诊断报告。

ST Diagnostic Helper helps users analyze generation status, streaming behavior, manual stops, and common HTTP errors.

It does not automatically fix problems.

Its purpose is to turn vague issues into structured diagnostic reports.

---

功能说明 | Features

1. 生成链路诊断

Generation Chain Diagnostics

记录生成开始、首 chunk、回复接收、生成结束等关键事件。

Tracks generation start, first chunk arrival, message reception, and generation completion.

---

2. 手动停止识别

Manual Stop Detection

能够识别用户主动点击停止按钮。

Can detect when the user manually stops generation.

避免把用户主动停止误判为模型故障。

Prevents manual interruptions from being mistaken for model failures.

---

3. 首 Chunk 延迟统计

First Chunk Latency

记录从发送请求到收到首个流式 chunk 的耗时。

Measures the delay between request submission and the first streamed chunk.

用于分析：

- 网络延迟
- 上游响应速度
- 模型首包速度

Useful for evaluating:

- Network latency
- Backend responsiveness
- Model first-token speed

---

4. 流式 Chunk 统计

Stream Chunk Counter

统计本次生成期间捕获到的 chunk 数量。

Counts observed streamed chunks during generation.

用于判断：

- 是否真正流式
- 是否假流式
- 是否存在中断

Useful for identifying:

- True streaming
- Simulated streaming
- Interrupted streams

---

5. HTTP 错误分类

HTTP Error Classification

仅记录：

- 状态码
- 请求方法
- 安全路径
- 耗时

Records only:

- Status code
- HTTP method
- Safe path
- Duration

不会记录：

- Prompt
- Body
- Headers
- API Key
- Query String

Does NOT record:

- Prompt
- Body
- Headers
- API Keys
- Query Strings

---

6. 常见错误解释

Built-in Error Explanations

支持解释：

- NETWORK_ERROR
- 403 Forbidden
- 429 Too Many Requests
- 500 Internal Error
- 502 Bad Gateway
- 503 Service Unavailable
- 504 Gateway Timeout
- 524 Cloudflare Timeout

Provides human-readable explanations and troubleshooting suggestions.

---

7. 后台扩展错误降噪

Background Extension Error Filtering

自动区分：

- 生成相关错误
- 后台扩展错误

Automatically separates:

- Generation-related failures
- Background extension failures

例如：

/api/extensions/version

不会被误判为模型生成失败。

Background extension update checks will not be treated as generation failures.

---

8. 社区版报告

Community Report

自动隐藏：

- Preset
- Character
- Chat ID

Generates privacy-safe reports suitable for sharing with communities.

---

9. 本地完整报告

Full Local Report

保留完整本地信息。

Shows full local diagnostic information for personal troubleshooting.

---

隐私说明 | Privacy

本插件不会记录：

- 聊天正文
- Prompt
- API Key
- Headers
- Body
- Query String

This plugin does NOT record:

- Chat contents
- Prompts
- API keys
- Headers
- Request bodies
- Query strings

---

适用场景 | Intended Use

适用于：

- 公益站排错
- API 调试
- 反代排错
- 流式响应测试
- 社区问题反馈

Suitable for:

- API troubleshooting
- Reverse proxy diagnostics
- Streaming analysis
- Community bug reports

---

不适用场景 | Not Intended For

不适用于：

- 自动修复问题
- 性能压测
- Prompt 调试
- 模型质量评测

Not intended for:

- Automatic fixes
- Benchmarking
- Prompt debugging
- Model evaluation

---

License

MIT License
