"""CLI for hevy2garmin."""

from __future__ import annotations

import argparse
import getpass
import logging
import sys

from hevy2garmin import db
from hevy2garmin.config import is_configured, load_config, save_config
from hevy2garmin.mapper import save_custom_mapping
from hevy2garmin.sync import sync


def _require_config(args: argparse.Namespace) -> None:
    """Check config exists, error if not (unless credentials passed via flags)."""
    if not is_configured() and not args.hevy_api_key:
        print("✗ Not configured. Run: hevy2garmin init")
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


def cmd_status(args: argparse.Namespace) -> None:
    """Show sync status."""
    if not is_configured():
        print("✗ Not configured. Run: hevy2garmin init")
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
                cat, _, _ = lookup_exercise(name)
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

    # serve
    serve_parser = subparsers.add_parser("serve", help="Start web dashboard")
    serve_parser.add_argument("-p", "--port", type=int, default=8123, help="Port (default: 8123)")
    serve_parser.add_argument("--host", default="0.0.0.0", help="Host (default: 0.0.0.0)")

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
            "status": cmd_status,
            "list": cmd_list,
            "unmapped": cmd_unmapped,
            "map": cmd_map,
            "unsync": cmd_unsync,
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
