"""Map Hevy exercise names to Garmin FIT category/subcategory IDs.

Each Garmin strength exercise is identified by a (category, subcategory) pair
of 16-bit unsigned integers defined in the FIT SDK.  This module provides a
static lookup table that translates free-text Hevy exercise names into those
numeric IDs so that uploaded workouts show the correct exercise in Garmin
Connect.

FIT SDK exercise categories used:
    BENCH_PRESS=0, CALF_RAISE=1, CARDIO=2, CARRY=3, CHOP=4, CORE=5,
    CRUNCH=6, CURL=7, DEADLIFT=8, FLYE=9, HIP_RAISE=10, HIP_STABILITY=11,
    HIP_SWING=12, HYPEREXTENSION=13, LATERAL_RAISE=14, LEG_CURL=15,
    LEG_RAISE=16, LUNGE=17, OLYMPIC_LIFT=18, PLANK=19, PLYO=20,
    PULL_UP=21, PUSH_UP=22, ROW=23, SHOULDER_PRESS=24,
    SHOULDER_STABILITY=25, SHRUG=26, SIT_UP=27, SQUAT=28, TOTAL_BODY=29,
    TRICEPS_EXTENSION=30, WARM_UP=31, RUN=32, UNKNOWN=65534
"""

from __future__ import annotations

from hevy2garmin.template_map import TEMPLATE_TO_GARMIN

# --------------------------------------------------------------------------- #
# Mapping: Hevy exercise name  ->  (FIT exercise category, subcategory)
# --------------------------------------------------------------------------- #

HEVY_TO_GARMIN: dict[str, tuple[int, int]] = {

    # ======================================================================= #
    #  CHEST – Bench Press (category 0)
    # ======================================================================= #
    "Bench Press (Barbell)":                    (0, 1),    # bench_press / barbell_bench_press
    "Bench Press (Cable)":                      (0, 20),   # bench_press / single_arm_cable_chest_press (closest cable bench)
    "Bench Press (Dumbbell)":                   (0, 6),    # bench_press / dumbbell_bench_press
    "Bench Press (Smith Machine)":              (0, 22),   # bench_press / smith_machine_bench_press
    "Bench Press - Close Grip (Barbell)":       (0, 4),    # bench_press / close_grip_barbell_bench_press
    "Bench Press - Wide Grip (Barbell)":        (0, 25),   # bench_press / wide_grip_barbell_bench_press
    "Decline Bench Press (Barbell)":            (0, 5),    # bench_press / decline_dumbbell_bench_press (closest decline)
    "Decline Bench Press (Dumbbell)":           (0, 5),    # bench_press / decline_dumbbell_bench_press
    "Decline Bench Press (Machine)":            (0, 5),    # bench_press / decline_dumbbell_bench_press (closest)
    "Decline Bench Press (Smith Machine)":      (0, 22),   # bench_press / smith_machine_bench_press (closest)
    "Feet Up Bench Press (Barbell)":            (0, 1),    # bench_press / barbell_bench_press (feet-up variant)
    "Floor Press (Barbell)":                    (0, 3),    # bench_press / barbell_floor_press
    "Floor Press (Dumbbell)":                   (0, 7),    # bench_press / dumbbell_floor_press
    "Incline Bench Press (Barbell)":            (0, 8),    # bench_press / incline_barbell_bench_press
    "Incline Bench Press (Dumbbell)":           (0, 9),    # bench_press / incline_dumbbell_bench_press
    "Incline Bench Press (Smith Machine)":      (0, 8),    # bench_press / incline_barbell_bench_press (closest)
    "Incline Chest Press (Machine)":            (0, 9),    # bench_press / incline_dumbbell_bench_press (closest machine)
    "Iso-Lateral Chest Press (Machine)":        (0, 6),    # bench_press / dumbbell_bench_press (closest)
    "Chest Press (Band)":                       (0, 1),    # bench_press / barbell_bench_press (closest)
    "Chest Press (Machine)":                    (0, 6),    # bench_press / dumbbell_bench_press (closest machine press)
    "Dumbbell Squeeze Press":                   (0, 6),    # bench_press / dumbbell_bench_press (squeeze variant)
    "Hex Press (Dumbbell)":                     (0, 6),    # bench_press / dumbbell_bench_press (hex variant)
    "JM Press (Barbell)":                       (0, 4),    # bench_press / close_grip_barbell_bench_press (closest)
    "Plate Press":                              (0, 12),   # bench_press / kettlebell_chest_press (closest plate press)
    "Plate Squeeze (Svend Press)":              (0, 12),   # bench_press / kettlebell_chest_press (closest svend press)

    # ======================================================================= #
    #  CHEST – Flyes (category 9)
    # ======================================================================= #
    "Butterfly (Pec Deck)":                     (9, 2),    # flye / dumbbell_flye (closest pec deck)
    "Cable Fly Crossovers":                     (9, 0),    # flye / cable_crossover
    "Chest Fly (Band)":                         (9, 2),    # flye / dumbbell_flye (closest band fly)
    "Chest Fly (Dumbbell)":                     (9, 2),    # flye / dumbbell_flye
    "Chest Fly (Machine)":                      (9, 2),    # flye / dumbbell_flye (closest machine fly)
    "Chest Fly (Suspension)":                   (9, 2),    # flye / dumbbell_flye (closest)
    "Decline Chest Fly (Dumbbell)":             (9, 1),    # flye / decline_dumbbell_flye
    "Incline Chest Fly (Dumbbell)":             (9, 3),    # flye / incline_dumbbell_flye
    "Low Cable Fly Crossovers":                 (9, 0),    # flye / cable_crossover (low angle)
    "Seated Chest Flys (Cable)":                (9, 0),    # flye / cable_crossover (seated)
    "Single Arm Cable Crossover":               (9, 0),    # flye / cable_crossover (single arm)

    # ======================================================================= #
    #  CHEST – Push Ups (category 22)
    # ======================================================================= #
    "Clap Push Ups":                            (22, 7),   # push_up / clapping_push_up
    "Decline Push Up":                          (22, 13),  # push_up / decline_push_up
    "Diamond Push Up":                          (22, 15),  # push_up / diamond_push_up
    "Incline Push Ups":                         (22, 27),  # push_up / incline_push_up
    "Kneeling Push Up":                         (22, 33),  # push_up / kneeling_push_up
    "One Arm Push Up":                          (22, 38),  # push_up / one_arm_push_up
    "Pike Pushup":                              (22, 49),  # push_up / shoulder_push_up (closest pike)
    "Plank Pushup":                             (22, 77),  # push_up / push_up (plank-to-pushup)
    "Push Up":                                  (22, 77),  # push_up / push_up
    "Push Up (Weighted)":                       (22, 40),  # push_up / weighted_push_up
    "Push Up - Close Grip":                     (22, 11),  # push_up / close_hands_push_up
    "Ring Push Up":                             (22, 75),  # push_up / ring_push_up

    # ======================================================================= #
    #  CHEST – Dips (category 30 – triceps_extension)
    # ======================================================================= #
    "Bench Dip":                                (30, 0),   # triceps_extension / bench_dip
    "Chest Dip":                                (30, 2),   # triceps_extension / body_weight_dip
    "Chest Dip (Assisted)":                     (30, 2),   # triceps_extension / body_weight_dip (assisted)
    "Chest Dip (Weighted)":                     (30, 40),  # triceps_extension / weighted_dip

    # ======================================================================= #
    #  CHEST – Pullovers (category 21 – pull_up)
    # ======================================================================= #
    "Pullover (Dumbbell)":                      (21, 8),   # pull_up / ez_bar_pullover (closest pullover)
    "Pullover (Machine)":                       (21, 8),   # pull_up / ez_bar_pullover (closest)

    # ======================================================================= #
    #  BACK – Rows (category 23)
    # ======================================================================= #
    "Bent Over Row (Band)":                     (23, 0),   # row / barbell_straight_leg_deadlift_to_row (closest band row)
    "Bent Over Row (Barbell)":                  (23, 46),  # row / bent_over_barbell_row
    "Bent Over Row (Dumbbell)":                 (23, 2),   # row / dumbbell_row
    "Chest Supported Incline Row (Dumbbell)":   (23, 40),  # row / chest_supported_dumbbell_row
    "Dumbbell Row":                             (23, 2),   # row / dumbbell_row
    "Face Pull":                                (23, 5),   # row / face_pull
    "Gorilla Row (Kettlebell)":                 (23, 9),   # row / kettlebell_row (closest)
    "Inverted Row":                             (23, 10),  # row / modified_inverted_row
    "Iso-Lateral High Row (Machine)":           (23, 18),  # row / seated_cable_row (closest)
    "Iso-Lateral Low Row":                      (23, 18),  # row / seated_cable_row (closest)
    "Iso-Lateral Row (Machine)":                (23, 2),   # row / dumbbell_row (closest)
    "Landmine Row":                             (23, 13),  # row / one_arm_bent_over_row (closest)
    "Low Row (Suspension)":                     (23, 26),  # row / suspended_inverted_row
    "Meadows Rows (Barbell)":                   (23, 13),  # row / one_arm_bent_over_row
    "Pendlay Row (Barbell)":                    (23, 46),  # row / bent_over_barbell_row (Pendlay variant)
    "Renegade Row (Dumbbell)":                  (23, 15),  # row / renegade_row
    "Seated Cable Row - Bar Grip":              (23, 18),  # row / seated_cable_row
    "Seated Cable Row - Bar Wide Grip":         (23, 33),  # row / wide_grip_seated_cable_row
    "Seated Cable Row - V Grip (Cable)":        (23, 32),  # row / v_grip_cable_row
    "Seated Row (Machine)":                     (23, 18),  # row / seated_cable_row (closest)
    "Single Arm Cable Row":                     (23, 20),  # row / single_arm_cable_row
    "Squat Row":                                (23, 18),  # row / seated_cable_row (closest)
    "T Bar Row":                                (23, 28),  # row / t_bar_row

    # ======================================================================= #
    #  BACK – Pull Ups / Lat Pulldown (category 21)
    # ======================================================================= #
    "Chin Up":                                  (21, 3),   # pull_up / close_grip_chin_up
    "Chin Up (Assisted)":                       (21, 3),   # pull_up / close_grip_chin_up (assisted)
    "Chin Up (Weighted)":                       (21, 4),   # pull_up / weighted_close_grip_chin_up
    "Kipping Pull Up":                          (21, 32),  # pull_up / kipping_pull_up
    "Kneeling Pulldown (band)":                 (21, 11),  # pull_up / kneeling_lat_pulldown
    "Lat Pulldown (Band)":                      (21, 13),  # pull_up / lat_pulldown (closest)
    "Lat Pulldown (Cable)":                     (21, 13),  # pull_up / lat_pulldown
    "Lat Pulldown (Machine)":                   (21, 13),  # pull_up / lat_pulldown (closest)
    "Lat Pulldown - Close Grip (Cable)":        (21, 5),   # pull_up / close_grip_lat_pulldown
    "Negative Pull Up":                         (21, 38),  # pull_up / pull_up (negative variant)
    "Pull Up":                                  (21, 38),  # pull_up / pull_up
    "Pull Up (Assisted)":                       (21, 0),   # pull_up / banded_pull_ups
    "Pull Up (Band)":                           (21, 0),   # pull_up / banded_pull_ups
    "Pull Up (Weighted)":                       (21, 24),  # pull_up / weighted_pull_up
    "Reverse Grip Lat Pulldown (Cable)":        (21, 18),  # pull_up / reverse_grip_pulldown
    "Ring Pull Up":                             (21, 38),  # pull_up / pull_up (ring variant)
    "Rope Straight Arm Pulldown":               (21, 20),  # pull_up / straight_arm_pulldown
    "Scapular Pull Ups":                        (21, 38),  # pull_up / pull_up (scapular variant)
    "Single Arm Lat Pulldown":                  (21, 13),  # pull_up / lat_pulldown (single arm)
    "Sternum Pull up (Gironda)":                (21, 38),  # pull_up / pull_up (sternum variant)
    "Straight Arm Lat Pulldown (Cable)":        (21, 20),  # pull_up / straight_arm_pulldown
    "Vertical Traction (Machine)":              (21, 13),  # pull_up / lat_pulldown (closest)
    "Wide Pull Up":                             (21, 26),  # pull_up / wide_grip_pull_up

    # ======================================================================= #
    #  BACK – Hyperextension (category 13)
    # ======================================================================= #
    "Back Extension (Hyperextension)":          (13, 25),  # hyperextension / spine_extension
    "Back Extension (Machine)":                 (13, 25),  # hyperextension / spine_extension (machine)
    "Back Extension (Weighted Hyperextension)":  (13, 26),  # hyperextension / weighted_spine_extension
    "Reverse Hyperextension":                   (13, 4),   # hyperextension / bent_knee_reverse_hyperextension

    # ======================================================================= #
    #  SHOULDERS – Shoulder Press (category 24)
    # ======================================================================= #
    "Arnold Press (Dumbbell)":                  (24, 1),   # shoulder_press / arnold_press
    "Kettlebell Shoulder Press":                (24, 15),  # shoulder_press / overhead_dumbbell_press (closest KB)
    "Overhead Press (Barbell)":                 (24, 14),  # shoulder_press / overhead_barbell_press
    "Overhead Press (Dumbbell)":                (24, 15),  # shoulder_press / overhead_dumbbell_press
    "Overhead Press (Smith Machine)":           (24, 20),  # shoulder_press / smith_machine_overhead_press
    "Push Press":                               (24, 3),   # shoulder_press / barbell_push_press
    "Seated Overhead Press (Barbell)":          (24, 16),  # shoulder_press / seated_barbell_shoulder_press
    "Seated Overhead Press (Dumbbell)":         (24, 17),  # shoulder_press / seated_dumbbell_shoulder_press
    "Seated Shoulder Press (Machine)":          (24, 20),  # shoulder_press / smith_machine_overhead_press (closest machine)
    "Shoulder Press (Dumbbell)":                (24, 15),  # shoulder_press / overhead_dumbbell_press
    "Shoulder Press (Machine Plates)":          (24, 20),  # shoulder_press / smith_machine_overhead_press (closest)
    "Single Arm Landmine Press (Barbell)":      (24, 18),  # shoulder_press / single_arm_dumbbell_shoulder_press (closest)
    "Standing Military Press (Barbell)":        (24, 14),  # shoulder_press / overhead_barbell_press

    # ======================================================================= #
    #  SHOULDERS – Lateral Raise (category 14)
    # ======================================================================= #
    "Around The World":                         (14, 32),  # lateral_raise / arm_circles (closest)
    "Chest Supported Y Raise (Dumbbell)":       (14, 10),  # lateral_raise / front_raise (closest Y-raise)
    "Front Raise (Band)":                       (14, 10),  # lateral_raise / front_raise
    "Front Raise (Barbell)":                    (14, 10),  # lateral_raise / front_raise
    "Front Raise (Cable)":                      (14, 5),   # lateral_raise / cable_front_raise
    "Front Raise (Dumbbell)":                   (14, 10),  # lateral_raise / front_raise
    "Front Raise (Suspension)":                 (14, 10),  # lateral_raise / front_raise (suspension)
    "Lateral Raise (Band)":                     (14, 11),  # lateral_raise / leaning_dumbbell_lateral_raise (closest band)
    "Lateral Raise (Cable)":                    (14, 14),  # lateral_raise / one_arm_cable_lateral_raise
    "Lateral Raise (Dumbbell)":                 (14, 11),  # lateral_raise / leaning_dumbbell_lateral_raise
    "Lateral Raise (Machine)":                  (14, 24),  # lateral_raise / seated_lateral_raise
    "Overhead Plate Raise":                     (14, 16),  # lateral_raise / plate_raises
    "Plate Front Raise":                        (14, 16),  # lateral_raise / plate_raises
    "Seated Lateral Raise (Dumbbell)":          (14, 24),  # lateral_raise / seated_lateral_raise
    "Single Arm Lateral Raise (Cable)":         (14, 14),  # lateral_raise / one_arm_cable_lateral_raise
    "Muscle Up":                                (14, 13),  # lateral_raise / muscle_up
    "Ring Dips":                                (14, 17),  # lateral_raise / ring_dip

    # ======================================================================= #
    #  SHOULDERS – Reverse Flyes / Rear Delt (category 9)
    # ======================================================================= #
    "Chest Supported Reverse Fly (Dumbbell)":   (9, 5),    # flye / kneeling_rear_flye (closest)
    "Rear Delt Reverse Fly (Cable)":            (9, 6),    # flye / single_arm_standing_cable_reverse_flye
    "Rear Delt Reverse Fly (Dumbbell)":         (9, 5),    # flye / kneeling_rear_flye
    "Rear Delt Reverse Fly (Machine)":          (9, 5),    # flye / kneeling_rear_flye (closest machine)
    "Rear Deltoid":                             (9, 5),    # flye / kneeling_rear_flye
    "Reverse Fly Single Arm (Cable)":           (9, 6),    # flye / single_arm_standing_cable_reverse_flye
    "Band Pullaparts":                          (9, 5),    # flye / kneeling_rear_flye (closest band)

    # ======================================================================= #
    #  SHOULDERS – Shoulder Stability (category 25)
    # ======================================================================= #
    "Shoulder Extension":                       (25, 3),   # shoulder_stability / bent_arm_lateral_raise_and_external_rotation
    "Shoulder Taps":                            (25, 3),   # shoulder_stability / bent_arm_lateral_raise_and_external_rotation (closest)

    # ======================================================================= #
    #  SHOULDERS – Shrugs & Upright Rows (category 26)
    # ======================================================================= #
    "Shrug (Barbell)":                          (26, 1),   # shrug / barbell_shrug
    "Shrug (Cable)":                            (26, 5),   # shrug / dumbbell_shrug (closest cable)
    "Shrug (Dumbbell)":                         (26, 5),   # shrug / dumbbell_shrug
    "Shrug (Machine)":                          (26, 5),   # shrug / dumbbell_shrug (closest machine)
    "Shrug (Smith Machine)":                    (26, 1),   # shrug / barbell_shrug (closest)
    "Upright Row (Barbell)":                    (26, 2),   # shrug / barbell_upright_row
    "Upright Row (Cable)":                      (26, 6),   # shrug / dumbbell_upright_row (closest cable)
    "Upright Row (Dumbbell)":                   (26, 6),   # shrug / dumbbell_upright_row
    "Jump Shrug":                               (26, 0),   # shrug / barbell_jump_shrug

    # ======================================================================= #
    #  BICEPS – Curls (category 7)
    # ======================================================================= #
    "21s Bicep Curl":                           (7, 3),    # curl / barbell_biceps_curl (21s variant)
    "Behind the Back Bicep Wrist Curl (Barbell)": (7, 4),  # curl / barbell_reverse_wrist_curl
    "Behind the Back Curl (Cable)":             (7, 7),    # curl / behind_the_back_one_arm_cable_curl
    "Bicep Curl (Barbell)":                     (7, 3),    # curl / barbell_biceps_curl
    "Bicep Curl (Cable)":                       (7, 8),    # curl / cable_biceps_curl
    "Bicep Curl (Dumbbell)":                    (7, 37),   # curl / standing_dumbbell_biceps_curl
    "Bicep Curl (Machine)":                     (7, 8),    # curl / cable_biceps_curl (closest machine)
    "Bicep Curl (Suspension)":                  (7, 37),   # curl / standing_dumbbell_biceps_curl (closest)
    "Concentration Curl":                       (7, 37),   # curl / standing_dumbbell_biceps_curl (closest concentration)
    "Cross Body Hammer Curl":                   (7, 12),   # curl / cross_body_dumbbell_hammer_curl
    "Drag Curl":                                (7, 3),    # curl / barbell_biceps_curl (drag variant)
    "EZ Bar Biceps Curl":                       (7, 19),   # curl / ez_bar_preacher_curl (closest EZ bar)
    "Hammer Curl (Band)":                       (7, 16),   # curl / dumbbell_hammer_curl (closest band)
    "Hammer Curl (Cable)":                      (7, 9),    # curl / cable_hammer_curl
    "Hammer Curl (Dumbbell)":                   (7, 16),   # curl / dumbbell_hammer_curl
    "Kettlebell Curl":                          (7, 24),   # curl / kettlebell_biceps_curl
    "Overhead Curl (Cable)":                    (7, 8),    # curl / cable_biceps_curl (overhead variant)
    "Pinwheel Curl (Dumbbell)":                 (7, 12),   # curl / cross_body_dumbbell_hammer_curl (closest)
    "Plate Curl":                               (7, 27),   # curl / plate_pinch_curl
    "Preacher Curl (Barbell)":                  (7, 19),   # curl / ez_bar_preacher_curl
    "Preacher Curl (Dumbbell)":                 (7, 26),   # curl / one_arm_preacher_curl
    "Preacher Curl (Machine)":                  (7, 28),   # curl / preacher_curl_with_cable (closest machine)
    "Reverse Curl (Barbell)":                   (7, 31),   # curl / reverse_grip_barbell_biceps_curl
    "Reverse Curl (Cable)":                     (7, 31),   # curl / reverse_grip_barbell_biceps_curl (closest cable)
    "Reverse Curl (Dumbbell)":                  (7, 31),   # curl / reverse_grip_barbell_biceps_curl (closest)
    "Reverse EZ-Bar Curl":                      (7, 29),   # curl / reverse_ez_bar_curl
    "Reverse Grip Concentration Curl":          (7, 31),   # curl / reverse_grip_barbell_biceps_curl (closest)
    "Rope Cable Curl":                          (7, 8),    # curl / cable_biceps_curl (rope attachment)
    "Seated Incline Curl (Dumbbell)":           (7, 22),   # curl / incline_dumbbell_biceps_curl
    "Seated Palms Up Wrist Curl":               (7, 5),    # curl / barbell_wrist_curl
    "Seated Wrist Extension (Barbell)":         (7, 4),    # curl / barbell_reverse_wrist_curl
    "Single Arm Curl (Cable)":                  (7, 7),    # curl / behind_the_back_one_arm_cable_curl (closest single arm)
    "Spider Curl (Barbell)":                    (7, 3),    # curl / barbell_biceps_curl (spider variant)
    "Spider Curl (Dumbbell)":                   (7, 37),   # curl / standing_dumbbell_biceps_curl (spider variant)
    "Waiter Curl (Dumbbell)":                   (7, 37),   # curl / standing_dumbbell_biceps_curl (waiter variant)
    "Wrist Roller":                             (7, 18),   # curl / dumbbell_wrist_curl (closest)
    "Zottman Curl (Dumbbell)":                  (7, 42),   # curl / twisting_standing_dumbbell_biceps_curl

    # ======================================================================= #
    #  TRICEPS – Extensions (category 30)
    # ======================================================================= #
    "Floor Triceps Dip":                        (30, 0),   # triceps_extension / bench_dip (closest floor dip)
    "One-Arm Cable Cross Body Triceps Extension": (30, 3), # triceps_extension / cable_kickback
    "Overhead Triceps Extension (Cable)":       (30, 5),   # triceps_extension / cable_overhead_triceps_extension
    "Seated Dip Machine":                       (30, 2),   # triceps_extension / body_weight_dip (closest machine)
    "Seated Triceps Press":                     (30, 20),  # triceps_extension / seated_barbell_overhead_triceps_extension
    "Single Arm Tricep Extension (Dumbbell)":   (30, 24),  # triceps_extension / single_arm_dumbbell_overhead_triceps_extension
    "Single Arm Triceps Pushdown (Cable)":      (30, 39),  # triceps_extension / triceps_pressdown (single arm)
    "Skullcrusher (Barbell)":                   (30, 13),  # triceps_extension / lying_ez_bar_triceps_extension
    "Skullcrusher (Dumbbell)":                  (30, 7),   # triceps_extension / dumbbell_lying_triceps_extension
    "Triceps Dip":                              (30, 2),   # triceps_extension / body_weight_dip
    "Triceps Dip (Assisted)":                   (30, 2),   # triceps_extension / body_weight_dip (assisted)
    "Triceps Dip (Weighted)":                   (30, 40),  # triceps_extension / weighted_dip
    "Triceps Extension (Barbell)":              (30, 8),   # triceps_extension / ez_bar_overhead_triceps_extension
    "Triceps Extension (Cable)":                (30, 5),   # triceps_extension / cable_overhead_triceps_extension
    "Triceps Extension (Dumbbell)":             (30, 15),  # triceps_extension / overhead_dumbbell_triceps_extension
    "Triceps Extension (Machine)":              (30, 5),   # triceps_extension / cable_overhead_triceps_extension (closest)
    "Triceps Extension (Suspension)":           (30, 5),   # triceps_extension / cable_overhead_triceps_extension (closest)
    "Triceps Kickback (Cable)":                 (30, 3),   # triceps_extension / cable_kickback
    "Triceps Kickback (Dumbbell)":              (30, 6),   # triceps_extension / dumbbell_kickback
    "Triceps Pressdown":                        (30, 39),  # triceps_extension / triceps_pressdown
    "Triceps Pushdown":                         (30, 39),  # triceps_extension / triceps_pressdown
    "Triceps Rope Pushdown":                    (30, 19),  # triceps_extension / rope_pressdown
    "Wide-Elbow Triceps Press (Dumbbell)":      (30, 15),  # triceps_extension / overhead_dumbbell_triceps_extension (closest)

    # ======================================================================= #
    #  LEGS – Squat (category 28)
    # ======================================================================= #
    "Assisted Pistol Squats":                   (28, 47),  # squat / pistol_squat (assisted)
    "Belt Squat (Machine)":                     (28, 61),  # squat / squat (belt squat variant)
    "Box Squat (Barbell)":                      (28, 7),   # squat / barbell_box_squat
    "Front Squat":                              (28, 8),   # squat / barbell_front_squat
    "Full Squat":                               (28, 6),   # squat / barbell_back_squat (full ROM)
    "Goblet Squat":                             (28, 37),  # squat / goblet_squat
    "Hack Squat":                               (28, 9),   # squat / barbell_hack_squat
    "Hack Squat (Machine)":                     (28, 9),   # squat / barbell_hack_squat (machine)
    "Kettlebell Goblet Squat":                  (28, 37),  # squat / goblet_squat (kettlebell)
    "Landmine Squat and Press":                 (28, 79),  # squat / thrusters (closest squat+press)
    "Lateral Squat":                            (28, 61),  # squat / squat (lateral variant)
    "Leg Press (Machine)":                      (28, 0),   # squat / leg_press
    "Leg Press Horizontal (Machine)":           (28, 0),   # squat / leg_press (horizontal)
    "Overhead Squat":                           (28, 44),  # squat / overhead_squat
    "Pause Squat (Barbell)":                    (28, 6),   # squat / barbell_back_squat (pause variant)
    "Pendulum Squat (Machine)":                 (28, 61),  # squat / squat (pendulum machine)
    "Pistol Squat":                             (28, 47),  # squat / pistol_squat
    "Single Leg Press (Machine)":               (28, 0),   # squat / leg_press (single leg)
    "Sissy Squat (Weighted)":                   (28, 62),  # squat / weighted_squat (sissy variant)
    "Squat (Band)":                             (28, 61),  # squat / squat (band)
    "Squat (Barbell)":                          (28, 6),   # squat / barbell_back_squat
    "Squat (Bodyweight)":                       (28, 61),  # squat / squat (bodyweight)
    "Squat (Dumbbell)":                         (28, 29),  # squat / dumbbell_squat
    "Squat (Machine)":                          (28, 61),  # squat / squat (machine)
    "Squat (Smith Machine)":                    (28, 6),   # squat / barbell_back_squat (smith)
    "Squat (Suspension)":                       (28, 61),  # squat / squat (suspension)
    "Sumo Squat":                               (28, 69),  # squat / sumo_squat
    "Sumo Squat (Barbell)":                     (28, 69),  # squat / sumo_squat (barbell)
    "Sumo Squat (Dumbbell)":                    (28, 69),  # squat / sumo_squat (dumbbell)
    "Sumo Squat (Kettlebell)":                  (28, 69),  # squat / sumo_squat (kettlebell)
    "Thruster (Barbell)":                       (28, 79),  # squat / thrusters
    "Thruster (Kettlebell)":                    (28, 79),  # squat / thrusters (kettlebell)
    "Wall Ball":                                (28, 83),  # squat / wall_ball
    "Wall Sit":                                 (28, 20),  # squat / body_weight_wall_squat
    "Zercher Squat":                            (28, 86),  # squat / zercher_squat

    # ======================================================================= #
    #  LEGS – Step Ups (category 28)
    # ======================================================================= #
    "Dumbbell Step Up":                         (28, 32),  # squat / dumbbell_step_up
    "Step Up":                                  (28, 66),  # squat / step_up
    "Stair Machine (Floors)":                   (47, 0),   # stair_stepper / stair_stepper
    "Stair Machine (Steps)":                    (47, 0),   # stair_stepper / stair_stepper

    # ======================================================================= #
    #  LEGS – Lunges (category 17)
    # ======================================================================= #
    "Bulgarian Split Squat":                    (17, 7),   # lunge / barbell_bulgarian_split_squat (closest)
    "Curtsy Lunge (Dumbbell)":                  (17, 21),  # lunge / dumbbell_lunge (closest curtsy)
    "Jumping Lunge":                            (20, 0),   # plyo / alternating_jump_lunge
    "Lateral Lunge":                            (17, 32),  # lunge / lunge (lateral variant)
    "Lunge":                                    (17, 32),  # lunge / lunge
    "Lunge (Barbell)":                          (17, 10),  # lunge / barbell_lunge
    "Lunge (Dumbbell)":                         (17, 21),  # lunge / dumbbell_lunge
    "Overhead Dumbbell Lunge":                  (17, 40),  # lunge / overhead_dumbbell_lunge
    "Reverse Lunge":                            (17, 32),  # lunge / lunge (reverse variant)
    "Reverse Lunge (Barbell)":                  (17, 11),  # lunge / barbell_reverse_lunge
    "Reverse Lunge (Dumbbell)":                 (17, 21),  # lunge / dumbbell_lunge (reverse)
    "Split Squat (Dumbbell)":                   (17, 28),  # lunge / dumbbell_split_squat
    "Walking Lunge":                            (17, 78),  # lunge / walking_lunge
    "Walking Lunge (Dumbbell)":                 (17, 77),  # lunge / walking_dumbbell_lunge

    # ======================================================================= #
    #  LEGS – Deadlift (category 8)
    # ======================================================================= #
    "Deadlift (Band)":                          (8, 0),    # deadlift / barbell_deadlift (closest band)
    "Deadlift (Barbell)":                       (8, 0),    # deadlift / barbell_deadlift
    "Deadlift (Dumbbell)":                      (8, 2),    # deadlift / dumbbell_deadlift
    "Deadlift (Smith Machine)":                 (8, 0),    # deadlift / barbell_deadlift (smith)
    "Deadlift (Trap bar)":                      (8, 17),   # deadlift / trap_bar_deadlift
    "Deadlift High Pull":                       (8, 16),   # deadlift / sumo_deadlift_high_pull (closest)
    "Rack Pull":                                (8, 7),    # deadlift / rack_pull
    "Romanian Deadlift (Barbell)":              (8, 1),    # deadlift / barbell_straight_leg_deadlift
    "Romanian Deadlift (Dumbbell)":             (8, 4),    # deadlift / dumbbell_straight_leg_deadlift
    "Single Leg Romanian Deadlift (Barbell)":   (8, 10),   # deadlift / single_leg_barbell_deadlift
    "Single Leg Romanian Deadlift (Dumbbell)":  (8, 14),   # deadlift / single_leg_romanian_deadlift_with_dumbbell
    "Straight Leg Deadlift":                    (8, 1),    # deadlift / barbell_straight_leg_deadlift
    "Sumo Deadlift":                            (8, 15),   # deadlift / sumo_deadlift

    # ======================================================================= #
    #  LEGS – Leg Curl (category 15)
    # ======================================================================= #
    "Good Morning (Barbell)":                   (15, 2),   # leg_curl / good_morning
    "Lying Leg Curl (Machine)":                 (15, 0),   # leg_curl / leg_curl
    "Nordic Hamstrings Curls":                  (15, 0),   # leg_curl / leg_curl (Nordic variant)
    "Seated Leg Curl (Machine)":                (15, 0),   # leg_curl / leg_curl (seated)
    "Standing Leg Curls":                       (15, 0),   # leg_curl / leg_curl (standing)

    # ======================================================================= #
    #  LEGS – Leg Extension
    # ======================================================================= #
    "Leg Extension (Machine)":                  (6, 33),   # crunch / leg_extensions (FIT SDK maps this here)
    "Single Leg Extensions":                    (6, 33),   # crunch / leg_extensions (single leg)

    # ======================================================================= #
    #  LEGS – Calf Raise (category 1)
    # ======================================================================= #
    "Calf Extension (Machine)":                 (1, 18),   # calf_raise / standing_calf_raise (closest)
    "Calf Press (Machine)":                     (1, 18),   # calf_raise / standing_calf_raise (closest)
    "Seated Calf Raise":                        (1, 6),    # calf_raise / seated_calf_raise
    "Single Leg Standing Calf Raise":           (1, 15),   # calf_raise / single_leg_standing_calf_raise
    "Single Leg Standing Calf Raise (Barbell)": (1, 15),   # calf_raise / single_leg_standing_calf_raise (barbell)
    "Single Leg Standing Calf Raise (Dumbbell)": (1, 16),  # calf_raise / single_leg_standing_dumbbell_calf_raise
    "Single Leg Standing Calf Raise (Machine)": (1, 15),   # calf_raise / single_leg_standing_calf_raise (machine)
    "Standing Calf Raise":                      (1, 18),   # calf_raise / standing_calf_raise
    "Standing Calf Raise (Barbell)":            (1, 17),   # calf_raise / standing_barbell_calf_raise
    "Standing Calf Raise (Dumbbell)":           (1, 20),   # calf_raise / standing_dumbbell_calf_raise
    "Standing Calf Raise (Machine)":            (1, 18),   # calf_raise / standing_calf_raise (machine)
    "Standing Calf Raise (Smith)":              (1, 17),   # calf_raise / standing_barbell_calf_raise (smith)

    # ======================================================================= #
    #  LEGS – Hip Raise / Glutes (category 10)
    # ======================================================================= #
    "Frog Pumps (Dumbbell)":                    (10, 11),  # hip_raise / hip_raise (closest frog pump)
    "Glute Bridge":                             (10, 11),  # hip_raise / hip_raise
    "Glute Ham Raise":                          (10, 11),  # hip_raise / hip_raise (GHR variant)
    "Hip Thrust":                               (10, 0),   # hip_raise / barbell_hip_thrust_on_floor
    "Hip Thrust (Barbell)":                     (10, 1),   # hip_raise / barbell_hip_thrust_with_bench
    "Hip Thrust (Machine)":                     (10, 1),   # hip_raise / barbell_hip_thrust_with_bench (closest machine)
    "Hip Thrust (Smith Machine)":               (10, 1),   # hip_raise / barbell_hip_thrust_with_bench (smith)
    "Partial Glute Bridge (Barbell)":           (10, 0),   # hip_raise / barbell_hip_thrust_on_floor (partial)
    "Single Leg Glute Bridge":                  (10, 30),  # hip_raise / single_leg_hip_raise
    "Single Leg Hip Thrust":                    (10, 30),  # hip_raise / single_leg_hip_raise
    "Single Leg Hip Thrust (Dumbbell)":         (10, 30),  # hip_raise / single_leg_hip_raise (dumbbell)

    # ======================================================================= #
    #  LEGS – Hip Stability (category 11)
    # ======================================================================= #
    "Clamshell":                                (10, 44),  # hip_raise / clams
    "Fire Hydrants":                            (11, 5),   # hip_stability / fire_hydrant_kicks
    "Glute Kickback (Machine)":                 (11, 17),  # hip_stability / quadruped_hip_extension (closest)
    "Glute Kickback on Floor":                  (11, 17),  # hip_stability / quadruped_hip_extension
    "Hip Abduction (Machine)":                  (11, 28),  # hip_stability / standing_hip_abduction
    "Hip Adduction (Machine)":                  (11, 25),  # hip_stability / standing_adduction
    "Lateral Band Walks":                       (11, 11),  # hip_stability / lateral_walks_with_band_at_ankles
    "Lateral Leg Raises":                       (11, 21),  # hip_stability / side_lying_leg_raise
    "Rear Kick (Machine)":                      (11, 30),  # hip_stability / standing_rear_leg_raise
    "Standing Cable Glute Kickbacks":           (11, 30),  # hip_stability / standing_rear_leg_raise (cable)

    # ======================================================================= #
    #  LEGS – Hip Swing (category 12)
    # ======================================================================= #
    "Kettlebell Swing":                         (10, 23),  # hip_raise / kettlebell_swing

    # ======================================================================= #
    #  CORE – Core (category 5)
    # ======================================================================= #
    "Ab Scissors":                              (5, 49),   # core / bicycle (closest scissors)
    "Cable Core Palloff Press":                 (5, 46),   # core / russian_twist (closest anti-rotation)
    "Cable Twist (Down to up)":                 (4, 2),    # chop / cable_woodchop (twist variant)
    "Cable Twist (Up to down)":                 (4, 2),    # chop / cable_woodchop (twist variant)
    "Russian Twist (Bodyweight)":               (5, 46),   # core / russian_twist
    "Russian Twist (Weighted)":                 (5, 46),   # core / russian_twist (weighted)
    "Side Bend":                                (5, 8),    # core / side_bend
    "Side Bend (Dumbbell)":                     (5, 9),    # core / weighted_side_bend
    "Torso Rotation":                           (4, 2),    # chop / cable_woodchop (closest)

    # ======================================================================= #
    #  CORE – Crunch (category 6)
    # ======================================================================= #
    "Ab Wheel":                                 (5, 18),   # core / kneeling_ab_wheel
    "Bicycle Crunch":                           (6, 0),    # crunch / bicycle_crunch
    "Bicycle Crunch Raised Legs":               (6, 0),    # crunch / bicycle_crunch (raised legs)
    "Cable Crunch":                             (6, 1),    # crunch / cable_crunch
    "Crunch":                                   (6, 83),   # crunch / crunch
    "Crunch (Machine)":                         (6, 28),   # crunch / kneeling_cable_crunch (closest machine)
    "Crunch (Weighted)":                        (6, 79),   # crunch / weighted_crunch
    "Decline Crunch":                           (6, 83),   # crunch / crunch (decline variant)
    "Decline Crunch (Weighted)":                (6, 79),   # crunch / weighted_crunch (decline)
    "Flutter Kicks":                            (6, 13),   # crunch / flutter_kicks
    "Heel Taps":                                (6, 83),   # crunch / crunch (heel tap variant)
    "Hollow Rock":                              (6, 24),   # crunch / hollow_rock
    "Oblique Crunch":                           (6, 83),   # crunch / crunch (oblique variant)
    "Reverse Crunch":                           (6, 46),   # crunch / reverse_crunch
    "Toes to Bar":                              (6, 81),   # crunch / toes_to_bar

    # ======================================================================= #
    #  CORE – Sit Up (category 27)
    # ======================================================================= #
    "Elbow to Knee":                            (27, 37),  # sit_up / sit_up (elbow-to-knee variant)
    "Jackknife Sit Up":                         (27, 37),  # sit_up / sit_up (jackknife variant)
    "Sit Up":                                   (27, 37),  # sit_up / sit_up
    "Sit Up (Weighted)":                        (27, 34),  # sit_up / weighted_sit_up
    "Toe Touch":                                (27, 37),  # sit_up / sit_up (toe touch variant)
    "V Up":                                     (27, 31),  # sit_up / v_up

    # ======================================================================= #
    #  CORE – Leg Raise (category 16)
    # ======================================================================= #
    "Dragon Flag":                              (16, 1),   # leg_raise / hanging_leg_raise (closest)
    "Dragonfly":                                (16, 1),   # leg_raise / hanging_leg_raise (closest)
    "Hanging Knee Raise":                       (16, 0),   # leg_raise / hanging_knee_raise
    "Hanging Leg Raise":                        (16, 1),   # leg_raise / hanging_leg_raise
    "Knee Raise Parallel Bars":                 (16, 0),   # leg_raise / hanging_knee_raise (parallel bars)
    "Leg Raise Parallel Bars":                  (16, 1),   # leg_raise / hanging_leg_raise (parallel bars)
    "Lying Knee Raise":                         (16, 8),   # leg_raise / lying_straight_leg_raise (closest)
    "Lying Leg Raise":                          (16, 8),   # leg_raise / lying_straight_leg_raise

    # ======================================================================= #
    #  CORE – Plank (category 19)
    # ======================================================================= #
    "Mountain Climber":                         (19, 34),  # plank / mountain_climber
    "Plank":                                    (19, 43),  # plank / plank
    "Reverse Plank":                            (19, 43),  # plank / plank (reverse variant)
    "Side Plank":                               (19, 66),  # plank / side_plank
    "Spiderman":                                (19, 90),  # plank / spiderman_plank

    # ======================================================================= #
    #  CORE – Hyperextension / Superman (category 13)
    # ======================================================================= #
    "Superman":                                 (13, 29),  # hyperextension / superman_from_floor

    # ======================================================================= #
    #  OLYMPIC LIFTS (category 18)
    # ======================================================================= #
    "Clean":                                    (18, 11),  # olympic_lift / clean
    "Clean Pull":                               (18, 11),  # olympic_lift / clean (pull phase)
    "Clean and Jerk":                           (18, 5),   # olympic_lift / clean_and_jerk
    "Clean and Press":                          (18, 5),   # olympic_lift / clean_and_jerk (closest)
    "Dumbbell Snatch":                          (18, 16),  # olympic_lift / single_arm_dumbbell_snatch
    "Hang Clean":                               (18, 0),   # olympic_lift / barbell_hang_power_clean
    "Hang Snatch":                              (18, 6),   # olympic_lift / barbell_hang_power_snatch
    "Kettlebell Clean":                         (18, 11),  # olympic_lift / clean (kettlebell)
    "Kettlebell Snatch":                        (18, 18),  # olympic_lift / single_arm_kettlebell_snatch
    "Power Clean":                              (18, 2),   # olympic_lift / barbell_power_clean
    "Power Snatch":                             (18, 3),   # olympic_lift / barbell_power_snatch
    "Press Under":                              (18, 11),  # olympic_lift / clean (press-under variant)
    "Snatch":                                   (18, 9),   # olympic_lift / barbell_snatch
    "Split Jerk":                               (18, 10),  # olympic_lift / barbell_split_jerk
    "Kettlebell High Pull":                     (18, 8),   # olympic_lift / barbell_high_pull (closest KB)

    # ======================================================================= #
    #  PLYOMETRICS (category 20)
    # ======================================================================= #
    "Box Jump":                                 (20, 13),  # plyo / high_box_jump
    "Frog Jumps":                               (20, 3),   # plyo / body_weight_jump_squat (closest)
    "High Knee Skips":                          (20, 3),   # plyo / body_weight_jump_squat (closest)
    "Jump Squat":                               (20, 3),   # plyo / body_weight_jump_squat
    "Lateral Box Jump":                         (20, 19),  # plyo / lateral_plyo_squats (closest)
    "Ball Slams":                               (20, 25),  # plyo / medicine_ball_slam
    "Sled Push":                                (20, 29),  # plyo / squat_jump_onto_box (closest heavy plyo)

    # ======================================================================= #
    #  TOTAL BODY (category 29)
    # ======================================================================= #
    "Burpee":                                   (29, 0),   # total_body / burpee
    "Burpee Over the Bar":                      (29, 0),   # total_body / burpee (over bar variant)

    # ======================================================================= #
    #  CARRY (category 3)
    # ======================================================================= #
    "Farmers Walk":                             (3, 1),    # carry / farmers_walk
    "Overhead Dumbbell Lunge":                  (3, 4),    # carry / overhead_carry (closest overhead lunge/carry)

    # ======================================================================= #
    #  WARM UP (category 31)
    # ======================================================================= #
    "Warm Up":                                  (31, 0),   # warm_up / generic warm up

    # ======================================================================= #
    #  FLEXIBILITY / STABILITY – mapped to known FIT categories
    # ======================================================================= #
    "Bird Dog":                                 (11, 1),   # hip_stability / dead_bug (closest quadruped stability)
    "Dead Bug":                                 (11, 1),   # hip_stability / dead_bug
    "Dead Hang":                                (21, 38),  # pull_up / pull_up (hang variant – grip/lat endurance)
    "Downward Dog":                             (31, 0),   # warm_up / generic (yoga pose)
    "Front Lever Hold":                         (21, 38),  # pull_up / pull_up (front lever)
    "Front Lever Raise":                        (21, 38),  # pull_up / pull_up (front lever)
    "Handstand Hold":                           (22, 25),  # push_up / handstand_push_up (hold variant)
    "Handstand Push Up":                        (22, 25),  # push_up / handstand_push_up
    "Jack Knife (Suspension)":                  (6, 83),   # crunch / crunch (jackknife on suspension)
    "L-Sit Hold":                               (16, 1),   # leg_raise / hanging_leg_raise (L-sit hold)
    "Landmine 180":                             (4, 2),    # chop / cable_woodchop (rotational)
    "Lying Neck Curls":                         (65534, 0), # unknown – no FIT neck category
    "Lying Neck Curls (Weighted)":              (65534, 0), # unknown – no FIT neck category
    "Lying Neck Extension":                     (65534, 0), # unknown – no FIT neck category
    "Lying Neck Extension (Weighted)":          (65534, 0), # unknown – no FIT neck category

    # ======================================================================= #
    #  KETTLEBELL SPECIFIC
    # ======================================================================= #
    "Kettlebell Around the World":              (5, 46),   # core / russian_twist (closest rotational KB)
    "Kettlebell Halo":                          (25, 3),   # shoulder_stability / bent_arm_lateral_raise (closest)
    "Kettlebell Turkish Get Up":                (29, 0),   # total_body / burpee (closest full-body KB)

    # ======================================================================= #
    #  CARDIO / MACHINES — uses newer FIT SDK categories (33+) where available
    # ======================================================================= #
    "Aerobics":                                 (2, 0),    # cardio / generic
    "Air Bike":                                 (41, 0),   # indoor_bike / air_bike
    "Battle Ropes":                             (38, 0),   # battle_rope / alternating_waves
    "Boxing":                                   (2, 42),   # cardio / punch
    "Climbing":                                 (2, 0),    # cardio / generic
    "Cycling":                                  (33, 0),   # bike / bike
    "Elliptical Trainer":                       (39, 0),   # elliptical / elliptical
    "HIIT":                                     (2, 0),    # cardio / generic
    "Hiking":                                   (32, 1),   # run / walk (hiking = walking)
    "Jump Rope":                                (2, 6),    # cardio / jump_rope
    "Jumping Jack":                             (2, 12),   # cardio / jumping_jacks
    "Pilates":                                  (2, 0),    # cardio / generic
    "Rowing Machine":                           (42, 0),   # indoor_row / rowing_machine
    "Skating":                                  (2, 0),    # cardio / generic
    "Skiing":                                   (2, 0),    # cardio / generic
    "Snowboarding":                             (2, 0),    # cardio / generic
    "Spinning":                                 (41, 3),   # indoor_bike / stationary_bike
    "Stretching":                               (31, 0),   # warm_up / generic (stretching)
    "Swimming":                                 (2, 0),    # cardio / generic
    "Treadmill":                                (52, 1),   # run_indoor / treadmill
    "Yoga":                                     (36, 0),   # pose / generic (yoga)
    "High Knees":                               (2, 0),    # cardio / generic
    "Sprints":                                  (32, 3),   # run / sprint
    "Cable Pull Through":                       (10, 11),  # hip_raise / hip_raise (cable pull-through = hip hinge)

    # ======================================================================= #
    #  RUNNING (category 32)
    # ======================================================================= #
    "Running":                                  (32, 0),   # run / run
    "Walking":                                  (32, 1),   # run / walk

}

# --------------------------------------------------------------------------- #
# Remove any duplicates that crept in (the last assignment wins in Python
# dicts, but let's be explicit about the canonical set).
# --------------------------------------------------------------------------- #

_UNKNOWN_CATEGORY = 65534
_UNKNOWN_SUBCATEGORY = 0

# Custom user-defined mappings (loaded from ~/.hevy2garmin/custom_mappings.json)
_custom_mappings: dict[str, tuple[int, int]] = {}
_custom_loaded = False


def _ensure_custom_loaded() -> None:
    """Load custom mappings from DB (cloud) or disk (local) on first use."""
    global _custom_loaded
    if _custom_loaded:
        return
    _custom_loaded = True

    # Try DB first (cloud deployments)
    try:
        from hevy2garmin.db import get_database_url, get_db
        if get_database_url():
            _db = get_db()
            if hasattr(_db, 'get_custom_mappings'):
                for name, (cat, subcat) in _db.get_custom_mappings().items():
                    _custom_mappings[name] = (cat, subcat)
                return
    except Exception:
        pass

    # Fallback: filesystem (local/Docker)
    import json
    from pathlib import Path
    path = Path("~/.hevy2garmin/custom_mappings.json").expanduser()
    if path.exists():
        try:
            data = json.loads(path.read_text())
            for name, pair in data.items():
                _custom_mappings[name] = (pair[0], pair[1])
        except (json.JSONDecodeError, OSError, IndexError):
            pass


def save_custom_mapping(hevy_name: str, category: int, subcategory: int) -> None:
    """Persist a custom exercise mapping.

    On cloud deployments (DATABASE_URL set) writes to the DB — the home
    filesystem is read-only on serverless, so the previous file-only write
    raised a 500 and the mapping never persisted (#142, #145). Mirrors the
    DB-first load path in ``_ensure_custom_loaded``. Falls back to the
    filesystem for local/Docker installs.
    """
    # Cloud: persist to the DB
    try:
        from hevy2garmin.db import get_database_url, get_db
        if get_database_url():
            _db = get_db()
            if hasattr(_db, "save_custom_mapping"):
                _db.save_custom_mapping(hevy_name, category, subcategory)
                _custom_mappings[hevy_name] = (category, subcategory)
                return
    except Exception:
        pass

    # Local/Docker: filesystem
    import json
    from pathlib import Path
    path = Path("~/.hevy2garmin/custom_mappings.json").expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    existing[hevy_name] = [category, subcategory]
    path.write_text(json.dumps(existing, indent=2))
    _custom_mappings[hevy_name] = (category, subcategory)


def lookup_exercise(hevy_name: str, template_id: str | None = None) -> tuple[int, int, str]:
    """Return ``(category, subcategory, display_name)`` for a Hevy exercise.

    Resolution order:
      1. Custom user mapping, keyed by the user's own exercise name.
      2. Hevy ``exercise_template_id``, which is the same regardless of the
         user's Hevy language, so non-English exercises map automatically (#173).
      3. The built-in English-name table.
    Returns sentinel category ``65534`` if not found anywhere.
    """
    _ensure_custom_loaded()
    # Custom mappings take priority
    if hevy_name in _custom_mappings:
        cat, subcat = _custom_mappings[hevy_name]
        return (cat, subcat, hevy_name)
    # Language-independent template-id match
    if template_id:
        pair = TEMPLATE_TO_GARMIN.get(template_id)
        if pair is not None:
            return (pair[0], pair[1], hevy_name)
    # Built-in English-name mappings
    pair = HEVY_TO_GARMIN.get(hevy_name)
    if pair is not None:
        return (pair[0], pair[1], hevy_name)
    return (_UNKNOWN_CATEGORY, _UNKNOWN_SUBCATEGORY, hevy_name)
