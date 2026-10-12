import {createClient} from 'npm:@supabase/supabase-js@2.112.4';
import {createBacklinkPerformance} from './handler.ts';
const supabase=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
declare const EdgeRuntime:{waitUntil(task:Promise<void>):void};
Deno.serve(createBacklinkPerformance({supabase,waitUntil:task=>EdgeRuntime.waitUntil(task)}));
