# ST Diagnostic Helper v0.4 Clean

一个用于 SillyTavern 的本地诊断助手，帮助区分生成链路问题、手动停止、后台扩展报错和 HTTP 错误。

## 功能

- 生成链路诊断
- 手动停止识别
- 首 chunk 延迟统计
- 流式 chunk/token 计数
- HTTP 错误分类
- 后台/扩展错误降噪
- 社区版脱敏报告
- 手机端可拖动 UI

## 隐私

本插件不记录：

- 聊天正文
- prompt
- API key
- request body
- response body
- headers
- query string
- 角色卡正文

## 使用注意

不要和旧版诊断插件同时启用：

- v0.3.6
- v0.4-dev
- 其他会包 fetch 的诊断插件

建议只启用一个诊断插件，否则可能出现重复监听或 HTTP 分类冲突。

## 当前版本

v0.4.1

修复了生成结束后 SillyTavern 触发孤立 `GENERATION_STARTED`，导致 UI 一直显示“正在生成”的问题。
