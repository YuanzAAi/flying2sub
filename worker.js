const APP_HEADERS = {
  "User-Agent": "ua.net.fbclient.app.apex/v7.2.5",
  Accept: "application/json",
};

const SUBSCRIPTION_HEADERS = {
  "User-Agent": APP_HEADERS["User-Agent"],
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

async function requestJson(env, url, init) {
  const response = await env.API_TLS.fetch(url, init);
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

  const data = await requestJson(env, apiUrl(env, "/auth/token"), {
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
  const data = await requestJson(env, apiUrl(env, "/feed/access-token"), {
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

function safeHeaderValue(value, maxLength = 2048) {
  if (!value || value.length > maxLength || /[\r\n]/.test(value)) return null;
  return value;
}

function safeProfileWebPageUrl(value) {
  const safe = safeHeaderValue(value);
  if (!safe) return null;
  try {
    const url = new URL(safe);
    if (url.protocol !== "https:" || url.searchParams.has("token")) return null;
    return url.toString();
  } catch {
    return null;
  }
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
  if (!info?.token) throw new Error("getSubscribe response missing subscription token");
  const url = new URL(`${env.SUBSCRIPTION_BASE.replace(/\/+$/, "")}/feed/download`);
  url.searchParams.set("access_key", info.token);
  return url.toString();
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

function prefixedBytes(prefix, data) {
  const prefixBytes = new TextEncoder().encode(prefix);
  const result = new Uint8Array(prefixBytes.length + data.length);
  result.set(prefixBytes);
  result.set(data, prefixBytes.length);
  return result;
}

async function decryptProfile(payload) {
  if (payload.length < 105) throw new Error("encrypted subscription is too short");
  const header = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  if (header.getUint32(0) !== 0x41505853 || payload[4] !== 2 || header.getUint32(5) !== 1 || header.getUint32(9) !== 1) {
    throw new Error("unsupported subscription envelope");
  }
  const signedPayload = payload.subarray(0, -64);
  const verificationKey = await crypto.subtle.importKey(
    "raw", b64ToBytes("lmzs43izW9GHIOOq+avbwhWh0TG/ldT3kipGkrQ4RiE="), "Ed25519", false, ["verify"],
  );
  const validSignature = await crypto.subtle.verify(
    "Ed25519", verificationKey, payload.subarray(-64), prefixedBytes("apex-sub-sign-v2\0", signedPayload),
  );
  if (!validSignature) throw new Error("subscription signature rejected");
  const cryptoKey = await crypto.subtle.importKey(
    "raw", b64ToBytes("fCA3jkvhXpLEpDVuqPstNUS/kXewk7yGL5o8Fbh3uSc="), "AES-GCM", false, ["decrypt"],
  );
  const plainBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: payload.subarray(13, 25),
      additionalData: prefixedBytes("apex-sub-v2\0", payload.subarray(0, 25)),
      tagLength: 128,
    },
    cryptoKey,
    signedPayload.subarray(25),
  );
  const plainText = new TextDecoder().decode(plainBuffer);
  if (looksLikeYaml(plainText)) return plainText;
  throw new Error("decrypted subscription is not YAML");
}

async function fetchYaml(env, subscriptionUrl) {
  const response = await env.SUBSCRIPTION_TLS.fetch(subscriptionUrl, {
    method: "GET",
    headers: SUBSCRIPTION_HEADERS,
    redirect: "follow",
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(payload);
  const contentType = response.headers.get("content-type") || "";

  if (!response.ok) {
    throw new Error(`subscription HTTP ${response.status}`);
  }
  if (contentType.toLowerCase().includes("text/html") || /^\s*<!doctype|^\s*<html|^\s*<script/i.test(text)) {
    throw new Error("subscription returned HTML/WAF page");
  }
  const yaml = looksLikeYaml(text) ? text : await decryptProfile(payload);
  return {
    yaml,
    subscriptionUserinfo: safeHeaderValue(response.headers.get("subscription-userinfo")),
    profileUpdateInterval: safeHeaderValue(response.headers.get("profile-update-interval")),
    profileWebPageUrl: safeProfileWebPageUrl(response.headers.get("profile-web-page-url")),
  };
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
      const profile = await fetchYaml(env, subscriptionUrl);
      const headers = {
        "content-type": "text/yaml; charset=utf-8",
        "cache-control": "no-store",
      };
      if (profile.subscriptionUserinfo) headers["subscription-userinfo"] = profile.subscriptionUserinfo;
      if (profile.profileUpdateInterval) headers["profile-update-interval"] = profile.profileUpdateInterval;
      if (profile.profileWebPageUrl) headers["profile-web-page-url"] = profile.profileWebPageUrl;

      return new Response(profile.yaml, {
        status: 200,
        headers,
      });
    } catch (error) {
      return json({ ok: false, error: error.message || String(error) }, 502);
    }
  },
};
