'use server';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { coreLinkErrorMessage, coreLinkReason } from '@/lib/keyword-core-link';

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

export type CoreLinkActionState = { ok: boolean; message: string } | null;

// A teammate links an active long-tail keyword to a core keyword of its site's
// approved list, changes that link, or clears it (20261120200000). The
// database checks the caller, the rule and the reason, and records who did
// what and why; the column has no other writer.
export async function linkCoreParent(
  clientId: string,
  keywordId: string,
  _prev: CoreLinkActionState,
  form: FormData,
): Promise<CoreLinkActionState> {
  const parentId = form.get('parent_id');
  if (typeof parentId !== 'string' || !parentId) return { ok: false, message: 'Choose a core keyword.' };
  const reason = coreLinkReason(form.get('reason'));
  if (!reason.ok) return reason;
  const db = await createClient();
  const { error } = await db.rpc('keyword_link_core_parent', {
    p_keyword_id: keywordId, p_parent_id: parentId, p_reason: reason.reason,
  });
  if (error) return { ok: false, message: coreLinkErrorMessage(error.message) };
  revalidatePath(`/clients/${clientId}/keywords`);
  return { ok: true, message: 'Linked.' };
}

export async function unlinkCoreParent(
  clientId: string,
  keywordId: string,
  _prev: CoreLinkActionState,
  form: FormData,
): Promise<CoreLinkActionState> {
  const reason = coreLinkReason(form.get('reason'));
  if (!reason.ok) return reason;
  const db = await createClient();
  const { error } = await db.rpc('keyword_unlink_core_parent', { p_keyword_id: keywordId, p_reason: reason.reason });
  if (error) return { ok: false, message: coreLinkErrorMessage(error.message) };
  revalidatePath(`/clients/${clientId}/keywords`);
  return { ok: true, message: 'Link cleared.' };
}
