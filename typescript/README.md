# hevy2garmin (TypeScript)

The TypeScript build of [hevy2garmin](https://github.com/drkostas/hevy2garmin). Same job as the Python package: turn a Hevy workout into a Garmin FIT file with correct exercise names, sets, reps, weights, calorie estimation, and optional heart rate, then upload it to Garmin Connect.

It ships as an npm package so you can run the sync from Node, a serverless function, or a Vercel cron without a Python runtime. The Python package on PyPI stays fully supported; this is the same logic in TypeScript for JS/TS projects.

> This lives in the [`typescript/`](https://github.com/drkostas/hevy2garmin/tree/main/typescript) folder of the monorepo, next to the Python package in [`src/`](https://github.com/drkostas/hevy2garmin/tree/main/src). One repo, two runtimes.

## Install

```bash
npm install hevy2garmin
```

FIT generation and the exercise mapper work on their own. The Garmin upload path needs two peer dependencies:

```bash
npm install garmin-auth pg
```

`garmin-auth` handles Garmin Connect authentication (token storage and refresh). `pg` is only used when you store tokens in Postgres.

## Usage

### Exercise mapping

```ts
import { lookupExercise } from "hevy2garmin";

const { category, subcategory, name } = lookupExercise("Bench Press (Barbell)");
// category 0, subcategory 1, name "Bench Press (Barbell)"
```

### FIT generation

```ts
import { generateFit } from "hevy2garmin";

// hevyWorkout is a workout object from the Hevy API.
// See https://docs.hevy.com/#tag/workout/operation/workout
const result = generateFit(hevyWorkout, /* hrSamples */ null, {
  profile: { birthYear: 1994, weightKg: 78, vo2max: 50 },
});

console.log(result.exercises, result.total_sets, result.calories);
// result.fit is a Uint8Array you can write to disk or upload.
```

Heart rate is optional. Pass an array of bpm integers for an even distribution, or `{ time, hr }` objects to place real samples at their offsets.

### Pull workouts from Hevy

```ts
import { HevyClient } from "hevy2garmin";

const hevy = new HevyClient(process.env.HEVY_API_KEY);
const count = await hevy.getWorkoutCount();
const recent = await hevy.getWorkouts(1, 10); // page 1, 10 per page
```

### Upload to Garmin Connect

```ts
import { generateFit, uploadFit, renameActivity } from "hevy2garmin";
import { GarminAuth, DBTokenStore } from "garmin-auth";

const client = await new GarminAuth({
  store: new DBTokenStore(process.env.DATABASE_URL!),
}).client();

const { fit } = generateFit(hevyWorkout, null, { profile });
const { activityId } = await uploadFit(client, fit, hevyWorkout.start_time);
if (activityId) await renameActivity(client, activityId, hevyWorkout.title);
```

### Sync a workout (dedup, dry-run by default)

The sync engine decides which Hevy workouts still need to reach Garmin and
performs the upload. It never touches a database or the network directly: you
hand it a `SyncStore` (the ledger of synced and in-flight workouts), a lazily
built `GarminGateway`, and the Hevy fetch. `dryRun` defaults to `true`, so the
call below computes the decision without writing anything.

```ts
import { garminGateway, syncOneWorkout, type SyncStore } from "hevy2garmin";

const store: SyncStore = /* your ledger: Postgres, SQLite, a Map in tests */;
const deps = {
  store,
  gateway: async () => garminGateway(await garminAuth.client()),
  fetchWorkouts: () => hevy.getAllWorkouts(),
};

const preview = await syncOneWorkout(deps);                   // no writes
if (preview.wouldUpload) await syncOneWorkout(deps, { dryRun: false });
```

Three layers keep a workout from being uploaded twice: a terminal row in the
store, an activity already on Garmin at the same start time (matched, not
re-uploaded), and an atomic claim on the in-flight row so two workers never
race. `reconcilePending` and `retryPending` recover a stuck upload the same
way, checking Garmin before ever re-uploading.

## API

| Export | What it does |
| --- | --- |
| `HevyClient` | Read the Hevy API (`getWorkoutCount`, `getWorkouts`, `getWorkout`, `getAllWorkouts`). |
| `generateFit` | Build a FIT file (`Uint8Array`) from a Hevy workout, with optional HR. |
| `calcCalories` | Keytel-with-VO2max calorie estimate from HR samples. |
| `lookupExercise` | Map a Hevy exercise name to its Garmin FIT category. |
| `uploadFit` / `renameActivity` / `setDescription` / `deleteActivity` | Manage the activity on Garmin Connect (needs a `garmin-auth` client). |
| `HEVY_TO_GARMIN`, `TEMPLATE_TO_GARMIN` | The raw exercise mapping tables. |
| `syncOneWorkout` / `listCandidates` | The sync engine: next unsynced workout, three-layer dedup, dry-run by default. |
| `reconcilePending` / `retryPending` | Recover a stuck in-flight upload without ever double-uploading. |
| `SyncStore` / `GarminGateway` / `garminGateway` | The two boundaries the engine talks through; `garminGateway` wraps a `garmin-auth` client. |
| `isUnsynced` / `filterUnsynced` / `pickNextUnsynced` / `summarizeDedup` | Pure dedup decisions over a workout list. |
| `generateDescription` | The activity description text every upload path attaches. |

## Develop

```bash
cd typescript
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

The FIT output is checked against the Python package with shared fixtures, so both runtimes produce the same file for the same workout.

## License

MIT, same as the rest of the repository.
