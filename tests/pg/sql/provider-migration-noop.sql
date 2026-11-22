  -- Automatic no-ops retain the target byte-for-byte and acknowledge only this source version.
  ASSERT NOT has_function_privilege('authenticated','public.acknowledge_provider_migration_noop(uuid,uuid,uuid,uuid,timestamptz)','EXECUTE');
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id,source_hash)
    VALUES(company,u,j.provider,j.account_key,'suppliers','noop-supplier',target,a);
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'suppliers',1,'noop-supplier','encrypted','integrity',b,'needs_attention','MIGRATION_SOURCE_CHANGED','import',target) RETURNING id INTO first_record;
  SELECT to_jsonb(t),t.updated_at INTO before_row,revision FROM suppliers t WHERE id=target;
  BEGIN
    PERFORM acknowledge_provider_migration_noop(j.id,first_record,company,viewer,revision);
    RAISE EXCEPTION 'viewer acknowledged a no-op';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  BEGIN
    PERFORM acknowledge_provider_migration_noop(j.id,first_record,company,u,revision-interval '1 day');
    RAISE EXCEPTION 'stale no-op accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_STALE'; END;
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=first_record);
  ASSERT acknowledge_provider_migration_noop(j.id,first_record,company,u,revision);
  ASSERT (SELECT to_jsonb(t)=before_row FROM suppliers t WHERE id=target),'no-op wrote supplier fields or updated_at';
  ASSERT (SELECT source_hash=b FROM migration_source_records WHERE company_id=company AND source_id='noop-supplier');
  ASSERT (SELECT state='skipped' AND receipt->>'reason'='unchanged' AND receipt->>'automaticNoop'='true'
    AND receipt->'reviewDecision'->>'by'=u::text FROM migration_job_chunks WHERE id=first_record);
  ASSERT NOT acknowledge_provider_migration_noop(j.id,first_record,company,u,revision),'no-op repeated a decision';
  ASSERT (SELECT unchanged>=1 FROM provider_migration_counts(j.id) WHERE resource='suppliers');

  -- Posted payment evidence does not prevent an empty action, and is never rewritten.
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'supplierInvoices',1,'noop-paid','encrypted','integrity',c,'needs_attention','MIGRATION_SOURCE_CHANGED','import',paid_invoice) RETURNING id INTO first_record;
  SELECT to_jsonb(t),t.updated_at INTO before_row,revision FROM supplier_invoices t WHERE id=paid_invoice;
  SELECT count(*) INTO original_payments FROM supplier_invoice_payments WHERE supplier_invoice_id=paid_invoice;
  ASSERT acknowledge_provider_migration_noop(j.id,first_record,company,u,revision);
  ASSERT (SELECT to_jsonb(t)=before_row FROM supplier_invoices t WHERE id=paid_invoice);
  ASSERT (SELECT count(*)=original_payments FROM supplier_invoice_payments WHERE supplier_invoice_id=paid_invoice);
