# 参与贡献

感谢帮助改进部署、文档及桥接稳定性。提交前请阅读 [LICENSE](LICENSE)、
[NOTICE](NOTICE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)，确认有权提供相应材料。
项目自有材料的贡献沿用 PolyForm Noncommercial 1.0.0；内置 SDK 部分沿用 MIT。

## 报告问题

普通问题使用公开仓库的 Issues，说明预期结果、实际结果、复现步骤、Node 版本及部署方式。
只附脱敏的错误信息。不要提供 cookie、微信登录态、配置原文件、数据库、真实附件或私人聊天。
疑似安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告。

## 提交修改

围绕一个问题创建分支和 Pull Request，说明触发条件、修改后的行为及验证结果。
保留现有运行目录和配置兼容性；不要把自己环境中的账号、路径或代理凭据写成默认值。
修改 SDK 时保留其 MIT 文件及作者声明，并说明这是本地修改。

在 `bridge/` 执行：

```bash
npm ci
npm run build
npm test
```

运行行为发生变化时，按 [验收方法](docs/ACCEPTANCE.md) 补充对应手机实测。
只有自动化结果时明确写“代码验证”，不要写成微信实收通过。
文档修改检查链接、示例命令与真实脚本一致即可。
