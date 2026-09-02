"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const params = useSearchParams();
  // Surface a server-provided ?error= on first render (e.g. an expired session
  // redirect), matching the Python login form's error passthrough.
  const initialError = params.get("error") ?? "";
  const [shownInitial, setShownInitial] = useState(false);
  if (initialError && !shownInitial) {
    setShownInitial(true);
    setError(initialError);
  }

  function safeNext(raw: string | null): string {
    if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
    return raw;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    const next = safeNext(params.get("next"));
    try {
      const res = await fetch(`/api/login?next=${encodeURIComponent(next)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; next?: string; error?: string };
      if (res.ok && data.ok) {
        router.push(safeNext(data.next ?? next));
        router.refresh();
      } else {
        // Server message covers both "Incorrect password" and the rate-limit
        // "Too many attempts. Try again in …" cooldown (HTTP 429).
        setError(data.error ?? "Incorrect password");
        setLoading(false);
      }
    } catch {
      setError("Something went wrong. Try again.");
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-2xl font-bold text-text">hevy2garmin</h1>
      <p className="mb-6 text-sm text-text-secondary">Enter your dashboard password.</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="rounded-lg border border-border bg-surface px-4 py-3 text-text outline-none focus:border-teal"
        />
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={loading || password.length === 0}
          className="rounded-lg bg-teal px-4 py-3 font-medium text-black transition-opacity disabled:opacity-50"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
