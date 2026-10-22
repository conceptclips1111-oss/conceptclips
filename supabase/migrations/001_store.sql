-- Run once in the Supabase SQL editor on a NEW project. No sample users/products/payments.
begin;
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text unique not null, email text not null, name text not null,
  role text not null default 'customer' check(role in ('customer','admin'))
);
create function public.create_store_profile() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into profiles(id,phone,email,name,role) values(new.id, coalesce(new.phone,''), coalesce(new.raw_user_meta_data->>'contact_email',''), coalesce(new.raw_user_meta_data->>'name','Customer'), 'customer');
  return new;
end; $$;
create trigger create_store_profile after insert on auth.users for each row execute function public.create_store_profile();
create table public.products (
 id uuid primary key, title text not null, subject text not null, description text not null,
 overview text not null, price integer not null check(price>=100), pages integer not null check(pages>0),
 level text not null, color text not null, published boolean not null default false, file_key text,
 updated_at timestamptz not null default now(), check(not published or file_key is not null)
);
create table public.orders (
 id uuid primary key, user_id uuid not null references profiles(id), product_id uuid not null references products(id),
 amount integer not null check(amount>0), status text not null check(status in ('awaiting_payment','pending','approved','rejected')),
 transaction_id text unique, payer_name text, paid_at timestamptz, note text, rejection_reason text,
 created_at timestamptz not null default now(), submitted_at timestamptz, reviewed_at timestamptz,
 reviewed_by uuid references profiles(id), payee_name text not null, upi_id text not null, is_demo boolean not null default false,
 check(transaction_id is null or transaction_id = upper(transaction_id)),
 check(status not in ('pending','approved') or (transaction_id is not null and payer_name is not null and paid_at is not null))
);
create unique index one_active_order on orders(user_id,product_id) where status in ('awaiting_payment','pending','approved');
create index orders_user on orders(user_id,created_at desc);
create index orders_status on orders(status,submitted_at desc);
create table public.payment_references(transaction_id text primary key, order_id uuid not null references orders(id));
create view public.order_details with(security_invoker=true) as select o.*, p.title product_title,p.subject,u.name customer_name,u.phone customer_phone,u.email customer_email from orders o join products p on p.id=o.product_id join profiles u on u.id=o.user_id;
create table public.store_settings(id integer primary key check(id=1), data jsonb not null);
insert into store_settings values(1,'{"store_name":"Akhil Notes","upi_id":"","payee_name":"","payments_enabled":false,"support_email":""}');
create table public.audit_log(id uuid primary key default gen_random_uuid(), actor uuid not null references profiles(id), action text not null, target text not null, created_at timestamptz not null default now());
create table public.rate_limits(key text primary key, count integer not null, expires timestamptz not null);

-- All application data is accessed by the Worker with its server-only service role.
-- No browser client can list customers, edit prices, grant purchases, or read file keys.
alter table profiles enable row level security;
alter table products enable row level security;
alter table orders enable row level security;
alter table store_settings enable row level security;
alter table audit_log enable row level security;
alter table rate_limits enable row level security;
alter table payment_references enable row level security;
revoke all on table profiles,products,orders,order_details,store_settings,audit_log,rate_limits,payment_references from anon,authenticated;
grant all on table profiles,products,orders,order_details,store_settings,audit_log,rate_limits,payment_references to service_role;

create function public.create_store_order(p_order jsonb) returns uuid language plpgsql security definer set search_path=public as $$
declare existing uuid; pid uuid := (p_order->>'product_id')::uuid; uid uuid := (p_order->>'user_id')::uuid;
  item products%rowtype; config jsonb; created uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(uid::text||pid::text,0));
  select id into existing from orders where user_id=uid and product_id=pid order by created_at desc limit 1;
  if existing is not null then return existing; end if;
  select * into item from products where id=pid;
  if not found or not item.published or item.file_key is null then raise exception 'INVALID: These notes are not available.'; end if;
  select data into config from store_settings where id=1;
  if not (config->>'payments_enabled')::boolean then raise exception 'INVALID: Payments are temporarily paused.'; end if;
  created := (p_order->>'id')::uuid;
  insert into orders(id,user_id,product_id,amount,status,payee_name,upi_id,is_demo) values(created,uid,pid,item.price,'awaiting_payment',config->>'payee_name',config->>'upi_id',false);
  return created;
end; $$;
create function public.submit_store_payment(p_id uuid,p_user uuid,p_submission jsonb) returns void language plpgsql security definer set search_path=public as $$
declare item orders%rowtype;
begin
 select * into item from orders where id=p_id and user_id=p_user for update;
 if not found then raise exception 'NOT_FOUND: Order not found.'; end if;
 if item.status not in ('awaiting_payment','rejected') then raise exception 'CONFLICT: This order is already submitted or approved.'; end if;
 insert into payment_references values(upper(p_submission->>'transaction_id'),p_id) on conflict(transaction_id) do nothing;
 if exists(select 1 from payment_references where transaction_id=upper(p_submission->>'transaction_id') and order_id<>p_id) then raise exception 'CONFLICT: This transaction reference has already been submitted.'; end if;
 update orders set status='pending',transaction_id=upper(p_submission->>'transaction_id'),payer_name=p_submission->>'payer_name',paid_at=(p_submission->>'paid_at')::timestamptz,note=p_submission->>'note',submitted_at=now(),rejection_reason=null,reviewed_at=null,reviewed_by=null where id=p_id;
 insert into audit_log(actor,action,target) values(p_user,'payment.submitted',p_id::text);
end; $$;
create function public.review_store_payment(p_id uuid,p_actor uuid,p_approve boolean,p_reason text) returns void language plpgsql security definer set search_path=public as $$
declare current_status text;
begin
 if not exists(select 1 from profiles where id=p_actor and role='admin') then raise exception 'INVALID: Admin access required.'; end if;
 select status into current_status from orders where id=p_id for update;
 if not found then raise exception 'NOT_FOUND: Order not found.'; end if;
 if current_status<>'pending' then raise exception 'CONFLICT: This order is no longer awaiting review. Refresh the list.'; end if;
 if not p_approve and length(trim(p_reason))=0 then raise exception 'INVALID: A rejection reason is required.'; end if;
 update orders set status=case when p_approve then 'approved' else 'rejected' end,reviewed_at=now(),reviewed_by=p_actor,rejection_reason=case when p_approve then null else p_reason end where id=p_id;
 insert into audit_log(actor,action,target) values(p_actor,case when p_approve then 'payment.approved' else 'payment.rejected' end,p_id::text);
end; $$;
create function public.update_store_settings(p_settings jsonb,p_actor uuid) returns void language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from profiles where id=p_actor and role='admin') then raise exception 'INVALID: Admin access required.'; end if;
 update store_settings set data=p_settings where id=1;
 insert into audit_log(actor,action,target) values(p_actor,'settings.updated','store');
end; $$;
create function public.take_rate_limit(p_key text,p_limit integer,p_seconds integer) returns boolean language plpgsql security definer set search_path=public as $$
declare attempts integer;
begin
 delete from rate_limits where expires<now();
 insert into rate_limits values(p_key,1,now()+make_interval(secs=>p_seconds)) on conflict(key) do update set count=rate_limits.count+1 returning count into attempts;
 return attempts<=p_limit;
end; $$;
revoke all on function create_store_profile(),create_store_order(jsonb),submit_store_payment(uuid,uuid,jsonb),review_store_payment(uuid,uuid,boolean,text),update_store_settings(jsonb,uuid),take_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function create_store_order(jsonb),submit_store_payment(uuid,uuid,jsonb),review_store_payment(uuid,uuid,boolean,text),update_store_settings(jsonb,uuid),take_rate_limit(text,integer,integer) to service_role;
commit;
