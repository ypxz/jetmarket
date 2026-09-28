-- One operator profile per user. upsertOperator used to SELECT-then-INSERT,
-- so concurrent onboarding POSTs could mint duplicates; the unique index makes
-- them collide, and the insert path uses ON CONFLICT (user_id) instead.
drop index if exists operators_user_idx;
create unique index if not exists operators_user_uniq on operators (user_id);
