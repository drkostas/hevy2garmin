/**
 * The sync pipeline "how it works" diagram on the dashboard — a modern data-flow
 * visualization (glowing nodes, light particles streaming along the connectors,
 * the HR-enrichment loop) whose colours all come from the shared soma-style
 * tokens (var(--color-*) / currentColor), so restyling soma-style centrally
 * restyles this too. No hardcoded brand hex, no external fonts.
 *
 * Content is faithful to the real pipeline and MUST stay accurate:
 *   Hevy (fetch) → Map exercises (N built-in mappings) → Generate FIT
 *   (+ HR + calories) → Garmin (upload). HR loop: Garmin's daily heart-rate is
 *   matched to the workout, its calories computed, and fed back into the FIT.
 */

interface Stage {
  key: string;
  x: number;
  w: number;
  title: string;
  sub: string;
  dynamic?: boolean;
  cls: string; // sets `color` (currentColor) to a soma-style token
  titleVar: string; // fill for the title text
}

const STAGES: Stage[] = [
  { key: "hevy", x: 8, w: 188, title: "Hevy", sub: "Fetch your workout", cls: "pl-teal", titleVar: "var(--color-teal-light)" },
  { key: "map", x: 224, w: 188, title: "Map exercises", sub: "", dynamic: true, cls: "pl-warm", titleVar: "var(--color-warm-light)" },
  { key: "fit", x: 440, w: 188, title: "Generate FIT", sub: "sets · reps · HR · calories", cls: "pl-success", titleVar: "var(--color-success)" },
  { key: "garmin", x: 656, w: 188, title: "Garmin", sub: "Upload activity", cls: "pl-tealL", titleVar: "var(--color-teal-light)" },
];

export function PipelineDiagram({ mappingCount }: { mappingCount?: number }) {
  const mapSub = `${(mappingCount ?? 433).toLocaleString()} mappings`;

  return (
    <section className="mb-8 rounded-xl border border-border bg-surface-elevated p-4">
      <div className="mb-3 flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-muted" aria-hidden="true">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
        </svg>
        <h3 className="text-sm font-semibold text-text">Pipeline</h3>
        <span className="text-xs text-text-muted">— how a workout reaches Garmin</span>
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox="0 0 852 352"
          role="img"
          aria-label="Hevy fetches the workout, exercises are mapped to Garmin FIT categories, a FIT file is generated with heart-rate and calories, and it is uploaded to Garmin. In a loop, Garmin's daily heart-rate is matched to the workout and its calories are computed, feeding back into the FIT."
          className="block h-auto w-full min-w-[600px]"
          style={{ fontFamily: "inherit" }}
        >
          <defs>
            <style>{`
              .pl-teal { color: var(--color-teal); }
              .pl-tealL { color: var(--color-teal-light); }
              .pl-warm { color: var(--color-warm); }
              .pl-success { color: var(--color-success); }
              .pl-danger { color: var(--color-danger); }
              .pl-base { fill: var(--color-base); }
              .pl-sub { fill: var(--color-text-muted); }
              .pl-cbase { stroke: var(--color-border); }
              .pl-amb { stroke: var(--color-border-subtle); }
              .pl-flow { stroke-dasharray: 2 12; animation: plflow 0.75s linear infinite; }
              @keyframes plflow { to { stroke-dashoffset: -14; } }
              @media (prefers-reduced-motion: reduce) { .pl-flow, .pl-particle { display: none; } }
            `}</style>
            <filter id="pl-glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="3.2" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            <filter id="pl-soft" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="8" />
            </filter>
          </defs>

          {/* ambient guide lines */}
          <g className="pl-amb" strokeWidth="1">
            <line x1="0" y1="118" x2="852" y2="118" /><line x1="0" y1="330" x2="852" y2="330" />
          </g>

          {/* connector paths */}
          <path id="pl-c1" d="M196,120 L224,120" fill="none" />
          <path id="pl-c2" d="M412,120 L440,120" fill="none" />
          <path id="pl-c3" d="M628,120 L656,120" fill="none" />
          <path id="pl-h1" d="M750,168 C750,208 750,220 750,262" fill="none" />
          <path id="pl-h2" d="M656,300 C628,300 620,300 592,300" fill="none" />
          <path id="pl-h3" d="M534,262 C534,222 534,208 534,168" fill="none" />

          {/* base strokes + animated flow overlay */}
          <g fill="none" strokeLinecap="round">
            <use href="#pl-c1" className="pl-cbase" strokeWidth="2.5" /><use href="#pl-c2" className="pl-cbase" strokeWidth="2.5" /><use href="#pl-c3" className="pl-cbase" strokeWidth="2.5" />
            <g className="pl-teal"><use href="#pl-c1" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" /></g>
            <g className="pl-warm"><use href="#pl-c2" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" /></g>
            <g className="pl-success"><use href="#pl-c3" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" /></g>
            <use href="#pl-h1" className="pl-cbase" strokeWidth="2.5" /><use href="#pl-h2" className="pl-cbase" strokeWidth="2.5" /><use href="#pl-h3" className="pl-cbase" strokeWidth="2.5" />
            <g className="pl-danger">
              <use href="#pl-h1" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" style={{ animationDuration: "0.95s" }} />
              <use href="#pl-h2" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" style={{ animationDuration: "0.95s" }} />
              <use href="#pl-h3" className="pl-flow" stroke="currentColor" strokeWidth="2.5" strokeOpacity="0.8" style={{ animationDuration: "0.95s" }} />
            </g>
          </g>

          {/* streaming light particles */}
          <g filter="url(#pl-glow)" className="pl-particle">
            <circle r="3" className="pl-teal" fill="currentColor"><animateMotion dur="1.6s" repeatCount="indefinite"><mpath href="#pl-c1" /></animateMotion></circle>
            <circle r="3" className="pl-warm" fill="currentColor"><animateMotion dur="1.6s" begin="0.5s" repeatCount="indefinite"><mpath href="#pl-c2" /></animateMotion></circle>
            <circle r="3" className="pl-success" fill="currentColor"><animateMotion dur="1.6s" begin="0.9s" repeatCount="indefinite"><mpath href="#pl-c3" /></animateMotion></circle>
            <circle r="2.7" className="pl-danger" fill="currentColor"><animateMotion dur="2.6s" repeatCount="indefinite"><mpath href="#pl-h1" /></animateMotion></circle>
            <circle r="2.7" className="pl-danger" fill="currentColor"><animateMotion dur="2.6s" begin="0.9s" repeatCount="indefinite"><mpath href="#pl-h2" /></animateMotion></circle>
            <circle r="2.7" className="pl-danger" fill="currentColor"><animateMotion dur="3.2s" begin="1.4s" repeatCount="indefinite"><mpath href="#pl-h3" /></animateMotion></circle>
          </g>

          {/* top-row stage cards */}
          {STAGES.map((s) => (
            <g key={s.key} className={s.cls}>
              <rect x={s.x} y="76" width={s.w} height="88" rx="16" fill="currentColor" opacity="0.13" filter="url(#pl-soft)" />
              <rect x={s.x} y="76" width={s.w} height="88" rx="16" className="pl-base" stroke="currentColor" strokeOpacity="0.55" />
              <rect x={s.x} y="76" width={s.w} height="88" rx="16" fill="currentColor" opacity="0.07" />
              <rect x={s.x} y="76" width={s.w} height="3.5" rx="1.75" fill="currentColor" />
              <text x={s.x + s.w / 2} y="118" textAnchor="middle" fontSize="17" fontWeight="700" fill={s.titleVar}>{s.title}</text>
              <text x={s.x + s.w / 2} y="140" textAnchor="middle" fontSize="11.5" className="pl-sub">
                {s.dynamic ? mapSub : s.sub}
              </text>
            </g>
          ))}

          {/* Fetch HR data (teal-light, dashed, under Garmin) */}
          <g className="pl-tealL">
            <rect x="656" y="262" width="188" height="76" rx="16" className="pl-base" stroke="currentColor" strokeOpacity="0.4" strokeDasharray="7 4" />
            <text x="750" y="296" textAnchor="middle" fontSize="14.5" fontWeight="600" fill="var(--color-teal-light)">Fetch HR data</text>
            <text x="750" y="316" textAnchor="middle" fontSize="11" className="pl-sub">Daily watch monitoring</text>
          </g>

          {/* Match HR & calories (danger, under Generate FIT) */}
          <g className="pl-danger">
            <rect x="440" y="262" width="188" height="76" rx="16" fill="currentColor" opacity="0.11" filter="url(#pl-soft)" />
            <rect x="440" y="262" width="188" height="76" rx="16" className="pl-base" stroke="currentColor" strokeOpacity="0.5" />
            <rect x="440" y="262" width="188" height="76" rx="16" fill="currentColor" opacity="0.06" />
            <text x="534" y="296" textAnchor="middle" fontSize="14" fontWeight="600" fill="var(--color-danger)">Match HR &amp; calories</text>
            <text x="534" y="316" textAnchor="middle" fontSize="10.5" className="pl-sub">~90 bpm fallback</text>
          </g>
        </svg>
      </div>

      {/* legend */}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-teal" style={{ boxShadow: "0 0 10px var(--color-teal)" }} /> Workout data
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-danger" style={{ boxShadow: "0 0 10px var(--color-danger)" }} /> Heart-rate enrichment
        </span>
        <span>
          Runs when HR fusion is on — toggle it in{" "}
          <a href="/settings" className="text-teal underline">
            Settings
          </a>
          .
        </span>
      </div>
    </section>
  );
}
