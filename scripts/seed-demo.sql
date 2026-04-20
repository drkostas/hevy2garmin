-- seed-demo.sql — Realistic fake data for hevy2garmin demo instance
-- Run against a fresh Postgres database after schema migration.

-- ── synced_workouts (25 rows) ─────────────────────────────────────────────────

INSERT INTO synced_workouts (hevy_id, garmin_activity_id, title, synced_at, calories, avg_hr, status, hevy_updated_at, sync_method) VALUES
('demo_a1b2c3d4-1111-4000-8000-000000000001', '18234567890', 'Push Day A — Chest & Triceps', NOW() - INTERVAL '1 day', 412, 118, 'success', NOW() - INTERVAL '1 day' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000002', '18234567891', 'Pull Day B — Back & Biceps', NOW() - INTERVAL '2 days', 387, 122, 'success', NOW() - INTERVAL '2 days' - INTERVAL '1 hour', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000003', '18234567892', 'Leg Day — Squats & RDL', NOW() - INTERVAL '3 days', 524, 135, 'success', NOW() - INTERVAL '3 days' - INTERVAL '3 hours', 'merge'),
('demo_a1b2c3d4-1111-4000-8000-000000000004', '18234567893', 'Full Body Hypertrophy', NOW() - INTERVAL '4 days', 478, 128, 'success', NOW() - INTERVAL '4 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000005', '18234567894', 'Upper Body Strength', NOW() - INTERVAL '5 days', 356, 115, 'success', NOW() - INTERVAL '5 days' - INTERVAL '1 hour', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000006', '18234567895', 'Shoulder & Arms', NOW() - INTERVAL '6 days', 298, 108, 'success', NOW() - INTERVAL '6 days' - INTERVAL '4 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000007', '18234567896', 'Push Day B — Incline Focus', NOW() - INTERVAL '8 days', 425, 121, 'success', NOW() - INTERVAL '8 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000008', '18234567897', 'Pull Day A — Deadlift & Rows', NOW() - INTERVAL '9 days', 512, 138, 'success', NOW() - INTERVAL '9 days' - INTERVAL '3 hours', 'merge'),
('demo_a1b2c3d4-1111-4000-8000-000000000009', '18234567898', 'Leg Day — Front Squats & Lunges', NOW() - INTERVAL '10 days', 498, 132, 'success', NOW() - INTERVAL '10 days' - INTERVAL '1 hour', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000010', '18234567899', 'Push Day A — Chest & Triceps', NOW() - INTERVAL '11 days', 405, 119, 'success', NOW() - INTERVAL '11 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000011', '18234567900', 'Full Body Power', NOW() - INTERVAL '12 days', 562, 142, 'success', NOW() - INTERVAL '12 days' - INTERVAL '5 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000012', '18234567901', 'Pull Day B — Back & Biceps', NOW() - INTERVAL '14 days', 374, 120, 'success', NOW() - INTERVAL '14 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000013', '18234567902', 'Upper Body Hypertrophy', NOW() - INTERVAL '15 days', 345, 113, 'success', NOW() - INTERVAL '15 days' - INTERVAL '1 hour', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000014', '18234567903', 'Leg Day — Squats & RDL', NOW() - INTERVAL '16 days', 531, 137, 'success', NOW() - INTERVAL '16 days' - INTERVAL '3 hours', 'merge'),
('demo_a1b2c3d4-1111-4000-8000-000000000015', '18234567904', 'Shoulder & Arms', NOW() - INTERVAL '17 days', 287, 105, 'success', NOW() - INTERVAL '17 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000016', '18234567905', 'Push Day B — Incline Focus', NOW() - INTERVAL '18 days', 418, 120, 'success', NOW() - INTERVAL '18 days' - INTERVAL '4 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000017', '18234567906', 'Pull Day A — Deadlift & Rows', NOW() - INTERVAL '20 days', 495, 134, 'success', NOW() - INTERVAL '20 days' - INTERVAL '1 hour', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000018', '18234567907', 'Full Body Hypertrophy', NOW() - INTERVAL '21 days', 467, 126, 'success', NOW() - INTERVAL '21 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000019', '18234567908', 'Leg Day — Front Squats & Lunges', NOW() - INTERVAL '22 days', 515, 133, 'success', NOW() - INTERVAL '22 days' - INTERVAL '3 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000020', '18234567909', 'Push Day A — Chest & Triceps', NOW() - INTERVAL '23 days', 398, 117, 'success', NOW() - INTERVAL '23 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000021', '18234567910', 'Upper Body Strength', NOW() - INTERVAL '24 days', 362, 114, 'success', NOW() - INTERVAL '24 days' - INTERVAL '1 hour', 'merge'),
('demo_a1b2c3d4-1111-4000-8000-000000000022', '18234567911', 'Shoulder & Arms', NOW() - INTERVAL '25 days', 275, 102, 'success', NOW() - INTERVAL '25 days' - INTERVAL '4 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000023', '18234567912', 'Pull Day B — Back & Biceps', NOW() - INTERVAL '27 days', 381, 121, 'success', NOW() - INTERVAL '27 days' - INTERVAL '2 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000024', '18234567913', 'Leg Day — Squats & RDL', NOW() - INTERVAL '28 days', 542, 139, 'success', NOW() - INTERVAL '28 days' - INTERVAL '3 hours', 'upload'),
('demo_a1b2c3d4-1111-4000-8000-000000000025', '18234567914', 'Full Body Power', NOW() - INTERVAL '30 days', 578, 145, 'success', NOW() - INTERVAL '30 days' - INTERVAL '1 hour', 'upload');


-- ── sync_log (15 rows) ────────────────────────────────────────────────────────

INSERT INTO sync_log (time, synced, skipped, failed, trigger) VALUES
(NOW() - INTERVAL '1 day', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '2 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '3 days', 2, 0, 0, 'manual'),
(NOW() - INTERVAL '4 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '5 days', 1, 1, 0, 'cron'),
(NOW() - INTERVAL '6 days', 1, 0, 0, 'auto'),
(NOW() - INTERVAL '8 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '9 days', 2, 0, 1, 'manual'),
(NOW() - INTERVAL '10 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '12 days', 3, 0, 0, 'manual'),
(NOW() - INTERVAL '14 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '16 days', 2, 1, 0, 'auto'),
(NOW() - INTERVAL '20 days', 1, 0, 0, 'cron'),
(NOW() - INTERVAL '24 days', 3, 0, 1, 'manual'),
(NOW() - INTERVAL '28 days', 2, 0, 0, 'cron');


-- ── custom_mappings (5 rows) ──────────────────────────────────────────────────

INSERT INTO custom_mappings (hevy_name, category, subcategory) VALUES
('Cable Lateral Raise', 14, 6),
('Rope Pushdown', 30, 5),
('Incline Smith Machine Press', 0, 12),
('Hack Squat (Machine)', 28, 15),
('Single Arm Cable Row', 23, 8);


-- ── app_cache (4 rows) ────────────────────────────────────────────────────────

INSERT INTO app_cache (key, value) VALUES
('user_profile', '{"weight_kg": 82, "birth_year": 1993, "sex": "male", "vo2max": 44}'),
('timing', '{"working_set_seconds": 40, "warmup_set_seconds": 25, "rest_between_sets_seconds": 75, "rest_between_exercises_seconds": 120}'),
('hr_fusion', '{"enabled": true}'),
('merge_settings', '{"merge_mode": true, "description_enabled": true, "merge_overlap_pct": 70, "merge_max_drift_min": 20}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;


-- ── platform_credentials (2 rows) ─────────────────────────────────────────────

INSERT INTO platform_credentials (platform, auth_type, credentials, status) VALUES
('hevy', 'api_key', '{"api_key": "demo_key_xxx"}', 'active'),
('garmin', 'password', '{"email": "demo@example.com"}', 'active')
ON CONFLICT (platform) DO UPDATE SET credentials = EXCLUDED.credentials, status = EXCLUDED.status;
