create extension if not exists pgcrypto;

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  title text not null,
  image_url text not null,
  storage_path text,
  position integer not null,
  created_at timestamptz not null default now(),
  unique(category_id, position)
);

alter table items add column if not exists storage_path text;

create table if not exists app_settings (
  id integer primary key check (id = 1),
  active_category_id uuid references categories(id) on delete set null
);
insert into app_settings(id) values (1) on conflict (id) do nothing;

create table if not exists admin_sessions (
  user_id bigint primary key,
  category_id uuid references categories(id) on delete cascade,
  mode text not null default 'awaiting_photo',
  pending_file_id text,
  pending_item_id uuid references items(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table admin_sessions add column if not exists pending_item_id uuid references items(id) on delete set null;

alter table categories enable row level security;
alter table items enable row level security;
alter table app_settings enable row level security;
alter table admin_sessions enable row level security;

insert into storage.buckets (id, name, public)
values ('blind-ranking-images', 'blind-ranking-images', true)
on conflict (id) do update set public = true;


-- Version 2.2: Ausgabe-Einstellungen und Abstimmungsverteilung
alter table categories add column if not exists send_images boolean not null default true;

create table if not exists game_votes (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references categories(id) on delete cascade,
  chat_id bigint not null,
  user_id bigint not null,
  player_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(category_id, chat_id, user_id)
);

create table if not exists vote_entries (
  vote_id uuid not null references game_votes(id) on delete cascade,
  item_id uuid not null references items(id) on delete cascade,
  position integer not null check (position > 0),
  primary key(vote_id, item_id),
  unique(vote_id, position)
);

alter table game_votes enable row level security;
alter table vote_entries enable row level security;

-- Version 2.8: getrennte Telegram-Forenthemen für Umfrage-Link und Ergebnisse
create table if not exists group_topic_settings (
  chat_id bigint primary key,
  poll_thread_id bigint,
  results_thread_id bigint,
  updated_at timestamptz not null default now()
);

alter table group_topic_settings enable row level security;


-- Version 3.0: Rollen- und Tokenverwaltung
create table if not exists bot_users (
  user_id bigint primary key,
  role text not null check (role in ('owner','creator','player')),
  username text,
  display_name text,
  active boolean not null default true,
  approved_by bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invite_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  token_hint text not null,
  role text not null check (role in ('creator','player')),
  created_by bigint not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  used_by bigint,
  used_at timestamptz,
  revoked_at timestamptz
);

alter table bot_users enable row level security;
alter table invite_tokens enable row level security;

-- Version 3.1: Player sind öffentlich; Creator erhalten Kategorienkontingente
alter table bot_users add column if not exists category_limit integer check (category_limit is null or category_limit > 0);
alter table bot_users add column if not exists categories_used integer not null default 0 check (categories_used >= 0);
alter table invite_tokens add column if not exists category_limit integer check (category_limit is null or category_limit > 0);

-- Bestehende aktive Creator werden aus Kompatibilitätsgründen unbegrenzt geführt.
update bot_users
set category_limit = null,
    categories_used = greatest(categories_used, (
      select count(*)::integer from categories where categories.created_by = bot_users.user_id
    ))
where role = 'creator';

-- Alte Player-Freigaben werden nicht mehr benötigt; Player sind automatisch alle Nutzer.
update bot_users set active = false where role = 'player';

-- Version 3.4: Zusätzliche Owner können über bot_users mit role='owner' gespeichert werden.
-- Die bestehende Rollenprüfung erlaubt 'owner' bereits; keine destruktive Migration nötig.


-- Version 3.7: mehrere Spieltypen
alter table categories add column if not exists game_type text not null default 'blind_ranking' check (game_type in ('blind_ranking','fmk'));
create index if not exists categories_game_type_idx on categories(game_type);

-- Version 3.9: eigenständige Budget Challenge für Influencerinnen
create table if not exists budget_games (
  id uuid primary key default gen_random_uuid(),
  creator_id bigint not null,
  title text not null,
  budget_amount integer not null check (budget_amount > 0),
  currency_label text not null default '€',
  min_selections integer check (min_selections is null or min_selections > 0),
  max_selections integer check (max_selections is null or max_selections > 0),
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(creator_id, title)
);

create table if not exists budget_items (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references budget_games(id) on delete cascade,
  name text not null,
  image_url text not null,
  storage_path text,
  price integer not null check (price > 0),
  sort_order integer not null,
  created_at timestamptz not null default now(),
  unique(game_id, sort_order)
);

create table if not exists budget_votes (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references budget_games(id) on delete cascade,
  chat_id bigint not null,
  user_id bigint not null,
  player_name text not null,
  total_spent integer not null check (total_spent >= 0),
  remaining_budget integer not null check (remaining_budget >= 0),
  created_at timestamptz not null default now(),
  unique(game_id, chat_id, user_id)
);

create table if not exists budget_vote_entries (
  vote_id uuid not null references budget_votes(id) on delete cascade,
  item_id uuid not null references budget_items(id) on delete cascade,
  price_at_vote integer not null check (price_at_vote > 0),
  primary key(vote_id, item_id)
);

create table if not exists budget_admin_sessions (
  user_id bigint primary key,
  game_id uuid references budget_games(id) on delete cascade,
  mode text not null default 'idle',
  pending_file_id text,
  updated_at timestamptz not null default now()
);

create index if not exists budget_games_creator_idx on budget_games(creator_id, created_at desc);
create index if not exists budget_items_game_idx on budget_items(game_id, sort_order);
create index if not exists budget_votes_game_chat_idx on budget_votes(game_id, chat_id);

alter table budget_games enable row level security;
alter table budget_items enable row level security;
alter table budget_votes enable row level security;
alter table budget_vote_entries enable row level security;
alter table budget_admin_sessions enable row level security;

-- Version 4.2: Influencerin anhand von Bildausschnitten erraten
alter table if exists categories add column if not exists send_images boolean not null default true;
alter table if exists budget_games add column if not exists send_images boolean not null default true;
create table if not exists guess_games (
  id uuid primary key default gen_random_uuid(), creator_id bigint not null, title text not null,
  answer_mode text not null default 'free_text' check (answer_mode in ('free_text','multiple_choice')),
  hints_enabled boolean not null default true, send_images boolean not null default true,
  is_active boolean not null default false, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists guess_people (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references guess_games(id) on delete cascade,
  display_name text not null, aliases jsonb not null default '[]'::jsonb, social_handle text, sort_order integer not null default 0, created_at timestamptz not null default now()
);
create table if not exists guess_media (
  id uuid primary key default gen_random_uuid(), person_id uuid not null references guess_people(id) on delete cascade,
  media_url text not null, media_type text not null default 'image' check(media_type in ('image','animation')),
  hint_level integer not null default 1, sort_order integer not null default 0, created_at timestamptz not null default now()
);
create table if not exists guess_answers (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references guess_games(id) on delete cascade,
  person_id uuid not null references guess_people(id) on delete cascade, user_id bigint not null, chat_id text,
  submitted_answer text not null, normalized_answer text not null, similarity_score numeric not null default 0,
  is_correct boolean not null default false, points integer not null default 0, created_at timestamptz not null default now()
);
create index if not exists guess_people_game_idx on guess_people(game_id);
create index if not exists guess_media_person_idx on guess_media(person_id);
create index if not exists guess_answers_game_idx on guess_answers(game_id, chat_id);

-- Version 4.3: einheitliche Kategorienverwaltung und Rate-Assistent
alter table if exists guess_games add column if not exists game_mode text not null default 'collection' check (game_mode in ('single','collection'));
alter table if exists guess_games add column if not exists show_own_choice boolean not null default true;
alter table if exists guess_games add column if not exists show_community_result boolean not null default true;
alter table if exists guess_games add column if not exists auto_send_results boolean not null default true;
alter table if exists categories add column if not exists show_own_choice boolean not null default true;
alter table if exists categories add column if not exists show_community_result boolean not null default true;
alter table if exists categories add column if not exists auto_send_results boolean not null default true;
alter table if exists budget_games add column if not exists show_own_choice boolean not null default true;
alter table if exists budget_games add column if not exists show_community_result boolean not null default true;
alter table if exists budget_games add column if not exists auto_send_results boolean not null default true;
alter table if exists items add column if not exists media_type text not null default 'image' check (media_type in ('image','animation'));
alter table if exists budget_items add column if not exists media_type text not null default 'image' check (media_type in ('image','animation'));
create table if not exists guess_admin_sessions (
  user_id bigint primary key,
  game_id uuid references guess_games(id) on delete cascade,
  person_id uuid references guess_people(id) on delete cascade,
  mode text not null default 'idle',
  game_mode text check (game_mode is null or game_mode in ('single','collection')),
  pending_value text,
  updated_at timestamptz not null default now()
);
alter table guess_admin_sessions enable row level security;

-- Version 4.3.2: Rate-Antwortmodus und mobile Mini-App
alter table if exists guess_games drop constraint if exists guess_games_answer_mode_check;
alter table if exists guess_games
  add constraint guess_games_answer_mode_check
  check (answer_mode in ('free_text', 'multiple_choice', 'mixed'));

-- Version 4.4: sichere Gruppen-Auswahl für alle Spiele
create table if not exists bot_groups (
  chat_id bigint primary key,
  title text not null,
  chat_type text not null default 'supergroup' check (chat_type in ('group','supergroup')),
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table bot_groups enable row level security;

-- Version 4.5: eigene Rate-Auswahloptionen und Position Ranking
alter table if exists guess_people add column if not exists distractors jsonb not null default '[]'::jsonb;
alter table if exists guess_people add column if not exists auto_fill_choices boolean not null default true;

create table if not exists position_games (
  id uuid primary key default gen_random_uuid(), creator_id bigint not null, title text not null,
  question text not null default 'Ordne deine Favoritinnen.', ranking_mode text not null default 'blind' check (ranking_mode in ('blind','open')),
  position_labels jsonb not null default '[]'::jsonb, send_images boolean not null default true,
  show_own_choice boolean not null default true, show_community_result boolean not null default true,
  auto_send_results boolean not null default true, is_active boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists position_items (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references position_games(id) on delete cascade,
  name text not null, media_url text not null, media_type text not null default 'image' check(media_type in ('image','animation')),
  sort_order integer not null default 0, created_at timestamptz not null default now()
);
create table if not exists position_votes (
  id uuid primary key default gen_random_uuid(), game_id uuid not null references position_games(id) on delete cascade,
  user_id bigint not null, chat_id text, created_at timestamptz not null default now()
);
create table if not exists position_vote_entries (
  id uuid primary key default gen_random_uuid(), vote_id uuid not null references position_votes(id) on delete cascade,
  item_id uuid not null references position_items(id) on delete cascade, rank integer not null,
  unique(vote_id,item_id), unique(vote_id,rank)
);
create table if not exists position_admin_sessions (
  user_id bigint primary key, game_id uuid references position_games(id) on delete cascade,
  mode text not null default 'idle', ranking_mode text check(ranking_mode is null or ranking_mode in ('blind','open')),
  pending_value text, updated_at timestamptz not null default now()
);
create index if not exists position_items_game_idx on position_items(game_id);
create index if not exists position_votes_game_idx on position_votes(game_id,chat_id);
alter table position_games enable row level security;
alter table position_items enable row level security;
alter table position_votes enable row level security;
alter table position_vote_entries enable row level security;
alter table position_admin_sessions enable row level security;
