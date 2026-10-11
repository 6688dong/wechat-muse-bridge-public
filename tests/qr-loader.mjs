export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('/auth/login-qr.js')) {
    return {url:new URL('./qr-sdk.mock.mjs',import.meta.url).href,shortCircuit:true};
  }
  return nextResolve(specifier, context);
}
