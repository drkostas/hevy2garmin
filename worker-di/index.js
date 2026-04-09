/**
 * Cloudflare Worker: Garmin DI OAuth ticket exchange proxy.
 *
 * Runs alongside the legacy `hevy2garmin-exchange` worker. This version
 * exchanges the CAS service ticket for a DI OAuth token at
 * `diauth.garmin.com/di-oauth2-service/oauth/token`, which is the format
 * garminconnect>=0.3.0 and garmin-auth>=0.3.0 consume.
 *
 * The legacy worker stays alive indefinitely for older hevy2garmin
 * deployments that still expect the {oauth1, oauth2} response shape.
 * New deployments point at this worker instead.
 *
 * Why a separate worker instead of a new path on the legacy worker?
 * Keeping the legacy code path untouched means zero risk of breaking
 * existing users' setup wizards. A CAS ticket is single-use, so a single
 * endpoint cannot return both the OAuth1/OAuth2 pair AND the DI token in
 * one response — each exchange consumes the ticket.
 *
 * The user signs in on Garmin's own embed-widget page (which natively
 * handles 2FA via Garmin's own UI), then pastes the resulting
 * `https://sso.garmin.com/sso/embed?ticket=ST-...` URL into hevy2garmin.
 * The browser POSTs the ticket to this worker, which exchanges it for a
 * DI OAuth access token + refresh token.
 *
 * POST /exchange { ticket }
 *   → Posts the CAS ticket to Garmin's DI OAuth endpoint
 *   → Returns { di_token, di_refresh_token, di_client_id, expires_in,
 *               refresh_token_expires_in, scope }
 */

const DI_TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const DI_GRANT_TYPE =
  "https://connectapi.garmin.com/di-oauth2-service/oauth/grant/service_ticket";
const CLIENT_ID = "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2";
const SERVICE_URL = "https://sso.garmin.com/sso/embed";

// Mobile GCM headers expected by the DI endpoint.
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

// CORS headers for any origin (called from user's Vercel app)
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return Response.json(
        { error: "POST only" },
        { status: 405, headers: corsHeaders }
      );
    }

    try {
      const { ticket } = await request.json();
      if (!ticket) {
        return Response.json(
          { error: "No ticket" },
          { status: 400, headers: corsHeaders }
        );
      }
      if (typeof ticket !== "string" || !ticket.startsWith("ST-")) {
        return Response.json(
          { error: "Ticket must be a Garmin CAS service ticket (starts with ST-)" },
          { status: 400, headers: corsHeaders }
        );
      }

      // Basic auth with empty password, per garminconnect 0.3.0 reference impl.
      const basicAuth = "Basic " + btoa(`${CLIENT_ID}:`);

      const body = new URLSearchParams({
        client_id: CLIENT_ID,
        service_ticket: ticket,
        grant_type: DI_GRANT_TYPE,
        service_url: SERVICE_URL,
      });

      const diResp = await fetch(DI_TOKEN_URL, {
        method: "POST",
        headers: { ...DI_HEADERS, Authorization: basicAuth },
        body,
      });

      if (!diResp.ok) {
        const text = await diResp.text();
        return Response.json(
          {
            error: `DI token exchange failed (${diResp.status}): ${text.slice(0, 300)}`,
          },
          { status: 502, headers: corsHeaders }
        );
      }

      const di = await diResp.json();
      if (!di.access_token || !di.refresh_token) {
        return Response.json(
          { error: "DI response missing expected tokens" },
          { status: 502, headers: corsHeaders }
        );
      }

      // Extract the actual client_id from the JWT payload in case Garmin's
      // backend promoted us to a newer rotation (2025Q2 → 2025Q4, etc.)
      const jwtClientId = extractClientIdFromJwt(di.access_token) || CLIENT_ID;

      return Response.json(
        {
          di_token: di.access_token,
          di_refresh_token: di.refresh_token,
          di_client_id: jwtClientId,
          expires_in: di.expires_in,
          refresh_token_expires_in: di.refresh_token_expires_in,
          scope: di.scope,
        },
        { headers: corsHeaders }
      );
    } catch (e) {
      return Response.json(
        { error: e.message || "Internal error" },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};

/** Parse a JWT payload (no signature check) and extract `client_id`. */
function extractClientIdFromJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    // atob in Workers handles standard base64; payloads are base64url so we fix pad.
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return payload.client_id || null;
  } catch {
    return null;
  }
}
