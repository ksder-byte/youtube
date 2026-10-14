const SDK = {
  sdk: new URL('./sdk/index.mjs', import.meta.url).href,
  'sdk/db': new URL('./sdk/db.mjs', import.meta.url).href,
  'sdk/api': new URL('./sdk/api.mjs', import.meta.url).href,
  'sdk/fetch': new URL('./sdk/fetch.mjs', import.meta.url).href,
};
const SECRETS = new URL('./fixtures/secrets.js', import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (SDK[specifier]) return { url: SDK[specifier], shortCircuit: true };
  if (specifier === './secrets.js' && context.parentURL?.endsWith('/tgcloud/lib/config.js')) {
    return { url: SECRETS, shortCircuit: true };
  }
  return next(specifier, context);
}
