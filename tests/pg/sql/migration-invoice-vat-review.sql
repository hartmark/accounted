BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid(); company uuid:=gen_random_uuid();
  supplier uuid:=gen_random_uuid(); inv uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); chunk uuid:=gen_random_uuid();
  revision timestamptz; original jsonb; before_journal bigint; v numeric;
BEGIN
  ASSERT NOT has_function_privilege('authenticated','public.confirm_migration_invoice_vat(uuid,uuid,uuid,uuid,timestamptz,numeric,integer)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','public.confirm_migration_invoice_vat(uuid,uuid,uuid,uuid,timestamptz,numeric,integer)','EXECUTE');
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (viewer,viewer||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'VAT test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner'),(company,viewer,'viewer');
  INSERT INTO suppliers(id,user_id,company_id,name,supplier_type) VALUES(supplier,u,company,'Supplier','swedish_business');
  INSERT INTO supplier_invoices(id,user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
    status,currency,subtotal,subtotal_sek,vat_amount,vat_amount_sek,total,total_sek,paid_amount,remaining_amount,vat_treatment)
    VALUES(inv,u,company,supplier,1,'1001','2026-11-03','2026-11-28','registered','SEK',763.2,763.2,0,0,763.2,763.2,0,763.2,'standard_25');
  INSERT INTO migration_jobs(id,company_id,user_id,provider,account_key,resources,phase,state)
    VALUES(job,company,u,'bokio','test',ARRAY['supplierInvoices'],'completed','completed');
  INSERT INTO migration_job_chunks(id,job_id,company_id,resource,resource_order,source_id,payload,payload_hash,state,target_id,receipt)
    VALUES(chunk,job,company,'supplierInvoices',1,'source','encrypted-original','integrity','done',inv,'{"warnings":{"vatUnresolved":true,"fxUnresolved":false}}');
  SELECT updated_at,to_jsonb(i) INTO revision,original FROM supplier_invoices i WHERE id=inv;
  SELECT count(*) INTO before_journal FROM journal_entries;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  BEGIN
    PERFORM confirm_migration_invoice_vat(job,chunk,company,viewer,revision,43.2,6);
    RAISE EXCEPTION 'viewer accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  BEGIN
    PERFORM confirm_migration_invoice_vat(job,chunk,gen_random_uuid(),u,revision,43.2,6);
    RAISE EXCEPTION 'foreign company accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  BEGIN
    PERFORM confirm_migration_invoice_vat(job,chunk,company,u,revision-interval '1 second',43.2,6);
    RAISE EXCEPTION 'stale revision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_STALE'; END;
  FOREACH v IN ARRAY ARRAY[-1::numeric,0.001,50,763.2,'NaN'::numeric] LOOP
    BEGIN
      PERFORM confirm_migration_invoice_vat(job,chunk,company,u,revision,v,6);
      RAISE EXCEPTION 'invalid VAT accepted';
    EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_VAT_INVALID'; END;
  END LOOP;
  -- No rewriting of an invoice with a settlement, even if its header is stale.
  INSERT INTO supplier_invoice_payments(company_id,user_id,supplier_invoice_id,payment_date,amount,currency)
    VALUES(company,u,inv,'2026-11-03',1,'SEK');
  BEGIN
    PERFORM confirm_migration_invoice_vat(job,chunk,company,u,revision,43.2,6);
    RAISE EXCEPTION 'settled invoice accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_BOOKED_CONFLICT'; END;
  DELETE FROM supplier_invoice_payments WHERE supplier_invoice_id=inv;
  PERFORM confirm_migration_invoice_vat(job,chunk,company,u,revision,43.2,6);
  ASSERT (SELECT subtotal=720 AND vat_amount=43.2 AND vat_treatment='reduced_6' AND total=763.2 AND remaining_amount=763.2
    FROM supplier_invoices WHERE id=inv),'header split did not reconcile';
  ASSERT (SELECT receipt->'warnings'->>'vatUnresolved'='false' AND receipt->'warnings'->>'fxUnresolved'='false'
    AND receipt->'vatReview'->>'by'=u::text AND (receipt->'vatReview'->'before'->>'vat_amount')::numeric=0
    AND payload='encrypted-original' AND payload_hash='integrity'
    FROM migration_job_chunks WHERE id=chunk),'review lost evidence or source snapshot';
  ASSERT (SELECT vat_unresolved=0 FROM provider_migration_counts(job) WHERE resource='supplierInvoices'),'warning remained';
  ASSERT (SELECT count(*) FROM journal_entries)=before_journal,'review wrote bookkeeping';
  BEGIN
    PERFORM confirm_migration_invoice_vat(job,chunk,company,u,revision,43.2,6);
    RAISE EXCEPTION 'stale warning accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_STALE'; END;
END $$;
ROLLBACK;
