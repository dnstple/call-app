# Profile field classification (Stage 2C1)

Every field collected during signup or editing, classified. Public Explore
payloads come exclusively from the `discoverable_companions` view, which
selects only the fields marked **public** below.

| Field | Where stored | Class | Notes |
|---|---|---|---|
| first_name | profiles | public | shown everywhere |
| last_name | profiles | private | only `last_initial` (first letter) is public |
| headline, bio, region | profiles | public | free text; users advised not to include contact details |
| age_band | profiles | public | band only, never DOB |
| languages, mediums, style | profiles | public | matching data |
| avatar_path / photo | profiles + Storage | public for discoverable Companions; private otherwise | served via signed URLs only |
| visibility, profile_status | profiles | protected system | trigger-frozen against user updates |
| verification | profiles / companion_profiles | protected system | no self-verification |
| role (profile_type) | profiles | protected system | immutable by users |
| legal names | profile_private_details | private/sensitive | not collected by current wizard; column reserved |
| date_of_birth | profile_private_details | sensitive | 18+ validation for Companions; never exposed |
| email, phone | profile_private_details | sensitive | never in public payloads (legacy profiles.email/phone are excluded from the view and slated for removal in 2C2) |
| Member preferences (duration, days, dayparts, styles, regular-companion, topics_to_avoid) | member_profiles | private (role) | visible only via profile_access |
| accessibility/comfort notes | profiles.accessibility_needs | sensitive | access-gated; never discoverable |
| is_accepting_new_members | companion_profiles | public | discovery filter |
| conversation_style | companion_profiles | public | |
| relationship_summary | coordinator_profiles | private (role) | |
| consent records | profile_access / managed_relationships | protected system | function-managed only |
| interests | interests + profile_interests | public for discoverable Companions; access-gated otherwise | controlled catalogue; custom free-text interests are not persisted in 2C1 (documented limitation) |
| favourites | favourites | private per account | nobody can see who favourited a profile |
| pricing, availability, offers, ratings | — | **deferred** | later milestones; never faked in Supabase mode |

Never present in Explore/public payloads: legal surname, DOB, email, phone,
street address, consent evidence, accessibility/health notes, account rows,
profile_access rows, auth user ids, moderation state.
