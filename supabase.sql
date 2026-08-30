create extension if not exists pgcrypto;

create table if not exists public.chat_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_telegram_id bigint not null,
  contact_name text not null default 'Kontakt',
  contact_status text not null default 'online',
  profile_photo_file_id text,
  current_side text not null default 'other' check (current_side in ('me','other')),
  theme text not null default 'light' check (theme in ('light','dark')),
  receipt_style text not null default 'blue' check (receipt_style in ('single','double','blue')),
  admin_state text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.chat_drafts add column if not exists contact_status text not null default 'online';
alter table public.chat_drafts add column if not exists profile_photo_file_id text;
alter table public.chat_drafts add column if not exists receipt_style text not null default 'blue';
alter table public.chat_drafts add column if not exists admin_state text;

create index if not exists chat_drafts_owner_active_idx on public.chat_drafts(owner_telegram_id, is_active, created_at desc);

create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chat_drafts(id) on delete cascade,
  sender_side text not null check (sender_side in ('me','other')),
  message_type text not null check (message_type in ('text','image')),
  text text,
  telegram_file_id text,
  telegram_message_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_chat_idx on public.chat_messages(chat_id, created_at);

alter table public.chat_drafts enable row level security;
alter table public.chat_messages enable row level security;
