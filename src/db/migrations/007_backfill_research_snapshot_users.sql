UPDATE research_snapshots
SET user_id = (
  SELECT trading_plans.user_id
  FROM trading_plans
  WHERE trading_plans.research_snapshot_id = research_snapshots.id
  ORDER BY trading_plans.created_at DESC
  LIMIT 1
)
WHERE user_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM trading_plans
    WHERE trading_plans.research_snapshot_id = research_snapshots.id
  );
