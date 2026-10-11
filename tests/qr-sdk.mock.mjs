export async function startWeixinLoginWithQr() {
  return {sessionKey:'mock-session',qrcodeUrl:'mock://qr',message:'mock QR'};
}
export async function waitForWeixinLogin(options) {
  if (!options.apiBaseUrl || options.sessionKey !== 'mock-session') throw new Error('SDK options invalid');
  return JSON.parse(process.env.QR_TEST_RESULT);
}
