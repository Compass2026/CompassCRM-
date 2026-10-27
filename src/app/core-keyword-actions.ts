'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

// A teammate approves a proposed core keyword list (the database stamps who
// and when, and supersedes the previous approval), or withdraws a proposal /
// revokes an approval. Lists never change: a different 50 is a new version.
export async function reviewCoreKeywordList(clientId: string, id: string, version: number, decision: 'approve' | 'withdraw') {
  const db = await createClient();
  const { data, error } = await db.from('core_keyword_lists')
    .update({ status: decision === 'approve' ? 'approved' : 'superseded' })
    .eq('id', id).eq('client_id', clientId).eq('version', version)
    .in('status', decision === 'approve' ? ['proposed'] : ['proposed', 'approved'])
    .select('id').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('The core keyword list changed or is unavailable. Reload and review the current version.');
  revalidatePath(`/clients/${clientId}/keywords`);
}
