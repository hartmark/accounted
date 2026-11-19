-- Preserve resumable deferred reviews alongside upstream outside-year rejudging.
-- pg-test: tests/pg/finish-migration-with-review.pg.test.ts
CREATE OR REPLACE FUNCTION public.retry_provider_migration_job(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('needs_attention','retry_wait') AND NOT (j.state='completed' AND j.review_deferred_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention')) THEN RETURN; END IF;
  -- Only the failed records go back to work, each to the phase it failed in.
  -- Their last code stays in the receipt: the same code after the retry means
  -- the retry changed nothing for that record.
  UPDATE migration_job_chunks SET state=CASE error_phase WHEN 'link' THEN 'imported' WHEN 'reconcile' THEN 'linked' WHEN 'settle' THEN 'planned' ELSE 'pending' END,
    receipt=receipt||jsonb_build_object('previous_error_code',error_code),
    error_code=NULL,error_phase=NULL WHERE job_id=j.id AND state='needs_attention';
  -- And the invoices declined as outside the imported years before more
  -- years were imported: the import phase judges them again.
  UPDATE migration_job_chunks SET state='pending',receipt='{}'::jsonb
    WHERE job_id=j.id AND id IN (SELECT provider_migration_stale_year_skips(j.id));
  UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=CASE WHEN phase='discover' THEN 'discover' ELSE 'import' END,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
END $$;
REVOKE ALL ON FUNCTION public.retry_provider_migration_job(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.retry_provider_migration_job(uuid,uuid,uuid) TO service_role;


NOTIFY pgrst,'reload schema';
