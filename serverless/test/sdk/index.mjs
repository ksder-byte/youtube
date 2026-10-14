export { db } from './db.mjs';
export { api, BotApiError, InputFile } from './api.mjs';
export { fetch } from './fetch.mjs';

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
  }
}

export const FormData = globalThis.FormData;
