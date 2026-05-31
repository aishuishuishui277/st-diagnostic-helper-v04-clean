# ST Diagnostic Helper v0.4 Clean

SillyTavern 本地诊断插件，用于社区排错报告生成。

## 功能

- 生成链路诊断
- 手动停止识别
- 首 chunk 延迟统计
- HTTP 错误分类
- 后台扩展更新错误降噪
- 社区版脱敏报告
- Prompt Token Lens / Prompt Breakdown Lens

## 隐私

插件不记录聊天正文、prompt 正文、API key、headers、request body、response body、query string。

## 注意

Prompt Token Lens 只读取 SillyTavern 可访问的内部统计信息，不保证等于提示词查看器顶部总 token。
如果显示 unknown，请先完成一次正常生成后再刷新诊断。
不要和旧版诊断插件同时启用。
## 提示词数量诊断 / Prompt Token Lens

本插件提供一个轻量级的提示词结构诊断功能，用于辅助判断当前会话的上下文压力来源。

它会尽量读取 SillyTavern 内部可访问的 Prompt Itemization / 提示词结构统计，并在诊断面板和社区报告中显示：

- Internal Itemized Total Tokens：插件读取到的内部结构化 token 总量
- Chat History Tokens：聊天历史占用
- WorldInfo Tokens：世界书 / 外部上下文占用
- System / Preset Tokens：系统提示词 / 预设占用
- Character Definition Tokens：角色定义占用
- Example Messages Tokens：示例消息占用
- Anchor / Injection Tokens：锚点 / 注入项参考值
- Last User Message Tokens：最近用户消息占用
- Last Assistant Message Tokens：最近助手回复占用

### 注意

Prompt Token Lens 不是 SillyTavern 官方提示词查看器的替代品。

它的定位是“排错辅助”和“结构拆分”，用于快速判断：

- 是聊天历史太长
- 还是世界书占用过高
- 还是预设 / 系统提示词较重
- 还是最近一轮回复过长

插件不会记录或导出 prompt 正文，只显示 token / 字符数量等统计信息。

如果显示 `unknown` 或 `(not available)`，通常表示当前页面还没有生成可读取的 Prompt Itemization 数据。建议先完成一次正常生成，再刷新诊断面板或重新复制报告。

### 隐私说明

Prompt Token Lens 不记录：

- 聊天正文
- prompt 正文
- 世界书正文
- 角色卡正文
- API key
- headers
- request body
- response body
- query string

它只输出 token 数量和结构分类。
