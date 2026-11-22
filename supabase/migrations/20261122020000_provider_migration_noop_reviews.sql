-- pg-test: tests/pg/provider-migration-noop.pg.test.ts
-- The service compares the retained snapshot first. The existing decision RPC
-- then checks the target revision under lock without writing any business fields.
CREATE FUNCTION public.acknowledge_provider_migration_noop(
  p_job_id uuid, p_record_id uuid, p_company_id uuid, p_user_id uuid,
  p_expected_updated_at timestamptz
) RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE c public.migration_job_chunks;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id
    AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  -- Same lock order as decisions, so automatic and explicit decisions serialize.
  PERFORM 1 FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO c FROM migration_job_chunks WHERE id=p_record_id
    AND job_id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND OR c.state<>'needs_attention'
    OR c.error_code IS DISTINCT FROM 'MIGRATION_SOURCE_CHANGED' THEN RETURN false; END IF;
  PERFORM decide_provider_migration_record(p_job_id,p_record_id,p_company_id,p_user_id,
    'source','{}'::jsonb,NULL,p_expected_updated_at);
  UPDATE migration_job_chunks SET state='skipped',receipt=receipt||jsonb_build_object(
    'reason','unchanged','automaticNoop',true) WHERE id=c.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.acknowledge_provider_migration_noop(uuid,uuid,uuid,uuid,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_provider_migration_noop(uuid,uuid,uuid,uuid,timestamptz) TO service_role;
NOTIFY pgrst,'reload schema';
