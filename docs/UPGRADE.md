# 升级与回滚

先确定仓库 REPO 的绝对路径及要升级的 profile。以下以 default 为例；家人 profile
的运行目录改为 `bridge/profiles/<name>`，服务名改为 wechat-muse-bridge-<name>.service。

停止默认及家人消费者后才能更新共享源码或安装依赖；同时检查是否仍有前台手动启动
的 bridge.js。停止服务会暂时中断微信处理，完成后逐个恢复。

```bash
sudo systemctl stop wechat-muse-bridge.service
# 也停止已安装的家人 profile 服务；确认没有前台消费者。
DIR="$HOME/wechat-muse-bridge/bridge"
BACKUPS="$HOME/wechat-muse-bridge/backups/default"
mkdir -p "$BACKUPS"
chmod 700 "$BACKUPS"
STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$DIR/bridge.js" "$BACKUPS/bridge.js.backup-$STAMP"
```

数据库使用 SQLite 的一致性备份，避免只复制 WAL 模式的主文件。
在已停止消费者、已安装 sqlite3 CLI 的环境执行：

```bash
sqlite3 "$DIR/tasks.db" ".backup '$BACKUPS/tasks.db.backup-$STAMP'"
chmod 600 "$BACKUPS"/*
node --check "$REPO/bridge/bridge.js"
sha256sum "$REPO/bridge/bridge.js"
bash "$REPO/scripts/deploy.sh" default
sha256sum "$DIR/bridge.js"
sudo systemctl start wechat-muse-bridge.service
bash "$REPO/scripts/verify.sh" default "本次新标记"
```

备份路径含单引号时，使用 sqlite3 交互模式正确引用 `.backup` 目标。
部署哈希必须与审核候选一致；启动后确认每个 profile 只有一个消费者，再做微信实收。
不要仅凭主分支 README 中的旧哈希认定新版本已验收。

启动时会为旧数据库增加回执列。文本分段和附件各自保存 pending/实际结果；
重启遇到 running/replied 任务时保留结果，标为 unknown，不自动重发，因为网关去重
尚未验证，无法排除“已发送但回执还未落盘”。需要用户核对后再决定重试。

回滚使用本 profile 的代码备份：

```bash
bash "$REPO/scripts/rollback.sh" default
# 或指定同一 profile 备份目录内的文件：
bash "$REPO/scripts/rollback.sh" default "$BACKUPS/bridge.js.backup-$STAMP"
```

回滚先验证暂存代码，再停止服务、替换、启动；越界路径和损坏代码会被拒绝。
这只回滚 bridge.js，不会恢复数据库或微信登录态。若候选同时修改 SDK 或依赖，应恢复
对应已审核版本并重新构建；恢复数据库前必须停止消费者，并评估覆盖新任务的影响。
