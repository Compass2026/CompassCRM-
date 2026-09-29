export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alerts: {
        Row: {
          acknowledged: boolean
          acknowledged_at: string | null
          client_id: string
          current_rank: number | null
          id: string
          keyword_id: string
          location_id: string | null
          previous_rank: number | null
          result_type: Database["public"]["Enums"]["rank_result_type"] | null
          source: string | null
          triggered_on: string
        }
        Insert: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          client_id: string
          current_rank?: number | null
          id?: string
          keyword_id: string
          location_id?: string | null
          previous_rank?: number | null
          result_type?: Database["public"]["Enums"]["rank_result_type"] | null
          source?: string | null
          triggered_on?: string
        }
        Update: {
          acknowledged?: boolean
          acknowledged_at?: string | null
          client_id?: string
          current_rank?: number | null
          id?: string
          keyword_id?: string
          location_id?: string | null
          previous_rank?: number | null
          result_type?: Database["public"]["Enums"]["rank_result_type"] | null
          source?: string | null
          triggered_on?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      authority_opportunities: {
        Row: {
          action: string
          client_id: string
          content_type: string
          cycle_started_at: string | null
          decided_at: string | null
          decided_by: string | null
          dismissed_until: string | null
          eligible_from: string | null
          first_seen_run_id: string
          id: string
          intent: string | null
          key: string
          keyword_id: string | null
          last_seen_at: string
          last_seen_run_id: string
          opportunity: Json
          present: boolean
          section: string
          service_id: string | null
          sort_order: number[]
          status: string
          status_reason: string | null
          suppressed: boolean
          suppression_basis: Json | null
          target_path: string | null
          tier: string
          topic: string
        }
        Insert: {
          action: string
          client_id: string
          content_type: string
          cycle_started_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          dismissed_until?: string | null
          eligible_from?: string | null
          first_seen_run_id: string
          id?: string
          intent?: string | null
          key: string
          keyword_id?: string | null
          last_seen_at: string
          last_seen_run_id: string
          opportunity: Json
          present?: boolean
          section: string
          service_id?: string | null
          sort_order?: number[]
          status?: string
          status_reason?: string | null
          suppressed?: boolean
          suppression_basis?: Json | null
          target_path?: string | null
          tier: string
          topic: string
        }
        Update: {
          action?: string
          client_id?: string
          content_type?: string
          cycle_started_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          dismissed_until?: string | null
          eligible_from?: string | null
          first_seen_run_id?: string
          id?: string
          intent?: string | null
          key?: string
          keyword_id?: string | null
          last_seen_at?: string
          last_seen_run_id?: string
          opportunity?: Json
          present?: boolean
          section?: string
          service_id?: string | null
          sort_order?: number[]
          status?: string
          status_reason?: string | null
          suppressed?: boolean
          suppression_basis?: Json | null
          target_path?: string | null
          tier?: string
          topic?: string
        }
        Relationships: [
          {
            foreignKeyName: "authority_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_first_run_fk"
            columns: ["first_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_first_run_fk"
            columns: ["first_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_last_run_fk"
            columns: ["last_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_last_run_fk"
            columns: ["last_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      authority_opportunity_events: {
        Row: {
          actor_id: string | null
          actor_kind: string
          client_id: string
          created_at: string
          detail: Json
          id: string
          kind: string
          opportunity_id: string
          run_id: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_kind: string
          client_id: string
          created_at?: string
          detail?: Json
          id?: string
          kind: string
          opportunity_id: string
          run_id?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_kind?: string
          client_id?: string
          created_at?: string
          detail?: Json
          id?: string
          kind?: string
          opportunity_id?: string
          run_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "authority_events_opportunity_fk"
            columns: ["opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunities"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_events_opportunity_fk"
            columns: ["opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunity_state"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_events_run_fk"
            columns: ["run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_events_run_fk"
            columns: ["run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunity_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      authority_opportunity_links: {
        Row: {
          change_log_id: string | null
          client_id: string
          content_post_id: string | null
          created_at: string
          created_by: string | null
          drafter_run_id: string | null
          id: string
          kind: string
          opportunity_id: string
          ref_id: string
          social_post_id: string | null
          task_id: string | null
        }
        Insert: {
          change_log_id?: string | null
          client_id: string
          content_post_id?: string | null
          created_at?: string
          created_by?: string | null
          drafter_run_id?: string | null
          id?: string
          kind: string
          opportunity_id: string
          ref_id: string
          social_post_id?: string | null
          task_id?: string | null
        }
        Update: {
          change_log_id?: string | null
          client_id?: string
          content_post_id?: string | null
          created_at?: string
          created_by?: string | null
          drafter_run_id?: string | null
          id?: string
          kind?: string
          opportunity_id?: string
          ref_id?: string
          social_post_id?: string | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "authority_links_change_log_fk"
            columns: ["change_log_id", "client_id"]
            isOneToOne: false
            referencedRelation: "change_log"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_content_post_fk"
            columns: ["content_post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "content_posts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_drafter_run_fk"
            columns: ["drafter_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "drafter_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_opportunity_fk"
            columns: ["opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunities"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_opportunity_fk"
            columns: ["opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunity_state"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_social_post_fk"
            columns: ["social_post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_links_task_fk"
            columns: ["task_id", "client_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunity_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      authority_runs: {
        Row: {
          as_of: string | null
          client_id: string
          counts: Json | null
          created_at: string
          diff: Json | null
          engine_version: string | null
          error: string | null
          finished_at: string | null
          id: string
          input_hash: string | null
          inventory: Json | null
          inventory_errors: number | null
          inventory_fetched_at: string | null
          inventory_pages: number | null
          judged_at: string | null
          mode: string
          previous_run_id: string | null
          report: Json | null
          requested_by: string | null
          requested_via: string
          section_hashes: Json | null
          sources: Json | null
          status: string
        }
        Insert: {
          as_of?: string | null
          client_id: string
          counts?: Json | null
          created_at?: string
          diff?: Json | null
          engine_version?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_hash?: string | null
          inventory?: Json | null
          inventory_errors?: number | null
          inventory_fetched_at?: string | null
          inventory_pages?: number | null
          judged_at?: string | null
          mode: string
          previous_run_id?: string | null
          report?: Json | null
          requested_by?: string | null
          requested_via: string
          section_hashes?: Json | null
          sources?: Json | null
          status?: string
        }
        Update: {
          as_of?: string | null
          client_id?: string
          counts?: Json | null
          created_at?: string
          diff?: Json | null
          engine_version?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          input_hash?: string | null
          inventory?: Json | null
          inventory_errors?: number | null
          inventory_fetched_at?: string | null
          inventory_pages?: number | null
          judged_at?: string | null
          mode?: string
          previous_run_id?: string | null
          report?: Json | null
          requested_by?: string | null
          requested_via?: string
          section_hashes?: Json | null
          sources?: Json | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "authority_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_runs_previous_fk"
            columns: ["previous_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_runs_previous_fk"
            columns: ["previous_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_runs_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_audit_events: {
        Row: {
          action: string
          actor_kind: string
          actor_portal_user_id: string | null
          actor_team_member_id: string | null
          client_id: string | null
          created_at: string
          detail: Json
          id: string
          livemode: boolean | null
          subject: string | null
        }
        Insert: {
          action: string
          actor_kind: string
          actor_portal_user_id?: string | null
          actor_team_member_id?: string | null
          client_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          livemode?: boolean | null
          subject?: string | null
        }
        Update: {
          action?: string
          actor_kind?: string
          actor_portal_user_id?: string | null
          actor_team_member_id?: string | null
          client_id?: string | null
          created_at?: string
          detail?: Json
          id?: string
          livemode?: boolean | null
          subject?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_audit_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_audit_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_audit_events_actor_portal_user_id_fkey"
            columns: ["actor_portal_user_id"]
            isOneToOne: false
            referencedRelation: "portal_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_audit_events_actor_team_member_id_fkey"
            columns: ["actor_team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_one_time_items: {
        Row: {
          active: boolean
          category: string
          created_at: string
          description: string | null
          id: string
          key: string
          name: string
          sort_order: number
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          category: string
          created_at?: string
          description?: string | null
          id?: string
          key: string
          name: string
          sort_order?: number
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          category?: string
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          name?: string
          sort_order?: number
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_one_time_items_stripe_product_id_fkey"
            columns: ["stripe_product_id"]
            isOneToOne: true
            referencedRelation: "stripe_products"
            referencedColumns: ["stripe_product_id"]
          },
        ]
      }
      billing_package_prices: {
        Row: {
          active: boolean
          client_id: string | null
          created_at: string
          id: string
          is_default: boolean
          notes: string | null
          package_id: string
          package_kind: string
          price_type: string
          stripe_price_id: string
          stripe_product_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          client_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          notes?: string | null
          package_id: string
          package_kind: string
          price_type?: string
          stripe_price_id: string
          stripe_product_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          client_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          notes?: string | null
          package_id?: string
          package_kind?: string
          price_type?: string
          stripe_price_id?: string
          stripe_product_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_package_prices_package_id_stripe_product_id_packag_fkey"
            columns: ["package_id", "stripe_product_id", "package_kind"]
            isOneToOne: false
            referencedRelation: "billing_packages"
            referencedColumns: ["id", "stripe_product_id", "kind"]
          },
          {
            foreignKeyName: "billing_package_prices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_package_prices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_package_prices_stripe_price_id_stripe_product_id_p_fkey"
            columns: ["stripe_price_id", "stripe_product_id", "price_type"]
            isOneToOne: false
            referencedRelation: "stripe_prices"
            referencedColumns: ["stripe_price_id", "stripe_product_id", "type"]
          },
        ]
      }
      billing_packages: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          id: string
          key: string
          kind: string
          name: string
          sort_order: number
          stripe_product_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          key: string
          kind: string
          name: string
          sort_order?: number
          stripe_product_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          kind?: string
          name?: string
          sort_order?: number
          stripe_product_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_packages_stripe_product_id_fkey"
            columns: ["stripe_product_id"]
            isOneToOne: true
            referencedRelation: "stripe_products"
            referencedColumns: ["stripe_product_id"]
          },
        ]
      }
      brand_assets: {
        Row: {
          client_id: string
          content_hash: string | null
          content_hashed_at: string | null
          content_measurement: Json | null
          created_at: string
          creative_review_note: string | null
          creative_reviewed_at: string | null
          creative_reviewed_by: string | null
          creative_suggestions: Json | null
          creative_use: string
          depicts_own_work: boolean | null
          file_name: string | null
          focal_x: number | null
          focal_y: number | null
          height: number | null
          id: string
          is_primary: boolean
          kind: Database["public"]["Enums"]["brand_asset_kind"]
          label: string
          mime_type: string | null
          notes: string | null
          size_bytes: number | null
          sort_order: number
          source: Database["public"]["Enums"]["brand_asset_source"]
          storage_path: string | null
          subjects: string[]
          uploaded_by: string | null
          url: string | null
          width: number | null
        }
        Insert: {
          client_id: string
          content_hash?: string | null
          content_hashed_at?: string | null
          content_measurement?: Json | null
          created_at?: string
          creative_review_note?: string | null
          creative_reviewed_at?: string | null
          creative_reviewed_by?: string | null
          creative_suggestions?: Json | null
          creative_use?: string
          depicts_own_work?: boolean | null
          file_name?: string | null
          focal_x?: number | null
          focal_y?: number | null
          height?: number | null
          id?: string
          is_primary?: boolean
          kind?: Database["public"]["Enums"]["brand_asset_kind"]
          label: string
          mime_type?: string | null
          notes?: string | null
          size_bytes?: number | null
          sort_order?: number
          source?: Database["public"]["Enums"]["brand_asset_source"]
          storage_path?: string | null
          subjects?: string[]
          uploaded_by?: string | null
          url?: string | null
          width?: number | null
        }
        Update: {
          client_id?: string
          content_hash?: string | null
          content_hashed_at?: string | null
          content_measurement?: Json | null
          created_at?: string
          creative_review_note?: string | null
          creative_reviewed_at?: string | null
          creative_reviewed_by?: string | null
          creative_suggestions?: Json | null
          creative_use?: string
          depicts_own_work?: boolean | null
          file_name?: string | null
          focal_x?: number | null
          focal_y?: number | null
          height?: number | null
          id?: string
          is_primary?: boolean
          kind?: Database["public"]["Enums"]["brand_asset_kind"]
          label?: string
          mime_type?: string | null
          notes?: string | null
          size_bytes?: number | null
          sort_order?: number
          source?: Database["public"]["Enums"]["brand_asset_source"]
          storage_path?: string | null
          subjects?: string[]
          uploaded_by?: string | null
          url?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "brand_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_assets_creative_reviewed_by_fkey"
            columns: ["creative_reviewed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_boards: {
        Row: {
          approved_by: string | null
          approved_on: string | null
          client_id: string
          created_at: string
          drive_doc_url: string | null
          hard_rules: string[]
          id: string
          palette: Json
          positioning_line: string | null
          standing_cta: string | null
          status: Database["public"]["Enums"]["brand_board_status"]
          typography: Json
          version: number
        }
        Insert: {
          approved_by?: string | null
          approved_on?: string | null
          client_id: string
          created_at?: string
          drive_doc_url?: string | null
          hard_rules?: string[]
          id?: string
          palette?: Json
          positioning_line?: string | null
          standing_cta?: string | null
          status?: Database["public"]["Enums"]["brand_board_status"]
          typography?: Json
          version?: number
        }
        Update: {
          approved_by?: string | null
          approved_on?: string | null
          client_id?: string
          created_at?: string
          drive_doc_url?: string | null
          hard_rules?: string[]
          id?: string
          palette?: Json
          positioning_line?: string | null
          standing_cta?: string | null
          status?: Database["public"]["Enums"]["brand_board_status"]
          typography?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "brand_boards_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_boards_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_colors: {
        Row: {
          client_id: string
          created_at: string
          hex: string
          id: string
          name: string
          role: Database["public"]["Enums"]["brand_color_role"]
          sort_order: number
          usage: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          hex: string
          id?: string
          name: string
          role?: Database["public"]["Enums"]["brand_color_role"]
          sort_order?: number
          usage?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          hex?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["brand_color_role"]
          sort_order?: number
          usage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brand_colors_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_colors_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      brand_fonts: {
        Row: {
          client_id: string
          created_at: string
          family: string
          id: string
          notes: string | null
          role: Database["public"]["Enums"]["brand_font_role"]
          sort_order: number
          source: string | null
          url: string | null
          weights: string | null
        }
        Insert: {
          client_id: string
          created_at?: string
          family: string
          id?: string
          notes?: string | null
          role?: Database["public"]["Enums"]["brand_font_role"]
          sort_order?: number
          source?: string | null
          url?: string | null
          weights?: string | null
        }
        Update: {
          client_id?: string
          created_at?: string
          family?: string
          id?: string
          notes?: string | null
          role?: Database["public"]["Enums"]["brand_font_role"]
          sort_order?: number
          source?: string | null
          url?: string | null
          weights?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "brand_fonts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "brand_fonts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      change_log: {
        Row: {
          after: Json | null
          before: Json | null
          change_type: string
          client_id: string
          created_at: string
          evidence: string | null
          id: string
          object_id: string | null
          object_type: string
          reasoning: string | null
          reviewed_by: string | null
          reviewed_on: string | null
          status: Database["public"]["Enums"]["change_status"]
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          change_type: string
          client_id: string
          created_at?: string
          evidence?: string | null
          id?: string
          object_id?: string | null
          object_type: string
          reasoning?: string | null
          reviewed_by?: string | null
          reviewed_on?: string | null
          status?: Database["public"]["Enums"]["change_status"]
        }
        Update: {
          after?: Json | null
          before?: Json | null
          change_type?: string
          client_id?: string
          created_at?: string
          evidence?: string | null
          id?: string
          object_id?: string | null
          object_type?: string
          reasoning?: string | null
          reviewed_by?: string | null
          reviewed_on?: string | null
          status?: Database["public"]["Enums"]["change_status"]
        }
        Relationships: [
          {
            foreignKeyName: "change_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "change_log_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      checkout_sessions: {
        Row: {
          client_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          id: string
          line_items: Json
          livemode: boolean
          mode: string
          package_id: string | null
          payment_status: string | null
          status: string
          stripe_checkout_session_id: string
          stripe_created_at: string | null
          stripe_customer_id: string
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          stripe_synced_at: string
          updated_at: string
          url: string | null
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at: string
          id?: string
          line_items?: Json
          livemode: boolean
          mode: string
          package_id?: string | null
          payment_status?: string | null
          status: string
          stripe_checkout_session_id: string
          stripe_created_at?: string | null
          stripe_customer_id: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          stripe_synced_at: string
          updated_at?: string
          url?: string | null
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          id?: string
          line_items?: Json
          livemode?: boolean
          mode?: string
          package_id?: string | null
          payment_status?: string | null
          status?: string
          stripe_checkout_session_id?: string
          stripe_created_at?: string | null
          stripe_customer_id?: string
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          stripe_synced_at?: string
          updated_at?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "checkout_sessions_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "billing_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_sessions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_sessions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "checkout_sessions_stripe_customer_id_client_id_fkey"
            columns: ["stripe_customer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "stripe_customers"
            referencedColumns: ["stripe_customer_id", "client_id"]
          },
          {
            foreignKeyName: "checkout_sessions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      claims: {
        Row: {
          claim: string
          client_id: string
          confirmed_by: string | null
          confirmed_on: string | null
          created_at: string
          id: string
          source: string | null
          status: Database["public"]["Enums"]["claim_status"]
        }
        Insert: {
          claim: string
          client_id: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          id?: string
          source?: string | null
          status?: Database["public"]["Enums"]["claim_status"]
        }
        Update: {
          claim?: string
          client_id?: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          id?: string
          source?: string | null
          status?: Database["public"]["Enums"]["claim_status"]
        }
        Relationships: [
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "claims_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      client_access: {
        Row: {
          client_id: string
          id: string
          notes: string | null
          status: Database["public"]["Enums"]["access_status"]
          system: Database["public"]["Enums"]["access_system"]
          updated_at: string
        }
        Insert: {
          client_id: string
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["access_status"]
          system: Database["public"]["Enums"]["access_system"]
          updated_at?: string
        }
        Update: {
          client_id?: string
          id?: string
          notes?: string | null
          status?: Database["public"]["Enums"]["access_status"]
          system?: Database["public"]["Enums"]["access_system"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_access_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      client_brands: {
        Row: {
          ai_guidance: string | null
          approved_at: string | null
          approved_by: string | null
          audience: string | null
          client_id: string
          content_pillars: string[]
          created_at: string
          differentiators: string | null
          imagery_style: string | null
          positioning: string | null
          story: string | null
          tagline: string | null
          typography_notes: string | null
          updated_at: string
          voice_tone: string | null
          words_we_avoid: string[]
          words_we_use: string[]
        }
        Insert: {
          ai_guidance?: string | null
          approved_at?: string | null
          approved_by?: string | null
          audience?: string | null
          client_id: string
          content_pillars?: string[]
          created_at?: string
          differentiators?: string | null
          imagery_style?: string | null
          positioning?: string | null
          story?: string | null
          tagline?: string | null
          typography_notes?: string | null
          updated_at?: string
          voice_tone?: string | null
          words_we_avoid?: string[]
          words_we_use?: string[]
        }
        Update: {
          ai_guidance?: string | null
          approved_at?: string | null
          approved_by?: string | null
          audience?: string | null
          client_id?: string
          content_pillars?: string[]
          created_at?: string
          differentiators?: string | null
          imagery_style?: string | null
          positioning?: string | null
          story?: string | null
          tagline?: string | null
          typography_notes?: string | null
          updated_at?: string
          voice_tone?: string | null
          words_we_avoid?: string[]
          words_we_use?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "client_brands_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_brands_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      client_contacts: {
        Row: {
          client_id: string
          email: string | null
          id: string
          is_primary: boolean
          name: string
          phone: string | null
          role: string | null
        }
        Insert: {
          client_id: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          phone?: string | null
          role?: string | null
        }
        Update: {
          client_id?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          phone?: string | null
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_contacts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      client_creative_settings: {
        Row: {
          channel: Database["public"]["Enums"]["social_platform"]
          client_id: string
          creative_policy: string
          generated_imagery: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          channel: Database["public"]["Enums"]["social_platform"]
          client_id: string
          creative_policy?: string
          generated_imagery?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          channel?: Database["public"]["Enums"]["social_platform"]
          client_id?: string
          creative_policy?: string
          generated_imagery?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_creative_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_settings_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      client_creative_templates: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          client_id: string
          created_at: string
          id: string
          note: string | null
          preview_asset_id: string | null
          revoked_at: string | null
          revoked_by: string | null
          status: string
          template_id: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          client_id: string
          created_at?: string
          id?: string
          note?: string | null
          preview_asset_id?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          template_id: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          client_id?: string
          created_at?: string
          id?: string
          note?: string | null
          preview_asset_id?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          status?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_creative_templates_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_templates_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_templates_preview_asset_id_client_id_fkey"
            columns: ["preview_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "creative_assets"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "client_creative_templates_revoked_by_fkey"
            columns: ["revoked_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_creative_templates_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "creative_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      client_entitlement_overrides: {
        Row: {
          client_id: string
          enabled: boolean
          quantity: number | null
          reason: string
          service_key: string
          service_kind: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          client_id: string
          enabled: boolean
          quantity?: number | null
          reason: string
          service_key: string
          service_kind: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          client_id?: string
          enabled?: boolean
          quantity?: number | null
          reason?: string
          service_key?: string
          service_kind?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_entitlement_overrides_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_entitlement_overrides_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_entitlement_overrides_service_key_service_kind_fkey"
            columns: ["service_key", "service_kind"]
            isOneToOne: false
            referencedRelation: "service_catalog"
            referencedColumns: ["key", "kind"]
          },
          {
            foreignKeyName: "client_entitlement_overrides_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      client_pipelines: {
        Row: {
          client_id: string
          completed_at: string | null
          enrolled_at: string
          id: string
          pipeline_id: string
          status: Database["public"]["Enums"]["enrollment_status"]
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          enrolled_at?: string
          id?: string
          pipeline_id: string
          status?: Database["public"]["Enums"]["enrollment_status"]
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          enrolled_at?: string
          id?: string
          pipeline_id?: string
          status?: Database["public"]["Enums"]["enrollment_status"]
        }
        Relationships: [
          {
            foreignKeyName: "client_pipelines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pipelines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pipelines_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      client_requests: {
        Row: {
          client_id: string
          created_at: string
          drafted_by_claude_at: string | null
          id: string
          items: Json
          responses: Json | null
          sent_by_tom_at: string | null
          status: Database["public"]["Enums"]["client_request_status"]
        }
        Insert: {
          client_id: string
          created_at?: string
          drafted_by_claude_at?: string | null
          id?: string
          items?: Json
          responses?: Json | null
          sent_by_tom_at?: string | null
          status?: Database["public"]["Enums"]["client_request_status"]
        }
        Update: {
          client_id?: string
          created_at?: string
          drafted_by_claude_at?: string | null
          id?: string
          items?: Json
          responses?: Json | null
          sent_by_tom_at?: string | null
          status?: Database["public"]["Enums"]["client_request_status"]
        }
        Relationships: [
          {
            foreignKeyName: "client_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_requests_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      client_stages: {
        Row: {
          client_pipeline_id: string
          completed_at: string | null
          due_date: string | null
          evidence: string | null
          id: string
          next_action: string | null
          notes: string | null
          owner: Database["public"]["Enums"]["owner_type"]
          stage_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["stage_status"]
        }
        Insert: {
          client_pipeline_id: string
          completed_at?: string | null
          due_date?: string | null
          evidence?: string | null
          id?: string
          next_action?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          stage_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
        }
        Update: {
          client_pipeline_id?: string
          completed_at?: string | null
          due_date?: string | null
          evidence?: string | null
          id?: string
          next_action?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          stage_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["stage_status"]
        }
        Relationships: [
          {
            foreignKeyName: "client_stages_client_pipeline_id_fkey"
            columns: ["client_pipeline_id"]
            isOneToOne: false
            referencedRelation: "client_pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_stages_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          address_line1: string | null
          business_type: Database["public"]["Enums"]["business_type"] | null
          canva_folder_id: string | null
          canva_used_folder_id: string | null
          city: string | null
          created_at: string
          dba: string | null
          drive_folders: Json | null
          drive_root_url: string | null
          ga4_property: string | null
          gbp_location: string | null
          gbp_spec: Json | null
          gsc_property: string | null
          id: string
          industry: string | null
          kickoff_at: string | null
          launched_at: string | null
          name: string
          notes: string | null
          phone: string | null
          renewal_at: string | null
          service_area: string | null
          signed_at: string | null
          state: string | null
          status: Database["public"]["Enums"]["client_status"]
          updated_at: string
          vertical: string | null
          website_url: string | null
          zip: string | null
        }
        Insert: {
          address_line1?: string | null
          business_type?: Database["public"]["Enums"]["business_type"] | null
          canva_folder_id?: string | null
          canva_used_folder_id?: string | null
          city?: string | null
          created_at?: string
          dba?: string | null
          drive_folders?: Json | null
          drive_root_url?: string | null
          ga4_property?: string | null
          gbp_location?: string | null
          gbp_spec?: Json | null
          gsc_property?: string | null
          id?: string
          industry?: string | null
          kickoff_at?: string | null
          launched_at?: string | null
          name: string
          notes?: string | null
          phone?: string | null
          renewal_at?: string | null
          service_area?: string | null
          signed_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          vertical?: string | null
          website_url?: string | null
          zip?: string | null
        }
        Update: {
          address_line1?: string | null
          business_type?: Database["public"]["Enums"]["business_type"] | null
          canva_folder_id?: string | null
          canva_used_folder_id?: string | null
          city?: string | null
          created_at?: string
          dba?: string | null
          drive_folders?: Json | null
          drive_root_url?: string | null
          ga4_property?: string | null
          gbp_location?: string | null
          gbp_spec?: Json | null
          gsc_property?: string | null
          id?: string
          industry?: string | null
          kickoff_at?: string | null
          launched_at?: string | null
          name?: string
          notes?: string | null
          phone?: string | null
          renewal_at?: string | null
          service_area?: string | null
          signed_at?: string | null
          state?: string | null
          status?: Database["public"]["Enums"]["client_status"]
          updated_at?: string
          vertical?: string | null
          website_url?: string | null
          zip?: string | null
        }
        Relationships: []
      }
      content_posts: {
        Row: {
          client_id: string
          due_date: string | null
          id: string
          keyword_id: string | null
          notes: string | null
          origin: string
          owner: Database["public"]["Enums"]["owner_type"]
          published_at: string | null
          status: Database["public"]["Enums"]["content_status"]
          title: string
          url: string | null
          word_count: number | null
        }
        Insert: {
          client_id: string
          due_date?: string | null
          id?: string
          keyword_id?: string | null
          notes?: string | null
          origin?: string
          owner?: Database["public"]["Enums"]["owner_type"]
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          title: string
          url?: string | null
          word_count?: number | null
        }
        Update: {
          client_id?: string
          due_date?: string | null
          id?: string
          keyword_id?: string | null
          notes?: string | null
          origin?: string
          owner?: Database["public"]["Enums"]["owner_type"]
          published_at?: string | null
          status?: Database["public"]["Enums"]["content_status"]
          title?: string
          url?: string | null
          word_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "content_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "content_posts_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      creative_asset_sources: {
        Row: {
          brand_asset_id: string | null
          client_id: string
          creative_asset_id: string
          crop: Json | null
          focal: Json | null
          governance: Json
          ordinal: number
          role: string
          source_content_hash: string
          source_height: number
          source_storage_path: string
          source_width: number
        }
        Insert: {
          brand_asset_id?: string | null
          client_id: string
          creative_asset_id: string
          crop?: Json | null
          focal?: Json | null
          governance: Json
          ordinal: number
          role: string
          source_content_hash: string
          source_height: number
          source_storage_path: string
          source_width: number
        }
        Update: {
          brand_asset_id?: string | null
          client_id?: string
          creative_asset_id?: string
          crop?: Json | null
          focal?: Json | null
          governance?: Json
          ordinal?: number
          role?: string
          source_content_hash?: string
          source_height?: number
          source_storage_path?: string
          source_width?: number
        }
        Relationships: [
          {
            foreignKeyName: "creative_asset_sources_brand_asset_id_client_id_fkey"
            columns: ["brand_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "brand_assets"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "creative_asset_sources_creative_asset_id_client_id_fkey"
            columns: ["creative_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "creative_assets"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      creative_assets: {
        Row: {
          alt_text: string | null
          client_id: string
          content_hash: string
          created_at: string
          format: string
          generation: Json
          height: number
          id: string
          mime_type: string
          overlay: Json
          provenance: Json
          purpose: string
          run_id: string | null
          size_bytes: number
          storage_bucket: string
          storage_path: string
          strategy: string
          template_id: string | null
          template_spec_hash: string | null
          uploaded_by: string | null
          width: number
          withdrawn_at: string | null
          withdrawn_by: string | null
          withdrawn_reason: string | null
        }
        Insert: {
          alt_text?: string | null
          client_id: string
          content_hash: string
          created_at?: string
          format: string
          generation?: Json
          height: number
          id?: string
          mime_type: string
          overlay?: Json
          provenance?: Json
          purpose: string
          run_id?: string | null
          size_bytes: number
          storage_bucket?: string
          storage_path: string
          strategy: string
          template_id?: string | null
          template_spec_hash?: string | null
          uploaded_by?: string | null
          width: number
          withdrawn_at?: string | null
          withdrawn_by?: string | null
          withdrawn_reason?: string | null
        }
        Update: {
          alt_text?: string | null
          client_id?: string
          content_hash?: string
          created_at?: string
          format?: string
          generation?: Json
          height?: number
          id?: string
          mime_type?: string
          overlay?: Json
          provenance?: Json
          purpose?: string
          run_id?: string | null
          size_bytes?: number
          storage_bucket?: string
          storage_path?: string
          strategy?: string
          template_id?: string | null
          template_spec_hash?: string | null
          uploaded_by?: string | null
          width?: number
          withdrawn_at?: string | null
          withdrawn_by?: string | null
          withdrawn_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "creative_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_assets_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_assets_run_fk"
            columns: ["run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "creative_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "creative_assets_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "creative_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_assets_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_assets_withdrawn_by_fkey"
            columns: ["withdrawn_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      creative_governance_events: {
        Row: {
          action: string
          actor_id: string | null
          actor_kind: string
          changes: Json
          client_id: string
          created_at: string
          id: number
          note: string | null
          subject_id: string
          subject_type: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          actor_kind: string
          changes?: Json
          client_id: string
          created_at?: string
          id?: never
          note?: string | null
          subject_id: string
          subject_type: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          actor_kind?: string
          changes?: Json
          client_id?: string
          created_at?: string
          id?: never
          note?: string | null
          subject_id?: string
          subject_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "creative_governance_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_governance_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_governance_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      creative_runs: {
        Row: {
          brief: Json
          brief_hash: string
          client_id: string
          copy_hash: string | null
          created_at: string
          creative_asset_id: string | null
          error: string | null
          finished_at: string | null
          id: string
          post_id: string | null
          purpose: string
          reason: string
          renderer: string
          requested_by: string | null
          requested_via: string
          status: string
          strategy: string
          template_id: string
          template_spec_hash: string
        }
        Insert: {
          brief: Json
          brief_hash: string
          client_id: string
          copy_hash?: string | null
          created_at?: string
          creative_asset_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          post_id?: string | null
          purpose: string
          reason: string
          renderer: string
          requested_by?: string | null
          requested_via: string
          status?: string
          strategy: string
          template_id: string
          template_spec_hash: string
        }
        Update: {
          brief?: Json
          brief_hash?: string
          client_id?: string
          copy_hash?: string | null
          created_at?: string
          creative_asset_id?: string | null
          error?: string | null
          finished_at?: string | null
          id?: string
          post_id?: string | null
          purpose?: string
          reason?: string
          renderer?: string
          requested_by?: string | null
          requested_via?: string
          status?: string
          strategy?: string
          template_id?: string
          template_spec_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "creative_runs_asset_fk"
            columns: ["creative_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "creative_assets"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "creative_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_runs_post_fk"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "creative_runs_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "creative_runs_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "creative_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      creative_templates: {
        Row: {
          channel: Database["public"]["Enums"]["social_platform"]
          created_at: string
          description: string | null
          id: string
          key: string
          mime_type: string
          name: string
          output_height: number
          output_width: number
          retired_at: string | null
          spec: Json
          spec_hash: string
          status: string
          version: number
        }
        Insert: {
          channel: Database["public"]["Enums"]["social_platform"]
          created_at?: string
          description?: string | null
          id?: string
          key: string
          mime_type: string
          name: string
          output_height: number
          output_width: number
          retired_at?: string | null
          spec: Json
          spec_hash: string
          status?: string
          version: number
        }
        Update: {
          channel?: Database["public"]["Enums"]["social_platform"]
          created_at?: string
          description?: string | null
          id?: string
          key?: string
          mime_type?: string
          name?: string
          output_height?: number
          output_width?: number
          retired_at?: string | null
          spec?: Json
          spec_hash?: string
          status?: string
          version?: number
        }
        Relationships: []
      }
      decisions: {
        Row: {
          client_id: string | null
          decided_by: string | null
          decided_on: string
          decision: string
          id: string
          match_count: number
          playbook_step: string | null
          rule_text: string | null
          task_id: string | null
        }
        Insert: {
          client_id?: string | null
          decided_by?: string | null
          decided_on?: string
          decision: string
          id?: string
          match_count?: number
          playbook_step?: string | null
          rule_text?: string | null
          task_id?: string | null
        }
        Update: {
          client_id?: string | null
          decided_by?: string | null
          decided_on?: string
          decision?: string
          id?: string
          match_count?: number
          playbook_step?: string | null
          rule_text?: string | null
          task_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "decisions_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      deliverables: {
        Row: {
          client_id: string
          client_stage_id: string | null
          id: string
          label: string
          monthly_cycle_id: string | null
          type: Database["public"]["Enums"]["deliverable_type"]
          url: string
        }
        Insert: {
          client_id: string
          client_stage_id?: string | null
          id?: string
          label: string
          monthly_cycle_id?: string | null
          type?: Database["public"]["Enums"]["deliverable_type"]
          url: string
        }
        Update: {
          client_id?: string
          client_stage_id?: string | null
          id?: string
          label?: string
          monthly_cycle_id?: string | null
          type?: Database["public"]["Enums"]["deliverable_type"]
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "deliverables_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_client_stage_id_fkey"
            columns: ["client_stage_id"]
            isOneToOne: false
            referencedRelation: "client_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "deliverables_monthly_cycle_id_fkey"
            columns: ["monthly_cycle_id"]
            isOneToOne: false
            referencedRelation: "monthly_cycles"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          category: Database["public"]["Enums"]["document_category"]
          client_id: string
          created_at: string
          file_name: string | null
          id: string
          kind: Database["public"]["Enums"]["document_kind"]
          label: string
          mime_type: string | null
          notes: string | null
          storage_path: string | null
          uploaded_by: string | null
          url: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["document_category"]
          client_id: string
          created_at?: string
          file_name?: string | null
          id?: string
          kind: Database["public"]["Enums"]["document_kind"]
          label: string
          mime_type?: string | null
          notes?: string | null
          storage_path?: string | null
          uploaded_by?: string | null
          url?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["document_category"]
          client_id?: string
          created_at?: string
          file_name?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["document_kind"]
          label?: string
          mime_type?: string | null
          notes?: string | null
          storage_path?: string | null
          uploaded_by?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      drafter_runs: {
        Row: {
          attempt: number
          authority_opportunity_id: string | null
          brief: Json | null
          brief_hash: string
          brief_version: string
          claim_ids: string[]
          client_id: string
          copy_hash: string | null
          created_at: string
          detail: string | null
          id: string
          lint: Json | null
          post_id: string | null
          requested_by: string | null
          requested_via: string
          runtime: string
          status: string
          target: Json
        }
        Insert: {
          attempt?: number
          authority_opportunity_id?: string | null
          brief?: Json | null
          brief_hash: string
          brief_version: string
          claim_ids?: string[]
          client_id: string
          copy_hash?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          lint?: Json | null
          post_id?: string | null
          requested_by?: string | null
          requested_via: string
          runtime: string
          status: string
          target: Json
        }
        Update: {
          attempt?: number
          authority_opportunity_id?: string | null
          brief?: Json | null
          brief_hash?: string
          brief_version?: string
          claim_ids?: string[]
          client_id?: string
          copy_hash?: string | null
          created_at?: string
          detail?: string | null
          id?: string
          lint?: Json | null
          post_id?: string | null
          requested_by?: string | null
          requested_via?: string
          runtime?: string
          status?: string
          target?: Json
        }
        Relationships: [
          {
            foreignKeyName: "drafter_runs_authority_opportunity_fk"
            columns: ["authority_opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunities"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "drafter_runs_authority_opportunity_fk"
            columns: ["authority_opportunity_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_opportunity_state"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "drafter_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafter_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafter_runs_post_fk"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "drafter_runs_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      foundation_releases: {
        Row: {
          accepted_on: string | null
          created_at: string
          documents: Json
          handoff_url: string | null
          id: string
          is_current: boolean
          notes: string | null
          source_repo: string
          source_sha: string
          version: string
        }
        Insert: {
          accepted_on?: string | null
          created_at?: string
          documents?: Json
          handoff_url?: string | null
          id?: string
          is_current?: boolean
          notes?: string | null
          source_repo: string
          source_sha: string
          version: string
        }
        Update: {
          accepted_on?: string | null
          created_at?: string
          documents?: Json
          handoff_url?: string | null
          id?: string
          is_current?: boolean
          notes?: string | null
          source_repo?: string
          source_sha?: string
          version?: string
        }
        Relationships: []
      }
      grid_configs: {
        Row: {
          brightlocal_lsg_report_id: string | null
          center_lat: number | null
          center_lng: number | null
          grid_size: number
          id: string
          is_active: boolean
          keyword_ids: string[]
          location_id: string
          spacing_miles: number
        }
        Insert: {
          brightlocal_lsg_report_id?: string | null
          center_lat?: number | null
          center_lng?: number | null
          grid_size?: number
          id?: string
          is_active?: boolean
          keyword_ids?: string[]
          location_id: string
          spacing_miles?: number
        }
        Update: {
          brightlocal_lsg_report_id?: string | null
          center_lat?: number | null
          center_lng?: number | null
          grid_size?: number
          id?: string
          is_active?: boolean
          keyword_ids?: string[]
          location_id?: string
          spacing_miles?: number
        }
        Relationships: [
          {
            foreignKeyName: "grid_configs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      grid_snapshots: {
        Row: {
          avg_map_rank: number | null
          competitors: Json | null
          grid_config_id: string
          id: string
          keyword_id: string
          points: Json | null
          recorded_at: string
          report_url: string | null
          run_id: string | null
          share_of_voice: number | null
        }
        Insert: {
          avg_map_rank?: number | null
          competitors?: Json | null
          grid_config_id: string
          id?: string
          keyword_id: string
          points?: Json | null
          recorded_at?: string
          report_url?: string | null
          run_id?: string | null
          share_of_voice?: number | null
        }
        Update: {
          avg_map_rank?: number | null
          competitors?: Json | null
          grid_config_id?: string
          id?: string
          keyword_id?: string
          points?: Json | null
          recorded_at?: string
          report_url?: string | null
          run_id?: string | null
          share_of_voice?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "grid_snapshots_grid_config_id_fkey"
            columns: ["grid_config_id"]
            isOneToOne: false
            referencedRelation: "grid_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grid_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "grid_snapshots_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "rank_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      gsc_snapshots: {
        Row: {
          avg_position: number | null
          clicks: number
          client_id: string
          ctr: number | null
          id: string
          impressions: number
          keyword_id: string | null
          page: string | null
          period_end: string
          period_start: string
          query: string
          recorded_at: string
        }
        Insert: {
          avg_position?: number | null
          clicks?: number
          client_id: string
          ctr?: number | null
          id?: string
          impressions?: number
          keyword_id?: string | null
          page?: string | null
          period_end: string
          period_start: string
          query: string
          recorded_at?: string
        }
        Update: {
          avg_position?: number | null
          clicks?: number
          client_id?: string
          ctr?: number | null
          id?: string
          impressions?: number
          keyword_id?: string | null
          page?: string | null
          period_end?: string
          period_start?: string
          query?: string
          recorded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gsc_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      industry_pulse: {
        Row: {
          affected_client_ids: string[]
          competitor_moves: Json
          created_at: string
          id: string
          news_items: Json
          period: string
          rising_queries: Json
          serp_changes: Json
          vertical: string
        }
        Insert: {
          affected_client_ids?: string[]
          competitor_moves?: Json
          created_at?: string
          id?: string
          news_items?: Json
          period: string
          rising_queries?: Json
          serp_changes?: Json
          vertical: string
        }
        Update: {
          affected_client_ids?: string[]
          competitor_moves?: Json
          created_at?: string
          id?: string
          news_items?: Json
          period?: string
          rising_queries?: Json
          serp_changes?: Json
          vertical?: string
        }
        Relationships: []
      }
      invoice_line_items: {
        Row: {
          amount_cents: number
          client_id: string
          created_at: string
          currency: string
          description: string | null
          id: string
          invoice_id: string
          period_end: string | null
          period_start: string | null
          proration: boolean
          quantity: number | null
          stripe_line_item_id: string
          stripe_price_id: string | null
          stripe_product_id: string | null
          stripe_subscription_item_id: string | null
          stripe_synced_at: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          client_id: string
          created_at?: string
          currency: string
          description?: string | null
          id?: string
          invoice_id: string
          period_end?: string | null
          period_start?: string | null
          proration?: boolean
          quantity?: number | null
          stripe_line_item_id: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          stripe_subscription_item_id?: string | null
          stripe_synced_at: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          client_id?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          invoice_id?: string
          period_end?: string | null
          period_start?: string | null
          proration?: boolean
          quantity?: number | null
          stripe_line_item_id?: string
          stripe_price_id?: string | null
          stripe_product_id?: string | null
          stripe_subscription_item_id?: string | null
          stripe_synced_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_client_id_fkey"
            columns: ["invoice_id", "client_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      invoices: {
        Row: {
          amount_due_cents: number
          amount_paid_cents: number
          amount_remaining_cents: number
          attempt_count: number
          attempted: boolean
          billing_reason: string | null
          client_id: string
          collection_method: string
          created_at: string
          currency: string
          due_date: string | null
          finalized_at: string | null
          hosted_invoice_url: string | null
          id: string
          invoice_pdf: string | null
          livemode: boolean
          marked_uncollectible_at: string | null
          next_payment_attempt: string | null
          number: string | null
          paid_at: string | null
          paid_out_of_band: boolean
          period_end: string | null
          period_start: string | null
          status: string
          stripe_created_at: string
          stripe_customer_id: string
          stripe_invoice_id: string
          stripe_subscription_id: string | null
          stripe_synced_at: string
          subtotal_cents: number
          total_cents: number
          updated_at: string
          voided_at: string | null
        }
        Insert: {
          amount_due_cents: number
          amount_paid_cents: number
          amount_remaining_cents: number
          attempt_count?: number
          attempted?: boolean
          billing_reason?: string | null
          client_id: string
          collection_method: string
          created_at?: string
          currency: string
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf?: string | null
          livemode: boolean
          marked_uncollectible_at?: string | null
          next_payment_attempt?: string | null
          number?: string | null
          paid_at?: string | null
          paid_out_of_band?: boolean
          period_end?: string | null
          period_start?: string | null
          status: string
          stripe_created_at: string
          stripe_customer_id: string
          stripe_invoice_id: string
          stripe_subscription_id?: string | null
          stripe_synced_at: string
          subtotal_cents: number
          total_cents: number
          updated_at?: string
          voided_at?: string | null
        }
        Update: {
          amount_due_cents?: number
          amount_paid_cents?: number
          amount_remaining_cents?: number
          attempt_count?: number
          attempted?: boolean
          billing_reason?: string | null
          client_id?: string
          collection_method?: string
          created_at?: string
          currency?: string
          due_date?: string | null
          finalized_at?: string | null
          hosted_invoice_url?: string | null
          id?: string
          invoice_pdf?: string | null
          livemode?: boolean
          marked_uncollectible_at?: string | null
          next_payment_attempt?: string | null
          number?: string | null
          paid_at?: string | null
          paid_out_of_band?: boolean
          period_end?: string | null
          period_start?: string | null
          status?: string
          stripe_created_at?: string
          stripe_customer_id?: string
          stripe_invoice_id?: string
          stripe_subscription_id?: string | null
          stripe_synced_at?: string
          subtotal_cents?: number
          total_cents?: number
          updated_at?: string
          voided_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_stripe_customer_id_client_id_fkey"
            columns: ["stripe_customer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "stripe_customers"
            referencedColumns: ["stripe_customer_id", "client_id"]
          },
          {
            foreignKeyName: "invoices_stripe_subscription_id_client_id_fkey"
            columns: ["stripe_subscription_id", "client_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["stripe_subscription_id", "client_id"]
          },
        ]
      }
      keywords: {
        Row: {
          city: string | null
          client_id: string
          competition: number | null
          cpc: number | null
          created_at: string
          department: Database["public"]["Enums"]["department"]
          id: string
          intent: string | null
          intent_note: string | null
          is_active: boolean
          is_money: boolean
          is_tracked: boolean
          keyword: string
          last_checked: string | null
          priority: Database["public"]["Enums"]["keyword_priority"]
          service_id: string | null
          source: string | null
          target_url: string | null
          volume: number | null
        }
        Insert: {
          city?: string | null
          client_id: string
          competition?: number | null
          cpc?: number | null
          created_at?: string
          department?: Database["public"]["Enums"]["department"]
          id?: string
          intent?: string | null
          intent_note?: string | null
          is_active?: boolean
          is_money?: boolean
          is_tracked?: boolean
          keyword: string
          last_checked?: string | null
          priority?: Database["public"]["Enums"]["keyword_priority"]
          service_id?: string | null
          source?: string | null
          target_url?: string | null
          volume?: number | null
        }
        Update: {
          city?: string | null
          client_id?: string
          competition?: number | null
          cpc?: number | null
          created_at?: string
          department?: Database["public"]["Enums"]["department"]
          id?: string
          intent?: string | null
          intent_note?: string | null
          is_active?: boolean
          is_money?: boolean
          is_tracked?: boolean
          keyword?: string
          last_checked?: string | null
          priority?: Database["public"]["Enums"]["keyword_priority"]
          service_id?: string | null
          source?: string | null
          target_url?: string | null
          volume?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "keywords_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      location_index: {
        Row: {
          computed_at: string
          id: string
          keywords_counted: number
          location_id: string
          map_index: number | null
          organic_index: number | null
          period: string
        }
        Insert: {
          computed_at?: string
          id?: string
          keywords_counted?: number
          location_id: string
          map_index?: number | null
          organic_index?: number | null
          period: string
        }
        Update: {
          computed_at?: string
          id?: string
          keywords_counted?: number
          location_id?: string
          map_index?: number | null
          organic_index?: number | null
          period?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_index_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          brightlocal_location_id: string | null
          brightlocal_lrt_report_id: string | null
          city: string | null
          client_id: string
          gbp_place_id: string | null
          id: string
          is_active: boolean
          is_physical_location: boolean
          lat: number | null
          lng: number | null
          name: string
          sort_order: number
          state: string | null
        }
        Insert: {
          brightlocal_location_id?: string | null
          brightlocal_lrt_report_id?: string | null
          city?: string | null
          client_id: string
          gbp_place_id?: string | null
          id?: string
          is_active?: boolean
          is_physical_location?: boolean
          lat?: number | null
          lng?: number | null
          name: string
          sort_order?: number
          state?: string | null
        }
        Update: {
          brightlocal_location_id?: string | null
          brightlocal_lrt_report_id?: string | null
          city?: string | null
          client_id?: string
          gbp_place_id?: string | null
          id?: string
          is_active?: boolean
          is_physical_location?: boolean
          lat?: number | null
          lng?: number | null
          name?: string
          sort_order?: number
          state?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "locations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      money_keywords: {
        Row: {
          alert_threshold_map: number
          alert_threshold_organic: number
          client_id: string
          confirmed_by: string | null
          confirmed_on: string | null
          created_at: string
          id: string
          keyword_id: string
        }
        Insert: {
          alert_threshold_map?: number
          alert_threshold_organic?: number
          client_id: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          id?: string
          keyword_id: string
        }
        Update: {
          alert_threshold_map?: number
          alert_threshold_organic?: number
          client_id?: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          id?: string
          keyword_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "money_keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "money_keywords_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: true
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_cycles: {
        Row: {
          client_id: string
          completed_at: string | null
          id: string
          notes: string | null
          period: string
          rank_summary: Json | null
          report_url: string | null
          status: Database["public"]["Enums"]["cycle_status"]
          summary: Json | null
        }
        Insert: {
          client_id: string
          completed_at?: string | null
          id?: string
          notes?: string | null
          period: string
          rank_summary?: Json | null
          report_url?: string | null
          status?: Database["public"]["Enums"]["cycle_status"]
          summary?: Json | null
        }
        Update: {
          client_id?: string
          completed_at?: string | null
          id?: string
          notes?: string | null
          period?: string
          rank_summary?: Json | null
          report_url?: string | null
          status?: Database["public"]["Enums"]["cycle_status"]
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "monthly_cycles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_cycles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          client_id: string
          confirmed_by: string | null
          confirmed_on: string | null
          created_at: string
          ends_on: string | null
          id: string
          notes: string | null
          service_id: string | null
          source: string
          starts_on: string | null
          status: string
          terms: string
          title: string
          updated_at: string
        }
        Insert: {
          client_id: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          ends_on?: string | null
          id?: string
          notes?: string | null
          service_id?: string | null
          source: string
          starts_on?: string | null
          status?: string
          terms: string
          title: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          confirmed_by?: string | null
          confirmed_on?: string | null
          created_at?: string
          ends_on?: string | null
          id?: string
          notes?: string | null
          service_id?: string | null
          source?: string
          starts_on?: string | null
          status?: string
          terms?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "offers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offers_service_id_fkey"
            columns: ["service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
        ]
      }
      package_entitlements: {
        Row: {
          enabled: boolean
          notes: string | null
          package_id: string
          quantity: number | null
          service_key: string
          service_kind: string
          updated_at: string
        }
        Insert: {
          enabled: boolean
          notes?: string | null
          package_id: string
          quantity?: number | null
          service_key: string
          service_kind: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          notes?: string | null
          package_id?: string
          quantity?: number | null
          service_key?: string
          service_kind?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "package_entitlements_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "billing_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "package_entitlements_service_key_service_kind_fkey"
            columns: ["service_key", "service_kind"]
            isOneToOne: false
            referencedRelation: "service_catalog"
            referencedColumns: ["key", "kind"]
          },
        ]
      }
      page_groups: {
        Row: {
          city_tier: Database["public"]["Enums"]["city_tier"] | null
          client_id: string
          created_at: string
          id: string
          name: string
          page_type: Database["public"]["Enums"]["page_group_type"]
          primary_keyword_id: string | null
          serp_notes: string | null
          status: Database["public"]["Enums"]["taxonomy_status"]
          supporting_keyword_ids: string[]
          target_url: string | null
        }
        Insert: {
          city_tier?: Database["public"]["Enums"]["city_tier"] | null
          client_id: string
          created_at?: string
          id?: string
          name: string
          page_type?: Database["public"]["Enums"]["page_group_type"]
          primary_keyword_id?: string | null
          serp_notes?: string | null
          status?: Database["public"]["Enums"]["taxonomy_status"]
          supporting_keyword_ids?: string[]
          target_url?: string | null
        }
        Update: {
          city_tier?: Database["public"]["Enums"]["city_tier"] | null
          client_id?: string
          created_at?: string
          id?: string
          name?: string
          page_type?: Database["public"]["Enums"]["page_group_type"]
          primary_keyword_id?: string | null
          serp_notes?: string | null
          status?: Database["public"]["Enums"]["taxonomy_status"]
          supporting_keyword_ids?: string[]
          target_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "page_groups_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "page_groups_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "page_groups_primary_keyword_id_fkey"
            columns: ["primary_keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          amount_refunded_cents: number
          client_id: string
          client_request_id: string | null
          created_at: string
          currency: string
          external_method: string | null
          failure_code: string | null
          failure_message: string | null
          id: string
          livemode: boolean | null
          notes: string | null
          paid_at: string | null
          payment_method_type: string | null
          recorded_by: string | null
          reference: string | null
          source: string
          status: string
          stripe_charge_id: string | null
          stripe_created_at: string | null
          stripe_customer_id: string | null
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          stripe_synced_at: string | null
          updated_at: string
          void_reason: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          amount_cents: number
          amount_refunded_cents?: number
          client_id: string
          client_request_id?: string | null
          created_at?: string
          currency: string
          external_method?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          livemode?: boolean | null
          notes?: string | null
          paid_at?: string | null
          payment_method_type?: string | null
          recorded_by?: string | null
          reference?: string | null
          source: string
          status: string
          stripe_charge_id?: string | null
          stripe_created_at?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_synced_at?: string | null
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          amount_cents?: number
          amount_refunded_cents?: number
          client_id?: string
          client_request_id?: string | null
          created_at?: string
          currency?: string
          external_method?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          livemode?: boolean | null
          notes?: string | null
          paid_at?: string | null
          payment_method_type?: string | null
          recorded_by?: string | null
          reference?: string | null
          source?: string
          status?: string
          stripe_charge_id?: string | null
          stripe_created_at?: string | null
          stripe_customer_id?: string | null
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_synced_at?: string | null
          updated_at?: string
          void_reason?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_stripe_customer_id_client_id_fkey"
            columns: ["stripe_customer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "stripe_customers"
            referencedColumns: ["stripe_customer_id", "client_id"]
          },
          {
            foreignKeyName: "payments_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_voided_by_fkey"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      pipelines: {
        Row: {
          id: string
          is_recurring: boolean
          key: Database["public"]["Enums"]["pipeline_key"]
          name: string
          sort_order: number
        }
        Insert: {
          id?: string
          is_recurring?: boolean
          key: Database["public"]["Enums"]["pipeline_key"]
          name: string
          sort_order?: number
        }
        Update: {
          id?: string
          is_recurring?: boolean
          key?: Database["public"]["Enums"]["pipeline_key"]
          name?: string
          sort_order?: number
        }
        Relationships: []
      }
      placeholders: {
        Row: {
          client_id: string
          client_request_id: string | null
          created_at: string
          description: string | null
          id: string
          page: string | null
          resolved: boolean
          resolved_at: string | null
          site_id: string | null
          type: Database["public"]["Enums"]["placeholder_type"]
        }
        Insert: {
          client_id: string
          client_request_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          page?: string | null
          resolved?: boolean
          resolved_at?: string | null
          site_id?: string | null
          type: Database["public"]["Enums"]["placeholder_type"]
        }
        Update: {
          client_id?: string
          client_request_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          page?: string | null
          resolved?: boolean
          resolved_at?: string | null
          site_id?: string | null
          type?: Database["public"]["Enums"]["placeholder_type"]
        }
        Relationships: [
          {
            foreignKeyName: "placeholders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placeholders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placeholders_client_request_id_fkey"
            columns: ["client_request_id"]
            isOneToOne: false
            referencedRelation: "client_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "placeholders_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "sites"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          client_id: string
          collection: string
          external_amount_cents: number | null
          external_currency: string | null
          external_interval: string | null
          external_method: string | null
          id: string
          managed_ad_budget_cents: number | null
          notes: string | null
          package_id: string | null
          renewal_date: string | null
          start_date: string | null
          term_months: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          client_id: string
          collection?: string
          external_amount_cents?: number | null
          external_currency?: string | null
          external_interval?: string | null
          external_method?: string | null
          id?: string
          managed_ad_budget_cents?: number | null
          notes?: string | null
          package_id?: string | null
          renewal_date?: string | null
          start_date?: string | null
          term_months?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          client_id?: string
          collection?: string
          external_amount_cents?: number | null
          external_currency?: string | null
          external_interval?: string | null
          external_method?: string | null
          id?: string
          managed_ad_budget_cents?: number | null
          notes?: string | null
          package_id?: string | null
          renewal_date?: string | null
          start_date?: string | null
          term_months?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "plans_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "billing_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: true
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_users: {
        Row: {
          auth_user_id: string | null
          client_id: string
          created_at: string
          email: string
          id: string
          invited_at: string | null
          invited_by: string | null
          is_active: boolean
          last_seen_at: string | null
          name: string | null
        }
        Insert: {
          auth_user_id?: string | null
          client_id: string
          created_at?: string
          email: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean
          last_seen_at?: string | null
          name?: string | null
        }
        Update: {
          auth_user_id?: string | null
          client_id?: string
          created_at?: string
          email?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          is_active?: boolean
          last_seen_at?: string | null
          name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "portal_users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "portal_users_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      post_assets: {
        Row: {
          brand_asset_id: string | null
          client_id: string
          content_hash: string | null
          copy_hash: string | null
          created_at: string
          creative_asset_id: string | null
          id: string
          post_id: string
          role: string
          sort_order: number
        }
        Insert: {
          brand_asset_id?: string | null
          client_id: string
          content_hash?: string | null
          copy_hash?: string | null
          created_at?: string
          creative_asset_id?: string | null
          id?: string
          post_id: string
          role?: string
          sort_order?: number
        }
        Update: {
          brand_asset_id?: string | null
          client_id?: string
          content_hash?: string | null
          copy_hash?: string | null
          created_at?: string
          creative_asset_id?: string | null
          id?: string
          post_id?: string
          role?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "post_assets_brand_asset_id_client_id_fkey"
            columns: ["brand_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "brand_assets"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "post_assets_creative_fkey"
            columns: ["creative_asset_id", "client_id"]
            isOneToOne: false
            referencedRelation: "creative_assets"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "post_assets_post_id_client_id_fkey"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      post_claims: {
        Row: {
          claim_id: string
          client_id: string
          created_at: string
          post_id: string
        }
        Insert: {
          claim_id: string
          client_id: string
          created_at?: string
          post_id: string
        }
        Update: {
          claim_id?: string
          client_id?: string
          created_at?: string
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "post_claims_claim_id_client_id_fkey"
            columns: ["claim_id", "client_id"]
            isOneToOne: false
            referencedRelation: "claims"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "post_claims_post_id_client_id_fkey"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      post_events: {
        Row: {
          actor_id: string | null
          actor_kind: string
          client_id: string
          created_at: string
          detail: Json | null
          from_value: string | null
          id: number
          kind: string
          post_id: string
          to_value: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_kind: string
          client_id: string
          created_at?: string
          detail?: Json | null
          from_value?: string | null
          id?: never
          kind: string
          post_id: string
          to_value?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_kind?: string
          client_id?: string
          created_at?: string
          detail?: Json | null
          from_value?: string | null
          id?: never
          kind?: string
          post_id?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "post_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "post_events_post_id_client_id_fkey"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      publisher_runs: {
        Row: {
          client_id: string
          created_at: string
          detail: string | null
          http_status: number | null
          id: number
          mode: string
          outcome: string
          post_id: string
          task_id: string | null
          transient: boolean
        }
        Insert: {
          client_id: string
          created_at?: string
          detail?: string | null
          http_status?: number | null
          id?: never
          mode: string
          outcome: string
          post_id: string
          task_id?: string | null
          transient?: boolean
        }
        Update: {
          client_id?: string
          created_at?: string
          detail?: string | null
          http_status?: number | null
          id?: never
          mode?: string
          outcome?: string
          post_id?: string
          task_id?: string | null
          transient?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "publisher_runs_post_id_client_id_fkey"
            columns: ["post_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_posts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "publisher_runs_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      rank_runs: {
        Row: {
          checks_count: number | null
          client_id: string
          completed_at: string | null
          error: string | null
          id: string
          started_at: string
          status: Database["public"]["Enums"]["run_status"]
          triggered_by: Database["public"]["Enums"]["run_trigger"]
        }
        Insert: {
          checks_count?: number | null
          client_id: string
          completed_at?: string | null
          error?: string | null
          id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          triggered_by?: Database["public"]["Enums"]["run_trigger"]
        }
        Update: {
          checks_count?: number | null
          client_id?: string
          completed_at?: string | null
          error?: string | null
          id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          triggered_by?: Database["public"]["Enums"]["run_trigger"]
        }
        Relationships: [
          {
            foreignKeyName: "rank_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rank_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      rank_snapshots: {
        Row: {
          id: string
          keyword_id: string
          location_id: string
          position: number | null
          recorded_at: string
          result_type: Database["public"]["Enums"]["rank_result_type"]
          run_id: string | null
          source: Database["public"]["Enums"]["rank_source"]
          url_ranked: string | null
        }
        Insert: {
          id?: string
          keyword_id: string
          location_id: string
          position?: number | null
          recorded_at?: string
          result_type: Database["public"]["Enums"]["rank_result_type"]
          run_id?: string | null
          source?: Database["public"]["Enums"]["rank_source"]
          url_ranked?: string | null
        }
        Update: {
          id?: string
          keyword_id?: string
          location_id?: string
          position?: number | null
          recorded_at?: string
          result_type?: Database["public"]["Enums"]["rank_result_type"]
          run_id?: string | null
          source?: Database["public"]["Enums"]["rank_source"]
          url_ranked?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rank_snapshots_keyword_id_fkey"
            columns: ["keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rank_snapshots_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rank_snapshots_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "rank_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      report_measurements: {
        Row: {
          channel: string
          client_id: string
          context: string
          created_at: string
          evidence: string
          id: string
          meaning: string
          metric: string
          next_action: string
          platform: string
          recorded_by: string
          report_period: string | null
          scope: string
          sequence: number
          source: string
          status: string
          value: number | null
          window_end: string
          window_start: string
        }
        Insert: {
          channel?: string
          client_id: string
          context: string
          created_at?: string
          evidence?: string
          id?: string
          meaning: string
          metric: string
          next_action: string
          platform?: string
          recorded_by?: string
          report_period?: string | null
          scope: string
          sequence?: number
          source: string
          status: string
          value?: number | null
          window_end: string
          window_start: string
        }
        Update: {
          channel?: string
          client_id?: string
          context?: string
          created_at?: string
          evidence?: string
          id?: string
          meaning?: string
          metric?: string
          next_action?: string
          platform?: string
          recorded_by?: string
          report_period?: string | null
          scope?: string
          sequence?: number
          source?: string
          status?: string
          value?: number | null
          window_end?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_measurements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_measurements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      service_catalog: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          key: string
          kind: string
          name: string
          period: string | null
          pipeline_key: Database["public"]["Enums"]["pipeline_key"] | null
          sort_order: number
          unit: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          key: string
          kind: string
          name: string
          period?: string | null
          pipeline_key?: Database["public"]["Enums"]["pipeline_key"] | null
          sort_order?: number
          unit?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          key?: string
          kind?: string
          name?: string
          period?: string | null
          pipeline_key?: Database["public"]["Enums"]["pipeline_key"] | null
          sort_order?: number
          unit?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      services: {
        Row: {
          client_id: string
          created_at: string
          gbp_entry: string | null
          id: string
          name: string
          page_type: Database["public"]["Enums"]["service_page_type"]
          page_url: string | null
          parent_service_id: string | null
          primary_keyword_id: string | null
          segment: string | null
          sort_order: number
          status: Database["public"]["Enums"]["taxonomy_status"]
        }
        Insert: {
          client_id: string
          created_at?: string
          gbp_entry?: string | null
          id?: string
          name: string
          page_type?: Database["public"]["Enums"]["service_page_type"]
          page_url?: string | null
          parent_service_id?: string | null
          primary_keyword_id?: string | null
          segment?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["taxonomy_status"]
        }
        Update: {
          client_id?: string
          created_at?: string
          gbp_entry?: string | null
          id?: string
          name?: string
          page_type?: Database["public"]["Enums"]["service_page_type"]
          page_url?: string | null
          parent_service_id?: string | null
          primary_keyword_id?: string | null
          segment?: string | null
          sort_order?: number
          status?: Database["public"]["Enums"]["taxonomy_status"]
        }
        Relationships: [
          {
            foreignKeyName: "services_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_parent_service_id_fkey"
            columns: ["parent_service_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "services_primary_keyword_id_fkey"
            columns: ["primary_keyword_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id"]
          },
        ]
      }
      sites: {
        Row: {
          audit: Json | null
          audit_checked_at: string | null
          branch: string | null
          build_brief: Json | null
          build_brief_at: string | null
          client_id: string
          content_adapter: string | null
          content_paths: Json | null
          controlled_by_compass: boolean
          created_at: string
          domain_constant: string | null
          foundation_sha: string | null
          foundation_version: string | null
          ga4_measurement_id: string | null
          id: string
          last_commit_url: string | null
          last_pushed_at: string | null
          launched_at: string | null
          preview_branch: string | null
          quality: Json | null
          quality_checked_at: string | null
          repo_url: string | null
          stack: Database["public"]["Enums"]["site_stack"]
          staging_url: string | null
          url: string | null
          vercel_project: string | null
          work_mode: Database["public"]["Enums"]["website_work_mode"] | null
        }
        Insert: {
          audit?: Json | null
          audit_checked_at?: string | null
          branch?: string | null
          build_brief?: Json | null
          build_brief_at?: string | null
          client_id: string
          content_adapter?: string | null
          content_paths?: Json | null
          controlled_by_compass?: boolean
          created_at?: string
          domain_constant?: string | null
          foundation_sha?: string | null
          foundation_version?: string | null
          ga4_measurement_id?: string | null
          id?: string
          last_commit_url?: string | null
          last_pushed_at?: string | null
          launched_at?: string | null
          preview_branch?: string | null
          quality?: Json | null
          quality_checked_at?: string | null
          repo_url?: string | null
          stack?: Database["public"]["Enums"]["site_stack"]
          staging_url?: string | null
          url?: string | null
          vercel_project?: string | null
          work_mode?: Database["public"]["Enums"]["website_work_mode"] | null
        }
        Update: {
          audit?: Json | null
          audit_checked_at?: string | null
          branch?: string | null
          build_brief?: Json | null
          build_brief_at?: string | null
          client_id?: string
          content_adapter?: string | null
          content_paths?: Json | null
          controlled_by_compass?: boolean
          created_at?: string
          domain_constant?: string | null
          foundation_sha?: string | null
          foundation_version?: string | null
          ga4_measurement_id?: string | null
          id?: string
          last_commit_url?: string | null
          last_pushed_at?: string | null
          launched_at?: string | null
          preview_branch?: string | null
          quality?: Json | null
          quality_checked_at?: string | null
          repo_url?: string | null
          stack?: Database["public"]["Enums"]["site_stack"]
          staging_url?: string | null
          url?: string | null
          vercel_project?: string | null
          work_mode?: Database["public"]["Enums"]["website_work_mode"] | null
        }
        Relationships: [
          {
            foreignKeyName: "sites_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sites_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      social_accounts: {
        Row: {
          access_token: string | null
          client_id: string
          connected_at: string | null
          display_name: string | null
          external_account_id: string | null
          id: string
          platform: Database["public"]["Enums"]["social_platform"]
          status: Database["public"]["Enums"]["social_account_status"]
          token_expires_at: string | null
        }
        Insert: {
          access_token?: string | null
          client_id: string
          connected_at?: string | null
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          platform: Database["public"]["Enums"]["social_platform"]
          status?: Database["public"]["Enums"]["social_account_status"]
          token_expires_at?: string | null
        }
        Update: {
          access_token?: string | null
          client_id?: string
          connected_at?: string | null
          display_name?: string | null
          external_account_id?: string | null
          id?: string
          platform?: Database["public"]["Enums"]["social_platform"]
          status?: Database["public"]["Enums"]["social_account_status"]
          token_expires_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_accounts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      social_posts: {
        Row: {
          approved_hash: string | null
          approved_snapshot: Json | null
          author_kind: string
          client_id: string
          copy: string | null
          created_at: string
          created_by: string | null
          creative_policy: string
          creative_status: string
          creative_version: number
          crm_facts_only: boolean
          cta_type: string | null
          cta_url: string | null
          drafter_run_id: string | null
          error: string | null
          external_post_id: string | null
          id: string
          keyword_id: string | null
          last_attempt_at: string | null
          notes: string | null
          offer_id: string | null
          platform: Database["public"]["Enums"]["social_platform"]
          post_type: string
          publish_attempts: number
          publish_key: string
          publish_status: string
          published_at: string | null
          published_url: string | null
          rejection_category: string | null
          review_note: string | null
          review_status: string
          review_task_id: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          scheduled_at: string | null
          search_intent: string
          service_id: string | null
          social_account_id: string | null
          submitted_at: string | null
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          approved_hash?: string | null
          approved_snapshot?: Json | null
          author_kind?: string
          client_id: string
          copy?: string | null
          created_at?: string
          created_by?: string | null
          creative_policy?: string
          creative_status?: string
          creative_version?: number
          crm_facts_only?: boolean
          cta_type?: string | null
          cta_url?: string | null
          drafter_run_id?: string | null
          error?: string | null
          external_post_id?: string | null
          id?: string
          keyword_id?: string | null
          last_attempt_at?: string | null
          notes?: string | null
          offer_id?: string | null
          platform: Database["public"]["Enums"]["social_platform"]
          post_type?: string
          publish_attempts?: number
          publish_key?: string
          publish_status?: string
          published_at?: string | null
          published_url?: string | null
          rejection_category?: string | null
          review_note?: string | null
          review_status?: string
          review_task_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scheduled_at?: string | null
          search_intent: string
          service_id?: string | null
          social_account_id?: string | null
          submitted_at?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          approved_hash?: string | null
          approved_snapshot?: Json | null
          author_kind?: string
          client_id?: string
          copy?: string | null
          created_at?: string
          created_by?: string | null
          creative_policy?: string
          creative_status?: string
          creative_version?: number
          crm_facts_only?: boolean
          cta_type?: string | null
          cta_url?: string | null
          drafter_run_id?: string | null
          error?: string | null
          external_post_id?: string | null
          id?: string
          keyword_id?: string | null
          last_attempt_at?: string | null
          notes?: string | null
          offer_id?: string | null
          platform?: Database["public"]["Enums"]["social_platform"]
          post_type?: string
          publish_attempts?: number
          publish_key?: string
          publish_status?: string
          published_at?: string | null
          published_url?: string | null
          rejection_category?: string | null
          review_note?: string | null
          review_status?: string
          review_task_id?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scheduled_at?: string | null
          search_intent?: string
          service_id?: string | null
          social_account_id?: string | null
          submitted_at?: string | null
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "social_posts_account_fkey"
            columns: ["social_account_id", "client_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_drafter_run_fk"
            columns: ["drafter_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "drafter_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_keyword_fkey"
            columns: ["keyword_id", "client_id"]
            isOneToOne: false
            referencedRelation: "keywords"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_offer_fkey"
            columns: ["offer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_review_task_fkey"
            columns: ["review_task_id", "client_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "social_posts_service_fkey"
            columns: ["service_id", "client_id"]
            isOneToOne: false
            referencedRelation: "services"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "social_posts_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      stages: {
        Row: {
          autonomy_level: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner: Database["public"]["Enums"]["owner_type"]
          description: string | null
          id: string
          is_optional: boolean
          name: string
          pipeline_id: string
          playbook_ref: string | null
          requires_foundation: boolean
          sort_order: number
        }
        Insert: {
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner?: Database["public"]["Enums"]["owner_type"]
          description?: string | null
          id?: string
          is_optional?: boolean
          name: string
          pipeline_id: string
          playbook_ref?: string | null
          requires_foundation?: boolean
          sort_order?: number
        }
        Update: {
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner?: Database["public"]["Enums"]["owner_type"]
          description?: string | null
          id?: string
          is_optional?: boolean
          name?: string
          pipeline_id?: string
          playbook_ref?: string | null
          requires_foundation?: boolean
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "stages_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_customers: {
        Row: {
          client_id: string
          created_at: string
          currency: string | null
          default_payment_method_brand: string | null
          default_payment_method_last4: string | null
          default_payment_method_type: string | null
          deleted_at: string | null
          email: string | null
          id: string
          link_source: string
          linked_at: string
          linked_by: string | null
          livemode: boolean
          metadata: Json
          name: string | null
          stripe_created_at: string | null
          stripe_customer_id: string
          stripe_synced_at: string
          unlink_reason: string | null
          unlinked_at: string | null
          unlinked_by: string | null
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          currency?: string | null
          default_payment_method_brand?: string | null
          default_payment_method_last4?: string | null
          default_payment_method_type?: string | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          link_source: string
          linked_at?: string
          linked_by?: string | null
          livemode: boolean
          metadata?: Json
          name?: string | null
          stripe_created_at?: string | null
          stripe_customer_id: string
          stripe_synced_at: string
          unlink_reason?: string | null
          unlinked_at?: string | null
          unlinked_by?: string | null
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          currency?: string | null
          default_payment_method_brand?: string | null
          default_payment_method_last4?: string | null
          default_payment_method_type?: string | null
          deleted_at?: string | null
          email?: string | null
          id?: string
          link_source?: string
          linked_at?: string
          linked_by?: string | null
          livemode?: boolean
          metadata?: Json
          name?: string | null
          stripe_created_at?: string | null
          stripe_customer_id?: string
          stripe_synced_at?: string
          unlink_reason?: string | null
          unlinked_at?: string | null
          unlinked_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_customers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_customers_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_customers_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_customers_unlinked_by_fkey"
            columns: ["unlinked_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          api_version: string | null
          attempts: number
          event_created_at: string
          id: string
          ignored_reason: string | null
          last_attempt_at: string | null
          last_error: string | null
          lease_expires_at: string | null
          livemode: boolean
          object_id: string | null
          object_type: string | null
          processed_at: string | null
          received_at: string
          status: string
          type: string
        }
        Insert: {
          api_version?: string | null
          attempts?: number
          event_created_at: string
          id: string
          ignored_reason?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          lease_expires_at?: string | null
          livemode: boolean
          object_id?: string | null
          object_type?: string | null
          processed_at?: string | null
          received_at?: string
          status?: string
          type: string
        }
        Update: {
          api_version?: string | null
          attempts?: number
          event_created_at?: string
          id?: string
          ignored_reason?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          lease_expires_at?: string | null
          livemode?: boolean
          object_id?: string | null
          object_type?: string | null
          processed_at?: string | null
          received_at?: string
          status?: string
          type?: string
        }
        Relationships: []
      }
      stripe_prices: {
        Row: {
          active: boolean
          billing_scheme: string
          created_at: string
          currency: string
          deleted_at: string | null
          livemode: boolean
          lookup_key: string | null
          metadata: Json
          nickname: string | null
          recurring_interval: string | null
          recurring_interval_count: number | null
          recurring_usage_type: string | null
          stripe_created_at: string | null
          stripe_price_id: string
          stripe_product_id: string
          stripe_synced_at: string
          tax_behavior: string | null
          type: string
          unit_amount_cents: number | null
          updated_at: string
        }
        Insert: {
          active: boolean
          billing_scheme?: string
          created_at?: string
          currency: string
          deleted_at?: string | null
          livemode: boolean
          lookup_key?: string | null
          metadata?: Json
          nickname?: string | null
          recurring_interval?: string | null
          recurring_interval_count?: number | null
          recurring_usage_type?: string | null
          stripe_created_at?: string | null
          stripe_price_id: string
          stripe_product_id: string
          stripe_synced_at: string
          tax_behavior?: string | null
          type: string
          unit_amount_cents?: number | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          billing_scheme?: string
          created_at?: string
          currency?: string
          deleted_at?: string | null
          livemode?: boolean
          lookup_key?: string | null
          metadata?: Json
          nickname?: string | null
          recurring_interval?: string | null
          recurring_interval_count?: number | null
          recurring_usage_type?: string | null
          stripe_created_at?: string | null
          stripe_price_id?: string
          stripe_product_id?: string
          stripe_synced_at?: string
          tax_behavior?: string | null
          type?: string
          unit_amount_cents?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_prices_stripe_product_id_fkey"
            columns: ["stripe_product_id"]
            isOneToOne: false
            referencedRelation: "stripe_products"
            referencedColumns: ["stripe_product_id"]
          },
        ]
      }
      stripe_products: {
        Row: {
          active: boolean
          created_at: string
          deleted_at: string | null
          description: string | null
          livemode: boolean
          metadata: Json
          name: string
          stripe_created_at: string | null
          stripe_product_id: string
          stripe_synced_at: string
          updated_at: string
        }
        Insert: {
          active: boolean
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          livemode: boolean
          metadata?: Json
          name: string
          stripe_created_at?: string | null
          stripe_product_id: string
          stripe_synced_at: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          livemode?: boolean
          metadata?: Json
          name?: string
          stripe_created_at?: string | null
          stripe_product_id?: string
          stripe_synced_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      stripe_refunds: {
        Row: {
          amount_cents: number
          client_id: string
          created_at: string
          currency: string
          failure_reason: string | null
          id: string
          livemode: boolean
          payment_id: string
          payment_source: string
          reason: string | null
          status: string
          stripe_charge_id: string | null
          stripe_created_at: string
          stripe_payment_intent_id: string | null
          stripe_refund_id: string
          stripe_synced_at: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          client_id: string
          created_at?: string
          currency: string
          failure_reason?: string | null
          id?: string
          livemode: boolean
          payment_id: string
          payment_source?: string
          reason?: string | null
          status: string
          stripe_charge_id?: string | null
          stripe_created_at: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id: string
          stripe_synced_at: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          client_id?: string
          created_at?: string
          currency?: string
          failure_reason?: string | null
          id?: string
          livemode?: boolean
          payment_id?: string
          payment_source?: string
          reason?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_created_at?: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string
          stripe_synced_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_refunds_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_payment_id_client_id_payment_source_fkey"
            columns: ["payment_id", "client_id", "payment_source"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id", "client_id", "source"]
          },
        ]
      }
      subscription_items: {
        Row: {
          client_id: string
          created_at: string
          id: string
          quantity: number | null
          stripe_created_at: string | null
          stripe_price_id: string
          stripe_subscription_item_id: string
          stripe_synced_at: string
          subscription_id: string
          updated_at: string
        }
        Insert: {
          client_id: string
          created_at?: string
          id?: string
          quantity?: number | null
          stripe_created_at?: string | null
          stripe_price_id: string
          stripe_subscription_item_id: string
          stripe_synced_at: string
          subscription_id: string
          updated_at?: string
        }
        Update: {
          client_id?: string
          created_at?: string
          id?: string
          quantity?: number | null
          stripe_created_at?: string | null
          stripe_price_id?: string
          stripe_subscription_item_id?: string
          stripe_synced_at?: string
          subscription_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscription_items_stripe_price_id_fkey"
            columns: ["stripe_price_id"]
            isOneToOne: false
            referencedRelation: "stripe_prices"
            referencedColumns: ["stripe_price_id"]
          },
          {
            foreignKeyName: "subscription_items_subscription_id_client_id_fkey"
            columns: ["subscription_id", "client_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      subscriptions: {
        Row: {
          billing_cycle_anchor: string | null
          cancel_at: string | null
          cancel_at_period_end: boolean
          canceled_at: string | null
          cancellation_comment: string | null
          cancellation_feedback: string | null
          cancellation_reason: string | null
          client_id: string
          collection_method: string
          created_at: string
          currency: string
          current_period_end: string | null
          current_period_start: string | null
          days_until_due: number | null
          default_payment_method_type: string | null
          ended_at: string | null
          id: string
          latest_stripe_invoice_id: string | null
          livemode: boolean
          metadata: Json
          pause_collection_behavior: string | null
          pause_collection_resumes_at: string | null
          start_date: string | null
          status: string
          stripe_created_at: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          stripe_synced_at: string
          trial_end: string | null
          trial_start: string | null
          updated_at: string
        }
        Insert: {
          billing_cycle_anchor?: string | null
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          cancellation_comment?: string | null
          cancellation_feedback?: string | null
          cancellation_reason?: string | null
          client_id: string
          collection_method: string
          created_at?: string
          currency: string
          current_period_end?: string | null
          current_period_start?: string | null
          days_until_due?: number | null
          default_payment_method_type?: string | null
          ended_at?: string | null
          id?: string
          latest_stripe_invoice_id?: string | null
          livemode: boolean
          metadata?: Json
          pause_collection_behavior?: string | null
          pause_collection_resumes_at?: string | null
          start_date?: string | null
          status: string
          stripe_created_at?: string | null
          stripe_customer_id: string
          stripe_subscription_id: string
          stripe_synced_at: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Update: {
          billing_cycle_anchor?: string | null
          cancel_at?: string | null
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          cancellation_comment?: string | null
          cancellation_feedback?: string | null
          cancellation_reason?: string | null
          client_id?: string
          collection_method?: string
          created_at?: string
          currency?: string
          current_period_end?: string | null
          current_period_start?: string | null
          days_until_due?: number | null
          default_payment_method_type?: string | null
          ended_at?: string | null
          id?: string
          latest_stripe_invoice_id?: string | null
          livemode?: boolean
          metadata?: Json
          pause_collection_behavior?: string | null
          pause_collection_resumes_at?: string | null
          start_date?: string | null
          status?: string
          stripe_created_at?: string | null
          stripe_customer_id?: string
          stripe_subscription_id?: string
          stripe_synced_at?: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_stripe_customer_id_client_id_fkey"
            columns: ["stripe_customer_id", "client_id"]
            isOneToOne: false
            referencedRelation: "stripe_customers"
            referencedColumns: ["stripe_customer_id", "client_id"]
          },
        ]
      }
      task_comments: {
        Row: {
          author_id: string | null
          body: string
          client_id: string
          created_at: string
          id: string
          task_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          client_id: string
          created_at?: string
          id?: string
          task_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          client_id?: string
          created_at?: string
          id?: string
          task_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_comments_task_id_client_id_fkey"
            columns: ["task_id", "client_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      task_events: {
        Row: {
          actor_id: string | null
          client_id: string
          created_at: string
          from_value: string | null
          id: string
          kind: string
          task_id: string
          to_value: string | null
        }
        Insert: {
          actor_id?: string | null
          client_id: string
          created_at?: string
          from_value?: string | null
          id?: string
          kind: string
          task_id: string
          to_value?: string | null
        }
        Update: {
          actor_id?: string | null
          client_id?: string
          created_at?: string
          from_value?: string | null
          id?: string
          kind?: string
          task_id?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "task_events_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_events_task_id_client_id_fkey"
            columns: ["task_id", "client_id"]
            isOneToOne: false
            referencedRelation: "tasks"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      task_templates: {
        Row: {
          autonomy_level: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner: Database["public"]["Enums"]["owner_type"]
          department: Database["public"]["Enums"]["department"] | null
          id: string
          key: string | null
          pipeline_id: string | null
          playbook_step: string | null
          sort_order: number
          stage_id: string | null
          title: string
        }
        Insert: {
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner?: Database["public"]["Enums"]["owner_type"]
          department?: Database["public"]["Enums"]["department"] | null
          id?: string
          key?: string | null
          pipeline_id?: string | null
          playbook_step?: string | null
          sort_order?: number
          stage_id?: string | null
          title: string
        }
        Update: {
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          default_owner?: Database["public"]["Enums"]["owner_type"]
          department?: Database["public"]["Enums"]["department"] | null
          id?: string
          key?: string | null
          pipeline_id?: string | null
          playbook_step?: string | null
          sort_order?: number
          stage_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_templates_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_templates_stage_id_fkey"
            columns: ["stage_id"]
            isOneToOne: false
            referencedRelation: "stages"
            referencedColumns: ["id"]
          },
        ]
      }
      tasks: {
        Row: {
          assignee_id: string | null
          autonomy_level: Database["public"]["Enums"]["autonomy_level"] | null
          client_id: string
          client_stage_id: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          default_if_approved: string | null
          due_date: string | null
          flagged_for_review: boolean
          id: string
          key: string | null
          monthly_cycle_id: string | null
          notes: string | null
          owner: Database["public"]["Enums"]["owner_type"]
          playbook_step: string | null
          recommendation: string | null
          status: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at: string | null
          updated_by: string | null
        }
        Insert: {
          assignee_id?: string | null
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          client_id: string
          client_stage_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          default_if_approved?: string | null
          due_date?: string | null
          flagged_for_review?: boolean
          id?: string
          key?: string | null
          monthly_cycle_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          playbook_step?: string | null
          recommendation?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Update: {
          assignee_id?: string | null
          autonomy_level?: Database["public"]["Enums"]["autonomy_level"] | null
          client_id?: string
          client_stage_id?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          default_if_approved?: string | null
          due_date?: string | null
          flagged_for_review?: boolean
          id?: string
          key?: string | null
          monthly_cycle_id?: string | null
          notes?: string | null
          owner?: Database["public"]["Enums"]["owner_type"]
          playbook_step?: string | null
          recommendation?: string | null
          status?: Database["public"]["Enums"]["task_status"]
          title?: string
          updated_at?: string | null
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tasks_assignee_id_fkey"
            columns: ["assignee_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_client_stage_id_fkey"
            columns: ["client_stage_id"]
            isOneToOne: false
            referencedRelation: "client_stages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_monthly_cycle_id_fkey"
            columns: ["monthly_cycle_id"]
            isOneToOne: false
            referencedRelation: "monthly_cycles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tasks_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          auth_user_id: string | null
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["team_role"]
        }
        Insert: {
          auth_user_id?: string | null
          email: string
          id?: string
          name: string
          role?: Database["public"]["Enums"]["team_role"]
        }
        Update: {
          auth_user_id?: string | null
          email?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["team_role"]
        }
        Relationships: []
      }
      worker_fires: {
        Row: {
          attempt: number
          client_id: string | null
          created_at: string
          id: number
          reason: string
          request_id: number | null
          retry_of: number | null
        }
        Insert: {
          attempt?: number
          client_id?: string | null
          created_at?: string
          id?: never
          reason: string
          request_id?: number | null
          retry_of?: number | null
        }
        Update: {
          attempt?: number
          client_id?: string | null
          created_at?: string
          id?: never
          reason?: string
          request_id?: number | null
          retry_of?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_fires_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_fires_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "worker_fires_retry_of_fkey"
            columns: ["retry_of"]
            isOneToOne: false
            referencedRelation: "worker_fires"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      authority_latest: {
        Row: {
          client_id: string | null
          counts: Json | null
          created_at: string | null
          diff: Json | null
          engine_version: string | null
          finished_at: string | null
          inventory_fetched_at: string | null
          inventory_stale: boolean | null
          judged_at: string | null
          mode: string | null
          run_id: string | null
          sources: Json | null
          stale_sections: string[] | null
        }
        Relationships: [
          {
            foreignKeyName: "authority_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_runs_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      authority_opportunity_state: {
        Row: {
          action: string | null
          client_id: string | null
          content_type: string | null
          cycle_started_at: string | null
          decided_at: string | null
          decided_by: string | null
          dismissed_until: string | null
          effective_status: string | null
          eligible_from: string | null
          first_seen_run_id: string | null
          id: string | null
          intent: string | null
          key: string | null
          keyword_id: string | null
          last_seen_at: string | null
          last_seen_run_id: string | null
          opportunity: Json | null
          present: boolean | null
          section: string | null
          service_id: string | null
          sort_order: number[] | null
          status: string | null
          status_reason: string | null
          suppressed: boolean | null
          suppression_basis: Json | null
          target_path: string | null
          tier: string | null
          topic: string | null
        }
        Insert: {
          action?: string | null
          client_id?: string | null
          content_type?: string | null
          cycle_started_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          dismissed_until?: string | null
          effective_status?: never
          eligible_from?: string | null
          first_seen_run_id?: string | null
          id?: string | null
          intent?: string | null
          key?: string | null
          keyword_id?: string | null
          last_seen_at?: string | null
          last_seen_run_id?: string | null
          opportunity?: Json | null
          present?: boolean | null
          section?: string | null
          service_id?: string | null
          sort_order?: number[] | null
          status?: string | null
          status_reason?: string | null
          suppressed?: boolean | null
          suppression_basis?: Json | null
          target_path?: string | null
          tier?: string | null
          topic?: string | null
        }
        Update: {
          action?: string | null
          client_id?: string | null
          content_type?: string | null
          cycle_started_at?: string | null
          decided_at?: string | null
          decided_by?: string | null
          dismissed_until?: string | null
          effective_status?: never
          eligible_from?: string | null
          first_seen_run_id?: string | null
          id?: string | null
          intent?: string | null
          key?: string | null
          keyword_id?: string | null
          last_seen_at?: string | null
          last_seen_run_id?: string | null
          opportunity?: Json | null
          present?: boolean | null
          section?: string | null
          service_id?: string | null
          sort_order?: number[] | null
          status?: string | null
          status_reason?: string | null
          suppressed?: boolean | null
          suppression_basis?: Json | null
          target_path?: string | null
          tier?: string | null
          topic?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "authority_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "authority_opportunities_first_run_fk"
            columns: ["first_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_first_run_fk"
            columns: ["first_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_last_run_fk"
            columns: ["last_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_latest"
            referencedColumns: ["run_id", "client_id"]
          },
          {
            foreignKeyName: "authority_opportunities_last_run_fk"
            columns: ["last_seen_run_id", "client_id"]
            isOneToOne: false
            referencedRelation: "authority_runs"
            referencedColumns: ["id", "client_id"]
          },
        ]
      }
      client_billing_status: {
        Row: {
          agreement_package_id: string | null
          attention_reasons: string[] | null
          billing_attention: boolean | null
          billing_state: string | null
          cancel_at: string | null
          cancel_at_period_end: boolean | null
          canceled_at: string | null
          checkout_expires_at: string | null
          checkout_url: string | null
          client_id: string | null
          collection: string | null
          currency: string | null
          current_period_end: string | null
          current_period_start: string | null
          default_payment_method_brand: string | null
          default_payment_method_last4: string | null
          default_payment_method_type: string | null
          latest_invoice_currency: string | null
          latest_invoice_due_date: string | null
          latest_invoice_id: string | null
          latest_invoice_remaining_cents: number | null
          latest_invoice_status: string | null
          latest_invoice_total_cents: number | null
          latest_invoice_url: string | null
          live_subscription_count: number | null
          livemode: boolean | null
          mrr_cents: number | null
          mrr_incomplete: boolean | null
          next_billing_at: string | null
          open_invoice_count: number | null
          outstanding_cents_by_currency: Json | null
          overdue_invoice_count: number | null
          pause_collection_behavior: string | null
          settling_invoice_count: number | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_package_ids: string[] | null
          subscription_status: string | null
        }
        Relationships: []
      }
      client_entitlements: {
        Row: {
          client_id: string | null
          enabled: boolean | null
          override_reason: string | null
          package_enabled: boolean | null
          package_id: string | null
          package_quantity: number | null
          period: string | null
          quantity: number | null
          service_key: string | null
          service_kind: string | null
          service_name: string | null
          sort_order: number | null
          source: string | null
          unit: string | null
        }
        Relationships: []
      }
      portal_client: {
        Row: {
          city: string | null
          id: string | null
          launched_at: string | null
          name: string | null
          state: string | null
          status: string | null
          website_url: string | null
        }
        Insert: {
          city?: string | null
          id?: string | null
          launched_at?: string | null
          name?: string | null
          state?: string | null
          status?: never
          website_url?: string | null
        }
        Update: {
          city?: string | null
          id?: string | null
          launched_at?: string | null
          name?: string | null
          state?: string | null
          status?: never
          website_url?: string | null
        }
        Relationships: []
      }
      portal_progress: {
        Row: {
          client_id: string | null
          completed_at: string | null
          pipeline: string | null
          pipeline_order: number | null
          stage: string | null
          stage_order: number | null
          status: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_pipelines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_pipelines_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_rankings: {
        Row: {
          checked_at: string | null
          city: string | null
          client_id: string | null
          is_money: boolean | null
          keyword: string | null
          position: number | null
          previous_position: number | null
          result_type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "keywords_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_reports: {
        Row: {
          client_id: string | null
          completed_at: string | null
          period: string | null
          report_url: string | null
          status: string | null
          summary: Json | null
        }
        Insert: {
          client_id?: string | null
          completed_at?: string | null
          period?: string | null
          report_url?: string | null
          status?: never
          summary?: Json | null
        }
        Update: {
          client_id?: string | null
          completed_at?: string | null
          period?: string | null
          report_url?: string | null
          status?: never
          summary?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "monthly_cycles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_cycles_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_search_performance: {
        Row: {
          avg_position: number | null
          clicks: number | null
          client_id: string | null
          impressions: number | null
          period_end: string | null
          period_start: string | null
          queries: number | null
        }
        Relationships: [
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_search_queries: {
        Row: {
          avg_position: number | null
          clicks: number | null
          client_id: string | null
          ctr: number | null
          impressions: number | null
          page: string | null
          period_end: string | null
          period_start: string | null
          query: string | null
        }
        Insert: {
          avg_position?: number | null
          clicks?: number | null
          client_id?: string | null
          ctr?: number | null
          impressions?: number | null
          page?: string | null
          period_end?: string | null
          period_start?: string | null
          query?: string | null
        }
        Update: {
          avg_position?: number | null
          clicks?: number | null
          client_id?: string | null
          ctr?: number | null
          impressions?: number | null
          page?: string | null
          period_end?: string | null
          period_start?: string | null
          query?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "gsc_snapshots_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_site: {
        Row: {
          client_id: string | null
          last_pushed_at: string | null
          launched_at: string | null
          staging_url: string | null
          url: string | null
        }
        Insert: {
          client_id?: string | null
          last_pushed_at?: string | null
          launched_at?: string | null
          staging_url?: string | null
          url?: string | null
        }
        Update: {
          client_id?: string | null
          last_pushed_at?: string | null
          launched_at?: string | null
          staging_url?: string | null
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sites_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sites_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "portal_client"
            referencedColumns: ["id"]
          },
        ]
      }
      portal_work_log: {
        Row: {
          at: string | null
          client_id: string | null
          detail: string | null
          kind: string | null
          label: string | null
          url: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      authority_apply: {
        Args: {
          p_action: string
          p_expected?: Json
          p_opportunity_id: string
          p_payload?: Json
        }
        Returns: Json
      }
      authority_begin_run: {
        Args: {
          p_client_id: string
          p_mode: string
          p_requested_by?: string
          p_requested_via: string
        }
        Returns: string
      }
      authority_caller_is_service: { Args: never; Returns: boolean }
      authority_decide: {
        Args: { p_opportunity_id: string; p_payload?: Json; p_verb: string }
        Returns: Json
      }
      authority_draft_start: { Args: { p_task_id: string }; Returns: Json }
      authority_fingerprint: { Args: { p_client_id: string }; Returns: Json }
      authority_input: { Args: { p_client_id: string }; Returns: Json }
      authority_link_state: {
        Args: {
          l: Database["public"]["Tables"]["authority_opportunity_links"]["Row"]
        }
        Returns: string
      }
      authority_lock_opportunity: {
        Args: { p_opportunity_id: string }
        Returns: {
          action: string
          client_id: string
          content_type: string
          cycle_started_at: string | null
          decided_at: string | null
          decided_by: string | null
          dismissed_until: string | null
          eligible_from: string | null
          first_seen_run_id: string
          id: string
          intent: string | null
          key: string
          keyword_id: string | null
          last_seen_at: string
          last_seen_run_id: string
          opportunity: Json
          present: boolean
          section: string
          service_id: string | null
          sort_order: number[]
          status: string
          status_reason: string | null
          suppressed: boolean
          suppression_basis: Json | null
          target_path: string | null
          tier: string
          topic: string
        }
        SetofOptions: {
          from: "*"
          to: "authority_opportunities"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      authority_norm_path: {
        Args: { p_site?: string; p_url: string }
        Returns: string
      }
      authority_norm_place: { Args: { p: string }; Returns: string }
      authority_page_state: {
        Args: { p_path: string; p_run_id: string }
        Returns: Json
      }
      authority_recommendation_basis: {
        Args: { p_key: string; p_opportunity: Json }
        Returns: Json
      }
      authority_record_run: {
        Args: { p: Json; p_run_id: string }
        Returns: Json
      }
      authority_selected_rows: {
        Args: { p_expected: Json; p_rows: Json }
        Returns: Json
      }
      authority_service_group: {
        Args: { p_client_id: string; p_service_name: string }
        Returns: {
          city_tier: Database["public"]["Enums"]["city_tier"] | null
          client_id: string
          created_at: string
          id: string
          name: string
          page_type: Database["public"]["Enums"]["page_group_type"]
          primary_keyword_id: string | null
          serp_notes: string | null
          status: Database["public"]["Enums"]["taxonomy_status"]
          supporting_keyword_ids: string[]
          target_url: string | null
        }
        SetofOptions: {
          from: "*"
          to: "page_groups"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      authority_url_decode: { Args: { p: string }; Returns: string }
      authority_write_active: { Args: never; Returns: boolean }
      billing_audit: {
        Args: {
          p: Json
        }
        Returns: string
      }
      billing_caller_is_service: { Args: never; Returns: boolean }
      billing_caller_is_superuser: { Args: never; Returns: boolean }
      billing_event_begin: {
        Args: {
          p: Json
          p_lease_seconds?: number
        }
        Returns: Json
      }
      billing_event_fail: {
        Args: {
          p_attempt: number
          p_error: string
          p_id: string
        }
        Returns: Json
      }
      billing_event_finish: {
        Args: {
          p_attempt: number
          p_id: string
          p_reason?: string
          p_status: string
        }
        Returns: Json
      }
      billing_link_customer: {
        Args: {
          p: Json
        }
        Returns: Json
      }
      billing_livemode: { Args: never; Returns: boolean }
      billing_monthly_cents: {
        Args: {
          p_amount: number
          p_interval: string
          p_interval_count: number
          p_quantity: number
        }
        Returns: number
      }
      billing_owner: {
        Args: { p_customer: string; p_livemode: boolean }
        Returns: Record<string, unknown>
      }
      billing_record_checkout: {
        Args: {
          p: Json
        }
        Returns: Json
      }
      billing_record_external_payment: {
        Args: {
          p: Json
        }
        Returns: Json
      }
      billing_require_service: { Args: never; Returns: undefined }
      billing_sync_active: { Args: never; Returns: boolean }
      billing_sync_apply: {
        Args: {
          p: Json
        }
        Returns: Json
      }
      billing_update: {
        Args: {
          p_key: string
          p_row: Json
          p_table: string
        }
        Returns: string
      }
      billing_upsert: {
        Args: {
          p_keys: string[]
          p_row: Json
          p_table: string
        }
        Returns: Json
      }
      billing_void_external_payment: {
        Args: {
          p: Json
        }
        Returns: Json
      }
      brand_asset_record_hash: { Args: { p: Json }; Returns: Json }
      client_canva_folders: {
        Args: { p_client_id?: string }
        Returns: {
          canva_enabled: boolean
          canva_folder_id: string
          canva_used_folder_id: string
          client_id: string
          client_name: string
          client_status: string
        }[]
      }
      client_intelligence_input: {
        Args: { p_client_id: string }
        Returns: Json
      }
      compute_location_index: {
        Args: { p_location_id: string; p_period: string }
        Returns: undefined
      }
      converge_client: { Args: { p_client_id: string }; Returns: boolean }
      create_monthly_cycles: { Args: { p_period?: string }; Returns: number }
      create_stage_tasks: {
        Args: { p_client_pipeline_id: string }
        Returns: number
      }
      create_weekly_blog_tasks: { Args: never; Returns: number }
      creative_actor_kind: { Args: never; Returns: string }
      creative_begin_run: { Args: { p: Json }; Returns: Json }
      creative_caller_is_teammate: { Args: never; Returns: boolean }
      creative_diff: {
        Args: { p_fields: string[]; p_new: Json; p_old: Json }
        Returns: Json
      }
      creative_fail_run: { Args: { p: Json }; Returns: Json }
      creative_governance_log: {
        Args: {
          p_action: string
          p_changes: Json
          p_client: string
          p_note?: string
          p_subject: string
          p_type: string
        }
        Returns: undefined
      }
      creative_overlay_problems: {
        Args: { p_client: string; p_overlay: Json; p_post_id: string }
        Returns: string[]
      }
      creative_policy_for: {
        Args: { p_channel: string; p_client: string }
        Returns: string
      }
      creative_register_template: { Args: { p: Json }; Returns: Json }
      creative_session_active: { Args: never; Returns: boolean }
      creative_spec_hash: { Args: { p_spec: Json }; Returns: string }
      creative_subjects_valid: { Args: { p: string[] }; Returns: boolean }
      creative_write: { Args: { p: Json }; Returns: Json }
      drafter_caller_is_service: { Args: never; Returns: boolean }
      drafter_caller_is_superuser: { Args: never; Returns: boolean }
      drafter_copy_hash: { Args: { p_copy: string }; Returns: string }
      drafter_session_active: { Args: never; Returns: boolean }
      drafter_write: { Args: { p: Json }; Returns: Json }
      fire_foundation_worker: {
        Args: { p_client_id: string; p_reason: string }
        Returns: undefined
      }
      fire_monthly_reporting: { Args: { p_period?: string }; Returns: number }
      fire_website_updates: { Args: { p_period?: string }; Returns: number }
      foundation_complete: { Args: { p_client_id: string }; Returns: boolean }
      get_brand_profile: { Args: { p_client_id: string }; Returns: Json }
      get_secret: { Args: { secret_name: string }; Returns: string }
      is_team: { Args: never; Returns: boolean }
      is_team_admin: { Args: never; Returns: boolean }
      normalize_tracked_keywords: {
        Args: { p_client_id: string; p_target?: number }
        Returns: number
      }
      portal_client_id: { Args: never; Returns: string }
      portal_seen: { Args: never; Returns: undefined }
      post_caller_is_human: { Args: never; Returns: boolean }
      post_caller_kind: { Args: never; Returns: string }
      publisher_reminder_state: {
        Args: { p_post_ids?: string[] }
        Returns: {
          client_id: string
          created_at: string
          outcome: string
          post_id: string
          task_id: string
        }[]
      }
      recheck_social_posts: { Args: { p_post_ids?: string[] }; Returns: number }
      recompute_location_indexes: {
        Args: { p_client_id?: string; p_period?: string }
        Returns: number
      }
      request_new_creative: {
        Args: { p_note: string; p_post_id: string }
        Returns: Json
      }
      retry_failed_fires: { Args: never; Returns: number }
      secret_present: { Args: { secret_name: string }; Returns: boolean }
      set_secret: {
        Args: { secret_name: string; secret_value: string }
        Returns: undefined
      }
      social_post_close_review_task: {
        Args: { p_outcome: string; p_task_id: string }
        Returns: undefined
      }
      social_post_grounding_problems: {
        Args: { p: Database["public"]["Tables"]["social_posts"]["Row"] }
        Returns: string[]
      }
      social_post_hash: { Args: { p_snapshot: Json }; Returns: string }
      social_post_open_review_task: {
        Args: {
          p: Database["public"]["Tables"]["social_posts"]["Row"]
          p_reason: string
        }
        Returns: string
      }
      social_post_readiness: { Args: { p_post_id: string }; Returns: string[] }
      social_post_snapshot: {
        Args: { p: Database["public"]["Tables"]["social_posts"]["Row"] }
        Returns: Json
      }
      source_hash_session_active: { Args: never; Returns: boolean }
      task_actor: { Args: never; Returns: string }
    }
    Enums: {
      access_status: "not_needed" | "requested" | "granted"
      access_system:
        | "gsc"
        | "ga4"
        | "gbp"
        | "hosting"
        | "dns"
        | "meta_ads"
        | "google_ads"
        | "facebook"
        | "instagram"
        | "linkedin"
        | "tiktok"
        | "crm"
        | "other"
      autonomy_level: "run" | "run_flag" | "hold"
      brand_asset_kind:
        | "logo_primary"
        | "logo_alt"
        | "logo_icon"
        | "wordmark"
        | "photo"
        | "website_screenshot"
        | "social_post"
        | "ad"
        | "print"
        | "pattern"
        | "video"
        | "other"
      brand_asset_source: "upload" | "link" | "website_scan"
      brand_board_status: "draft" | "approved"
      brand_color_role:
        | "primary"
        | "secondary"
        | "accent"
        | "neutral"
        | "background"
        | "text"
        | "other"
      brand_font_role: "heading" | "body" | "accent" | "other"
      business_type: "storefront" | "service_area"
      change_status: "proposed" | "approved" | "vetoed"
      city_tier: "1" | "2" | "fold"
      claim_status: "sourced" | "unverified" | "confirmed"
      client_request_status: "draft" | "sent" | "answered" | "closed"
      client_status: "launching" | "active" | "paused" | "offboarded"
      content_status: "idea" | "brief" | "draft" | "review" | "published"
      cycle_status: "open" | "complete"
      deliverable_type: "drive" | "site" | "sheet" | "report" | "other"
      department: "seo" | "website" | "social" | "paid_ads"
      document_category:
        | "contract"
        | "proposal"
        | "brand"
        | "audit"
        | "report"
        | "other"
      document_kind: "drive_link" | "upload"
      enrollment_status: "pending" | "active" | "complete" | "paused"
      keyword_priority: "p1" | "p2" | "p3"
      owner_type: "TOM" | "CLAUDE" | "CLAUDE_APPROVAL" | "DELEGATED" | "WAITING"
      page_group_type: "home" | "service" | "city" | "hub" | "other"
      pipeline_key:
        | "foundation"
        | "seo"
        | "website"
        | "social"
        | "crm"
        | "paid_ads"
        | "reporting"
      placeholder_type: "image" | "claim" | "fact" | "project"
      rank_result_type: "organic" | "map_pack"
      rank_source:
        | "brightlocal_report"
        | "brightlocal_live"
        | "csv"
        | "manual"
        | "dataforseo"
      run_status: "pending" | "running" | "complete" | "failed"
      run_trigger: "cron" | "manual"
      service_page_type: "service" | "hub"
      site_stack: "astro" | "nextjs" | "other"
      social_account_status: "connected" | "expired" | "manual_only"
      social_platform:
        | "facebook"
        | "instagram"
        | "linkedin"
        | "x"
        | "tiktok"
        | "google_business"
      stage_status:
        | "not_started"
        | "in_progress"
        | "blocked"
        | "skipped"
        | "complete"
      task_status: "open" | "in_progress" | "blocked" | "done"
      taxonomy_status: "proposed" | "approved" | "retired"
      team_role: "admin" | "member"
      website_work_mode: "new_build" | "upgrade_existing" | "client_retains"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      access_status: ["not_needed", "requested", "granted"],
      access_system: [
        "gsc",
        "ga4",
        "gbp",
        "hosting",
        "dns",
        "meta_ads",
        "google_ads",
        "facebook",
        "instagram",
        "linkedin",
        "tiktok",
        "crm",
        "other",
      ],
      autonomy_level: ["run", "run_flag", "hold"],
      brand_asset_kind: [
        "logo_primary",
        "logo_alt",
        "logo_icon",
        "wordmark",
        "photo",
        "website_screenshot",
        "social_post",
        "ad",
        "print",
        "pattern",
        "video",
        "other",
      ],
      brand_asset_source: ["upload", "link", "website_scan"],
      brand_board_status: ["draft", "approved"],
      brand_color_role: [
        "primary",
        "secondary",
        "accent",
        "neutral",
        "background",
        "text",
        "other",
      ],
      brand_font_role: ["heading", "body", "accent", "other"],
      business_type: ["storefront", "service_area"],
      change_status: ["proposed", "approved", "vetoed"],
      city_tier: ["1", "2", "fold"],
      claim_status: ["sourced", "unverified", "confirmed"],
      client_request_status: ["draft", "sent", "answered", "closed"],
      client_status: ["launching", "active", "paused", "offboarded"],
      content_status: ["idea", "brief", "draft", "review", "published"],
      cycle_status: ["open", "complete"],
      deliverable_type: ["drive", "site", "sheet", "report", "other"],
      department: ["seo", "website", "social", "paid_ads"],
      document_category: [
        "contract",
        "proposal",
        "brand",
        "audit",
        "report",
        "other",
      ],
      document_kind: ["drive_link", "upload"],
      enrollment_status: ["pending", "active", "complete", "paused"],
      keyword_priority: ["p1", "p2", "p3"],
      owner_type: ["TOM", "CLAUDE", "CLAUDE_APPROVAL", "DELEGATED", "WAITING"],
      page_group_type: ["home", "service", "city", "hub", "other"],
      pipeline_key: [
        "foundation",
        "seo",
        "website",
        "social",
        "crm",
        "paid_ads",
        "reporting",
      ],
      placeholder_type: ["image", "claim", "fact", "project"],
      rank_result_type: ["organic", "map_pack"],
      rank_source: [
        "brightlocal_report",
        "brightlocal_live",
        "csv",
        "manual",
        "dataforseo",
      ],
      run_status: ["pending", "running", "complete", "failed"],
      run_trigger: ["cron", "manual"],
      service_page_type: ["service", "hub"],
      site_stack: ["astro", "nextjs", "other"],
      social_account_status: ["connected", "expired", "manual_only"],
      social_platform: [
        "facebook",
        "instagram",
        "linkedin",
        "x",
        "tiktok",
        "google_business",
      ],
      stage_status: [
        "not_started",
        "in_progress",
        "blocked",
        "skipped",
        "complete",
      ],
      task_status: ["open", "in_progress", "blocked", "done"],
      taxonomy_status: ["proposed", "approved", "retired"],
      team_role: ["admin", "member"],
      website_work_mode: ["new_build", "upgrade_existing", "client_retains"],
    },
  },
} as const
