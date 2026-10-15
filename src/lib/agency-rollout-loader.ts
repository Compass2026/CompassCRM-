import type { createClient } from './supabase/server';
import { completeRead } from './integration-health.ts';
import type { RolloutReview } from './agency-rollout';

export async function loadRolloutReviews(db: Awaited<ReturnType<typeof createClient>>, clientIds: string[]) {
  if (!clientIds.length) return [] as RolloutReview[];
  const result = await db.from('agency_rollout_reviews').select('*',{count:'exact'})
    .in('client_id',clientIds).order('version',{ascending:false}).limit(3000);
  return completeRead(result);
}
