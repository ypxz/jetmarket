-- Dead seam: nothing ever wrote to or read from `usage` (plan metering reads
-- live rows instead). Pre-launch cleanup so the schema only carries live tables.
drop table if exists usage;
