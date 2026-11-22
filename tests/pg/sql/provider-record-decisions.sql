BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; old_job public.migration_jobs; target uuid; first_record uuid; second_record uuid;
  invoice uuid; paid_invoice uuid; customer uuid; sales uuid; revision timestamptz; before_row jsonb; result jsonb;
  a text:=repeat('a',64); b text:=repeat('b',64); c text:=repeat('c',64); original_payments integer;
BEGIN
  ASSERT NOT has_function_privilege('anon','public.decide_provider_migration_record(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz)','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','public.decide_provider_migration_record(uuid,uuid,uuid,uuid,text,jsonb,jsonb,timestamptz)','EXECUTE');
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),(viewer,viewer||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Record decision test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner'),(company,viewer,'viewer');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Record review','bokio','556000-0001');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'bokio','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status) VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  old_job:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);
  old_job:=claim_provider_migration_job(worker,old_job.id);
  PERFORM save_provider_migration_page(old_job.id,worker,old_job.attempt,'suppliers',1,
    jsonb_build_array(jsonb_build_object('source_id','sup-1','payload','encrypted-original','payload_hash','integrity','source_hash',a)),NULL);
  SELECT id INTO first_record FROM migration_job_chunks WHERE job_id=old_job.id;
  PERFORM commit_provider_migration_records(old_job.id,worker,old_job.attempt,jsonb_build_array(jsonb_build_object(
    'id',first_record,'row',jsonb_build_object('name','Original supplier','org_number','5560000001'))));
  SELECT target_id INTO target FROM migration_job_chunks WHERE id=first_record;
  UPDATE migration_jobs SET state='completed',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=old_job.id;
  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,jsonb_build_array(
    jsonb_build_object('source_id','sup-1','payload','encrypted-change','payload_hash','new-integrity','source_hash',b),
    jsonb_build_object('source_id','never-imported','payload','encrypted-other','payload_hash','other-integrity','source_hash',c)),NULL);
  SELECT id INTO first_record FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO second_record FROM migration_job_chunks WHERE job_id=j.id AND source_id='never-imported';
  UPDATE migration_job_chunks SET state='needs_attention',error_code='MIGRATION_ROWS_MISSING',error_phase='import' WHERE id=second_record;
  UPDATE migration_jobs SET state='completed',phase='completed',review_deferred_at=clock_timestamp(),worker_id=NULL,lease_until=NULL WHERE id=j.id;
  BEGIN
    PERFORM decide_provider_migration_record(j.id,first_record,company,viewer,'ignore');
    RAISE EXCEPTION 'viewer decision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  BEGIN
    PERFORM decide_provider_migration_record(j.id,first_record,gen_random_uuid(),u,'ignore');
    RAISE EXCEPTION 'foreign company accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  UPDATE migration_jobs SET state='needs_attention',phase='import' WHERE id=j.id;
  BEGIN
    PERFORM decide_provider_migration_record(j.id,first_record,company,u,'ignore');
    RAISE EXCEPTION 'unfinished import accepted a decision';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_BUSY'; END;
  UPDATE migration_jobs SET state='completed',phase='completed' WHERE id=j.id;
  SELECT updated_at INTO revision FROM suppliers WHERE id=target;
  BEGIN
    PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{"name":"Wrong"}',NULL,revision-interval '1 day');
    RAISE EXCEPTION 'stale decision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_STALE'; END;
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'ignore');
  ASSERT (SELECT name='Original supplier' FROM suppliers WHERE id=target),'ignore changed local values';
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=second_record),'ignore affected another issue';
  ASSERT (SELECT receipt->'reviewDecision'->>'by'=u::text FROM migration_job_chunks WHERE id=first_record),'decision actor missing';
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'ignore');
  PERFORM decide_provider_migration_record(j.id,second_record,company,u,'ignore');
  ASSERT (SELECT source_hash=b FROM migration_source_records WHERE company_id=company AND source_id='sup-1');
  ASSERT (SELECT imported=0 AND skipped=2 AND needs_attention=0 FROM provider_migration_counts(j.id) WHERE resource='suppliers'),'decisions counted as new imports';
  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,jsonb_build_array(
    jsonb_build_object('source_id','sup-1','payload','encrypted-same','payload_hash','same','source_hash',b),
    jsonb_build_object('source_id','never-imported','payload','encrypted-same','payload_hash','same','source_hash',c)),NULL);
  ASSERT (SELECT count(*)=2 FROM migration_job_chunks WHERE job_id=j.id AND state='skipped'),'ignored source versions prompted again';
  UPDATE migration_jobs SET state='completed',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,jsonb_build_array(
    jsonb_build_object('source_id','sup-1','payload','encrypted-new','payload_hash','new','source_hash',c)),NULL);
  SELECT id INTO first_record FROM migration_job_chunks WHERE job_id=j.id;
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=first_record),'new source version was silently ignored';
  UPDATE migration_jobs SET state='completed',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{"name":"Imported supplier"}',NULL,revision);
  ASSERT (SELECT name='Imported supplier' FROM suppliers WHERE id=target);
  ASSERT (SELECT source_hash=c FROM migration_source_records WHERE company_id=company AND source_id='sup-1');
  ASSERT (SELECT imported=0 AND completed=1 FROM provider_migration_counts(j.id) WHERE resource='suppliers');
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{"name":"Duplicate"}',NULL,revision);
  ASSERT (SELECT name='Imported supplier' FROM suppliers WHERE id=target),'repeated decision rewrote record';

  -- An already-linked payment cannot lose its date or amount on source acceptance.
  INSERT INTO supplier_invoices(id,company_id,user_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,total,paid_amount,remaining_amount,status)
    VALUES(gen_random_uuid(),company,u,target,1,'Paid','2026-10-14','2026-11-01',100,100,0,'paid') RETURNING id INTO paid_invoice;
  INSERT INTO supplier_invoice_payments(company_id,user_id,supplier_invoice_id,payment_date,amount,currency)
    VALUES(company,u,paid_invoice,'2026-09-01',100,'SEK');
  j:=create_provider_migration_job(company,u,consent,ARRAY['supplierInvoices'],NULL);
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'supplierInvoices',1,'paid-source','encrypted','integrity',a,'needs_attention','MIGRATION_SOURCE_CHANGED','import',paid_invoice) RETURNING id INTO first_record;
  UPDATE migration_jobs SET state='completed',phase='completed' WHERE id=j.id;
  SELECT updated_at,to_jsonb(i) INTO revision,before_row FROM supplier_invoices i WHERE id=paid_invoice;
  BEGIN
    PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{"paid_at":null}',NULL,revision);
    RAISE EXCEPTION 'linked payment overwritten';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_BOOKED_CONFLICT'; END;
  ASSERT (SELECT to_jsonb(i)=before_row FROM supplier_invoices i WHERE id=paid_invoice),'refusal altered invoice';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_payments WHERE supplier_invoice_id=paid_invoice);
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'ignore');

  -- Unbooked imported payment facts can be refreshed without creating a voucher or duplicate payment.
  INSERT INTO supplier_invoices(id,company_id,user_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,total,remaining_amount,status)
    VALUES(gen_random_uuid(),company,u,target,2,'Open','2026-11-12','2026-11-20',50,50,'overdue') RETURNING id INTO invoice;
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'supplierInvoices',1,'open-source','encrypted','integrity',a,'needs_attention','MIGRATION_SOURCE_CHANGED','import',invoice) RETURNING id INTO first_record;
  SELECT updated_at INTO revision FROM supplier_invoices WHERE id=invoice;
  SELECT count(*) INTO original_payments FROM supplier_invoice_payments;
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{"status":"paid","paid_amount":50,"remaining_amount":0}',NULL,revision);
  ASSERT (SELECT status='paid' AND paid_amount=50 AND remaining_amount=0 FROM supplier_invoices WHERE id=invoice);
  ASSERT (SELECT count(*)=original_payments FROM supplier_invoice_payments),'source created a payment';
  ASSERT NOT EXISTS(SELECT 1 FROM journal_entries WHERE company_id=company),'review wrote bookkeeping';

  -- Invoice line replacement uses the existing typed insert helper within the same transaction.
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'supplierInvoices',1,'rows-source','encrypted','integrity',b,'needs_attention','MIGRATION_SOURCE_CHANGED','import',invoice) RETURNING id INTO first_record;
  SELECT updated_at INTO revision FROM supplier_invoices WHERE id=invoice;
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{}',
    '[{"description":"Supplier line","quantity":1,"unit_price":50,"line_total":50,"vat_rate":0,"vat_amount":0,"sort_order":0,"account_number":"6540"}]',revision);
  ASSERT (SELECT count(*)=1 AND max(description)='Supplier line' FROM supplier_invoice_items WHERE supplier_invoice_id=invoice);
  INSERT INTO customers(user_id,company_id,name) VALUES(u,company,'Customer') RETURNING id INTO customer;
  INSERT INTO invoices(user_id,company_id,customer_id,invoice_date,due_date,status,total)
    VALUES(u,company,customer,'2026-11-12','2026-11-20','draft',50) RETURNING id INTO sales;
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'salesInvoices',1,'sales-rows','encrypted','integrity',c,'needs_attention','MIGRATION_SOURCE_CHANGED','import',sales) RETURNING id INTO first_record;
  SELECT updated_at INTO revision FROM invoices WHERE id=sales;
  PERFORM decide_provider_migration_record(j.id,first_record,company,u,'source','{}',
    '[{"description":"Sales line","quantity":1,"unit_price":50,"line_total":50,"vat_rate":0,"vat_amount":0,"sort_order":0}]',revision);
  ASSERT (SELECT count(*)=1 AND max(description)='Sales line' FROM invoice_items WHERE invoice_id=sales);

  -- Queueing one stopped record never resets the other outstanding records.
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase,target_id)
    VALUES(j.id,company,'supplierInvoices',1,'one','encrypted','integrity',a,'needs_attention','MIGRATION_PAYMENT_REVIEW','reconcile',invoice) RETURNING id INTO first_record;
  INSERT INTO migration_job_chunks(job_id,company_id,resource,resource_order,source_id,payload,payload_hash,source_hash,state,error_code,error_phase)
    VALUES(j.id,company,'supplierInvoices',1,'two','encrypted','integrity',b,'needs_attention','MIGRATION_ROWS_MISSING','import') RETURNING id INTO second_record;
  result:=decide_provider_migration_record(j.id,first_record,company,u,'source');
  ASSERT (result->>'queued')::boolean;
  ASSERT (SELECT state='linked' FROM migration_job_chunks WHERE id=first_record);
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=second_record),'source retried the whole job';
  BEGIN
    PERFORM decide_provider_migration_record(j.id,second_record,company,u,'ignore');
    RAISE EXCEPTION 'concurrent running decision accepted';
  EXCEPTION WHEN OTHERS THEN ASSERT SQLERRM='MIGRATION_REVIEW_BUSY'; END;
END $$;
ROLLBACK;
