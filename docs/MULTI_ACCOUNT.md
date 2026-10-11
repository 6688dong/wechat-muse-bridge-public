# 家人使用同一个 Muse 服务

每位家人使用独立微信扫码、独立 profile、独立 Muse 对话，附件目录和数据库也分别保存。
默认连接保留在 `$HOME/wechat-muse-bridge/bridge`；家人连接位于
`$HOME/wechat-muse-bridge/bridge/profiles/<name>`。

先按 [UPGRADE.md](UPGRADE.md) 停止当前消费者，再从完整仓库根目录创建：

```bash
bash scripts/add-account.sh family
```

名称只能包含字母、数字、下划线和短横线，最多 32 个字符，不能使用 default。
脚本拒绝已有目录，并准备该 profile 自己的依赖。安装期间不改写默认微信凭据。

1. 使用同一个 Muse 登录创建一个新的对话：`muse-cli session-start`。
2. 编辑家人目录的 config.json：填写该对话的 weixin_session_id 和 muse_cli_path。
3. 执行 `node "$REPO/scripts/qr-login.mjs" --profile family`，让家人自己的微信扫码。
4. 将扫码结果的 userId 填入此 profile 的 ilink_user_id。
5. 从服务模板创建 wechat-muse-bridge-family.service，修改运行目录和 Node 路径，
   保持同一服务用户和 HOME。启动家人服务，并恢复默认服务。
6. 两个微信分别发送不同标记，检查回复和附件只出现在各自对话、数据库及目录中。

每个 profile 的 state、tasks.db、media、logs 和进程锁独立；不能共用同一个 Muse
对话编号，也不能复制默认连接的微信 state 来冒充家人绑定。

这种配置共享 Muse 账户、权限和费用，对话及文件目录的分离不构成账户权限隔离。
更换共享 muse-cli cookie 会影响所有 profile。若需要独立 Muse 账户，使用不同
服务用户/HOME 或独立凭据配置，并重新检查路由。

完整的微信实收和附件目录验收见 [ACCEPTANCE.md](ACCEPTANCE.md)。
