-- Already applied to the live project (migration "live_pass"). Kept for reference.
-- LIVE pass: PHP 500 / day, its own time bank (profiles.live_hours / live_until), package kind 'live'.
-- RPCs: start_live_pass(p_device) — used by the LIVE screen when the organizer signs in;
-- admin_review_purchase / admin_undo_approval route LIVE donations to the LIVE time bank.

-- Updated (migration "live_pass_hourly_options"): LIVE options are live1h PHP 20/1h, live4h PHP 50/4h, live PHP 150/24h, live3d PHP 300/72h.
