# 安装一个微信连接

需要 Linux、Node.js 22.13 或更高版本、npm，以及已登录的 muse-cli。
语音、视频和 Office 处理还需要 ffmpeg/ffprobe、faster-whisper、LibreOffice；
安装了工具不等于对应格式已通过微信实测。

从仓库根目录执行，以下命令假设已设置 `REPO` 为完整仓库的绝对路径：

```bash
cd "$REPO"
bash scripts/deploy.sh default
```

默认运行目录固定为 `$HOME/wechat-muse-bridge/bridge`。安装脚本保留已有
config.json 和登录态；升级已有连接时先按 [UPGRADE.md](UPGRADE.md) 停止消费者。

编辑运行目录的 config.json：muse_cli_path 填实际程序绝对路径；
weixin_session_id 填 `muse-cli session-start` 创建的新对话编号，不能与其他
profile 共用。muse-cli 使用当前服务用户的 Muse 登录信息；不要把 cookie 发到聊天或仓库。

首次扫码使用专用脚本：

```bash
node "$REPO/scripts/qr-login.mjs" --profile default
```

用准备使用此连接的微信扫码，按脚本结果填写 ilink_user_id。扫码者就是绑定用户，
在微信的 ClawBot 对话中测试即可，不需要准备另一个“bot 微信”。凭据保存在此
profile 的 state/weixin/。已有绑定不能被其他扫码者静默覆盖。

编辑仓库中的 wechat-muse-bridge.service，填写实际 User、HOME、Node 路径和
运行目录。代理只在环境确实需要时配置，模板不指定代理地址。

```bash
sudo cp "$REPO/wechat-muse-bridge.service" /etc/systemd/system/wechat-muse-bridge.service
sudo systemctl daemon-reload
sudo systemctl enable --now wechat-muse-bridge.service
systemctl is-active wechat-muse-bridge.service
bash "$REPO/scripts/verify.sh" default "本次唯一测试标记"
```

每个 profile 只能有一个消费者。服务活跃、预热成功、数据库 sent 都不足以证明
用户收到消息；按照 [ACCEPTANCE.md](ACCEPTANCE.md) 完成微信实际收发。

config.json、登录态、数据库、附件和日志只留在运行环境中。

## 换一个 Muse 账号与微信

在另一个 Muse 账号的独立运行环境从零部署时，使用 default profile 即可。
先确认当前环境的 muse-cli 已通过该账号支持的登录方式登录，再安装完整仓库，
创建该账号的新对话，用新微信扫码。复制完整 config.example.json 并填写
ilink_user_id、weixin_session_id 和 muse_cli_path；muse_thread_id 不是桥接读取的字段。
不复制原环境的 cookie、config、state 或数据库。新的服务与原机器分别验收。

代理使用平台支持且已实测的当前配置；认证会轮换时不要把短期密码快照写入 unit。
免认证代理是否可用需按当前环境和平台配置核实，不能把某台机器的地址硬编码为通用值。

## 视频声音

bridge.js 将视频音轨提取为 16kHz 单声道 WAV，再调用 faster-whisper 命令。
仅安装同名 Python 库不能保证该命令存在；迁移环境应核对当前服务用户可执行的
CLI/wrapper，以及它支持 <音频路径> --language zh --output_format txt 参数，
并在音频旁写入同名 .txt 或将正文输出到 stdout。
先用有已知人声的样本检查退出码、非空转写和实际短句，再从微信发入复验。
无音轨、低音量或非语音视频转写为空时如实报告；没有原视频对比不能断言微信损坏了音轨。

## faster-whisper 语音转写（视频/语音）

桥接支持视频音轨和语音消息的转写，需要安装 faster-whisper。

### 安装步骤

```bash
# 使用实际服务用户及 HOME 创建环境和下载模型
WHISPER_VENV="$HOME/.local/share/wechat-muse/whisper-venv"
python3 -m venv "$WHISPER_VENV"
"$WHISPER_VENV/bin/pip" install faster-whisper numpy
HF_HUB_OFFLINE=0 "$WHISPER_VENV/bin/python" -c \
  "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

sudo cp "$REPO/scripts/faster-whisper-wrapper.py" /usr/local/bin/faster-whisper
sudo chmod +x /usr/local/bin/faster-whisper
export WHISPER_VENV_PYTHON="$WHISPER_VENV/bin/python"
```

服务也需要配置 WHISPER_VENV_PYTHON 为该解释器的实际绝对路径，或修改 wrapper 首行为
实际 venv Python 的绝对路径。shebang 不展开 `$HOME` 等变量；仅在 shell 中 export 不会
自动传入现有 systemd 服务。

### 验证

```bash
# 准备测试音频（16kHz 单声道 WAV）
ffmpeg -y -i test.mp4 -vn -ac 1 -ar 16000 test.wav

# 转写
faster-whisper test.wav --language zh --output_format txt
cat test.txt
```

### 说明

- wrapper 自动处理任意采样率（16kHz 视频音轨、24kHz 语音），内部用 ffmpeg 归一化到 16kHz
- 模型为 `tiny`（速度优先）；如需更高准确率，修改 wrapper 中的模型名
- 离线使用：确保 `HF_HUB_OFFLINE=1`（wrapper 默认设置）


模型预下载与实际服务必须使用相同运行用户、HOME 及模型缓存。安装完成后按实际服务的
环境验证命令可执行、模型能离线加载。音频转换失败应明确报错，不把原采样率音频当作16kHz继续识别。
