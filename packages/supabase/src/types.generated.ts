
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "public": {
          Tables: {
            "content_entries": {
                  Row: {
                    "asks_for_feedback": boolean,"author_id": string,"canonical_url": string,"caption_excerpt": string | null,"created_at": string,"creator_note": string | null,"deleted_at": string | null,"id": string,"original_url": string,"platform": Database["public"]['Enums']["platform_kind"],"preview_meta": Json | null,"preview_state": Database["public"]['Enums']["preview_state"],"published_at": string,"status": Database["public"]['Enums']["entry_state"],"thumbnail_path": string | null,"thumbnail_source": string | null,"title": string | null,"url_hash": string
                  }
                  Insert: {
                    "asks_for_feedback"?: boolean,"author_id": string,"canonical_url": string,"caption_excerpt"?: string | null,"created_at"?: string,"creator_note"?: string | null,"deleted_at"?: string | null,"id"?: string,"original_url": string,"platform": Database["public"]['Enums']["platform_kind"],"preview_meta"?: Json | null,"preview_state"?: Database["public"]['Enums']["preview_state"],"published_at"?: string,"status"?: Database["public"]['Enums']["entry_state"],"thumbnail_path"?: string | null,"thumbnail_source"?: string | null,"title"?: string | null,"url_hash": string
                  }
                  Update: {
                    "asks_for_feedback"?: boolean,"author_id"?: string,"canonical_url"?: string,"caption_excerpt"?: string | null,"created_at"?: string,"creator_note"?: string | null,"deleted_at"?: string | null,"id"?: string,"original_url"?: string,"platform"?: Database["public"]['Enums']["platform_kind"],"preview_meta"?: Json | null,"preview_state"?: Database["public"]['Enums']["preview_state"],"published_at"?: string,"status"?: Database["public"]['Enums']["entry_state"],"thumbnail_path"?: string | null,"thumbnail_source"?: string | null,"title"?: string | null,"url_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"content_hashtags": {
                  Row: {
                    "content_entry_id": string,"hashtag_id": string,"position": number
                  }
                  Insert: {
                    "content_entry_id": string,"hashtag_id": string,"position": number
                  }
                  Update: {
                    "content_entry_id"?: string,"hashtag_id"?: string,"position"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_hashtags_content_entry_id_fkey"
      columns: ["content_entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "content_hashtags_content_entry_id_fkey"
      columns: ["content_entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "content_hashtags_content_entry_id_fkey"
      columns: ["content_entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "content_hashtags_hashtag_id_fkey"
      columns: ["hashtag_id"]
isOneToOne: false
      referencedRelation: "hashtags"
      referencedColumns: ["id"]
    }
                  ]
                },"credit_eligibility_reviews": {
                  Row: {
                    "decision": Database["public"]['Enums']["eligibility_state"],"feedback_id": string,"id": string,"reason": string | null,"reviewed_at": string,"reviewed_by": string | null,"user_id": string
                  }
                  Insert: {
                    "decision": Database["public"]['Enums']["eligibility_state"],"feedback_id": string,"id"?: string,"reason"?: string | null,"reviewed_at"?: string,"reviewed_by"?: string | null,"user_id": string
                  }
                  Update: {
                    "decision"?: Database["public"]['Enums']["eligibility_state"],"feedback_id"?: string,"id"?: string,"reason"?: string | null,"reviewed_at"?: string,"reviewed_by"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_eligibility_reviews_feedback_id_fkey"
      columns: ["feedback_id"]
isOneToOne: false
      referencedRelation: "feedback"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_eligibility_reviews_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "credit_eligibility_reviews_reviewed_by_fkey"
      columns: ["reviewed_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_eligibility_reviews_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "credit_eligibility_reviews_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"credit_ledger": {
                  Row: {
                    "available_at": string | null,"created_at": string,"created_by": string | null,"delta": number,"entry_id": string | null,"feedback_id": string | null,"id": string,"kind": Database["public"]['Enums']["credit_kind"],"note": string | null,"reverses_id": string | null,"status": Database["public"]['Enums']["ledger_status"],"user_id": string
                  }
                  Insert: {
                    "available_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"delta": number,"entry_id"?: string | null,"feedback_id"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["credit_kind"],"note"?: string | null,"reverses_id"?: string | null,"status": Database["public"]['Enums']["ledger_status"],"user_id": string
                  }
                  Update: {
                    "available_at"?: string | null,"created_at"?: string,"created_by"?: string | null,"delta"?: number,"entry_id"?: string | null,"feedback_id"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["credit_kind"],"note"?: string | null,"reverses_id"?: string | null,"status"?: Database["public"]['Enums']["ledger_status"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_ledger_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "credit_ledger_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_ledger_reverses_id_fkey"
      columns: ["reverses_id"]
isOneToOne: false
      referencedRelation: "credit_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "credit_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "credit_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"duration_consents": {
                  Row: {
                    "consent_version": string,"granted_at": string,"revoked_at": string | null,"source": string,"user_id": string
                  }
                  Insert: {
                    "consent_version": string,"granted_at"?: string,"revoked_at"?: string | null,"source"?: string,"user_id": string
                  }
                  Update: {
                    "consent_version"?: string,"granted_at"?: string,"revoked_at"?: string | null,"source"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "duration_consents_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "duration_consents_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"duration_events": {
                  Row: {
                    "band": Database["public"]['Enums']["duration_band"],"consent_version": string,"entry_id": string,"id": string,"received_at": string,"returned": boolean | null,"user_id": string
                  }
                  Insert: {
                    "band": Database["public"]['Enums']["duration_band"],"consent_version": string,"entry_id": string,"id"?: string,"received_at"?: string,"returned"?: boolean | null,"user_id": string
                  }
                  Update: {
                    "band"?: Database["public"]['Enums']["duration_band"],"consent_version"?: string,"entry_id"?: string,"id"?: string,"received_at"?: string,"returned"?: boolean | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "duration_events_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "duration_events_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "duration_events_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "duration_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "duration_events_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"feed_impressions": {
                  Row: {
                    "entry_id": string,"id": string,"opened": boolean,"opened_at": string | null,"position": number | null,"reason_code": string | null,"score": number | null,"served_at": string,"viewer_id": string
                  }
                  Insert: {
                    "entry_id": string,"id"?: string,"opened"?: boolean,"opened_at"?: string | null,"position"?: number | null,"reason_code"?: string | null,"score"?: number | null,"served_at"?: string,"viewer_id": string
                  }
                  Update: {
                    "entry_id"?: string,"id"?: string,"opened"?: boolean,"opened_at"?: string | null,"position"?: number | null,"reason_code"?: string | null,"score"?: number | null,"served_at"?: string,"viewer_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "feed_impressions_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feed_impressions_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "feed_impressions_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "feed_impressions_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "feed_impressions_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"feed_signals": {
                  Row: {
                    "created_at": string,"entry_id": string,"id": string,"signal": Database["public"]['Enums']["feed_signal_kind"],"viewer_id": string
                  }
                  Insert: {
                    "created_at"?: string,"entry_id": string,"id"?: string,"signal": Database["public"]['Enums']["feed_signal_kind"],"viewer_id": string
                  }
                  Update: {
                    "created_at"?: string,"entry_id"?: string,"id"?: string,"signal"?: Database["public"]['Enums']["feed_signal_kind"],"viewer_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "feed_signals_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feed_signals_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "feed_signals_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "feed_signals_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "feed_signals_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"feedback": {
                  Row: {
                    "author_id": string,"body": string,"created_at": string,"edited_at": string | null,"eligibility": Database["public"]['Enums']["eligibility_state"],"eligibility_reason": string | null,"entry_id": string,"hold_until": string | null,"id": string,"image_paths": (string)[],"opened_entry": boolean,"removed_at": string | null,"tags": (Database["public"]['Enums']["feedback_tag"])[]
                  }
                  Insert: {
                    "author_id": string,"body": string,"created_at"?: string,"edited_at"?: string | null,"eligibility"?: Database["public"]['Enums']["eligibility_state"],"eligibility_reason"?: string | null,"entry_id": string,"hold_until"?: string | null,"id"?: string,"image_paths"?: (string)[],"opened_entry"?: boolean,"removed_at"?: string | null,"tags"?: (Database["public"]['Enums']["feedback_tag"])[]
                  }
                  Update: {
                    "author_id"?: string,"body"?: string,"created_at"?: string,"edited_at"?: string | null,"eligibility"?: Database["public"]['Enums']["eligibility_state"],"eligibility_reason"?: string | null,"entry_id"?: string,"hold_until"?: string | null,"id"?: string,"image_paths"?: (string)[],"opened_entry"?: boolean,"removed_at"?: string | null,"tags"?: (Database["public"]['Enums']["feedback_tag"])[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "feedback_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "feedback_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feedback_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feedback_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "feedback_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    }
                  ]
                },"feedback_ratings": {
                  Row: {
                    "created_at": string,"entry_owner_id": string,"feedback_id": string,"id": string,"rater_id": string,"revised_at": string | null,"score": number,"source": string
                  }
                  Insert: {
                    "created_at"?: string,"entry_owner_id": string,"feedback_id": string,"id"?: string,"rater_id": string,"revised_at"?: string | null,"score": number,"source"?: string
                  }
                  Update: {
                    "created_at"?: string,"entry_owner_id"?: string,"feedback_id"?: string,"id"?: string,"rater_id"?: string,"revised_at"?: string | null,"score"?: number,"source"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "feedback_ratings_entry_owner_id_fkey"
      columns: ["entry_owner_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "feedback_ratings_entry_owner_id_fkey"
      columns: ["entry_owner_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feedback_ratings_feedback_id_fkey"
      columns: ["feedback_id"]
isOneToOne: true
      referencedRelation: "feedback"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "feedback_ratings_rater_id_fkey"
      columns: ["rater_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "feedback_ratings_rater_id_fkey"
      columns: ["rater_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"friendships": {
                  Row: {
                    "addressee_id": string,"created_at": string,"id": string,"pair_key": string | null,"requester_id": string,"responded_at": string | null,"state": Database["public"]['Enums']["friendship_state"]
                  }
                  Insert: {
                    "addressee_id": string,"created_at"?: string,"id"?: string,"pair_key"?: never,"requester_id": string,"responded_at"?: string | null,"state"?: Database["public"]['Enums']["friendship_state"]
                  }
                  Update: {
                    "addressee_id"?: string,"created_at"?: string,"id"?: string,"pair_key"?: never,"requester_id"?: string,"responded_at"?: string | null,"state"?: Database["public"]['Enums']["friendship_state"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "friendships_addressee_id_fkey"
      columns: ["addressee_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "friendships_addressee_id_fkey"
      columns: ["addressee_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "friendships_requester_id_fkey"
      columns: ["requester_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "friendships_requester_id_fkey"
      columns: ["requester_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"hashtags": {
                  Row: {
                    "created_at": string,"created_by": string | null,"id": string,"is_official": boolean,"label": string,"slug": string,"usage_count": number
                  }
                  Insert: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"is_official"?: boolean,"label": string,"slug": string,"usage_count"?: number
                  }
                  Update: {
                    "created_at"?: string,"created_by"?: string | null,"id"?: string,"is_official"?: boolean,"label"?: string,"slug"?: string,"usage_count"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "hashtags_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "hashtags_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"invite_code_redemptions": {
                  Row: {
                    "id": string,"invite_code_id": string,"redeemed_at": string,"user_id": string
                  }
                  Insert: {
                    "id"?: string,"invite_code_id": string,"redeemed_at"?: string,"user_id": string
                  }
                  Update: {
                    "id"?: string,"invite_code_id"?: string,"redeemed_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invite_code_redemptions_invite_code_id_fkey"
      columns: ["invite_code_id"]
isOneToOne: false
      referencedRelation: "invite_codes"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invite_code_redemptions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "invite_code_redemptions_user_id_fkey"
      columns: ["user_id"]
isOneToOne: true
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"invite_codes": {
                  Row: {
                    "code_hash": string,"code_length": number,"created_at": string,"created_by": string | null,"expires_at": string | null,"id": string,"label": string | null,"max_uses": number,"revoked_at": string | null,"used_count": number
                  }
                  Insert: {
                    "code_hash": string,"code_length": number,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"label"?: string | null,"max_uses": number,"revoked_at"?: string | null,"used_count"?: number
                  }
                  Update: {
                    "code_hash"?: string,"code_length"?: number,"created_at"?: string,"created_by"?: string | null,"expires_at"?: string | null,"id"?: string,"label"?: string | null,"max_uses"?: number,"revoked_at"?: string | null,"used_count"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "invite_codes_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "invite_codes_created_by_fkey"
      columns: ["created_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"invites": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"email": string,"expires_at": string | null,"id": string,"invited_by": string | null,"revoked_at": string | null,"role": Database["public"]['Enums']["profile_role"],"token_hash": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email": string,"expires_at"?: string | null,"id"?: string,"invited_by"?: string | null,"revoked_at"?: string | null,"role"?: Database["public"]['Enums']["profile_role"],"token_hash": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"email"?: string,"expires_at"?: string | null,"id"?: string,"invited_by"?: string | null,"revoked_at"?: string | null,"role"?: Database["public"]['Enums']["profile_role"],"token_hash"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "invites_accepted_by_fkey"
      columns: ["accepted_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "invites_accepted_by_fkey"
      columns: ["accepted_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "invites_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "invites_invited_by_fkey"
      columns: ["invited_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"moderation_actions": {
                  Row: {
                    "action": string,"actor_id": string | null,"created_at": string,"id": string,"meta": Json | null,"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Insert: {
                    "action": string,"actor_id"?: string | null,"created_at"?: string,"id"?: string,"meta"?: Json | null,"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Update: {
                    "action"?: string,"actor_id"?: string | null,"created_at"?: string,"id"?: string,"meta"?: Json | null,"target_id"?: string,"target_type"?: Database["public"]['Enums']["report_target"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "moderation_actions_actor_id_fkey"
      columns: ["actor_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "moderation_actions_actor_id_fkey"
      columns: ["actor_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"moderation_reports": {
                  Row: {
                    "created_at": string,"details": string | null,"id": string,"reason": string,"reporter_id": string,"resolution_note": string | null,"resolved_at": string | null,"resolved_by": string | null,"state": Database["public"]['Enums']["report_state"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Insert: {
                    "created_at"?: string,"details"?: string | null,"id"?: string,"reason": string,"reporter_id": string,"resolution_note"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"state"?: Database["public"]['Enums']["report_state"],"target_id": string,"target_type": Database["public"]['Enums']["report_target"]
                  }
                  Update: {
                    "created_at"?: string,"details"?: string | null,"id"?: string,"reason"?: string,"reporter_id"?: string,"resolution_note"?: string | null,"resolved_at"?: string | null,"resolved_by"?: string | null,"state"?: Database["public"]['Enums']["report_state"],"target_id"?: string,"target_type"?: Database["public"]['Enums']["report_target"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "moderation_reports_reporter_id_fkey"
      columns: ["reporter_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "moderation_reports_reporter_id_fkey"
      columns: ["reporter_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "moderation_reports_resolved_by_fkey"
      columns: ["resolved_by"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "moderation_reports_resolved_by_fkey"
      columns: ["resolved_by"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"mutes": {
                  Row: {
                    "created_at": string,"muted_profile_id": string,"viewer_id": string
                  }
                  Insert: {
                    "created_at"?: string,"muted_profile_id": string,"viewer_id": string
                  }
                  Update: {
                    "created_at"?: string,"muted_profile_id"?: string,"viewer_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "mutes_muted_profile_id_fkey"
      columns: ["muted_profile_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "mutes_muted_profile_id_fkey"
      columns: ["muted_profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "mutes_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "mutes_viewer_id_fkey"
      columns: ["viewer_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"outbound_clicks": {
                  Row: {
                    "clicked_at": string,"client": string | null,"entry_id": string,"id": string,"return_token": string | null,"returned_at": string | null,"source": string | null,"user_id": string
                  }
                  Insert: {
                    "clicked_at"?: string,"client"?: string | null,"entry_id": string,"id"?: string,"return_token"?: string | null,"returned_at"?: string | null,"source"?: string | null,"user_id": string
                  }
                  Update: {
                    "clicked_at"?: string,"client"?: string | null,"entry_id"?: string,"id"?: string,"return_token"?: string | null,"returned_at"?: string | null,"source"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "outbound_clicks_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "content_entries"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "outbound_clicks_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_feedback_summary"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "outbound_clicks_entry_id_fkey"
      columns: ["entry_id"]
isOneToOne: false
      referencedRelation: "entry_ranking_signals"
      referencedColumns: ["entry_id"]
    },{
      foreignKeyName: "outbound_clicks_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "outbound_clicks_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profile_hashtags": {
                  Row: {
                    "hashtag_id": string,"position": number,"profile_id": string
                  }
                  Insert: {
                    "hashtag_id": string,"position": number,"profile_id": string
                  }
                  Update: {
                    "hashtag_id"?: string,"position"?: number,"profile_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profile_hashtags_hashtag_id_fkey"
      columns: ["hashtag_id"]
isOneToOne: false
      referencedRelation: "hashtags"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "profile_hashtags_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "profile_hashtags_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profile_links": {
                  Row: {
                    "created_at": string,"id": string,"label": string | null,"platform": Database["public"]['Enums']["platform_kind"],"profile_id": string,"url": string
                  }
                  Insert: {
                    "created_at"?: string,"id"?: string,"label"?: string | null,"platform": Database["public"]['Enums']["platform_kind"],"profile_id": string,"url": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"label"?: string | null,"platform"?: Database["public"]['Enums']["platform_kind"],"profile_id"?: string,"url"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "profile_links_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "profile_links_profile_id_fkey"
      columns: ["profile_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_path": string | null,"bio": string | null,"created_at": string,"display_name": string,"handle": string,"id": string,"last_seen_at": string,"onboarding_completed_at": string | null,"rated_feedback_count": number,"reputation_avg": number | null,"reputation_total": number,"role": Database["public"]['Enums']["profile_role"]
                  }
                  Insert: {
                    "avatar_path"?: string | null,"bio"?: string | null,"created_at"?: string,"display_name": string,"handle": string,"id": string,"last_seen_at"?: string,"onboarding_completed_at"?: string | null,"rated_feedback_count"?: number,"reputation_avg"?: number | null,"reputation_total"?: number,"role"?: Database["public"]['Enums']["profile_role"]
                  }
                  Update: {
                    "avatar_path"?: string | null,"bio"?: string | null,"created_at"?: string,"display_name"?: string,"handle"?: string,"id"?: string,"last_seen_at"?: string,"onboarding_completed_at"?: string | null,"rated_feedback_count"?: number,"reputation_avg"?: number | null,"reputation_total"?: number,"role"?: Database["public"]['Enums']["profile_role"]
                  }
                  Relationships: [
                    
                  ]
                },"reputation_ledger": {
                  Row: {
                    "created_at": string,"delta": number,"feedback_id": string | null,"id": string,"kind": Database["public"]['Enums']["reputation_kind"],"rating_id": string | null,"reverses_id": string | null,"user_id": string
                  }
                  Insert: {
                    "created_at"?: string,"delta": number,"feedback_id"?: string | null,"id"?: string,"kind": Database["public"]['Enums']["reputation_kind"],"rating_id"?: string | null,"reverses_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"delta"?: number,"feedback_id"?: string | null,"id"?: string,"kind"?: Database["public"]['Enums']["reputation_kind"],"rating_id"?: string | null,"reverses_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reputation_ledger_feedback_id_fkey"
      columns: ["feedback_id"]
isOneToOne: false
      referencedRelation: "feedback"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reputation_ledger_rating_id_fkey"
      columns: ["rating_id"]
isOneToOne: false
      referencedRelation: "feedback_ratings"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reputation_ledger_reverses_id_fkey"
      columns: ["reverses_id"]
isOneToOne: false
      referencedRelation: "reputation_ledger"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "reputation_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "reputation_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"weekly_allowance_runs": {
                  Row: {
                    "amount": number,"granted_count": number,"period_start": string,"ran_at": string
                  }
                  Insert: {
                    "amount": number,"granted_count"?: number,"period_start": string,"ran_at"?: string
                  }
                  Update: {
                    "amount"?: number,"granted_count"?: number,"period_start"?: string,"ran_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            "credit_flow_summary": {
                  Row: {
                    "entries": number | null,"kind": Database["public"]['Enums']["credit_kind"] | null,"net_delta": number | null,"user_id": string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "credit_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "credit_ledger_user_id_fkey"
      columns: ["user_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"entry_feedback_summary": {
                  Row: {
                    "asks_for_feedback": boolean | null,"author_id": string | null,"average_score": number | null,"entry_id": string | null,"feedback_count": number | null,"published_at": string | null,"rated_count": number | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"entry_ranking_signals": {
                  Row: {
                    "asks_for_feedback": boolean | null,"author_id": string | null,"entry_id": string | null,"feedback_count": number | null,"hashtag_count": number | null,"hide_signals": number | null,"less_like_signals": number | null,"matched_profile_hashtags": number | null,"more_like_signals": number | null,"platform": Database["public"]['Enums']["platform_kind"] | null,"published_at": string | null
                  }
                  Insert: {
                           "asks_for_feedback"?: boolean | null,"author_id"?: string | null,"entry_id"?: string | null,"feedback_count"?: never,"hashtag_count"?: never,"hide_signals"?: never,"less_like_signals"?: never,"matched_profile_hashtags"?: never,"more_like_signals"?: never,"platform"?: Database["public"]['Enums']["platform_kind"] | null,"published_at"?: string | null
                         }
                        Update: {
                           "asks_for_feedback"?: boolean | null,"author_id"?: string | null,"entry_id"?: string | null,"feedback_count"?: never,"hashtag_count"?: never,"hide_signals"?: never,"less_like_signals"?: never,"matched_profile_hashtags"?: never,"more_like_signals"?: never,"platform"?: Database["public"]['Enums']["platform_kind"] | null,"published_at"?: string | null
                         }
                        Relationships: [
                    {
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profile_reputation"
      referencedColumns: ["profile_id"]
    },{
      foreignKeyName: "content_entries_author_id_fkey"
      columns: ["author_id"]
isOneToOne: false
      referencedRelation: "profiles"
      referencedColumns: ["id"]
    }
                  ]
                },"feed_impression_reasons": {
                  Row: {
                    "distinct_entries": number | null,"distinct_viewers": number | null,"impressions": number | null,"opened": number | null,"reason_code": string | null,"reason_label": string | null
                  }
                  Relationships: [
                    
                  ]
                },"member_retention_cohorts": {
                  Row: {
                    "cohort_week": string | null,"new_members": number | null,"retained_28d": number | null,"retained_7d": number | null,"retention_28d_pct": number | null,"retention_7d_pct": number | null
                  }
                  Relationships: [
                    
                  ]
                },"profile_reputation": {
                  Row: {
                    "badge": string | null,"handle": string | null,"profile_id": string | null,"rated_feedback_count": number | null,"reputation_avg": number | null,"reputation_total": number | null
                  }
                  Insert: {
                           "badge"?: never,"handle"?: string | null,"profile_id"?: string | null,"rated_feedback_count"?: number | null,"reputation_avg"?: number | null,"reputation_total"?: number | null
                         }
                        Update: {
                           "badge"?: never,"handle"?: string | null,"profile_id"?: string | null,"rated_feedback_count"?: number | null,"reputation_avg"?: number | null,"reputation_total"?: number | null
                         }
                        Relationships: [
                    
                  ]
                },"weekly_engagement_dashboard": {
                  Row: {
                    "active_creators": number | null,"avg_feedback_rating": number | null,"credits_earned_feedback": number | null,"credits_spent_submissions": number | null,"distribution_fairness_pct": number | null,"entries_published": number | null,"feed_open_rate_pct": number | null,"feedback_givers": number | null,"feedback_items": number | null,"feedback_per_opened_entry": number | null,"feedback_rated_count": number | null,"feedback_rated_pct": number | null,"opened_impressions": number | null,"submissions_per_active_creator": number | null,"total_impressions": number | null,"week": string | null,"week_start": string | null,"weekly_active_members": number | null
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Functions: {
            "acknowledge_return_token":
{ Args: { "p_token": string }; Returns: {
              "entry_id": string,"opened_at": string
            }[]
                           },
"admin_cap_credit":
{ Args: { "p_cap": number,"p_note"?: string,"p_user_id": string }; Returns: number
                           },
"admin_grant_credit":
{ Args: { "p_amount": number,"p_note"?: string,"p_user_id": string }; Returns: number
                           },
"admin_resolve_report":
{ Args: { "p_note"?: string,"p_report_id": string,"p_state": Database["public"]['Enums']["report_state"] }; Returns: {
              "created_at": string,
"details": string | null,
"id": string,
"reason": string,
"reporter_id": string,
"resolution_note": string | null,
"resolved_at": string | null,
"resolved_by": string | null,
"state": Database["public"]['Enums']["report_state"],
"target_id": string,
"target_type": Database["public"]['Enums']["report_target"]
            }
                          SetofOptions: {
        from: "*"
        to: "moderation_reports"
        isOneToOne: true
        isSetofReturn: false
      } },
"admin_reverse_credit":
{ Args: { "p_ledger_id": string,"p_note"?: string,"p_user_id": string }; Returns: number
                           },
"admin_set_role":
{ Args: { "p_role": Database["public"]['Enums']["profile_role"],"p_user_id": string }; Returns: {
              "avatar_path": string | null,
"bio": string | null,
"created_at": string,
"display_name": string,
"handle": string,
"id": string,
"last_seen_at": string,
"onboarding_completed_at": string | null,
"rated_feedback_count": number,
"reputation_avg": number | null,
"reputation_total": number,
"role": Database["public"]['Enums']["profile_role"]
            }
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"app_setting_int":
{ Args: { "p_default": number,"p_name": string }; Returns: number
                           },
"app_setting_num":
{ Args: { "p_default": number,"p_name": string }; Returns: number
                           },
"app_setting_num_int":
{ Args: { "p_default": number,"p_name": string }; Returns: number
                           },
"block_member":
{ Args: { "p_user_id": string }; Returns: {
              "addressee_id": string,
"created_at": string,
"id": string,
"pair_key": string | null,
"requester_id": string,
"responded_at": string | null,
"state": Database["public"]['Enums']["friendship_state"]
            }
                          SetofOptions: {
        from: "*"
        to: "friendships"
        isOneToOne: true
        isSetofReturn: false
      } },
"can_edit_feedback":
{ Args: { "p_feedback_id": string }; Returns: boolean
                           },
"can_view_entry":
{ Args: { "p_entry_id": string,"p_viewer": string }; Returns: boolean
                           },
"can_view_entry_hashtags":
{ Args: { "p_entry_id": string,"p_viewer": string }; Returns: boolean
                           },
"claim_invite":
{ Args: { "p_token_hash": string,"p_user_id": string }; Returns: {
              "accepted_at": string | null,
"accepted_by": string | null,
"created_at": string,
"email": string,
"expires_at": string | null,
"id": string,
"invited_by": string | null,
"revoked_at": string | null,
"role": Database["public"]['Enums']["profile_role"],
"token_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "invites"
        isOneToOne: true
        isSetofReturn: false
      } },
"claim_invite_code":
{ Args: { "p_code_hash": string,"p_user_id": string }; Returns: {
              "code_hash": string,
"code_length": number,
"created_at": string,
"created_by": string | null,
"expires_at": string | null,
"id": string,
"label": string | null,
"max_uses": number,
"revoked_at": string | null,
"used_count": number
            }
                          SetofOptions: {
        from: "*"
        to: "invite_codes"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_content_entry":
{ Args: { "p_asks_for_feedback"?: boolean,"p_canonical_url": string,"p_caption"?: string,"p_cover_path"?: string,"p_creator_note"?: string,"p_hashtags"?: (string)[],"p_platform": Database["public"]['Enums']["platform_kind"],"p_title"?: string,"p_url": string }; Returns: {
              "asks_for_feedback": boolean,
"author_id": string,
"canonical_url": string,
"caption_excerpt": string | null,
"created_at": string,
"creator_note": string | null,
"deleted_at": string | null,
"id": string,
"original_url": string,
"platform": Database["public"]['Enums']["platform_kind"],
"preview_meta": Json | null,
"preview_state": Database["public"]['Enums']["preview_state"],
"published_at": string,
"status": Database["public"]['Enums']["entry_state"],
"thumbnail_path": string | null,
"thumbnail_source": string | null,
"title": string | null,
"url_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "content_entries"
        isOneToOne: true
        isSetofReturn: false
      } },
"create_hashtag":
{ Args: { "p_label": string }; Returns: {
              "created_at": string,
"created_by": string | null,
"id": string,
"is_official": boolean,
"label": string,
"slug": string,
"usage_count": number
            }
                          SetofOptions: {
        from: "*"
        to: "hashtags"
        isOneToOne: true
        isSetofReturn: false
      } },
"credit_cap_ceiling":
{ Args: { "p_user_id": string }; Returns: number
                           },
"current_duration_consent_version":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"delete_own_duration_history":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"ensure_profile":
{ Args: Record<PropertyKey, never>; Returns: {
              "avatar_path": string | null,
"bio": string | null,
"created_at": string,
"display_name": string,
"handle": string,
"id": string,
"last_seen_at": string,
"onboarding_completed_at": string | null,
"rated_feedback_count": number,
"reputation_avg": number | null,
"reputation_total": number,
"role": Database["public"]['Enums']["profile_role"]
            }
                          SetofOptions: {
        from: "*"
        to: "profiles"
        isOneToOne: true
        isSetofReturn: false
      } },
"evaluate_feedback_eligibility":
{ Args: { "p_feedback_id": string }; Returns: Database["public"]['Enums']["eligibility_state"]
                           },
"feed_reason_label":
{ Args: { "p_reason": string }; Returns: string
                           },
"friendship_pair_key":
{ Args: { "p_a": string,"p_b": string }; Returns: string
                           },
"get_credit_balance":
{ Args: { "p_user_id": string }; Returns: number
                           },
"get_credit_summary":
{ Args: { "p_user_id"?: string }; Returns: Json
                           },
"get_migration_head":
{ Args: Record<PropertyKey, never>; Returns: string
                           },
"get_rating_summary":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"get_reputation":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"grant_duration_consent":
{ Args: { "p_source"?: string }; Returns: undefined
                           },
"grant_weekly_allowance":
{ Args: { "p_amount"?: number }; Returns: number
                           },
"has_current_duration_consent":
{ Args: { "p_user_id": string,"p_version"?: string }; Returns: boolean
                           },
"hide_entry":
{ Args: { "p_entry_id": string }; Returns: {
              "asks_for_feedback": boolean,
"author_id": string,
"canonical_url": string,
"caption_excerpt": string | null,
"created_at": string,
"creator_note": string | null,
"deleted_at": string | null,
"id": string,
"original_url": string,
"platform": Database["public"]['Enums']["platform_kind"],
"preview_meta": Json | null,
"preview_state": Database["public"]['Enums']["preview_state"],
"published_at": string,
"status": Database["public"]['Enums']["entry_state"],
"thumbnail_path": string | null,
"thumbnail_source": string | null,
"title": string | null,
"url_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "content_entries"
        isOneToOne: true
        isSetofReturn: false
      } },
"ingest_duration_event":
{ Args: { "p_band": string,"p_entry_id": string,"p_returned"?: boolean,"p_user_id": string }; Returns: string
                           },
"is_admin":
{ Args: { "p_user_id"?: string }; Returns: boolean
                           },
"log_feed_impressions":
{ Args: { "p_entries": Json }; Returns: undefined
                           },
"mark_entry_opened":
{ Args: { "p_entry_id": string }; Returns: undefined
                           },
"mute_creator":
{ Args: { "p_profile_id": string }; Returns: undefined
                           },
"normalize_hashtag":
{ Args: { "p_raw": string }; Returns: string
                           },
"rank_feed":
{ Args: { "p_cursor"?: string,"p_cursor_id"?: string,"p_cursor_score"?: number,"p_limit"?: number,"p_now"?: string,"p_platforms"?: (Database["public"]['Enums']["platform_kind"])[],"p_tags"?: (string)[] }; Returns: {
              "entry": Json,"rank": number,"reason_code": string,"score": string
            }[]
                           },
"ranked_reason":
{ Args: { "p_is_friend": boolean,"p_needs_feedback": boolean,"p_tag_overlap": boolean }; Returns: string
                           },
"rate_feedback":
{ Args: { "p_feedback_id": string,"p_score": number }; Returns: {
              "created_at": string,
"entry_owner_id": string,
"feedback_id": string,
"id": string,
"rater_id": string,
"revised_at": string | null,
"score": number,
"source": string
            }
                          SetofOptions: {
        from: "*"
        to: "feedback_ratings"
        isOneToOne: true
        isSetofReturn: false
      } },
"record_duration_event":
{ Args: { "p_band": Database["public"]['Enums']["duration_band"],"p_consent_version": string,"p_entry_id": string,"p_returned"?: boolean }; Returns: string
                           },
"record_outbound_click":
{ Args: { "p_client"?: string,"p_entry_id": string,"p_source"?: string }; Returns: {
              "click_id": string,"return_token": string
            }[]
                           },
"refresh_profile_reputation":
{ Args: { "p_user_id": string }; Returns: undefined
                           },
"release_held_credits":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"remove_entry":
{ Args: { "p_entry_id": string }; Returns: {
              "asks_for_feedback": boolean,
"author_id": string,
"canonical_url": string,
"caption_excerpt": string | null,
"created_at": string,
"creator_note": string | null,
"deleted_at": string | null,
"id": string,
"original_url": string,
"platform": Database["public"]['Enums']["platform_kind"],
"preview_meta": Json | null,
"preview_state": Database["public"]['Enums']["preview_state"],
"published_at": string,
"status": Database["public"]['Enums']["entry_state"],
"thumbnail_path": string | null,
"thumbnail_source": string | null,
"title": string | null,
"url_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "content_entries"
        isOneToOne: true
        isSetofReturn: false
      } },
"remove_feedback":
{ Args: { "p_feedback_id": string }; Returns: {
              "author_id": string,
"body": string,
"created_at": string,
"edited_at": string | null,
"eligibility": Database["public"]['Enums']["eligibility_state"],
"eligibility_reason": string | null,
"entry_id": string,
"hold_until": string | null,
"id": string,
"image_paths": (string)[],
"opened_entry": boolean,
"removed_at": string | null,
"tags": (Database["public"]['Enums']["feedback_tag"])[]
            }
                          SetofOptions: {
        from: "*"
        to: "feedback"
        isOneToOne: true
        isSetofReturn: false
      } },
"remove_friend":
{ Args: { "p_friendship_id": string }; Returns: {
              "addressee_id": string,
"created_at": string,
"id": string,
"pair_key": string | null,
"requester_id": string,
"responded_at": string | null,
"state": Database["public"]['Enums']["friendship_state"]
            }
                          SetofOptions: {
        from: "*"
        to: "friendships"
        isOneToOne: true
        isSetofReturn: false
      } },
"report_content":
{ Args: { "p_details"?: string,"p_reason": string,"p_target_id": string,"p_target_type": Database["public"]['Enums']["report_target"] }; Returns: {
              "created_at": string,
"details": string | null,
"id": string,
"reason": string,
"reporter_id": string,
"resolution_note": string | null,
"resolved_at": string | null,
"resolved_by": string | null,
"state": Database["public"]['Enums']["report_state"],
"target_id": string,
"target_type": Database["public"]['Enums']["report_target"]
            }
                          SetofOptions: {
        from: "*"
        to: "moderation_reports"
        isOneToOne: true
        isSetofReturn: false
      } },
"reputation_badge_for_total":
{ Args: { "p_total": number }; Returns: string
                           },
"respond_friend_request":
{ Args: { "p_accept": boolean,"p_friendship_id": string }; Returns: {
              "addressee_id": string,
"created_at": string,
"id": string,
"pair_key": string | null,
"requester_id": string,
"responded_at": string | null,
"state": Database["public"]['Enums']["friendship_state"]
            }
                          SetofOptions: {
        from: "*"
        to: "friendships"
        isOneToOne: true
        isSetofReturn: false
      } },
"reverse_credit_for_feedback":
{ Args: { "p_feedback_id": string,"p_note"?: string }; Returns: number
                           },
"reverse_credit_on_feedback_change":
{ Args: { "p_actor_id": string,"p_feedback_id": string,"p_note": string }; Returns: undefined
                           },
"reverse_reputation_for_feedback":
{ Args: { "p_feedback_id": string,"p_note"?: string }; Returns: number
                           },
"revise_rating":
{ Args: { "p_feedback_id": string,"p_score": number }; Returns: {
              "created_at": string,
"entry_owner_id": string,
"feedback_id": string,
"id": string,
"rater_id": string,
"revised_at": string | null,
"score": number,
"source": string
            }
                          SetofOptions: {
        from: "*"
        to: "feedback_ratings"
        isOneToOne: true
        isSetofReturn: false
      } },
"revoke_duration_consent":
{ Args: Record<PropertyKey, never>; Returns: boolean
                           },
"send_friend_request":
{ Args: { "p_addressee": string }; Returns: {
              "addressee_id": string,
"created_at": string,
"id": string,
"pair_key": string | null,
"requester_id": string,
"responded_at": string | null,
"state": Database["public"]['Enums']["friendship_state"]
            }
                          SetofOptions: {
        from: "*"
        to: "friendships"
        isOneToOne: true
        isSetofReturn: false
      } },
"set_entry_hashtags":
{ Args: { "p_entry_id": string,"p_hashtags": (string)[] }; Returns: undefined
                           },
"set_profile_hashtags":
{ Args: { "p_hashtags": (string)[] }; Returns: undefined
                           },
"submit_feed_signal":
{ Args: { "p_entry_id": string,"p_signal": string }; Returns: undefined
                           },
"submit_feedback":
{ Args: { "p_body": string,"p_entry_id": string,"p_image_paths"?: (string)[],"p_tags"?: (Database["public"]['Enums']["feedback_tag"])[] }; Returns: {
              "author_id": string,
"body": string,
"created_at": string,
"edited_at": string | null,
"eligibility": Database["public"]['Enums']["eligibility_state"],
"eligibility_reason": string | null,
"entry_id": string,
"hold_until": string | null,
"id": string,
"image_paths": (string)[],
"opened_entry": boolean,
"removed_at": string | null,
"tags": (Database["public"]['Enums']["feedback_tag"])[]
            }
                          SetofOptions: {
        from: "*"
        to: "feedback"
        isOneToOne: true
        isSetofReturn: false
      } },
"unblock_member":
{ Args: { "p_user_id": string }; Returns: {
              "addressee_id": string,
"created_at": string,
"id": string,
"pair_key": string | null,
"requester_id": string,
"responded_at": string | null,
"state": Database["public"]['Enums']["friendship_state"]
            }
                          SetofOptions: {
        from: "*"
        to: "friendships"
        isOneToOne: true
        isSetofReturn: false
      } },
"unhide_entry":
{ Args: { "p_entry_id": string }; Returns: {
              "asks_for_feedback": boolean,
"author_id": string,
"canonical_url": string,
"caption_excerpt": string | null,
"created_at": string,
"creator_note": string | null,
"deleted_at": string | null,
"id": string,
"original_url": string,
"platform": Database["public"]['Enums']["platform_kind"],
"preview_meta": Json | null,
"preview_state": Database["public"]['Enums']["preview_state"],
"published_at": string,
"status": Database["public"]['Enums']["entry_state"],
"thumbnail_path": string | null,
"thumbnail_source": string | null,
"title": string | null,
"url_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "content_entries"
        isOneToOne: true
        isSetofReturn: false
      } },
"unique_handle_from_email":
{ Args: { "p_email": string }; Returns: string
                           },
"unmute_creator":
{ Args: { "p_profile_id": string }; Returns: undefined
                           },
"update_entry":
{ Args: { "p_asks_for_feedback"?: boolean,"p_creator_note"?: string,"p_entry_id": string }; Returns: {
              "asks_for_feedback": boolean,
"author_id": string,
"canonical_url": string,
"caption_excerpt": string | null,
"created_at": string,
"creator_note": string | null,
"deleted_at": string | null,
"id": string,
"original_url": string,
"platform": Database["public"]['Enums']["platform_kind"],
"preview_meta": Json | null,
"preview_state": Database["public"]['Enums']["preview_state"],
"published_at": string,
"status": Database["public"]['Enums']["entry_state"],
"thumbnail_path": string | null,
"thumbnail_source": string | null,
"title": string | null,
"url_hash": string
            }
                          SetofOptions: {
        from: "*"
        to: "content_entries"
        isOneToOne: true
        isSetofReturn: false
      } },
"update_feedback":
{ Args: { "p_body": string,"p_feedback_id": string,"p_image_paths"?: (string)[],"p_tags"?: (Database["public"]['Enums']["feedback_tag"])[] }; Returns: {
              "author_id": string,
"body": string,
"created_at": string,
"edited_at": string | null,
"eligibility": Database["public"]['Enums']["eligibility_state"],
"eligibility_reason": string | null,
"entry_id": string,
"hold_until": string | null,
"id": string,
"image_paths": (string)[],
"opened_entry": boolean,
"removed_at": string | null,
"tags": (Database["public"]['Enums']["feedback_tag"])[]
            }
                          SetofOptions: {
        from: "*"
        to: "feedback"
        isOneToOne: true
        isSetofReturn: false
      } },
"validate_return_token":
{ Args: { "p_token": string }; Returns: {
              "entry_id": string,"opened_at": string,"returned_at": string
            }[]
                           }
          }
          Enums: {
            "credit_kind": "weekly_allowance"|"feedback_earned"|"submission_spend"|"admin_grant"|"admin_reverse"|"hold_release"|"hold_reversal"|"entry_removed_reversal","duration_band": "lt_15s"|"s15_60"|"m1_3"|"gt_3"|"unknown","eligibility_state": "pending"|"eligible"|"ineligible"|"held"|"reversed"|"removed","entry_state": "active"|"hidden"|"removed","feed_signal_kind": "more_like"|"less_like"|"hide","feedback_tag": "hook"|"clarity"|"editing"|"storytelling"|"thumbnail"|"cta"|"audience_fit","friendship_state": "pending"|"accepted"|"declined"|"blocked","ledger_status": "held"|"available"|"spent"|"reversed","platform_kind": "instagram"|"tiktok"|"youtube"|"x","preview_state": "pending"|"resolved"|"unavailable"|"failed","profile_role": "member"|"admin","report_state": "open"|"reviewing"|"resolved"|"dismissed","report_target": "user"|"content_entry"|"feedback"|"hashtag","reputation_kind": "creator_rating"|"rating_revision"|"moderation_reversal"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "credit_kind": ["weekly_allowance", "feedback_earned", "submission_spend", "admin_grant", "admin_reverse", "hold_release", "hold_reversal", "entry_removed_reversal"],"duration_band": ["lt_15s", "s15_60", "m1_3", "gt_3", "unknown"],"eligibility_state": ["pending", "eligible", "ineligible", "held", "reversed", "removed"],"entry_state": ["active", "hidden", "removed"],"feed_signal_kind": ["more_like", "less_like", "hide"],"feedback_tag": ["hook", "clarity", "editing", "storytelling", "thumbnail", "cta", "audience_fit"],"friendship_state": ["pending", "accepted", "declined", "blocked"],"ledger_status": ["held", "available", "spent", "reversed"],"platform_kind": ["instagram", "tiktok", "youtube", "x"],"preview_state": ["pending", "resolved", "unavailable", "failed"],"profile_role": ["member", "admin"],"report_state": ["open", "reviewing", "resolved", "dismissed"],"report_target": ["user", "content_entry", "feedback", "hashtag"],"reputation_kind": ["creator_rating", "rating_revision", "moderation_reversal"]
          }
        }
} as const
