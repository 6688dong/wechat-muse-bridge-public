# 微信 × Muse 桥接

把微信消息和附件交给 Muse 处理，再把回复与生成的文件发回微信。
适合在自己的 Linux 环境部署，也支持家人共用 Muse 服务、分别绑定微信。

**源码公开，采用 [PolyForm Noncommercial 1.0.0](LICENSE) 非商业许可。**
允许许可范围内的个人及其他非商业用途；商业用途需要另行获得授权。
这不是 OSI 定义的开源许可。内置 SDK 单独保留 MIT，详见 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 能做什么

| 功能 | 在微信中使用 |
| --- | --- |
| 与 Muse 对话 | 直接发文字、图片或附件，收到处理结果 |
| 生成和返回文件 | “生成一个只写着测试的小 txt 文件发给我” |
| 找回资料 | “最近文件”“找文件 报告”“再发文件 1” |
| 提醒和待办 | “提醒我1分钟后 喝水”“待办 买牛奶”“待办列表” |
| 长任务进度 | 较长任务自动提示进度；“重试最近失败任务”用于明确失败的普通任务 |
| 个人偏好 | “偏好 简短”“偏好 列表”“偏好查看” |
| 家人连接 | 每个微信单独扫码，分别保存 Muse 对话、数据库和附件 |

微信正文呈现结果和附件，不显示服务器文件路径。完整命令及限制见 [日常工具](docs/DAILY_TOOLS.md)。

## 开始使用

需要 **Linux、Node.js ≥ 22.13、npm 和已登录的 muse-cli**。
Muse 访问权限和微信扫码入口需由部署环境提供；本仓库不附带账号或登录凭据。
ffmpeg、LibreOffice 和 faster-whisper 为按需安装的外部工具。

```bash
git clone https://github.com/6688dong/wechat-muse-bridge-public.git
cd wechat-muse-bridge-public
export REPO="$(pwd)"
bash scripts/deploy.sh default
```

然后按 [安装指南](docs/DEPLOY.md) 填写运行配置、创建独立 Muse 对话、扫码绑定微信、
安装服务，并从手机完成实际收发测试。部署脚本默认使用 `$HOME/wechat-muse-bridge/bridge`
作为运行目录；已有部署请先阅读 [升级与回滚](docs/UPGRADE.md)。

## 使用与维护文档

| 你要做什么 | 阅读入口 |
| --- | --- |
| 首次安装、语音工具配置 | [安装指南](docs/DEPLOY.md) |
| 绑定家人的微信 | [多账号配置](docs/MULTI_ACCOUNT.md) |
| 提醒、待办、资料找回、偏好 | [日常工具](docs/DAILY_TOOLS.md) |
| 微信无回复、文件未送达、提醒未到 | [常见问题](docs/FAQ.md) |
| 更新代码、备份及回滚 | [升级与回滚](docs/UPGRADE.md) |
| 核对手机实际收到的内容 | [验收方法](docs/ACCEPTANCE.md) · [公开验收摘要](FINAL-REPORT.md) |
| 交给支持 skill 的助手运维 | [运维 skill](skills/wechat-muse-bridge/SKILL.md)，需配合完整仓库 |
| 参与修改、报告问题 | [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md) |

## 当前验证范围

两套独立部署已确认微信文件实收；其中一套还完成了设置提醒和到时提醒的实收测试。
Excel、Word、文本 PDF、PPTX、扫描 PDF 和视频画面已有样本验证，不能代表任意文件都能正确处理。
视频清晰人声的微信端到端验收仍待完成。资料找回、待办、进度和偏好主要由自动化检查覆盖。
详细范围见 [公开验收摘要](FINAL-REPORT.md)。

家人连接分开保存数据，但**共用 Muse 账号的权限和费用**。目录分离不构成 Muse 账户权限隔离。
提醒按北京时间解析；主动发送依赖微信可用上下文，过期时可能需要本人发一条新消息。

## 开发验证

```bash
cd bridge
npm ci
npm run build
npm test
```

`bridge/bridge.js` 为桥接入口；`bridge/vendor/` 为内置 SDK；`scripts/` 为部署与运维工具；
`tests/` 为回归检查。构建产物及依赖在部署时生成，不提交到仓库。

配置、cookie、微信登录态、数据库、附件、聊天日志和运行备份只保留在部署环境。
提交问题前请脱敏，详见 [安全说明](SECURITY.md)。版本变化见 [更新记录](CHANGELOG.md)。

本项目是独立桥接工具；微信、Muse 及 SDK 作者没有为本项目提供官方背书。
