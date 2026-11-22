BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid();
  bank uuid:=gen_random_uuid(); sales uuid:=gen_random_uuid(); entry uuid;
  base jsonb; incoming jsonb; prior jsonb; verdict text; i integer;
  j public.sie_imports; worker uuid:=gen_random_uuid(); entries jsonb:='[]';
  manifest jsonb:='{"input":{"filename":"synthetic.se","options":{},"mappings":[],"fiscalYear":{"start":"2026-01-01","end":"2026-12-31"}},"file_storage_path":"synthetic.se"}';
  gap jsonb:='{"count":1,"explanation":"Generated explanation for a skipped empty source voucher"}';
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(c,'SIE gap metadata fixture','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(c,u,'owner');
  INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end) VALUES(p,c,u,'2026','2026-01-01','2026-12-31');
  INSERT INTO chart_of_accounts(id,company_id,user_id,account_number,account_name,account_type,account_class,normal_balance)
    VALUES(bank,c,u,'1930','Bank','asset',1,'debit'),(sales,c,u,'3001','Sales','revenue',3,'credit');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  j:=start_sie_import_job(c,u,p,'synthetic.se',repeat('a',64),manifest,NULL);
  j:=claim_sie_import_job(worker,j.id);
  FOR i IN 1..2 LOOP
    base:=jsonb_build_object('sourceId','A'||i,'sourceOrdinal',i,'sieImportId',gen_random_uuid(),
      'series','A','date','2026-02-01','description','Read-only comparison','sourceSeries','A','sourceNumber',i,'sourceType','import',
      'lines',jsonb_build_array(
        jsonb_build_object('account_number','1930','account_id',bank,'debit_amount',100,'credit_amount',0,'dimensions','{}'::jsonb),
        jsonb_build_object('account_number','3001','account_id',sales,'debit_amount',0,'credit_amount',100,'dimensions','{}'::jsonb)));
    IF i=2 THEN base:=base||jsonb_build_object('numberGap',gap); END IF;
    entries:=entries||jsonb_build_array(base||jsonb_build_object('sieImportId',j.id));
  END LOOP;
  PERFORM save_sie_import_chunk(c,j.id,worker,j.job_attempt,'vouchers',0,entries);
  PERFORM seal_sie_import_preparation(c,j.id,worker,j.job_attempt,manifest,1);
  PERFORM import_sie_chunk(c,j.id,worker,j.job_attempt,'vouchers',0);
  PERFORM complete_sie_import_job(c,j.id,worker,j.job_attempt,
    '{"success":true,"journalEntriesCreated":2,"warnings":[]}'::jsonb,'{}'::jsonb);
  FOR i IN 1..2 LOOP
    base:=entries->(i-1);
    SELECT id,to_jsonb(t) INTO entry,prior FROM journal_entries t
      WHERE company_id=c AND import_batch_id=j.id AND source_voucher_series='A' AND source_voucher_number=i;

    incoming:=base||jsonb_build_object('numberGap',gap,'sourceOrdinal',90+i,'sieImportId',gen_random_uuid());
    SELECT outcome INTO verdict FROM classify_sie_resync_entries(c,p,jsonb_build_array(incoming));
    ASSERT verdict='unchanged','generated gap documentation changed a source voucher';
    SELECT outcome INTO verdict FROM classify_sie_resync_entries(c,p,jsonb_build_array(incoming||'{"description":"Actual source edit"}'));
    ASSERT verdict='changed','a changed description was hidden';
    SELECT outcome INTO verdict FROM classify_sie_resync_entries(c,p,jsonb_build_array(jsonb_set(incoming,'{date}','"2026-02-02"')));
    ASSERT verdict='changed','a changed date was hidden';
    SELECT outcome INTO verdict FROM classify_sie_resync_entries(c,p,jsonb_build_array(jsonb_set(incoming,'{lines,0,debit_amount}','200')));
    ASSERT verdict='changed','a changed amount was hidden';
    ASSERT (SELECT to_jsonb(t)=prior FROM journal_entries t WHERE id=entry),'comparison rewrote a posted entry';
  END LOOP;
  BEGIN
    PERFORM classify_sie_resync_entries(gen_random_uuid(),p,jsonb_build_array(incoming));
    RAISE EXCEPTION 'cross-company comparison accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $$;
ROLLBACK;
