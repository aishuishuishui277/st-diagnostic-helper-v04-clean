# ST Diagnostic Helper v0.4 Clean

一个用于 SillyTavern 的轻量级诊断助手插件，主要面向社区答疑、接口排错和生成链路观察。

它不会读取聊天正文、Prompt 正文、API Key、Headers、Request Body、Response Body 或 Query String。  
插件只记录生成状态、前端事件、HTTP 状态码、安全路径、耗时、提示词结构拆分和用户手动填写的上游域名线索。

## 功能定位

这个插件不是模型增强器，也不是官方调试器。  
它的目标是把 SillyTavern 常见排错信息整理成一份更容易阅读的报告，让答疑者快速判断：

- 这次生成是否真的失败
- 是否只是用户手动停止
- 是否是后台扩展更新失败
- 是否出现 403 / 429 / 500 / 502 / 503 / 524 / NETWORK_ERROR
- 首 chunk 延迟和生成耗时大概是多少
- 前端是否观察到流式 chunk
- 提示词压力主要来自聊天历史、世界书还是预设
- 用户声称使用的上游服务域名是什么

## 主要功能

### 1. 社区简报

一键复制适合发到社区答疑区的精简报告。

社区简报会隐藏：

- Preset 名称
- 角色名
- Chat ID
- 聊天正文
- Prompt 正文
- API Key
- Headers
- Body
- Query String

社区简报会保留：

- 一句话结论
- 建议动作
- 请求目标
- 上游域名线索
- HTTP 状态码
- 生成耗时
- 首 chunk 延迟
- chunk 数量
- 提示词结构拆分
- 隐私说明

### 2. 生成链路诊断

插件会记录最近一次生成的关键状态：

- 是否开始生成
- 是否收到回复
- 是否正常结束
- 是否用户手动停止
- 生成耗时
- 首 chunk 延迟
- 捕获到的 chunk/token 次数

如果用户手动停止，报告会明确标记，不会把不完整回复误判成模型或 API 故障。

### 3. HTTP 状态分类

插件会对前端可见的 HTTP 错误进行分类。

支持常见状态：

- 403 Forbidden
- 429 Too Many Requests
- 500 Server Error
- 502 Bad Gateway
- 503 Service Unavailable
- 524 Cloudflare Timeout
- NETWORK_ERROR

每类错误都会附带简短解释和排查建议。

注意：  
浏览器侧插件通常只能看到 `local:/api/...` 这类前端请求，真实上游地址可能在 SillyTavern 后端配置中，插件不会读取密钥配置或请求正文。

### 4. 上游域名线索

插件支持用户手动填写一个上游域名线索，例如：

```txt
example.com
api.example.com
