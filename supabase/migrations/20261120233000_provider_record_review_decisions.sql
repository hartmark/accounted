-- Per-record review decisions preserve source snapshots and never rewrite posted vouchers.
-- pg-test: tests/pg/provider-record-decisions.pg.test.ts
CREATE OR REPLACE FUNCTION public.insert_provider_migration_row(p_table text,p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE cols text; selected text; target uuid;
BEGIN
  IF p_table NOT IN ('customers','suppliers','invoices','supplier_invoices','supplier_invoice_items','invoice_items') THEN
    RAISE EXCEPTION 'MIGRATION_TABLE_FORBIDDEN'; END IF;
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('r.%I',key),',' ORDER BY key)
    INTO cols,selected FROM jsonb_object_keys(p_row) AS key;
  EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r RETURNING id',
    p_table,cols,selected,p_table) INTO target USING p_row;
  RETURN target;
END $$;

CREATE FUNCTION public.decide_provider_migration_record(
  p_job_id uuid,p_record_id uuid,p_company_id uuid,p_user_id uuid,p_action text,
  p_values jsonb DEFAULT '{}'::jsonb,p_items jsonb DEFAULT NULL,p_expected_updated_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; tbl text; old_row jsonb;
  allowed text[]; assignments text; protected boolean; item jsonb; child_table text; parent_key text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  IF p_action IS NULL OR p_action NOT IN ('source','ignore') THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('completed','needs_attention') OR j.phase<>'completed' THEN RAISE EXCEPTION 'MIGRATION_REVIEW_BUSY'; END IF;
  SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=p_record_id AND job_id=j.id AND company_id=p_company_id FOR UPDATE;
  IF c.state<>'needs_attention' THEN
    IF c.receipt->'reviewDecision'->>'action'=p_action THEN RETURN jsonb_build_object('queued',false); END IF;
    RAISE EXCEPTION 'MIGRATION_REVIEW_STALE';
  END IF;
  IF p_action='source' AND c.error_code IS DISTINCT FROM 'MIGRATION_SOURCE_CHANGED' THEN
    -- Only this record re-enters its failed phase. Other outstanding records stay stopped.
    UPDATE migration_job_chunks SET state=CASE error_phase WHEN 'link' THEN 'imported'
      WHEN 'reconcile' THEN 'linked' WHEN 'settle' THEN 'planned' ELSE 'pending' END,
      receipt=receipt||jsonb_build_object('previous_error_code',error_code,'reviewDecision',
        jsonb_build_object('action','source','by',p_user_id,'at',clock_timestamp())),error_code=NULL,error_phase=NULL WHERE id=c.id;
    UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=COALESCE(c.error_phase,'import'),
      worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
    RETURN jsonb_build_object('queued',true);
  END IF;
  IF p_action='source' THEN
    IF c.target_id IS NULL OR p_values IS NULL OR jsonb_typeof(p_values)<>'object'
      OR (p_items IS NOT NULL AND jsonb_typeof(p_items)<>'array') THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
    tbl:=CASE c.resource WHEN 'salesInvoices' THEN 'invoices' WHEN 'supplierInvoices' THEN 'supplier_invoices'
      WHEN 'customers' THEN 'customers' WHEN 'suppliers' THEN 'suppliers' END;
    IF tbl IS NULL THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
    EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 AND company_id=$2 FOR UPDATE',tbl)
      INTO old_row USING c.target_id,p_company_id;
    IF old_row IS NULL OR p_expected_updated_at IS NULL
      OR (old_row->>'updated_at')::timestamptz IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'MIGRATION_REVIEW_STALE'; END IF;
    IF c.resource IN ('salesInvoices','supplierInvoices') THEN
      allowed:=ARRAY['invoice_number','supplier_invoice_number','invoice_date','due_date','delivery_date','status',
        'currency','subtotal','vat_amount','total','subtotal_sek','vat_amount_sek','total_sek','exchange_rate','vat_rate','vat_treatment','reverse_charge','paid_amount','remaining_amount','paid_at','payment_reference','notes','is_credit_note'];
      protected:=old_row->>'journal_entry_id' IS NOT NULL OR old_row->>'registration_journal_entry_id' IS NOT NULL
        OR old_row->>'payment_journal_entry_id' IS NOT NULL;
      IF c.resource='supplierInvoices' THEN
        protected:=protected OR EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE supplier_invoice_id=c.target_id);
      ELSE
        protected:=protected OR EXISTS(SELECT 1 FROM invoice_payments WHERE invoice_id=c.target_id);
      END IF;
      IF protected AND (p_items IS NOT NULL OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k
        WHERE k NOT IN ('notes','payment_reference','due_date'))) THEN
        RAISE EXCEPTION 'MIGRATION_REVIEW_BOOKED_CONFLICT'; END IF;
    ELSE
      allowed:=ARRAY['name','email','phone','address_line1','address_line2','postal_code','city','country','org_number',
        'vat_number','bankgiro','plusgiro','bank_account','default_payment_terms','notes'];
      IF p_items IS NOT NULL THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_values) k WHERE NOT(k=ANY(allowed))) THEN
      RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
    SELECT string_agg(format('%1$I=(jsonb_populate_record(NULL::public.%2$I,$1)).%1$I',k,tbl),',')
      INTO assignments FROM jsonb_object_keys(p_values) k;
    IF assignments IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I SET %s WHERE id=$2 AND company_id=$3',tbl,assignments)
        USING p_values,c.target_id,p_company_id;
    END IF;
    IF p_items IS NOT NULL THEN
      IF jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'MIGRATION_REVIEW_INVALID'; END IF;
      child_table:=CASE c.resource WHEN 'salesInvoices' THEN 'invoice_items' ELSE 'supplier_invoice_items' END;
      parent_key:=CASE c.resource WHEN 'salesInvoices' THEN 'invoice_id' ELSE 'supplier_invoice_id' END;
      EXECUTE format('DELETE FROM public.%I WHERE %I=$1',child_table,parent_key) USING c.target_id;
      FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        PERFORM insert_provider_migration_row(child_table,(item-'id'-'invoice_id'-'supplier_invoice_id')||jsonb_build_object(parent_key,c.target_id));
      END LOOP;
    END IF;
  END IF;
  -- Acknowledge exactly this source version, including an explicit decision to keep the local values.
  UPDATE migration_source_records SET source_hash=c.source_hash WHERE company_id=p_company_id AND provider=j.provider
    AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id AND target_id=c.target_id;
  UPDATE migration_job_chunks SET state=CASE p_action WHEN 'ignore' THEN 'skipped' ELSE 'done' END,
    error_code=NULL,error_phase=NULL,receipt=receipt||jsonb_build_object('reason',CASE p_action WHEN 'ignore' THEN 'ignored' ELSE 'source_applied' END,
      'reviewDecision',jsonb_build_object('action',p_action,'by',p_user_id,'at',clock_timestamp(),'sourceHash',c.source_hash)) WHERE id=c.id;
  IF j.phase='completed' AND NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id
    AND state IN ('needs_attention','pending','imported','linked','planned')) THEN
    UPDATE migration_jobs SET state='completed',review_accepted_at=clock_timestamp(),review_deferred_at=NULL,error_code=NULL WHERE id=j.id;
  END IF;
  RETURN jsonb_build_object('queued',false);
END $$;
REVOKE ALL ON FUNCTION public.decide_provider_migration_record(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.decide_provider_migration_record(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.save_provider_migration_page(p_job_id uuid,p_worker_id uuid,p_attempt integer,
  p_resource text,p_page integer,p_records jsonb,p_next_page integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; r jsonb; prior public.migration_source_records; target_exists boolean; ignored boolean; tbl text;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'discover' OR j.resources[j.resource_index]<>p_resource OR j.next_page<>p_page THEN
    RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT';
  END IF;
  IF jsonb_array_length(p_records)>1000 THEN RAISE EXCEPTION 'MIGRATION_PAGE_TOO_LARGE'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO prior FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
      AND account_key=j.account_key AND resource=p_resource AND source_id=r->>'source_id';
    -- Ignore only the exact reviewed version; a changed source remains reviewable.
    ignored:=EXISTS(SELECT 1 FROM migration_job_chunks previous JOIN migration_jobs old ON old.id=previous.job_id
      WHERE previous.company_id=j.company_id AND old.provider=j.provider AND old.account_key=j.account_key
        AND previous.resource=p_resource AND previous.source_id=r->>'source_id' AND previous.source_hash=r->>'source_hash'
        AND previous.state='skipped' AND previous.receipt->'reviewDecision'->>'action'='ignore');
    target_exists:=false;
    IF prior.target_id IS NOT NULL THEN
      tbl:=CASE p_resource WHEN 'salesInvoices' THEN 'invoices' WHEN 'supplierInvoices' THEN 'supplier_invoices' ELSE p_resource END;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND company_id=$2)',tbl)
        INTO target_exists USING prior.target_id,j.company_id;
    END IF;
    INSERT INTO migration_job_chunks(job_id,company_id,resource,source_id,resource_order,payload,payload_hash,source_hash,state,target_id,receipt,error_code,error_phase)
    VALUES(j.id,j.company_id,p_resource,r->>'source_id',j.resource_index,r->>'payload',r->>'payload_hash',r->>'source_hash',
      CASE WHEN ignored THEN 'skipped' WHEN r ? 'skip' THEN 'skipped' WHEN target_exists AND prior.source_hash=r->>'source_hash' THEN 'skipped'
        WHEN target_exists AND prior.source_hash IS NOT NULL THEN 'needs_attention' ELSE 'pending' END,
      CASE WHEN r ? 'skip' THEN NULL WHEN target_exists THEN prior.target_id END,
      CASE WHEN ignored THEN '{"reason":"ignored"}'::jsonb WHEN r ? 'skip' THEN jsonb_build_object('reason',r->>'skip')
        WHEN target_exists AND prior.source_hash=r->>'source_hash' THEN '{"reason":"unchanged"}'::jsonb
        WHEN target_exists AND prior.source_hash IS NOT NULL THEN '{"reason":"source_changed"}'::jsonb ELSE '{}'::jsonb END,
      CASE WHEN NOT ignored AND NOT(r ? 'skip') AND target_exists AND prior.source_hash IS NOT NULL AND prior.source_hash IS DISTINCT FROM r->>'source_hash'
        THEN 'MIGRATION_SOURCE_CHANGED' END,
      CASE WHEN NOT ignored AND NOT(r ? 'skip') AND target_exists AND prior.source_hash IS NOT NULL AND prior.source_hash IS DISTINCT FROM r->>'source_hash' THEN 'import' END)
    ON CONFLICT(job_id,resource,source_id) DO NOTHING;
  END LOOP;
  IF p_next_page IS NULL THEN
    UPDATE migration_jobs SET resource_index=resource_index+1,next_page=1,
      phase=CASE WHEN resource_index=cardinality(resources) THEN 'import' ELSE 'discover' END,
      failures=0,error_code=NULL WHERE id=j.id;
  ELSIF p_next_page=0 THEN
    NULL; -- A persisted segment of an upstream page; its cursor stays put.
  ELSIF p_next_page=p_page+1 THEN
    UPDATE migration_jobs SET next_page=p_next_page,failures=0,error_code=NULL WHERE id=j.id;
  ELSE RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.provider_migration_counts(p_job_id uuid)
RETURNS TABLE(resource text,total bigint,imported bigint,completed bigint,skipped bigint,needs_attention bigint,pending bigint,
  fx_unresolved bigint,vat_unresolved bigint,credit_notes_unlinked bigint,credit_notes_linked bigint,outside_years_stale bigint,unchanged bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
  SELECT c.resource,count(*),count(*) FILTER(WHERE c.target_id IS NOT NULL AND COALESCE(c.receipt->>'reason','') NOT IN ('unchanged','source_changed','ignored','source_applied')),count(*) FILTER(WHERE c.state='done'),
    count(*) FILTER(WHERE c.state='skipped' AND COALESCE(c.receipt->>'reason','')<>'unchanged'),count(*) FILTER(WHERE c.state='needs_attention'),
    count(*) FILTER(WHERE c.state IN ('pending','imported','linked','planned')),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'fxUnresolved'='true'),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'vatUnresolved'='true'),
    -- No reference at all (flagged at import), or a reference the link phase
    -- could not resolve. 'imported' means the link phase has not run yet:
    -- such a row is not unlinked, it is not yet paired.
    count(*) FILTER(WHERE c.receipt->'warnings'->>'creditNoteUnlinked'='true'
      OR (c.resource='salesInvoices' AND c.target_id IS NOT NULL AND c.state<>'imported'
        AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
        AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
          AND i.credited_invoice_id IS NOT NULL))),
    count(*) FILTER(WHERE c.resource='salesInvoices' AND c.target_id IS NOT NULL
      AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
      AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
        AND i.credited_invoice_id IS NOT NULL)),
    -- Declined as outside the imported years before more years were imported:
    -- a retry judges them again (provider_migration_stale_year_skips).
    count(*) FILTER(WHERE c.id IN (SELECT provider_migration_stale_year_skips(p_job_id))),
    count(*) FILTER(WHERE c.receipt->>'reason'='unchanged')
  FROM migration_job_chunks c WHERE c.job_id=p_job_id GROUP BY c.resource;
$$;

NOTIFY pgrst,'reload schema';
