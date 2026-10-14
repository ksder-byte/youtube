// node --import ./test/register.mjs: resolves the platform's `sdk` imports and
// the bot's secrets.js to test doubles, so tgcloud/ modules load unchanged.
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
