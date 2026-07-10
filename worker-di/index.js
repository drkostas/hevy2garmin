/**
 * Cloudflare Worker: Garmin DI OAuth authentication proxy.
 *
 * Runs alongside the legacy `hevy2garmin-exchange` worker. This worker
 * serves the garmin-auth >= 0.3.0 DI OAuth token format.
 *
 * Endpoints:
 *
 *   POST /exchange   { ticket }
 *     Ticket-based flow (used by the manual copy-paste fallback). User
 *     signs in on Garmin's own embed widget, pastes the URL back into
 *     hevy2garmin, hevy2garmin extracts the `ST-...` ticket and POSTs
 *     it here. Worker exchanges it for a DI token.
 *
 *   POST /login      { email, password }
 *     Direct credential flow (the preferred UX with no copy-paste). User
 *     types email + password into hevy2garmin's setup form, hevy2garmin
 *     POSTs them here. Worker hits Garmin's portal/api/login endpoint
 *     from the Cloudflare edge (which Garmin does not block the way it
 *     blocks AWS/Azure IPs). Returns one of:
 *       { status: "success", di_token, di_refresh_token, di_client_id }
 *       { status: "needs_mfa", session_id, mfa_method }
 *       { status: "needs_captcha" }         ← hevy2garmin falls back to manual flow
 *       { status: "invalid_credentials" }
 *       { status: "rate_limited" }
 *       { status: "error", message }
 *
 *   POST /login-mfa  { session_id, mfa_code }
 *     Second step of the credential flow when Garmin required a second
 *     factor. Looks up the stashed session in KV, POSTs the code to
 *     Garmin's mfa/verifyCode endpoint, exchanges the resulting ticket
 *     for a DI token, returns the same shape as /login success.
 *
 * The Worker never retries on failure in order to avoid self-inflicted
 * rate limits. One HTTP call per login attempt.
 */

// ── Constants ──────────────────────────────────────────────────────────────

const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const DI_GRANT_TYPE =
  "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
const CLIENT_ID = "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2";

const PORTAL_SSO = "https://sso.garmin.com";
const PORTAL_CLIENT_ID = "GarminConnect";
const PORTAL_SERVICE_URL = "https://connect.garmin.com/app";
const SSO_EMBED_SERVICE = "https://sso.garmin.com/sso/embed";

// Mobile SSO flow — the Garmin Android app's login endpoint. Used as a
// fallback when the browser-oriented /portal/api/login returns error 427
// (which it does for MFA-enabled accounts). The mobile endpoint is designed
// for a native app that needs to handle MFA inline via JSON, so it returns
// the documented `responseStatus.type === "MFA_REQUIRED"` response shape.
const MOBILE_SSO_CLIENT_ID = "GCM_ANDROID_DARK";
const MOBILE_SSO_SERVICE_URL = "https://mobile.integration.garmin.com/gcm/android";
const MOBILE_SSO_UA =
  "Mozilla/5.0 (Linux; Android 13; sdk_gphone64_arm64 Build/TE1A.220922.025; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/132.0.0.0 Mobile Safari/537.36";

// Mobile GCM headers expected by the DI token-exchange endpoint.
const DI_HEADERS = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "application/json,text/html;q=0.9,*/*;q=0.8",
  "Content-Type": "application/x-www-form-urlencoded",
  "Cache-Control": "no-cache",
};

// Desktop browser headers used for the portal login flow. Matches what
// Garmin Connect's own React app sends, so Cloudflare doesn't flag us.
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// MFA session TTL — Garmin's pending MFA login state typically expires
// within a few minutes, so we don't bother keeping KV entries around longer.
const MFA_SESSION_TTL_SECONDS = 600;

// Rate-limit cooldown (#214). When Garmin returns a 429 for a login, we stash a
// per-account cooldown in KV and short-circuit further /login attempts for that
// account until it lapses, so a determined user can't bypass the client-side
// cooldown (0.5.14) by POSTing the Worker directly and deepen Garmin's throttle
// (#147). Keyed per account because this Worker is shared across every
// self-hosted instance and Garmin throttles per-account, so a global key would
// let one account's 429 lock out everyone. Uses a flat 2h window (the local
// server's ratelimit.py base) as a backstop; it intentionally does NOT
// replicate the client's exponential backoff, so for a repeatedly-throttled
// account the two layers can report different waits. The KV entry's TTL equals
// the cooldown, so it self-clears exactly when the window ends.
const COOLDOWN_KEY_PREFIX = "cooldown:";
const COOLDOWN_SECONDS = 2 * 3600;

// ── Main handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }
    if (request.method !== "POST") {
      return json({ error: "POST only" }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, ""); // strip trailing slash

    try {
      if (path === "" || path === "/exchange") {
        return await handleExchange(request);
      }
      if (path === "/login") {
        return await handleLogin(request, env);
      }
      if (path === "/login-mfa") {
        return await handleLoginMfa(request, env);
      }
      return json({ error: `Unknown path: ${path}` }, 404);
    } catch (e) {
      return json({ error: e.message || "Internal error" }, 500);
    }
  },
};

// ── /exchange — ticket-based flow (fallback path) ─────────────────────────

async function handleExchange(request) {
  const { ticket } = await request.json();
  if (!ticket) return json({ error: "No ticket" }, 400);
  if (typeof ticket !== "string" || !ticket.startsWith("ST-")) {
    return json(
      { error: "Ticket must be a Garmin CAS service ticket (starts with ST-)" },
      400,
    );
  }

  const di = await exchangeServiceTicket(ticket, SSO_EMBED_SERVICE);
  if (di.error) return json({ error: di.error }, di.status || 502);

  return json({
    di_token: di.access_token,
    di_refresh_token: di.refresh_token,
    di_client_id: extractClientIdFromJwt(di.access_token) || CLIENT_ID,
    expires_in: di.expires_in,
    refresh_token_expires_in: di.refresh_token_expires_in,
    scope: di.scope,
  });
}

// ── /login — credential-based flow (preferred UX) ─────────────────────────

async function handleLogin(request, env) {
  const body = await request.json();
  const email = (body.email || "").trim();
  const password = body.password || "";
  if (!email || !password) {
    return json({ status: "error", message: "email and password required" }, 400);
  }

  // Hard-enforce the per-account cooldown before touching Garmin (#214). If this
  // account is still cooling down from an earlier 429, return immediately so we
  // never add to Garmin's throttle. Fails open: any KV error proceeds to Garmin
  // rather than locking the account out (this Worker is shared).
  const remaining = await cooldownRemaining(env, email);
  if (remaining > 0) {
    return json({ status: "rate_limited", retry_after_seconds: remaining });
  }

  // Mobile-first: the mobile/app login endpoint is the one Garmin designed for
  // native MFA, so it's the least likely to reject programmatic logins with a
  // 427. Fall back to the portal endpoint ONLY on a 427 (MFA-routing). We do
  // NOT fall back on a 429: Garmin's login rate limit is per-account (it spans
  // both endpoints), so retrying the other flavour just burns its bucket too
  // and deepens the throttle that won't clear (#147). On 429 we surface
  // rate_limited immediately.
  const first = await tryLoginFlavour(env, email, password, "mobile");
  if (first.rateLimited) return await rateLimitResponse(env, email);
  if (!first.fallback) {
    if (first.success) await clearCooldown(env, email);
    return first.response;
  }

  const second = await tryLoginFlavour(env, email, password, "portal");
  if (second.rateLimited) return await rateLimitResponse(env, email);
  if (!second.fallback) {
    if (second.success) await clearCooldown(env, email);
    return second.response;
  }

  // 427 on both endpoints → Garmin is steering us to the manual flow.
  return json({
    status: "needs_captcha",
    message:
      "Garmin returned error 427 on both login flows. Use the manual sign-in fallback.",
  });
}

/** Record a fresh cooldown for this account and build the rate_limited
 *  response the caller sends back. */
async function rateLimitResponse(env, email) {
  const secs = await setCooldown(env, email);
  return json({ status: "rate_limited", retry_after_seconds: secs });
}

/** Attempt a single login flavour (portal or mobile) and return either a
 *  final Response to send back to the caller, or a signal to fall through
 *  to the next flavour. */
async function tryLoginFlavour(env, email, password, flavour) {
  const config =
    flavour === "mobile"
      ? {
          signinPath: "/mobile/sso/en_US/sign-in",
          loginPath: "/mobile/api/login",
          mfaPath: "/mobile/api/mfa/verifyCode",
          clientId: MOBILE_SSO_CLIENT_ID,
          serviceUrl: MOBILE_SSO_SERVICE_URL,
          userAgent: MOBILE_SSO_UA,
        }
      : {
          signinPath: "/portal/sso/en-US/sign-in",
          loginPath: "/portal/api/login",
          mfaPath: "/portal/api/mfa/verifyCode",
          clientId: PORTAL_CLIENT_ID,
          serviceUrl: PORTAL_SERVICE_URL,
          userAgent: DESKTOP_UA,
        };

  const signinUrl = `${PORTAL_SSO}${config.signinPath}`;
  const params = new URLSearchParams({
    clientId: config.clientId,
    locale: "en-US",
    service: config.serviceUrl,
  });
  const loginUrl = `${PORTAL_SSO}${config.loginPath}?${params}`;
  const referer = `${signinUrl}?clientId=${config.clientId}&service=${config.serviceUrl}`;

  // Step 1: GET the sign-in page to establish session cookies.
  let sessionCookies = "";
  try {
    const getResp = await fetch(
      `${signinUrl}?clientId=${config.clientId}&service=${config.serviceUrl}`,
      {
        headers: {
          "User-Agent": config.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      },
    );
    sessionCookies = extractSetCookieHeader(getResp);
  } catch (e) {
    return {
      response: json(
        { status: "error", message: `[${flavour}] warmup GET failed: ${e.message}` },
        502,
      ),
    };
  }

  // Step 2: POST credentials.
  const postHeaders = {
    "User-Agent": config.userAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: PORTAL_SSO,
    Referer: referer,
  };
  if (sessionCookies) postHeaders.Cookie = sessionCookies;

  let loginResp;
  try {
    loginResp = await fetch(loginUrl, {
      method: "POST",
      headers: postHeaders,
      body: JSON.stringify({
        username: email,
        password,
        rememberMe: true,
        captchaToken: "",
      }),
    });
  } catch (e) {
    return {
      response: json(
        { status: "error", message: `[${flavour}] login POST failed: ${e.message}` },
        502,
      ),
    };
  }

  // Step 3: parse and branch.
  if (loginResp.status === 429) {
    // Never fall back to the other flavour on a rate limit — Garmin's login
    // limit is per-account across both endpoints, so retrying just deepens it
    // (#147). Signal the caller to record the cooldown and surface it (#214).
    return { rateLimited: true };
  }
  let loginData;
  try {
    loginData = await loginResp.json();
  } catch {
    const text = await loginResp.text().catch(() => "");
    return {
      response: json(
        {
          status: "error",
          message: `[${flavour}] non-JSON login response (HTTP ${loginResp.status}): ${text.slice(0, 200)}`,
        },
        502,
      ),
    };
  }

  // Handle Garmin's custom error envelope.
  const garminErrCode = loginData?.error?.["status-code"];
  if (garminErrCode === "429") {
    // Per-account rate limit — never retry the other flavour (#147). Signal the
    // caller to record the cooldown and surface it (#214).
    return { rateLimited: true };
  }
  if (garminErrCode === "427") {
    // 427 routes MFA-enabled accounts to a different flow. Signal the caller to
    // try the other flavour; the caller surfaces needs_captcha if both 427.
    return { fallback: true };
  }
  if (garminErrCode) {
    return {
      response: json(
        {
          status: "error",
          message: `[${flavour}] Garmin login returned error status-code ${garminErrCode}`,
          detail: JSON.stringify(loginData).slice(0, 400),
          http_status: loginResp.status,
        },
        502,
      ),
    };
  }

  const respType = loginData?.responseStatus?.type;

  if (respType === "SUCCESSFUL") {
    const ticket = loginData.serviceTicketId;
    if (!ticket) {
      return {
        response: json(
          { status: "error", message: `[${flavour}] login succeeded but no serviceTicketId` },
          502,
        ),
      };
    }
    const di = await exchangeServiceTicket(ticket, config.serviceUrl);
    if (di.error) {
      return {
        response: json(
          { status: "error", message: di.error },
          di.status || 502,
        ),
      };
    }
    return {
      success: true,
      response: json({
        status: "success",
        di_token: di.access_token,
        di_refresh_token: di.refresh_token,
        di_client_id: extractClientIdFromJwt(di.access_token) || CLIENT_ID,
      }),
    };
  }

  if (respType === "MFA_REQUIRED") {
    const mfaMethod =
      loginData?.customerMfaInfo?.mfaLastMethodUsed || "email";
    const postCookies = extractSetCookieHeader(loginResp);
    const mergedCookies = mergeCookieStrings(sessionCookies, postCookies);

    if (!env.MFA_SESSIONS) {
      return {
        response: json(
          {
            status: "error",
            message:
              "MFA_SESSIONS KV namespace not bound — set it up in wrangler.toml",
          },
          500,
        ),
      };
    }
    const sessionId = crypto.randomUUID();
    const sessionState = {
      flavour,
      email,
      cookies: mergedCookies,
      mfa_method: mfaMethod,
      params: params.toString(),
      referer,
      user_agent: config.userAgent,
      service_url: config.serviceUrl,
      mfa_path: config.mfaPath,
      created_at: Date.now(),
    };
    await env.MFA_SESSIONS.put(sessionId, JSON.stringify(sessionState), {
      expirationTtl: MFA_SESSION_TTL_SECONDS,
    });
    return {
      response: json({
        status: "needs_mfa",
        session_id: sessionId,
        mfa_method: mfaMethod,
      }),
    };
  }

  if (respType === "INVALID_USERNAME_PASSWORD") {
    return { response: json({ status: "invalid_credentials" }) };
  }

  // Defensive captcha detection on an unknown response shape.
  const rawBody = JSON.stringify(loginData);
  if (
    /captcha/i.test(rawBody) ||
    respType === "CAPTCHA_REQUIRED" ||
    respType === "NEED_CAPTCHA"
  ) {
    return { response: json({ status: "needs_captcha" }) };
  }

  return {
    response: json(
      {
        status: "error",
        message: `[${flavour}] Unexpected responseStatus.type: ${respType || "(none)"}`,
        detail: rawBody.slice(0, 300),
      },
      502,
    ),
  };
}

// ── /login-mfa — second step for MFA completion ──────────────────────────

async function handleLoginMfa(request, env) {
  const { session_id: sessionId, mfa_code: code } = await request.json();
  if (!sessionId || !code) {
    return json(
      { status: "error", message: "session_id and mfa_code required" },
      400,
    );
  }

  if (!env.MFA_SESSIONS) {
    return json(
      {
        status: "error",
        message:
          "MFA_SESSIONS KV namespace not bound — set it up in wrangler.toml",
      },
      500,
    );
  }

  const raw = await env.MFA_SESSIONS.get(sessionId);
  if (!raw) {
    return json(
      {
        status: "error",
        message: "MFA session expired or not found, please start over",
      },
      410,
    );
  }
  const session = JSON.parse(raw);

  // Use the same flavour (portal or mobile) and matching endpoint/UA as
  // the original /login call — Garmin requires the MFA verify to hit the
  // sibling endpoint of whichever login flow produced the MFA challenge.
  const mfaPath = session.mfa_path || "/portal/api/mfa/verifyCode";
  const userAgent = session.user_agent || DESKTOP_UA;
  const mfaUrl = `${PORTAL_SSO}${mfaPath}?${session.params}`;
  const mfaHeaders = {
    "User-Agent": userAgent,
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Content-Type": "application/json",
    Origin: PORTAL_SSO,
    Referer: session.referer,
  };
  if (session.cookies) mfaHeaders.Cookie = session.cookies;

  let mfaResp;
  try {
    mfaResp = await fetch(mfaUrl, {
      method: "POST",
      headers: mfaHeaders,
      body: JSON.stringify({
        mfaMethod: session.mfa_method || "email",
        mfaVerificationCode: code.trim(),
        rememberMyBrowser: true,
        reconsentList: [],
        mfaSetup: false,
      }),
    });
  } catch (e) {
    return json({ status: "error", message: `mfa verify failed: ${e.message}` }, 502);
  }

  if (mfaResp.status === 429) {
    const secs = await setCooldown(env, session.email);
    return json({ status: "rate_limited", retry_after_seconds: secs });
  }
  let mfaData;
  try {
    mfaData = await mfaResp.json();
  } catch {
    return json({ status: "error", message: `non-JSON mfa response HTTP ${mfaResp.status}` }, 502);
  }
  const mfaType = mfaData?.responseStatus?.type;
  if (mfaType !== "SUCCESSFUL") {
    // Wrong code, expired, locked, etc. Leave the session in KV so the
    // user can retry with a different code within the TTL window.
    return json(
      {
        status: "mfa_failed",
        message: `Garmin rejected the code (${mfaType || "unknown"})`,
      },
      400,
    );
  }
  const ticket = mfaData.serviceTicketId;
  if (!ticket) {
    return json({ status: "error", message: "MFA succeeded but no serviceTicketId returned" }, 502);
  }

  // Exchange the ticket for a DI token using the same service URL as the
  // original login (portal vs mobile have different service URLs).
  const serviceUrl = session.service_url || PORTAL_SERVICE_URL;
  const di = await exchangeServiceTicket(ticket, serviceUrl);
  if (di.error) return json({ status: "error", message: di.error }, di.status || 502);
  await env.MFA_SESSIONS.delete(sessionId).catch(() => {});
  await clearCooldown(env, session.email);

  return json({
    status: "success",
    di_token: di.access_token,
    di_refresh_token: di.refresh_token,
    di_client_id: extractClientIdFromJwt(di.access_token) || CLIENT_ID,
  });
}

// ── Rate-limit cooldown helpers (#214) ─────────────────────────────────────

/** SHA-256 hex of the normalized (trimmed, lowercased) email. Used as the KV
 *  key suffix so we never store the raw address and so casing/whitespace
 *  variants of the same account map to one cooldown. */
export async function hashEmail(email) {
  const norm = (email || "").trim().toLowerCase();
  const bytes = new TextEncoder().encode(norm);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Whole seconds remaining until `until` (ms epoch), floored at 0. */
export function remainingSeconds(until, now) {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Seconds left on this account's cooldown, or 0 if none. Fails open: any KV
 *  error returns 0 so a KV blip can't lock every account out of login. */
export async function cooldownRemaining(env, email) {
  if (!env || !env.MFA_SESSIONS) return 0;
  try {
    const hash = await hashEmail(email);
    const raw = await env.MFA_SESSIONS.get(COOLDOWN_KEY_PREFIX + hash);
    if (!raw) return 0;
    const { until } = JSON.parse(raw);
    if (typeof until !== "number") return 0;
    return remainingSeconds(until, Date.now());
  } catch {
    return 0;
  }
}

/** Start (or refresh) this account's cooldown. The KV TTL equals the cooldown
 *  so the entry self-clears when the window ends. Returns the cooldown length
 *  in seconds; still returns it on a KV error so the caller reports the real
 *  429 the user just hit. */
export async function setCooldown(env, email) {
  if (env && env.MFA_SESSIONS) {
    try {
      const hash = await hashEmail(email);
      const until = Date.now() + COOLDOWN_SECONDS * 1000;
      await env.MFA_SESSIONS.put(
        COOLDOWN_KEY_PREFIX + hash,
        JSON.stringify({ until }),
        { expirationTtl: COOLDOWN_SECONDS },
      );
    } catch {
      // fall through — still report the cooldown length to the caller
    }
  }
  return COOLDOWN_SECONDS;
}

/** Drop this account's cooldown after a genuine Garmin response (the account
 *  clearly isn't throttled). Best effort; errors are ignored. */
export async function clearCooldown(env, email) {
  if (!env || !env.MFA_SESSIONS || !email) return;
  try {
    const hash = await hashEmail(email);
    await env.MFA_SESSIONS.delete(COOLDOWN_KEY_PREFIX + hash);
  } catch {
    // best effort
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Exchange a CAS service ticket for a DI OAuth token payload. */
async function exchangeServiceTicket(ticket, serviceUrl) {
  const basicAuth = "Basic " + btoa(`${CLIENT_ID}:`);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    service_ticket: ticket,
    grant_type: DI_GRANT_TYPE,
    service_url: serviceUrl,
  });
  let resp;
  try {
    resp = await fetch(DI_TOKEN_URL, {
      method: "POST",
      headers: { ...DI_HEADERS, Authorization: basicAuth },
      body,
    });
  } catch (e) {
    return { error: `DI exchange network error: ${e.message}`, status: 502 };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      error: `DI token exchange failed (${resp.status}): ${text.slice(0, 300)}`,
      status: 502,
    };
  }
  const di = await resp.json();
  if (!di.access_token || !di.refresh_token) {
    return { error: "DI response missing expected tokens", status: 502 };
  }
  return di;
}

/** Parse a JWT payload (no signature check) and extract `client_id`. */
function extractClientIdFromJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.client_id || null;
  } catch {
    return null;
  }
}

/** Collapse the Set-Cookie headers from a Response into a single Cookie
 *  header value suitable for forwarding to Garmin on a follow-up request. */
function extractSetCookieHeader(resp) {
  // Cloudflare Workers expose `getSetCookie()` on Headers to read multiple
  // Set-Cookie entries. Fall back to the single-string form for older runtimes.
  const headers = resp.headers;
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : [headers.get("set-cookie")].filter(Boolean);
  const pairs = [];
  for (const line of setCookies) {
    if (!line) continue;
    const nameValue = line.split(";")[0].trim();
    if (nameValue) pairs.push(nameValue);
  }
  return pairs.join("; ");
}

/** Merge two Cookie header strings, deduping by cookie name with the second
 *  set winning so cookies updated by the login POST override the warmup. */
function mergeCookieStrings(a, b) {
  if (!a) return b || "";
  if (!b) return a || "";
  const map = new Map();
  for (const str of [a, b]) {
    for (const pair of str.split(";").map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      map.set(pair.slice(0, eq), pair);
    }
  }
  return [...map.values()].join("; ");
}

/** Helper to build a JSON Response with CORS headers. */
function json(body, status = 200) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}
