-- Keep incremental provider sync compatible with upstream admission, attribution and review.
-- pg-test: tests/pg/provider-resync.pg.test.ts

CREATE OR REPLACE FUNCTION public.start_sie_import_job(p_company_id uuid, p_actor uuid,
  p_period_id uuid, p_filename text, p_file_hash text, p_manifest jsonb,
  p_supersedes_import_id uuid DEFAULT NULL) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; incremental boolean; v_refusal jsonb;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  IF p_file_hash !~ '^[0-9a-f]{64}$' OR p_file_hash IS NULL OR
     jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     octet_length(p_manifest::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid SIE import manifest' USING ERRCODE = '22023';
  END IF;
  incremental:=p_manifest #>> '{input,options,onExistingPeriod}'='incremental';
  IF incremental AND (p_supersedes_import_id IS NOT NULL
    OR (p_manifest #>> '{input,options,importOpeningBalances}')::boolean IS DISTINCT FROM false
    OR (p_manifest #>> '{input,options,importTransactions}')::boolean IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'Invalid incremental SIE options' USING ERRCODE='22023';
  END IF;
  -- Enqueue accepts source inputs only. Checkpoints are worker-owned state.
  p_manifest := jsonb_build_object('input',p_manifest->'input',
    'file_storage_path',p_manifest->'file_storage_path',
    'originalSource',p_manifest->'originalSource')
    || CASE WHEN jsonb_typeof(p_manifest->'commit_actor')='object' THEN jsonb_build_object('commit_actor',p_manifest->'commit_actor') ELSE '{}'::jsonb END;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id
    AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002'; END IF;
  IF (p_manifest #>> '{input,fiscalYear,start}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,end}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,start}')::date < v_period.period_start OR
     (p_manifest #>> '{input,fiscalYear,end}')::date > v_period.period_end OR
     (p_manifest #>> '{input,fiscalYear,start}')::date > (p_manifest #>> '{input,fiscalYear,end}')::date THEN
    RAISE EXCEPTION 'SIE source fiscal year does not fit the target period' USING ERRCODE = '22023';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked or closed' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id = p_company_id
    AND fiscal_period_id = p_period_id AND file_hash = p_file_hash
    AND job_state IS NOT NULL AND job_state NOT IN ('undone','failed')
    AND id IS DISTINCT FROM p_supersedes_import_id
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE retry has different mapping or options' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND job_state NOT IN ('completed','undone','failed') AND id IS DISTINCT FROM p_supersedes_import_id)
      OR (v_period.import_hold IS NOT NULL AND v_period.import_hold IS DISTINCT FROM p_supersedes_import_id) THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  END IF;
  -- What the year already holds (crm#1272): the rule the preflight reads.
  -- The job books the file's IB only when importOpeningBalances is true
  -- (sie-job-preparation.ts), so that is what the IB test is given.
  v_refusal := public.sie_import_admission_refusal(p_company_id, p_period_id, v_period.period_start,
    v_period.period_end, p_supersedes_import_id,
    (p_manifest #> '{input,options,importOpeningBalances}') IS NOT DISTINCT FROM 'true'::jsonb);
  IF v_refusal->>'reason' = 'unfinished_import' THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  ELSIF v_refusal->>'reason' = 'existing_import' AND NOT COALESCE(incremental,false) THEN
    RAISE EXCEPTION 'Existing SIE import requires reviewed replacement or reconciliation' USING ERRCODE = '55000';
  ELSIF v_refusal->>'reason' = 'opening_balance' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'SIE_IMPORT_PERIOD_HAS_OPENING_BALANCE: ' || (v_refusal->>'message');
  ELSIF v_refusal IS NOT NULL AND NOT (COALESCE(incremental,false) AND v_refusal->>'reason'='existing_import') THEN
    RAISE EXCEPTION 'SIE import refused: %', v_refusal->>'reason' USING ERRCODE = '55000';
  END IF;
  IF p_supersedes_import_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sie_imports
      WHERE id = p_supersedes_import_id AND company_id = p_company_id
      AND fiscal_period_id = p_period_id AND job_state IN ('undone','undoing')) THEN
    RAISE EXCEPTION 'SIE predecessor has not been completely undone' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.sie_imports(company_id, user_id, filename, file_hash, sie_type,
    fiscal_period_id, fiscal_year_start, fiscal_year_end, status, job_state, job_phase,
    manifest, supersedes_import_id, file_storage_path, execution_actor_id)
  VALUES (p_company_id, p_actor, p_filename, p_file_hash, 4, p_period_id,
    v_period.period_start, v_period.period_end, 'pending', 'queued', 'prepare',
    p_manifest || jsonb_build_object('prior_activity',public.sie_import_prior_activity(p_company_id,v_period.period_end,p_supersedes_import_id)),
    p_supersedes_import_id, p_manifest->>'file_storage_path', p_actor) RETURNING * INTO v_job;
  -- During replacement the predecessor keeps the hold until its last undo
  -- checkpoint. The successor cannot be claimed before that handoff.
  UPDATE public.fiscal_periods SET import_hold = v_job.id WHERE id = p_period_id AND import_hold IS NULL;
  RETURN v_job;
END;
$$;

DROP FUNCTION public.provider_migration_counts(uuid);
CREATE FUNCTION public.provider_migration_counts(p_job_id uuid)
RETURNS TABLE(resource text,total bigint,imported bigint,completed bigint,skipped bigint,needs_attention bigint,pending bigint,
  fx_unresolved bigint,vat_unresolved bigint,credit_notes_unlinked bigint,credit_notes_linked bigint,outside_years_stale bigint,unchanged bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
  SELECT c.resource,count(*),count(*) FILTER(WHERE c.target_id IS NOT NULL AND COALESCE(c.receipt->>'reason','') NOT IN ('unchanged','source_changed')),count(*) FILTER(WHERE c.state='done'),
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
REVOKE ALL ON FUNCTION public.provider_migration_counts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_counts(uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';


CREATE OR REPLACE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; row_data jsonb; item jsonb;
  target uuid; party uuid; tbl text; ids uuid[]; row_result jsonb; was_new boolean; message text;
  legacy public.invoices; fortnox text;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'import' OR jsonb_array_length(p_records)>25 THEN RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF c.state<>'pending' THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'skip' THEN
        UPDATE migration_job_chunks SET state='skipped',receipt=jsonb_build_object('reason',r->>'skip') WHERE id=c.id;
        CONTINUE;
      END IF;
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF c.source_hash IS NULL AND r->>'source_hash' IS NOT NULL THEN
        IF r->>'source_hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'MIGRATION_SOURCE_HASH_INVALID'; END IF;
        c.source_hash:=r->>'source_hash';
        UPDATE migration_job_chunks SET source_hash=c.source_hash WHERE id=c.id;
      END IF;
      IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id
        AND source_hash IS NOT NULL AND source_hash IS DISTINCT FROM c.source_hash) THEN
        RAISE EXCEPTION 'MIGRATION_SOURCE_CHANGED'; END IF;
      IF c.resource IN ('customers','suppliers') THEN
        target:=resolve_provider_migration_party(j.id,c.resource,c.source_id,r->'row');
        UPDATE migration_source_records SET source_hash=c.source_hash WHERE company_id=j.company_id AND provider=j.provider
          AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
        UPDATE migration_job_chunks SET state='done',target_id=target,receipt='{"imported":true}' WHERE id=c.id;
        CONTINUE;
      END IF;
      tbl:=CASE c.resource WHEN 'salesInvoices' THEN 'invoices' ELSE 'supplier_invoices' END;
      SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      was_new:=false;
      party:=NULL;
      -- A sales invoice number is unique per company: it is the record's own
      -- identity. Adopt on it, never on the customer the job derived for it.
      IF target IS NULL AND c.resource='salesInvoices' AND NULLIF(r->'row'->>'invoice_number','') IS NOT NULL THEN
        SELECT * INTO legacy FROM invoices WHERE company_id=j.company_id AND invoice_number=r->'row'->>'invoice_number'
          FOR UPDATE;
        IF FOUND THEN
          IF legacy.invoice_date IS DISTINCT FROM (r->'row'->>'invoice_date')::date
            OR legacy.currency IS DISTINCT FROM r->'row'->>'currency'
            OR legacy.total IS DISTINCT FROM (r->'row'->>'total')::numeric THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
          END IF;
          IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
            AND account_key=j.account_key AND resource=c.resource AND target_id=legacy.id AND source_id<>c.source_id) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF legacy.customer_id IS NOT NULL THEN
            party:=adopt_provider_migration_invoice_party(j.id,r->>'party_source_id',legacy.customer_id);
          END IF;
          target:=legacy.id;
          INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
            VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
        END IF;
      END IF;
      IF party IS NULL THEN
        party:=resolve_provider_migration_party(j.id,
          CASE c.resource WHEN 'salesInvoices' THEN 'customers' ELSE 'suppliers' END,r->>'party_source_id',r->'party');
      END IF;
      row_data:=r->'row'||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id,
        CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,party);
      -- Fortnox numbers its supplier invoices itself (löpnummer, the chunk's
      -- source id), apart from the number the supplier printed. The row keeps
      -- it in fortnox_number, and a Fortnox record is recognised by it before
      -- anything else (crm#1157).
      fortnox:=CASE WHEN j.provider='fortnox' AND c.resource='supplierInvoices'
        AND NULLIF(btrim(c.source_id),'') IS NOT NULL AND c.source_id NOT LIKE 'missing:%' THEN btrim(c.source_id) END;
      IF fortnox IS NOT NULL THEN
        row_data:=row_data||jsonb_build_object('fortnox_number',fortnox);
        IF target IS NULL THEN
          SELECT id INTO target FROM supplier_invoices WHERE company_id=j.company_id AND fortnox_number=fortnox;
        END IF;
        -- An import from before fortnox_number holds the löpnummer as its
        -- supplier number: the same supplier, number and header is that
        -- invoice. The same supplier and number on another header is refused,
        -- never guessed at: it may be that invoice edited here, or another one.
        IF target IS NULL THEN
          SELECT array_agg(id) INTO ids FROM (SELECT id FROM supplier_invoices WHERE company_id=j.company_id
            AND supplier_id=party AND fortnox_number IS NULL AND supplier_invoice_number=fortnox LIMIT 2) earlier;
          IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF ids[1] IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM supplier_invoices WHERE id=ids[1]
              AND invoice_date=(row_data->>'invoice_date')::date AND currency=row_data->>'currency'
              AND total=(row_data->>'total')::numeric
              AND is_credit_note=COALESCE((row_data->>'is_credit_note')::boolean,false)) THEN
              RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS';
            END IF;
            target:=ids[1];
          END IF;
        END IF;
        IF target IS NOT NULL AND NOT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id
          AND provider=j.provider AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id) THEN
          IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
            AND account_key=j.account_key AND resource=c.resource AND target_id=target AND source_id<>c.source_id) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
            VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
        END IF;
      END IF;
      IF target IS NULL THEN
        -- Supplier numbers are references, not unique identities. Adopt an older
        -- document only on supplier AND number AND date/currency/total/kind.
        -- Source mappings remain the durable identity; ambiguous matches stop.
        -- Number-less records are identified exclusively by their source map.
        EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE company_id=$1
          AND COALESCE($2->>''supplier_invoice_number'','''')<>''-''
          AND %I=$2->>%L AND %I=($2->>%L)::uuid AND invoice_date=($2->>''invoice_date'')::date
          AND currency=$2->>''currency'' AND total=($2->>''total'')::numeric %s LIMIT 2) matches',
          tbl,CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE WHEN c.resource='supplierInvoices' THEN 'AND is_credit_note=COALESCE(($2->>''is_credit_note'')::boolean,false)' ELSE '' END)
          INTO ids USING j.company_id,row_data;
        IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        target:=ids[1];
        IF target IS NOT NULL AND EXISTS(SELECT 1 FROM migration_source_records
          WHERE company_id=j.company_id AND provider=j.provider AND account_key=j.account_key
            AND resource=c.resource AND target_id=target AND source_id<>c.source_id) THEN
          RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        IF target IS NULL THEN
          IF c.resource='supplierInvoices' THEN
            row_data:=row_data||jsonb_build_object('arrival_number',get_next_arrival_number(j.company_id));
          END IF;
          target:=insert_provider_migration_row(tbl,row_data);
          was_new:=true;
        END IF;
        INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
          VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
      END IF;
      -- A stored invoice taken for a Fortnox record carries its löpnummer from
      -- now on; one that carries another löpnummer is not this record.
      IF fortnox IS NOT NULL AND NOT was_new THEN
        IF EXISTS(SELECT 1 FROM supplier_invoices WHERE id=target AND fortnox_number<>fortnox) THEN
          RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        UPDATE supplier_invoices SET fortnox_number=fortnox
          WHERE id=target AND company_id=j.company_id AND fortnox_number IS NULL;
      END IF;
      -- Never fill a native/adopted document with rows for a different amount.
      EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2
        AND total=($3->>''total'')::numeric AND currency=$3->>''currency''',tbl) INTO ids USING target,j.company_id,row_data;
      IF ids IS NULL THEN RAISE EXCEPTION 'MIGRATION_INVOICE_CHANGED'; END IF;
      IF jsonb_array_length(r->'items')>0 THEN
        IF c.resource='salesInvoices' THEN
          row_result:=complete_invoice_rows(j.company_id,target,r->'items',
            CASE WHEN COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN NULL ELSE
              jsonb_build_object('subtotal',row_data->'subtotal','subtotal_sek',row_data->'subtotal_sek',
                'vat_amount',row_data->'vat_amount','vat_amount_sek',row_data->'vat_amount_sek',
                'vat_rate',row_data->'vat_rate','vat_treatment',row_data->'vat_treatment') END);
          IF NOT COALESCE((row_result->>'ok')::boolean,false) THEN RAISE EXCEPTION '%',row_result->>'code'; END IF;
          IF (row_result->>'wrote')::boolean THEN
            INSERT INTO processing_history(company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,actor,occurred_at)
            VALUES(j.company_id,j.id,'Invoice',target,'InvoiceRowsCompleted',
              jsonb_build_object('source','provider-migration-worker','provider',j.provider,'consent_id',j.consent_id,
                'rows',jsonb_array_length(r->'items'),'header_updated',row_result->'header_updated'),
              jsonb_build_object('type','user','id',j.user_id),clock_timestamp());
          END IF;
        ELSE
          PERFORM 1 FROM supplier_invoices WHERE id=target AND company_id=j.company_id FOR UPDATE;
          IF NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=target) THEN
            IF was_new AND NOT COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN
              UPDATE supplier_invoices SET subtotal=(row_data->>'subtotal')::numeric,
                subtotal_sek=(row_data->>'subtotal_sek')::numeric,vat_amount=(row_data->>'vat_amount')::numeric,
                vat_amount_sek=(row_data->>'vat_amount_sek')::numeric,vat_treatment=row_data->>'vat_treatment'
                WHERE id=target AND company_id=j.company_id;
            END IF;
            FOR item IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
              PERFORM insert_provider_migration_row('supplier_invoice_items',item||jsonb_build_object('supplier_invoice_id',target));
            END LOOP;
          END IF;
        END IF;
      END IF;
      UPDATE migration_source_records SET source_hash=c.source_hash WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      UPDATE migration_job_chunks SET target_id=target,state='imported',
        receipt=jsonb_build_object('imported',was_new,'link',r->'link','warnings',r->'warnings') WHERE id=c.id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal data.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase='import',
        error_code=CASE WHEN message LIKE 'MIGRATION_%' THEN split_part(message,E'\n',1) ELSE SQLSTATE END WHERE id=c.id;
    END;
  END LOOP;
  UPDATE migration_jobs SET failures=0,error_code=NULL WHERE id=j.id;
END $$;
NOTIFY pgrst, 'reload schema';
