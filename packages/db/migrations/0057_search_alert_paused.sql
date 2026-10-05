-- QA-542: 'paused' is a new search_alerts.status value — a session-side
-- mute that keeps the row (and its match backlog) unlike 'off'. The due
-- index + every mail path already select status='active', so paused rows
-- are exempt from instant and digest mail with no index change.
alter table search_alerts
  drop constraint search_alerts_status_check;
alter table search_alerts
  add constraint search_alerts_status_check
  check (status in ('pending','active','paused','off'));
