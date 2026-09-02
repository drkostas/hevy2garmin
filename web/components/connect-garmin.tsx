"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Connect-Garmin form for the setup page. Three modes:
 *   1. email/password → POST /api/garmin-login
 *   2. two-factor code → POST /api/garmin-login-mfa (when step 1 returns needs_mfa)
 *   3. manual ticket fallback → sign in on Garmin's own widget, paste the
 *      resulting ST-… ticket, exchange it at the CF Worker /exchange for DI
 *      tokens, then POST /api/garmin-ticket. Revealed when Garmin forces a
 *      captcha (needs_captcha), or on demand via "having trouble?".
 *
 * Credentials are forwarded to the login Worker only to obtain a token and are
 * never stored or echoed back.
 */

// The Garmin embed sign-in widget (opens in a new tab); after login the URL
// carries the ST-… ticket the user pastes back.
const GARMIN_SSO_URL =
  "https://sso.garmin.com/sso/signin?id=gauth-widget&embedWidget=true" +
  "&gauthHost=https://sso.garmin.com/sso" +
  "&service=https://sso.garmin.com/sso/embed" +
  "&source=https://sso.garmin.com/sso/embed" +
  "&redirectAfterAccountLoginUrl=https://sso.garmin.com/sso/embed" +
  "&redirectAfterAccountCreationUrl=https://sso.garmin.com/sso/embed";
const WORKER_EXCHANGE_URL = "https://hevy2garmin-exchange-di.gkos.workers.dev/exchange";

/** Pull the ST-… ticket out of a pasted embed URL, or accept a raw ticket. */
function extractTicket(raw: string): string | null {
  const m = raw.match(/ticket=([^&\s]+)/);
  if (m) return m[1];
  const t = raw.trim();
  return t.startsWith("ST-") ? t : null;
}

export function ConnectGarmin({ connected }: { connected: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [ticketUrl, setTicketUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  type Reply = { status?: string; error?: string; session_id?: string };

  function onSuccess() {
    setPassword("");
    setMfaCode("");
    setTicketUrl("");
    setSessionId(null);
    setManual(false);
    setOkMsg("Garmin connected.");
    router.refresh();
  }

  async function startLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    if (!email.trim() || !password) {
      setError("Enter your Garmin email and password.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/garmin-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const d = (await res.json().catch(() => ({}))) as Reply;
      if (d.status === "connected") {
        onSuccess();
      } else if (d.status === "needs_mfa") {
        setSessionId(d.session_id ?? "");
        setError(null);
      } else if (d.status === "needs_captcha") {
        // Garmin wants a captcha the automated flow can't clear → manual ticket.
        setManual(true);
        setError(null);
      } else {
        if (d.status === "rate_limited") void recordCooldown();
        setError(d.error ?? `Request failed (${res.status}).`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!mfaCode.trim()) {
      setError("Enter the verification code Garmin sent you.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/garmin-login-mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, mfa_code: mfaCode.trim() }),
      });
      const d = (await res.json().catch(() => ({}))) as Reply;
      if (d.status === "connected") onSuccess();
      else setError(d.error ?? `Request failed (${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Best-effort record of a Garmin rate-limit cooldown. */
  async function recordCooldown() {
    try {
      await fetch("/api/garmin-rate-limited", { method: "POST" });
    } catch {
      /* best-effort */
    }
  }

  async function submitTicket(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const ticket = extractTicket(ticketUrl);
    if (!ticket) {
      setError("Paste the full URL after signing in (it contains ?ticket=ST-…).");
      return;
    }
    setBusy(true);
    try {
      // Exchange the ticket for DI tokens at the CF Worker (returns them directly).
      const ex = await fetch(WORKER_EXCHANGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      const tokens = (await ex.json().catch(() => ({}))) as {
        di_token?: string;
        di_refresh_token?: string;
        di_client_id?: string;
        error?: string;
      };
      if (!ex.ok || !tokens.di_token || !tokens.di_refresh_token || !tokens.di_client_id) {
        setError(tokens.error ?? "That ticket could not be exchanged. Sign in again for a fresh one.");
        return;
      }
      const res = await fetch("/api/garmin-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokens: {
            di_token: tokens.di_token,
            di_refresh_token: tokens.di_refresh_token,
            di_client_id: tokens.di_client_id,
          },
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && d.ok) onSuccess();
      else setError(d.error ?? `Could not store the session (${res.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:border-teal focus:outline-none";

  // Mode 3: manual ticket-paste fallback
  if (manual) {
    return (
      <form onSubmit={submitTicket} className="space-y-3">
        <p className="text-xs text-text-muted">
          Garmin needs you to sign in on its own page. Do these in order:
        </p>
        <ol className="ml-4 list-decimal space-y-1 text-xs text-text-secondary">
          <li>
            <a href={GARMIN_SSO_URL} target="_blank" rel="noreferrer" className="text-teal underline">
              Sign in to Garmin
            </a>{" "}
            in the new tab (complete any verification there).
          </li>
          <li>When it finishes, copy the full URL from the address bar.</li>
          <li>Paste it below and press Connect.</li>
        </ol>
        <input
          type="text"
          value={ticketUrl}
          onChange={(e) => setTicketUrl(e.target.value)}
          placeholder="https://sso.garmin.com/sso/embed?ticket=ST-…"
          className={inputCls}
          aria-label="Garmin ticket URL"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50"
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          <button
            type="button"
            onClick={() => { setManual(false); setError(null); }}
            disabled={busy}
            className="text-xs text-text-muted underline hover:text-text-secondary disabled:opacity-50"
          >
            Back to password sign-in
          </button>
          {error && <span className="text-xs text-danger" role="alert">{error}</span>}
        </div>
      </form>
    );
  }

  // Mode 2: verification code
  if (sessionId !== null) {
    return (
      <form onSubmit={submitMfa} className="space-y-3">
        <p className="text-xs text-text-muted">
          This Garmin account uses two-factor authentication. Enter the
          verification code from your authenticator app or SMS.
        </p>
        <input
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={mfaCode}
          onChange={(e) => setMfaCode(e.target.value)}
          placeholder="Verification code"
          className={inputCls}
          aria-label="Verification code"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={busy} className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50">
            {busy ? "Verifying…" : "Verify code"}
          </button>
          <button type="button" onClick={() => { setSessionId(null); setMfaCode(""); setError(null); }} disabled={busy} className="text-xs text-text-muted underline hover:text-text-secondary disabled:opacity-50">
            Start over
          </button>
          {error && <span className="text-xs text-danger" role="alert">{error}</span>}
        </div>
      </form>
    );
  }

  // Mode 1: email + password
  return (
    <form onSubmit={startLogin} className="space-y-3">
      <p className="text-xs text-text-muted">
        {connected
          ? "Garmin is connected. Sign in again to refresh the session."
          : "Sign in with your Garmin Connect account. Your password is used only to get a token and is never stored."}
      </p>
      <input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Garmin email" className={inputCls} aria-label="Garmin email" />
      <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Garmin password" className={inputCls} aria-label="Garmin password" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-teal/20 px-4 py-2 text-sm font-medium text-teal transition-colors hover:bg-teal/30 disabled:opacity-50">
          {busy ? "Connecting…" : "Connect Garmin"}
        </button>
        {okMsg && <span className="text-xs text-success">{okMsg}</span>}
        {error && <span className="text-xs text-danger" role="alert">{error}</span>}
      </div>
      <p className="text-xs text-text-muted">
        Two-factor accounts are supported. Having trouble, or Garmin asking for a
        captcha?{" "}
        <button type="button" onClick={() => { setManual(true); setError(null); }} className="text-teal underline">
          Sign in on Garmin&apos;s site instead
        </button>
        .
      </p>
    </form>
  );
}
