const APP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (dart:io) SuperAccelerator",
  Accept: "application/json",
};

const SUBSCRIPTION_HEADERS = {
  "User-Agent": "NetFlow/v3.0.3 clash-verge Platform/windows",
};

const YAML_PREFIXES = ["mixed-port:", "port:", "dns:", "proxies:", "proxy-groups:", "rules:"];

let cachedAuth = null;

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function apiUrl(env, path) {
  return `${env.API_BASE.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function decodeJwtExp(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const data = JSON.parse(atob(padded));
    return Number.isInteger(data.exp) ? data.exp : null;
  } catch {
    return null;
  }
}

function getCachedAuth() {
  if (!cachedAuth?.authData || !cachedAuth?.exp) return null;
  if (cachedAuth.exp <= Math.floor(Date.now() / 1000) + 300) return null;
  return cachedAuth.authData;
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`API response is not JSON: ${error.message}`);
  }
  if (!response.ok) {
    throw new Error(`API HTTP ${response.status}: ${data.message || data.error || url}`);
  }
  if (data.status && data.status !== "success") {
    throw new Error(`API non-success: ${data.message || data.error || "unknown error"}`);
  }
  return data;
}

async function login(env) {
  const form = new URLSearchParams();
  form.set("email", env.FB_EMAIL);
  form.set("password", env.FB_PASSWORD);

  const data = await requestJson(apiUrl(env, "/passport/auth/login"), {
    method: "POST",
    headers: {
      ...APP_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  const authData = data?.data?.auth_data;
  if (!authData) throw new Error("login response missing data.auth_data");

  cachedAuth = {
    authData,
    exp: decodeJwtExp(authData),
  };
  return authData;
}

async function getSubscribeInfo(env, authData) {
  const data = await requestJson(apiUrl(env, "/user/getSubscribe"), {
    method: "GET",
    headers: {
      ...APP_HEADERS,
      Authorization: authData,
      "Content-Type": "application/json",
    },
  });
  if (!data?.data || typeof data.data !== "object") {
    throw new Error("getSubscribe response missing data object");
  }
  return data.data;
}

async function getSubscriptionUrl(env) {
  let authData = getCachedAuth() || (await login(env));
  try {
    const info = await getSubscribeInfo(env, authData);
    return subscriptionUrlFromInfo(env, info);
  } catch {
    authData = await login(env);
    const info = await getSubscribeInfo(env, authData);
    return subscriptionUrlFromInfo(env, info);
  }
}

function subscriptionUrlFromInfo(env, info) {
  if (info.token) {
    const url = new URL(apiUrl(env, "/client/subscribe"));
    url.searchParams.set("token", info.token);
    return url.toString();
  }
  const url = info.subscription_url || info.subscribe_url;
  if (!url) throw new Error("getSubscribe response missing subscription token/url");
  return String(url);
}

function b64ToBytes(b64) {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function looksLikeYaml(text) {
  const trimmed = text.trimStart();
  return YAML_PREFIXES.some((prefix) => trimmed.startsWith(prefix)) || /\n\s*(proxies|proxy-groups|rules)\s*:/.test(text);
}

async function decryptProfile(encryptedText, env) {
  const key = new TextEncoder().encode(env.KEY_ASCII);
  const iv = new TextEncoder().encode(env.IV_ASCII);
  if (key.length !== 16 || iv.length !== 16) {
    throw new Error("conversion parameters must both be 16 ASCII bytes");
  }

  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-CBC", false, ["decrypt"]);
  const plainBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, cryptoKey, b64ToBytes(encryptedText));
  const plainText = new TextDecoder().decode(plainBuffer);
  if (looksLikeYaml(plainText)) return plainText;

  try {
    const inner = b64ToBytes(plainText);
    return new TextDecoder().decode(inner);
  } catch {
    return plainText;
  }
}

async function fetchYaml(env, subscriptionUrl) {
  const response = await fetch(subscriptionUrl, {
    method: "GET",
    headers: SUBSCRIPTION_HEADERS,
    redirect: "follow",
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`subscription HTTP ${response.status}`);
  }
  if (contentType.toLowerCase().includes("text/html") || /^\s*<!doctype|^\s*<html|^\s*<script/i.test(text)) {
    throw new Error("subscription returned HTML/WAF page");
  }
  return looksLikeYaml(text) ? text : await decryptProfile(text, env);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "flyingbird-sub" });
    }

    if (url.pathname !== "/flyingbird") {
      return json({ ok: false, error: "not found" }, 404);
    }

    if (!env.ACCESS_TOKEN || url.searchParams.get("token") !== env.ACCESS_TOKEN) {
      return json({ ok: false, error: "invalid access token" }, 403);
    }

    try {
      const subscriptionUrl = await getSubscriptionUrl(env);
      const yaml = await fetchYaml(env, subscriptionUrl);
      return new Response(yaml, {
        status: 200,
        headers: {
          "content-type": "text/yaml; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 502);
    }
  },
};
