"""CLI for hevy2garmin."""

from __future__ import annotations

import argparse
import getpass
import logging
import json
import sys

from hevy2garmin import db
from hevy2garmin.config import is_configured, load_config, save_config
from hevy2garmin.mapper import save_custom_mapping
from hevy2garmin.sync import sync, sync_routines


def _not_configured_message() -> str:
    """Context-aware 'not configured' guidance. On the cloud/Actions path
    (DATABASE_URL set) 'hevy2garmin init' is the wrong advice — the real fix is
    the dashboard setup + a matching DATABASE_URL."""
    from hevy2garmin.db import get_database_url

    if get_database_url():
        return (
            "✗ Not configured: no Hevy/Garmin credentials found in the database.\n"
            "  Finish setup in your deployed dashboard (add your Hevy API key and connect\n"
            "  Garmin), and make sure the DATABASE_URL here is the SAME database your\n"
            "  deployment uses (check the GitHub secret matches your Vercel env var)."
        )
    return (
        "✗ Not configured. On GitHub Actions / cloud, set the DATABASE_URL secret to your\n"
        "  deployment's database (the same Neon URL your dashboard uses). Running locally?\n"
        "  Run: hevy2garmin init"
    )


def _require_config(args: argparse.Namespace) -> None:
    """Check config exists, error if not (unless credentials passed via flags)."""
    if not is_configured() and not args.hevy_api_key:
        print(_not_configured_message())
        sys.exit(1)


def cmd_init(args: argparse.Namespace) -> None:
    """Interactive setup wizard."""
    print("hevy2garmin setup\n")

    config = load_config()

    # Hevy API key
    current_key = config.get("hevy_api_key", "")
    key_display = f" (current: {current_key[:8]}...)" if current_key else ""
    key = input(f"Hevy API key{key_display}: ").strip() or current_key
    if not key:
        print("✗ API key required. Get it from hevyapp.com → Settings → Developer")
        sys.exit(1)
    config["hevy_api_key"] = key

    # Validate Hevy key
    print("  Checking Hevy API key...", end=" ", flush=True)
    try:
        from hevy2garmin.hevy import HevyClient
        count = HevyClient(api_key=key).get_workout_count()
        print(f"✓ {count} workouts found")
    except Exception as e:
        print(f"✗ Failed: {e}")
        sys.exit(1)

    # Garmin email
    current_email = config.get("garmin_email", "")
    email_display = f" (current: {current_email})" if current_email else ""
    email = input(f"Garmin email{email_display}: ").strip() or current_email
    config["garmin_email"] = email

    # Garmin password (optional — can use saved tokens)
    if email:
        pw = getpass.getpass("Garmin password (enter to skip if tokens exist): ")
        if pw:
            # Test login
            print("  Checking Garmin login...", end=" ", flush=True)
            try:
                from garmin_auth import GarminAuth
                auth = GarminAuth(email=email, password=pw)
                client = auth.login()
                print(f"✓ Authenticated as {client.display_name}")
            except Exception as e:
                print(f"✗ Failed: {e}")
                print("  You can fix this later. Continuing setup...")

    # User profile
    print("\nUser profile (for calorie estimation):")
    profile = config.get("user_profile", {})
    weight = input(f"  Weight in kg [{profile.get('weight_kg', 80.0)}]: ").strip()
    if weight:
        profile["weight_kg"] = float(weight)
    birth_year = input(f"  Birth year [{profile.get('birth_year', 1990)}]: ").strip()
    if birth_year:
        profile["birth_year"] = int(birth_year)
    sex = input(f"  Sex (male/female) [{profile.get('sex', 'male')}]: ").strip()
    if sex:
        profile["sex"] = sex
    config["user_profile"] = profile

    save_config(config)
    print(f"\n✓ Setup complete. Config saved to ~/.hevy2garmin/config.json")
    print(f"  Run: hevy2garmin sync")


def cmd_sync(args: argparse.Namespace) -> None:
    """Sync Hevy workouts to Garmin."""
    _require_config(args)

    overrides = {}
    if args.hevy_api_key:
        overrides["hevy_api_key"] = args.hevy_api_key
    if args.garmin_email:
        overrides["garmin_email"] = args.garmin_email
    if args.garmin_password:
        overrides["garmin_password"] = args.garmin_password

    result = sync(
        limit=args.limit,
        since=args.since,
        fetch_all=args.all,
        dry_run=args.dry_run,
        **overrides,
    )

    print(f"\n✓ Sync complete: {result['synced']} synced, {result['skipped']} skipped, {result['failed']} failed")
    if result.get("unmapped"):
        print(f"  ⚠ {len(result['unmapped'])} unmapped exercises — run: hevy2garmin unmapped")
    if result["failed"] > 0:
        sys.exit(1)


def cmd_sync_routines(args: argparse.Namespace) -> None:
    """Sync Hevy routines to Garmin as planned workouts."""
    _require_config(args)

    if args.list:
        cfg = load_config()
        from hevy2garmin.hevy import HevyClient
        hevy = HevyClient(api_key=args.hevy_api_key or cfg.get("hevy_api_key"))
        # Hevy caps /v1/routines at pageSize 10 — larger values return HTTP 400.
        page_size = min(args.limit or 10, 10)
        for r in hevy.get_routines(page=1, page_size=page_size).get("routines", []):
            synced = "✓" if db.get_synced_routine(r["id"]) else " "
            n = len(r.get("exercises", []))
            print(f"  [{synced}] {r.get('title', '?')} ({n} exercises)")
        return

    overrides = {}
    if args.hevy_api_key:
        overrides["hevy_api_key"] = args.hevy_api_key
    if args.garmin_email:
        overrides["garmin_email"] = args.garmin_email
    if args.garmin_password:
        overrides["garmin_password"] = args.garmin_password

    result = sync_routines(
        dry_run=args.dry_run,
        schedule_date=args.date,
        force=args.force,
        **overrides,
    )

    print(
        f"\n✓ Routine sync complete: {result['created']} created, "
        f"{result['updated']} updated, {result['skipped']} skipped, {result['failed']} failed"
        + (f", {result['scheduled']} scheduled" if result.get("scheduled") else "")
    )
    if result["failed"] > 0:
        sys.exit(1)


def cmd_status(args: argparse.Namespace) -> None:
    """Show sync status."""
    if not is_configured():
        print(_not_configured_message())
        sys.exit(1)

    count = db.get_synced_count()
    recent = db.get_recent_synced(5)
    print(f"Total synced: {count}")
    if recent:
        print("\nRecent:")
        for r in recent:
            print(f"  {r['synced_at']} | {r['title']} → garmin:{r['garmin_activity_id'] or '?'}")
    else:
        print("No workouts synced yet. Run: hevy2garmin sync")


def cmd_list(args: argparse.Namespace) -> None:
    """List recent Hevy workouts."""
    _require_config(args)
    cfg = load_config()
    from hevy2garmin.hevy import HevyClient
    hevy = HevyClient(api_key=args.hevy_api_key or cfg.get("hevy_api_key"))
    data = hevy.get_workouts(page=1, page_size=args.limit or 10)
    for w in data.get("workouts", []):
        synced = "✓" if db.is_synced(w["id"]) else " "
        exercises = len(w.get("exercises", []))
        start = (w.get("start_time") or w.get("startTime", ""))[:16]
        print(f"  [{synced}] {start} | {w.get('title', '?')} ({exercises} exercises)")


def cmd_unmapped(args: argparse.Namespace) -> None:
    """List exercises that couldn't be mapped to Garmin categories."""
    _require_config(args)
    cfg = load_config()
    from hevy2garmin.hevy import HevyClient
    from hevy2garmin.mapper import lookup_exercise

    hevy = HevyClient(api_key=args.hevy_api_key or cfg.get("hevy_api_key"))

    # Scan recent workouts for unmapped exercises
    unmapped: dict[str, int] = {}
    page = 1
    while page <= 10:  # check last 10 pages
        data = hevy.get_workouts(page=page, page_size=10)
        for w in data.get("workouts", []):
            for ex in w.get("exercises", []):
                name = ex.get("title") or ex.get("name", "")
                cat, _, _ = lookup_exercise(name, ex.get("exercise_template_id"))
                if cat == 65534:
                    unmapped[name] = unmapped.get(name, 0) + 1
        if page >= data.get("page_count", page):
            break
        page += 1

    if not unmapped:
        print("✓ All exercises are mapped!")
    else:
        print(f"Found {len(unmapped)} unmapped exercises:\n")
        for name, count in sorted(unmapped.items(), key=lambda x: -x[1]):
            print(f"  {name} (used {count}x)")
        print(f"\nAdd mappings: hevy2garmin map \"Exercise Name\" --category N --subcategory N")
        print("FIT SDK categories: https://developer.garmin.com/fit/overview/")


def cmd_unsync(args: argparse.Namespace) -> None:
    """Remove sync records so workouts can be re-synced."""
    if args.all:
        if not args.confirm:
            print("✗ --all requires --confirm to prevent accidents")
            sys.exit(1)
        count = db.unsync_all()
        print(f"✓ Removed {count} sync records. All workouts will re-appear as pending.")
        return

    if not args.hevy_id:
        print("✗ Provide a Hevy workout ID, or use --all --confirm")
        sys.exit(1)

    garmin_id = db.get_garmin_id(args.hevy_id)
    if not db.unsync(args.hevy_id):
        print(f"✗ No sync record found for {args.hevy_id}")
        sys.exit(1)

    print(f"✓ Removed sync record for {args.hevy_id}")
    if garmin_id:
        print(f"  Garmin activity: {garmin_id}")

    if args.delete and garmin_id:
        try:
            config = load_config()
            from hevy2garmin.garmin import get_client
            client = get_client(config.get("garmin_email"))
            client.delete_activity(int(garmin_id))
            print(f"  ✓ Deleted Garmin activity {garmin_id}")
        except Exception as e:
            print(f"  ✗ Failed to delete from Garmin: {e}")


def cmd_map(args: argparse.Namespace) -> None:
    """Add a custom exercise mapping."""
    save_custom_mapping(args.exercise_name, args.category, args.subcategory)
    print(f"✓ Mapped \"{args.exercise_name}\" → category {args.category}, subcategory {args.subcategory}")
    print(f"  Saved to ~/.hevy2garmin/custom_mappings.json")


def cmd_pending(args: argparse.Namespace) -> None:
    rows = [db.get_pending(args.hevy_id)] if args.hevy_id else db.list_pending()
    rows = [row for row in rows if row]
    if not rows:
        print("No pending uploads.")
        return
    for row in rows:
        print(json.dumps(row, indent=2, default=str, sort_keys=True))


def _garmin_client_from_config():
    cfg = load_config()
    from hevy2garmin.garmin import get_client
    return get_client(cfg.get("garmin_email"), cfg.get("garmin_password", ""), cfg.get("garmin_token_dir", "~/.garminconnect"))


def cmd_reconcile(args: argparse.Namespace) -> None:
    from hevy2garmin.sync import reconcile_pending
    result = reconcile_pending(db.get_db(), _garmin_client_from_config(), args.hevy_id)
    print(f"{args.hevy_id}: {result.status}")


def cmd_retry_failed(args: argparse.Namespace) -> None:
    if not args.confirm:
        print("✗ retry-failed requires --confirm")
        sys.exit(1)
    store = db.get_db()
    pending = store.get_pending(args.hevy_id)
    if not pending or pending.get("phase") != "failed":
        print("✗ Operation is not definitively failed; reconcile or abandon it instead")
        sys.exit(1)
    from hevy2garmin.sync import reconcile_pending, sync_one_workout
    reconcile_pending(store, _garmin_client_from_config(), args.hevy_id)
    pending = store.get_pending(args.hevy_id)
    if not pending or pending.get("phase") != "failed":
        print("✗ Operation is no longer eligible for retry")
        sys.exit(1)
    workout = (pending.get("payload") or {}).get("workout")
    if not workout:
        print("✗ Pending operation has no recoverable workout payload")
        sys.exit(1)
    store.delete_pending(args.hevy_id)
    result = sync_one_workout(workout, cfg=load_config(), garmin_client=_garmin_client_from_config(), force_upload=True, database=store)
    print(f"{args.hevy_id}: {result.status}")


def cmd_abandon_pending(args: argparse.Namespace) -> None:
    if args.confirm != args.hevy_id:
        print(f"✗ confirm the risk with: --confirm {args.hevy_id}")
        sys.exit(1)
    if not db.delete_pending(args.hevy_id):
        print(f"✗ No pending operation found for {args.hevy_id}")
        sys.exit(1)
    logging.getLogger("hevy2garmin").warning("ABANDONED pending Garmin upload for %s; an orphan may still appear", args.hevy_id)
    print(f"✓ Abandoned pending operation for {args.hevy_id}")


def cmd_mark_synced(args: argparse.Namespace) -> None:
    if args.garmin_id is not None and args.garmin_id <= 0:
        print("✗ Garmin ID must be a positive integer"); sys.exit(1)
    db.resolve_terminal(args.hevy_id, status="manual", garmin_activity_id=str(args.garmin_id) if args.garmin_id else None, reason=(args.reason or "")[:1000], source="manual")
    print(f"✓ Marked {args.hevy_id} as synced")


def cmd_skip(args: argparse.Namespace) -> None:
    db.resolve_terminal(args.hevy_id, status="skipped", reason=(args.reason or "")[:1000], source="manual")
    print(f"✓ Skipped {args.hevy_id}")


def cmd_hash_password(args: argparse.Namespace) -> None:
    """Generate an argon2 hash for the H2G_PASSWORD_HASH dashboard secret."""
    import nacl.pwhash

    pw = args.password
    if not pw:
        pw = getpass.getpass("Dashboard password: ")
        if pw != getpass.getpass("Confirm password: "):
            print("✗ Passwords do not match", file=sys.stderr)
            sys.exit(1)
    if not pw:
        print("✗ Empty password", file=sys.stderr)
        sys.exit(1)
    print(nacl.pwhash.argon2id.str(pw.encode()).decode())
    print(
        "\nSet this value as H2G_PASSWORD_HASH (and leave H2G_PASSWORD unset) so the "
        "plaintext password never lives in your environment.",
        file=sys.stderr,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="hevy2garmin",
        description="Sync Hevy gym workouts to Garmin Connect",
    )
    parser.add_argument("--hevy-api-key", help="Hevy API key (or HEVY_API_KEY env var)")
    parser.add_argument("--garmin-email", help="Garmin email (or GARMIN_EMAIL env var)")
    parser.add_argument("--garmin-password", help="Garmin password (or GARMIN_PASSWORD env var)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose logging")
    parser.add_argument("-q", "--quiet", action="store_true", help="Suppress logging")

    subparsers = parser.add_subparsers(dest="command")

    # init
    subparsers.add_parser("init", help="Interactive setup wizard")

    # sync
    sync_parser = subparsers.add_parser("sync", help="Sync workouts to Garmin")
    sync_parser.add_argument("-n", "--limit", type=int, help="Max workouts to sync")
    sync_parser.add_argument("--since", help="Sync workouts after this date (YYYY-MM-DD)")
    sync_parser.add_argument("--all", action="store_true", help="Sync entire history")
    sync_parser.add_argument("--dry-run", action="store_true", help="Generate FIT files without uploading")

    # sync-routines
    routines_parser = subparsers.add_parser(
        "sync-routines", help="Sync Hevy routines to Garmin as planned workouts"
    )
    routines_parser.add_argument("--dry-run", action="store_true", help="Build payloads without calling Garmin")
    routines_parser.add_argument("--force", action="store_true", help="Re-create even routines already synced (deletes & recreates)")
    routines_parser.add_argument("--date", help="Also schedule workouts on this date (YYYY-MM-DD)")
    routines_parser.add_argument("--list", action="store_true", help="List Hevy routines and their sync status")
    routines_parser.add_argument("-n", "--limit", type=int, help="Number of routines to list with --list")

    # status
    subparsers.add_parser("status", help="Show sync status")

    # list
    list_parser = subparsers.add_parser("list", help="List recent Hevy workouts")
    list_parser.add_argument("-n", "--limit", type=int, default=10, help="Number of workouts")

    # unmapped
    subparsers.add_parser("unmapped", help="List unmapped exercises")

    # map
    map_parser = subparsers.add_parser("map", help="Add custom exercise mapping")
    map_parser.add_argument("exercise_name", help="Hevy exercise name (exact match)")
    map_parser.add_argument("--category", type=int, required=True, help="FIT SDK exercise category")
    map_parser.add_argument("--subcategory", type=int, required=True, help="FIT SDK exercise subcategory")

    # unsync
    unsync_parser = subparsers.add_parser("unsync", help="Remove sync record(s) so workouts can be re-synced")
    unsync_parser.add_argument("hevy_id", nargs="?", help="Hevy workout ID to unsync")
    unsync_parser.add_argument("--all", action="store_true", help="Remove ALL sync records (requires --confirm)")
    unsync_parser.add_argument("--confirm", action="store_true", help="Required with --all")
    unsync_parser.add_argument("--delete", action="store_true", help="Also delete the Garmin activity")

    pending_parser = subparsers.add_parser("pending", help="List or inspect parked uploads")
    pending_parser.add_argument("hevy_id", nargs="?")
    reconcile_parser = subparsers.add_parser("reconcile", help="Recover a parked upload without resubmitting")
    reconcile_parser.add_argument("hevy_id")
    retry_parser = subparsers.add_parser("retry-failed", help="Explicitly retry a definitive rejection")
    retry_parser.add_argument("hevy_id"); retry_parser.add_argument("--confirm", action="store_true")
    abandon_parser = subparsers.add_parser("abandon-pending", help="Release a parked upload block")
    abandon_parser.add_argument("hevy_id"); abandon_parser.add_argument("--confirm", metavar="HEVY_ID")
    manual_parser = subparsers.add_parser("mark-synced", help="Manually mark a workout terminal")
    manual_parser.add_argument("hevy_id"); manual_parser.add_argument("--garmin-id", type=int); manual_parser.add_argument("--reason")
    skip_parser = subparsers.add_parser("skip", help="Permanently skip a workout")
    skip_parser.add_argument("hevy_id"); skip_parser.add_argument("--reason")

    # serve
    serve_parser = subparsers.add_parser("serve", help="Start web dashboard")
    serve_parser.add_argument("-p", "--port", type=int, default=8123, help="Port (default: 8123)")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")

    # hash-password
    hashpw_parser = subparsers.add_parser(
        "hash-password", help="Generate an argon2 hash for H2G_PASSWORD_HASH")
    hashpw_parser.add_argument("password", nargs="?", help="Password (omit to be prompted securely)")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    level = logging.DEBUG if args.verbose else (logging.CRITICAL if args.quiet else logging.INFO)
    logging.basicConfig(format="%(message)s", level=level, force=True)

    try:
        if args.command == "serve":
            from hevy2garmin.server import run_server
            run_server(host=args.host, port=args.port)
            return

        commands = {
            "init": cmd_init,
            "sync": cmd_sync,
            "sync-routines": cmd_sync_routines,
            "status": cmd_status,
            "list": cmd_list,
            "unmapped": cmd_unmapped,
            "map": cmd_map,
            "unsync": cmd_unsync,
            "pending": cmd_pending,
            "reconcile": cmd_reconcile,
            "retry-failed": cmd_retry_failed,
            "abandon-pending": cmd_abandon_pending,
            "mark-synced": cmd_mark_synced,
            "skip": cmd_skip,
            "hash-password": cmd_hash_password,
        }
        commands[args.command](args)
    except RuntimeError as e:
        print(f"\n✗ Error: {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(130)


if __name__ == "__main__":
    main()
