import { authenticateBearerToken } from "../../auth/bearer-auth.js";

function createAuthHook(config) {
  return async function authHook(request) {
    authenticateBearerToken(request.headers.authorization, config.auth.apiKey);
  };
}

export { createAuthHook };
