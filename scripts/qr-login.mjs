#!/usr/bin/env node
/**
 * 独立 QR 登录脚本（真实 SDK 调用）
 *
 * SDK 真实返回格式（waitForWeixinLogin）：
 *   成功: { connected: true, botToken, accountId, baseUrl, userId, message }
 *   失败: { connected: false, message }
 *
 * 路径统一：
 *   - default profile: $HOME/wechat-muse-bridge/bridge/
 *   - 命名 profile: $HOME/wechat-muse-bridge/bridge/profiles/<name>/
 *   - SDK state: <profile>/state/weixin/  (与 bridge.js 的 OPENCLAW_STATE_DIR 一致)
 *
 * 安全约束：
 * - 默认绝不读取其他 profile 或旧桥的 session.json
 * - 目录权限 700，umask 077
 * - 已知扫描者 userId 必须与配置或 --expected-user 匹配，写入前检查
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const profileIdx = args.indexOf("--profile");
const profile = (profileIdx !== -1 && args[profileIdx + 1]) ? args[profileIdx + 1] : "default";
const expectedIdx = args.indexOf("--expected-user");
if ((profileIdx !== -1 && !args[profileIdx + 1]) || (expectedIdx !== -1 && !args[expectedIdx + 1])) {
  throw new Error("--profile/--expected-user 需要参数");
}

// 验证 profile 名称
if (!/^[a-zA-Z0-9_-]{1,32}$/.test(profile)) {
  console.error("错误: profile 名称只能包含字母、数字、下划线、连字符（1-32字符）");
  process.exit(1);
}

if (args.includes("--import-old")) throw new Error("扫码脚本不迁移旧登录态；旧桥迁移须单独核对账号后显式进行");

// 路径统一：default 用 bridge 根目录，命名 profile 用 profiles/<name>
const PROFILE_DIR = profile === "default"
  ? path.join(os.homedir(), "wechat-muse-bridge", "bridge")
  : path.join(os.homedir(), "wechat-muse-bridge", "bridge", "profiles", profile);
const STATE_WEIXIN_DIR = path.join(PROFILE_DIR, "state", "weixin");
const ACCOUNT_FILE = path.join(STATE_WEIXIN_DIR, "openclaw-weixin", "accounts.json");
const configPath = path.join(PROFILE_DIR, "config.json");
if (!fs.existsSync(configPath)) throw new Error("请先创建本 profile 的 config.json，再扫码");
const profileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const configuredUser = profileConfig.ilink_user_id;
const expectedUser = expectedIdx !== -1 ? args[expectedIdx + 1] :
  (typeof configuredUser === "string" && !/^YOUR_|^REPLACE_|^</.test(configuredUser) ? configuredUser : null);

// 设置 SDK 状态目录（与 bridge.js 一致）
process.env.OPENCLAW_STATE_DIR = STATE_WEIXIN_DIR;

// 设置 umask 确保护凭据文件权限
process.umask(0o077);

console.log(`Profile: ${profile}`);
console.log(`Profile 目录: ${PROFILE_DIR}`);
console.log(`SDK state: ${STATE_WEIXIN_DIR}`);

// 确保目录存在且权限 700
fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true, mode: 0o700 });
fs.chmodSync(path.dirname(ACCOUNT_FILE), 0o700);

// 检查是否已有账号（不覆盖）
if (fs.existsSync(ACCOUNT_FILE)) {
    const accounts = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf-8"));
    if (!Array.isArray(accounts)) throw new Error("账号索引损坏，保留状态，拒绝自动覆盖");
    if (Array.isArray(accounts) && accounts.length > 0) {
      console.log(`\n该 profile 已有登录账号: ${accounts.join(", ")}`);
      console.log("如需重新扫码，请先备份并删除 state 目录。");
      console.log("当前不做任何修改，退出。");
      process.exit(0);
    }
}
const credentialsDir = path.join(path.dirname(ACCOUNT_FILE), "accounts");
if (fs.existsSync(credentialsDir) && fs.readdirSync(credentialsDir).some(name => name.endsWith(".json"))) {
  throw new Error("发现已有凭据但账号索引为空，保留状态，请先核对");
}

try {
  const distUrl = new URL("../bridge/dist/", import.meta.url);
  const { startWeixinLoginWithQr, waitForWeixinLogin } = await import(
    new URL("auth/login-qr.js", distUrl)
  );
  const sdkAccounts = await import(new URL("auth/accounts.js", distUrl));

  console.log("\n=== 微信扫码登录 ===");
  console.log("正在获取二维码...");

  const qrResult = await startWeixinLoginWithQr({
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
  });

  if (!qrResult.qrcodeUrl) {
    console.error(`获取二维码失败: ${qrResult.message}`);
    process.exit(1);
  }

  console.log(`\n${qrResult.message}`);
  console.log(`二维码链接: ${qrResult.qrcodeUrl}`);
  console.log("\n请使用微信扫描。等待确认（5 分钟）...\n");

  // P1 修复：wait 调用补 apiBaseUrl
  const result = await waitForWeixinLogin({
    sessionKey: qrResult.sessionKey,
    apiBaseUrl: "https://ilinkai.weixin.qq.com",
    timeoutMs: 5 * 60 * 1000,
  });

  // P1 修复：检查真实 SDK 字段 connected，而非 status==='confirmed'
  if (!result.connected) {
    console.error(`\n登录失败: ${result.message}`);
    process.exit(1);
  }

  // P1 修复：使用真实字段 botToken/accountId/baseUrl/userId
  const { botToken, accountId, baseUrl, userId } = result;
  if (!botToken || !accountId || !userId) {
    console.error("\n登录返回缺少必要字段 (botToken/accountId/userId)，拒绝保存。");
    process.exit(1);
  }
  if (expectedUser && userId !== expectedUser) {
    throw new Error("扫描者与本 profile 的预期账号不匹配；拒绝保存，现有状态保留");
  }

  console.log("\n✅ 扫码确认成功！");
  console.log(`  accountId (ilink_bot_id): ${accountId}`);
  console.log(`  userId (扫码者): ${userId.slice(0, 12)}...`);

  // 保存到本 profile 的 state 目录
  const normalizedId = sdkAccounts.normalizeAccountId(accountId);
  sdkAccounts.saveWeixinAccount(normalizedId, {
    token: botToken,
    baseUrl: baseUrl || "https://ilinkai.weixin.qq.com",
    userId: userId,
  });
  sdkAccounts.registerWeixinAccountId(normalizedId);

  // 确保账号文件权限 600
  try { fs.chmodSync(ACCOUNT_FILE, 0o600); } catch {}

  console.log(`\n账号已保存到: ${ACCOUNT_FILE}`);
  console.log("\n下一步：");
  console.log(`  1. 编辑 ${PROFILE_DIR}/config.json，设置:`);
  console.log(`     ilink_user_id: "${userId}"`);
  console.log("  2. 确保该 userId 与您期望的绑定用户一致");
  console.log("  3. 运行 scripts/deploy.sh 部署服务");
} catch (e) {
  console.error(`\nQR 登录失败: ${e.message}`);
  process.exit(1);
}
