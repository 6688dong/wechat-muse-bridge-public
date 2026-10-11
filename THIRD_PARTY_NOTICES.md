# 第三方组件与许可范围

## 本项目代码

仓库中由本项目权利人提供的桥接代码、脚本、测试和文档适用根目录
[LICENSE](LICENSE) 中的 PolyForm Noncommercial License 1.0.0。
版权和许可范围见 [NOTICE](NOTICE)。第三方代码与独立依赖除外。

此许可允许条款规定的非商业用途；商业用途需要相关权利人另行授权。
需要授权时，通过 [维护者 GitHub 主页](https://github.com/6688dong) 联系。
涉及第三方或其他贡献者的代码时，还须具备相应授权，维护者不能授予自己不拥有的权利。

## 内置 weixin-agent-sdk

| 项目 | 内容 |
|---|---|
| 位置 | `bridge/vendor/weixin-agent-sdk/` |
| 内置版本 | 0.5.0（包含本项目修改） |
| 许可证 | MIT |
| 原版权声明 | Copyright (c) 2026 wong2 |
| 完整文本 | [SDK LICENSE](bridge/vendor/weixin-agent-sdk/LICENSE) |

SDK 的原许可证及作者声明原样保留；本地修改也随 SDK 按 MIT 提供。
根目录的非商业限制不改变 SDK 的 MIT 使用权，也不代表 SDK 作者为本项目背书。
分发源码或含该 SDK 的构建产物时，须同时保留完整 MIT 文本与版权声明。

## npm 依赖

以下对应当前 `bridge/package-lock.json`；更新依赖时须重新检查。

| 组件 | 锁定版本 | 许可证 | 用途 |
|---|---|---|---|
| silk-wasm | 3.7.1 | MIT | 语音格式处理 |
| TypeScript | 5.8.3 | Apache-2.0 | SDK 构建 |
| @types/node | 26.6.5 | MIT | 构建类型声明 |
| Prettier | 3.9.9 | MIT | 开发工具 |
| undici-types | 8.9.0 | MIT | 类型声明依赖 |

这些包由 npm 安装，仓库不附带 `node_modules`。其许可证以各包内附文本为准；
如分发含依赖的安装包或二进制，仍须履行各自的版权、许可和通知义务。

## 外部程序与服务

Node.js、muse-cli、Muse 服务、ffmpeg/ffprobe、LibreOffice、faster-whisper
和模型权重不随本源码仓库分发。安装和使用它们应遵守各自许可及服务条款。
本项目许可不授予 Muse 账号、微信账号、第三方商标或外部服务访问权限。
